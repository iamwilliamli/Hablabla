import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { browserDeviceCommand, nativeDeviceCommand, localDeviceOrigin,
  type DeviceState } from "../devices-protocol";

const cookieName = "hablabla-local-device-session";
const maxBody = 2_810_000;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
type Snapshot = NonNullable<DeviceState["request"]> & { bytes?: Uint8Array; digest?: string };
type Session = { expires: number; seen: number; challenge?: { digest: string; expires: number };
  device?: NonNullable<DeviceState["device"]> & { tokenHash: string }; request?: Snapshot; catalog?: NonNullable<DeviceState["catalog"]>; used: Map<string, string> };
class LocalError extends Error { constructor(readonly status: number, message: string) { super(message); } }

/** In-memory, single-process, loopback-only broker. Restart deliberately revokes
 * all pairings. It is not an internet relay or an authenticated user account. */
export class LocalDevices {
  private sessions = new Map<string, Session>();
  private attempts = { since: 0, count: 0 };
  constructor(private now: () => number = Date.now) {}

  sweep() {
    const now = this.now();
    for (const [key, session] of this.sessions) {
      if (now >= session.expires) { this.sessions.delete(key); continue; }
      if (session.challenge && now >= session.challenge.expires) session.challenge = undefined;
      const offline = !session.device || now - Date.parse(session.device.lastSeen) > 10_000 || now - session.seen > 15_000;
      if (session.catalog && (offline || !session.device?.permissions.accessibility || now >= Date.parse(session.catalog.expiresAt))) session.catalog = undefined;
      const request = session.request;
      if (!request) continue;
      if (request.status === "awaiting_approval" && (offline || now >= Date.parse(request.expiresAt))) {
        request.status = offline ? "cancelled" : "expired";
      }
      if (request.status === "executing" && (offline || now >= Date.parse(request.expiresAt))) request.status = "unknown";
      if (request.status === "awaiting_approval" && request.kind !== "snapshot" && (!session.device?.permissions.accessibility || (request.kind === "control" && !session.catalog))) request.status = "failed";
      if (request.status === "shared" && (offline || now >= Date.parse(request.imageExpiresAt!))) request.status = "expired";
      if (!["awaiting_approval", "executing"].includes(request.status)) request.action = undefined;
      if (request.status !== "shared") { request.bytes = undefined; request.metadata = null; request.imageExpiresAt = null; }
    }
  }

  private state(session: Session): DeviceState {
    const device = session.device;
    const request = session.request;
    return {
      catalog: session.catalog ?? null,
      device: device ? { id: device.id, name: device.name, permissions: device.permissions, lastSeen: device.lastSeen,
        online: this.now() - Date.parse(device.lastSeen) <= 10_000 } : null,
      request: request ? { id: request.id, kind: request.kind, catalogId: request.catalogId, windowId: request.windowId, action: request.action, status: request.status, expiresAt: request.expiresAt,
        imageExpiresAt: request.imageExpiresAt, metadata: request.metadata } : null,
    };
  }

