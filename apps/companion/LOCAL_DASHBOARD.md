# Same-Mac dashboard — local protocol v2 — snapshots and approved controls

This is a separate, deliberately local connection between the **running native
GUI** and the existing Next.js server. It does not import the demo relay or change
the Terminal `open_resource` protocol. No runner-to-GUI IPC was added.

## Try it

1. Run `npm run dev:web` from the repository root.
2. Open **http://127.0.0.1:3100/devices**. Use this exact numeric loopback host.
3. Run `npm run companion -- app`, then click **Local Dashboard…** in Setup.
4. Create a pairing code in the browser, paste it into the app, and click **Pair Dashboard**.
5. Click **Request snapshot** in the browser. In the companion, choose a window
   or display using the macOS picker and click **Capture Once**.
6. Review the native preview. **Share with Dashboard** sends that one image to
   this browser on this Mac. **Decline Request**, Clear, or closing Capture ends
   the request without sharing the preview.

The browser displays the actual native permission checks, online state, selected
source, capture time, and pixel dimensions. The capture API remains authoritative:
the global Screen Recording check does not replace the picker’s scoped grant.
Accessibility is not used by snapshots. The separate controls below require the running GUI to report Accessibility granted.

**Stop:** Disconnect & Clear in either surface revokes the connection. Closing
the native connection window also disconnects. Browser Clear cancels a pending
request or removes a shared image. A request expires in two minutes; an image
expires one minute after receipt. The app never starts a stream or sends an
image to a model. After the native app/web server restarts, disconnect a stale
browser pairing and pair again. Pairings are not stored in Keychain in this mode.

## Window and input controls

After pairing, choose **Request window list**. The native **Approve Control**
window lists up to 50 Accessibility windows from up to 40 regular apps. Select
which app names and titles to share, then click **Share Selected Windows**.
Nothing is selected by default. Only that selection reaches the browser.

Choose a shared window and an action in **Windows & controls**:

- Bring the window forward, restoring it if minimized.
- Move, click, double-click, right-click, or drag within the window.
- Scroll horizontally or vertically (up to 600 pixels per axis).
- Type up to 500 characters without control characters, or press a supported
  key with Command, Shift, Option, and/or Control. Return is a separate action.

The app displays the exact target and input; **Approve Once** admits one attempt.
**Decline**, browser Cancel, or closing the approval window ends pending approval.
The native app rechecks Accessibility, the retained AX window, its unchanged
full title, expiry, broker authorization, and actual focused window before input.
It refuses an unverified target instead of switching to another window.

Pointer coordinates are percentages of the window's current Accessibility bounds,
from its top-left corner. These are window coordinates, **not snapshot pixels**.
The app hit-tests points against the approved window before mouse delivery.
Dragging stays inside the selected window; cross-window drag is not supported.
Mouse gestures use the macOS HID event path and are bounded down/up sequences;
keyboard events target the approved process. System Secure Event Input blocks
input. Secure/login/system UI is not bypassed. Ordinary concurrent desktop
interaction can still change an app between a check and event delivery; this is
an interactive prototype, not OS-level exclusive remote control.

A catalog expires within three minutes and is removed on new listing, lost peer
heartbeat, permission revocation, or disconnect. Closed windows and changed titles
require a fresh selection. Native AX handles, PIDs, content trees and document
contents are never sent as the catalog. Opaque window UUIDs work only within
that session's selected catalog. Text exists only in the current in-memory request
and approval view; terminal status clears it. There is no input history/log.

Results distinguish **succeeded** (native focused-window verification),
**dispatched** (input sent, receiving app outcome unverified), and **unknown**
(action may have happened). Cancellation after the execution claim cannot undo
an action. Inspect the Mac before retrying an uncertain operation. A fresh
snapshot still requires the existing explicit capture/share flow.

## Contract and ownership

- Browser: `apps/web/src/app/devices/` and `components/devices/dashboard.tsx`.
- Broker: `apps/web/src/app/api/devices/route.ts`, `lib/server/local-devices.ts`.
- TypeScript schemas: `apps/web/src/lib/devices-protocol.ts`.
- Native transport/setup: `apps/companion/native/DashboardWindow.swift`.
- Native picker/preview/explicit sharing: `native/CaptureWindow.swift`.
- Native Accessibility approval/execution: `native/WindowControl.swift`.
- Browser controls: `components/devices/control-panel.tsx`.

All requests use the fixed origin `http://127.0.0.1:3100`; the server scripts bind
to `127.0.0.1`. Host must match exactly. Browser mutations require the matching
Origin, JSON and a server-issued HttpOnly, SameSite=Strict session cookie scoped
to `/api/devices`. Unknown cookies cannot authorize a mutation. Cross-site fetch
metadata is rejected. This establishes a local browser session, **not an account
login or a production owner identity**. Do not expose this server through a proxy,
public bind, tunnel, or remote deployment without a new authenticated relay design.

