import assert from "node:assert/strict";
import test from "node:test";
import { FakeDetector, FakeSearchProvider, ResearchService } from "agent-core/research";
import { createResearchHandler } from "./research-http";
import { researchBudgetFromEnv } from "./research-config";

const origin = "http://127.0.0.1:3100";
const cookieA = `web-research-session=${"a".repeat(64)}`;
const cookieB = `web-research-session=${"b".repeat(64)}`;
const question = "Does early mobilisation after knee replacement reduce length of stay?";
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${origin}/api/research`, {
    method: "POST",
    headers: { origin, host: "127.0.0.1:3100", cookie: cookieA, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
const get = (query = "", headers: Record<string, string> = {}) =>
  new Request(`${origin}/api/research${query}`, { headers: { host: "127.0.0.1:3100", ...headers } });

function handler(search = new FakeSearchProvider({ default: { kind: "results", results: [{ url: "https://nice.org.uk/g", title: "Knee replacement early mobilisation guideline", text: "Early mobilisation after knee replacement reduces length of stay." }] } })) {
  const service = new ResearchService({ search, synthesis: null, budget: { deadlineMs: 2_000 } });
  return { handle: createResearchHandler({ service }), search, service };
}

test("GET establishes a protected session and reports capabilities without calling out", async () => {
  const { handle, search } = handler();
  const response = await handle(get());
  const body = await response.json();
  assert.equal(body.status, "ready");
  assert.equal(body.search.provider, "fake");
  assert.equal(body.synthesis.provider, "none");
  assert.match(response.headers.get("set-cookie")!, /HttpOnly; SameSite=Strict; Path=\/api\/research/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(search.calls.length, 0);
});

test("non-loopback hosts, cross-origin posts, absent sessions, and form bodies are refused", async () => {
  const { handle, search } = handler();
  assert.equal((await handle(get("", { host: "evil.example" }))).status, 403);
  const invalidHeaders: Record<string, string>[] = [
    { origin: "https://evil.example" },
    { cookie: "" },
    { "content-type": "application/x-www-form-urlencoded" },
    { origin: "" },
  ];
  for (const headers of invalidHeaders) {
    assert.equal((await handle(post({ operation: "prepare", input: { question } }, headers))).status, 403);
  }
  assert.equal((await handle(new Request(`${origin}/api/research`, { method: "DELETE", headers: { host: "127.0.0.1:3100" } }))).status, 405);
  assert.equal(search.calls.length, 0);
});

test("prepare → approve → poll flow, with decline, replay, foreign session, and tampering handled", async () => {
  const { handle, search, service } = handler();
  const prepared = await handle(post({ operation: "prepare", input: { question, jurisdiction: "UK" } }));
  assert.equal(prepared.status, 200);
  const { plan } = await prepared.json();
  assert.equal(plan.status, "awaiting_approval");
  assert.equal(search.calls.length, 0, "preparing a plan makes no external call");

  // Tampered hash and foreign session.
  assert.equal((await handle(post({ operation: "approve", requestId: plan.requestId, planHash: "0".repeat(64) }))).status, 409);
  assert.equal((await handle(post({ operation: "approve", requestId: plan.requestId, planHash: plan.planHash }, { cookie: cookieB }))).status, 404);
  assert.equal((await handle(get(`?requestId=${plan.requestId}`, { cookie: cookieB }))).status, 404);
  assert.equal(search.calls.length, 0);

  const approved = await handle(post({ operation: "approve", requestId: plan.requestId, planHash: plan.planHash }));
  assert.equal(approved.status, 202);
  assert.equal((await approved.json()).status, "running");
  assert.equal((await handle(post({ operation: "approve", requestId: plan.requestId, planHash: plan.planHash }))).status, 409, "replay");
  await service.settle("a".repeat(64), plan.requestId);
  const polled = await handle(get(`?requestId=${plan.requestId}`, { cookie: cookieA }));
  const view = await polled.json();
  assert.equal(view.status, "sources_only");
  assert.equal(view.brief.sources.length, 1);
  assert.equal(search.calls.length, plan.queries.length);

  const second = await (await handle(post({ operation: "prepare", input: { question } }))).json();
  const declined = await handle(post({ operation: "decline", requestId: second.plan.requestId }));
  assert.equal((await declined.json()).status, "declined");
  assert.equal(search.calls.length, plan.queries.length, "declining sends nothing");
  assert.equal((await handle(post({ operation: "cancel", requestId: second.plan.requestId }))).status, 409);
});

test("malformed bodies and oversized payloads fail closed", async () => {
  const { handle, search } = handler();
  assert.equal((await handle(post({ operation: "prepare", input: { question: "short" } }))).status, 400);
  assert.equal((await handle(post({ operation: "prepare", input: { question, transcript: "Doctor: hello" } }))).status, 400);
  assert.equal((await handle(post({ operation: "prepare", input: { question: "x".repeat(130_000) } }))).status, 413);
  assert.equal((await handle(get("?requestId=not-a-uuid", { cookie: cookieA }))).status, 400);
  assert.equal((await handle(get(`?requestId=${"1".repeat(8)}-1111-4111-8111-111111111111`))).status, 404);
  assert.equal(search.calls.length, 0);
});

test("unconfigured search refuses approval with 503 and cancel aborts a running request", async () => {
  const unconfigured = handler(new FakeSearchProvider({ configured: false }));
  const { plan } = await (await unconfigured.handle(post({ operation: "prepare", input: { question } }))).json();
  assert.equal(plan.searchProvider.configured, false);
  const refused = await unconfigured.handle(post({ operation: "approve", requestId: plan.requestId, planHash: plan.planHash }));
  assert.equal(refused.status, 503);
  assert.equal((await refused.json()).code, "search_unconfigured");

  const hanging = handler(new FakeSearchProvider({ default: { kind: "hang" } }));
  const prepared = await (await hanging.handle(post({ operation: "prepare", input: { question } }))).json();
  await hanging.handle(post({ operation: "approve", requestId: prepared.plan.requestId, planHash: prepared.plan.planHash }));
  const cancelled = await hanging.handle(post({ operation: "cancel", requestId: prepared.plan.requestId }));
  assert.equal((await cancelled.json()).status, "cancelled");
});

test("environment budget parsing clamps to the contract bounds", () => {
  assert.deepEqual(researchBudgetFromEnv({}), { maxQueries: 3, maxResultsPerQuery: 5, maxSources: 8, maxPassageCharacters: 2000, deadlineMs: 45_000 });
  const clamped = researchBudgetFromEnv({ RESEARCH_MAX_QUERIES: "99", RESEARCH_MAX_RESULTS_PER_QUERY: "0", RESEARCH_DEADLINE_MS: "abc" });
  assert.equal(clamped.maxQueries, 5);
  assert.equal(clamped.maxResultsPerQuery, 1);
  assert.equal(clamped.deadlineMs, 45_000);
});

test("detect sends the transcript only on an explicit command and reports verified topics", async () => {
  const detector = new FakeDetector({
    kind: "output",
    output: {
      medicalContentDetected: true,
      confidence: "high",
      summary: "Blood pressure review.",
      topics: [{ topic: "Hypertension", category: "condition", evidence: "readings around 150 over 95" }],
      suggestedQuestions: [{ question: "What is first-line treatment for uncomplicated hypertension in adults?", rationale: "Discussed." }],
    },
  });
  const service = new ResearchService({ search: new FakeSearchProvider(), synthesis: null, detector });
  const handle = createResearchHandler({ service });
  const capabilities = await (await handle(get())).json();
  assert.equal(capabilities.detection.provider, "fake");
  assert.equal(detector.calls.length, 0);
  const transcript = "Dr A [00:00]: Your readings around 150 over 95 are high.";
  const response = await handle(post({ operation: "detect", input: { meetingId: "MTG-1", transcript } }));
  assert.equal(response.status, 200);
  const { detection } = await response.json();
  assert.equal(detection.medicalContentDetected, true);
  assert.equal(detection.topics.length, 1);
  assert.equal(detection.suggestedQuestions[0].question, "What is first-line treatment for uncomplicated hypertension in adults?");
  assert.equal(detector.calls.length, 1);
  assert.equal((await handle(post({ operation: "detect", input: { meetingId: "MTG-1", transcript } }, { origin: "https://evil.example" }))).status, 403);
  assert.equal((await handle(post({ operation: "detect", input: { meetingId: "MTG-1", transcript: "x".repeat(50_001) } }))).status, 400);
  assert.equal(detector.calls.length, 1);
  const unconfigured = createResearchHandler({ service: new ResearchService({ search: new FakeSearchProvider(), synthesis: null, detector: null }) });
  assert.equal((await unconfigured(post({ operation: "detect", input: { meetingId: "MTG-1", transcript } }))).status, 503);
});
