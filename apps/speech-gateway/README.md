# Hablabla public speech API

This gateway lets approved web applications use a model worker running on the
demo Mac without exposing the native process itself.

```text
partner browser -> HTTPS/WSS gateway -> local Swift worker -> Core ML / MLX
```

- Parakeet TDT 0.6B v3 receives ordered 16 kHz mono Int16 PCM over WebSocket
  and returns revisable live transcript state.
- MOSS receives a complete browser audio file, normalizes it with FFmpeg, runs
  as a queued offline job, and returns text plus available speaker segments.
- The long-lived partner API key is for server-to-server calls. Browsers receive
  only a single-use, origin-bound Parakeet ticket that expires after 60 seconds.

## Run locally

Requirements: macOS 15+, Apple Silicon, Swift 6.2, Node.js 22+, and FFmpeg.

```bash
cd apps/macos-model-worker
./scripts/build-release.sh
cd ../..
cp .env.example .env
```

Use the Xcode build script for the runnable worker. MOSS depends on MLX Metal
resources that a plain command-line `swift build` does not package.

Set the speech variables in `.env`, then:

```bash
npm run dev:speech
```

The default listener is `127.0.0.1:8765`. Put an authenticated HTTPS reverse
proxy or tunnel in front of it for remote clients. Keep the native worker and
the gateway listener off the public LAN; expose only the TLS endpoint.

Model weights download from their publishers on the first real run. A successful
build does not prove that either model is downloaded or that real inference has
completed.

## Routes

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/healthz` | Process liveness; does not assert model readiness |
| `GET` | `/v1/capabilities` | Audio formats, models, and upload limit |
| `POST` | `/v1/parakeet/sessions` | Create a one-time browser WebSocket ticket |
| `WSS` | `/v1/parakeet/stream?ticket=...` | Send framed PCM and receive live text |
| `POST` | `/v1/nemotron/sessions` | Create a multilingual live-transcription ticket with optional hotwords |
| `WSS` | `/v1/nemotron/stream?ticket=...` | Send framed PCM and receive Nemotron live text |
| `POST` | `/v1/moss/transcriptions` | Upload a complete file and create a queued job |
| `GET` | `/v1/moss/transcriptions/:id` | Read job progress or result |
| `GET` | `/v1/moss/transcriptions/:id/events` | Receive progress with SSE |
| `DELETE` | `/v1/moss/transcriptions/:id` | Cancel queued conversion/inference |

All `/v1` HTTP routes require `Authorization: Bearer <partner-api-key>`. MOSS
creation also requires a unique `Idempotency-Key` header.

The [frontend speech API contract](../../dev-docs/speech-api-frontend.md) is the
source of truth for exact request bodies, binary framing, response events,
errors, and copyable browser/server examples.

Start with the [English API usage guide](../../dev-docs/speech-api-usage.md)
for current LAN URLs, copyable curl requests, PCM streaming, and job handling.

## Scheduling and retention

MOSS jobs run one at a time. Uploaded files are placed in a mode-0600 temporary
directory and removed after conversion/inference, cancellation, or failure.
Completed in-memory results expire after one hour. Audio and transcript contents
are not intentionally logged by the gateway.

For the demo, do not run MOSS while latency-sensitive Parakeet sessions are in
progress unless the Mac has been profiled with both model allocations. The
current queue serializes MOSS jobs but does not yet pause them for an incoming
Parakeet session.
# Nemotron hotwords

`POST /v1/nemotron/sessions` and its returned WebSocket URL support multilingual
Nemotron with per-session `hotwords: string[]`. Audio framing is identical to
Parakeet. Configure `HABLABLA_NEMOTRON_MODEL_DIR` and rebuild the native worker;
see [the frontend contract](../../dev-docs/speech-api-frontend.md#nemotron-multilingual-streaming-with-medical-hotwords)
for payloads, asset requirements, limits, and error behavior. The model directory
must be a FluidAudio multilingual export, not the English-only model. Vocabulary
bias needs logits-capable decoder assets and does not guarantee clinical accuracy.

## Backend recording test page

Run `npm run demo --workspace speech-gateway` from the repository root for the
standalone English Speech Lab. For LAN HTTPS access, run
`HABLABLA_DEMO_LAN=1 npm run demo --workspace speech-gateway`.
See [the test console guide](demo/README.md) for recording, the Nemotron 3.5
multilingual preset, certificate setup, quality comparisons, and test evidence.
This diagnostic tool is separate from the team's product frontend.

The [demo handoff](../../dev-docs/demo-speech-handoff.md) records the current LAN
address and API examples, and explains how to run the teammate-owned frontend
and a separately configured speech gateway together on the demo Mac.
