import { setTimeout as delay } from "node:timers/promises";
import { CommandEngine, type EnginePorts } from "./engine.js";
import { RelayClient, RelayError } from "./client.js";
import type { Config } from "./storage.js";

export async function runCompanion(options: {
  directory: string; config: Config; client: RelayClient; signal: AbortSignal;
  ports: Pick<EnginePorts, "approve" | "validate" | "open">;
  log(message: string): void;
}) {
  const { directory, config, client, signal, ports, log } = options;
  const engine = new CommandEngine(directory, config.deviceId, config.resources, {
    ...ports, authorize: c => client.authorize(c),
    report: async e => { await client.report(e); log(`${e.commandId.slice(0, 8)}: ${e.status} (${e.code})`); },
  });
  await engine.init();
  let backoff = 1000;
  while (!signal.aborted) {
    const connection = new AbortController();
    const sessionSignal = AbortSignal.any([signal, connection.signal]);
    let heartbeatTask: Promise<void> | undefined;
    let current: { id: string; controller: AbortController } | undefined;
    let heartbeatFailure: unknown;
    try {
      const sessionId = await client.connect(config.resources.map(({ id, label }) => ({ id, label })), signal);
      log(`Connected: ${JSON.stringify(config.name)}. Waiting for requests. Ctrl+C stops the companion.`);
      backoff = 1000;
      heartbeatTask = (async () => {
        while (!sessionSignal.aborted) {
          await delay(1000, undefined, { signal: sessionSignal });
          const response = await client.heartbeat(sessionId, sessionSignal);
          if (current && response.cancelled.includes(current.id)) current.controller.abort();
        }
      })().catch(error => { if (!sessionSignal.aborted) { heartbeatFailure = error; connection.abort(); } });
      while (!sessionSignal.aborted) {
        const command = await client.poll(sessionId, sessionSignal);
        if (!command) { await delay(500, undefined, { signal: sessionSignal }); continue; }
        current = { id: command.commandId, controller: new AbortController() };
        try { await engine.handle(command, sessionId, AbortSignal.any([sessionSignal, current.controller.signal])); }
        finally { current = undefined; }
      }
      if (heartbeatFailure) throw heartbeatFailure;
    } catch (caught) {
      const error = heartbeatFailure ?? caught;
      if (signal.aborted) break;
      if (error instanceof RelayError && (error.status === 401 || error.status === 403)) {
        throw new Error("Pairing was revoked or expired. Pair again before reconnecting.");
      }
      log("Connection interrupted. Pending local approval is cancelled; reconnecting with a new session.");
    } finally {
      connection.abort(); current?.controller.abort(); await heartbeatTask;
    }
    if (!signal.aborted) {
      await delay(backoff, undefined, { signal }).catch(() => {});
      backoff = Math.min(backoff * 2, 15000);
    }
  }
  log("Companion stopped. Completed actions are not undone.");
}
