import test, { type TestContext } from "node:test";
import { request as httpRequest } from "node:http";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { CommandEngine, type EnginePorts } from "./engine.js";
import { type Command, type CommandEvent, commandSchema, relayOrigin } from "./protocol.js";
import { writePrivate, type Resource, acquireLock, unlock } from "./storage.js";
import { fingerprint, validateResource } from "./native.js";
import { DemoRelay } from "./demo-relay.js";
import { RelayClient, RelayError } from "./client.js";
import { runCompanion } from "./runner.js";

const deviceId = randomUUID(), sessionId = randomUUID();
const resource: Resource = { id: "presentation:demo", label: "Demo", path: "/demo.txt", sha256: "a".repeat(64) };
function command(now = Date.now()): Command {
  return { protocolVersion: 1, type: "command.request", commandId: randomUUID(), intentId: randomUUID(), deviceId, sessionId,
    issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60000).toISOString(), action: { kind: "open_resource", resourceId: resource.id } };
}
async function fixture(t: TestContext, overrides: Partial<EnginePorts> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "hablabla-companion-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let opened = 0, approvals = 0;
  const events: CommandEvent[] = [];
  const ports: EnginePorts = {
    approve: async () => { approvals++; return true; }, validate: async () => {},
    open: async () => { opened++; }, authorize: async () => true,
    report: async e => { events.push(e); }, ...overrides,
  };
  const engine = new CommandEngine(directory, deviceId, [resource], ports); await engine.init();
  return { directory, engine, ports, events, opened: () => opened, approvals: () => approvals };
}
const signal = () => new AbortController().signal;

