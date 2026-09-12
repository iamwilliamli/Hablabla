/** Loopback-only development fixture. The admin surface is this process's Terminal,
 * not an unauthenticated web endpoint. A production relay is a separate project. */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import {
  pairingRequest, sessionRequest, connectRequest, authorizeRequest, eventSchema,
  terminalStatuses, type Command, type CommandEvent,
} from "./protocol.js";

type Device = {
  ownerId: string; deviceId: string; name: string; tokenHash: string; revoked: boolean;
  resources: { id: string; label: string }[]; sessionId?: string; lastSeen: number;
};
type Pending = { command: Command; ownerId: string; status: string; cancelRequested: boolean; result?: CommandEvent };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
class HttpError extends Error { constructor(readonly status: number) { super("request_rejected"); } }
export class DemoRelay {
  private pairings = new Map<string, { ownerId: string; expires: number }>();
  private devices = new Map<string, Device>();
  private commands = new Map<string, Pending>();
  readonly server = createServer((req, res) => { void this.handle(req, res); });
  constructor(private now: () => number = Date.now) {
    this.server.requestTimeout = 10000; this.server.headersTimeout = 10000;
    this.server.maxHeadersCount = 30;
  }
  async listen(port = 3210) {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject); this.server.listen(port, "127.0.0.1", resolve);
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("No relay port.");
    return `http://127.0.0.1:${address.port}`;
  }
  async close() { this.server.closeAllConnections(); await new Promise<void>((resolve) => this.server.close(() => resolve())); }
  pairing(ownerId: string) {
    for (const [key, value] of this.pairings) if (value.expires <= this.now()) this.pairings.delete(key);
    const code = randomBytes(16).toString("hex");
    this.pairings.set(hash(code), { ownerId, expires: this.now() + 120000 });
    return code;
  }
  list(ownerId: string) {
    return [...this.devices.values()].filter(d => d.ownerId === ownerId && !d.revoked).map(d => ({
      deviceId: d.deviceId, name: d.name, resources: d.resources,
      online: Boolean(d.sessionId) && this.now() - d.lastSeen < 15000,
    }));
  }
  private owned(ownerId: string, deviceId: string) {
    const device = this.devices.get(deviceId);
    if (!device || device.ownerId !== ownerId || device.revoked) throw new Error("Device unavailable for this owner.");
    return device;
  }
  open(ownerId: string, deviceId: string, resourceId: string) {
    const device = this.owned(ownerId, deviceId);
    if (!device.sessionId || this.now() - device.lastSeen >= 15000) throw new Error("Device is offline.");
    if (!device.resources.some(r => r.id === resourceId)) throw new Error("Resource is not advertised by this device.");
    if ([...this.commands.values()].some(c => c.command.deviceId === deviceId && !terminalStatuses.has(c.status))) throw new Error("Wait for the current command to finish.");
    // A bounded, in-memory fixture. Expired history is not a production record store.
    if (this.commands.size >= 1000) throw new Error("Demo history is full. Restart the demo relay.");
    const command: Command = {
      protocolVersion: 1, type: "command.request", intentId: randomUUID(), commandId: randomUUID(),
      deviceId, sessionId: device.sessionId, issuedAt: new Date(this.now()).toISOString(),
      expiresAt: new Date(this.now() + 60000).toISOString(), action: { kind: "open_resource", resourceId },
    };
    this.commands.set(command.commandId, { command, ownerId, status: "queued", cancelRequested: false });
    return command;
  }
  history(ownerId: string) {
    return [...this.commands.values()].filter(c => c.ownerId === ownerId).map(c => ({
      commandId: c.command.commandId, deviceId: c.command.deviceId, resourceId: c.command.action.resourceId,
      status: c.status, cancelRequested: c.cancelRequested, code: c.result?.code,
    }));
  }
  cancel(ownerId: string, commandId: string) {
    const pending = this.commands.get(commandId);
    if (!pending || pending.ownerId !== ownerId) throw new Error("Command not found.");
    if (!terminalStatuses.has(pending.status)) pending.cancelRequested = true;
  }
  revoke(ownerId: string, deviceId: string) {
    const device = this.owned(ownerId, deviceId); device.revoked = true;
    this.invalidateSession(device);
  }
  private invalidateSession(device: Device) {
    for (const pending of this.commands.values()) {
      if (pending.command.deviceId === device.deviceId && !terminalStatuses.has(pending.status)) {
        // A disconnect may race OS execution. Never assert cancelled/succeeded without its result.
        pending.status = "unknown";
      }
    }
    delete device.sessionId;
  }
  private authenticate(req: IncomingMessage) {
    const token = req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    const device = token && [...this.devices.values()].find(d => d.tokenHash === hash(token));
    if (!device || device.revoked) throw new HttpError(401);
    return device;
  }
  private session(device: Device, value: unknown) {
    const { sessionId } = sessionRequest.parse(value);
    if (sessionId !== device.sessionId || this.now() - device.lastSeen >= 15000) throw new HttpError(409);
    device.lastSeen = this.now();
  }
  private async body(req: IncomingMessage) {
    let bytes = 0; const chunks: Buffer[] = [];
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > 16384) throw new HttpError(413);
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  private async handle(req: IncomingMessage, res: ServerResponse) {
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      res.end(JSON.stringify(data));
    };
    try {
      const address = this.server.address();
      const expectedHost = address && typeof address !== "string" ? `127.0.0.1:${address.port}` : "";
      if (req.headers.host !== expectedHost || req.headers.origin || req.headers["sec-fetch-site"]) throw new HttpError(403);
      if (req.method !== "POST" || req.headers["content-type"] !== "application/json") throw new HttpError(405);
      const raw: unknown = await this.body(req);
      if (req.url === "/v1/pairings/complete") {
        const input = pairingRequest.parse(raw);
        const challenge = this.pairings.get(hash(input.code));
        if (!challenge || challenge.expires <= this.now()) throw new HttpError(401);
        if (this.devices.has(input.deviceId) && !this.devices.get(input.deviceId)!.revoked) throw new HttpError(409);
        this.pairings.delete(hash(input.code));
        const token = randomBytes(32).toString("hex");
        this.devices.set(input.deviceId, {
          ownerId: challenge.ownerId, deviceId: input.deviceId, name: input.name,
          tokenHash: hash(token), revoked: false, resources: input.resources, lastSeen: 0,
        });
        send(200, { deviceId: input.deviceId, deviceToken: token }); return;
      }
      const device = this.authenticate(req);
      if (req.url === "/v1/companion/revoke") {
        z.strictObject({}).parse(raw); this.revoke(device.ownerId, device.deviceId); send(200, {}); return;
      }
      if (req.url === "/v1/companion/connect") {
        const input = connectRequest.parse(raw);
        this.invalidateSession(device); device.resources = input.resources;
        device.sessionId = randomUUID(); device.lastSeen = this.now();
        send(200, { sessionId: device.sessionId }); return;
      }
      if (req.url === "/v1/companion/events") {
        const event = eventSchema.parse(raw);
        this.session(device, { sessionId: event.sessionId });
        const pending = this.commands.get(event.commandId);
        if (!pending || pending.command.deviceId !== device.deviceId || event.deviceId !== device.deviceId ||
            event.intentId !== pending.command.intentId || event.sessionId !== pending.command.sessionId) throw new HttpError(403);
        if (terminalStatuses.has(pending.status)) {
          if (JSON.stringify(pending.result) !== JSON.stringify(event)) throw new HttpError(409);
        } else {
          const stages = ["queued", "received", "awaiting_approval", "running"];
          if (!terminalStatuses.has(event.status) && stages.indexOf(event.status) < stages.indexOf(pending.status)) throw new HttpError(409);
          if (event.status === "running" && (pending.cancelRequested || Date.parse(pending.command.expiresAt) <= this.now())) throw new HttpError(409);
          pending.status = event.status;
          if (terminalStatuses.has(event.status)) pending.result = event;
        }
        send(200, {}); return;
      }
      if (req.url === "/v1/companion/authorize") {
        const input = authorizeRequest.parse(raw);
        this.session(device, { sessionId: input.sessionId });
        const pending = this.commands.get(input.commandId);
        const allowed = !!pending && pending.command.deviceId === device.deviceId &&
          pending.command.sessionId === device.sessionId && !pending.cancelRequested &&
          pending.status === "awaiting_approval" && Date.parse(pending.command.expiresAt) > this.now();
        send(200, { allowed }); return;
      }
      this.session(device, raw);
      if (req.url === "/v1/companion/heartbeat") {
        send(200, { cancelled: [...this.commands.values()].filter(c => c.command.deviceId === device.deviceId &&
          c.command.sessionId === device.sessionId && c.cancelRequested && !terminalStatuses.has(c.status)).map(c => c.command.commandId) }); return;
      }
      if (req.url === "/v1/companion/poll") {
        const pending = [...this.commands.values()].find(c => c.command.deviceId === device.deviceId &&
          c.command.sessionId === device.sessionId && !terminalStatuses.has(c.status));
        send(200, { command: pending?.command ?? null }); return;
      }
      throw new HttpError(404);
    } catch (error) {
      send(error instanceof HttpError ? error.status : 400, { error: "request_rejected" });
    }
  }
}
