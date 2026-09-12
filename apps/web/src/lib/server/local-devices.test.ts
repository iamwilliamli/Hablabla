import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { LocalDevices } from "./local-devices";

const origin = "http://127.0.0.1:3100";
const permissions = { screenRecording: true, accessibility: false };
function fixture() {
  let now = Date.parse("2026-09-12T20:00:00.000Z");
  const broker = new LocalDevices(() => now);
  const request = (path = "", body?: unknown, headers: Record<string, string> = {}) => broker.handle(new Request(`${origin}/api/devices${path}`, {
    method: body === undefined ? "GET" : "POST", headers: { host: "127.0.0.1:3100", ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const browser = (cookie: string, body?: unknown, path = "") => request(path, body, { cookie, origin, "sec-fetch-site": "same-origin" });
  const native = (token: string, body: unknown) => request("?native=1", body, token ? { authorization: `Bearer ${token}` } : {});
  const session = async () => (await request()).headers.get("set-cookie")!.split(";")[0];
  const pair = async (cookie: string) => {
    const { code } = await (await browser(cookie, { operation: "pairing" })).json();
    const response = await native("", { operation: "pair", code, name: "Test Mac", permissions });
    assert.equal(response.status, 200);
    return { ...await response.json(), code } as { token: string; deviceId: string; code: string };
  };
  const snapshot = async (cookie: string, deviceId: string) => {
    const requestId = randomUUID();
    assert.equal((await browser(cookie, { operation: "snapshot", requestId, deviceId })).status, 200);
    return requestId;
  };
  // Tiny bounded SOF fixture tests validation/storage, not image rendering.
  const jpeg = Buffer.from([255,216,255,192,0,11,8,0,1,0,1,1,1,17,0,255,217]).toString("base64");
  const share = (requestId: string) => ({ operation: "share", requestId, jpeg,
    metadata: { target: "Test window", targetId: "window:1", kind: "window", width: 1, height: 1, scale: 2, capturedAt: new Date(now).toISOString() } });
  return { broker, request, browser, native, session, pair, snapshot, share, advance: (ms: number) => { now += ms; broker.sweep(); } };
}

test("local pairing binds the native token, GUI permissions, and image to the issuing browser", async () => {
  const f = fixture(), owner = await f.session(), other = await f.session();
  const pair = await f.pair(owner);
  const state = await (await f.browser(owner)).json();
  assert.equal(state.device.name, "Test Mac");
  assert.deepEqual(state.device.permissions, permissions);
  assert.equal(JSON.stringify(state).includes(pair.token), false);
  assert.equal((await (await f.browser(other)).json()).device, null);
  const id = await f.snapshot(owner, pair.deviceId);
  const delivery = await (await f.native(pair.token, { operation: "poll", permissions })).json();
  assert.equal(delivery.request.id, id);
  assert.equal((await f.native(pair.token, f.share(id))).status, 200);
  const result = await (await f.browser(owner)).json();
  assert.equal(result.request.status, "shared");
  assert.equal(result.request.metadata.targetId, "window:1");
  const image = await f.browser(owner, undefined, `?image=${id}`);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/jpeg");
  assert.match(image.headers.get("cache-control")!, /no-store/);
  assert.equal((await f.browser(other, undefined, `?image=${id}`)).status, 404);
});

test("pairing codes are expiring, single-use, and replaced by a fresh challenge", async () => {
  const f = fixture(), owner = await f.session();
  const p = await f.pair(owner);
  assert.equal((await f.native("", { operation: "pair", code: p.code, name: "Replay", permissions })).status, 403);
  await f.browser(owner, { operation: "disconnect" });
  const first = await (await f.browser(owner, { operation: "pairing" })).json();
  const second = await (await f.browser(owner, { operation: "pairing" })).json();
  assert.equal((await f.native("", { operation: "pair", code: first.code, name: "Old", permissions })).status, 403);
  f.advance(120_001);
  assert.equal((await f.native("", { operation: "pair", code: second.code, name: "Late", permissions })).status, 403);
});

test("unknown cookies and native credentials do not establish ownership", async () => {
  const f = fixture();
  assert.equal((await f.browser(`hablabla-local-device-session=${"a".repeat(64)}`, { operation: "pairing" })).status, 401);
  assert.equal((await f.native("a".repeat(64), { operation: "poll", permissions })).status, 401);
  assert.equal((await f.native("", { operation: "poll", permissions })).status, 401);
});

test("reject cross-origin, DNS rebinding, wrong ports, browser calls to native API and unknown fields", async () => {
  const f = fixture(), cookie = await f.session();
  const command = { operation: "pairing" };
  const invalidHeaders: Record<string, string>[] = [
    { host: "attacker.example", origin: "http://attacker.example" },
    { host: "127.0.0.1:9999", origin: "http://127.0.0.1:9999" },
    { origin: "https://attacker.example" }, { origin, "sec-fetch-site": "cross-site" },
  ];
  for (const headers of invalidHeaders) assert.equal((await f.request("", command, { cookie, ...headers })).status, 403);
  assert.equal((await f.request("?native=1", command, { origin })).status, 403);
  assert.equal((await f.request("?native=1", command, { "sec-fetch-site": "none" })).status, 403);
  assert.equal((await f.browser(cookie, { ...command, ownerId: randomUUID() })).status, 400);
});

test("two devices cannot request, complete, cancel, or read each other's work", async () => {
  const f = fixture(), a = await f.session(), b = await f.session();
  const pa = await f.pair(a), pb = await f.pair(b);
  assert.equal((await f.browser(b, { operation: "snapshot", requestId: randomUUID(), deviceId: pa.deviceId })).status, 404);
  const id = await f.snapshot(a, pa.deviceId);
  assert.equal((await f.native(pb.token, f.share(id))).status, 409);
  await f.browser(b, { operation: "clear" });
  assert.equal((await (await f.native(pa.token, { operation: "poll", permissions })).json()).request.id, id);
});

test("browser retries and lost native replies never request a second capture", async () => {
  const f = fixture(), owner = await f.session(), p = await f.pair(owner);
  const id = await f.snapshot(owner, p.deviceId), body = f.share(id);
  assert.equal((await f.native(p.token, body)).status, 200);
  assert.equal((await f.native(p.token, body)).status, 200);
  await f.browser(owner, { operation: "snapshot", requestId: id, deviceId: p.deviceId });
  assert.equal((await (await f.native(p.token, { operation: "poll", permissions })).json()).request, null);
  assert.equal((await f.native(p.token, { ...body, metadata: { ...body.metadata, target: "Changed" } })).status, 409);
  await f.browser(owner, { operation: "clear" });
  assert.equal((await f.native(p.token, body)).status, 409);
  await f.browser(owner, { operation: "snapshot", requestId: id, deviceId: p.deviceId });
  assert.equal((await (await f.browser(owner)).json()).request.status, "cancelled");
});

test("only one request is active and decline remains terminal", async () => {
  const f = fixture(), owner = await f.session(), p = await f.pair(owner);
  const id = await f.snapshot(owner, p.deviceId);
  assert.equal((await f.browser(owner, { operation: "snapshot", requestId: randomUUID(), deviceId: p.deviceId })).status, 409);
  const decline = { operation: "result", requestId: id, result: "denied" };
  assert.equal((await f.native(p.token, decline)).status, 200);
  assert.equal((await f.native(p.token, decline)).status, 200);
  assert.equal((await f.native(p.token, f.share(id))).status, 409);
  assert.equal((await (await f.browser(owner)).json()).request.status, "denied");
});

test("clear during approval prevents late images and removes media immediately", async () => {
  const f = fixture(), owner = await f.session(), p = await f.pair(owner);
  const id = await f.snapshot(owner, p.deviceId);
  await f.browser(owner, { operation: "clear" });
  assert.equal((await f.native(p.token, f.share(id))).status, 409);
  const next = await f.snapshot(owner, p.deviceId);
  await f.native(p.token, f.share(next));
  await f.browser(owner, { operation: "clear" });
  assert.equal((await f.browser(owner, undefined, `?image=${next}`)).status, 404);
});

test("offline companion and closed browser cancel pending work; reconnect does not replay", async () => {
  const f = fixture(), owner = await f.session(), p = await f.pair(owner);
  const id = await f.snapshot(owner, p.deviceId);
  f.advance(10_001);
  assert.equal((await (await f.browser(owner)).json()).device.online, false);
  assert.equal((await f.native(p.token, f.share(id))).status, 409);
  assert.equal((await (await f.native(p.token, { operation: "poll", permissions })).json()).request, null);
  const next = await f.snapshot(owner, p.deviceId);
  for (let i = 0; i < 4; i++) { f.advance(5000); await f.native(p.token, { operation: "poll", permissions }); }
  assert.equal((await f.native(p.token, f.share(next))).status, 409);
});

test("request and image deadlines hold even while both sides stay online", async () => {
  const f = fixture(), owner = await f.session(), p = await f.pair(owner);
  const id = await f.snapshot(owner, p.deviceId);
  for (let i = 0; i < 25; i++) { f.advance(5000); await f.browser(owner); await f.native(p.token, { operation: "poll", permissions }); }
  assert.equal((await (await f.browser(owner)).json()).request.status, "expired");
  assert.equal((await f.native(p.token, f.share(id))).status, 409);
  const next = await f.snapshot(owner, p.deviceId);
  await f.native(p.token, f.share(next));
  for (let i = 0; i < 13; i++) { f.advance(5000); await f.browser(owner); await f.native(p.token, { operation: "poll", permissions }); }
  assert.equal((await f.browser(owner, undefined, `?image=${next}`)).status, 404);
  assert.equal((await (await f.browser(owner)).json()).request.metadata, null);
});

test("revocation, process restart, and session expiry invalidate native credentials", async () => {
  for (const nativeStop of [false, true]) {
    const f = fixture(), owner = await f.session(), p = await f.pair(owner);
    await f.snapshot(owner, p.deviceId);
    if (nativeStop) await f.native(p.token, { operation: "disconnect" });
    else await f.browser(owner, { operation: "disconnect" });
    assert.equal((await f.native(p.token, { operation: "poll", permissions })).status, 401);
    assert.equal((await (await f.browser(owner)).json()).request, null);
  }
  const f = fixture(), owner = await f.session(), p = await f.pair(owner);
  assert.equal((await fixture().native(p.token, { operation: "poll", permissions })).status, 401);
  f.advance(2 * 60 * 60_000);
  assert.equal((await f.native(p.token, { operation: "poll", permissions })).status, 401);
});

test("reject malformed images, metadata mismatch, old captures, oversized and arbitrary actions", async () => {
  const f = fixture(), owner = await f.session(), p = await f.pair(owner);
  const id = await f.snapshot(owner, p.deviceId), share = f.share(id);
  for (const body of [
    { ...share, jpeg: Buffer.from("not an image").toString("base64") },
    { ...share, metadata: { ...share.metadata, width: 100 } },
    { ...share, metadata: { ...share.metadata, capturedAt: "2020-01-01T00:00:00.000Z" } },
    { ...share, metadata: { ...share.metadata, targetId: "x".repeat(101) } },
    { operation: "shell", command: "whoami" },
  ]) assert.equal((await f.native(p.token, body)).status, 400);
  assert.equal((await f.native(p.token, { ...share, jpeg: "a".repeat(2_820_000) })).status, 413);
  assert.equal((await (await f.browser(owner)).json()).request.status, "awaiting_approval");
});
