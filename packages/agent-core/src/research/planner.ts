/**
 * Builds the bounded research plan a reviewer approves before any external
 * call. Query generation is deterministic so the reviewer sees exactly what
 * will be sent, and the plan hash binds approval to that exact content.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  type PlannedQuery,
  type ResearchBudget,
  type ResearchPlan,
  type ResearchQuestionInput,
  type SynthesisDisclosure,
  RESEARCH_CONTRACT_VERSION,
  researchPlanSchema,
} from "./contract";

export const DEFAULT_BUDGET: ResearchBudget = {
  maxQueries: 3,
  maxResultsPerQuery: 5,
  maxSources: 8,
  maxPassageCharacters: 2000,
  deadlineMs: 45_000,
};

/** Health-evidence publishers used only to *focus* two of the queries; the first query is unrestricted. */
export const GUIDELINE_DOMAINS = [
  "who.int",
  "nice.org.uk",
  "cdc.gov",
  "nih.gov",
  "cochrane.org",
  "cochranelibrary.com",
];
export const PRIMARY_STUDY_DOMAINS = [
  "pubmed.ncbi.nlm.nih.gov",
  "ncbi.nlm.nih.gov",
  "cochranelibrary.com",
  "thelancet.com",
  "nejm.org",
  "bmj.com",
  "jamanetwork.com",
];

const JURISDICTION_DOMAINS: Record<string, string[]> = {
  uk: ["nice.org.uk", "gov.uk", "sign.ac.uk"],
  "united kingdom": ["nice.org.uk", "gov.uk", "sign.ac.uk"],
  england: ["nice.org.uk", "gov.uk"],
  us: ["cdc.gov", "nih.gov", "uspreventiveservicestaskforce.org"],
  usa: ["cdc.gov", "nih.gov", "uspreventiveservicestaskforce.org"],
  "united states": ["cdc.gov", "nih.gov", "uspreventiveservicestaskforce.org"],
  canada: ["canada.ca", "cmaj.ca"],
  australia: ["health.gov.au", "nhmrc.gov.au"],
  eu: ["ema.europa.eu", "ecdc.europa.eu"],
  europe: ["ema.europa.eu", "ecdc.europa.eu"],
};

export interface PlannerConfig {
  budget?: Partial<ResearchBudget>;
  searchProvider: { provider: "exa" | "fake"; searchType: string; configured: boolean };
  synthesis: SynthesisDisclosure;
  planTtlMs: number;
  now?: () => Date;
}

function toIsoStart(date: string) {
  return `${date}T00:00:00.000Z`;
}
function toIsoEnd(date: string) {
  return `${date}T23:59:59.999Z`;
}

/**
 * Heuristic reviewer prompts. These cannot prove a question is anonymous;
 * they exist to make the human review explicit, not to replace it.
 */
