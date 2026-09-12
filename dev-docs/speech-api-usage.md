# Speech API usage guide

For teammates integrating recording, live transcription, and complete-file
transcription with William's native speech backend. Addresses and console
connectivity were checked on September 12, 2026, after the Wi-Fi change.

## 1. Choose the correct base URL

| Environment | Base URL | HTTP authentication |
| --- | --- | --- |
| LAN Speech Lab | `https://192.168.137.253:18767` | Console headers below; no browser bearer key |
| Speech Lab on this Mac | `http://127.0.0.1:18766` | Same console contract |
| Separately configured speech gateway | `http://127.0.0.1:8765` by default | Server-side Bearer key for all `/v1` HTTP routes |

The LAN address is the current Wi-Fi IP and can change. Restart the LAN
launcher after changing networks and use its printed URL:

```bash
HABLABLA_DEMO_LAN=1 npm run demo --workspace speech-gateway
```

For the local console, use `npm run demo --workspace speech-gateway` instead.
Keep the terminal running. The console launches its own internal gateway;
port 8765 is a separate setup, not a service started by that command.

Other LAN devices need HTTPS certificate trust/acceptance and microphone
permission. The public certificate is `.data/speech-demo/tls/server-cert.pem`;
keep `server-key.pem` private. Wi-Fi client isolation can block peer access.

