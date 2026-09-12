import { z } from "zod";

// Local dashboard v2. Never send control requests to a v1 snapshot companion.
export const localDeviceOrigin = "http://127.0.0.1:3100";
export const permissionsSchema = z.strictObject({ screenRecording: z.boolean(), accessibility: z.boolean() });
export const snapshotMetadataSchema = z.strictObject({
  target: z.string().min(1).max(240), targetId: z.string().min(1).max(100),
  kind: z.enum(["window", "display"]), width: z.int().min(1).max(2560), height: z.int().min(1).max(2560),
  scale: z.number().positive().max(8), capturedAt: z.iso.datetime(),
});
const point = z.strictObject({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) });
export const keyNames = ["a", "c", "v", "x", "z", "s", "f", "n", "w", "p", "r", "q", "t", "b", "i", "u", "Enter", "Tab", "Escape", "Backspace", "Delete", "Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"] as const;
export const controlActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("activate_window") }),
  z.strictObject({ kind: z.literal("pointer"), mode: z.enum(["move", "click", "double_click", "right_click", "drag"]), point, end: point.optional() }).refine(v => (v.mode === "drag") === (v.end !== undefined)),
  z.strictObject({ kind: z.literal("scroll"), point, dx: z.int().min(-600).max(600), dy: z.int().min(-600).max(600) }),
  z.strictObject({ kind: z.literal("type_text"), text: z.string().min(1).max(500).refine(v => !/[\u0000-\u001f\u007f]/u.test(v), "Use named keys for control characters.") }),
  z.strictObject({ kind: z.literal("key"), key: z.enum(keyNames), modifiers: z.array(z.enum(["command", "shift", "option", "control"])).max(4).refine(v => new Set(v).size === v.length) }),
]);
export type ControlAction = z.infer<typeof controlActionSchema>;
export const windowSchema = z.strictObject({ id: z.uuid(), app: z.string().min(1).max(100), title: z.string().min(1).max(160), minimized: z.boolean() });
export const catalogSchema = z.strictObject({ id: z.uuid(), expiresAt: z.iso.datetime(), windows: z.array(windowSchema).max(50) });
export const snapshotStatusSchema = z.enum(["awaiting_approval", "executing", "shared", "succeeded", "dispatched", "unknown", "denied", "cancelled", "expired", "failed"]);
export const deviceStateSchema = z.strictObject({
  device: z.strictObject({ id: z.uuid(), name: z.string(), online: z.boolean(), permissions: permissionsSchema, lastSeen: z.iso.datetime() }).nullable(),
  catalog: catalogSchema.nullable(),
  request: z.strictObject({
    id: z.uuid(), kind: z.enum(["snapshot", "list_windows", "control"]), status: snapshotStatusSchema,
    expiresAt: z.iso.datetime(), imageExpiresAt: z.iso.datetime().nullable(), metadata: snapshotMetadataSchema.nullable(),
    catalogId: z.uuid().optional(), windowId: z.uuid().optional(), action: controlActionSchema.optional(),
  }).nullable(),
});
export type DeviceState = z.infer<typeof deviceStateSchema>;
export const browserDeviceCommand = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("ai_status") }),
  z.strictObject({ operation: z.literal("ai_cancel") }),
  z.strictObject({ operation: z.literal("ai_plan"), planId: z.uuid(), deviceId: z.uuid(), catalogId: z.uuid(), windowId: z.uuid(), instruction: z.string().trim().min(1).max(2000) }),
  z.strictObject({ operation: z.literal("pairing") }),
  z.strictObject({ operation: z.literal("snapshot"), requestId: z.uuid(), deviceId: z.uuid() }),
  z.strictObject({ operation: z.literal("list_windows"), requestId: z.uuid(), deviceId: z.uuid() }),
  z.strictObject({ operation: z.literal("control"), requestId: z.uuid(), deviceId: z.uuid(), catalogId: z.uuid(), windowId: z.uuid(), action: controlActionSchema }),
  z.strictObject({ operation: z.literal("clear") }),
  z.strictObject({ operation: z.literal("disconnect") }),
]);
export const nativeDeviceCommand = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("pair"), protocolVersion: z.literal(2), code: z.string().regex(/^[a-f0-9]{32}$/), name: z.string().min(1).max(100), permissions: permissionsSchema }),
  z.strictObject({ operation: z.literal("poll"), permissions: permissionsSchema }),
  z.strictObject({ operation: z.literal("disconnect") }),
  z.strictObject({ operation: z.literal("result"), requestId: z.uuid(), result: z.enum(["denied", "failed", "succeeded", "dispatched", "unknown"]) }),
  z.strictObject({ operation: z.literal("authorize"), requestId: z.uuid(), catalogId: z.uuid(), windowId: z.uuid() }),
  z.strictObject({ operation: z.literal("windows"), requestId: z.uuid(), catalog: catalogSchema }),
  z.strictObject({ operation: z.literal("share"), requestId: z.uuid(), metadata: snapshotMetadataSchema,
    jpeg: z.string().min(8).max(2_796_204).regex(/^[A-Za-z0-9+/]+={0,2}$/) }),
]);
