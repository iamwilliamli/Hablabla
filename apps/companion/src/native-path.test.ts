import test from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { companionAppPath } from "./native.js";

test("CLI uses a stable installed app path and accepts only explicit absolute bundle overrides", () => {
  const previous = process.env.HABLABLA_COMPANION_APP;
  try {
    delete process.env.HABLABLA_COMPANION_APP;
    assert.equal(companionAppPath(), join(homedir(), "Applications", "Hablabla Companion.app"));
    process.env.HABLABLA_COMPANION_APP = "/tmp/development/Hablabla Companion.app";
    assert.equal(companionAppPath(), "/tmp/development/Hablabla Companion.app");
    for (const invalid of ["", "./Hablabla Companion.app", "/tmp/companion-native"]) {
      process.env.HABLABLA_COMPANION_APP = invalid;
      assert.throws(() => companionAppPath(), /absolute .app/);
    }
  } finally {
    if (previous === undefined) delete process.env.HABLABLA_COMPANION_APP;
    else process.env.HABLABLA_COMPANION_APP = previous;
  }
});
