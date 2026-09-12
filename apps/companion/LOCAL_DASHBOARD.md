# Same-Mac dashboard — implemented local protocol v1

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
Accessibility is not used by this snapshot feature.

**Stop:** Disconnect & Clear in either surface revokes the connection. Closing
the native connection window also disconnects. Browser Clear cancels a pending
request or removes a shared image. A request expires in two minutes; an image
expires one minute after receipt. The app never starts a stream or sends an
image to a model. After the native app/web server restarts, disconnect a stale
browser pairing and pair again. Pairings are not stored in Keychain in this mode.

## Contract and ownership

- Browser: `apps/web/src/app/devices/` and `components/devices/dashboard.tsx`.
- Broker: `apps/web/src/app/api/devices/route.ts`, `lib/server/local-devices.ts`.
- TypeScript schemas: `apps/web/src/lib/devices-protocol.ts`.
- Native transport/setup: `apps/companion/native/DashboardWindow.swift`.
- Native picker/preview/explicit sharing: `native/CaptureWindow.swift`.

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
  request: null | { id, status, expiresAt, imageExpiresAt, metadata }
}
```

Browser `POST /api/devices` accepts one strict JSON operation:

| Operation | Additional fields | Result |
| --- | --- | --- |
| `pairing` | none | `{code, expiresAt}`; replaces any earlier challenge |
| `snapshot` | `deviceId`, `requestId` UUIDs | Current state; one pending request per device |
| `clear` | none | Cancels pending request or clears media |
| `disconnect` | none | Revokes device, challenge and media |

The 128-bit pairing code is single-use and expires in two minutes. The native
app sends JSON to `POST /api/devices?native=1`, with no browser Origin/Fetch
Metadata headers. Pairing accepts `{operation:"pair", code, name, permissions}`
and returns `{token, deviceId}`. Later native calls use `Authorization: Bearer`
with the 256-bit device token. Secrets are held in memory; the server stores
hashes. Browser responses never expose device tokens. Native redirects are
rejected and URLSession uses ephemeral storage, no cookies/cache/credentials,
an eight-second deadline and a 16 KiB response limit.

| Native operation | Additional fields | Result |
| --- | --- | --- |
| `poll` | `permissions` | `{request: null \| {id, expiresAt}}` |
| `share` | `requestId`, `metadata`, `jpeg` base64 | `{}` after validated receipt |
| `result` | `requestId`, `result: "denied" \| "failed"` | `{}` |
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

## Verification

On September 12, 2026, the 12 broker tests cover browser/device isolation,
single-use/expired pairing, forged credentials, Host/Origin guards, bounded input,
metadata mismatch, duplicate/lost replies, denial, cancellation, offline peers,
expiry, revocation and restart. All 132 repository tests and typechecks passed;
three native bundle checks passed. The app compiled with the installed macOS SDK.

Live checks on macOS 26: browser pairing, actual permission reporting, browser
cancellation, native decline, and a real selected-window capture shared to the
browser (1146 × 676, matching decoded image dimensions and capture timestamp),
automatic one-minute removal, and native Disconnect revoking the browser pairing.
The new ad-hoc build needed the documented, app-scoped Screen Recording refresh.
Legacy macOS screenshot paths and internet access are not verified by this run.

Native API references: [ephemeral URLSession](https://developer.apple.com/documentation/foundation/urlsessionconfiguration),
[redirect delegate](https://developer.apple.com/documentation/foundation/urlsessiontaskdelegate/urlsession(_:task:willperformhttpredirection:newrequest:completionhandler:)),
[in-memory image encoding](https://developer.apple.com/documentation/appkit/nsbitmapimagerep/representation(using:properties:)).