`GET /api/devices` bootstraps the browser session or returns:

```ts
{
  device: null | { id, name, online, permissions: { screenRecording, accessibility }, lastSeen },
  catalog: null | { id, expiresAt, windows: [{ id, app, title, minimized }] },
  request: null | { id, kind, status, expiresAt, imageExpiresAt, metadata, catalogId?, windowId?, action? }
}
```

Browser `POST /api/devices` accepts one strict JSON operation:

| Operation | Additional fields | Result |
| --- | --- | --- |
| `pairing` | none | `{code, expiresAt}`; replaces any earlier challenge |
| `snapshot` | `deviceId`, `requestId` UUIDs | Current state; one pending request per device |
| `list_windows` | `deviceId`, `requestId` | Requests local review of window titles |
| `control` | `deviceId`, `requestId`, `catalogId`, `windowId`, `action` | Requests one locally approved action |
| `clear` | none | Cancels pending request or clears media; executing actions become unknown |
| `disconnect` | none | Revokes device, challenge and media |

The 128-bit pairing code is single-use and expires in two minutes. The native
app sends JSON to `POST /api/devices?native=1`, with no browser Origin/Fetch
Metadata headers. Pairing accepts `{operation:"pair", protocolVersion:2, code, name, permissions}`
and returns `{token, deviceId, protocolVersion:2}`. Version 1 companions are rejected; update both app and web server and re-pair. This prevents older snapshot-only apps from misreading a control request. Later native calls use `Authorization: Bearer`
with the 256-bit device token. Secrets are held in memory; the server stores
hashes. Browser responses never expose device tokens. Native redirects are
rejected and URLSession uses ephemeral storage, no cookies/cache/credentials,
an eight-second deadline and a 16 KiB response limit.

| Native operation | Additional fields | Result |
| --- | --- | --- |
| `poll` | `permissions` | `{request: null \| {id, kind, expiresAt, catalogId?, windowId?, action?}}` |
| `share` | `requestId`, `metadata`, `jpeg` base64 | `{}` after validated receipt |
| `windows` | `requestId`, selected `catalog` | Stores approved titles for up to three minutes |
| `authorize` | `requestId`, `catalogId`, `windowId` | `{allowed:true}` for one execution claim only |
| `result` | `requestId`, `result: "denied" \| "failed" \| "succeeded" \| "dispatched" \| "unknown"` | `{}` |
| `disconnect` | none | Revokes the connection |

Metadata is `{target, targetId, kind:"window"|"display", width, height, scale,
capturedAt}`. OS window/display IDs are included where available (macOS 15.2+);
older systems use a clearly prefixed selection UUID. `scale` is the source's
points-to-pixels scale; dimensions describe the delivered image, which may be
downscaled. This is not an input-coordinate contract. Captured time is the Mac's
screenshot completion time, not a streaming presentation timestamp.

JPEGs are encoded only after Share, capped at 2 MiB and 2560 px on either side.
The broker validates the JPEG header dimensions against metadata and checks
capture time against the request. `GET /api/devices?image=<requestId>` requires
the owning browser cookie, returns `image/jpeg` with no-store/nosniff/same-origin
headers, and returns 404 once cleared/expired. No public media URLs, files, image
logs, clipboard images, model calls or persistent image storage are created.
The browser revokes Blob URLs when an image is replaced, cleared, expired, the
component unmounts, or the tab is hidden. A hidden preview requires a fresh request.

Native polling is every two seconds; browser status polling is every 1.5 seconds.
No native contact for ten seconds marks the device offline and cancels work;
no browser status contact for fifteen seconds cancels pending work and discards
media. Native network failure immediately drops local pending capture state and
requires re-pairing. Disconnect is best effort over an unavailable network; server
leases still bound retention. Closing a browser does not revoke a pairing
immediately, but its absent heartbeat clears pending work/media. Same-origin tabs
share a browser session; this is not per-tab authentication.

Session lifetime is two hours. A five-second sweep frees expired state even when
requests stop. Limits: 16 browser sessions, one device and one image per session,
500 admitted request IDs per session, 30 pairing attempts per minute globally,
2 KiB control bodies and 2,810,000-byte authenticated native bodies. Request IDs
remain admitted for the session: replay cannot request a new capture. Identical
terminal replies can be acknowledged while their result exists; changed, late,
cross-device, cleared, or expired results are rejected. Restart invalidates every
token, so no durable snapshot journal or retry after restart is needed.

Action shapes are strict, defined in `devices-protocol.ts`:

```ts
{ kind: "activate_window" }
{ kind: "pointer", mode: "move"|"click"|"double_click"|"right_click"|"drag", point: {x,y}, end?: {x,y} }
{ kind: "scroll", point: {x,y}, dx, dy }
{ kind: "type_text", text }
{ kind: "key", key, modifiers: ["command"|"shift"|"option"|"control"] }
```

