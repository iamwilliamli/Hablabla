const DEFAULT_SPEECH_URL = "http://127.0.0.1:8765";

type SpeechEnvironment = Record<string, string | undefined>;

export function speechConfiguration(environment: SpeechEnvironment = process.env) {
  const baseUrl = (
    environment.HABLABLA_SPEECH_URL ||
    (environment.HABLABLA_SPEECH_HOST || environment.HABLABLA_SPEECH_PORT
      ? `http://${environment.HABLABLA_SPEECH_HOST || "127.0.0.1"}:${environment.HABLABLA_SPEECH_PORT || "8765"}`
      : DEFAULT_SPEECH_URL)
  ).replace(/\/$/, "");
  const apiKey =
    environment.HABLABLA_SPEECH_API_KEY ||
    environment.HABLABLA_SPEECH_API_KEYS?.split(",")[0]?.trim() ||
    "";
  return { baseUrl, apiKey };
}

function requestOrigin(request: Request) {
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host");
  const supplied = request.headers.get("origin");
  if (supplied) {
    const origin = new URL(supplied);
    if (host && origin.host !== host) throw new Error("ORIGIN_MISMATCH");
    return origin.origin;
  }
  const protocol = request.headers.get("x-forwarded-proto") || new URL(request.url).protocol.replace(":", "");
  return host ? `${protocol}://${host}` : new URL(request.url).origin;
}

function upstreamHeaders(apiKey: string, extra?: HeadersInit) {
  return new Headers({ authorization: `Bearer ${apiKey}`, ...extra });
}

async function forward(response: Response) {
  return new Response(response.body, {
    status: response.status,
    headers: { "content-type": response.headers.get("content-type") || "application/json" },
  });
}

function unavailable(error: unknown) {
  const message = error instanceof Error && error.message === "ORIGIN_MISMATCH"
    ? "This request did not come from the Hablabla web app."
    : "The local speech service is not running or cannot be reached.";
  return Response.json(
    { error: { code: "SPEECH_UNAVAILABLE", message, retryable: true, requestId: crypto.randomUUID() } },
    { status: error instanceof Error && error.message === "ORIGIN_MISMATCH" ? 403 : 503 },
  );
}

export async function speechHealth(fetcher: typeof fetch = fetch) {
  const { baseUrl, apiKey } = speechConfiguration();
  try {
    const health = await fetcher(`${baseUrl}/healthz`, { cache: "no-store" });
    if (!health.ok) return forward(health);
    if (!apiKey) {
      return Response.json({ status: "needs-configuration", message: "Add the speech API key to the server environment." });
    }
    const capabilities = await fetcher(`${baseUrl}/v1/capabilities`, {
      headers: upstreamHeaders(apiKey),
      cache: "no-store",
    });
    if (!capabilities.ok) return forward(capabilities);
    return Response.json({ status: "connected", capabilities: await capabilities.json() });
  } catch (error) {
    return unavailable(error);
  }
}

export async function createParakeetSession(request: Request, fetcher: typeof fetch = fetch) {
  return createLiveSession(request, "parakeet", fetcher);
}

export async function createNemotronSession(request: Request, fetcher: typeof fetch = fetch) {
  return createLiveSession(request, "nemotron", fetcher);
}

async function createLiveSession(request: Request, model: "parakeet" | "nemotron", fetcher: typeof fetch) {
  const { baseUrl, apiKey } = speechConfiguration();
  try {
    if (!apiKey) return unavailable(new Error("NO_API_KEY"));
    const input = (await request.json().catch(() => ({}))) as { language?: unknown; hotwords?: unknown };
    const language = typeof input.language === "string" ? input.language : "en";
    const response = await fetcher(`${baseUrl}/v1/${model}/sessions`, {
      method: "POST",
      headers: upstreamHeaders(apiKey, { "content-type": "application/json" }),
      body: JSON.stringify({
        origin: requestOrigin(request),
        language,
        ...(model === "nemotron" ? { hotwords: input.hotwords ?? [] } : {}),
        audio: { encoding: "pcm_s16le", sampleRateHz: 16000, channels: 1 },
      }),
    });
    return forward(response);
  } catch (error) {
    return unavailable(error);
  }
}

export async function createMossTranscription(request: Request, fetcher: typeof fetch = fetch) {
  const { baseUrl, apiKey } = speechConfiguration();
  try {
    if (!apiKey) return unavailable(new Error("NO_API_KEY"));
    requestOrigin(request);
    const incoming = await request.formData();
    const audio = incoming.get("audio");
    if (!(audio instanceof File) || audio.size === 0) {
      return Response.json({ error: { code: "MISSING_AUDIO", message: "Choose an audio recording first.", retryable: false, requestId: crypto.randomUUID() } }, { status: 400 });
    }
    const idempotencyKey = request.headers.get("idempotency-key")?.trim();
    if (!idempotencyKey || idempotencyKey.length > 200) {
      return Response.json({ error: { code: "IDEMPOTENCY_KEY_REQUIRED", message: "The upload is missing its retry identifier.", retryable: false, requestId: crypto.randomUUID() } }, { status: 400 });
    }
    const upstream = new FormData();
    upstream.set("audio", audio, audio.name || "recording.webm");
    upstream.set("language", String(incoming.get("language") || "auto"));
    upstream.set("hotwords", String(incoming.get("hotwords") || '["Hablabla","CopilotKit"]'));
    upstream.set("clientReference", String(incoming.get("clientReference") || crypto.randomUUID()));
    const response = await fetcher(`${baseUrl}/v1/moss/transcriptions`, {
      method: "POST",
      headers: upstreamHeaders(apiKey, { "idempotency-key": idempotencyKey }),
      body: upstream,
    });
    return forward(response);
  } catch (error) {
    return unavailable(error);
  }
}

export async function readOrCancelMossTranscription(
  jobId: string,
  method: "GET" | "DELETE",
  fetcher: typeof fetch = fetch,
) {
  const { baseUrl, apiKey } = speechConfiguration();
  try {
    if (!apiKey) return unavailable(new Error("NO_API_KEY"));
    const response = await fetcher(`${baseUrl}/v1/moss/transcriptions/${encodeURIComponent(jobId)}`, {
      method,
      headers: upstreamHeaders(apiKey),
      cache: "no-store",
    });
    return forward(response);
  } catch (error) {
    return unavailable(error);
  }
}
