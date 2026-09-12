# Demo speech backend handoff

Verified on William's demo Mac on September 12, 2026. This guide covers the
standalone backend test console and a separate integration path for the team's
frontend. The test console is not the product frontend; its implementation does
not transfer ownership of product pages, components, or providers.

For step-by-step HTTP calls, PCM streaming, MOSS jobs, and troubleshooting,
read the [Speech API usage guide](speech-api-usage.md). The LAN address below
was refreshed after the September 12 Wi-Fi change.

## Choose the demo layout

| Layout | Use it for | Status |
| --- | --- | --- |
| Open Speech Lab on this Mac or another LAN device | Record, play back, inspect live text, run MOSS, and compare against a reference | Running; use the addresses below |
| Run the team's frontend and its server on this Mac; also use the browser on this Mac | Demonstrate the team's UI using local native speech models | Recommended product-demo layout; frontend owners must implement their server proxy |
| Run the team's frontend on another origin/device and call Speech Lab directly | Cross-origin product integration | Not supported by the current console; use a deliberate HTTP/WebSocket proxy or a separately configured TLS speech gateway |

Where the **browser** runs matters. A frontend server running on William's Mac
does not make `127.0.0.1` in a remote user's browser refer to William's Mac.

## Current working addresses

| Service | Address | Access |
| --- | --- | --- |
| Local test page and console API | `http://127.0.0.1:18766` | Browser on this Mac |
| LAN test page and console API | `https://192.168.137.253:18767` | Devices on the same private network |
| LAN hostname alternative | `https://WilliamdeMacBook-Pro.local:18767` | Requires working local mDNS resolution |
| Local console's internal speech gateway | `http://127.0.0.1:18765` | Internal, ephemeral bearer key |
| LAN console's internal speech gateway | `http://127.0.0.1:18768` | Internal, ephemeral bearer key |
| Dedicated gateway for the team's same-Mac frontend | `http://127.0.0.1:8765` | Separate configuration/startup described below; not started by the console |

The LAN listener binds to `0.0.0.0:18767`; the model gateways remain on loopback.
The IP is a current network assignment, not a permanent deployment address.
After changing Wi-Fi or DHCP address, restart the LAN launcher and share its
newly printed URL. The certificate and origin list are generated for those
addresses at startup.

From the repository root, use separate terminals:

```bash
# Local console
npm run demo --workspace speech-gateway

# LAN HTTPS console
HABLABLA_DEMO_LAN=1 npm run demo --workspace speech-gateway
```

Each command stays running. Ctrl+C stops only that launcher's gateway and worker
process group. The two instances can coexist. The launchers create their own
private keys; do not copy their internal port numbers into a frontend browser
configuration or expect the keys to be stable across restarts.

Remote recording needs HTTPS. Each test device must trust the self-signed
certificate or accept its browser certificate exception, then allow microphone
access. The public certificate is `.data/speech-demo/tls/server-cert.pem`;
`server-key.pem` is private and must stay on this Mac. No certificate trust or
firewall changes are installed automatically. Another device must still verify
connectivity; a Wi-Fi network with client isolation can prevent LAN access.

## Console HTTP and WebSocket interface

Use either console base URL from the table. These are the actual implemented
console paths, distinct from the native gateway's `/v1` HTTP routes:

| Method | Console path | Input / behavior |
| --- | --- | --- |
| GET | `/api/capabilities` | Model names, configuration presence, audio format, upload limit, Nemotron chunk tier |
| POST | `/api/nemotron/sessions` | JSON session configuration; returns one-use WebSocket URL |
| POST | `/api/parakeet/sessions` | Same audio configuration; no Nemotron hotwords |
| WebSocket | Returned `websocketUrl` | `/v1/nemotron/stream?ticket=...` or `/v1/parakeet/stream?ticket=...`, on the console's host and port |
| POST | `/api/jobs` | Multipart MOSS upload with `Idempotency-Key` |
| GET | `/api/jobs/:jobId` | Poll the MOSS job and retrieve its result |
| DELETE | `/api/jobs/:jobId` | Cancel the MOSS job; already terminal jobs retain their state |

