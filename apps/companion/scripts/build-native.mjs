import { copyFile, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { root, bundleName, buildApp, executableName, requireMac, run, verifyBundle } from "./app-bundle.mjs";

requireMac();
const dist = join(root, "dist");
await mkdir(dist, { recursive: true });
const staging = await mkdtemp(join(dist, ".bundle-build-"));
try {
  const app = join(staging, bundleName);
  const contents = join(app, "Contents");
  await mkdir(join(contents, "MacOS"), { recursive: true });
  await mkdir(join(contents, "Resources"));
  await copyFile(join(root, "native", "Info.plist"), join(contents, "Info.plist"));
  run("/usr/bin/plutil", ["-lint", join(contents, "Info.plist")]);
  const arch = process.arch === "arm64" ? "arm64" : "x86_64";
  run("/usr/bin/xcrun", ["swiftc", join(root, "native", "main.swift"), join(root, "native", "PermissionsWindow.swift"), join(root, "native", "CaptureWindow.swift"), join(root, "native", "DashboardWindow.swift"), "-O", "-target", `${arch}-apple-macos13.0`,
    "-o", join(contents, "MacOS", executableName), "-framework", "AppKit", "-framework", "Security",
    "-framework", "ApplicationServices", "-framework", "CoreGraphics", "-framework", "ScreenCaptureKit"]);
  // An explicit identity is never silently downgraded to ad-hoc signing.
  const identity = process.env.HABLABLA_SIGNING_IDENTITY?.trim() || "-";
  run("/usr/bin/codesign", ["--force", "--sign", identity, "--options", "runtime", "--timestamp=none", app]);
  verifyBundle(app);
  // Replace only our generated output after compilation/signature verification succeeds.
  await rm(buildApp, { recursive: true, force: true });
  await rename(app, buildApp);
  console.log(`Built ${buildApp}`);
  console.log(identity === "-"
    ? "Signing: ad-hoc development build. Permission grants may need renewal after rebuilding."
    : "Signing: configured certificate. Keep the same signing identity across updates.");
  console.log("Install with npm run companion:install. This build is not notarized for distribution.");
} finally { await rm(staging, { recursive: true, force: true }); }
