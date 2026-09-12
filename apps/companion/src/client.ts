import { z } from "zod";
import { relayOrigin, heartbeatResponse, commandSchema, type Command, type CommandEvent } from "./protocol.js";

export class RelayError extends Error {
  constructor(public status: number) { super(`Relay request failed (HTTP ${status}).`); }
}
export class RelayClient {
  readonly origin: string;
  constructor(origin: string, private token?: string) { this.origin = relayOrigin(origin); }
  async request(path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    const response = await fetch(this.origin + path, {
      method: "POST", redirect: "error",
      headers: { "Content-Type": "application/json", ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.any([AbortSignal.timeout(8000), ...(signal ? [signal] : [])]),
    });
    if (!response.ok) { await response.body?.cancel(); throw new RelayError(response.status); }
    // Stream-bound the body, not just Content-Length (which a peer may omit).
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Empty relay response.");
    let data = "", bytes = 0;
    const decoder = new TextDecoder();
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 65536) { await reader.cancel(); throw new Error("Relay response too large."); }
      data += decoder.decode(part.value, { stream: true });
    }
    return JSON.parse(data + decoder.decode());
  }
  async connect(resources: { id: string; label: string }[], signal?: AbortSignal) {
    return z.strictObject({ sessionId: z.string().uuid() }).parse(await this.request("/v1/companion/connect", { resources }, signal)).sessionId;
  }
  async poll(sessionId: string, signal?: AbortSignal) {
    return z.strictObject({ command: commandSchema.nullable() }).parse(await this.request("/v1/companion/poll", { sessionId }, signal)).command;
  }
  async heartbeat(sessionId: string, signal?: AbortSignal) {
    return heartbeatResponse.parse(await this.request("/v1/companion/heartbeat", { sessionId }, signal));
  }
  async authorize(command: Command) {
    return z.strictObject({ allowed: z.boolean() }).parse(await this.request("/v1/companion/authorize", { sessionId: command.sessionId, commandId: command.commandId })).allowed;
  }
  async report(event: CommandEvent) { await this.request("/v1/companion/events", event); }
}