No bearer credential is sent by the console browser. The console proxy supplies
its private bearer key to the internal gateway. Mutating HTTP requests require
both `Origin: <the console's exact origin>` and `X-Hablabla-Demo: 1`.
The browser supplies `Origin`; do not attempt to set it from browser JavaScript.
The proxy checks Host/Origin and does not enable cross-origin CORS. A frontend
on `http://127.0.0.1:3100` therefore cannot directly fetch the console at port
18766, even though both run on the same computer.

A session request from a page already served at the console origin:

```js
const response = await fetch('/api/nemotron/sessions', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Hablabla-Demo': '1',
  },
  body: JSON.stringify({
    origin: window.location.origin,
    language: 'auto', // or 'en', 'zh', or a supported language/locale
    audio: { encoding: 'pcm_s16le', sampleRateHz: 16000, channels: 1 },
    hotwords: ['amoxicillin', 'allergy'],
  }),
});
if (!response.ok) throw new Error(await response.text());
const { sessionId, websocketUrl } = await response.json();
const socket = new WebSocket(websocketUrl);
```

Use the returned URL unchanged. On the LAN it begins with
`wss://192.168.137.253:18767/` when that IP was used to open the page. The ticket
expires after 60 seconds, is single-use, and is bound to the exact browser
origin. A successful session POST means a ticket was created, not that the
model has loaded.

Streaming sequence:

1. Open the returned socket and send `{"type":"start"}`.
2. Wait for `ready` before recording/sending audio. Show model-loading progress
   and errors while waiting.
3. Send 16 kHz mono Int16 PCM with the 8-byte little-endian header: UInt32
   sequence (starting at zero), then UInt32 sample count, then PCM bytes.
4. Replace live text only with a newer `revision`. Nemotron partial text is in
   `volatileText`; the final text is in `confirmedText`.
5. Stop capture, flush the final partial packet, send `{"type":"finish"}`, and
   wait for `isFinal: true`. A socket close alone is not a successful result.

Reuse the [PCM worklet and full event contract](speech-api-frontend.md#parakeet-live-pcm).
Do not send MediaRecorder WebM chunks to the PCM socket.

For MOSS, submit the complete file:

```js
const form = new FormData();
form.set('audio', audioFile, audioFile.name);
form.set('language', 'auto');
form.set('hotwords', JSON.stringify(['amoxicillin', 'allergy']));
const idempotencyKey = crypto.randomUUID(); // retain this across transport retries
const response = await fetch('/api/jobs', {
  method: 'POST',
  headers: {
    'X-Hablabla-Demo': '1',
    'Idempotency-Key': idempotencyKey,
  },
  body: form,
});
if (!response.ok) throw new Error(await response.text());
const { jobId } = await response.json();
const statusResponse = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`);
if (!statusResponse.ok) throw new Error(await statusResponse.text());
const job = await statusResponse.json();
// Poll until completed, failed, or cancelled; only completed has final output.
```

Keep the original file MIME type and filename; omit a manually specified
multipart Content-Type. The console supports polling but does **not** proxy SSE.
Creation may return the internal gateway's `/v1/...` `statusUrl`/`eventsUrl`;
console clients must construct `/api/jobs/${jobId}` from `jobId` as above.
Do not request those internal HTTP URLs on port 18767.

A credential-free connectivity check from the demo Mac:

```bash
curl --cacert .data/speech-demo/tls/server-cert.pem \
  https://192.168.137.253:18767/api/capabilities
```

This checks the gateway connection and reported configuration, not inference.

## Team frontend and browser on this Mac

Use the ordinary speech gateway with a deliberately shared **server-side** key,
separate from the console launchers. Port 3100 below is an example frontend
origin; replace it with the actual port used by the frontend owner.

```text
Browser on this Mac: http://127.0.0.1:3100
    -> teammate's same-origin server routes
    -> http://127.0.0.1:8765/v1/... (Bearer key on the server)

