# Sending audio to the Hablabla backend

This file is the frontend/backend contract. The production base URL is supplied
separately as `HABLABLA_SPEECH_URL`; all examples below are relative to it.
The HTTP routes are also available as an importable
[OpenAPI 3.1 file](speech-api.openapi.yaml). OpenAPI cannot fully describe the
binary WebSocket frames, so this document remains authoritative for streaming.

## Interface summary

| Method | Path | Called by | Request data | Success |
| --- | --- | --- | --- | --- |
| `GET` | `/healthz` | Browser or server | none | `200 { "status": "ok" }` |
| `GET` | `/v1/capabilities` | Partner server | bearer token | Supported models and audio limits |
| `POST` | `/v1/parakeet/sessions` | Partner server | JSON stream configuration | `201` one-time WebSocket URL |
| `WSS` | `/v1/parakeet/stream?ticket=...` | Browser | JSON commands plus framed PCM | Live transcript events |
| `POST` | `/v1/nemotron/sessions` | Partner server | JSON stream configuration and optional `hotwords` | `201` one-time WebSocket URL |
| `WSS` | `/v1/nemotron/stream?ticket=...` | Browser | Same framed PCM protocol | Live transcript events |
| `POST` | `/v1/moss/transcriptions` | Partner server | Multipart complete audio file | `202` queued job |
| `GET` | `/v1/moss/transcriptions/:jobId` | Partner server | bearer token | Job progress/result |
| `GET` | `/v1/moss/transcriptions/:jobId/events` | Partner server | bearer token | SSE progress/result stream |
| `DELETE` | `/v1/moss/transcriptions/:jobId` | Partner server | bearer token | Cancelled/current job state |

The backend accepts two intentionally different inputs:

| Workflow | Input from the web app | Transport |
| --- | --- | --- |
| Live captions | Header-framed 16 kHz mono signed Int16 PCM | WebSocket |
| Final offline transcript | The complete `File` or recorded `Blob` | Multipart HTTPS |

Do not send a browser `MediaStream` object. It exists only inside that browser.

## Frontend integration handoff

### Nemotron multilingual streaming with medical hotwords

The partner server calls `POST /v1/nemotron/sessions` with its bearer key:

```json
{
  "origin": "https://partner.example.com",
  "language": "en",
  "audio": { "encoding": "pcm_s16le", "sampleRateHz": 16000, "channels": 1 },
  "hotwords": ["metformin", "HbA1c", "myocardial infarction"]
}
```

Response and ticket rules match Parakeet: `sessionId`, `websocketUrl`,
`ticketExpiresAt`; one use, 60 seconds, bound to the exact browser Origin.
Use the returned URL, send `start`, wait for `ready`, then reuse the PCM worklet
and 8-byte packet header documented below. Do not send WebM/Opus chunks.
Send `finish` after flushing captured PCM and wait for `isFinal: true`.
Nemotron partial results are whole-text snapshots in `volatileText` (not deltas);
only the final result moves to `confirmedText`. Replace text by revision.
`audioEndMs` measures received audio, not word-level alignment.

`hotwords` is optional; omitted or `[]` disables vocabulary biasing. Maximum
64 terms, each nonblank and at most 80 UTF-16 code units. Whitespace is trimmed
and exact duplicates removed. Use complete medical terms: the upstream decoder
ignores terms shorter than three graphemes (two for CJK). Vocabulary is fixed
for the session; create a new session to change it. `language` accepts `auto`
or a two-letter language with optional region; actual language availability
depends on the model export. The decoder applies vocabulary bias during ASR,
not a later find-and-replace. This does not guarantee medical accuracy; preserve
the recording and require review of drug names, dosage, and clinical terms.

