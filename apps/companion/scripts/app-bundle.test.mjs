import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, cp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, executableName, verifyBundle, bundleId } from "./app-bundle.mjs";

const mac = { skip: process.platform !== "darwin" };
function rpc(input, args = ["--stdio"]) {
  return spawnSync(join(buildApp, "Contents", "MacOS", executableName), args, {
    input: JSON.stringify(input), encoding: "utf8", timeout: 4000, shell: false,
  });
}
test("built background app has the expected identity and a valid signature", mac, () => {
  verifyBundle(buildApp);
  const result = rpc({ op: "identity" });
  assert.equal(result.status, 0);
  const identity = JSON.parse(result.stdout);
  assert.equal(identity.value, bundleId);
  assert.equal(identity.version, "0.1.0");
  assert.equal(identity.bundlePath, buildApp);
});
test("bundled RPC mode rejects unsupported actions and unexpected launch arguments", mac, () => {
  for (const input of [{ op: "shell", account: "not-a-uuid" }, { op: "capture_display" }, { op: "capture_window" }, { op: "request_screen_permission" }, { op: "request_accessibility_permission" }, { op: "open_resource", path: "/tmp/unregistered.txt" }]) {
    const result = rpc(input);
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stdout), { error: "native_operation_failed" });
  }
  assert.equal(rpc({}, ["--unexpected"]).status, 1);
});
test("bundle verification detects changed signed metadata", mac, async t => {
  const temporary = await mkdtemp(join(tmpdir(), "hablabla-bundle-check-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const copy = join(temporary, "Hablabla Companion.app");
  await cp(buildApp, copy, { recursive: true });
  const plist = join(copy, "Contents", "Info.plist");
  const contents = await readFile(plist, "utf8");
  await writeFile(plist, contents.replace("<string>0.1.0</string>", "<string>9.9.9</string>"));
  assert.throws(() => verifyBundle(copy), /codesign/);
});