test("approved command opens once; exact redelivery returns the recorded result", async t => {
  const f = await fixture(t); const c = command();
  const result = await f.engine.handle(c, sessionId, signal());
  assert.equal(result.status, "succeeded"); assert.equal(result.code, "open_dispatched");
  assert.deepEqual(f.events.map(e => e.status), ["received", "awaiting_approval", "running", "succeeded"]);
  assert.deepEqual(await f.engine.handle(c, sessionId, signal()), result);
  assert.equal(f.opened(), 1); assert.equal(f.approvals(), 1);
  const restart = new CommandEngine(f.directory, deviceId, [resource], f.ports); await restart.init();
  await restart.handle(c, sessionId, signal()); assert.equal(f.opened(), 1);
  await assert.rejects(() => restart.handle({ ...c, action: { ...c.action, resourceId: "different" } }, sessionId, signal()), /reused/);
});
test("denial creates no OS action", async t => {
  const f = await fixture(t, { approve: async () => false });
  assert.equal((await f.engine.handle(command(), sessionId, signal())).status, "denied"); assert.equal(f.opened(), 0);
});
test("wrong device/session, unknown action, and extra approval fields fail closed", async t => {
  const f = await fixture(t);
  for (const c of [{ ...command(), deviceId: randomUUID() }, { ...command(), sessionId: randomUUID() },
    { ...command(), approved: true }, { ...command(), action: { kind: "shell", command: "open /tmp/file" } }]) {
    await assert.rejects(() => f.engine.handle(c, sessionId, signal()));
  }
  assert.equal(f.opened(), 0); assert.equal(f.approvals(), 0);
});
test("expired and overlong validity windows do not prompt", async t => {
  const f = await fixture(t);
  for (const c of [command(Date.now() - 120000), { ...command(), expiresAt: new Date(Date.now() + 900000).toISOString() }]) {
    assert.equal((await f.engine.handle(c, sessionId, signal())).status, "expired");
  }
  assert.equal(f.approvals(), 0);
});
test("cancellation while prompting and remote revocation after approval cannot execute", async t => {
  const stop = new AbortController();
  const f = await fixture(t, { approve: async () => { stop.abort(); return true; } });
  assert.equal((await f.engine.handle(command(), sessionId, stop.signal)).status, "cancelled"); assert.equal(f.opened(), 0);
  const g = await fixture(t, { authorize: async () => false });
  assert.equal((await g.engine.handle(command(), sessionId, signal())).status, "cancelled"); assert.equal(g.opened(), 0);
});
test("connection loss after approval and changed file fail closed", async t => {
  const f = await fixture(t, { authorize: async () => { throw new Error("offline"); } });
  assert.equal((await f.engine.handle(command(), sessionId, signal())).code, "connection_lost_before_execution");
  let checks = 0;
  const g = await fixture(t, { validate: async () => { if (++checks === 2) throw new Error("changed"); } });
  assert.equal((await g.engine.handle(command(), sessionId, signal())).code, "resource_changed_or_missing");
  assert.equal(f.opened() + g.opened(), 0);
  const h = await fixture(t, { open: async () => { throw new Error("native timeout"); } });
  assert.equal((await h.engine.handle(command(), sessionId, signal())).status, "unknown");
});
test("lost result reply retries durable result without opening again", async t => {
  let failOnce = true;
  const f = await fixture(t, { report: async e => { if (e.status === "succeeded" && failOnce) { failOnce = false; throw new Error("lost reply"); } } });
  const c = command();
  await assert.rejects(() => f.engine.handle(c, sessionId, signal()));
  assert.equal((await f.engine.handle(c, sessionId, signal())).status, "succeeded"); assert.equal(f.opened(), 1);
});
test("crash after durable claim yields unknown, never a blind retry", async t => {
  const f = await fixture(t), c = command();
  const canonical = commandSchema.parse(c);
  await writePrivate(join(f.directory, "journal.json"), { [c.commandId]: {
    digest: createHash("sha256").update(JSON.stringify(canonical)).digest("hex"), expiresAt: c.expiresAt, claimed: true,
  } });
  const restarted = new CommandEngine(f.directory, deviceId, [resource], f.ports); await restarted.init();
  assert.equal((await restarted.handle(c, sessionId, signal())).status, "unknown"); assert.equal(f.opened(), 0);
});
test("registered files are content-pinned and executable/script extensions are rejected", async t => {
  const f = await fixture(t); const path = join(f.directory, "slides.txt");
  await writeFile(path, "original"); const r = { ...resource, ...await fingerprint(path) };
  await validateResource(r); await writeFile(path, "changed"); await assert.rejects(() => validateResource(r), /changed/);
  const script = join(f.directory, "run.sh"); await writeFile(script, "exit 0");
  await assert.rejects(() => fingerprint(script), /regular/);
});
test("state lock excludes concurrent processes; active lock cannot be cleared", async t => {
  const f = await fixture(t); await chmod(f.directory, 0o700);
  const release = await acquireLock(f.directory);
  await assert.rejects(() => acquireLock(f.directory), /locked/);
  await assert.rejects(() => unlock(f.directory), /still running/); await release();
});
test("remote transport requires HTTPS; credentials/redirect-friendly origins are rejected", () => {
  assert.equal(relayOrigin("http://127.0.0.1:3210"), "http://127.0.0.1:3210");
  assert.equal(relayOrigin("https://relay.example"), "https://relay.example");
  for (const value of ["http://relay.example", "http://localhost:3210", "https://user:pass@relay.example", "https://relay.example/path", "https://relay.example/?secret=1"]) assert.throws(() => relayOrigin(value));
});
async function pair(relay: DemoRelay, origin: string, owner: string) {
  const id = randomUUID();
  const result = await new RelayClient(origin).request("/v1/pairings/complete", {
    code: relay.pairing(owner), deviceId: id, name: "Test Mac", capabilities: ["open_resource"], resources: [{ id: resource.id, label: resource.label }],
  }) as { deviceToken: string };
  return { id, token: result.deviceToken, client: new RelayClient(origin, result.deviceToken) };
}
test("relay pairing is single-use, owner/device scoped, and revocable", async t => {
  const relay = new DemoRelay(); const origin = await relay.listen(0); t.after(() => relay.close());
  const code = relay.pairing("a"); const body = { code, deviceId: randomUUID(), name: "A", capabilities: ["open_resource"], resources: [] };
  const anonymous = new RelayClient(origin);
  await anonymous.request("/v1/pairings/complete", body);
  await assert.rejects(() => anonymous.request("/v1/pairings/complete", { ...body, deviceId: randomUUID() }), (e: unknown) => e instanceof RelayError && e.status === 401);
  const a = await pair(relay, origin, "a"), b = await pair(relay, origin, "b");
  const sa = await a.client.connect([{ id: resource.id, label: resource.label }]);
  const sb = await b.client.connect([{ id: resource.id, label: resource.label }]);
  assert.equal(relay.list("b").length, 1);
  assert.throws(() => relay.open("b", a.id, resource.id), /owner/);
  const c = relay.open("a", a.id, resource.id);
  assert.equal(await b.client.poll(sb), null);
  await assert.rejects(() => b.client.poll(sa));
  await assert.rejects(() => b.client.report({ protocolVersion: 1, commandId: c.commandId, intentId: c.intentId, deviceId: b.id, sessionId: sb, status: "succeeded", code: "open_dispatched", at: new Date().toISOString() }));
  relay.revoke("a", a.id); await assert.rejects(() => a.client.poll(sa), (e: unknown) => e instanceof RelayError && e.status === 401);
});
test("relay expires challenges and invalidates old sessions after reconnect", async t => {
  let now = Date.now(); const relay = new DemoRelay(() => now), origin = await relay.listen(0); t.after(() => relay.close());
  const expired = relay.pairing("a"); now += 121000;
  await assert.rejects(() => new RelayClient(origin).request("/v1/pairings/complete", { code: expired, deviceId: randomUUID(), name: "A", capabilities: ["open_resource"], resources: [] }));
  const a = await pair(relay, origin, "a"); const session = await a.client.connect([{ id: resource.id, label: resource.label }]);
  relay.open("a", a.id, resource.id);
  const next = await a.client.connect([{ id: resource.id, label: resource.label }]);
  await assert.rejects(() => a.client.poll(session)); assert.equal(await a.client.poll(next), null);
  assert.equal(relay.history("a")[0]?.status, "unknown");
});
test("loopback relay rejects browser origins and forged Host headers", async t => {
  const relay = new DemoRelay(), origin = await relay.listen(0); t.after(() => relay.close());
  for (const headers of [{ Origin: "https://untrusted.example" }, { Host: "untrusted.example" }]) {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(origin + "/v1/pairings/complete", { method: "POST", headers: { "Content-Type": "application/json", ...headers } }, res => {
        res.resume(); res.on("end", () => resolve(res.statusCode));
      });
      req.on("error", reject); req.end("{}");
    });
    assert.equal(status, 403);
  }
});
async function until(predicate: () => boolean, milliseconds = 6000) {
  const deadline = Date.now() + milliseconds;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error("Timed out waiting for integration result."); await new Promise(r => setTimeout(r, 25)); }
}
test("actual HTTP runner delivers approval and cancel results with no OS action on cancellation", async t => {
  const f = await fixture(t), relay = new DemoRelay(), origin = await relay.listen(0); t.after(() => relay.close());
  const a = await pair(relay, origin, "owner"), stop = new AbortController();
  let approved = true, opened = 0, prompting = false;
  const running = runCompanion({ directory: f.directory,
    config: { version: 1, deviceId: a.id, name: "Test", resources: [resource] }, client: a.client, signal: stop.signal, log() {},
    ports: { validate: async () => {}, open: async () => { opened++; }, approve: async (_r, _c, signal) => {
      if (approved) return true;
      prompting = true;
      return new Promise<boolean>(resolve => signal.addEventListener("abort", () => resolve(false), { once: true }));
    } },
  });
  t.after(async () => { stop.abort(); await running; });
  await until(() => relay.list("owner")[0]?.online === true);
  relay.open("owner", a.id, resource.id);
  await until(() => relay.history("owner")[0]?.status === "succeeded"); assert.equal(opened, 1);
  approved = false; const c = relay.open("owner", a.id, resource.id);
  await until(() => prompting); relay.cancel("owner", c.commandId);
  await until(() => relay.history("owner")[1]?.status === "cancelled"); assert.equal(opened, 1);
});
