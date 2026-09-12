/**
 * Executes an approved plan: bounded sequential searches, evidence assembly,
 * optional synthesis, and citation validation. It never reads the plan input
 * from anywhere but the approved plan object, and it never calls a provider
 * that the plan did not disclose.
 */
import {
  type EvidenceBrief,
  type EvidenceSource,
  type ExecutedQuery,
  type ResearchPlan,
  evidenceBriefSchema,
  RESEARCH_CONTRACT_VERSION,
} from "./contract";
import { synthesisOutputSchema, validateFindings } from "./citations";
import { assembleSources } from "./evidence";
import { SearchProviderError } from "./errors";
import type { RawSearchResult, SearchProvider, SynthesisProvider } from "./providers";

export interface PipelineDeps {
  search: SearchProvider;
  synthesis: SynthesisProvider | null;
  signal: AbortSignal;
  now?: () => Date;
  /** Per-query bound; defaults to QUERY_TIMEOUT_MS. */
  queryTimeoutMs?: number;
}

const STOP_ALL: ReadonlySet<string> = new Set([
  "unauthorized",
  "unconfigured",
  "credits_exhausted",
  "rate_limited",
  "timeout",
  "cancelled",
]);

/** One slow query must not consume the whole run; it fails alone and the rest continue. */
export const QUERY_TIMEOUT_MS = 20_000;

function querySignal(parent: AbortSignal, timeoutMs: number): { signal: AbortSignal; release(): void } {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    const error = new Error("The query timed out.");
    error.name = "QueryTimeoutError";
    controller.abort(error);
  }, timeoutMs);
  const forward = () => controller.abort(parent.reason);
  if (parent.aborted) forward();
  else parent.addEventListener("abort", forward, { once: true });
  return {
    signal: controller.signal,
    release() {
      clearTimeout(timer);
      parent.removeEventListener("abort", forward);
    },
  };
}

function baseLimitations(plan: ResearchPlan, sources: EvidenceSource[]): string[] {
  const limitations = [
    `This is a bounded public web search (${plan.queries.length} queries, at most ${plan.budget.maxResultsPerQuery} results each, ${plan.budget.maxSources} sources kept). It is not a systematic review and may miss relevant evidence.`,
    "Source types are heuristic labels from titles, URLs, and text; publication and peer-review status were not verified.",
    "Retrieved passages are excerpts. Study design, population, effect sizes, and dates should be confirmed in the original publication before clinical use.",
  ];
  if (sources.some((s) => s.access.contentKind === "abstract"))
    limitations.push("Some sources were retrieved as abstracts only.");
  if (sources.some((s) => s.access.contentKind === "none" || s.access.contentKind === "highlights_only"))
    limitations.push("Some sources had little or no retrievable content and are listed for follow-up only.");
  if (sources.some((s) => s.publishedDate === null))
    limitations.push("Publication dates are unknown for some sources.");
  if (sources.some((s) => s.sourceType === "preprint"))
    limitations.push("Preprints are included and have not been peer reviewed.");
  return limitations;
}

