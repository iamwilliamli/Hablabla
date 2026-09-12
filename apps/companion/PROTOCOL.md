# Companion protocol v1 — implemented prototype

This is Hablabla's application contract, not a vendor SDK. Source of truth: `src/protocol.ts`. All bodies/responses are JSON. The companion sends `Content-Type: application/json` and, after pairing, `Authorization: Bearer <deviceToken>`. Reject redirects. A remote relay must use HTTPS and derive device/owner identity from authenticated credentials, never from an owner ID in the body.

The development fixture is `src/demo-relay.ts`. Its owner operations are process-local methods controlled from Terminal. It intentionally does not implement dashboard sign-in or public `/v1/devices` endpoints. The production backend owner must provide those for remote access. The implemented same-Mac `/devices` snapshot route uses a separate GUI-only contract in [LOCAL_DASHBOARD.md](LOCAL_DASHBOARD.md); it does not reuse this fixture.

## Pairing and registration

The dashboard/backend creates an expiring, single-use challenge bound to its authenticated owner. In the local fixture the `pair` Terminal command creates one with 128 bits of randomness and a two-minute lifetime.

`POST /v1/pairings/complete` (no bearer token):

```json
{
  "code": "32 lowercase hex characters",
  "deviceId": "UUID generated on the Mac",
  "name": "My MacBook",
  "capabilities": ["open_resource"],
  "resources": [{ "id": "presentation:demo", "label": "Demo presentation" }]
}
```

Response: `{ "deviceId": "same UUID", "deviceToken": "64 lowercase hex characters" }`. The companion confirms the relay locally, then stores this token in Keychain. Resource paths and hashes are never advertised. At most 50 resources; labels at most 120 characters; names at most 100 characters. Pairing/code values above are descriptive placeholders, not literal schema-valid examples.

`POST /v1/companion/revoke` with `{}` revokes the authenticated device. The companion then removes its local Keychain item and pairing fields. Production revocation must terminate all sessions and prevent future use of that token.

## Session and delivery

| Endpoint | Request | Response |
| --- | --- | --- |
| `/v1/companion/connect` | `{ "resources": [{ "id": "presentation:demo", "label": "Demo" }] }` | `{ "sessionId": "fresh UUID" }` |
| `/v1/companion/poll` | `{ "sessionId": "UUID" }` | `{ "command": null }` or `{ "command": <envelope> }` |
| `/v1/companion/heartbeat` | `{ "sessionId": "UUID" }` | `{ "cancelled": ["command UUID"] }` |
| `/v1/companion/authorize` | `{ "sessionId": "UUID", "commandId": "UUID" }` | `{ "allowed": true }` or `{ "allowed": false }` |
| `/v1/companion/events` | Event below | `{}` |

All endpoints use POST. The prototype allows one command at a time per device, uses short polling, and rejects old sessions. `connect` starts a new session and invalidates outstanding work from the previous one. Cancellation IDs must remain available until the command produces a terminal result. A revoked bearer token returns 401/403; a stale session returns 409. A transport error or failed heartbeat aborts local approval. No keyboard input is queued or replayed.

Command envelope (UUID/timestamp values must be real):

```json
{
  "protocolVersion": 1,
  "type": "command.request",
  "intentId": "c5e8ac8e-a70f-4848-9d88-3c837912496a",
  "commandId": "99c83d05-20cf-40bd-8b6e-88a7f6c69631",
  "deviceId": "23873585-cb94-4fef-9041-c5e43aef1b69",
  "sessionId": "b56733f4-26f3-45e3-8fbb-153fbf9c0e69",
  "issuedAt": "2026-09-12T17:00:00.000Z",
  "expiresAt": "2026-09-12T17:01:00.000Z",
  "action": { "kind": "open_resource", "resourceId": "presentation:demo" }
}
```

The companion requires `expiresAt > issuedAt`, a lifetime at most 120 seconds, at most five seconds of future clock skew, and a nonexpired command. The fixture issues 60-second commands. Unknown fields/actions are rejected. `resourceId` matches `[a-zA-Z0-9][a-zA-Z0-9:_-]{0,79}`.

After local approval, `/authorize` must validate authenticated device ownership, session, command, expiry, and cancellation. A positive response does not replace local approval. There is a small unavoidable race between dispatch and cancellation; report the actual outcome instead of promising rollback.

## Events and interpretation

```json
{
  "protocolVersion": 1,
  "intentId": "c5e8ac8e-a70f-4848-9d88-3c837912496a",
  "commandId": "99c83d05-20cf-40bd-8b6e-88a7f6c69631",
  "deviceId": "23873585-cb94-4fef-9041-c5e43aef1b69",
  "sessionId": "b56733f4-26f3-45e3-8fbb-153fbf9c0e69",
  "status": "succeeded",
  "code": "open_dispatched",
  "at": "2026-09-12T17:00:10.000Z"
}
```

Nonterminal events: `received`, `awaiting_approval`, `running`. Terminal events: `succeeded`, `denied`, `failed`, `cancelled`, `expired`, `unknown`. The relay separately holds `queued` and `cancelRequested` state. Identical terminal event redelivery is idempotent; mismatched IDs, changed payloads, and state regression must be rejected.

Codes are bounded lowercase identifiers, not arbitrary native/network error text. `open_dispatched` means Launch Services accepted opening the document; it is not evidence of a visible window or a captured screen. `native_open_not_confirmed` / `interrupted_command` mean the effect cannot be proven, so the client must not automatically retry it as a new command.

The companion persists the command digest before approval, and the execution claim before the native call. A previously admitted command surviving an interrupted process returns `unknown` unless a terminal result was durably recorded. A lost result reply can be retried without reopening while the session remains valid. If the session is lost, the fixture marks unfinished commands `unknown`; it does not accept an old session's retry or automatically reconcile across sessions. A future backend may add explicit authenticated result reconciliation without re-executing commands.

## Future capabilities

The native GUI supports single-window/display snapshots and explicitly approved sharing with the same-Mac dashboard. See [LOCAL_DASHBOARD.md](LOCAL_DASHBOARD.md). This does not add a capability or RPC method to this Terminal relay protocol. Remote capture, stream signaling, remote input, AI planning, and voice are not part of this implemented schema. Add new versioned action schemas and local permission checks before advertising those capabilities. A model or dashboard must never dispatch arbitrary code through `open_resource`.
