import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createOpenAIComputerPlanner, type ComputerPlanner, type ComputerContext, type ComputerDecision } from "./openai-computer";
import { LocalDevices } from "./local-devices";

const context: ComputerContext = { instruction: "Type exactly hello", window: { app: "TextEdit", title: "Demo", minimized: false } };
const action = { kind: "type_text", text: "hello" } as const;
const toolCall = (value: unknown = action) => ({ type: "function_call", name: "request_control", arguments: JSON.stringify({ action: value }) });
const reply = (output: unknown[], status = "completed") => Response.json({ status, output });
const plannerFor = (response: () => Response) => createOpenAIComputerPlanner({ apiKey: "test-secret", model: "test-model", fetch: async () => response() });

test("OpenAI receives only selected context, with bounded function tools and storage disabled", async () => {
  let calls = 0;
  const planner = createOpenAIComputerPlanner({ apiKey: "test-secret", model: "test-model", fetch: async (url, options) => {
    calls++;
    assert.equal(url, "https://api.openai.com/v1/responses");
    assert.equal(options?.redirect, "error");
    assert.equal(new Headers(options?.headers).get("authorization"), "Bearer test-secret");
    const body = JSON.parse(String(options?.body));
    assert.equal(body.store, false); assert.equal(body.parallel_tool_calls, false);
    assert.equal(body.model, "test-model"); assert.equal(body.max_output_tokens, 1600);
    assert.deepEqual(JSON.parse(body.input[0].content), context);
    assert.equal(JSON.stringify(body).includes("test-secret"), false);
    assert.deepEqual(body.tools.map((tool: { name: string; type: string }) => [tool.type, tool.name]), [["function", "request_control"]]);
    return reply([toolCall()]);
  } });
  assert.deepEqual((await planner.plan(context, new AbortController().signal)).action, action);
  assert.equal(calls, 1);
});

test("unknown tools, batches, incomplete and malformed or unbounded commands never become proposals", async () => {
  const cases = [
    () => reply([{ ...toolCall(), name: "shell" }]),
    () => reply([toolCall(), toolCall()]),
    () => reply([toolCall()], "incomplete"),
    () => reply([{ ...toolCall(), arguments: "not-json" }]),
    () => reply([toolCall({ kind: "pointer", mode: "click", point: { x: 2, y: 0.5 } })]),
    () => reply([toolCall({ kind: "type_text", text: "hello\n" })]),
    () => reply([toolCall({ kind: "pointer", mode: "drag", point: { x: 0.1, y: 0.1 } })]),
    () => reply([toolCall({ kind: "key", key: "Tab", modifiers: ["command", "command"] })]),
    () => reply([{ type: "computer_call", actions: [{ type: "click", x: 1, y: 1 }] }]),
    () => reply([]),
  ];
  for (const response of cases) await assert.rejects(plannerFor(response).plan(context, new AbortController().signal), /supported, complete action/);
});

test("refusal or clarification is displayed without an action", async () => {
  const result = await plannerFor(() => reply([{ type: "message", content: [{ type: "refusal", refusal: "Please select a field first." }] }])).plan(context, new AbortController().signal);
  assert.equal(result.action, null); assert.match(result.message, /select a field/);
});