  async handle(request: Request): Promise<Response> {
    this.sweep();
    const headers: Record<string, string> = { "Cache-Control": "no-store, max-age=0", "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin" };
    const reply = (body: unknown, status = 200) => Response.json(body, { status, headers });
    try {
      const url = new URL(request.url);
      // Exact numeric loopback origin prevents DNS rebinding and keeps the native
      // destination fixed. Proxy headers never supply identity or origin.
      if (url.protocol !== "http:" || (request.headers.get("host") ?? url.host) !== "127.0.0.1:3100")
        throw new LocalError(403, "Open the local dashboard at http://127.0.0.1:3100/devices.");
      const native = url.search === "?native=1";
      if (native) {
        if (request.method !== "POST" || request.headers.has("origin") || request.headers.has("sec-fetch-site"))
          throw new LocalError(403, "Native connection required.");
        // Reject bad credentials before reading an image-sized body. Pairing is
        // small and additionally gated by a single-use 128-bit challenge.
        const authorization = request.headers.get("authorization");
        const session = authorization ? this.byToken(authorization) : undefined;
        const input = nativeDeviceCommand.parse(await readBody(request, session ? maxBody : 2048));
        if (input.operation === "pair") {
          if (authorization) throw new LocalError(400, "Already connected.");
          if (this.now() - this.attempts.since > 60_000) this.attempts = { since: this.now(), count: 0 };
          if (++this.attempts.count > 30) throw new LocalError(429, "Wait a minute before pairing again.");
          const owner = [...this.sessions.values()].find(s => s.challenge?.digest === hash(input.code));
          if (!owner?.challenge || owner.challenge.expires <= this.now() || owner.device)
            throw new LocalError(403, "Pairing code is invalid or expired.");
          owner.challenge = undefined;
          const token = randomBytes(32).toString("hex");
          owner.device = { id: randomUUID(), name: input.name, online: true, permissions: input.permissions,
            lastSeen: new Date(this.now()).toISOString(), tokenHash: hash(token) };
          return reply({ token, deviceId: owner.device.id, protocolVersion: 2 });
        }
        if (!session?.device) throw new LocalError(401, "Pair the companion again.");
        if (input.operation === "disconnect") { this.disconnect(session); return reply({}); }
        if (input.operation === "poll") {
          session.device.permissions = input.permissions;
          session.device.lastSeen = new Date(this.now()).toISOString();
          this.sweep();
          const pending = session.request && ["awaiting_approval", "executing"].includes(session.request.status) ? session.request : null;
          return reply({ request: pending ? { id: pending.id, kind: pending.kind, expiresAt: pending.expiresAt, catalogId: pending.catalogId, windowId: pending.windowId, action: pending.action } : null });
        }
        const pending = session.request;
        if (!pending || pending.id !== input.requestId) throw new LocalError(409, "Request is no longer available.");
        // A lost successful reply can be acknowledged, but never republishes an
        // expired/cleared image or executes another capture.
        const digest = hash(JSON.stringify(input));
        if (pending.digest === digest && ["shared", "denied", "failed", "succeeded", "dispatched", "unknown"].includes(pending.status)) return reply({});
        if (input.operation === "result") {
          const executing = pending.status === "executing" && pending.kind === "control";
          if (!(executing || (pending.status === "awaiting_approval" && ["denied", "failed"].includes(input.result))))
            throw new LocalError(409, "No action is awaiting this result.");
          if (input.result === "succeeded" && pending.action?.kind !== "activate_window") throw new LocalError(400, "Input delivery cannot prove application success.");
          pending.status = input.result; pending.digest = digest; pending.action = undefined;
          return reply({});
        }
        if (pending.status !== "awaiting_approval" || this.now() >= Date.parse(pending.expiresAt))
          throw new LocalError(409, "Request was cancelled or expired.");
        if (input.operation === "authorize") {
          if (pending.kind !== "control" || !session.device.permissions.accessibility ||
              !session.catalog || session.catalog.id !== input.catalogId || pending.catalogId !== input.catalogId ||
              pending.windowId !== input.windowId || !session.catalog.windows.some(w => w.id === input.windowId))
            throw new LocalError(409, "Window approval is no longer valid.");
          // Single execution claim. A lost reply is uncertain, never replayable.
          pending.status = "executing";
          return reply({ allowed: true });
        }
        if (input.operation === "windows") {
          const expires = Date.parse(input.catalog.expiresAt);
          if (pending.kind !== "list_windows" || !session.device.permissions.accessibility || expires <= this.now() || expires > this.now() + 180_000 ||
              new Set(input.catalog.windows.map(w => w.id)).size !== input.catalog.windows.length)
            throw new LocalError(400, "Invalid window selection.");
          session.catalog = input.catalog; pending.status = "shared"; pending.digest = digest;
          pending.imageExpiresAt = input.catalog.expiresAt;
          return reply({});
        }
        if (pending.kind !== "snapshot") throw new LocalError(409, "This request is not a snapshot.");
        const bytes = Buffer.from(input.jpeg, "base64");
        if (bytes.byteLength > 2 * 1024 * 1024 || bytes.toString("base64") !== input.jpeg) throw new LocalError(400, "Invalid snapshot.");
        const dimensions = jpegDimensions(bytes);
        const captured = Date.parse(input.metadata.capturedAt);
        if (!dimensions || dimensions.width !== input.metadata.width || dimensions.height !== input.metadata.height ||
          captured < Date.parse(pending.expiresAt) - 120_000 || captured > this.now() + 5000)
          throw new LocalError(400, "Snapshot metadata does not match this request.");
        pending.bytes = bytes; pending.metadata = input.metadata; pending.status = "shared"; pending.digest = digest;
        pending.imageExpiresAt = new Date(this.now() + 60_000).toISOString();
        return reply({});
      }

      const site = request.headers.get("sec-fetch-site");
      if (site && site !== "same-origin" && site !== "none") throw new LocalError(403, "Use this dashboard's own controls.");
      if (request.method !== "GET" && request.method !== "POST") throw new LocalError(405, "Method not allowed.");
      if (request.method === "POST" && request.headers.get("origin") !== localDeviceOrigin)
        throw new LocalError(403, "Use this dashboard's own controls.");
      const cookie = request.headers.get("cookie")?.split(";").map(v => v.trim()).find(v => v.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
      let session = cookie ? this.sessions.get(hash(cookie)) : undefined;
      if (!session) {
        if (request.method !== "GET" || url.search) throw new LocalError(401, "Reload the dashboard to start a session.");
        if (this.sessions.size >= 16) throw new LocalError(503, "Too many local sessions. Close unused sessions or restart the web server.");
        const token = randomBytes(32).toString("hex");
        session = { expires: this.now() + 2 * 60 * 60_000, seen: this.now(), used: new Map() };
        this.sessions.set(hash(token), session);
        headers["Set-Cookie"] = `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/api/devices; Max-Age=7200`;
      }
      session.seen = this.now();
      if (request.method === "GET") {
        if (url.searchParams.has("image")) {
          const snapshot = session.request;
          if (!snapshot?.bytes || snapshot.status !== "shared" || snapshot.id !== url.searchParams.get("image"))
            throw new LocalError(404, "Snapshot has been cleared or expired.");
          return new Response(new Uint8Array(snapshot.bytes), { headers: { ...headers, "Content-Type": "image/jpeg", "Content-Length": String(snapshot.bytes.byteLength) } });
        }
        if (url.search) throw new LocalError(400, "Unknown request.");
        return reply(this.state(session));
      }
      if (url.search) throw new LocalError(400, "Unknown request.");
      const input = browserDeviceCommand.parse(await readBody(request, 2048));
      switch (input.operation) {
        case "pairing": {
          if (session.device) throw new LocalError(409, "Disconnect this Mac before pairing again.");
          const code = randomBytes(16).toString("hex");
          session.challenge = { digest: hash(code), expires: this.now() + 120_000 };
          return reply({ code, expiresAt: new Date(session.challenge.expires).toISOString() });
        }
        case "snapshot":
        case "list_windows":
        case "control": {
          if (!session.device || session.device.id !== input.deviceId) throw new LocalError(404, "Mac is not paired to this browser.");
          const digest = hash(JSON.stringify(input));
          if (session.used.has(input.requestId)) {
            if (session.used.get(input.requestId) !== digest) throw new LocalError(409, "Request ID already used for different details.");
            return reply(this.state(session));
          }
          if (!this.state(session).device?.online) throw new LocalError(409, "Companion is offline. Reconnect it first.");
          if (session.request && ["awaiting_approval", "executing"].includes(session.request.status)) throw new LocalError(409, "Finish or cancel the current request first.");
          if (session.used.size >= 500) throw new LocalError(429, "This browser session reached its request limit. Start a new browser session.");
          if (input.operation !== "snapshot" && !session.device.permissions.accessibility) throw new LocalError(409, "Enable Accessibility in the companion first.");
          if (input.operation === "control" && (!session.catalog || session.catalog.id !== input.catalogId || !session.catalog.windows.some(w => w.id === input.windowId)))
            throw new LocalError(409, "Share a fresh window list from the companion first.");
          if (input.operation === "list_windows") session.catalog = undefined;
          session.used.set(input.requestId, digest);
          session.request = { id: input.requestId, kind: input.operation,
            ...(input.operation === "control" ? { catalogId: input.catalogId, windowId: input.windowId, action: input.action } : {}), status: "awaiting_approval", expiresAt: new Date(this.now() + 120_000).toISOString(), imageExpiresAt: null, metadata: null };
          break;
        }
        case "clear":
          if (session.request) { session.request.status = session.request.status === "executing" ? "unknown" : "cancelled"; session.request.action = undefined; session.request.bytes = undefined; session.request.metadata = null; session.request.imageExpiresAt = null; }
          break;
        case "disconnect": this.disconnect(session); break;
      }
      return reply(this.state(session));
    } catch (error) {
      if (error instanceof LocalError) return reply({ error: error.message }, error.status);
      if (error instanceof z.ZodError || error instanceof SyntaxError) return reply({ error: "Invalid local device request." }, 400);
      return reply({ error: "Local connection failed. Reconnect the companion." }, 500);
    }
  }

  private disconnect(session: Session) {
    if (session.request?.status === "executing") { session.request.status = "unknown"; session.request.action = undefined; }
    else session.request = undefined;
    session.device = undefined; session.catalog = undefined; session.challenge = undefined;
    // Keep admitted IDs for the whole browser session, including across re-pair.
  }
  private byToken(authorization: string) {
    if (!/^Bearer [a-f0-9]{64}$/.test(authorization)) throw new LocalError(401, "Pair the companion again.");
    const tokenHash = hash(authorization.slice(7));
    const session = [...this.sessions.values()].find(s => s.device?.tokenHash === tokenHash);
    if (!session) throw new LocalError(401, "Pair the companion again.");
    return session;
  }
}

async function readBody(request: Request, limit: number) {
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json") throw new LocalError(415, "JSON required.");
  const reader = request.body?.getReader();
  if (!reader) throw new LocalError(400, "Body required.");
  let size = 0;
  const chunks: Uint8Array[] = [];
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void reader.cancel(); }, 8000);
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new LocalError(413, "Request too large."); }
      chunks.push(value);
    }
    if (timedOut) throw new LocalError(408, "Request timed out.");
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally { clearTimeout(timer); reader.releaseLock(); }
}

// Read the SOF dimensions without decoding untrusted pixels or adding an image
// processor. Only baseline/progressive JPEG from the native encoder is accepted.
function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) return;
  for (let i = 2; i + 9 < bytes.length;) {
    if (bytes[i] !== 255) return;
    const marker = bytes[i + 1];
    const length = bytes[i + 2] * 256 + bytes[i + 3];
    if (length < 2 || i + length + 2 > bytes.length) return;
    if (marker === 0xc0 || marker === 0xc2) return { height: bytes[i + 5] * 256 + bytes[i + 6], width: bytes[i + 7] * 256 + bytes[i + 8] };
    if (marker === 0xda) return;
    i += length + 2;
  }
}
