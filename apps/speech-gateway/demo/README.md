# Speech Lab — backend test console

This is an independent, English-language diagnostic page for William's speech
backend. It is **not** the team's product frontend and does not change anything
under `apps/web`. Product UI and integration remain with the frontend owners.

For the current demo addresses, exact console HTTP/WebSocket paths, request
examples, and a separate same-Mac setup for the team's frontend, read the
[demo speech backend handoff](../../../dev-docs/demo-speech-handoff.md).

## Start on this Mac

```bash
npm run demo --workspace speech-gateway
```

Open `http://127.0.0.1:18766`. The command starts a dedicated gateway on
`127.0.0.1:18765`, with an ephemeral server-only API key. The page never receives
that key. The worker must first be built using the native worker's
`scripts/build-release.sh`.

## Share on the LAN

```bash
HABLABLA_DEMO_LAN=1 npm run demo --workspace speech-gateway
```

The HTTPS console listens on all IPv4 interfaces on port 18767. Its dedicated
native gateway stays on loopback port 18768. Use a printed LAN IP or `.local`
URL. The launcher accepts private-network peers and enumerated local Host/Origin
values; it does not create a public tunnel. Everyone on the trusted LAN can use
this test service, so run it only for the intended shared test session.

Remote microphone access needs HTTPS. The launcher generates a 30-day
self-signed certificate under `.data/speech-demo/tls/` and reuses it while the
address list and validity permit. Each client must trust that certificate or
accept its browser certificate exception before microphone access can work.
No trust-store or firewall changes are performed automatically. Wi-Fi client
isolation or host firewall rules can still block another device.

`HABLABLA_DEMO_PORT` and `HABLABLA_DEMO_GATEWAY_PORT` override the ports. Ctrl+C
stops the launcher, its gateway, and its worker process group. Local and LAN
instances may run at the same time.

## Nemotron 3.5 multilingual preset

```bash
node apps/macos-model-worker/scripts/install-nemotron.mjs
npm run demo --workspace speech-gateway
```

The installer pins the Core ML export revision and verifies file sizes and
SHA-256 LFS hashes / Git blob hashes. It downloads approximately 665 MB into
`.data/models/nemotron-3.5-multilingual/2240ms/`. The launcher discovers this
completed installation automatically; `HABLABLA_NEMOTRON_MODEL_DIR` can override
it explicitly.

The preset uses **Nemotron 3.5 ASR Streaming Multilingual 0.6B**, the full
13,087-token vocabulary, and a 2,240 ms chunk tier. This is the export author's
recommended streaming balance; it is not a measured guarantee of clinical
accuracy. The native worker rejects English-only or Latin-pruned models,
announces the actual chunk size at `ready`, and maps short language codes such
as `zh` to the model's `zh-CN` prompt. Hotwords require a logits-capable decoder.

Sources: [Core ML export and tier guidance](https://huggingface.co/FluidInference/Nemotron-3.5-ASR-Streaming-Multilingual-0.6b-CoreML),
[NVIDIA base model](https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b).

## Test a recording

1. Select a mode and language. Nemotron 3.5 is selected initially when configured.
   `Record only` needs no model. Parakeet is available for its supported languages.
2. Press **Start recording** and allow the microphone. Live modes wait for the
   model's `ready` event before capturing samples. Loading can be cancelled.
3. Press **Stop recording**. The worklet flushes its final partial packet. A
   16 kHz, mono, PCM16 WAV is retained in page memory for playback and download.
4. Submit the saved WAV or an uploaded file to **MOSS** for a complete transcript
   and available speaker segments. This is a separate explicit action.
5. Paste a verified reference to compare final results. Export JSON for diagnosis.

The recorder stops after ten minutes. Refreshing clears browser-held audio and
results. Audio is sent only to this demo Mac's local worker; this console never
calls OpenAI or other cloud inference. Model downloads are separate network
traffic. Gateway job results remain in memory for its configured retention time;
refreshing the page does not erase a running backend job. Cancel it explicitly
when no longer needed. MOSS serializes jobs; no multi-user performance guarantee
has been established.

## What the measurements mean

- **First text:** elapsed time from capture start to the first nonempty live
  transcript; model loading is excluded.
- **Finalization:** elapsed time from pressing Stop to receipt of the final live
  transcript, including capture flush.
- **WER/CER:** normalized Levenshtein edits divided by the reference length.
  Case and punctuation are ignored; numbers and negation remain significant.
  Chinese/Japanese references use character units; other text uses whitespace
  word units. Scores can exceed 100% when insertions exceed reference length.
  This is not model confidence or a clinical validation metric.

Live snapshots replace older revisions. Only `isFinal: true` completes a live
run. MOSS failure, cancellation, and empty output remain visible. Transport
retries reuse the idempotency key; a completed run can be explicitly submitted
again as a new run. Generic speaker IDs never automatically become identities.

## Verification

`npm run verify` covers the gateway protocol and console tests: private-peer and
Host/Origin checks, server-only bearer forwarding, multipart bytes, cancellation,
same-origin WebSocket forwarding, WAV headers/final partial samples, and reference
comparison. Browser checks used synthetic audio through the actual AudioWorklet:
1.224 seconds yielded a 39,212-byte, 16 kHz WAV; stopping ended the media track.
A 390 px layout had no horizontal overflow. Fixture responses separately verified
MOSS completion/cancellation, speaker rows, WER, ordered PCM, stale revisions,
and final live output. These browser fixtures do not prove actual model quality
or a physical microphone. Another LAN device still needs to verify connectivity
and its microphone permission.

Actual Nemotron inference was subsequently verified on this Mac with two
explicitly synthetic macOS TTS samples. The English sample produced the expected
words. A 5.897-second Mandarin sample went through the real LAN HTTPS session,
WSS proxy, framed PCM transport, and native Core ML worker: it emitted two
partial snapshots followed by final revision 3, preserving both negations and
matching the reference after punctuation/whitespace normalization. Both runs
reported the full Nemotron 3.5 model and 2,240 ms tier. This exposed and fixed
an adapter bug: FluidAudio's `process(samples:)` returns an empty string; the
adapter must read `getPartialTranscript()` after processing. Real human
consultation quality, difficult acoustics, and concurrent multi-user capacity
remain to be measured. The final repository verification passed 141 tests and
all workspace typechecks; the updated Swift Release build passed.
