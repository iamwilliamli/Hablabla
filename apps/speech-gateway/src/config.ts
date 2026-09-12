import { randomBytes, timingSafeEqual } from "node:crypto";

export type GatewayConfig = {
  host: string;
  port: number;
  publicBaseUrl: string;
  apiKeys: string[];
  allowedOrigins: Set<string>;
  workerExecutable: string;
  ffmpegExecutable: string;
  parakeetModelDirectory?: string;
  mossModelDirectory?: string;
  maximumUploadBytes: number;
  ticketLifetimeMs: number;
  resultLifetimeMs: number;
};

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function loadConfig(): GatewayConfig {
  const port = Number(process.env.HABLABLA_SPEECH_PORT ?? "8765");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("HABLABLA_SPEECH_PORT must be a valid TCP port");
  }
  const apiKeys = required("HABLABLA_SPEECH_API_KEYS")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const origins = required("HABLABLA_SPEECH_ALLOWED_ORIGINS")
    .split(",")
    .map((value) => new URL(value.trim()).origin);
  const publicBaseUrl = (process.env.HABLABLA_SPEECH_PUBLIC_URL ?? `http://127.0.0.1:${port}`)
    .replace(/\/$/, "");

  return {
    host: process.env.HABLABLA_SPEECH_HOST ?? "127.0.0.1",
    port,
    publicBaseUrl,
    apiKeys,
    allowedOrigins: new Set(origins),
    workerExecutable: required("HABLABLA_SPEECH_WORKER"),
    ffmpegExecutable: process.env.HABLABLA_FFMPEG ?? "ffmpeg",
    parakeetModelDirectory: process.env.HABLABLA_PARAKEET_MODEL_DIR?.trim() || undefined,
    mossModelDirectory: process.env.HABLABLA_MOSS_MODEL_DIR?.trim() || undefined,
    maximumUploadBytes: Number(process.env.HABLABLA_SPEECH_MAX_UPLOAD_BYTES ?? 200 * 1024 * 1024),
    ticketLifetimeMs: 60_000,
    resultLifetimeMs: 60 * 60_000,
  };
}

export function constantTimeIncludes(candidates: string[], supplied: string): boolean {
  const suppliedBuffer = Buffer.from(supplied);
  return candidates.some((candidate) => {
    const candidateBuffer = Buffer.from(candidate);
    return candidateBuffer.length === suppliedBuffer.length
      && timingSafeEqual(candidateBuffer, suppliedBuffer);
  });
}

export function bearerToken(header: string | undefined): string | null {
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  return token || null;
}

export function opaqueID(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("hex")}`;
}
