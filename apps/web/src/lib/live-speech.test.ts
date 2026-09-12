import assert from "node:assert/strict";
import test from "node:test";
import { createLiveSpeech, parseLiveHotwords } from "./live-speech";

test("hotwords preserve multilingual terms and reject oversized requests", () => {
  assert.deepEqual(parseLiveHotwords("allergy, 阿莫西林，allergy\n250 milligrams"), ["allergy", "阿莫西林", "250 milligrams"]);
  assert.throws(() => parseLiveHotwords("x".repeat(81)));
  assert.throws(() => parseLiveHotwords(Array.from({length: 65}, (_, i) => String(i)).join(",")));
});

test("cancelling while audio initialization waits prevents a late session request", async () => {
  const original = Object.getOwnPropertyDescriptors(globalThis);
  let resume!: () => void;
  let closed = 0;
  let fetched = false;
  const states: string[] = [];
  Object.defineProperty(globalThis, "window", { configurable: true, value: { isSecureContext: true } });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: { getUserMedia() {} } } });
  Object.defineProperty(globalThis, "AudioContext", { configurable: true, value: class {
    sampleRate = 16000; state = "running";
    resume() { return new Promise<void>(resolve => { resume = resolve; }); }
    async close() { closed++; }
  } });
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async () => { fetched = true; return Response.json({}); } });
  try {
    const session = createLiveSpeech({ model: "nemotron", language: "zh", hotwords: [], onState: state => states.push(state), onText() {} });
    const starting = session.start();
    session.cancel(); resume(); await starting;
    assert.deepEqual(states, ["loading", "cancelled"]);
    assert.equal(fetched, false); assert.equal(closed, 1);
  } finally {
    for (const key of ["window", "navigator", "AudioContext", "fetch"]) {
      if (original[key]) Object.defineProperty(globalThis, key, original[key]);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
