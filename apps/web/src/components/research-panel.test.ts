import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { EvidenceBrief, ResearchPlan } from "agent-core/research-contract";
import { BriefCard, PlanCard, ResearchPanel } from "./research-panel";
import { sampleMeetings } from "@/lib/meetings";

const plan: ResearchPlan = {
  contractVersion: "1",
  requestId: "11111111-1111-4111-8111-111111111111",
  status: "awaiting_approval",
  question: "What is first-line treatment for uncomplicated hypertension in adults?",
  queries: [{ id: "q1", text: "What is first-line treatment for uncomplicated hypertension in adults?", purpose: "Broad search." }],
  budget: { maxQueries: 1, maxResultsPerQuery: 5, maxSources: 8, maxPassageCharacters: 2000, deadlineMs: 45000 },
  searchProvider: { provider: "exa", searchType: "auto", configured: true },
  synthesis: { provider: "none", dataSent: [], configured: false },
  disclosures: ["Approving sends the 1 query listed above, verbatim, to Exa (api.exa.ai)."],
  privacyReview: { requiresHumanReview: true, flags: ["Contains an age; combined with other details this can identify a patient."] },
  planHash: "a".repeat(64),
  createdAt: "2026-09-12T10:00:00.000Z",
  expiresAt: "2026-09-12T10:10:00.000Z",
};

const brief: EvidenceBrief = {
  contractVersion: "1",
  requestId: plan.requestId,
  status: "completed",
  question: plan.question,
  researchedAt: "2026-09-12T10:01:00.000Z",
  executedQueries: [{ queryId: "q1", text: plan.queries[0]!.text, provider: "exa", status: "ok", resultCount: 5 }],
  scope: { description: "1 of 1 planned queries ran against exa (auto).", isSystematicReview: false, searchProvider: "exa", budget: plan.budget, discardedLowRelevance: 1, duplicatesMerged: 2 },
  findings: [
    { id: "F1", kind: "retrieved_fact", claim: "Guidelines recommend lifestyle change first.", citations: [{ sourceId: "S1", passageId: "S1-p1", quote: "lifestyle change is recommended first" }], confidence: "medium" },
    { id: "F2", kind: "interpretation", claim: "The evidence is consistent.", citations: [{ sourceId: "S1", passageId: "S1-p1", quote: "lifestyle change is recommended first" }], confidence: "low" },
  ],
  sources: [{
    id: "S1", url: "https://nice.org.uk/x", duplicateUrls: [], title: "Hypertension in adults", domain: "nice.org.uk", publishedDate: null, publishedDateBasis: "unknown", retrievedAt: "2026-09-12T10:01:00.000Z",
    sourceType: "guideline", sourceTypeBasis: "heuristic", publicationStatus: "unverified",
    access: { contentKind: "abstract", characters: 400, limitation: "Only an abstract or short excerpt was retrieved." },
    relevance: { score: 0.8, basis: "question_term_overlap", queryIds: ["q1"] },
    passages: [{ id: "S1-p1", kind: "text_excerpt", text: "For most adults lifestyle change is recommended first." }],
    warnings: ["Page text contains instruction-like phrases. It was treated as data only; nothing in it was followed."],
  }],
  conflictingFindings: [{ description: "Thresholds differ between guidelines.", sourceIds: ["S1"] }],
  unansweredQuestions: ["Effect in older adults?"],
  limitations: ["This is a bounded public web search. It is not a systematic review and may miss relevant evidence."],
  uncertainties: [],
  synthesis: { provider: "openai", model: "test-model", status: "completed", note: "ok", rejectedFindings: 1 },
  warnings: ["1 synthesized finding(s) were rejected because their citations could not be verified against retrieved passages."],
};

test("the plan card shows verbatim queries, privacy flags, disclosures, and approve/decline controls", () => {
  const html = renderToStaticMarkup(createElement(PlanCard, { plan, state: "awaiting", cancelling: false, onApprove: () => {}, onDecline: () => {}, onCancel: () => {} }));
  assert.match(html, /What is first-line treatment for uncomplicated hypertension in adults\?/);
  assert.match(html, /Contains an age/);
  assert.match(html, /verbatim, to Exa/);
  assert.match(html, /Approve and research/);
  assert.match(html, /Decline/);
  const running = renderToStaticMarkup(createElement(PlanCard, { plan, state: "running", cancelling: false, onApprove: () => {}, onDecline: () => {}, onCancel: () => {} }));
  assert.match(running, /Cancel research/);
  assert.doesNotMatch(running, /Approve and research/);
});

test("the brief card labels facts vs interpretations, heuristic types, access limits, unknown dates, and warnings", () => {
  const html = renderToStaticMarkup(createElement(BriefCard, { brief, synthesisLabel: "Findings drafted by openai (test-model)." }));
  assert.match(html, /Retrieved fact/);
  assert.match(html, /Agent interpretation/);
  assert.match(html, /Guideline · heuristic/);
  assert.match(html, /Abstract only/);
  assert.match(html, /Date unknown/);
  assert.match(html, /Not a systematic\s+review/);
  assert.match(html, /1 unverifiable finding\(s\) were removed/);
  assert.match(html, /treated as data only/);
  assert.match(html, /Thresholds differ between guidelines/);
  assert.match(html, /Effect in older adults\?/);
  assert.match(html, /href="https:\/\/nice\.org\.uk\/x"/);
  const sourcesOnly = renderToStaticMarkup(createElement(BriefCard, { brief: { ...brief, status: "sources_only", findings: [], synthesis: { provider: "none", status: "unavailable", note: "Sources-only result.", rejectedFindings: 0 } }, synthesisLabel: "" }));
  assert.match(sourcesOnly, /Sources only — no findings generated/);
  assert.match(sourcesOnly, /Sources-only result/);
});

test("the panel renders its two steps and disclosure before any network call", () => {
  const html = renderToStaticMarkup(createElement(ResearchPanel, { meeting: sampleMeetings.find((m) => m.id === "MTG-consult")! }));
  assert.match(html, /Detect medical content/);
  assert.match(html, /Research a reviewed question/);
  assert.match(html, /never the transcript/);
  assert.match(html, /Fictional sample transcript/);
  assert.match(html, /disabled=""/, "controls are disabled until capabilities load");
});
