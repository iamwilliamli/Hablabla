import { parseArgs } from "node:util";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { acquireLock, configSchema, getConfig, readJSON, unlock, writePrivate, type Config } from "./storage.js";
import { fingerprint, keychain, openResource, validateResource, appIdentity, launchCompanionApp } from "./native.js";
import { RelayClient } from "./client.js";
import { pairingResponse, resourceId } from "./protocol.js";
import { runCompanion } from "./runner.js";

const parsed = parseArgs({ allowPositionals: true, options: {
  "state-dir": { type: "string" }, relay: { type: "string" }, name: { type: "string" },
} });
const invocationDirectory = process.env.INIT_CWD ?? process.cwd();
const directory = resolve(invocationDirectory, parsed.values["state-dir"] ?? join(homedir(), "Library", "Application Support", "Hablabla Companion"));
const [command, ...args] = parsed.positionals;
const help = `Hablabla Mac companion (Terminal prototype)
  npm run companion:build
  npm run companion:install
  npm run companion -- app
  npm run companion -- app-info
  npm run companion -- register <resource-id> <file> [--name "Presentation"]
  npm run companion -- list
  npm run companion -- remove <resource-id>
  npm run companion -- pair --relay http://127.0.0.1:3210
  npm run companion -- start
  npm run companion -- unpair
  npm run companion -- unlock
Use --state-dir <private-directory> for an isolated demo. No auto-approval option.
Register accepts PDF, PPT/PPTX, KEY and TXT files. Only resource IDs/labels leave this Mac.`;
async function prompt(question: string, signal?: AbortSignal) {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error("Local approval requires an interactive Terminal.");
  const terminal = createInterface({ input: stdin, output: stdout });
  const cancelled = new AbortController();
  terminal.once("SIGINT", () => {
    cancelled.abort();
    if (process.listenerCount("SIGINT") > 0) process.emit("SIGINT");
  });
  terminal.once("close", () => cancelled.abort());
  try { return (await terminal.question(question, { signal: AbortSignal.any([cancelled.signal, ...(signal ? [signal] : [])]) })).trim(); }
  finally { terminal.close(); }
}
async function main() {
  if (!command || command === "help") { console.log(help); return; }
  if (command === "app") {
    await launchCompanionApp();
    console.log("Background helper launched. Open Local Dashboard for approved snapshots. Document-opening approvals still use the Terminal runner."); return;
  }
  if (command === "app-info") { console.log(JSON.stringify(await appIdentity(), null, 2)); return; }
  if (command === "unlock") { await unlock(directory); console.log("Stale lock removed."); return; }
  const release = await acquireLock(directory);
  try {
    if (command === "register") {
      const [rawId, file] = args;
      const rid = resourceId.parse(rawId);
      if (!file) throw new Error("Supply a local file path.");
      const config: Config = configSchema.parse(await readJSON(join(directory, "config.json")) ?? {
        version: 1, deviceId: randomUUID(), name: hostname().slice(0, 100), resources: [],
      });
      const entry = { id: rid, label: parsed.values.name ?? rid, ...await fingerprint(resolve(invocationDirectory, file)) };
      config.resources = [...config.resources.filter(r => r.id !== rid), entry];
      await writePrivate(join(directory, "config.json"), configSchema.parse(config));
      console.log(`Registered ${JSON.stringify(rid)} → ${JSON.stringify(entry.path)}. File contents remain local.`);
      return;
    }
    const config = await getConfig(directory);
    if (command === "list") {
      console.log(`Device: ${JSON.stringify(config.name)} (${config.deviceId})\nRelay: ${config.relay ?? "not paired"}`);
      for (const resource of config.resources) console.log(`${JSON.stringify(resource.id)}: ${JSON.stringify(resource.label)} → ${JSON.stringify(resource.path)}`);
    } else if (command === "remove") {
      config.resources = config.resources.filter(r => r.id !== resourceId.parse(args[0]));
      await writePrivate(join(directory, "config.json"), config);
      console.log("Resource removed. Restart the companion to advertise the updated list.");
    } else if (command === "pair") {
      if (config.keychainAccount) throw new Error("Unpair the existing device first.");
      const client = new RelayClient(parsed.values.relay ?? "http://127.0.0.1:3210");
      console.log(`Pair ${JSON.stringify(config.name)} with ${client.origin}. Share resource IDs/labels only.`);
      const code = await prompt("Paste the one-time pairing code from your relay: ");
      if (!/^[a-f0-9]{32}$/.test(code)) throw new Error("Invalid pairing code.");
      if (await prompt('Confirm this relay and device by typing "pair": ') !== "pair") { console.log("Pairing cancelled."); return; }
      const result = pairingResponse.parse(await client.request("/v1/pairings/complete", {
        code, deviceId: config.deviceId, name: config.name, capabilities: ["open_resource"],
        resources: config.resources.map(({ id, label }) => ({ id, label })),
      }));
      if (result.deviceId !== config.deviceId) throw new Error("Relay returned a different device identity.");
      const account = randomUUID();
      try {
        await keychain.set(account, result.deviceToken);
        await writePrivate(join(directory, "config.json"), { ...config, relay: client.origin, keychainAccount: account });
      } catch (error) {
        await new RelayClient(client.origin, result.deviceToken).request("/v1/companion/revoke").catch(() => {});
        await keychain.delete(account).catch(() => {});
        throw error;
      }
      console.log("Paired. Device credential is in macOS Keychain. Run start next.");
    } else if (command === "unpair") {
      if (config.relay && config.keychainAccount) {
        try {
          const client = new RelayClient(config.relay, await keychain.get(config.keychainAccount));
          await client.request("/v1/companion/revoke");
        }
        catch { console.log("Relay revocation could not be confirmed. Revoke this device at the relay too."); }
        await keychain.delete(config.keychainAccount);
      }
      delete config.relay; delete config.keychainAccount;
      await writePrivate(join(directory, "config.json"), config);
      console.log("Local pairing removed.");
    } else if (command === "start") {
      if (!config.relay || !config.keychainAccount) throw new Error("Pair this companion first.");
      if (!stdin.isTTY || !stdout.isTTY) throw new Error("Start in an interactive Terminal so each action can be approved locally.");
      const stop = new AbortController();
      const stopNow = () => stop.abort();
      process.on("SIGINT", stopNow); process.on("SIGTERM", stopNow);
      try {
        await runCompanion({ directory, config,
          client: new RelayClient(config.relay, await keychain.get(config.keychainAccount)), signal: stop.signal,
          log: message => console.log(message), ports: {
            validate: validateResource, open: openResource,
            approve: async (resource, request, signal) => {
              console.log(`\nRequest ${request.commandId}\nOpen ${JSON.stringify(resource.label)}\nLocal file: ${JSON.stringify(resource.path)}\nExpires: ${request.expiresAt}`);
              return await prompt('Type "approve" to open this file, or Enter to deny: ', signal) === "approve";
            },
          },
        });
      } finally { process.off("SIGINT", stopNow); process.off("SIGTERM", stopNow); }
    } else throw new Error(help);
  } finally { await release(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Companion failed."); process.exitCode = 1; });
