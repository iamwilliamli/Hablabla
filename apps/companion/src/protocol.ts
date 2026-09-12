import { z } from "zod";

export const id = z.string().uuid();
export const resourceId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,79}$/);
export const resourceInfo = z.strictObject({ id: resourceId, label: z.string().min(1).max(120) });
export const commandSchema = z.strictObject({
  protocolVersion: z.literal(1), type: z.literal("command.request"),
  intentId: id, commandId: id, deviceId: id, sessionId: id,
  issuedAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
  action: z.strictObject({ kind: z.literal("open_resource"), resourceId }),
});
export type Command = z.infer<typeof commandSchema>;
export const statusSchema = z.enum(["received", "awaiting_approval", "running", "succeeded", "denied", "failed", "cancelled", "expired", "unknown"]);
export const terminalStatuses = new Set(["succeeded", "denied", "failed", "cancelled", "expired", "unknown"]);
export const eventSchema = z.strictObject({
  protocolVersion: z.literal(1), commandId: id, intentId: id, deviceId: id, sessionId: id,
  status: statusSchema, code: z.string().regex(/^[a-z_]{1,60}$/), at: z.iso.datetime(),
});
export type CommandEvent = z.infer<typeof eventSchema>;
export const pairingRequest = z.strictObject({
  code: z.string().regex(/^[a-f0-9]{32}$/), deviceId: id,
  name: z.string().min(1).max(100), capabilities: z.tuple([z.literal("open_resource")]),
  resources: z.array(resourceInfo).max(50),
});
export const pairingResponse = z.strictObject({ deviceId: id, deviceToken: z.string().regex(/^[a-f0-9]{64}$/) });
export const sessionRequest = z.strictObject({ sessionId: id });
export const connectRequest = z.strictObject({ resources: z.array(resourceInfo).max(50) });
export const authorizeRequest = sessionRequest.extend({ commandId: id });
export const heartbeatResponse = z.strictObject({ cancelled: z.array(id).max(100) });

export function relayOrigin(value: string): string {
  const url = new URL(value);
  const local = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      (url.protocol !== "https:" && !(local && url.protocol === "http:"))) {
    throw new Error("Use an HTTPS relay origin, or HTTP at literal 127.0.0.1 / [::1] for local development.");
  }
  return url.origin;
}
