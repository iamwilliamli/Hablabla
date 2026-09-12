# Hablabla Mac companion

A Terminal-launched macOS companion for the first device-control prototype. It pairs with a relay, advertises registered documents, receives a typed `open_resource` command, asks for approval **on the Mac**, opens the document through Launch Services, and reports the result.

The user assigned this component on September 12, 2026. Its implementation lives entirely in `apps/companion/`, apart from root workspace/scripts and handoff documentation. The meeting UI and deferred local-model verification are unchanged.

## Run the local demo

Requirements: macOS, Node.js 22+, and Xcode Command Line Tools (`xcrun swiftc`). Run the commands below from the repository root. No model key or cloud account is needed.

```bash
npm ci
npm run companion:build
npm run companion:install
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

## Packaged native app

`npm run companion:build` creates `apps/companion/dist/Hablabla Companion.app`.
`npm run companion:install` verifies the bundle and copies it to the fixed user
location `~/Applications/Hablabla Companion.app`. It needs no administrator
installation and does not register a login item. Quit the menu-bar helper and
stop the Terminal runner before updating; the installer refuses to replace a
running helper or an unrelated app at the destination.

Bundle identifier: **`com.hablabla.companion`**. The executable lives at
`Contents/MacOS/HablablaCompanion`. `LSUIElement` makes it an accessory app with
no Dock icon. Open it from Finder or run:

```bash
npm run companion -- app
npm run companion -- app-info
```

Opening the app shows its **Setup** window and a small computer icon in the menu
bar, with Setup & Permissions, About, and Quit Helper controls. The app does not claim to be connected:
**pairing, the relay connection, and approval still run in Terminal**. Quitting
the menu-bar helper does not stop that separate process; use Ctrl+C there.

The CLI invokes the executable **inside the installed bundle** with `--stdio`.
That mode preserves the existing private JSON request/response pipe and does
not show the menu or dialog. Double-clicking the app never waits for stdin.
`app-info` works before pairing and prints the actual bundle ID/version/path.
There is no fallback to the old loose `dist/companion-native` executable.
For an explicit development override, set `HABLABLA_COMPANION_APP` to an absolute
`.app` path; normally use the installed location.

### Signing and permission identity

The build signs and verifies the complete bundle. By default it uses an ad-hoc
local-development signature; this Mac had no Apple signing identity configured.
A stable bundle ID/path does **not** guarantee that macOS remembers permissions
across changed ad-hoc builds. Apple documents how signing requirements affect
that identity in [TN3127](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements).

If a development certificate and its private key are already installed in
Keychain, select it explicitly when building, then reinstall:

```bash
HABLABLA_SIGNING_IDENTITY="Apple Development: Your Name (TEAMID)" npm run companion:build
npm run companion:install
```

Replace the placeholder with your actual identity. An invalid configured
identity fails the build; it never silently falls back to ad-hoc signing. Keep
the same signing identity for updates. Existing companion state and Keychain
account IDs are retained; macOS may request Keychain authorization when code
identity changes. This build is not notarized or packaged for public distribution.

Packaging does not grant Screen Recording or Accessibility access. The setup
window now checks both permissions in the running background app. Future capture
and control operations must verify authorization from their own process, including
its launch path; a Terminal-launched `--stdio` process must not be assumed to inherit
grants observed in a Finder-launched app or in Codex Computer Use. The background
app is the intended host for future permission-sensitive operations; integrating
its communication with the runner is a separate next step.

### Setup window

Open the installed app, run `npm run companion -- app`, or choose **Setup &
Permissions…** from its menu. Screen Recording uses
[`CGPreflightScreenCaptureAccess`](https://developer.apple.com/documentation/coregraphics/cgpreflightscreencaptureaccess()),
and Accessibility uses
[`AXIsProcessTrusted`](https://developer.apple.com/documentation/applicationservices/1459188-axisprocesstrusted).
Both report actual access for the GUI process. No permission is inferred from
Codex, Terminal, a dashboard, or a stored configuration flag.

- Status refreshes on opening, app activation, every two seconds while the window
  is open, and with **Refresh Status** (Command-R).
- **Not granted** covers both an unanswered request and denied access; these
  APIs do not distinguish those cases. Screen Recording may require quitting and
  reopening the app after changing permission before preflight reports access.
- Only the explicit **Request…** buttons invoke macOS permission prompts.
  Accessibility prompting is asynchronous; returning from a request is never
  treated as a grant. **Open Settings…** opens the relevant Privacy & Security
  pane, where the user makes their choice.
- Opening, refreshing, or closing the window does not request access, capture
  content, or control the desktop. Closing it leaves the menu helper running;
  reopening the app brings the same setup window back.

Permission status and requests are local GUI features, not new relay/RPC
capabilities. Existing document opening does not require these grants.

## Local state and permissions

Default state: `~/Library/Application Support/Hablabla Companion/` (directory mode 700, JSON files mode 600). Override it with `--state-dir /absolute/private/path` on **every** command for an isolated demo. No background service or login item is installed. The native app is installed separately by `companion:install`.

- `config.json`: device identity, relay origin, Keychain account ID, registered file paths/labels/content hashes. The device token is **not** in this file.
- macOS Keychain: a device-scoped credential under service `com.hablabla.companion.device`, accessed by the Swift helper. The helper receives JSON on stdin; secrets never travel in shell arguments.
- `journal.json`: bounded durable command digests, execution claims, and results. No document contents. A crash with an uncertain command produces `unknown`, never a blind replay.
- `process.lock`: prevents concurrent companion/configuration processes using the same directory. After a crash, `npm run companion -- unlock` checks whether the recorded process has exited before removing its stale lock. It refuses to unlock an active process.

`list` shows resources and pairing metadata. `remove <resource-id>` removes a resource. Stop the companion before changing registration, then start it again to advertise the new list.

The adapter accepts regular PDF, PPT/PPTX, KEY, and TXT files up to 100 MB. Older package-directory Keynote files are not supported. Registered files are pinned to a canonical path and SHA-256 digest. If you edit or replace the document, register it again. The native adapter checks the digest immediately before opening; it is not a sandbox against another process running as the same macOS user.

Only device name, resource IDs/labels, and command status leave the Mac. File paths and document contents stay local. Opening a file may trigger ordinary macOS file-access or application prompts. Screen Recording and Accessibility are requested only through explicit setup-window buttons. Microphone access and remote input remain unimplemented.

## Connection and execution

The companion makes outbound authenticated HTTP requests; it does not listen on a network port. Remote origins must use HTTPS. Plain HTTP is permitted only for literal loopback addresses (`127.0.0.1` or `[::1]`). Redirects are rejected, request deadlines and response-size limits are enforced, and tokens are not logged.

The demo fixture binds only `127.0.0.1:3210`. Its owner/admin controls live in Terminal; it does not expose browser/admin endpoints. It rejects browser-origin requests and unexpected Host headers. This is a same-user, loopback test fixture, **not a production relay or an internet-facing authentication system**. It has no persistent database, browser sign-in, public deployment, or rate-limit service.

The runner polls at 500 ms when idle and heartbeats every second. Requests time out after eight seconds. The fixture considers a device offline after 15 seconds without contact. A connection failure cancels local approval and reconnects with a new session; old-session commands become uncertain in the fixture and are not replayed. Revoked credentials stop the runner. Use `start` again after a fresh pairing.

Before execution the companion checks the device, session, strict action schema, validity window, local registry, current file digest, exact local approval, and the relay's current authorization. There is no trusted remote `approved: true`, arbitrary shell tool, automatic approval flag, or permission escalation.

For a running native operation, cancellation is best effort. A result may still be `succeeded` if macOS already accepted the open request. The UI/backend must show the actual terminal result, not infer rollback from a cancellation request.

## Integration handoff

The concrete companion contract is in [PROTOCOL.md](PROTOCOL.md), with Zod schemas in [src/protocol.ts](src/protocol.ts). The relay fixture implements that contract for development; replace the transport peer with the assigned authenticated backend. Do not import the fixture into production.

The future `/devices` dashboard, `apps/relay/`, and `packages/device-protocol/` remain separate integration work. No meeting page/provider files were changed. Agree on protocol changes before extracting these schemas into a shared package.

Implemented capability: `open_resource`, plus native app packaging, a setup window with actual permission checks/request controls, and an About/Quit menu. Screen capture, streaming, remote keyboard/mouse, window control, voice input, connection/approval controls in the menu-bar app, and server-side AI planning remain future work. The WebGPU meeting model remains explicitly out of scope.

## Next milestone: one screen capture

Packaging and permission setup are implemented. Next: implement and verify one
user-selected screen/window capture in the background app before adding remote
input. `npm run companion -- app` opens setup. Permissions enabled for Codex
Computer Use are not a permission check for Hablabla Companion.

Keep this computer-control adapter separate from William's native speech worker
in the [team handbook](../../TEAM_ARCHITECTURE.md). Coordinate dashboard and
backend integration through the existing companion protocol. Keep live meeting
AI verification paused. See [TECH_STACK section 20](../../TECH_STACK.md#20-companion-prototype-and-access-scope)
for the staged capture/control plan.

## Verification

```bash
npm run verify
npm run companion:build
npm run companion:check-app
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