Browser on this Mac
    -> returned ws://127.0.0.1:8765/v1/nemotron/stream?ticket=...
    -> native Nemotron 3.5 worker on this Mac
```

Configure these values in the ignored root `.env`. Replace the key placeholders
with the same randomly generated private demo key. Preserve any existing
unrelated environment values.

```dotenv
# Native speech gateway, started with npm run dev:speech
HABLABLA_SPEECH_HOST=127.0.0.1
HABLABLA_SPEECH_PORT=8765
HABLABLA_SPEECH_PUBLIC_URL=http://127.0.0.1:8765
HABLABLA_SPEECH_ALLOWED_ORIGINS=http://127.0.0.1:3100,http://localhost:3100
HABLABLA_SPEECH_API_KEYS=replace-with-private-demo-key
HABLABLA_SPEECH_WORKER=/Volumes/XcodeStable/Users/william/workspace/Hablabla/apps/macos-model-worker/.xcode-derived/Build/Products/Release/hablabla-model-worker
HABLABLA_NEMOTRON_MODEL_DIR=/Volumes/XcodeStable/Users/william/workspace/Hablabla/.data/models/nemotron-3.5-multilingual/2240ms

# Read by the teammate's server proxy; never expose as NEXT_PUBLIC_* variables
HABLABLA_SPEECH_URL=http://127.0.0.1:8765
HABLABLA_SPEECH_API_KEY=replace-with-private-demo-key
```

Start `npm run dev:speech`, then start the teammate's frontend/server using its
own README. Running the frontend alone does not configure the speech proxy.
The existing meeting UI is not connected to these routes by this handoff.

The frontend/backend owners implement:

- Same-origin server routes for capabilities, session creation, and MOSS
  create/read/cancel (plus SSE if wanted).
- Private Bearer injection for the actual `/v1` routes in the
  [speech OpenAPI contract](speech-api.openapi.yaml).
- An allowlisted origin derived on the server from the incoming browser request
  or a trusted fixed setting. Include it in session JSON; do not trust an
  arbitrary caller-supplied origin.
- Client recording and event handling using the PCM contract above. Browser
  requests carry the short-lived ticket, never the server key.

If the browser instead runs on a teammate's laptop, the localhost WebSocket URL
will point at that laptop. Use the working LAN console for the diagnostic demo,
or have the frontend/backend owners add a TLS WebSocket proxy to the product
server and agree its public origin. Serving frontend HTML on William's Mac
alone is insufficient. A reverse proxy using the existing console also needs
to forward HTTP and WebSocket traffic, use the console's exact upstream
Host/Origin, and rewrite returned WebSocket URLs to the frontend's public
origin. That product integration is not implemented here.

## Model and demo readiness

The installed test preset is Nemotron 3.5 ASR Streaming Multilingual 0.6B with
the full vocabulary and 2,240 ms chunks. `ready.model`, `ready.chunkMs`, and
`ready.hotwordCount` identify the actual live configuration. If assets are
missing, install them before the demo:

```bash
node apps/macos-model-worker/scripts/install-nemotron.mjs
(cd apps/macos-model-worker && ./scripts/build-release.sh)
```

Before presenting, open the chosen URL, allow the microphone, record a short
sample, stop, and check the final text against playback. For another LAN device,
verify certificate trust and connectivity on that device. Keep the gateway
terminal running and the Mac awake. Run one recognition test at a time until
concurrent model capacity has been measured.

The current evidence includes English and Mandarin synthetic speech through
Nemotron 3.5, and a real HTTPS/WSS Mandarin run with partial and final events.
Actual consultation accuracy, medical terminology, and speaker attribution
still require review on representative human recordings. See
[Speech Lab's verification notes](../apps/speech-gateway/demo/README.md#verification).
