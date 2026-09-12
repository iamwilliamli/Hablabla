import assert from "node:assert/strict";
import test from "node:test";
import { bearerToken, constantTimeIncludes } from "./config.js";
import { decodeStreamPacket, jsonLineObjects, parseNemotronHotwords } from "./protocol.js";

test("Nemotron hotwords are optional, trimmed and deduplicated", () => {
  assert.deepEqual(parseNemotronHotwords(undefined), []);
  assert.deepEqual(parseNemotronHotwords([" metformin ", "HbA1c", "metformin"]), ["metformin", "HbA1c"]);
});

test("Nemotron rejects malformed or oversized hotword lists", () => {
  for (const value of [null, "metformin", [42], [" "], ["a".repeat(81)], Array(65).fill("metformin")]) {
    assert.throws(() => parseNemotronHotwords(value), /hotwords/);
  }
});

test("decodes a framed PCM packet", () => {
  const data = Buffer.alloc(12);
  data.writeUInt32LE(42, 0);
  data.writeUInt32LE(2, 4);
  data.writeInt16LE(-100, 8);
  data.writeInt16LE(100, 10);
  const packet = decodeStreamPacket(data);
  assert.equal(packet.sequence, 42);
  assert.equal(packet.sampleCount, 2);
  assert.deepEqual([...packet.pcm], [...data.subarray(8)]);
});

test("rejects a packet whose declared sample count is wrong", () => {
  const data = Buffer.alloc(10);
  data.writeUInt32LE(0, 0);
  data.writeUInt32LE(2, 4);
  assert.throws(() => decodeStreamPacket(data), /does not match/);
});

test("parses JSON lines across stdout chunks", () => {
  const state = { pending: "" };
  assert.deepEqual(jsonLineObjects(state, Buffer.from('{"a":1}\n{"b"')), [{ a: 1 }]);
  assert.deepEqual(jsonLineObjects(state, Buffer.from(':2}\n')), [{ b: 2 }]);
});

test("auth helpers reject malformed credentials", () => {
  assert.equal(bearerToken("Bearer secret"), "secret");
  assert.equal(bearerToken("Basic secret"), null);
  assert.equal(constantTimeIncludes(["one", "two"], "two"), true);
  assert.equal(constantTimeIncludes(["one", "two"], "three"), false);
});
