export function wavBlob(chunks) {
  const bytes = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const header = new ArrayBuffer(44), view = new DataView(header);
  const word = (offset, value) => [...value].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
  word(0, 'RIFF'); view.setUint32(4, 36 + bytes, true); word(8, 'WAVE'); word(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  word(36, 'data'); view.setUint32(40, bytes, true);
  return new Blob([header, ...chunks], { type: 'audio/wav' });
}

export class MicrophoneCapture {
  constructor({ onPacket, onLevel, onInterrupted }) {
    Object.assign(this, { onPacket, onLevel, onInterrupted, chunks: [], samples: 0, active: false, disposed: false });
  }
  async prepare() {
    if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) throw new Error('Open this local page in Chrome, Edge, or Safari with microphone and AudioWorklet support.');
    this.context = new AudioContext({ sampleRate: 16000 });
    await this.context.resume();
    if (this.context.sampleRate !== 16000) throw new Error('This browser did not provide 16 kHz audio. Try Chrome or Edge; no audio with an incorrect sample rate was sent.');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
    if (this.disposed) { stream.getTracks().forEach(track => track.stop()); return; }
    this.stream = stream;
    for (const track of stream.getTracks()) track.onended = () => { if (this.active) this.onInterrupted(); };
    await this.context.audioWorklet.addModule('/pcm-worklet.js');
    if (this.disposed) return;
    this.node = new AudioWorkletNode(this.context, 'hablabla-pcm16');
    this.source = this.context.createMediaStreamSource(stream);
    this.mute = this.context.createGain(); this.mute.gain.value = 0;
    this.node.connect(this.mute).connect(this.context.destination);
    this.node.port.onmessage = ({ data }) => {
      if (data?.type === 'flushed') { this.flushed?.(); return; }
      if (!(data instanceof ArrayBuffer)) return;
      this.chunks.push(data); this.samples += data.byteLength / 2;
      const samples = new Int16Array(data);
      let square = 0; for (const sample of samples) square += (sample / 32768) ** 2;
      this.onLevel(Math.sqrt(square / samples.length), this.samples / 16000);
      this.onPacket(data);
    };
    this.node.onprocessorerror = () => this.onInterrupted();
  }
  start() { if (!this.disposed) { this.active = true; this.source.connect(this.node); } }
  async stop() {
    this.active = false;
    this.source?.disconnect();
    this.stream?.getTracks().forEach(track => track.stop());
    try {
      if (this.node && this.context?.state === 'running') {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Audio flush timed out; the final audio frame was not confirmed.')), 3000);
          this.flushed = () => { clearTimeout(timer); resolve(); };
          this.node.port.postMessage({ type: 'flush' });
        });
      }
      return { blob: wavBlob(this.chunks), durationMs: this.samples / 16 };
    } finally { this.dispose(); }
  }
  dispose() {
    this.disposed = true; this.active = false;
    this.source?.disconnect(); this.node?.disconnect(); this.mute?.disconnect();
    this.stream?.getTracks().forEach(track => track.stop());
    if (this.context && this.context.state !== 'closed') void this.context.close();
  }
}
