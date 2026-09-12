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
    const response = await native("", { operation: "pair", protocolVersion: 2, code, name: "Test Mac", permissions });
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
  assert.equal((await f.native("", { operation: "pair", protocolVersion: 2, code: p.code, name: "Replay", permissions })).status, 403);
  await f.browser(owner, { operation: "disconnect" });
  const first = await (await f.browser(owner, { operation: "pairing" })).json();
  const second = await (await f.browser(owner, { operation: "pairing" })).json();
  assert.equal((await f.native("", { operation: "pair", protocolVersion: 2, code: first.code, name: "Old", permissions })).status, 403);
  f.advance(120_001);
  assert.equal((await f.native("", { operation: "pair", protocolVersion: 2, code: second.code, name: "Late", permissions })).status, 403);
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

async function controlFixture() {
  const f = fixture(), cookie = await f.session(), p = await f.pair(cookie);
  const access = { screenRecording: true, accessibility: true };
  await f.native(p.token, { operation: "poll", permissions: access });
  const requestId = randomUUID(), catalogId = randomUUID(), windowId = randomUUID();
  assert.equal((await f.browser(cookie, { operation: "list_windows", requestId, deviceId: p.deviceId })).status, 200);
  const catalog = { id: catalogId, expiresAt: "2026-09-12T20:02:55.000Z", windows: [{ id: windowId, app: "TextEdit", title: "Demo", minimized: false }] };
  assert.equal((await f.native(p.token, { operation: "windows", requestId, catalog })).status, 200);
  const command = { operation: "control", requestId: randomUUID(), deviceId: p.deviceId, catalogId, windowId, action: { kind: "activate_window" } };
  const authorize = { operation: "authorize", requestId: command.requestId, catalogId, windowId };
  return { ...f, cookie, p, catalog, command, authorize, access };
}

test("v1 companions cannot pair with the control-capable broker", async () => {
  const f = fixture(), cookie = await f.session();
  const { code } = await (await f.browser(cookie, { operation: "pairing" })).json();
  assert.equal((await f.native("", { operation: "pair", code, name: "Old app", permissions })).status, 400);
});

test("window listing requires actual AX access and remains private until native sharing", async () => {
  const f = fixture(), cookie = await f.session(), p = await f.pair(cookie);
  const command = { operation: "list_windows", requestId: randomUUID(), deviceId: p.deviceId };
  assert.equal((await f.browser(cookie, command)).status, 409);
  await f.native(p.token, { operation: "poll", permissions: { ...permissions, accessibility: true } });
  assert.equal((await f.browser(cookie, command)).status, 200);
  assert.equal((await (await f.browser(cookie)).json()).catalog, null);
  assert.equal((await f.native(p.token, f.share(command.requestId))).status, 409);
  assert.equal((await f.native(p.token, { operation: "result", requestId: command.requestId, result: "denied" })).status, 200);
  assert.equal((await (await f.browser(cookie)).json()).catalog, null);
});

test("window catalogs reject duplicate IDs, oversized titles, and excessive lifetimes", async () => {
  const f = await controlFixture();
  const requestId = randomUUID();
  await f.browser(f.cookie, { operation: "list_windows", deviceId: f.p.deviceId, requestId });
  for (const catalog of [
    { ...f.catalog, windows: [f.catalog.windows[0], f.catalog.windows[0]] },
    { ...f.catalog, expiresAt: "2026-09-12T22:00:00.000Z" },
    { ...f.catalog, windows: [{ ...f.catalog.windows[0], title: "x".repeat(161) }] },
  ]) assert.equal((await f.native(f.p.token, { operation: "windows", requestId, catalog })).status, 400);
});

test("a control executes only after a single claim bound to the exact selected window", async () => {
  const f = await controlFixture();
  assert.equal((await f.browser(f.cookie, f.command)).status, 200);
  assert.equal((await f.native(f.p.token, { operation: "result", requestId: f.command.requestId, result: "succeeded" })).status, 409);
  assert.equal((await f.native(f.p.token, { ...f.authorize, windowId: randomUUID() })).status, 409);
  assert.equal((await f.native(f.p.token, f.authorize)).status, 200);
  assert.equal((await f.native(f.p.token, f.authorize)).status, 409);
  const poll = await (await f.native(f.p.token, { operation: "poll", permissions: f.access })).json();
  assert.equal(poll.request.kind, "control");
  assert.deepEqual(poll.request.action, f.command.action);
  const result = { operation: "result", requestId: f.command.requestId, result: "succeeded" };
  assert.equal((await f.native(f.p.token, result)).status, 200);
  assert.equal((await f.native(f.p.token, result)).status, 200);
  assert.equal((await (await f.native(f.p.token, { operation: "poll", permissions: f.access })).json()).request, null);
});

test("cancellation before claim prevents input, while cancellation after claim reports uncertainty", async () => {
  const f = await controlFixture();
  await f.browser(f.cookie, f.command);
  await f.browser(f.cookie, { operation: "clear" });
  assert.equal((await f.native(f.p.token, f.authorize)).status, 409);
  assert.equal((await (await f.browser(f.cookie)).json()).request.status, "cancelled");
  const requestId = randomUUID();
  await f.browser(f.cookie, { ...f.command, requestId });
  await f.native(f.p.token, { ...f.authorize, requestId });
  await f.browser(f.cookie, { operation: "clear" });
  assert.equal((await (await f.browser(f.cookie)).json()).request.status, "unknown");
  assert.equal((await f.native(f.p.token, { ...f.authorize, requestId })).status, 409);
  assert.equal((await f.native(f.p.token, { operation: "result", requestId, result: "succeeded" })).status, 409);
});

