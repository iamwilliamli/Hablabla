/** PCM from the live worklet: signed 16-bit little-endian, mono, 16 kHz. */
export function recordingFromPcm(chunks: readonly ArrayBuffer[], name = "meeting-recording.wav") {
  const byteLength = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  function tag(offset: number, value: string) {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  }
  tag(0, "RIFF"); view.setUint32(4, 36 + byteLength, true);
  tag(8, "WAVE"); tag(12, "fmt "); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  tag(36, "data"); view.setUint32(40, byteLength, true);
  return new File([header, ...chunks], name, { type: "audio/wav" });
}
