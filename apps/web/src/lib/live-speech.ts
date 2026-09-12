import { recordingFromPcm } from "./recording-audio";

export type LiveSpeechState = "loading" | "listening" | "finishing" | "completed" | "cancelled" | "error";
export type LiveSpeechOptions = {
  model: "nemotron" | "parakeet";
  language: string;
  hotwords: string[];
  onState: (state: LiveSpeechState, message: string) => void;
  onText: (text: string, final: boolean) => void;
  onRecording?: (recording: File) => void;
};

export function parseLiveHotwords(input: string) {
  const words = [...new Set(input.split(/[,，\n]/).map(word => word.trim()).filter(Boolean))];
  if (words.length > 64 || words.some(word => word.length > 80)) {
    throw new Error("Use up to 64 hotwords, with no more than 80 characters per term.");
  }
  return words;
}

/** A single recording owns its microphone, transport, timers, and cancellation. */
export function createLiveSpeech(options: LiveSpeechOptions) {
  let context: AudioContext | undefined;
  let media: MediaStream | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let worklet: AudioWorkletNode | undefined;
  let socket: WebSocket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active = true;
  let ready = false;
  let finishing = false;
  let revision = -1;
  let sequence = 0;
  const chunks: ArrayBuffer[] = [];
  let recordingSaved = false;
  const abort = new AbortController();

  function cleanup() {
    active = false;
    clearTimeout(timer);
    abort.abort();
    chunks.length = 0;
    media?.getTracks().forEach(track => track.stop());
    source?.disconnect();
    worklet?.disconnect();
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
    if (context && context.state !== "closed") void context.close().catch(() => {});
  }
  function fail(message: string) {
    if (!active) return;
    cleanup();
    options.onState("error", message);
  }
  function cancel() {
    if (!active) return;
    cleanup();
    options.onState("cancelled", "Recording cancelled. Any partial text remains available for review.");
  }
  function finish() {
    if (!active || !ready || finishing) return;
    finishing = true;
    media?.getTracks().forEach(track => track.stop());
    source?.disconnect();
    worklet?.port.postMessage({ type: "flush" });
    options.onState("finishing", "Finishing your transcript…");
    clearTimeout(timer);
    timer = setTimeout(() => fail("No final transcript arrived. The partial text is still available for review."), 60_000);
  }
  async function start() {
    options.onState("loading", "Preparing live transcription…");
    timer = setTimeout(() => fail("The speech model took too long to become ready. Try again."), 180_000);
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        throw new Error("Microphone access requires HTTPS or localhost. Open this app using a secure address.");
      }
      context = new AudioContext({ sampleRate: 16000 });
      if (context.sampleRate !== 16000) throw new Error("This browser could not open 16 kHz audio. Try Chrome or Edge.");
      await context.resume();
      if (!active) return;
      await context.audioWorklet.addModule("/hablabla-pcm16-worklet.js");
      if (!active) return;
      const response = await fetch(`/api/speech/${options.model}-session`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ language: options.language, hotwords: options.hotwords }), signal: abort.signal,
      });
      const body = await response.json();
      if (!active) return;
      if (!response.ok) throw new Error(body.error?.message || "Could not create a live transcription session.");
      const url = new URL(body.websocketUrl);
      if (location.protocol === "https:" && url.protocol !== "wss:") {
        throw new Error("This HTTPS app needs a secure speech connection. Configure the gateway with a WSS address.");
      }
      socket = new WebSocket(url);
      socket.addEventListener("open", () => { if (active) socket?.send(JSON.stringify({ type: "start" })); });
      socket.addEventListener("message", ({ data }) => {
        if (!active) return;
        try {
          const event = JSON.parse(String(data));
          if (event.type === "ready" && !ready) {
            ready = true;
            void capture();
          } else if (event.type === "progress" && !ready) {
            options.onState("loading", "Loading the speech model on the connected computer…");
          } else if (event.type === "transcript" && Number.isInteger(event.revision) && event.revision > revision) {
            revision = event.revision;
            const text = `${event.confirmedText || ""}${event.volatileText || ""}`.trim();
            options.onText(text, event.isFinal === true);
            if (event.isFinal) {
              cleanup();
              options.onState("completed", text ? "Transcript ready. Review the words before adding the visit." : "No speech was detected. Try another recording.");
            }
          } else if (event.type === "error") fail(event.error?.message || "Live transcription failed.");
        } catch { fail("The speech service returned an unreadable response."); }
      });
      socket.addEventListener("error", () => fail("Could not connect to live transcription."));
      socket.addEventListener("close", () => fail("The connection ended before a final transcript arrived. Partial text is available for review."));
    } catch (error) { fail(error instanceof Error ? error.message : "Could not start live transcription."); }
  }
  async function capture() {
    try {
      options.onState("loading", "Allow microphone access to start recording…");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (!active) { stream.getTracks().forEach(track => track.stop()); return; }
      media = stream;
      source = context!.createMediaStreamSource(stream);
      worklet = new AudioWorkletNode(context!, "hablabla-pcm16");
      worklet.port.onmessage = ({ data }) => {
        if (!active) return;
        if (data?.type === "flushed") {
          if (finishing && !recordingSaved) {
            recordingSaved = true;
            if (chunks.length) options.onRecording?.(recordingFromPcm(chunks));
            chunks.length = 0;
            if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "finish" }));
          }
          return;
        }
        if (!(data instanceof ArrayBuffer) || recordingSaved) return;
        chunks.push(data);
        if (socket?.readyState !== WebSocket.OPEN) return;
        if (socket.bufferedAmount > 1024 * 1024) { fail("The speech connection is too slow. Please try again."); return; }
        const packet = new ArrayBuffer(8 + data.byteLength);
        const view = new DataView(packet);
        view.setUint32(0, sequence++, true);
        view.setUint32(4, data.byteLength / 2, true);
        new Uint8Array(packet, 8).set(new Uint8Array(data));
        socket.send(packet);
      };
      source.connect(worklet);
      // The processor emits silence, keeping the graph active without microphone feedback.
      worklet.connect(context!.destination);
      clearTimeout(timer);
      timer = setTimeout(finish, 10 * 60_000);
      options.onState("listening", "Listening. Partial words may change as you speak.");
    } catch (error) { fail(error instanceof Error ? error.message : "Could not access the microphone."); }
  }
  return { start, finish, cancel, dispose: cleanup };
}
