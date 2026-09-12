import assert from "node:assert/strict";
import test from "node:test";
import { ResearchError } from "./errors";
import { FakeSearchProvider, FakeSynthesisProvider, type RawSearchResult } from "./providers";
import { ResearchService } from "./service";

const sessionA = "a".repeat(64);
const sessionB = "b".repeat(64);
const question = "Does early mobilisation after knee replacement reduce length of stay?";
const hits: RawSearchResult[] = [
  { url: "https://nice.org.uk/g1", title: "Knee replacement guideline: early mobilisation", text: "Early mobilisation after knee replacement reduces length of stay." },
];

function clock(start = "2026-09-12T10:00:00.000Z") {
  let now = Date.parse(start);
  return { now: () => new Date(now), advance: (ms: number) => (now += ms) };
}

function service(search = new FakeSearchProvider({ default: { kind: "results", results: hits } }), extra: Partial<ConstructorParameters<typeof ResearchService>[0]> = {}) {
  const time = clock();
  const svc = new ResearchService({ search, synthesis: null, planTtlMs: 60_000, now: time.now, budget: { deadlineMs: 2_000 }, ...extra });
  return { svc, search, time };
}

async function rejects(fn: () => unknown, code: string) {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof ResearchError, `expected ResearchError, got ${String(error)}`);
    assert.equal(error.code, code);
    return;
  }
  assert.fail(`expected ${code}`);
}

test("prepare makes no external call; decline keeps it that way", async () => {
  const { svc, search } = service();
  const plan = svc.prepare(sessionA, { question });
  assert.equal(plan.status, "awaiting_approval");
  assert.equal(search.calls.length, 0);
  const declined = svc.decline(sessionA, plan.requestId);
  assert.equal(declined.status, "declined");
  assert.equal(search.calls.length, 0);
  await rejects(() => svc.approve(sessionA, plan.requestId, plan.planHash), "already_decided");
  assert.equal(search.calls.length, 0);
});

test("approval runs exactly the stored plan and the brief is readable afterwards", async () => {
  const { svc, search } = service();
  const plan = svc.prepare(sessionA, { question, jurisdiction: "UK" });
  const running = svc.approve(sessionA, plan.requestId, plan.planHash);
  assert.equal(running.status, "running");
  const done = await svc.settle(sessionA, plan.requestId);
  assert.equal(done.status, "sources_only");
  assert.equal(done.brief?.requestId, plan.requestId);
  assert.equal(done.brief?.jurisdiction, "UK");
  assert.equal(search.calls.length, plan.queries.length);
  assert.deepEqual(search.calls.map((c) => c.query.text), plan.queries.map((q) => q.text));
});

test("a changed plan hash, a replayed approval, and a foreign session are all rejected", async () => {
  const { svc, search } = service();
  const plan = svc.prepare(sessionA, { question });
  await rejects(() => svc.approve(sessionA, plan.requestId, "0".repeat(64)), "plan_mismatch");
  await rejects(() => svc.approve(sessionB, plan.requestId, plan.planHash), "not_found");
  await rejects(() => svc.view(sessionB, plan.requestId), "not_found");
  await rejects(() => svc.decline(sessionB, plan.requestId), "not_found");
  assert.equal(search.calls.length, 0);
  svc.approve(sessionA, plan.requestId, plan.planHash);
  await rejects(() => svc.approve(sessionA, plan.requestId, plan.planHash), "already_decided");
  await svc.settle(sessionA, plan.requestId);
  await rejects(() => svc.approve(sessionA, plan.requestId, plan.planHash), "already_decided");
  assert.equal(search.calls.length, plan.queries.length, "one approval, one run");
});

test("expired plans cannot be approved and are reported as expired", async () => {
  const { svc, search, time } = service();
  const plan = svc.prepare(sessionA, { question });
  time.advance(60_001);
  await rejects(() => svc.approve(sessionA, plan.requestId, plan.planHash), "expired");
  assert.equal(svc.view(sessionA, plan.requestId).status, "expired");
  assert.equal(search.calls.length, 0);
});

test("cancellation aborts a running request", async () => {
  const search = new FakeSearchProvider({ default: { kind: "hang" } });
  const { svc } = service(search);
  const plan = svc.prepare(sessionA, { question });
  svc.approve(sessionA, plan.requestId, plan.planHash);
  const view = await svc.cancel(sessionA, plan.requestId);
  assert.equal(view.status, "cancelled");
  assert.equal(view.brief?.error?.code, "cancelled");
  await rejects(() => svc.cancel(sessionA, plan.requestId), "not_running");
});

test("the deadline aborts a hung provider", async () => {
  const search = new FakeSearchProvider({ default: { kind: "hang" } });
  const { svc } = service(search, { budget: { deadlineMs: 1_000 } });
  const plan = svc.prepare(sessionA, { question });
  svc.approve(sessionA, plan.requestId, plan.planHash);
  const view = await svc.settle(sessionA, plan.requestId);
  assert.equal(view.status, "cancelled");
  assert.equal(view.brief?.error?.code, "timeout");
});

test("unconfigured search refuses approval without calling anything", async () => {
  const search = new FakeSearchProvider({ configured: false });
  const { svc } = service(search);
  const plan = svc.prepare(sessionA, { question });
  assert.equal(plan.searchProvider.configured, false);
  await rejects(() => svc.approve(sessionA, plan.requestId, plan.planHash), "search_unconfigured");
  assert.equal(search.calls.length, 0);
});

test("the rolling search budget refuses approvals it cannot afford", async () => {
  const { svc, search, time } = service(undefined, { searchBudget: { maxSearches: 4, windowMs: 60_000 } });
  const first = svc.prepare(sessionA, { question });
  svc.approve(sessionA, first.requestId, first.planHash);
  await svc.settle(sessionA, first.requestId);
  const second = svc.prepare(sessionA, { question });
  await rejects(() => svc.approve(sessionA, second.requestId, second.planHash), "budget_exhausted");
  assert.equal(search.calls.length, 3);
  time.advance(60_001);
  const third = svc.prepare(sessionA, { question });
  svc.approve(sessionA, third.requestId, third.planHash);
  await svc.settle(sessionA, third.requestId);
  assert.equal(search.calls.length, 6);
});

test("per-session pending limit and invalid sessions are enforced", async () => {
  const { svc } = service(undefined, { maxPendingPerSession: 2 });
  svc.prepare(sessionA, { question });
  svc.prepare(sessionA, { question });
  await rejects(() => svc.prepare(sessionA, { question }), "too_many_requests");
  svc.prepare(sessionB, { question });
  await rejects(() => svc.prepare("not-a-session", { question }), "invalid_request");
});

test("synthesis disclosure appears in the plan when a provider is configured", () => {
  const { svc } = service(undefined, { synthesis: new FakeSynthesisProvider({ kind: "output", output: {} }) });
  const plan = svc.prepare(sessionA, { question });
  assert.equal(plan.synthesis.provider, "fake");
  assert.ok(plan.synthesis.dataSent.length > 0);
  assert.match(plan.disclosures.join("\n"), /test synthesis provider/);
});

test("finished records are forgotten after the result TTL", async () => {
  const { svc, time } = service(undefined, { resultTtlMs: 1_000 });
  const plan = svc.prepare(sessionA, { question });
  svc.approve(sessionA, plan.requestId, plan.planHash);
  await svc.settle(sessionA, plan.requestId);
  time.advance(1_001);
  await rejects(() => svc.view(sessionA, plan.requestId), "not_found");
});
