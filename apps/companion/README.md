# Hablabla Mac companion

A Terminal-launched macOS companion for the first device-control prototype. It pairs with a relay, advertises registered documents, receives a typed `open_resource` command, asks for approval **on the Mac**, opens the document through Launch Services, and reports the result.

The user assigned this component on September 12, 2026. Its implementation lives entirely in `apps/companion/`, apart from root workspace/scripts and handoff documentation. The meeting UI and deferred local-model verification are unchanged.

## Run the local demo

Requirements: macOS, Node.js 22+, and Xcode Command Line Tools (`xcrun swiftc`). Run the commands below from the repository root. No model key or cloud account is needed.

```bash
npm ci
npm run companion:build
npm run companion -- register presentation:demo apps/companion/fixtures/demo-presentation.txt --name "Demo presentation"
```

The harmless demo document opens in the Mac's default text editor. To use your presentation instead, register an absolute file path:

```bash
npm run companion -- register presentation:demo "/absolute/path/My Presentation.pptx" --name "My presentation"
```

Terminal 1 starts the **development relay fixture**:

```bash
npm run companion:demo
```

It prints a one-time pairing code that expires in two minutes. Type `pair` there for a fresh code. Keep this Terminal open.

Terminal 2 pairs and starts the companion:

```bash
npm run companion -- pair --relay http://127.0.0.1:3210
# Paste the code at the prompt, then type pair to confirm the device and relay.
npm run companion -- start
```

In Terminal 1, type:

```text
Open my presentation
```

With one connected device and one registered resource, the demo queues that resource. With multiple choices, type `devices`, then `open <device-id> <resource-id>`. This phrase is a deterministic demo shortcut, not an AI planner.

In Terminal 2, review the exact document and type `approve`. Enter or any other answer denies it. The relay's `status` command shows the correlated result. A `succeeded / open_dispatched` result means macOS accepted the open request; it does not assert that a window is visible or that a screenshot was captured.

**Stop:** press Ctrl+C in the companion, including during approval. `cancel <command-id>` in the relay also cancels pending approval. Actions already dispatched cannot be undone. Type `quit` to stop the relay.

**Unpair:** stop the companion, then run `npm run companion -- unpair`. This revokes the relay credential and removes the Keychain item. If the relay is unreachable, local credentials are removed and the command tells you to revoke at the relay too. The demo relay keeps all state in memory; restarting it requires pairing again. Use `unpair` before re-pairing with that new instance.

## Local state and permissions

Default state: `~/Library/Application Support/Hablabla Companion/` (directory mode 700, JSON files mode 600). Override it with `--state-dir /absolute/private/path` on **every** command for an isolated demo. No service is installed and nothing starts at login.

- `config.json`: device identity, relay origin, Keychain account ID, registered file paths/labels/content hashes. The device token is **not** in this file.
- macOS Keychain: a device-scoped credential under service `com.hablabla.companion.device`, accessed by the Swift helper. The helper receives JSON on stdin; secrets never travel in shell arguments.
- `journal.json`: bounded durable command digests, execution claims, and results. No document contents. A crash with an uncertain command produces `unknown`, never a blind replay.
- `process.lock`: prevents concurrent companion/configuration processes using the same directory. After a crash, `npm run companion -- unlock` checks whether the recorded process has exited before removing its stale lock. It refuses to unlock an active process.

`list` shows resources and pairing metadata. `remove <resource-id>` removes a resource. Stop the companion before changing registration, then start it again to advertise the new list.

The adapter accepts regular PDF, PPT/PPTX, KEY, and TXT files up to 100 MB. Older package-directory Keynote files are not supported. Registered files are pinned to a canonical path and SHA-256 digest. If you edit or replace the document, register it again. The native adapter checks the digest immediately before opening; it is not a sandbox against another process running as the same macOS user.

Only device name, resource IDs/labels, and command status leave the Mac. File paths and document contents stay local. Opening a file may trigger ordinary macOS file-access or application prompts. Accessibility, screen capture, microphone access, and remote input are not requested by this prototype.

## Connection and execution

The companion makes outbound authenticated HTTP requests; it does not listen on a network port. Remote origins must use HTTPS. Plain HTTP is permitted only for literal loopback addresses (`127.0.0.1` or `[::1]`). Redirects are rejected, request deadlines and response-size limits are enforced, and tokens are not logged.

The demo fixture binds only `127.0.0.1:3210`. Its owner/admin controls live in Terminal; it does not expose browser/admin endpoints. It rejects browser-origin requests and unexpected Host headers. This is a same-user, loopback test fixture, **not a production relay or an internet-facing authentication system**. It has no persistent database, browser sign-in, public deployment, or rate-limit service.

The runner polls at 500 ms when idle and heartbeats every second. Requests time out after eight seconds. The fixture considers a device offline after 15 seconds without contact. A connection failure cancels local approval and reconnects with a new session; old-session commands become uncertain in the fixture and are not replayed. Revoked credentials stop the runner. Use `start` again after a fresh pairing.

Before execution the companion checks the device, session, strict action schema, validity window, local registry, current file digest, exact local approval, and the relay's current authorization. There is no trusted remote `approved: true`, arbitrary shell tool, automatic approval flag, or permission escalation.

For a running native operation, cancellation is best effort. A result may still be `succeeded` if macOS already accepted the open request. The UI/backend must show the actual terminal result, not infer rollback from a cancellation request.

## Integration handoff

The concrete companion contract is in [PROTOCOL.md](PROTOCOL.md), with Zod schemas in [src/protocol.ts](src/protocol.ts). The relay fixture implements that contract for development; replace the transport peer with the assigned authenticated backend. Do not import the fixture into production.

The future `/devices` dashboard, `apps/relay/`, and `packages/device-protocol/` remain separate integration work. No meeting page/provider files were changed. Agree on protocol changes before extracting these schemas into a shared package.

Implemented capability: `open_resource`. Screen capture, streaming, remote keyboard/mouse, window control, voice input, menu-bar UI, and server-side AI planning remain future work. The WebGPU meeting model remains explicitly out of scope.

## Verification

```bash
npm run verify
npm run companion:build
npm run build --workspace web
```

On September 12, 2026:

- All 112 repository tests passed (15 companion tests), along with all workspace typechecks.
- The existing web production build passed (with its inherited SDK warning).
- The Swift helper compiled on macOS 26.6.2. The live smoke test used Node 23.5.0; Node 22 is the declared minimum, not separately exercised in that run.
- Live pairing stored/retrieved a scoped Keychain credential. A request approved in the companion opened the bundled TXT document, verified in TextEdit.
- A second request was denied; a third was cancelled with Ctrl+C during approval. Both outcomes reached the relay. The test pairing was revoked and its local Keychain credential removed afterward.
- HTTP integration tests cover single-use/expired pairing, separate owners/devices, cancellation during approval, reconnect/session invalidation, and browser/Host rejection. Unit tests cover stale commands, changed files, denial, duplicate delivery, lost result replies, and crash uncertainty. Automated OS execution is stubbed; the live test above exercised the real adapter.

Native API references: [NSWorkspace.open](https://developer.apple.com/documentation/appkit/nsworkspace/open(_:)), [Keychain item creation](https://developer.apple.com/documentation/security/secitemadd(_:_:)). Build from the checked-in Swift source with your installed macOS SDK.