`GET /v1/capabilities` exposes `nemotron.configured`, `hotwords: true`, and
`maximumHotwords: 64`. Configured means a directory was supplied, not that a
model has passed loading. Missing configuration returns HTTP 503
`MODEL_NOT_CONFIGURED`; bad hotwords return HTTP 400 `INVALID_STREAM_CONFIG`.
Invalid/incompatible assets fail the WebSocket before `ready`; handle `error`
and close explicitly. `ready.hotwordCount` is the submitted deduplicated count,
not a count of words recognized or guaranteed effective.

Backend setup: set `HABLABLA_NEMOTRON_MODEL_DIR` to a FluidAudio-compatible
**multilingual** export containing `metadata.json`, `tokenizer.json`, encoder
assets and a loadable `decoder_joint` or `decoder` + `joint` logits path.
This adapter conservatively requires one of these logits paths for hotwords;
argmax-only and B3-only exports are rejected when hotwords are requested.
The separate English-only Nemotron exports are not interchangeable.
Rebuild the macOS worker after updating dependencies. Cold model loading may
take time; do not start microphone transmission before `ready`.

The speech gateway contract is ready, but `apps/web` does not currently expose
the same-origin proxy routes needed to keep the partner bearer key out of the
browser. Agree their final paths with the web-backend owner before wiring UI.
Names such as `/api/hablabla/parakeet-session` below are examples, not existing
routes.

| Owner | Required integration work |
| --- | --- |
| Web backend | Read `HABLABLA_SPEECH_URL` and `HABLABLA_SPEECH_API_KEY` only on the server; derive the trusted browser origin; proxy session creation and MOSS create/read/cancel; proxy SSE or expose authenticated polling. |
| Capture/transcript frontend | Use the supplied PCM worklet, start capture only after `ready`, replace transcript state by increasing `revision`, flush before `finish`, and wait for `isFinal: true`. Preserve the recorded file's MIME type and filename for MOSS. |
| Analysis frontend | Consume confirmed transcript snapshots and timestamped segments. Treat `speakerId` as a generic label unless the user explicitly names that speaker; do not infer identity. |

Acceptance requires all of the following:

1. Browser source, storage, logs, and requests never expose the long-lived API key.
2. One real Parakeet stream reaches `ready`, displays a revisable transcript,
   and ends with `isFinal: true`.
3. One real MOSS upload renders queued/processing/completed and uses its returned
   `jobId`; cancellation and a failed job are visible states, not empty text.
4. A repeated upload after a transport retry reuses the same idempotency key.
5. UI retains the backend `requestId` for diagnosis and ignores stale transcript
   revisions.

## Authentication boundary

Keep `HABLABLA_SPEECH_API_KEY` in the partner web app's server environment. Do
not place it in client JavaScript, local storage, a `NEXT_PUBLIC_*` variable, or
the WebSocket URL.

All `/v1` HTTP requests use `Authorization: Bearer <partner-api-key>`. The
browser must never receive that key. A frontend with no server component cannot
call the protected HTTP API safely.

The partner server creates a short-lived Parakeet session. Derive `origin` from
the incoming browser request or a server-side setting; do not accept an
arbitrary origin supplied by the browser:

```ts
// Example: a server route in the partner web app.
export async function POST(request: Request) {
  const { language = "en" } = await request.json();
  const origin = new URL(request.headers.get("origin")!).origin;
  const upstream = await fetch(`${process.env.HABLABLA_SPEECH_URL}/v1/parakeet/sessions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.HABLABLA_SPEECH_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      origin,
      language,
      audio: { encoding: "pcm_s16le", sampleRateHz: 16000, channels: 1 },
    }),
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "content-type": "application/json" },
  });
}
```

The configured origin must be an exact match, including scheme and port.

The session request and response are:

```http
POST /v1/parakeet/sessions
Authorization: Bearer <partner-api-key>
Content-Type: application/json

