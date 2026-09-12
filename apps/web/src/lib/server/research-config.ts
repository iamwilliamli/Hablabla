/**
 * Builds the research service from server environment variables. Read only on
 * the server; nothing here is exposed to the browser bundle.
 */
import {
  createExaSearchProvider,
  createOpenAIDetector,
  createOpenAISynthesisProvider,
  DEFAULT_BUDGET,
  ResearchService,
  type ResearchBudget,
} from "agent-core/research";

function bounded(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function researchBudgetFromEnv(env: Record<string, string | undefined> = process.env): ResearchBudget {
  return {
    maxQueries: bounded(env.RESEARCH_MAX_QUERIES, DEFAULT_BUDGET.maxQueries, 1, 5),
    maxResultsPerQuery: bounded(env.RESEARCH_MAX_RESULTS_PER_QUERY, DEFAULT_BUDGET.maxResultsPerQuery, 1, 10),
    maxSources: bounded(env.RESEARCH_MAX_SOURCES, DEFAULT_BUDGET.maxSources, 1, 20),
    maxPassageCharacters: bounded(env.RESEARCH_MAX_PASSAGE_CHARACTERS, DEFAULT_BUDGET.maxPassageCharacters, 200, 4000),
    deadlineMs: bounded(env.RESEARCH_DEADLINE_MS, DEFAULT_BUDGET.deadlineMs, 1000, 120_000),
  };
}

export function createResearchServiceFromEnv(env: Record<string, string | undefined> = process.env): ResearchService {
  const search = createExaSearchProvider({
    apiKey: env.EXA_API_KEY,
    searchType: env.RESEARCH_EXA_SEARCH_TYPE,
  });
  // No silent cloud fallback: synthesis exists only when explicitly selected.
  const synthesis =
    env.RESEARCH_SYNTHESIS_PROVIDER?.trim() === "openai"
      ? createOpenAISynthesisProvider({
          apiKey: env.OPENAI_API_KEY,
          model: env.RESEARCH_OPENAI_MODEL?.trim() || env.OPENAI_MODEL?.trim() || "gpt-5.6-sol",
        })
      : null;
  // Transcript scanning runs only on an explicit user action and is disclosed in the UI.
  const detector = env.OPENAI_API_KEY?.trim()
    ? createOpenAIDetector({ apiKey: env.OPENAI_API_KEY, model: env.RESEARCH_DETECT_MODEL })
    : null;
  return new ResearchService({
    search,
    synthesis,
    detector,
    budget: researchBudgetFromEnv(env),
    searchBudget: {
      maxSearches: bounded(env.RESEARCH_MAX_SEARCHES_PER_HOUR, 60, 1, 1000),
      windowMs: 60 * 60_000,
    },
    detectBudget: {
      maxDetections: bounded(env.RESEARCH_MAX_SCANS_PER_HOUR, 30, 1, 1000),
      windowMs: 60 * 60_000,
    },
  });
}
