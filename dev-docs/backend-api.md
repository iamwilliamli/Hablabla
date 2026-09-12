# Hablabla Backend API Reference

Updated: September 12, 2026. Integration reference for frontend and backend developers, checked against the current source. William owns backend work only; this documentation task does not change frontend code.

**An implemented endpoint is not necessarily deployed.** Public deployment, API account access, and real model inference were not verified for this document. The backend owner supplies actual public URLs and credentials separately; example domains are placeholders. The workspace contains concurrent development changes, so confirm matching versions before integration testing.

## Frontend Integration Ownership and Current Blockers

The speech gateway interfaces are defined, but `apps/web` currently has no speech proxy routes that protect the long-lived Bearer key. Frontend code must therefore not put `HABLABLA_SPEECH_API_KEY` in the browser or call protected `/v1/*` HTTP endpoints directly from a page.

| Owner | Next steps | Acceptance criteria |
| --- | --- | --- |
| Renzo (web backend) | Add same-origin server routes to create Parakeet tickets, forward MOSS uploads, query/cancel jobs, and either proxy SSE or support page polling. Read keys only from the server environment and derive ticket `origin` from trusted request context. | No long-lived key in browser network traffic or build artifacts; preserve error states and `requestId` in frontend responses. |
| Ahmad (recording and transcript frontend) | Integrate the PCM worklet; wait for `ready` before streaming; replace transcript snapshots by `revision`; flush before sending `finish` and wait for `isFinal: true`. Preserve the actual MIME type and filename when uploading offline recordings to the same-origin proxy. | Real recordings exercise loading, live, final, failed, and cancelled states; revised text is not appended twice and socket closure is not treated as success. |
| Arjun (analysis and agent frontend) | Consume only confirmed transcripts/segments. Display generic `speakerId` labels without inferring real identities. Keep analysis and task approval on their existing contracts. | Analysis input is traceable to the current transcript revision; tasks are not written without user approval. |
| William (speech backend) | Maintain this document, OpenAPI, frame protocol, worker, and gateway. Supply integration addresses, allowed Origins, separate keys, and measured model status. | Separate live integration evidence for `/healthz`, capabilities, one live stream, and one complete-file job. |

