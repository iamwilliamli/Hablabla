import assert from "node:assert/strict";
import test from "node:test";
import {
  createMossTranscription,
  createParakeetSession,
  readOrCancelMossTranscription,
  speechConfiguration,
} from "./speech";

test("speech configuration supports the dedicated web key and local gateway defaults", () => {
  assert.deepEqual(speechConfiguration({ HABLABLA_SPEECH_API_KEY: "partner-secret" }), {
    baseUrl: "http://127.0.0.1:8765",
    apiKey: "partner-secret",
  });
  assert.deepEqual(speechConfiguration({
    HABLABLA_SPEECH_HOST: "127.0.0.1",
    HABLABLA_SPEECH_PORT: "9000",
    HABLABLA_SPEECH_API_KEYS: "first-key,second-key",
  }), { baseUrl: "http://127.0.0.1:9000", apiKey: "first-key" });
});

test("Parakeet session proxy derives the browser origin and keeps the API key server-side", async () => {
  const previous = process.env.HABLABLA_SPEECH_API_KEY;
  process.env.HABLABLA_SPEECH_API_KEY = "partner-secret";
  let upstreamBody: unknown;
  let upstreamAuthorization = "";
  const fetcher = async (_input: string | URL | Request, init?: RequestInit) => {
    upstreamAuthorization = new Headers(init?.headers).get("authorization") || "";
    upstreamBody = JSON.parse(String(init?.body));
    return Response.json({ sessionId: "st_1", websocketUrl: "ws://127.0.0.1:8765/v1/parakeet/stream?ticket=once", ticketExpiresAt: new Date().toISOString() }, { status: 201 });
  };
  try {
    const response = await createParakeetSession(new Request("http://localhost:3100/api/speech/parakeet-session", {
      method: "POST",
      headers: { host: "localhost:3100", origin: "http://localhost:3100", "content-type": "application/json" },
      body: JSON.stringify({ language: "en" }),
    }), fetcher as typeof fetch);
    assert.equal(response.status, 201);
    assert.equal(upstreamAuthorization, "Bearer partner-secret");
    assert.deepEqual(upstreamBody, {
      origin: "http://localhost:3100",
      language: "en",
      audio: { encoding: "pcm_s16le", sampleRateHz: 16000, channels: 1 },
    });
    assert.doesNotMatch(await response.text(), /partner-secret/);
  } finally {
    if (previous === undefined) delete process.env.HABLABLA_SPEECH_API_KEY;
    else process.env.HABLABLA_SPEECH_API_KEY = previous;
  }
});

test("MOSS proxy preserves file metadata and retry identity", async () => {
  const previous = process.env.HABLABLA_SPEECH_API_KEY;
  process.env.HABLABLA_SPEECH_API_KEY = "partner-secret";
  let receivedKey = "";
  let receivedAudio: FormDataEntryValue | null = null;
  const fetcher = async (_input: string | URL | Request, init?: RequestInit) => {
    receivedKey = new Headers(init?.headers).get("idempotency-key") || "";
    receivedAudio = (init?.body as FormData).get("audio");
    return Response.json({ jobId: "moss_1", status: "queued", statusUrl: "/v1/moss/transcriptions/moss_1", eventsUrl: "/v1/moss/transcriptions/moss_1/events" }, { status: 202 });
  };
  const form = new FormData();
  form.set("audio", new File(["audio"], "standup.webm", { type: "audio/webm" }));
  try {
    const response = await createMossTranscription(new Request("http://localhost:3100/api/speech/transcriptions", {
      method: "POST",
      headers: { host: "localhost:3100", origin: "http://localhost:3100", "idempotency-key": "same-upload" },
      body: form,
    }), fetcher as typeof fetch);
    assert.equal(response.status, 202);
    assert.equal(receivedKey, "same-upload");
    const forwardedAudio = receivedAudio as unknown as File;
    assert.ok(forwardedAudio instanceof File);
    assert.equal(forwardedAudio.name, "standup.webm");
    assert.equal(forwardedAudio.type, "audio/webm");
  } finally {
    if (previous === undefined) delete process.env.HABLABLA_SPEECH_API_KEY;
    else process.env.HABLABLA_SPEECH_API_KEY = previous;
  }
});