export async function executeResearch(plan: ResearchPlan, deps: PipelineDeps): Promise<EvidenceBrief> {
  const now = deps.now ?? (() => new Date());
  const researchedAt = now().toISOString();
  const executedQueries: ExecutedQuery[] = [];
  const hits: { queryId: string; result: RawSearchResult }[] = [];
  const warnings: string[] = [];
  let fatal: { code: string; message: string } | undefined;
  let stopped = false;

  for (const query of plan.queries) {
    if (stopped || deps.signal.aborted) {
      executedQueries.push({
        queryId: query.id,
        text: query.text,
        provider: deps.search.kind,
        status: "skipped",
        resultCount: 0,
        errorCode: fatal?.code ?? (deps.signal.aborted ? "cancelled" : "skipped"),
      });
      continue;
    }
    const scoped = querySignal(deps.signal, Math.min(deps.queryTimeoutMs ?? QUERY_TIMEOUT_MS, plan.budget.deadlineMs));
    try {
      const execution = await deps.search.search(query, {
        numResults: plan.budget.maxResultsPerQuery,
        maxCharacters: plan.budget.maxPassageCharacters,
        highlightQuery: plan.question,
        signal: scoped.signal,
      });
      const results = execution.results.slice(0, plan.budget.maxResultsPerQuery);
      executedQueries.push({
        queryId: query.id,
        text: query.text,
        provider: deps.search.kind,
        status: "ok",
        resultCount: results.length,
        ...(execution.providerRequestId ? { providerRequestId: execution.providerRequestId } : {}),
      });
      for (const result of results) hits.push({ queryId: query.id, result });
    } catch (error) {
      // A per-query timeout is a local failure unless the whole run was aborted.
      const queryTimedOut = scoped.signal.aborted && !deps.signal.aborted;
      const code = queryTimedOut
        ? "query_timeout"
        : error instanceof SearchProviderError
          ? error.code
          : "provider_error";
      const message =
        error instanceof SearchProviderError ? error.message : "The search provider failed.";
      executedQueries.push({
        queryId: query.id,
        text: query.text,
        provider: deps.search.kind,
        status: "failed",
        resultCount: 0,
        errorCode: code,
      });
      if (STOP_ALL.has(code)) {
        stopped = true;
        fatal = { code, message };
      } else {
        warnings.push(`Query ${query.id} failed (${code}); results are partial.`);
      }
    } finally {
      scoped.release();
    }
  }

  const cancelled = fatal?.code === "cancelled";
  const timedOut = fatal?.code === "timeout";
  if (fatal && !cancelled && !timedOut && hits.length > 0)
    warnings.push(`Search stopped early (${fatal.code}); results are partial.`);

  const assembled = assembleSources({
    question: plan.question,
    hits,
    retrievedAt: researchedAt,
    maxSources: plan.budget.maxSources,
    maxPassageCharacters: plan.budget.maxPassageCharacters,
  });
  const sources = assembled.sources;
  const okQueries = executedQueries.filter((q) => q.status === "ok").length;

  const scope = {
    description: `${okQueries} of ${plan.queries.length} planned queries ran against ${deps.search.kind} (${deps.search.searchType}).`,
    isSystematicReview: false as const,
    searchProvider: deps.search.kind,
    budget: plan.budget,
    discardedLowRelevance: assembled.discardedLowRelevance,
    duplicatesMerged: assembled.duplicatesMerged,
  };
  const common = {
    contractVersion: RESEARCH_CONTRACT_VERSION as typeof RESEARCH_CONTRACT_VERSION,
    requestId: plan.requestId,
    question: plan.question,
    ...(plan.jurisdiction ? { jurisdiction: plan.jurisdiction } : {}),
    ...(plan.dateRange ? { dateRange: plan.dateRange } : {}),
    researchedAt,
    executedQueries,
    scope,
    sources,
    conflictingFindings: [] as EvidenceBrief["conflictingFindings"],
    unansweredQuestions: [] as string[],
    uncertainties: [] as string[],
    warnings,
  };

  if (cancelled || timedOut) {
    return evidenceBriefSchema.parse({
      ...common,
      status: "cancelled",
      findings: [],
      limitations: [
        cancelled ? "Research was cancelled before completion." : "The research deadline passed before completion.",
        ...(sources.length ? ["Sources retrieved before the stop are listed; nothing was synthesized."] : []),
      ],
      synthesis: {
        provider: deps.synthesis?.kind ?? "none",
        ...(deps.synthesis ? { model: deps.synthesis.model } : {}),
        status: "unavailable",
        note: "Synthesis did not run.",
        rejectedFindings: 0,
      },
      error: { code: fatal!.code, message: fatal!.message },
    } satisfies EvidenceBrief);
  }

  if (fatal && hits.length === 0) {
    return evidenceBriefSchema.parse({
      ...common,
      status: "failed",
      findings: [],
      limitations: ["No evidence was retrieved because the search provider failed."],
      synthesis: {
        provider: deps.synthesis?.kind ?? "none",
        ...(deps.synthesis ? { model: deps.synthesis.model } : {}),
        status: "unavailable",
        note: "Synthesis did not run because no evidence was retrieved.",
        rejectedFindings: 0,
      },
      error: fatal,
    } satisfies EvidenceBrief);
  }

  const limitations = baseLimitations(plan, sources);
  if (sources.length === 0) {
    return evidenceBriefSchema.parse({
      ...common,
      status: "sources_only",
      findings: [],
      limitations: [
        ...limitations,
        okQueries === 0
          ? "No query completed successfully."
          : "The searches returned no relevant public sources. Reformulate the question or widen the date range.",
      ],
      synthesis: {
        provider: deps.synthesis?.kind ?? "none",
        ...(deps.synthesis ? { model: deps.synthesis.model } : {}),
        status: "unavailable",
        note: "Synthesis did not run because there were no sources to cite.",
        rejectedFindings: 0,
      },
    } satisfies EvidenceBrief);
  }

  const citable = sources.filter((s) => s.passages.length > 0 && s.access.contentKind !== "none");
  if (!deps.synthesis || !deps.synthesis.configured || citable.length === 0) {
    return evidenceBriefSchema.parse({
      ...common,
      status: "sources_only",
      findings: [],
      limitations: [
        ...limitations,
        !deps.synthesis || !deps.synthesis.configured
          ? "No synthesis provider is configured; this brief lists sources and passages without generated findings."
          : "No source had citable content, so no findings were generated.",
      ],
      synthesis: {
        provider: deps.synthesis?.kind ?? "none",
        ...(deps.synthesis ? { model: deps.synthesis.model } : {}),
        status: "unavailable",
        note: "Sources-only result.",
        rejectedFindings: 0,
      },
    } satisfies EvidenceBrief);
  }

  let raw: unknown;
  try {
    raw = await deps.synthesis.synthesize(
      {
        question: plan.question,
        ...(plan.jurisdiction ? { jurisdiction: plan.jurisdiction } : {}),
        sources: citable.map((s) => ({
          id: s.id,
          title: s.title,
          sourceType: s.sourceType,
          publishedDate: s.publishedDate,
          passages: s.passages.map((p) => ({ id: p.id, text: p.text })),
        })),
      },
      deps.signal,
    );
  } catch (error) {
    const aborted = deps.signal.aborted;
    return evidenceBriefSchema.parse({
      ...common,
      status: aborted ? "cancelled" : "sources_only",
      findings: [],
      limitations: [
        ...limitations,
        aborted ? "Research was cancelled during synthesis." : "Synthesis failed; this brief lists sources and passages only.",
      ],
      synthesis: {
        provider: deps.synthesis.kind,
        model: deps.synthesis.model,
        status: "failed",
        note: aborted
          ? "Synthesis was interrupted."
          : `The synthesis provider (${deps.synthesis.kind}) returned an error. Sources are unaffected.`,
        rejectedFindings: 0,
      },
      ...(aborted ? { error: { code: "cancelled", message: "Research was cancelled." } } : {}),
    } satisfies EvidenceBrief);
  }

  const parsed = synthesisOutputSchema.safeParse(raw);
  if (!parsed.success) {
    return evidenceBriefSchema.parse({
      ...common,
      status: "sources_only",
      findings: [],
      limitations: [...limitations, "Synthesis output did not match the contract and was discarded."],
      synthesis: {
        provider: deps.synthesis.kind,
        model: deps.synthesis.model,
        status: "rejected",
        note: "Malformed synthesis output was rejected. Sources are unaffected.",
        rejectedFindings: 0,
      },
    } satisfies EvidenceBrief);
  }

  const validated = validateFindings(parsed.data, sources);
  const uncertainties = [...parsed.data.limitations];
  if (validated.rejected.length)
    warnings.push(
      `${validated.rejected.length} synthesized finding(s) were rejected because their citations could not be verified against retrieved passages.`,
    );
  return evidenceBriefSchema.parse({
    ...common,
    status: validated.findings.length ? "completed" : "sources_only",
    findings: validated.findings,
    conflictingFindings: validated.conflicting,
    unansweredQuestions: parsed.data.unansweredQuestions,
    limitations: [
      ...limitations,
      ...(validated.findings.length
        ? []
        : ["Every synthesized finding was rejected during citation validation; review the sources directly."]),
    ],
    uncertainties,
    synthesis: {
      provider: deps.synthesis.kind,
      model: deps.synthesis.model,
      status: "completed",
      note: validated.findings.length
        ? "Findings were generated by the synthesis provider and each citation was verified as a verbatim passage span."
        : "Synthesis ran but produced no verifiable findings.",
      rejectedFindings: validated.rejected.length,
    },
  } satisfies EvidenceBrief);
}
