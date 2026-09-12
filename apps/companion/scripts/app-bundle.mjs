import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../", import.meta.url));
export const bundleName = "Hablabla Companion.app";
export const bundleId = "com.hablabla.companion";
export const executableName = "HablablaCompanion";
export const buildApp = join(root, "dist", bundleName);
export const installedApp = join(homedir(), "Applications", bundleName);

export function run(file, args) {
  const result = spawnSync(file, args, { encoding: "utf8", shell: false });
  if (result.error || result.status !== 0) {
    throw new Error(`${file} failed: ${result.stderr?.trim() || result.error?.message || result.status}`);
  }
  return result.stdout.trim();
}
export function requireMac() {
  if (process.platform !== "darwin") throw new Error("Companion app packaging requires macOS and Xcode Command Line Tools.");
}
export function verifyBundle(app) {
  const plist = join(app, "Contents", "Info.plist");
  run("/usr/bin/plutil", ["-lint", plist]);
  const read = key => run("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", plist]);
  if (read("CFBundleIdentifier") !== bundleId || read("CFBundleExecutable") !== executableName || read("LSUIElement") !== "true") {
    throw new Error("Unexpected companion bundle identity or application mode.");
  }
  run("/usr/bin/codesign", ["--verify", "--strict", app]);
}