test("missing credentials, provider failures, excessive responses and aborted replies fail without leaking provider bodies", async () => {
  await assert.rejects(createOpenAIComputerPlanner({ apiKey: "", fetch: async () => { throw new Error("should not call"); } }).plan(context, new AbortController().signal), /OPENAI_API_KEY/);
  for (const status of [401, 403, 404, 429, 500]) {
    await assert.rejects(plannerFor(() => new Response("private provider body", { status })).plan(context, new AbortController().signal), error => error instanceof Error && !error.message.includes("private provider body"));
  }
  await assert.rejects(plannerFor(() => new Response("x".repeat(70_000))).plan(context, new AbortController().signal), /exceeded/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(plannerFor(() => reply([toolCall()])).plan(context, controller.signal), /stopped/);
});

async function fixture(plan?: ComputerPlanner["plan"]) {
  let now = Date.parse("2026-09-12T20:00:00.000Z");
  const contexts: ComputerContext[] = [];
  const planner: ComputerPlanner = { status: () => ({ configured: true, model: "test-model" }), plan: async (context, signal) => {
    contexts.push(context);
    return plan ? plan(context, signal) : { model: "test-model", message: "Review", action };
  } };
  const broker = new LocalDevices(() => now, planner);
  const origin = "http://127.0.0.1:3100";
  const request = (body?: unknown, cookie = "", native = false, token = "", extra: Record<string, string> = {}) => broker.handle(new Request(`${origin}/api/devices${native ? "?native=1" : ""}`, {
    method: body === undefined ? "GET" : "POST", headers: { host: "127.0.0.1:3100", "content-type": "application/json", ...(native ? (token ? { authorization: `Bearer ${token}` } : {}) : { cookie, origin, "sec-fetch-site": "same-origin" }), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const session = async () => (await request()).headers.get("set-cookie")!.split(";")[0];
  const cookie = await session(), other = await session();
  const browser = (body?: unknown, owner = cookie) => request(body, owner);
  const permissions = { accessibility: true, screenRecording: true };
  const code = (await (await browser({ operation: "pairing" })).json()).code;
  const pair = await (await request({ operation: "pair", protocolVersion: 2, code, name: "Demo Mac", permissions }, "", true)).json();
  const native = (body: unknown) => request(body, "", true, pair.token);
  const requestId = randomUUID();
  await browser({ operation: "list_windows", requestId, deviceId: pair.deviceId });
  const catalog = { id: randomUUID(), expiresAt: new Date(now + 175_000).toISOString(), windows: [
    { id: randomUUID(), app: "TextEdit", title: "Demo", minimized: false },
    { id: randomUUID(), app: "Private App", title: "Must not be sent", minimized: false },
  ] };
  await native({ operation: "windows", requestId, catalog });
  const command = { operation: "ai_plan", planId: randomUUID(), deviceId: pair.deviceId, catalogId: catalog.id, windowId: catalog.windows[0].id, instruction: context.instruction };
  return { broker, browser, native, request, cookie, other, pair, catalog, command, contexts, permissions, advance: (ms: number) => { now += ms; broker.sweep(); } };
}

test("a plan uses actual session-owned window data and never queues native input automatically", async () => {
  const f = await fixture();
  const response = await f.browser(f.command); assert.equal(response.status, 200);
  const proposal = await response.json();
  assert.deepEqual(f.contexts, [context]);
  assert.equal(JSON.stringify(proposal).includes(f.pair.token), false);
  assert.equal(proposal.windowId, f.catalog.windows[0].id);
  assert.equal((await (await f.native({ operation: "poll", permissions: f.permissions })).json()).request, null);
  // The explicit existing browser control route still leads to native approval.
  const requestId = randomUUID();
  assert.equal((await f.browser({ operation: "control", requestId, deviceId: proposal.deviceId, catalogId: proposal.catalogId, windowId: proposal.windowId, action: proposal.action })).status, 200);
  const pending = (await (await f.native({ operation: "poll", permissions: f.permissions })).json()).request;
  assert.deepEqual(pending.action, action);
  assert.equal((await f.native({ operation: "result", requestId, result: "dispatched" })).status, 409);
  assert.equal((await f.native({ operation: "authorize", requestId, catalogId: proposal.catalogId, windowId: proposal.windowId })).status, 200);
  assert.equal((await f.native({ operation: "result", requestId, result: "dispatched" })).status, 200);
  assert.equal((await (await f.browser()).json()).request.status, "dispatched");
});

test("cross-session, forged context, native, and cross-origin AI requests are rejected before OpenAI", async () => {
  const f = await fixture();
  assert.equal((await f.browser(f.command, f.other)).status, 404);
  assert.equal((await f.browser({ ...f.command, windowId: randomUUID() })).status, 409);
  assert.equal((await f.browser({ ...f.command, window: context.window })).status, 400);
  assert.equal((await f.browser({ ...f.command, jpeg: "never send me" })).status, 400);
  assert.equal((await f.native(f.command)).status, 400);
  assert.equal((await f.request(f.command, f.cookie, false, "", { origin: "https://evil.example" })).status, 403);
  assert.equal((await f.request(f.command, "unknown")).status, 401);
  assert.equal(f.contexts.length, 0);
});

test("retries reuse an existing proposal, changed instructions cannot reuse an ID, discard prevents replay", async () => {
  const f = await fixture();
  const first = await (await f.browser(f.command)).json();
  assert.deepEqual(await (await f.browser(f.command)).json(), first);
  assert.equal(f.contexts.length, 1);
  assert.equal((await f.browser({ ...f.command, instruction: "different" })).status, 409);
  await f.browser({ operation: "ai_cancel" });
  assert.equal((await f.browser(f.command)).status, 409);
  assert.equal(f.contexts.length, 1);
});

test("late AI replies are discarded after cancel, disconnect, permission loss, expiry, or a manual action", async () => {
  for (const cause of ["ai_cancel", "disconnect", "permission", "expiry", "manual"]) {
    let resolve!: (decision: ComputerDecision) => void;
    const f = await fixture(async () => new Promise<ComputerDecision>(r => { resolve = r; }));
    const running = f.browser(f.command);
    while (!resolve) await new Promise(r => setImmediate(r));
    assert.equal((await f.browser({ ...f.command, planId: randomUUID() })).status, 409);
    if (cause === "permission") await f.native({ operation: "poll", permissions: { ...f.permissions, accessibility: false } });
    else if (cause === "expiry") f.advance(180_000);
    else if (cause === "manual") await f.browser({ operation: "control", requestId: randomUUID(), deviceId: f.pair.deviceId, catalogId: f.catalog.id, windowId: f.catalog.windows[0].id, action });
    else await f.browser({ operation: cause });
    resolve({ model: "test-model", message: "Late", action });
    assert.equal((await running).status, 409, cause);
    if (cause !== "manual") assert.notEqual((await (await f.browser()).json()).request?.kind, "control");
  }
});

test("AI calls are bounded to 30 per hour and are blocked while native approval is pending", async () => {
  const f = await fixture();
  for (let i = 0; i < 30; i++) assert.equal((await f.browser({ ...f.command, planId: randomUUID() })).status, 200);
  assert.equal((await f.browser({ ...f.command, planId: randomUUID() })).status, 429);
  assert.equal(f.contexts.length, 30);
  const g = await fixture();
  await g.browser({ operation: "snapshot", requestId: randomUUID(), deviceId: g.pair.deviceId });
  assert.equal((await g.browser(g.command)).status, 409);
  assert.equal(g.contexts.length, 0);
});
