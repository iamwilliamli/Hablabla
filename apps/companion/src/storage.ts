import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { id, resourceId, eventSchema, relayOrigin } from "./protocol.js";

export const resourceSchema = z.strictObject({
  id: resourceId, label: z.string().min(1).max(120), path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type Resource = z.infer<typeof resourceSchema>;
export const configSchema = z.strictObject({
  version: z.literal(1), deviceId: id, name: z.string().min(1).max(100),
  relay: z.string().refine(v => { try { return relayOrigin(v) === v; } catch { return false; } }).optional(),
  keychainAccount: id.optional(), resources: z.array(resourceSchema).max(50),
});
export type Config = z.infer<typeof configSchema>;
export const journalSchema = z.record(z.string().uuid(), z.strictObject({
  digest: z.string(), expiresAt: z.string(), claimed: z.boolean(), result: eventSchema.optional(),
}));
export type Journal = z.infer<typeof journalSchema>;

export async function privateDirectory(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await stat(directory);
  if ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) {
    throw new Error("Companion state directory must be owned by you with mode 700.");
  }
}
export async function writePrivate(path: string, data: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(data, null, 2) + "\n"); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, path);
  const directory = await open(dirname(path), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}
export async function readJSON(path: string): Promise<unknown | undefined> {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
export async function getConfig(directory: string): Promise<Config> {
  const value = await readJSON(join(directory, "config.json"));
  if (!value) throw new Error("Run register first to create the companion configuration.");
  return configSchema.parse(value);
}
export async function acquireLock(directory: string) {
  await privateDirectory(directory);
  const path = join(directory, "process.lock");
  try {
    const file = await open(path, "wx", 0o600);
    await file.writeFile(String(process.pid)); await file.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("Companion state is locked. Stop the other process; after a crash, use unlock to check/remove the stale lock.");
    }
    throw error;
  }
  return () => rm(path, { force: true });
}
export async function unlock(directory: string) {
  const path = join(directory, "process.lock");
  const pid = Number(await readFile(path, "utf8"));
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Invalid lock; inspect it manually.");
  try { process.kill(pid, 0); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") { await rm(path); return; }
    throw error;
  }
  throw new Error("The lock owner is still running. Stop it before unlocking.");
}