Packaging verification on September 12, 2026:

- All **113 repository tests** and workspace typechecks passed; **three separate
  bundle tests** verified identity/signature, invalid RPC rejection, and signed
  metadata tamper detection.
- Built and installed the ad-hoc app at the fixed user path. Verified its About
  dialog, reported bundle identity, and refusal to overwrite the running helper.
- The installed executable passed a temporary Keychain store/read/delete check.
  A paired Terminal request opened the demo TXT document after approval and
  returned `succeeded / open_dispatched`; the document was visible in TextEdit.
  The test pairing and temporary Keychain credentials were removed afterward.
- Screen/control permission grants and persistence across certificate-signed
  updates were not tested. No permissions or signing certificates were granted
  or installed by these checks.

Permission-setup verification on September 12, 2026:

- Rebuilt and installed the app; all 113 repository tests, workspace typechecks,
  and three bundle tests passed again. RPC checks also reject permission-request
  operations, keeping prompts in the locally operated setup window.
- Inspected the native window visually and through its accessibility tree. Both
  permissions initially reported **Not granted**; manual/automatic refresh worked.
  During user interaction, Accessibility subsequently reported **Granted** and
  its request button became disabled. Screen Recording still reported no access
  in that process; a grant/relaunch flow was not fully verified.
- No automated permission grants, capture, or remote input were performed.
  Permission persistence across changed builds remains unverified.