test("permission revocation clears targets and prevents pending control claims", async () => {
  const f = await controlFixture();
  await f.browser(f.cookie, f.command);
  await f.native(f.p.token, { operation: "poll", permissions });
  const state = await (await f.browser(f.cookie)).json();
  assert.equal(state.catalog, null);
  assert.equal(state.request.status, "failed");
  assert.equal((await f.native(f.p.token, f.authorize)).status, 409);
});

test("catalog ownership, target identity, command bodies, and replay are bound together", async () => {
  const f = await controlFixture(), other = await f.session(), p2 = await f.pair(other);
  await f.native(p2.token, { operation: "poll", permissions: f.access });
  assert.equal((await (await f.browser(other)).json()).catalog, null);
  assert.equal((await f.browser(other, { ...f.command, deviceId: p2.deviceId })).status, 409);
  assert.equal((await f.browser(f.cookie, { ...f.command, windowId: randomUUID() })).status, 409);
  assert.equal((await f.browser(f.cookie, f.command)).status, 200);
  assert.equal((await f.browser(f.cookie, f.command)).status, 200);
  assert.equal((await f.browser(f.cookie, { ...f.command, action: { kind: "type_text", text: "different" } })).status, 409);
  assert.equal((await f.native(p2.token, f.authorize)).status, 409);
});

test("input schemas reject shell commands, held keys, unbounded input and invalid coordinates", async () => {
  const f = await controlFixture();
  for (const action of [
    { kind: "shell", command: "echo demo" }, { kind: "key_down", key: "a" },
    { kind: "key", key: "a", modifiers: ["command", "command"] },
    { kind: "type_text", text: "x".repeat(501) }, { kind: "type_text", text: "hello\nworld" },
    { kind: "pointer", mode: "click", point: { x: 2, y: 0.5 } },
    { kind: "pointer", mode: "drag", point: { x: 0.5, y: 0.5 } },
    { kind: "scroll", point: { x: 0.5, y: 0.5 }, dx: 0, dy: 601 },
    { kind: "activate_window", pid: 123 },
  ]) assert.equal((await f.browser(f.cookie, { ...f.command, action })).status, 400);
});

test("all bounded input variants dispatch once, without claiming application success", async () => {
  const f = await controlFixture();
  const point = { x: 0.4, y: 0.5 };
  const actions = [
    { kind: "type_text", text: "Demo text 👋" }, { kind: "key", key: "a", modifiers: ["command"] },
    ...["move", "click", "double_click", "right_click"].map(mode => ({ kind: "pointer", mode, point })),
    { kind: "pointer", mode: "drag", point, end: { x: 0.6, y: 0.6 } },
    { kind: "scroll", point, dx: 0, dy: -200 },
  ];
  for (const action of actions) {
    const requestId = randomUUID();
    assert.equal((await f.browser(f.cookie, { ...f.command, requestId, action })).status, 200);
    assert.equal((await f.native(f.p.token, { ...f.authorize, requestId })).status, 200);
    assert.equal((await f.native(f.p.token, { operation: "result", requestId, result: "succeeded" })).status, 400);
    assert.equal((await f.native(f.p.token, { operation: "result", requestId, result: "dispatched" })).status, 200);
    assert.equal((await (await f.browser(f.cookie)).json()).request.action, undefined);
  }
});

test("offline or disconnected execution stays uncertain and never replays", async () => {
  for (const mode of ["offline", "disconnect"] as const) {
    const f = await controlFixture();
    await f.browser(f.cookie, f.command);
    await f.native(f.p.token, f.authorize);
    if (mode === "offline") f.advance(16_000);
    else await f.browser(f.cookie, { operation: "disconnect" });
    const state = await (await f.browser(f.cookie)).json();
    assert.equal(state.request.status, "unknown");
    assert.equal(state.catalog, null);
    assert.equal((await f.native(f.p.token, f.authorize)).status, mode === "offline" ? 409 : 401);
  }
});

test("late or repeated cancellation cannot relabel dispatched input as never executed", async () => {
  const f = await controlFixture();
  await f.browser(f.cookie, { ...f.command, action: { kind: "type_text", text: "Demo" } });
  await f.native(f.p.token, f.authorize);
  await f.native(f.p.token, { operation: "result", requestId: f.command.requestId, result: "dispatched" });
  await f.browser(f.cookie, { operation: "clear" });
  assert.equal((await (await f.browser(f.cookie)).json()).request.status, "dispatched");
  const requestId = randomUUID();
  await f.browser(f.cookie, { ...f.command, requestId });
  await f.native(f.p.token, { ...f.authorize, requestId });
  await f.browser(f.cookie, { operation: "clear" });
  await f.browser(f.cookie, { operation: "clear" });
  assert.equal((await (await f.browser(f.cookie)).json()).request.status, "unknown");
});
