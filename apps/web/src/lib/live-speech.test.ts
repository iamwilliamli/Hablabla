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

test("Finish retains every PCM sample before final text, and the WAV survives a finalization failure", async () => {
  const original = Object.getOwnPropertyDescriptors(globalThis);
  const keys = ["window", "navigator", "location", "AudioContext", "AudioWorkletNode", "WebSocket", "fetch"];
  let stopped = false;
  let worklet: FakeWorklet;
  let socket: FakeSocket;
  class FakeSocket {
    static OPEN = 1; static CLOSING = 2;
    readyState = 1; bufferedAmount = 0;
    listeners = new Map<string, Array<(event: {data?: string}) => void>>();
    sent: Array<string | ArrayBuffer> = [];
    constructor() { socket = this; }
    addEventListener(name: string, fn: (event: {data?: string}) => void) {
      this.listeners.set(name, [...this.listeners.get(name) ?? [], fn]);
    }
    emit(name: string, value?: object) { this.listeners.get(name)?.forEach(fn => fn({data: JSON.stringify(value)})); }
    send(value: string | ArrayBuffer) { this.sent.push(value); }
    close() { this.readyState = 3; }
  }
  class FakeWorklet {
    port = {
      onmessage: (_event: {data: unknown}) => {},
      postMessage: () => {
        // The worklet flushes its final incomplete packet before acknowledging Finish.
        this.port.onmessage({data: new Int16Array([4, -5]).buffer});
        this.port.onmessage({data: {type: "flushed"}});
      },
    };
    constructor() { worklet = this; }
    connect() {} disconnect() {}
  }
  const replacements = {
    window: {isSecureContext: true}, location: {protocol: "http:"},
    navigator: {mediaDevices: {getUserMedia: async () => ({getTracks: () => [{stop: () => { stopped = true; }}]})}},
    AudioContext: class {
      sampleRate = 16000; state = "running"; destination = {};
      audioWorklet = {addModule: async () => {}};
      async resume() {} async close() {}
      createMediaStreamSource() { return {connect() {}, disconnect() {}}; }
    },
    AudioWorkletNode: FakeWorklet, WebSocket: FakeSocket,
    fetch: async () => Response.json({websocketUrl: "ws://localhost/stream"}),
  };
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, {configurable: true, value});
  try {
    for (const complete of [true, false]) {
      const recordings: File[] = [];
      const states: string[] = [];
      const session = createLiveSpeech({model: "nemotron", language: "en", hotwords: [],
        onState: state => states.push(state), onText() {}, onRecording: file => recordings.push(file)});
      try {
        await session.start();
        socket!.emit("open"); socket!.emit("message", {type: "ready"});
        await Promise.resolve(); await Promise.resolve();
        worklet!.port.onmessage({data: new Int16Array([1, -2, 3]).buffer});
        session.finish();
        assert.equal(stopped, true);
        assert.equal(recordings.length, 1, "WAV is retained without waiting for final text");
        const audio = await recordings[0].arrayBuffer();
        assert.equal(recordings[0].type, "audio/wav");
        assert.equal(audio.byteLength, 54);
        assert.equal(new TextDecoder().decode(audio.slice(0, 4)), "RIFF");
        assert.equal(new DataView(audio).getUint32(24, true), 16000);
        assert.equal(new DataView(audio).getUint32(40, true), 10);
        assert.deepEqual([...new Int16Array(audio.slice(44))], [1, -2, 3, 4, -5]);
        assert.equal(socket!.sent.at(-1), JSON.stringify({type: "finish"}));
        if (complete) socket!.emit("message", {type: "transcript", revision: 1, confirmedText: "Test", isFinal: true});
        else socket!.emit("close");
        assert.equal(states.at(-1), complete ? "completed" : "error");
        assert.deepEqual(await recordings[0].arrayBuffer(), audio, "Cleanup retains the captured WAV");
      } finally { session.dispose(); }
    }
  } finally {
    for (const key of keys) {
      if (original[key]) Object.defineProperty(globalThis, key, original[key]);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