The backend owner must finalize same-origin proxy paths before frontend implementation begins. `/api/hablabla/parakeet-session` is an example name, not an existing route. See the [Speech API contract](speech-api-frontend.md#frontend-integration-handoff) for browser examples and the acceptance checklist.

## 1. Service Addresses and Access Boundaries

| Service | Default local address | Scope |
| --- | --- | --- |
| Speech gateway | `http://127.0.0.1:8765` | Primary integration service; external deployment requires HTTPS/WSS and controlled access |
| Internal web API | `http://127.0.0.1:3100` | Local application use; not a hardened public API |
| Companion development relay | Separate process; see its protocol document | Device-control workflow, separate from the speech gateway |

See the [gateway README](../apps/speech-gateway/README.md) for startup instructions and model build requirements. The gateway uses `HABLABLA_SPEECH_PUBLIC_URL`; a caller's server can store the supplied address in `HABLABLA_SPEECH_URL`. These are different configuration settings.

The gateway accepts Bearer keys configured in `HABLABLA_SPEECH_API_KEYS`. The caller's server stores its own key, for example as `HABLABLA_SPEECH_API_KEY`. Browsers receive only short-lived WebSocket tickets, never long-lived keys. HTTP requests with an `Origin` header must pass the `HABLABLA_SPEECH_ALLOWED_ORIGINS` allowlist, including health checks. Server requests without `Origin` still require a valid key for protected endpoints.

## 2. Speech Gateway: Eight Endpoints

| Method | Path | Authentication | Purpose / success response |
| --- | --- | --- | --- |
| GET | `/healthz` | No key | `200 {"status":"ok"}`; process liveness only |
| GET | `/v1/capabilities` | Bearer | Models, transport formats, MIME types, and upload limit; not model readiness |
| POST | `/v1/parakeet/sessions` | Bearer | `201`; create a live-transcription ticket |
| WebSocket | `/v1/parakeet/stream?ticket=...` | Single-use ticket + matching Origin | Receive PCM and return live transcript events |
| POST | `/v1/moss/transcriptions` | Bearer + Idempotency-Key | `202`; upload a complete audio file and queue a job |
| GET | `/v1/moss/transcriptions/:jobId` | Bearer | `200`; job status and result |
| GET | `/v1/moss/transcriptions/:jobId/events` | Bearer | `200 text/event-stream`; SSE status snapshots |
| DELETE | `/v1/moss/transcriptions/:jobId` | Bearer | `200`; cancel an unfinished job and return its current state; does not delete results |

See the [Speech API contract](speech-api-frontend.md) for the detailed streaming protocol and integration examples, and [OpenAPI 3.1](speech-api.openapi.yaml) for HTTP schemas. Response examples below illustrate structure; they are not recorded inference results.

### 2.1 Check Capabilities

Run these commands on the caller's server after securely configuring its environment variables. Do not paste real keys into documentation or commits:

```bash
curl --fail-with-body "$HABLABLA_SPEECH_URL/healthz"
curl --fail-with-body "$HABLABLA_SPEECH_URL/v1/capabilities" \
  -H "Authorization: Bearer $HABLABLA_SPEECH_API_KEY"
```

The response includes `streaming.model/transport/audio` and `offline.model/transport/acceptedContentTypes/maximumUploadBytes`. Use the returned MIME list and upload limit.

### 2.2 Parakeet Live Transcription

Call sequence: your server requests a ticket → browser connects to the returned URL → wait for `ready` → stream audio frames → send `finish` → wait for the final transcript.

```bash
curl --fail-with-body "$HABLABLA_SPEECH_URL/v1/parakeet/sessions" \
  -H "Authorization: Bearer $HABLABLA_SPEECH_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"origin":"https://partner.example.com","language":"en","audio":{"encoding":"pcm_s16le","sampleRateHz":16000,"channels":1}}'
```

`origin` is required and must be allowlisted; replace the placeholder domain above. `language` defaults to `en` and accepts a two-letter lowercase language code with an optional region suffix, such as `en-US`. Valid syntax does not establish model support for that language. All three `audio` values must match the example.

```json
{
  "sessionId": "st_...",
  "websocketUrl": "wss://speech.example.com/v1/parakeet/stream?ticket=ticket_...",
  "ticketExpiresAt": "2026-09-12T18:30:00.000Z"
}
```

Tickets expire after 60 seconds, are single-use, and require a matching `Origin` on the upgrade request. Request a new ticket to reconnect. Do not put the returned URL in ordinary logs.

- Audio must be **16 kHz, mono, signed Int16 little-endian PCM**, not a WebM Blob or browser MediaStream object.
- Each binary frame contains a 4-byte UInt32 LE sequence number (starting at 0, increasing without gaps), a 4-byte UInt32 LE sample count, and PCM data. Each frame contains 1–16000 samples; PCM byte length must equal sample count × 2.
- Supported JSON text frames are `{"type":"start"}` and `{"type":"finish"}`. `start` does not replace the audio configuration supplied when creating the session. Send remaining PCM before finishing.
- Events include `connected`, `progress`, `ready`, `transcript`, and `error`. `connected` does not mean the model has finished loading.
- `transcript` contains `revision`, `confirmedText`, `volatileText`, `audioEndMs`, and `isFinal`. Replace the transcript snapshot by revision; do not append each event as new text.
- A closed connection is not proof of success. Use `isFinal: true` to identify the final transcript.

### 2.3 MOSS Full-File Transcription and Speaker Segments

```bash
# Reuse this value when retrying the same upload; generate a new value for a new recording.
speech_request_id=$(uuidgen)
curl --fail-with-body "$HABLABLA_SPEECH_URL/v1/moss/transcriptions" \
  -H "Authorization: Bearer $HABLABLA_SPEECH_API_KEY" \
  -H "Idempotency-Key: $speech_request_id" \
  -F 'audio=@/absolute/path/recording.webm;type=audio/webm' \
  -F 'language=auto' \
  -F 'hotwords=["Hablabla"]' \
  -F 'clientReference=meeting-123'
```

| Field | Constraints |
| --- | --- |
| `audio` | Required, nonempty file; MIME type must appear in the capabilities response |
| `language` | Defaults to `auto`; accepts formats such as `en`, `zh`, and `en-US`, without guaranteeing model language coverage |
| `hotwords` | Optional JSON string array; at most 64 entries, each at most 80 characters |
| `clientReference` | Optional business correlation string; truncated after 200 characters; not an authentication credential |
| `Idempotency-Key` header | Required, 1–200 characters after trimming; a matching retained job is returned without comparing the new file's contents |

Do not manually set the multipart `Content-Type`; let curl/fetch generate the boundary. Current MIME types are `audio/wav`, `audio/x-wav`, `audio/mpeg`, `audio/mp4`, `audio/x-m4a`, `audio/webm`, and `audio/ogg`. An `.mp4` filename does not mean that `video/mp4` is accepted.

The default upload limit is 200 MiB and also applies to the raw multipart request body. Leave room for fields and multipart overhead. The backend uses FFmpeg to decode, downmix to mono, and resample before passing audio to MOSS.

Initial creation returns:

```json
{"jobId":"moss_...","status":"queued","statusUrl":"/v1/moss/transcriptions/moss_...","eventsUrl":"/v1/moss/transcriptions/moss_.../events"}
```

A retry matching an existing key returns a `200` job snapshot, not the `202` creation structure above. Both returned URLs are relative paths; resolve them against the speech gateway address.

```bash
# Replace with the actual jobId from the creation response.
speech_job_id='moss_...'
curl --fail-with-body "$HABLABLA_SPEECH_URL/v1/moss/transcriptions/$speech_job_id" \
  -H "Authorization: Bearer $HABLABLA_SPEECH_API_KEY"
curl --fail-with-body -N "$HABLABLA_SPEECH_URL/v1/moss/transcriptions/$speech_job_id/events" \
  -H "Authorization: Bearer $HABLABLA_SPEECH_API_KEY"
# Call only when the user requests cancellation:
curl --fail-with-body -X DELETE "$HABLABLA_SPEECH_URL/v1/moss/transcriptions/$speech_job_id" \
  -H "Authorization: Bearer $HABLABLA_SPEECH_API_KEY"
```

Every job snapshot contains `jobId/status/progress/clientReference`, with optional `result` or `error` depending on state. States progress through `queued → processing → completed/failed`; unfinished jobs can become `cancelled`. A completed job's `result` contains `model/language/durationMs/text/segments`. Each segment contains `id/startMs/endMs/speakerId/text`, with timestamps in milliseconds. Speaker segmentation does not identify a person's real name, and segments are not guaranteed to be present.

SSE uses `data: <job snapshot JSON>` without custom event names. Clients should disconnect after receiving a terminal state; the current code does not guarantee an immediate close for new subscriptions to already-finished jobs. Native browser EventSource cannot attach the required Bearer header; use a caller-side server proxy or a streaming request that supports that header.

### 2.4 Errors and Operational Limits

HTTP errors use `{"error":{"code":"...","message":"...","retryable":false,"requestId":"req_..."}}`; WebSocket errors also include `type: "error"`. Error messages may contain worker/FFmpeg diagnostics. Treat them as sensitive data and do not write them directly to public logs.

| Status | Common cause |
| --- | --- |
| 400 | Invalid parameters, stream configuration, or multipart body; missing or invalid Idempotency-Key |
| 401 | Missing or invalid Bearer key |
| 403 | Disallowed Origin; missing, expired, used, or mismatched WebSocket ticket |
| 404 | Unknown endpoint or nonexistent/expired jobId |
| 413 | Upload limit exceeded |
| 415 | Unsupported file MIME type |
| 500 | Internal gateway error |

An asynchronous model failure appears as job `status: "failed"`; the status query may still return HTTP 200. Retry only when permitted by `retryable` and the business state. A new upload key creates a new job.

Jobs and tickets are stored in process memory and are lost on restart. Terminal jobs become eligible for periodic cleanup approximately one hour after creation, not one hour after completion. Cancellation does not delete results. MOSS jobs run serially; this is not a durable job system. API keys do not provide per-user job isolation: authorized keys share the job space. Do not treat this prototype as a multi-tenant public service.

## 3. Internal Web API (Do Not Expose Directly to the Internet)

### 3.1 Meeting Analysis Prototype: `/api/meeting-agent`

- `GET` → `200 {configured: boolean, model: string}`. `configured` only indicates a nonempty server-side key; it does not validate the account, model, or balance.
- `POST` → non-streaming JSON. The server reads `OPENAI_API_KEY` and `OPENAI_MODEL`. The backend must configure and verify the model; do not send a key or model in the request body.
- This route currently has no dedicated user authentication, trusted-Origin validation, or rate limiting. Do not expose it directly to the internet. There is no Local/OpenAI frontend switch or automatic fallback from local inference.

The following call sends an excerpt of the transcript and the question to an external model service. Use only authorized data; this example uses fictional content:

```bash
curl --fail-with-body http://127.0.0.1:3100/api/meeting-agent \
  -H 'Content-Type: application/json' \
  -d '{"meetingId":"MTG-example","transcript":"Alice will send the draft tomorrow.","question":"Summarize the agreed action.","structured":true}'
```

All four request fields are required; extra fields are rejected. `meetingId` must be 1–120 characters, `transcript` 1–50000 characters, `question` 1–1000 characters after trimming, and `structured` a boolean. The server additionally bounds the UTF-8 prompt, so it cannot claim to analyze an entire long transcript. Multi-turn chat history is not accepted.

`structured: false` returns `{text: string}`; `true` returns `{text: string, result: {summary, decisions, actions, questions}}`. Decisions contain `text/evidence`; actions contain `title/description/owner/due/evidence`. Evidence must match the input transcript. Generating suggestions does not save tasks. The server request sets `store: false`; this does not mean all audio/text stays on the device or guarantee all provider retention policies.

A missing key returns 503 `{error: string}`. The current implementation maps validation failures, cancellations, and provider errors to 502; do not assume an invalid body returns 400. Real model calls were not verified in this documentation task.

### 3.2 Task Approval: `/api/followups`

This existing local approval endpoint does not use the speech gateway's Bearer key. It requires a loopback Host; POST requires an exactly matching same-origin Origin, JSON Content-Type, and a valid session cookie. An initial `GET ?session=1` establishes an HttpOnly cookie and returns `{status:"ready"}`; this does not establish that external task storage is configured.

| Method | Parameters | Response / purpose |
| --- | --- | --- |
| GET | `?incidentId=MTG-...` | Returns `status/workspaceId/identityName/tasks` when connected; the field is still named incidentId |
| GET | `?taskId=...` | `{task: ...}`; read back a task |
| POST | `{operation:"propose",incidentId,title,details}` | `{proposal: ...}`; create a pending proposal only |
| POST | `{operation:"approve",proposalId:"UUID"}` | `{task: ...}`; write and read back only after explicit user approval |
| POST | `{operation:"deny",proposalId:"UUID"}` | `{status:"declined"}`; no task is created |

Requires server-side `AMBIGUOUS_API_KEY` and writable approval storage. When unconfigured, ordinary GET returns 200 with `status: "unconfigured"`; POST returns 503. Other main statuses are 400 for validation failures, 403 for disallowed origins/sessions, 413 for oversized bodies, and 502 for provider or approval failures. Errors use `{error: string}`. Never automatically call approve without user confirmation.

## 4. Other Routes: Separate from the Speech Service

The following is an inventory, not the stable external contract for William's speech gateway:

| Method / path | Purpose |
| --- | --- |
| GET/POST/OPTIONS `/api/copilotkit/*` | Inherited template SDK runtime routes, not the speech HTTP API |
| GET/POST/OPTIONS `/api/mobile-copilotkit/*` | Mobile template runtime routes |
| POST `/api/search` | Inherited search example; body contains `query` and optional `results` |
| POST `/api/realtime-token` | Inherited voice example returning a temporary client credential, not a Parakeet ticket |

Source code alone does not establish that these templates have been publicly released. Each requires authentication, authorization, and data-handling agreements before external deployment.

The `/care` demo and `/api/care/*` drafts were removed at the user's request. The medical scenario remains only in [design section 24](../TECH_STACK.md#24-doctor-and-patient-assistant--proposed-design). Frontend integration uses the generic transcription interfaces in this document; William does not implement the medical frontend, reports, or browser agent.

Companion has a separate pairing/connect/poll/heartbeat/authorize/events/revoke protocol; see the [Companion protocol](../apps/companion/PROTOCOL.md). Its current relay is a development fixture, not a route on the speech port, and does not implement a public device-management API.

No separate public Nemotron HTTP endpoint, speaker enrollment/identity HTTP endpoint, meeting CRUD API, or persistent analysis-job API was found in the current source review. Do not describe architecture plans or Python/Swift modules as exposed endpoints.

## 5. Integration Handoff Checklist and Source References

The backend supplies actual HTTPS/WSS addresses, a separately and securely delivered key, allowed browser Origins, version information, capacity limits, and measured model-readiness results. The caller supplies server proxies, PCM framing, correct file MIME types, idempotent retries, cancellation, and error handling. This document describes interfaces; it does not implement frontend code.

- [Speech routes](../apps/speech-gateway/src/server.ts), [configuration](../apps/speech-gateway/src/config.ts), and [frame protocol and MIME types](../apps/speech-gateway/src/protocol.ts)
- [Meeting analysis route](../apps/web/src/app/api/meeting-agent/route.ts) and [request validation and result generation](../apps/web/src/lib/server/openai-meeting.ts)
- [Approval HTTP implementation](../apps/web/src/lib/server/followup-http.ts)

Verification: source-by-source inspection, documentation link checks, and diff checks. No real audio was sent, billable model calls made, tasks written, or services deployed for this documentation task.
