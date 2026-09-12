import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { realpath, readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import type { Resource } from "./storage.js";

export function companionAppPath() {
  const override = process.env.HABLABLA_COMPANION_APP;
  if (override !== undefined && (!isAbsolute(override) || !override.endsWith(".app"))) {
    throw new Error("HABLABLA_COMPANION_APP must be an absolute .app bundle path.");
  }
  return override ?? join(homedir(), "Applications", "Hablabla Companion.app");
}
const executablePath = () => join(companionAppPath(), "Contents", "MacOS", "HablablaCompanion");
export async function appIdentity() {
  const identity = await native({ op: "identity" });
  if (identity.value !== "com.hablabla.companion" || !identity.version || !identity.bundlePath) {
    throw new Error("Installed app has an unexpected identity. Rebuild and reinstall the companion.");
  }
  return identity;
}
export async function launchCompanionApp() {
  await appIdentity();
  await new Promise<void>((resolve, reject) => {
    const child = spawn("/usr/bin/open", [companionAppPath()], { stdio: "ignore", shell: false });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve() : reject(new Error("Unable to launch the companion app.")));
  });
}
export async function native(request: Record<string, unknown>): Promise<{ value?: string; version?: string; bundlePath?: string }> {
  if (process.platform !== "darwin") throw new Error("The companion OS adapter requires macOS.");
  return new Promise((resolve, reject) => {
    const child = spawn(executablePath(), ["--stdio"], { stdio: ["pipe", "pipe", "pipe"], shell: false });
    let output = "";
    // Never echo native output on failure: Keychain responses may contain a token.
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Native helper timed out; outcome may be unknown.")); }, 15000);
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > 16384) child.kill();
    });
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.on("error", () => { clearTimeout(timeout); reject(new Error("Native helper unavailable. Run npm run companion:build and npm run companion:install.")); });
    child.on("close", code => {
      clearTimeout(timeout);
      if (code !== 0) return reject(new Error("Native operation failed; check macOS permissions and the registered resource."));
      try { resolve(JSON.parse(output)); } catch { reject(new Error("Invalid native response.")); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}
export const keychain = {
  async set(account: string, value: string) { await native({ op: "keychain_set", account, value }); },
  async get(account: string) {
    const result = await native({ op: "keychain_get", account });
    if (!result.value || !/^[a-f0-9]{64}$/.test(result.value)) throw new Error("Device credential is missing. Pair again.");
    return result.value;
  },
  async delete(account: string) { await native({ op: "keychain_delete", account }); },
};
const extensions = new Set([".pdf", ".ppt", ".pptx", ".key", ".txt"]);
export async function fingerprint(path: string) {
  const canonical = await realpath(path);
  const info = await stat(canonical);
  if (!info.isFile() || !extensions.has(extname(canonical).toLowerCase()) || info.size > 100 * 1024 * 1024) {
    throw new Error("Register a regular PDF, PPT/PPTX, KEY, or TXT file up to 100 MB.");
  }
  return { path: canonical, sha256: createHash("sha256").update(await readFile(canonical)).digest("hex") };
}
export async function validateResource(resource: Resource) {
  const current = await fingerprint(resource.path);
  if (current.path !== resource.path || current.sha256 !== resource.sha256) {
    throw new Error("The registered file changed; register it again before opening.");
  }
}
export async function openResource(resource: Resource) {
  const result = await native({ op: "open_resource", path: resource.path, sha256: resource.sha256 });
  if (result.value !== "open_dispatched") throw new Error("Native open was not confirmed.");
}
