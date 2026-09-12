import { mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
if (process.platform !== "darwin") throw new Error("Native build requires macOS and Xcode Command Line Tools.");
const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(root + "dist", { recursive: true });
const result = spawnSync("/usr/bin/xcrun", ["swiftc", root + "native/main.swift", "-o", root + "dist/companion-native", "-framework", "AppKit", "-framework", "Security"], { stdio: "inherit", shell: false });
process.exit(result.status ?? 1);