test("job polling and cancellation call the authenticated backend route", async () => {
  const previous = process.env.HABLABLA_SPEECH_API_KEY;
  process.env.HABLABLA_SPEECH_API_KEY = "partner-secret";
  const calls: Array<{ url: string; method: string }> = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method || "GET" });
    return Response.json({ jobId: "moss_1", status: init?.method === "DELETE" ? "cancelled" : "processing", progress: 0.5, clientReference: null });
  };
  try {
    assert.equal((await readOrCancelMossTranscription("moss_1", "GET", fetcher as typeof fetch)).status, 200);
    assert.equal((await readOrCancelMossTranscription("moss_1", "DELETE", fetcher as typeof fetch)).status, 200);
    assert.deepEqual(calls, [
      { url: "http://127.0.0.1:8765/v1/moss/transcriptions/moss_1", method: "GET" },
      { url: "http://127.0.0.1:8765/v1/moss/transcriptions/moss_1", method: "DELETE" },
    ]);
  } finally {
    if (previous === undefined) delete process.env.HABLABLA_SPEECH_API_KEY;
    else process.env.HABLABLA_SPEECH_API_KEY = previous;
  }
});

test("Nemotron proxy forwards multilingual hotwords and rejects a foreign origin", async () => {
  const { createNemotronSession } = await import("./speech");
  const previous = process.env.HABLABLA_SPEECH_API_KEY;
  process.env.HABLABLA_SPEECH_API_KEY = "partner-secret";
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return Response.json({ sessionId: "once", websocketUrl: "ws://localhost/stream?ticket=once" }, { status: 201 });
  };
  try {
    for (const origin of ["http://localhost:3100", "https://foreign.example"]) {
      const response = await createNemotronSession(new Request("http://localhost:3100/api/speech/nemotron-session", {
        method: "POST", headers: { host: "localhost:3100", origin },
        body: JSON.stringify({ language: "zh", hotwords: ["阿莫西林"] }),
      }), fetcher as typeof fetch);
      assert.equal(response.status, origin.includes("foreign") ? 403 : 201);
      assert.doesNotMatch(await response.text(), /partner-secret/);
    }
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/v1\/nemotron\/sessions$/);
    assert.equal(calls[0].body.language, "zh");
    assert.deepEqual(calls[0].body.hotwords, ["阿莫西林"]);
    assert.equal(calls[0].body.origin, "http://localhost:3100");
  } finally {
    if (previous === undefined) delete process.env.HABLABLA_SPEECH_API_KEY;
    else process.env.HABLABLA_SPEECH_API_KEY = previous;
  }
});

test("MOSS accepts the saved live WAV unchanged without a new file selection", async () => {
  const { recordingFromPcm } = await import("../recording-audio");
  const previous = process.env.HABLABLA_SPEECH_API_KEY;
  process.env.HABLABLA_SPEECH_API_KEY = "partner-secret";
  const recording = recordingFromPcm([new Int16Array([2, -3, 4]).buffer]);
  let forwarded: File | undefined;
  const fetcher = async (_url: string | URL | Request, init?: RequestInit) => {
    forwarded = (init!.body as FormData).get("audio") as File;
    return Response.json({jobId: "saved-audio", status: "queued"}, {status: 202});
  };
  try {
    const body = new FormData(); body.set("audio", recording, recording.name);
    const response = await createMossTranscription(new Request("http://localhost:3100/api/speech/transcriptions", {
      method: "POST", headers: {host: "localhost:3100", origin: "http://localhost:3100", "idempotency-key": "saved-audio"}, body,
    }), fetcher as typeof fetch);
    assert.equal(response.status, 202);
    assert.equal(forwarded?.type, "audio/wav");
    assert.equal(forwarded?.name, recording.name);
    assert.deepEqual(await forwarded?.arrayBuffer(), await recording.arrayBuffer());
  } finally {
    if (previous === undefined) delete process.env.HABLABLA_SPEECH_API_KEY;
    else process.env.HABLABLA_SPEECH_API_KEY = previous;
  }
});
