import assert from "node:assert/strict";
import test from "node:test";
import { buildPlan, buildQueries, hashPlan, privacyFlags } from "./planner";
import { researchPlanSchema, researchQuestionInputSchema } from "./contract";

const config = {
  searchProvider: { provider: "fake" as const, searchType: "fake", configured: true },
  synthesis: { provider: "none" as const, dataSent: [], configured: false },
  planTtlMs: 60_000,
  now: () => new Date("2026-09-12T10:00:00.000Z"),
};

test("plans are bounded, deterministic, and expose exact outbound queries", () => {
  const input = {
    question: "Does early mobilisation after knee replacement reduce length of stay?",
    jurisdiction: "UK",
    dateRange: { from: "2020-01-01", to: "2026-06-30" },
  };
  const plan = buildPlan(input, config);
  assert.equal(researchPlanSchema.safeParse(plan).success, true);
  assert.equal(plan.queries.length, 3);
  assert.equal(plan.queries[0]?.text, input.question);
  assert.equal(plan.queries[0]?.includeDomains, undefined);
  assert.ok(plan.queries[1]?.includeDomains?.includes("nice.org.uk"));
  assert.equal(plan.queries[0]?.startPublishedDate, "2020-01-01T00:00:00.000Z");
  assert.equal(plan.queries[0]?.endPublishedDate, "2026-06-30T23:59:59.999Z");
  assert.equal(plan.expiresAt, "2026-09-12T10:01:00.000Z");
  assert.equal(plan.privacyReview.requiresHumanReview, true);
  assert.match(plan.disclosures.join("\n"), /No language-model synthesis is configured/);
  // Same content, same hash; changed query text, different hash.
  assert.equal(hashPlan(plan), plan.planHash);
  const tampered = { ...plan, queries: [{ ...plan.queries[0]!, text: "something else" }, ...plan.queries.slice(1)] };
  assert.notEqual(hashPlan(tampered), plan.planHash);
});

test("query count follows the configured budget and never exceeds five", () => {
  const input = { question: "Is aspirin useful for primary prevention in older adults?" };
  assert.equal(buildQueries(input, 1).length, 1);
  assert.equal(buildQueries(input, 5).length, 5);
  assert.equal(buildQueries(input, 99).length, 5);
});

test("privacy flags surface patient-identifying phrasing without blocking", () => {
  const flags = privacyFlags({
    question: "My patient Mr Jones, a 64-year-old seen on 03/04/2026, has hypertension; what does NICE recommend?",
  });
  assert.ok(flags.some((f) => /age/.test(f)));
  assert.ok(flags.some((f) => /date/.test(f)));
  assert.ok(flags.some((f) => /specific patient/.test(f)));
  assert.ok(flags.some((f) => /name/.test(f)));
  assert.deepEqual(privacyFlags({ question: "What is the first-line treatment for uncomplicated hypertension in adults?" }), []);
});

test("input contract rejects transcripts, identifiers-as-fields, and bad dates", () => {
  assert.equal(researchQuestionInputSchema.safeParse({ question: "x".repeat(601) }).success, false);
  assert.equal(researchQuestionInputSchema.safeParse({ question: "short" }).success, false);
  assert.equal(
    researchQuestionInputSchema.safeParse({ question: "What is the evidence for X in Y?", transcript: "..." }).success,
    false,
  );
  assert.equal(
    researchQuestionInputSchema.safeParse({ question: "What is the evidence for X in Y?", dateRange: { from: "2025-13-01" } }).success,
    false,
  );
  assert.equal(
    researchQuestionInputSchema.safeParse({ question: "What is the evidence for X in Y?", dateRange: { from: "2025-02-01", to: "2024-01-01" } }).success,
    false,
  );
});
