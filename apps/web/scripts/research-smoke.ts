/**
 * Live smoke check for the research agent. Uses the real env-configured
 * providers. Prints the plan and exits unless `--approve` is passed, so the
 * exact outbound queries can be reviewed first.
 *
 *   npm run check:research -- "Generic clinical question here" [--approve] [--jurisdiction UK] [--from 2020-01-01] [--to 2026-12-31]
 *
 * Use only fictional or generic questions. Never paste transcripts or patient details.
 */
import { randomBytes } from "node:crypto";
import { createResearchServiceFromEnv } from "../src/lib/server/research-config";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const approve = args.includes("--approve");
const question = args.find((a, i) => !a.startsWith("--") && (i === 0 || !args[i - 1]?.startsWith("--")));
if (!question) {
  console.error("Usage: research-smoke.ts \"question\" [--approve] [--jurisdiction X] [--from YYYY-MM-DD] [--to YYYY-MM-DD]");
  process.exit(2);
}

const service = createResearchServiceFromEnv();
const session = randomBytes(32).toString("hex");
console.log("capabilities:", JSON.stringify(service.capabilities(), null, 2));
const plan = service.prepare(session, {
  question,
  ...(flag("--jurisdiction") ? { jurisdiction: flag("--jurisdiction") } : {}),
  ...(flag("--from") || flag("--to")
    ? { dateRange: { ...(flag("--from") ? { from: flag("--from") } : {}), ...(flag("--to") ? { to: flag("--to") } : {}) } }
    : {}),
});
console.log("\nPLAN (review before approving):");
for (const q of plan.queries) console.log(`  ${q.id}: ${JSON.stringify(q.text)} domains=${q.includeDomains?.join(",") ?? "any"}`);
for (const d of plan.disclosures) console.log(`  - ${d}`);
if (plan.privacyReview.flags.length) console.log("  privacy flags:", plan.privacyReview.flags);
if (!approve) {
  console.log("\nNothing was sent. Re-run with --approve to execute exactly this plan.");
  process.exit(0);
}
async function run() {
service.approve(session, plan.requestId, plan.planHash);
const started = Date.now();
const view = await service.settle(session, plan.requestId);
console.log(`\nSTATUS ${view.status} in ${Date.now() - started}ms`);
const brief = view.brief;
if (!brief) process.exit(1);
console.log("executed:", brief.executedQueries.map((q) => `${q.queryId}:${q.status}(${q.resultCount})${q.errorCode ? ":" + q.errorCode : ""}`).join(" "));
console.log("scope:", brief.scope.description, `merged=${brief.scope.duplicatesMerged} discarded=${brief.scope.discardedLowRelevance}`);
for (const s of brief.sources)
  console.log(`  ${s.id} [${s.sourceType}/${s.access.contentKind}/${s.publishedDate ?? "date unknown"}] rel=${s.relevance.score} ${s.title} <${s.url}> passages=${s.passages.length}${s.warnings.length ? " ⚠" : ""}`);
console.log("synthesis:", brief.synthesis);
for (const f of brief.findings)
  console.log(`  ${f.id} (${f.kind}, ${f.confidence}) ${f.claim}\n     cites ${f.citations.map((c) => `${c.sourceId}/${c.passageId}`).join(", ")}`);
if (brief.conflictingFindings.length) console.log("conflicts:", brief.conflictingFindings);
if (brief.unansweredQuestions.length) console.log("unanswered:", brief.unansweredQuestions);
console.log("limitations:", brief.limitations);
if (brief.warnings.length) console.log("warnings:", brief.warnings);
if (brief.error) console.log("error:", brief.error);
}
void run();