export function privacyFlags(input: ResearchQuestionInput): string[] {
  const flags: string[] = [];
  const q = input.question;
  if (/\b\d{1,3}\s*(?:-|–)?\s*(?:year|yr|yo|y\/o|month|week|day)s?(?:-|\s)?old\b/i.test(q))
    flags.push("Contains an age; combined with other details this can identify a patient.");
  if (/\b(?:19|20)\d{2}\b|\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/.test(q))
    flags.push("Contains a year or date; confirm it is not an encounter or birth date.");
  if (/\b\d{5,}\b/.test(q))
    flags.push("Contains a long number that could be a record, phone, or ID number.");
  if (/\b(?:my|our|this|the)\s+patient\b|\bpatient\s+(?:named|called|is)\b/i.test(q))
    flags.push("Refers to a specific patient; rephrase as a general clinical question.");
  if (/\b(?:[Mm]r|[Mm]rs|[Mm]s|[Dd]r|[Mm]iss)\.?\s+[A-Z][a-z]+/.test(q) || /@|https?:\/\//i.test(q))
    flags.push("Contains a name, email, or link; remove personal identifiers.");
  if (/\b(?:he|she|they)\s+(?:is|was|has|had)\b/i.test(q))
    flags.push("Describes an individual; consider a population-level phrasing.");
  const words = q.split(/\s+/).length;
  if (words > 60)
    flags.push("Long question; rare combinations of details can identify a person even without a name.");
  return flags;
}

function jurisdictionDomains(jurisdiction: string | undefined): string[] {
  if (!jurisdiction) return [];
  return JURISDICTION_DOMAINS[jurisdiction.trim().toLowerCase()] ?? [];
}

export function buildQueries(input: ResearchQuestionInput, maxQueries: number): PlannedQuery[] {
  const base = input.question.replace(/\s+/g, " ").trim();
  const dates = {
    ...(input.dateRange?.from ? { startPublishedDate: toIsoStart(input.dateRange.from) } : {}),
    ...(input.dateRange?.to ? { endPublishedDate: toIsoEnd(input.dateRange.to) } : {}),
  };
  const extra = jurisdictionDomains(input.jurisdiction);
  const jurisdictionText = input.jurisdiction ? ` ${input.jurisdiction.trim()}` : "";
  const candidates: PlannedQuery[] = [
    {
      id: "q1",
      text: base,
      purpose: "Broad public web search, no domain restriction.",
      ...dates,
    },
    {
      id: "q2",
      text: `${base} clinical guideline recommendations${jurisdictionText}`,
      purpose: "Guidelines and evidence summaries from public health and guideline bodies.",
      includeDomains: [...new Set([...GUIDELINE_DOMAINS, ...extra])],
      ...dates,
    },
    {
      id: "q3",
      text: `${base} systematic review OR randomized trial`,
      purpose: "Systematic reviews and primary studies in indexed journals.",
      includeDomains: PRIMARY_STUDY_DOMAINS,
      ...dates,
    },
    {
      id: "q4",
      text: `${base} observational study cohort`,
      purpose: "Observational evidence when trials are sparse.",
      includeDomains: PRIMARY_STUDY_DOMAINS,
      ...dates,
    },
    {
      id: "q5",
      text: `${base} preprint`,
      purpose: "Unreviewed preprints, labelled as such.",
      includeDomains: ["medrxiv.org", "biorxiv.org"],
      ...dates,
    },
  ];
  return candidates.slice(0, Math.max(1, Math.min(5, maxQueries)));
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Hash over everything that determines outbound traffic. Changing any of it needs a new plan. */
export function hashPlan(plan: Pick<ResearchPlan, "requestId" | "question" | "jurisdiction" | "dateRange" | "queries" | "budget" | "searchProvider" | "synthesis">): string {
  return createHash("sha256")
    .update(
      canonical({
        requestId: plan.requestId,
        question: plan.question,
        jurisdiction: plan.jurisdiction ?? null,
        dateRange: plan.dateRange ?? null,
        queries: plan.queries,
        budget: plan.budget,
        searchProvider: plan.searchProvider,
        synthesis: plan.synthesis,
      }),
    )
    .digest("hex");
}

export function buildPlan(input: ResearchQuestionInput, config: PlannerConfig): ResearchPlan {
  const now = (config.now ?? (() => new Date()))();
  const budget: ResearchBudget = { ...DEFAULT_BUDGET, ...config.budget };
  const queries = buildQueries(input, budget.maxQueries);
  const requestId = randomUUID();
  const disclosures = [
    `Approving sends the ${queries.length} quer${queries.length === 1 ? "y" : "ies"} listed above, verbatim, to ${config.searchProvider.provider === "exa" ? "Exa (api.exa.ai)" : "a test search provider"}. Nothing else from this session is sent.`,
    "No transcript, audio, snapshot, patient record, or identifier is included. Review the query text yourself: removing a name does not make rare details anonymous.",
    config.synthesis.provider === "none"
      ? "No language-model synthesis is configured. The result will list sources and passages only; no findings will be generated."
      : `After retrieval, the question and bounded passages from retrieved public pages are sent to ${config.synthesis.provider === "openai" ? `OpenAI (${config.synthesis.model ?? "configured model"})` : "a test synthesis provider"} to draft findings. Every finding is checked against the retrieved passages before it is returned.`,
    "Results are reference material for clinician review. The agent does not diagnose, prescribe, or message patients, and a bounded web search is not a systematic review.",
    "Retrieved pages are treated as untrusted data; instructions found inside them are never followed.",
  ];
  const partial = {
    requestId,
    question: input.question,
    jurisdiction: input.jurisdiction,
    dateRange: input.dateRange,
    queries,
    budget,
    searchProvider: config.searchProvider,
    synthesis: config.synthesis,
  };
  const plan: ResearchPlan = {
    contractVersion: RESEARCH_CONTRACT_VERSION,
    status: "awaiting_approval",
    ...partial,
    disclosures,
    privacyReview: { requiresHumanReview: true, flags: privacyFlags(input) },
    planHash: hashPlan(partial),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + config.planTtlMs).toISOString(),
  };
  return researchPlanSchema.parse(plan);
}
