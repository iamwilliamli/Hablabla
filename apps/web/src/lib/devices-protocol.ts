import { z } from "zod";

// Local dashboard protocol v1. Separate from the Terminal open_resource relay.
export const localDeviceOrigin = "http://127.0.0.1:3100";
export const permissionsSchema = z.strictObject({ screenRecording: z.boolean(), accessibility: z.boolean() });
export const snapshotMetadataSchema = z.strictObject({
  target: z.string().min(1).max(240), targetId: z.string().min(1).max(100),
  kind: z.enum(["window", "display"]), width: z.int().min(1).max(2560), height: z.int().min(1).max(2560),
  scale: z.number().positive().max(8), capturedAt: z.iso.datetime(),
});
export const snapshotStatusSchema = z.enum(["awaiting_approval", "shared", "denied", "cancelled", "expired", "failed"]);
export const deviceStateSchema = z.strictObject({
  device: z.strictObject({
    id: z.uuid(), name: z.string(), online: z.boolean(), permissions: permissionsSchema,
    lastSeen: z.iso.datetime(),
  }).nullable(),
  request: z.strictObject({
    id: z.uuid(), status: snapshotStatusSchema, expiresAt: z.iso.datetime(),
    imageExpiresAt: z.iso.datetime().nullable(), metadata: snapshotMetadataSchema.nullable(),
  }).nullable(),
});
export type DeviceState = z.infer<typeof deviceStateSchema>;

export const browserDeviceCommand = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("pairing") }),
  z.strictObject({ operation: z.literal("snapshot"), requestId: z.uuid(), deviceId: z.uuid() }),
  z.strictObject({ operation: z.literal("clear") }),
  z.strictObject({ operation: z.literal("disconnect") }),
]);
export const nativeDeviceCommand = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("pair"), code: z.string().regex(/^[a-f0-9]{32}$/), name: z.string().min(1).max(100), permissions: permissionsSchema }),
  z.strictObject({ operation: z.literal("poll"), permissions: permissionsSchema }),
  z.strictObject({ operation: z.literal("disconnect") }),
  z.strictObject({ operation: z.literal("result"), requestId: z.uuid(), result: z.enum(["denied", "failed"]) }),
  z.strictObject({ operation: z.literal("share"), requestId: z.uuid(), metadata: snapshotMetadataSchema,
    jpeg: z.string().min(8).max(2_796_204).regex(/^[A-Za-z0-9+/]+={0,2}$/) }),
]);
