import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, mkdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createDemoServer, isPrivatePeer } from "./demo-http.js";
import { networkInterfaces } from "node:os";
import { demoCertificate } from "./demo-tls.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const lan = process.env.HABLABLA_DEMO_LAN === "1";
const port = Number(process.env.HABLABLA_DEMO_PORT ?? (lan ? 18767 : 18766));
const gatewayPort = Number(process.env.HABLABLA_DEMO_GATEWAY_PORT ?? (lan ? 18768 : 18765));
if (![port, gatewayPort].every(p => Number.isInteger(p) && p > 1024 && p < 65536) || port === gatewayPort) {
  throw new Error("Use two different unprivileged TCP ports for the demo.");
}
const addresses = ["127.0.0.1", ...Object.values(networkInterfaces()).flatMap(items => (items ?? []).filter(item => item.family === "IPv4" && !item.internal && isPrivatePeer(item.address)).map(item => item.address))];
let hostname = "localhost";
if (lan) { try { hostname = execFileSync("scutil",["--get","LocalHostName"],{encoding:"utf8"}).trim() + ".local"; } catch {} }
const origin = `${lan ? "https" : "http"}://127.0.0.1:${port}`;
const additionalOrigins = lan ? [...addresses.filter(ip => ip !== "127.0.0.1"),hostname].map(host => `https://${host}:${port}`) : [];
const tls = lan ? await demoCertificate(resolve(root,".data/speech-demo/tls"), addresses, hostname) : undefined;
const upstream = `http://127.0.0.1:${gatewayPort}`;
const apiKey = randomBytes(32).toString("hex");
const worker = process.env.HABLABLA_SPEECH_WORKER || resolve(root, "apps/macos-model-worker/.xcode-derived/Build/Products/Release/hablabla-model-worker");
try { await access(worker, constants.X_OK); }
catch { console.warn("Native worker is missing. Build it with apps/macos-model-worker/scripts/build-release.sh before transcribing."); }
const temporaryDirectory = resolve(root, ".data/speech-demo/tmp");
await mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
let nemotronDirectory = process.env.HABLABLA_NEMOTRON_MODEL_DIR;
if (!nemotronDirectory) {
  const installed = resolve(root, ".data/models/nemotron-3.5-multilingual/2240ms");
  try {
    const metadata = JSON.parse(await readFile(resolve(installed, "metadata.json"), "utf8"));
    await access(resolve(installed, "hablabla-provenance.json"));
    if (metadata.model === "nvidia/nemotron-3.5-asr-streaming-0.6b" && metadata.vocab_size === 13087 && metadata.chunk_mel_frames === 224) nemotronDirectory = installed;
  } catch {}
}
const gateway = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./server.ts", import.meta.url))], {
  cwd: fileURLToPath(new URL("../", import.meta.url)),
  detached: true,
  stdio: ["ignore", "inherit", "inherit"],
  env: { ...process.env, TMPDIR: temporaryDirectory, HABLABLA_SPEECH_HOST: "127.0.0.1",
    HABLABLA_SPEECH_PORT: String(gatewayPort), HABLABLA_SPEECH_PUBLIC_URL: upstream,
    HABLABLA_SPEECH_API_KEYS: apiKey, HABLABLA_SPEECH_ALLOWED_ORIGINS: [origin,...additionalOrigins].join(","),
    HABLABLA_NEMOTRON_MODEL_DIR: nemotronDirectory,
    HABLABLA_SPEECH_WORKER: worker },
});
const server = createDemoServer({ upstream, apiKey, origin, additionalOrigins, tls, lan });
let closing = false;
function stop(code: number) {
  if (closing) return;
  closing = true;
  if (gateway.pid) { try { process.kill(-gateway.pid, "SIGTERM"); } catch {} }
  server.close();
  setTimeout(() => process.exit(code), 300).unref();
}
gateway.on("error", () => { console.error("Could not start the test gateway."); stop(1); });
gateway.on("exit", code => { if (!closing) { console.error("The test gateway stopped."); stop(code || 1); } });
server.on("error", error => { console.error(error.message); stop(1); });
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
server.listen(port, lan ? "0.0.0.0" : "127.0.0.1", () => console.log(`Speech test console: ${origin}\n${additionalOrigins.join("\n")}\n${lan ? "LAN HTTPS uses a self-signed certificate. Trust it on each test device before allowing microphone access.\n" : ""}Microphone access starts only when you press Record. Ctrl+C stops the console and its workers.`));