`x/y` are finite 0–1 values; `end` is required only for drag. There are no raw
shell, PID, AX selector, held-key, or arbitrary tool operations. Only one request
is pending/executing. Request IDs bind the entire command digest; changed details
under a reused ID are rejected. A second `authorize` is rejected even if the
first reply was lost. The native app retains admitted IDs until disconnect and
never replays input. Lost authorization/result replies or peer loss after claim
produce uncertainty rather than automatic retry. Restart revokes credentials.

## Verification

On September 12, 2026, the 12 broker tests cover browser/device isolation,
single-use/expired pairing, forged credentials, Host/Origin guards, bounded input,
metadata mismatch, duplicate/lost replies, denial, cancellation, offline peers,
expiry, revocation and restart. All 132 repository tests and typechecks passed;
three native bundle checks passed. The app compiled with the installed macOS SDK.
The web production build also passed after merging the team's meeting-navigation
and backend-documentation changes through `06849b4`. Production browser/native
pairing and both `/devices` and the meeting homepage were checked. The existing
CopilotKit dependency warning remains; no live model generation was run.

Live checks on macOS 26: browser pairing, actual permission reporting, browser
cancellation, native decline, and a real selected-window capture shared to the
browser (1146 × 676, matching decoded image dimensions and capture timestamp),
automatic one-minute removal, and native Disconnect revoking the browser pairing.
The new ad-hoc build needed the documented, app-scoped Screen Recording refresh.
Legacy macOS screenshot paths and internet access are not verified by this run.

Native API references: [ephemeral URLSession](https://developer.apple.com/documentation/foundation/urlsessionconfiguration),
[redirect delegate](https://developer.apple.com/documentation/foundation/urlsessiontaskdelegate/urlsession(_:task:willperformhttpredirection:newrequest:completionhandler:)),
[in-memory image encoding](https://developer.apple.com/documentation/appkit/nsbitmapimagerep/representation(using:properties:)).


Accessibility implementation checks on September 12, 2026: all **144 repository
tests/typechecks**, **three bundle checks**, and the production web build passed.
Ten additional broker tests cover version negotiation, selected catalogs,
permission gating/revocation, one-time execution claims, cancellation before/after
claim, request digest binding, cross-device isolation, strict input validation,
input outcome semantics, and disconnect uncertainty. Native GUI control remains
unavailable over the Terminal `--stdio` RPC. See the latest live check note below.

Final live Accessibility checks on macOS 26.6.2:

- The installed GUI reported **Screen Recording Granted** and **Accessibility
  Granted** after user-authorized, app-scoped refreshes for changed ad-hoc builds.
- Selected-title sharing and expiration were observed. An empty selection shared
  no titles; a selected TextEdit window appeared with an opaque catalog identity.
- Normal window activation returned verified focus. Unicode text was observed
  exactly in TextEdit; Command-A visibly selected it. Click cleared selection,
  double-click selected a word, right-click opened its menu, and drag selected
  the phrase. Scrolling moved the observed scrollbar from 0 to about 0.655.
- Pointer movement returned a successful native dispatch; its precise final
  global cursor position was not independently measured.
- Native Decline and browser Cancel removed the pending input without typing
  either test string. The native approval closed on cancellation.
- Minimized windows were listed accurately and restored visibly. Focus was not
  confirmed during the restore test, so the browser correctly showed **unknown**.
  The final implementation checks focus for up to two seconds without repeating
  activation. Treat minimized restore as partially verified, not a proven focus
  success on every app. Concurrent desktop interaction may interrupt focus.
- The final web control layout was inspected visually and through its DOM labels
  at 1280 px, with no horizontal overflow. Mobile layout and VoiceOver narration
  were not separately exercised in this control run.
- OS execution used a temporary TextEdit document. No model calls or internet
  computer-control transport were used. Snapshot compatibility passed the broker
  tests; image capture was not repeated on this final control build. The prior
  snapshot live check above belongs to the previous snapshot milestone.

Not live-tested: macOS 13–15, multi-display/Spaces switching, protected input,
app termination/closed-window races, or interruption midway through a gesture.
The broker tests cover permission revocation and expiry; actual TCC revocation
mid-input has not been exercised. These are discrete approvals, not a persistent
remote-desktop session or an AI computer-use loop.

Apple API references: [AX attributes](https://developer.apple.com/documentation/applicationservices/1462085-axuielementcopyattributevalue),
[process-targeted keyboard events](https://developer.apple.com/documentation/coregraphics/cgevent/posttopid(_:)),
[mouse event delivery](https://developer.apple.com/documentation/coregraphics/cgevent/post(tap:)),
[cursor positioning](https://developer.apple.com/documentation/coregraphics/cgwarpmousecursorposition(_:)).

A final cancellation-race regression check brings the broker suite to **23 tests**,
all passing, with repository-wide typechecks passing again. Late/repeated Cancel
preserves a dispatched or uncertain outcome instead of claiming input never ran.