{
  "origin": "https://partner.example.com",
  "language": "en",
  "audio": { "encoding": "pcm_s16le", "sampleRateHz": 16000, "channels": 1 }
}
```

```json
{
  "sessionId": "st_...",
  "websocketUrl": "wss://speech.example.com/v1/parakeet/stream?ticket=...",
  "ticketExpiresAt": "2026-09-12T18:30:00.000Z"
}
```

The ticket is single-use, expires after 60 seconds, and is bound to the exact
browser `Origin` used to create it.

## Parakeet live PCM

Create Web Audio at 16 kHz and verify that the browser honored it. If it reports
a different rate, use a real streaming resampler before sending; changing only
the metadata would produce incorrect audio.

```js
const audioContext = new AudioContext({ sampleRate: 16000 });
if (audioContext.sampleRate !== 16000) {
  throw new Error(`A 16 kHz resampler is required; browser opened ${audioContext.sampleRate} Hz`);
}

const media = await navigator.mediaDevices.getUserMedia({
  audio: {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
});
```

Copy or serve the supplied
[`hablabla-pcm16-worklet.js`](../apps/speech-gateway/examples/hablabla-pcm16-worklet.js),
then load it:

```js
await audioContext.audioWorklet.addModule("/hablabla-pcm16-worklet.js");
const source = audioContext.createMediaStreamSource(media);
const worklet = new AudioWorkletNode(audioContext, "hablabla-pcm16");
// Do not connect the microphone node to audioContext.destination.
```

Ask the partner server for a ticket, then connect directly to Hablabla:

```js
const sessionResponse = await fetch("/api/hablabla/parakeet-session", {
  method: "POST",
  headers: { "content-type": "application/json" },
  // The same-origin server route derives Origin from the request context.
  body: JSON.stringify({ language: "en" }),
});
if (!sessionResponse.ok) throw new Error(await sessionResponse.text());
const { websocketUrl } = await sessionResponse.json();

const socket = new WebSocket(websocketUrl);
socket.binaryType = "arraybuffer";

let sequence = 0;
let modelReady = false;
socket.addEventListener("open", () => {
  socket.send(JSON.stringify({ type: "start" }));
});

worklet.port.onmessage = ({ data: pcm }) => {
  if (!modelReady || socket.readyState !== WebSocket.OPEN) return;
  if (pcm?.type === "flushed") {
    socket.send(JSON.stringify({ type: "finish" }));
    return;
  }
  const samples = new Int16Array(pcm);
  const packet = new ArrayBuffer(8 + samples.byteLength);
  const view = new DataView(packet);
  view.setUint32(0, sequence++, true);
  view.setUint32(4, samples.length, true);
  new Uint8Array(packet, 8).set(new Uint8Array(samples.buffer));
  socket.send(packet);
};

socket.addEventListener("message", ({ data }) => {
  const event = JSON.parse(data);
  if (event.type === "ready" && !modelReady) {
    modelReady = true;
    source.connect(worklet); // Start capture only after the model can consume it.
  }
  if (event.type === "transcript") {
    // Replace the previous state. volatileText is allowed to change.
    renderTranscript(event.confirmedText, event.volatileText, event.isFinal);
  }
});
```

WebSocket server events are JSON text frames:

```json
{ "type": "connected", "sessionId": "st_...", "audio": { "encoding": "pcm_s16le", "sampleRateHz": 16000, "channels": 1 } }
{ "type": "progress", "progress": 0.01, "stage": "loading-model" }
{ "type": "ready", "model": "parakeet-tdt-0.6b-v3", "sampleRateHz": 16000 }
{ "type": "transcript", "revision": 3, "confirmedText": "Hello ", "volatileText": "world", "audioEndMs": 1840, "isFinal": false }
{ "type": "transcript", "revision": 4, "confirmedText": "Hello world.", "volatileText": "", "audioEndMs": 2100, "isFinal": true }
```

Treat every transcript event as a replacement snapshot, not text to append.
Ignore a revision older than the latest revision already rendered.

Each binary packet is:

```text
bytes 0...3   UInt32 LE sequence, starting at 0
bytes 4...7   UInt32 LE number of Int16 samples
bytes 8...N   signed Int16 little-endian mono PCM
```

The included worklet emits 1,600 samples per packet, or 100 ms. When recording
ends, stop all media tracks, disconnect the nodes, and flush the model:

```js
media.getTracks().forEach((track) => track.stop());
source.disconnect();
worklet.port.postMessage({ type: "flush" });
worklet.disconnect();
```

The worklet sends the final partial PCM packet, acknowledges `flushed`, and the
message handler above then sends `finish`. Wait for `isFinal: true`; a WebSocket
close by itself is not a final transcript.

## MOSS complete-file upload

The browser sends the recording to its own server. That server forwards it with
the private partner key:

```ts
const incoming = await request.formData();
const audio = incoming.get("audio");
if (!(audio instanceof File)) return new Response("audio is required", { status: 400 });

const upstream = new FormData();
upstream.set("audio", audio, audio.name || "recording.webm");
upstream.set("language", "auto");
upstream.set("hotwords", JSON.stringify(["Hablabla", "CopilotKit"]));
upstream.set("clientReference", crypto.randomUUID());

const response = await fetch(`${process.env.HABLABLA_SPEECH_URL}/v1/moss/transcriptions`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${process.env.HABLABLA_SPEECH_API_KEY}`,
    "idempotency-key": crypto.randomUUID(),
  },
  body: upstream,
});
```

The multipart fields are:

| Field | Required | Type | Meaning |
| --- | --- | --- | --- |
| `audio` | yes | file | Complete browser recording |
| `language` | no | string | `auto` (default), `en`, `zh`, or another two-letter language code |
| `hotwords` | no | JSON string | Array of at most 64 terms, each at most 80 characters |
| `clientReference` | no | string | Frontend correlation ID, at most 200 characters |

Do not manually set the multipart `Content-Type`; `fetch` must add its boundary.
The gateway accepts WAV, M4A/AAC, MP3, MP4, WebM/Opus, and Ogg/Opus, then uses
FFmpeg to validate, decode, downmix, and resample the file before MOSS sees it.

Creation returns `202` with `jobId`, `statusUrl`, and `eventsUrl`. Poll the status
URL from the partner server or proxy the SSE events. A completed result contains
`text` and any timestamped `segments`; queued and processing states are not a
transcription result.

```json
{
  "jobId": "moss_...",
  "status": "completed",
  "progress": 1,
  "clientReference": "meeting_123",
  "result": {
    "model": "vanch007/mlx-MOSS-Transcribe-Diarize-4bit",
    "language": "en",
    "durationMs": 8611,
    "text": "Hello world.",
    "segments": [
      { "id": "segment_001", "startMs": 0, "endMs": 2100, "speakerId": "speaker_0", "text": "Hello world." }
    ]
  }
}
```

Possible job states are `queued`, `processing`, `completed`, `failed`, and
`cancelled`. SSE messages use the same object inside `data: <json>` and end
after a terminal state.

## Errors and retry behavior

HTTP and WebSocket error messages share this shape:

```json
{
  "error": {
    "code": "INVALID_STREAM_CONFIG",
    "message": "Streaming audio must be 16 kHz mono pcm_s16le.",
    "retryable": false,
    "requestId": "req_..."
  }
}
```

Frontend behavior should follow `retryable`, retain `requestId` for debugging,
and show a user-visible failure instead of treating a closed socket or failed
job as an empty transcript. Common HTTP statuses are `400` invalid input, `401`
invalid API key, `403` disallowed origin, `404` unknown job, `413` file too
large, and `415` unsupported audio type.

## Operational limits

- Use 20–100 ms Parakeet packets; the server rejects packets over one second.
- Sequence numbers must be contiguous. WebSocket delivery is ordered, and a gap
  is treated as corrupted capture rather than silently hiding missing speech.
- The current upload default is 200 MiB.
- Preserve the MIME type and filename from `MediaRecorder`; both help FFmpeg
  identify the container.
- Never retry an offline upload with a new idempotency key unless a second job is
  actually intended.
