export const STREAM_SAMPLE_RATE_HZ = 16_000;
export const STREAM_CHANNELS = 1;
export const STREAM_ENCODING = "pcm_s16le";
export const STREAM_HEADER_BYTES = 8;
export const MAXIMUM_STREAM_SAMPLES_PER_PACKET = STREAM_SAMPLE_RATE_HZ;

export type StreamPacket = {
  sequence: number;
  sampleCount: number;
  pcm: Buffer;
};

export function decodeStreamPacket(data: Buffer): StreamPacket {
  if (data.length < STREAM_HEADER_BYTES) {
    throw new Error("Audio packet is shorter than its 8-byte header");
  }
  const sequence = data.readUInt32LE(0);
  const sampleCount = data.readUInt32LE(4);
  if (sampleCount < 1 || sampleCount > MAXIMUM_STREAM_SAMPLES_PER_PACKET) {
    throw new Error("Audio packet sampleCount must be between 1 and 16000");
  }
  const pcm = data.subarray(STREAM_HEADER_BYTES);
  if (pcm.length !== sampleCount * 2) {
    throw new Error("Audio packet byte length does not match sampleCount for Int16 PCM");
  }
  return { sequence, sampleCount, pcm };
}

export function jsonLineObjects(
  state: { pending: string },
  chunk: Buffer,
): unknown[] {
  state.pending += chunk.toString("utf8");
  const lines = state.pending.split("\n");
  state.pending = lines.pop() ?? "";
  return lines
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}

export const acceptedOfflineAudioTypes = new Map<string, string>([
  ["audio/wav", ".wav"],
  ["audio/x-wav", ".wav"],
  ["audio/mpeg", ".mp3"],
  ["audio/mp4", ".m4a"],
  ["audio/x-m4a", ".m4a"],
  ["audio/webm", ".webm"],
  ["audio/ogg", ".ogg"],
]);
