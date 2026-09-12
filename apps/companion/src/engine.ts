import { createHash } from "node:crypto";
import { join } from "node:path";
import { commandSchema, terminalStatuses, type Command, type CommandEvent } from "./protocol.js";
import { journalSchema, readJSON, writePrivate, type Journal, type Resource } from "./storage.js";

export interface EnginePorts {
  approve(resource: Resource, command: Command, signal: AbortSignal): Promise<boolean>;
  validate(resource: Resource): Promise<void>;
  open(resource: Resource): Promise<void>;
  authorize(command: Command): Promise<boolean>;
  report(event: CommandEvent): Promise<void>;
  now?: () => number;
}
export class CommandEngine {
  private active = false;
  private journal: Journal = {};
  constructor(private directory: string, private deviceId: string, private resources: Resource[], private ports: EnginePorts) {}
  private now() { return this.ports.now?.() ?? Date.now(); }
  async init() {
    this.journal = journalSchema.parse(await readJSON(join(this.directory, "journal.json")) ?? {});
    // Expired envelopes can never execute. Keep one day of results, bounded at admission.
    for (const [key, record] of Object.entries(this.journal)) {
      if (Date.parse(record.expiresAt) + 86400000 < this.now()) delete this.journal[key];
    }
    await this.persist();
  }
  private persist() { return writePrivate(join(this.directory, "journal.json"), this.journal); }
  async handle(raw: unknown, sessionId: string, signal: AbortSignal): Promise<CommandEvent> {
    if (this.active) throw new Error("One command may execute at a time.");
    this.active = true;
    try { return await this.execute(commandSchema.parse(raw), sessionId, signal); }
    finally { this.active = false; }
  }
  private async execute(command: Command, sessionId: string, signal: AbortSignal): Promise<CommandEvent> {
    const digest = createHash("sha256").update(JSON.stringify(command)).digest("hex");
    const event = (status: CommandEvent["status"], code: string): CommandEvent => ({
      protocolVersion: 1, commandId: command.commandId, intentId: command.intentId,
      deviceId: command.deviceId, sessionId: command.sessionId, status, code, at: new Date(this.now()).toISOString(),
    });
    // Never let a malformed/misrouted envelope poison another device's durable records.
    if (command.deviceId !== this.deviceId || command.sessionId !== sessionId) throw new Error("Command device/session mismatch.");
    const prior = this.journal[command.commandId];
    if (prior) {
      if (prior.digest !== digest) throw new Error("Command ID was reused with different content.");
      if (prior.result && terminalStatuses.has(prior.result.status)) {
        await this.ports.report(prior.result); return prior.result;
      }
      // Any admitted command surviving a restart is uncertain, even if the last write
      // preceded the OS call. Do not replay it or reuse a previous local approval.
      const result = event("unknown", "interrupted_command");
      prior.result = result; await this.persist(); await this.ports.report(result); return result;
    }
    if (Object.keys(this.journal).length >= 2000) throw new Error("Command journal is full; wait for old entries to expire.");
    const record: Journal[string] = { digest, expiresAt: command.expiresAt, claimed: false };
    this.journal[command.commandId] = record;
    await this.persist();
    const finish = async (status: CommandEvent["status"], code: string) => {
      const result = event(status, code);
      record.result = result; await this.persist();
      // The caller retries delivery from the durable record if the reply is lost.
      await this.ports.report(result); return result;
    };
    const issued = Date.parse(command.issuedAt), expires = Date.parse(command.expiresAt);
    const stale = () => expires <= this.now();
    if (issued > this.now() + 5000 || expires <= issued || expires - issued > 120000 || stale()) return finish("expired", "invalid_or_expired_window");
    if (signal.aborted) return finish("cancelled", "session_stopped");
    const resource = this.resources.find(item => item.id === command.action.resourceId);
    if (!resource) return finish("failed", "resource_not_registered");
    await this.ports.report(event("received", "command_received"));
    try { await this.ports.validate(resource); }
    catch { return finish("failed", "resource_changed_or_missing"); }
    await this.ports.report(event("awaiting_approval", "local_approval_required"));
    const deadline = AbortSignal.timeout(Math.max(1, expires - this.now()));
    const approvalSignal = AbortSignal.any([signal, deadline]);
    let approved = false;
    try { approved = await this.ports.approve(resource, command, approvalSignal); }
    catch { /* Abort, closed terminal, or prompt error always fails closed. */ }
    if (signal.aborted) return finish("cancelled", "session_stopped");
    if (stale() || deadline.aborted) return finish("expired", "approval_expired");
    if (!approved) return finish("denied", "local_user_denied");
    let allowed = false;
    try { allowed = await this.ports.authorize(command); }
    catch { return finish("cancelled", "connection_lost_before_execution"); }
    if (!allowed || signal.aborted) return finish("cancelled", "session_or_command_revoked");
    try { await this.ports.validate(resource); }
    catch { return finish("failed", "resource_changed_or_missing"); }
    if (signal.aborted) return finish("cancelled", "session_stopped");
    if (stale()) return finish("expired", "command_expired");
    await this.ports.report(event("running", "dispatching_open"));
    record.claimed = true; await this.persist();
    if (signal.aborted) return finish("cancelled", "session_stopped");
    if (stale()) return finish("expired", "command_expired");
    try { await this.ports.open(resource); }
    catch { return finish("unknown", "native_open_not_confirmed"); }
    return finish("succeeded", "open_dispatched");
  }
}
