import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import {
  bearerToken,
  constantTimeIncludes,
  loadConfig,
  opaqueID,
  type GatewayConfig,
} from "./config.js";
import {
  acceptedOfflineAudioTypes,
  decodeStreamPacket,
  jsonLineObjects,
  STREAM_CHANNELS,
  STREAM_ENCODING,
  STREAM_SAMPLE_RATE_HZ,
} from "./protocol.js";

type Ticket = {
  sessionId: string;
  origin: string;
  language: string;
  expiresAt: number;
};

type JobStatus = "queued" | "processing" | "completed" | "failed" | "cancelled";
type OfflineJob = {
  id: string;
  status: JobStatus;
  progress: number;
  createdAt: number;
  expiresAt: number;
  clientReference: string | null;
  result?: unknown;
  error?: ErrorBody;
  process?: ChildProcess;
  listeners: Set<ServerResponse>;
};

type ErrorBody = {
  code: string;
  message: string;
  retryable: boolean;
  requestId: string;
};

const config = loadConfig();
const tickets = new Map<string, Ticket>();
const jobs = new Map<string, OfflineJob>();
const idempotentJobs = new Map<string, string>();
const offlineQueue: Array<() => Promise<void>> = [];
let offlineRunning = false;

function sendJSON(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function sendError(
  response: ServerResponse,
  status: number,
  requestId: string,
  code: string,
  message: string,
  retryable = false,
): void {
  sendJSON(response, status, { error: { code, message, retryable, requestId } });
}

function requestOrigin(request: IncomingMessage): string | null {
  const value = request.headers.origin;
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function applyCors(request: IncomingMessage, response: ServerResponse): boolean {
  const origin = requestOrigin(request);
  if (!origin || !config.allowedOrigins.has(origin)) return false;
  response.setHeader("access-control-allow-origin", origin);
  response.setHeader("vary", "Origin");
  response.setHeader("access-control-allow-headers", "authorization, content-type, idempotency-key");
  response.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
  return true;
}

function isAuthenticated(request: IncomingMessage): boolean {
  const token = bearerToken(request.headers.authorization);
  return token !== null && constantTimeIncludes(config.apiKeys, token);
}

async function readBody(request: IncomingMessage, maximumBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let byteCount = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    byteCount += chunk.length;
    if (byteCount > maximumBytes) throw new RangeError("UPLOAD_TOO_LARGE");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function parseMultipart(request: IncomingMessage): Promise<FormData> {
  const contentType = request.headers["content-type"];
  if (!contentType?.toLowerCase().startsWith("multipart/form-data;")) {
    throw new TypeError("UNSUPPORTED_MEDIA_TYPE");
  }
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (declaredLength > config.maximumUploadBytes) throw new RangeError("UPLOAD_TOO_LARGE");
  const body = await readBody(request, config.maximumUploadBytes);
  return new Response(new Uint8Array(body), { headers: { "content-type": contentType } }).formData();
}

function cleanLanguage(value: FormDataEntryValue | null): string {
  const language = typeof value === "string" ? value.trim() : "auto";
  if (!/^(auto|[a-z]{2}(?:-[A-Za-z]{2})?)$/.test(language)) {
    throw new TypeError("INVALID_LANGUAGE");
  }
  return language;
}

function cleanHotwords(value: FormDataEntryValue | null): string[] {
  if (value === null || value === "") return [];
  if (typeof value !== "string") throw new TypeError("INVALID_HOTWORDS");
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.length > 64
    || parsed.some((word) => typeof word !== "string" || word.length > 80)) {
    throw new TypeError("INVALID_HOTWORDS");
  }
  return parsed;
}

function websocketBase(publicBaseUrl: string): string {
  const url = new URL(publicBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString().replace(/\/$/, "");
}

function emitJob(job: OfflineJob): void {
  const payload = JSON.stringify(publicJob(job));
  for (const response of job.listeners) response.write(`data: ${payload}\n\n`);
  if (["completed", "failed", "cancelled"].includes(job.status)) {
    for (const response of job.listeners) response.end();
    job.listeners.clear();
  }
}

function publicJob(job: OfflineJob): Record<string, unknown> {
  return {
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    clientReference: job.clientReference,
    ...(job.result === undefined ? {} : { result: job.result }),
    ...(job.error === undefined ? {} : { error: job.error }),
  };
}

function workerError(job: OfflineJob, message: string, retryable: boolean): ErrorBody {
  return {
    code: "WORKER_FAILURE",
    message,
    retryable,
    requestId: job.id,
  };
}

function enqueueOffline(operation: () => Promise<void>): void {
  offlineQueue.push(operation);
  void runOfflineQueue();
}

async function runOfflineQueue(): Promise<void> {
  if (offlineRunning) return;
  const operation = offlineQueue.shift();
  if (!operation) return;
  offlineRunning = true;
  try {
    await operation();
  } finally {
    offlineRunning = false;
    void runOfflineQueue();
  }
}

async function runMossJob(
  job: OfflineJob,
  filePath: string,
  temporaryDirectory: string,
  language: string,
  hotwords: string[],
): Promise<void> {
  if ((job.status as JobStatus) === "cancelled") {
    await rm(temporaryDirectory, { recursive: true, force: true });
    return;
  }
  job.status = "processing";
  emitJob(job);

  const normalizedPath = join(temporaryDirectory, "normalized.wav");
  const conversion = spawn(config.ffmpegExecutable, [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
    "-i", filePath,
    "-ac", "1", "-ar", "16000", "-c:a", "pcm_f32le",
    normalizedPath,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  job.process = conversion;
  let conversionError = "";
  conversion.stderr.on("data", (chunk: Buffer) => {
    conversionError = (conversionError + chunk.toString("utf8")).slice(-8_000);
  });
  const conversionExit = await new Promise<number | null>((resolve) => {
    conversion.once("error", () => resolve(null));
    conversion.once("exit", resolve);
  });
  job.process = undefined;
  if ((job.status as JobStatus) === "cancelled") {
    await rm(temporaryDirectory, { recursive: true, force: true });
    return;
  }
  if (conversionExit !== 0) {
    job.status = "failed";
    job.error = {
      code: "INVALID_AUDIO",
      message: conversionError.trim() || "FFmpeg could not decode the uploaded audio.",
      retryable: false,
      requestId: job.id,
    };
    await rm(temporaryDirectory, { recursive: true, force: true });
    emitJob(job);
    return;
  }

  const workerArguments = [
    "moss-offline",
    "--input", normalizedPath,
    "--language", language,
    "--hotwords-json", JSON.stringify(hotwords),
  ];
  if (config.mossModelDirectory) {
    workerArguments.push("--model-directory", config.mossModelDirectory);
  }
  const child = spawn(config.workerExecutable, workerArguments, { stdio: ["pipe", "pipe", "pipe"] });
  job.process = child;
  const stdoutState = { pending: "" };
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-8_000);
  });
  child.stdout.on("data", (chunk: Buffer) => {
    try {
      for (const value of jsonLineObjects(stdoutState, chunk)) {
        if (!value || typeof value !== "object") continue;
        const event = value as Record<string, unknown>;
        if (event.type === "progress" && typeof event.progress === "number") {
          job.progress = Math.min(Math.max(event.progress, 0), 1);
          emitJob(job);
        } else if (event.type === "result") {
          job.result = event.result;
        }
      }
    } catch {
      child.kill("SIGTERM");
    }
  });

  const exitCode = await new Promise<number | null>((resolve) => {
    child.once("error", () => resolve(null));
    child.once("exit", resolve);
  });
  job.process = undefined;
  await rm(temporaryDirectory, { recursive: true, force: true });
  if ((job.status as JobStatus) === "cancelled") return;
  if (exitCode === 0 && job.result !== undefined) {
    job.status = "completed";
    job.progress = 1;
  } else {
    job.status = "failed";
    job.error = workerError(
      job,
      stderr.trim() || "The MOSS worker stopped without returning a result.",
      exitCode === null,
    );
  }
  emitJob(job);
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const requestId = opaqueID("req");
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const hasCors = applyCors(request, response);
  if (request.method === "OPTIONS") {
    response.writeHead(hasCors ? 204 : 403).end();
    return;
  }
  if (request.headers.origin && !hasCors) {
    sendError(response, 403, requestId, "ORIGIN_NOT_ALLOWED", "This web origin is not allowed.");
    return;
  }

  if (request.method === "GET" && url.pathname === "/healthz") {
    sendJSON(response, 200, { status: "ok" });
    return;
  }
  if (!isAuthenticated(request)) {
    sendError(response, 401, requestId, "UNAUTHORIZED", "A valid bearer API key is required.");
    return;
  }

  if (request.method === "GET" && url.pathname === "/v1/capabilities") {
    sendJSON(response, 200, {
      streaming: {
        model: "parakeet-tdt-0.6b-v3",
        transport: "websocket",
        audio: { encoding: STREAM_ENCODING, sampleRateHz: STREAM_SAMPLE_RATE_HZ, channels: STREAM_CHANNELS },
      },
      offline: {
        model: "moss-transcribe-diarize",
        transport: "multipart-upload",
        acceptedContentTypes: [...acceptedOfflineAudioTypes.keys()],
        maximumUploadBytes: config.maximumUploadBytes,
      },
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/parakeet/sessions") {
    let body: Record<string, unknown>;
    let origin = "";
    try {
      body = JSON.parse((await readBody(request, 32_768)).toString("utf8")) as Record<string, unknown>;
      origin = typeof body.origin === "string" ? new URL(body.origin).origin : "";
    } catch {
      sendError(response, 400, requestId, "INVALID_STREAM_CONFIG", "Send a valid JSON stream configuration.");
      return;
    }
    const language = typeof body.language === "string" ? body.language : "en";
    const audio = body.audio as Record<string, unknown> | undefined;
    if (!config.allowedOrigins.has(origin)) {
      sendError(response, 403, requestId, "ORIGIN_NOT_ALLOWED", "This web origin is not allowed.");
      return;
    }
    if (!/^[a-z]{2}(?:-[A-Za-z]{2})?$/.test(language)
      || audio?.encoding !== STREAM_ENCODING
      || audio?.sampleRateHz !== STREAM_SAMPLE_RATE_HZ
      || audio?.channels !== STREAM_CHANNELS) {
      sendError(response, 400, requestId, "INVALID_STREAM_CONFIG", "Streaming audio must be 16 kHz mono pcm_s16le.");
      return;
    }
    const ticket = opaqueID("ticket");
    const sessionId = opaqueID("st");
    const expiresAt = Date.now() + config.ticketLifetimeMs;
    tickets.set(ticket, { sessionId, origin, language, expiresAt });
    sendJSON(response, 201, {
      sessionId,
      websocketUrl: `${websocketBase(config.publicBaseUrl)}/v1/parakeet/stream?ticket=${encodeURIComponent(ticket)}`,
      ticketExpiresAt: new Date(expiresAt).toISOString(),
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/moss/transcriptions") {
    try {
      const rawIdempotencyKey = request.headers["idempotency-key"];
      const idempotencyKey = Array.isArray(rawIdempotencyKey)
        ? rawIdempotencyKey[0]?.trim()
        : rawIdempotencyKey?.trim();
      if (!idempotencyKey || idempotencyKey.length > 200) {
        sendError(response, 400, requestId, "IDEMPOTENCY_KEY_REQUIRED", "Send a unique Idempotency-Key header.");
        return;
      }
      const existingJobId = idempotentJobs.get(idempotencyKey);
      if (existingJobId) {
        const existingJob = jobs.get(existingJobId);
        if (existingJob) {
          sendJSON(response, 200, publicJob(existingJob));
          return;
        }
      }
      const form = await parseMultipart(request);
      const audio = form.get("audio");
      if (!(audio instanceof File) || audio.size === 0) throw new TypeError("MISSING_AUDIO");
      const mediaType = audio.type.toLowerCase().split(";")[0];
      const suffix = acceptedOfflineAudioTypes.get(mediaType);
      if (!suffix) throw new TypeError("UNSUPPORTED_MEDIA_TYPE");
      if (audio.size > config.maximumUploadBytes) throw new RangeError("UPLOAD_TOO_LARGE");
      const language = cleanLanguage(form.get("language"));
      const hotwords = cleanHotwords(form.get("hotwords"));
      const clientReferenceValue = form.get("clientReference");
      const clientReference = typeof clientReferenceValue === "string"
        ? clientReferenceValue.slice(0, 200)
        : null;
      const temporaryDirectory = await mkdtemp(join(tmpdir(), "hablabla-moss-"));
      const originalSuffix = extname(audio.name).toLowerCase();
      const filePath = join(temporaryDirectory, `audio${originalSuffix || suffix}`);
      await writeFile(filePath, Buffer.from(await audio.arrayBuffer()), { mode: 0o600 });

      const id = opaqueID("moss");
      const job: OfflineJob = {
        id,
        status: "queued",
        progress: 0,
        createdAt: Date.now(),
        expiresAt: Date.now() + config.resultLifetimeMs,
        clientReference,
        listeners: new Set(),
      };
      jobs.set(id, job);
      idempotentJobs.set(idempotencyKey, id);
      enqueueOffline(() => runMossJob(job, filePath, temporaryDirectory, language, hotwords));
      sendJSON(response, 202, {
        jobId: id,
        status: "queued",
        statusUrl: `/v1/moss/transcriptions/${id}`,
        eventsUrl: `/v1/moss/transcriptions/${id}/events`,
      });
    } catch (error) {
      const code = error instanceof Error ? error.message : "INVALID_INPUT";
      if (code === "UPLOAD_TOO_LARGE") {
        sendError(response, 413, requestId, code, "The uploaded audio exceeds the configured limit.");
      } else if (code === "UNSUPPORTED_MEDIA_TYPE") {
        sendError(response, 415, requestId, code, "Upload WAV, M4A, MP3, MP4, WebM, or Ogg audio.");
      } else {
        sendError(response, 400, requestId, "INVALID_INPUT", "The multipart transcription request is invalid.");
      }
    }
    return;
  }

  const jobMatch = url.pathname.match(/^\/v1\/moss\/transcriptions\/([^/]+)(\/events)?$/);
  if (jobMatch) {
    const job = jobs.get(jobMatch[1]);
    if (!job) {
      sendError(response, 404, requestId, "JOB_NOT_FOUND", "No transcription job has that ID.");
      return;
    }
    if (request.method === "GET" && jobMatch[2] === "/events") {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      });
      job.listeners.add(response);
      response.write(`data: ${JSON.stringify(publicJob(job))}\n\n`);
      request.once("close", () => job.listeners.delete(response));
      return;
    }
    if (request.method === "GET" && !jobMatch[2]) {
      sendJSON(response, 200, publicJob(job));
      return;
    }
    if (request.method === "DELETE" && !jobMatch[2]) {
      if (!["completed", "failed", "cancelled"].includes(job.status)) {
        job.status = "cancelled";
        job.process?.kill("SIGTERM");
        emitJob(job);
      }
      sendJSON(response, 200, publicJob(job));
      return;
    }
  }

  sendError(response, 404, requestId, "NOT_FOUND", "No speech API route matches this request.");
}

const server = createServer((request, response) => {
  void handleRequest(request, response).catch((error: unknown) => {
    const requestId = opaqueID("req");
    const message = error instanceof Error ? error.message : "Unexpected gateway error";
    sendError(response, 500, requestId, "INTERNAL_ERROR", message, true);
  });
});

const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const ticketID = url.searchParams.get("ticket");
  const ticket = ticketID ? tickets.get(ticketID) : undefined;
  const origin = requestOrigin(request);
  if (url.pathname !== "/v1/parakeet/stream" || !ticket || !origin
    || ticket.expiresAt < Date.now() || origin !== ticket.origin) {
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  tickets.delete(ticketID!);
  webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
    webSocketServer.emit("connection", webSocket, request, ticket);
  });
});

webSocketServer.on("connection", (webSocket: WebSocket, _request: IncomingMessage, ticket: Ticket) => {
  const workerArguments = [
    "parakeet-stream",
    "--language", ticket.language,
    "--sample-rate", String(STREAM_SAMPLE_RATE_HZ),
    "--encoding", STREAM_ENCODING,
  ];
  if (config.parakeetModelDirectory) {
    workerArguments.push("--model-directory", config.parakeetModelDirectory);
  }
  const child = spawn(config.workerExecutable, workerArguments, { stdio: ["pipe", "pipe", "pipe"] });
  const stdoutState = { pending: "" };
  let expectedSequence = 0;
  let finished = false;
  let failed = false;
  let inputChain = Promise.resolve();

  const send = (body: unknown): void => {
    if (webSocket.readyState === WebSocket.OPEN) webSocket.send(JSON.stringify(body));
  };
  const fail = (code: string, message: string, retryable = false): void => {
    if (failed) return;
    failed = true;
    send({ type: "error", error: { code, message, retryable, requestId: ticket.sessionId } });
    webSocket.close(1011, code);
    child.kill("SIGTERM");
  };

  child.stdin.on("error", () => {
    if (!finished) fail("WORKER_INPUT_FAILURE", "The Parakeet worker stopped accepting audio.", true);
  });

  child.stdout.on("data", (chunk: Buffer) => {
    try {
      for (const event of jsonLineObjects(stdoutState, chunk)) send(event);
    } catch {
      fail("INVALID_WORKER_OUTPUT", "The Parakeet worker returned invalid JSON.");
    }
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-8_000);
  });
  child.once("error", () => fail("WORKER_UNAVAILABLE", "The Parakeet worker could not start.", true));
  child.once("exit", (code) => {
    if (!finished && code !== 0) fail("WORKER_FAILURE", stderr.trim() || "The Parakeet worker stopped.", true);
    else if (webSocket.readyState === WebSocket.OPEN) webSocket.close(1000, "finished");
  });

  send({
    type: "connected",
    sessionId: ticket.sessionId,
    audio: { encoding: STREAM_ENCODING, sampleRateHz: STREAM_SAMPLE_RATE_HZ, channels: STREAM_CHANNELS },
  });

  webSocket.on("message", (data, isBinary) => {
    inputChain = inputChain.then(async () => {
      if (finished) return;
      if (isBinary) {
        const packet = decodeStreamPacket(Buffer.from(data as ArrayBuffer));
        if (packet.sequence !== expectedSequence) {
          throw new Error(`Expected audio sequence ${expectedSequence}, received ${packet.sequence}`);
        }
        expectedSequence += 1;
        if (!child.stdin.write(packet.pcm)) await new Promise<void>((resolve) => child.stdin.once("drain", resolve));
        return;
      }
      const command = JSON.parse(data.toString()) as Record<string, unknown>;
      if (command.type === "finish") {
        finished = true;
        child.stdin.end();
      } else if (command.type !== "start") {
        throw new Error("Only start and finish JSON commands are accepted");
      }
    }).catch((error: unknown) => {
      fail("INVALID_STREAM_INPUT", error instanceof Error ? error.message : "Invalid stream input");
    });
  });
  webSocket.once("close", () => {
    if (!finished) child.kill("SIGTERM");
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [id, ticket] of tickets) if (ticket.expiresAt < now) tickets.delete(id);
  for (const [id, job] of jobs) {
    if (job.expiresAt < now && ["completed", "failed", "cancelled"].includes(job.status)) {
      jobs.delete(id);
    }
  }
}, 60_000).unref();

server.listen(config.port, config.host, () => {
  process.stdout.write(`Hablabla speech gateway listening on http://${config.host}:${config.port}\n`);
});
