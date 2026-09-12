import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { browserDeviceCommand, nativeDeviceCommand, localDeviceOrigin,
  type DeviceState } from "../devices-protocol";

const cookieName = "hablabla-local-device-session";
const maxBody = 2_810_000;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
type Snapshot = NonNullable<DeviceState["request"]> & { bytes?: Uint8Array; digest?: string };
type Session = { expires: number; seen: number; challenge?: { digest: string; expires: number };
  device?: NonNullable<DeviceState["device"]> & { tokenHash: string }; request?: Snapshot; used: Set<string> };
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
      const request = session.request;
      if (!request) continue;
      const offline = !session.device || now - Date.parse(session.device.lastSeen) > 10_000 || now - session.seen > 15_000;
      if (request.status === "awaiting_approval" && (offline || now >= Date.parse(request.expiresAt))) {
        request.status = offline ? "cancelled" : "expired";
      }
      if (request.status === "shared" && (offline || now >= Date.parse(request.imageExpiresAt!))) request.status = "expired";
      if (request.status !== "shared") { request.bytes = undefined; request.metadata = null; request.imageExpiresAt = null; }
    }
  }

  private state(session: Session): DeviceState {
    const device = session.device;
    const request = session.request;
    return {
      device: device ? { id: device.id, name: device.name, permissions: device.permissions, lastSeen: device.lastSeen,
        online: this.now() - Date.parse(device.lastSeen) <= 10_000 } : null,
      request: request ? { id: request.id, status: request.status, expiresAt: request.expiresAt,
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
          return reply({ token, deviceId: owner.device.id });
        }
        if (!session?.device) throw new LocalError(401, "Pair the companion again.");
        if (input.operation === "disconnect") { this.disconnect(session); return reply({}); }
        if (input.operation === "poll") {
          session.device.permissions = input.permissions;
          session.device.lastSeen = new Date(this.now()).toISOString();
          const pending = session.request?.status === "awaiting_approval" ? session.request : null;
          return reply({ request: pending ? { id: pending.id, expiresAt: pending.expiresAt } : null });
        }
        const pending = session.request;
        if (!pending || pending.id !== input.requestId) throw new LocalError(409, "Request is no longer available.");
        // A lost successful reply can be acknowledged, but never republishes an
        // expired/cleared image or executes another capture.
        const digest = hash(JSON.stringify(input));
        if (pending.digest === digest && ["shared", "denied", "failed"].includes(pending.status)) return reply({});
        if (pending.status !== "awaiting_approval" || this.now() >= Date.parse(pending.expiresAt))
          throw new LocalError(409, "Request was cancelled or expired.");
        if (input.operation === "result") { pending.status = input.result; pending.digest = digest; return reply({}); }
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
        session = { expires: this.now() + 2 * 60 * 60_000, seen: this.now(), used: new Set() };
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
        case "snapshot": {
          if (!session.device || session.device.id !== input.deviceId) throw new LocalError(404, "Mac is not paired to this browser.");
          if (session.used.has(input.requestId)) return reply(this.state(session));
          if (!this.state(session).device?.online) throw new LocalError(409, "Companion is offline. Reconnect it first.");
          if (session.request?.status === "awaiting_approval") throw new LocalError(409, "Finish or cancel the current request first.");
          if (session.used.size >= 500) throw new LocalError(429, "This browser session reached its snapshot limit. Start a new browser session.");
          session.used.add(input.requestId);
          session.request = { id: input.requestId, status: "awaiting_approval", expiresAt: new Date(this.now() + 120_000).toISOString(), imageExpiresAt: null, metadata: null };
          break;
        }
        case "clear":
          if (session.request) { session.request.status = "cancelled"; session.request.bytes = undefined; session.request.metadata = null; session.request.imageExpiresAt = null; }
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
    session.device = undefined; session.request = undefined; session.challenge = undefined;
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
