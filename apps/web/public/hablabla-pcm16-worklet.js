class HablablaPCM16Processor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pending = new Int16Array(1600);
    this.count = 0;
    this.port.onmessage = ({ data }) => {
      if (data?.type !== "flush") return;
      this.emitPending();
      this.port.postMessage({ type: "flushed" });
    };
  }

  emitPending() {
    if (this.count === 0) return;
    const packet = this.count === this.pending.length ? this.pending : this.pending.slice(0, this.count);
    this.port.postMessage(packet.buffer, [packet.buffer]);
    this.pending = new Int16Array(1600);
    this.count = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (let index = 0; index < channel.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, channel[index]));
      this.pending[this.count] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      this.count += 1;
      if (this.count === this.pending.length) this.emitPending();
    }
    return true;
  }
}

registerProcessor("hablabla-pcm16", HablablaPCM16Processor);
