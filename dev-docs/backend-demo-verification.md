# Backend demo verification — September 12, 2026

The requested doctor/patient recording was not located in this checkout. The
recording path is pending from William. This run does **not** establish that a
consultation recording can complete transcription, diarization, or analysis.
No frontend files were edited and browser-local AI verification remains paused.

## Results

| Surface | Observed result | Remaining gate |
| --- | --- | --- |
| Repository checks | `npm run verify`: 120 tests passed; all workspace typechecks passed | Native inference is separate |
| Speaker profile storage | Four Python unittest cases passed | Real consented enrollment and embedding extraction not tested |
| Native worker | Xcode Release build succeeded | Real audio inference not tested |
| Speech gateway | 19 live HTTP/WebSocket checks passed after the SSE fix | Real Parakeet final output, MOSS output/speakers, active cancellation |
| Meeting agent GET | 200, reports configured | Configuration presence does not establish credential validity |
| Meeting agent POST | Invalid input: 502; valid synthetic smoke input: 502 | Successful provider response; original recording not used |
| Followups GET/session | 200; session initialized; persistence unconfigured | AMBIGUOUS_API_KEY and approved create/read-back |
| Followups POST without same-origin session | 403 | Expected rejection; not a successful write |
| Search POST | Empty query: 400; valid query: 200 with missing EXA_API_KEY message | Real search results not available |
| Realtime token POST | 401; no ephemeral credential returned | Working provider credentials |
| CopilotKit and mobile CopilotKit `/info` | 200 | Agent generation not exercised |
| `/api/meetings`, `/api/local/capabilities` | 404 | Planned integration routes not implemented |

The speech checks cover liveness, capabilities, authentication on every
protected HTTP route, disallowed origins, invalid stream settings, ticket
creation, invalid WebSocket tickets, unknown jobs, required idempotency keys,
unsupported media, repeated-upload identity, invalid-audio failure, terminal
SSE, and deletion of an already terminal job. They do not substitute for
successful model inference.

## Fix verified

`GET /v1/moss/transcriptions/:id/events` previously left its connection open
when subscribed after a job had already completed, failed, or been cancelled.
The handler now emits that final snapshot and closes immediately. The live
regression check reproduced a timeout before the fix and passed afterward.

## Repeat with the consultation recording

Start the gateway with the environment described in
[its README](../apps/speech-gateway/README.md). From the repository root, run:

```bash
node --env-file=.env apps/speech-gateway/scripts/check-api.mjs /absolute/path/consultation.wav
```

The script uses `HABLABLA_SPEECH_API_KEYS` for the server credential. Optional
`HABLABLA_TEST_URL`, `HABLABLA_TEST_ORIGIN`, and `HABLABLA_TEST_OUTPUT` override
the local defaults. With audio supplied it streams normalized PCM in real time,
requires a nonempty final Parakeet transcript, uploads the original file to
MOSS, captures SSE and result JSON, and checks cancellation on a second upload.
Model downloads may be required. Each inference stage has a ten-minute bound.
No cloud analysis is invoked by this speech script.

Without an audio argument it runs only the 19 transport/error checks and
records the audio-dependent checks as blocked. Local results are under
`.data/backend-demo/`, ignored by Git. Treat generated transcripts as local
recording data; do not commit them automatically.

Other work was concurrently changing the native dependency and adding Nemotron
routes during this run. Those changes were preserved. The reported 19 checks
cover the original Parakeet/MOSS surface, not the in-progress Nemotron work or
future device-relay endpoints.

## Subsequent standalone test console

The later user request added [Speech Lab](../apps/speech-gateway/demo/README.md),
an independent English recording console with local/LAN HTTPS access. It leaves
the product frontend with its owners. Nemotron 3.5 full-multilingual 2240 ms
assets are installed, hash-verified, and exercised with English and Mandarin
synthetic speech. The real Mandarin HTTPS/WSS run produced two partial snapshots
and a final transcript. See the console guide for evidence boundaries; these
samples do not replace the still-missing doctor/patient demo recording. The
later repository run passed 141 tests and all workspace typechecks.