**Product frontend integration:** a browser page served on port 3100 cannot
directly fetch the console on port 18766 or 18767. The console requires the
same origin and does not offer cross-origin CORS. Use your web server's proxy
and a configured speech gateway; see [same-Mac setup](demo-speech-handoff.md#team-frontend-and-browser-on-this-mac).
These instructions do not install that proxy in the teammate-owned frontend.

## 2. Endpoint map

Use the **console** column with either Speech Lab URL. Use the **gateway**
column with your server's configured speech gateway URL.

| Method | Console path | Gateway path | Success |
| --- | --- | --- | --- |
| GET | Not exposed | `/healthz` | `200`, process liveness only; no Bearer required |
| GET | `/api/capabilities` | `/v1/capabilities` | `200`, supported formats and configuration |
| POST | `/api/nemotron/sessions` | `/v1/nemotron/sessions` | `201`, one-use WebSocket ticket |
| POST | `/api/parakeet/sessions` | `/v1/parakeet/sessions` | `201`, one-use WebSocket ticket |
| WebSocket | Returned `websocketUrl` | Returned `websocketUrl` | Live JSON events; send framed PCM |
| POST | `/api/jobs` | `/v1/moss/transcriptions` | `202` new job; `200` existing idempotent job |
| GET | `/api/jobs/:jobId` | `/v1/moss/transcriptions/:jobId` | `200`, current status/result |
| DELETE | `/api/jobs/:jobId` | `/v1/moss/transcriptions/:jobId` | `200`, cancelled or already terminal state |
| GET | Not exposed | `/v1/moss/transcriptions/:jobId/events` | `200`, SSE status/result stream |

The console proxies WebSocket paths `/v1/nemotron/stream?ticket=...` and
`/v1/parakeet/stream?ticket=...`. It does **not** proxy `/v1` HTTP routes or SSE.
The [OpenAPI file](speech-api.openapi.yaml) describes the gateway HTTP API;
do not use the console base URL with those paths.

### Request headers

For console POST/DELETE requests, send:

```http
Origin: https://192.168.137.253:18767
X-Hablabla-Demo: 1
```

The Origin must match the chosen console URL, including scheme and port.
Browsers supply Origin automatically; set it explicitly in command-line
clients. For gateway HTTP calls, your server supplies
`Authorization: Bearer <private-api-key>`. Keep the key out of browser code,
storage, `NEXT_PUBLIC_*` variables, and WebSocket URLs. The console already
injects its own private key upstream.

## 3. Check connectivity and model configuration

Run these shell examples from the repository root on the demo Mac. On a
teammate's machine, set `DEMO_CA` to a copy of the public certificate.

```bash
DEMO_URL='https://192.168.137.253:18767'
DEMO_CA='.data/speech-demo/tls/server-cert.pem'

curl --fail-with-body --cacert "$DEMO_CA" \
  "$DEMO_URL/api/capabilities"
```

The current response reports Nemotron model
`nemotron-3.5-asr-streaming-multilingual-0.6b`, `chunkMs: 2240`,
`configured: true`, and `maximumHotwords: 64`. It also reports Parakeet,
MOSS upload MIME types, and `maximumUploadBytes` (currently 209715200).
Configuration and HTTP success do not prove inference readiness; wait for
the stream's `ready` event or the job's `completed` state.

## 4. Create a live transcription session

Nemotron 3.5 is the multilingual live option. This command creates a ticket
without starting microphone capture or model inference:

```bash
curl --fail-with-body --cacert "$DEMO_CA" \
  "$DEMO_URL/api/nemotron/sessions" \
  -H "Origin: $DEMO_URL" \
  -H 'X-Hablabla-Demo: 1' \
  -H 'Content-Type: application/json' \
  --data-binary @- <<JSON
{
  "origin": "$DEMO_URL",
  "language": "auto",
  "audio": { "encoding": "pcm_s16le", "sampleRateHz": 16000, "channels": 1 },
  "hotwords": ["amoxicillin", "metformin", "HbA1c"]
}
JSON
```

Response shape (IDs and expiry below are illustrative):

```json
{
  "sessionId": "st_<opaque-id>",
  "websocketUrl": "wss://192.168.137.253:18767/v1/nemotron/stream?ticket=ticket_<opaque-id>",
  "ticketExpiresAt": "2026-09-12T23:00:00.000Z"
}
```

| Field | Rules |
| --- | --- |
| `origin` | Required, exact allowlisted browser origin |
| `audio` | Required: `pcm_s16le`, 16000 Hz, one channel |
| `language` | Defaults to `en`; Nemotron also accepts `auto`. Two-letter codes such as `en`/`zh` and optional regions are accepted; model support determines recognition availability |
| `hotwords` | Nemotron only: optional array, at most 64 nonblank strings, each at most 80 UTF-16 code units. Trimmed and exact duplicates removed. Omitted/empty disables biasing |

For Parakeet, change the route to `/api/parakeet/sessions`, set `language`
to `en` or another model-supported code, and omit `hotwords`. Parakeet's
session endpoint does not accept `auto`.

A ticket expires in 60 seconds, is single-use, and is bound to the request's
browser origin. Use the returned URL unchanged. If it expires or the socket
disconnects, obtain a new ticket; live sessions cannot resume. Native WebSocket
clients must explicitly send the same Origin header during the upgrade.

### Browser request from the console origin

```js
const response = await fetch('/api/nemotron/sessions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Hablabla-Demo': '1' },
  body: JSON.stringify({
    origin: location.origin,
    language: 'auto',
    audio: { encoding: 'pcm_s16le', sampleRateHz: 16000, channels: 1 },
    hotwords: ['amoxicillin', 'metformin'],
  }),
});
if (!response.ok) throw new Error(await response.text());
const session = await response.json();
```

For the product frontend, replace this fetch with a call to its own server
route. That server creates the gateway session using its private key and a
trusted browser origin.

## 5. Send PCM and consume live events

The following transport example continues from `session` above. It expects
your recorder to supply actual 16 kHz mono `Int16Array` buffers. It does not
request microphone permission or implement recording controls.

```js
const socket = new WebSocket(session.websocketUrl);
let ready = false;
let finishing = false;
let finalReceived = false;
let sequence = 0;
let latestRevision = -1;

socket.onopen = () => socket.send(JSON.stringify({ type: 'start' }));
socket.onmessage = ({ data }) => {
  const event = JSON.parse(data);
  if (event.type === 'ready') ready = true;
  if (event.type === 'error') {
    ready = false;
    console.error(event.error);
  }
  if (event.type === 'transcript' && event.revision > latestRevision) {
    latestRevision = event.revision;
    finalReceived = event.isFinal === true;
    // Replace the displayed snapshot; do not append partial results.
    console.log(event.confirmedText, event.volatileText, event.isFinal);
  }
};
socket.onerror = () => console.error('Speech connection failed');
socket.onclose = () => {
  ready = false;
  if (!finalReceived) console.error('Stream ended without a final transcript');
};

function sendPcm(samples) {
  if (!ready || finishing || socket.readyState !== WebSocket.OPEN) {
    throw new Error('The speech stream is not accepting audio');
  }
  if (!(samples instanceof Int16Array) || samples.length < 1 || samples.length > 16000) {
    throw new Error('Expected 1–16000 signed Int16 samples');
  }
  const packet = new ArrayBuffer(8 + samples.length * 2);
  const view = new DataView(packet);
  view.setUint32(0, sequence++, true);
  view.setUint32(4, samples.length, true);
  samples.forEach((sample, index) => view.setInt16(8 + index * 2, sample, true));
  socket.send(packet);
}

function finishAfterRecorderFlush() {
  if (!ready || finishing || socket.readyState !== WebSocket.OPEN) {
    throw new Error('The speech stream cannot finish in its current state');
  }
  finishing = true;
  socket.send(JSON.stringify({ type: 'finish' }));
}
```

For microphone capture, use the supplied
[PCM AudioWorklet](../apps/speech-gateway/examples/hablabla-pcm16-worklet.js)
and [capture lifecycle example](speech-api-frontend.md#parakeet-live-pcm):

1. Wait for `ready`, then start capture. Verify the actual AudioContext sample
   rate is 16000; resample if necessary. Changing metadata does not resample.
2. Pass each worklet PCM buffer to `sendPcm(new Int16Array(buffer))`.
   The worklet emits 1600 samples (100 ms) per full packet.
3. On Stop, stop the microphone tracks, disconnect the source, and send
   `{ type: 'flush' }` to the worklet. Send its final short PCM buffer too.
4. After the worklet acknowledges `{ type: 'flushed' }`, call
   `finishAfterRecorderFlush()`. Keep the socket open until the final result;
   close the audio context and release recording resources.

Binary framing is an 8-byte header followed by PCM: UInt32 little-endian
sequence at offset 0, UInt32 sample count at offset 4, Int16 little-endian
samples at offset 8. Sequence starts at zero and must be contiguous. Each
packet contains 1–16000 samples. Monitor `socket.bufferedAmount` in the actual
client and show an error if capture cannot keep up; do not silently drop frames.
WebM/Opus chunks, WAV headers, and MediaStream objects are not valid PCM packets.

| Event | Meaning / client action |
| --- | --- |
| `connected` | Socket accepted; the model may still be loading |
| `progress` | Display `stage` and `progress` while loading/processing |
| `ready` | Model can consume audio. Nemotron includes `model`, `chunkMs`, and `hotwordCount` |
| `transcript` | Replace text by increasing `revision`; display `confirmedText` and `volatileText` |
| `error` | Show the error and retain its `requestId`; stop capture |

Nemotron partial text is a complete snapshot in `volatileText`. Its final
snapshot moves text to `confirmedText` and sets `isFinal: true`. `audioEndMs`
counts received audio; it is not word alignment. A clean socket close alone
does not establish a successful transcription.

## 6. Upload a complete recording to MOSS

MOSS runs an offline transcription/diarization job. Replace the file path:

```bash
# Generate once per logical upload; retain this value for transport retries.
UPLOAD_KEY="$(uuidgen)"

curl --fail-with-body --cacert "$DEMO_CA" \
  "$DEMO_URL/api/jobs" \
  -H "Origin: $DEMO_URL" \
  -H 'X-Hablabla-Demo: 1' \
  -H "Idempotency-Key: $UPLOAD_KEY" \
  -F 'audio=@/absolute/path/consultation.wav;type=audio/wav' \
  -F 'language=auto' \
  -F 'hotwords=["amoxicillin","metformin"]' \
  -F 'clientReference=consultation-demo-001'
```

| Multipart field | Rules |
| --- | --- |
| `audio` | Required nonempty complete file; preserve filename and MIME type |
| `language` | Optional; defaults to `auto`, or a language code such as `en`/`zh` |
| `hotwords` | Optional JSON-encoded string array, at most 64 terms of at most 80 UTF-16 code units each |
| `clientReference` | Optional application correlation string; truncated to 200 characters |

Accepted MIME types are `audio/wav`, `audio/x-wav`, `audio/mpeg`, `audio/mp4`,
`audio/x-m4a`, `audio/webm`, and `audio/ogg`. AAC must be in a supported
container such as M4A; raw `audio/aac` is not accepted. The current 200 MiB
limit applies to the entire multipart body, including overhead. FFmpeg validates
and normalizes the audio before inference. Let curl/FormData set the multipart
Content-Type boundary.

A new upload returns `202` with `jobId`, `status`, `statusUrl`, and `eventsUrl`.
An idempotent replay returns `200` with the existing job snapshot. Reuse the
same key only for the same logical upload; the gateway does not compare replay
bodies. After a failed job, an intentional new attempt needs a new key.

### Poll and cancel

Copy the actual returned `jobId` into this variable:

```bash
JOB_ID='moss_<returned-id>'

curl --fail-with-body --cacert "$DEMO_CA" \
  "$DEMO_URL/api/jobs/$JOB_ID"

# Cancel this job if it is still queued or processing.
curl --fail-with-body --cacert "$DEMO_CA" \
  -X DELETE "$DEMO_URL/api/jobs/$JOB_ID" \
  -H "Origin: $DEMO_URL" \
  -H 'X-Hablabla-Demo: 1'
```

Poll about once per second until `completed`, `failed`, or `cancelled`.
Only `completed` establishes a successful result. An illustrative result is:

```json
{
  "jobId": "moss_<opaque-id>",
  "status": "completed",
  "progress": 1,
  "clientReference": "consultation-demo-001",
  "result": {
    "model": "vanch007/mlx-MOSS-Transcribe-Diarize-4bit",
    "language": "en",
    "durationMs": 4200,
    "text": "The cough started three days ago.",
    "segments": [
      {
        "id": "segment_001",
        "startMs": 0,
        "endMs": 4200,
        "speakerId": "speaker_0",
        "text": "The cough started three days ago."
      }
    ]
  }
}
```

Treat speaker IDs as anonymous labels. They do not identify a doctor, patient,
or enrolled person. Segment availability depends on the model output.

**Console URL caveat:** upload responses contain gateway-relative `/v1/...`
status/event URLs. Console clients must construct `/api/jobs/${jobId}` and
poll there. They cannot follow the returned SSE URL through the console.

For a configured gateway, the partner server can consume SSE instead:

```bash
# GATEWAY_URL and SPEECH_KEY are private server/terminal environment values.
curl --fail-with-body --no-buffer \
  -H "Authorization: Bearer $SPEECH_KEY" \
  "$GATEWAY_URL/v1/moss/transcriptions/$JOB_ID/events"
```

Each SSE message contains `data: <job JSON>` and a blank line. The stream ends
at a terminal state; reconnecting returns the current snapshot. Browser
EventSource needs a same-origin server proxy to keep the Bearer key private.

## 7. Errors, retries, and demo limits

Gateway HTTP errors contain `error.code`, `error.message`, `error.retryable`,
and `error.requestId`. WebSocket errors also include `type: "error"`.
Console-generated errors may contain only `error.message`; tolerate missing
diagnostic fields. Failed jobs expose `error` in their status snapshot.

| Symptom | Action |
| --- | --- |
| `400` | Check audio metadata, language, hotwords, multipart fields, and idempotency header |
| `401` | Fix the partner server's gateway Bearer key |
| `403` HTTP | Use the printed console URL and required headers, or fix the configured gateway origin |
| `403` WebSocket | Check exact Origin, correct model path, ticket expiry, and previous ticket use |
| `404` | Check the console/gateway path and job ID; jobs also disappear after restart/expiry |
| `413` / `415` | Reduce upload size / preserve a supported MIME type and container |
| `502` from console | Check its terminal and internal gateway process |
| `503 MODEL_NOT_CONFIGURED` | Configure the Nemotron model directory before creating a session |
| Worker error before `ready` | Check the native worker, model assets, and terminal diagnostics |
| No microphone | Check HTTPS certificate trust, browser permission, and actual device availability |

Live sessions have no resume/replay buffer. Retain the recording if recovery
is needed. Jobs and tickets are in memory and disappear on gateway restart.
Terminal jobs are eligible for cleanup one hour after creation; export results
promptly. MOSS jobs run serially. Test one model at a time on the demo Mac
until concurrent capacity has been measured.

Hotwords bias recognition; they do not guarantee exact medical terms or
correct dosage. Validate representative recordings against playback before
presenting accuracy claims. This guide documents the API; it does not turn
sample or synthetic-audio checks into proof of consultation accuracy.

## Related documentation

- [Demo startup, addresses, and same-Mac frontend configuration](demo-speech-handoff.md)
- [Detailed browser/server integration contract](speech-api-frontend.md)
- [Importable gateway OpenAPI 3.1 specification](speech-api.openapi.yaml)
- [English recording test console and verification notes](../apps/speech-gateway/demo/README.md)
- [Other backend APIs](backend-api.md)
