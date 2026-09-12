/**
 * Research agent contract: Zod schemas and types shared by the server pipeline
 * and any frontend consumer. Isomorphic — no Node imports. Import from
 * `agent-core/research-contract` in browser code.
 *
 * Vocabulary:
 * - A *plan* is the exact set of outbound queries and disclosures a human must
 *   approve before any external call is made.
 * - A *brief* is the structured result: sources with passages, findings that
 *   cite those passages, and explicit limitations.
 */
import { z } from "zod";

export const RESEARCH_CONTRACT_VERSION = "1" as const;

/** Session-facing lifecycle of one research request. */
export const researchStatusSchema = z.enum([
  "awaiting_approval",
  "declined",
  "running",
  "completed",
  "sources_only",
  "failed",
  "cancelled",
  "expired",
]);
export type ResearchStatus = z.infer<typeof researchStatusSchema>;

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.")
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)), {
    message: "Not a calendar date.",
  });

export const dateRangeSchema = z
  .object({ from: isoDate.optional(), to: isoDate.optional() })
  .strict()
  .refine((range) => !range.from || !range.to || range.from <= range.to, {
    message: "`from` must not be after `to`.",
  });
export type DateRange = z.infer<typeof dateRangeSchema>;

/**
 * The only thing a caller may submit. It is a minimized public question, not a
 * transcript, snapshot, or record. Length is bounded so a pasted transcript
 * cannot pass as a question.
 */
export const researchQuestionInputSchema = z
  .object({
    question: z.string().trim().min(12).max(600),
    jurisdiction: z.string().trim().min(2).max(80).optional(),
    dateRange: dateRangeSchema.optional(),
  })
  .strict();
export type ResearchQuestionInput = z.infer<typeof researchQuestionInputSchema>;

export const plannedQuerySchema = z
  .object({
    id: z.string().min(1),
    text: z.string().min(1).max(700),
    purpose: z.string().min(1).max(200),
    includeDomains: z.array(z.string()).max(20).optional(),
    startPublishedDate: z.string().optional(),
    endPublishedDate: z.string().optional(),
  })
  .strict();
export type PlannedQuery = z.infer<typeof plannedQuerySchema>;

export const researchBudgetSchema = z
  .object({
    maxQueries: z.number().int().min(1).max(5),
    maxResultsPerQuery: z.number().int().min(1).max(10),
    maxSources: z.number().int().min(1).max(20),
    maxPassageCharacters: z.number().int().min(200).max(4000),
    deadlineMs: z.number().int().min(1000).max(120_000),
  })
  .strict();
export type ResearchBudget = z.infer<typeof researchBudgetSchema>;

export const synthesisDisclosureSchema = z
  .object({
    provider: z.enum(["none", "openai", "fake"]),
    model: z.string().optional(),
    /** Exactly what leaves the endpoint if synthesis runs. */
    dataSent: z.array(z.string()),
    configured: z.boolean(),
  })
  .strict();
export type SynthesisDisclosure = z.infer<typeof synthesisDisclosureSchema>;

export const researchPlanSchema = z
  .object({
    contractVersion: z.literal(RESEARCH_CONTRACT_VERSION),
    requestId: z.uuid(),
    status: z.literal("awaiting_approval"),
    question: z.string(),
    jurisdiction: z.string().optional(),
    dateRange: dateRangeSchema.optional(),
    queries: z.array(plannedQuerySchema).min(1).max(5),
    budget: researchBudgetSchema,
    searchProvider: z
      .object({
        provider: z.enum(["exa", "fake"]),
        searchType: z.string(),
        configured: z.boolean(),
      })
      .strict(),
    synthesis: synthesisDisclosureSchema,
    /** Plain-language disclosures a reviewer must read before approving. */
    disclosures: z.array(z.string()),
    privacyReview: z
      .object({
        requiresHumanReview: z.literal(true),
        /** Heuristic flags only; absence of flags is not proof of anonymity. */
        flags: z.array(z.string()),
      })
      .strict(),
    /** SHA-256 over the outbound-relevant fields; approval must echo it. */
    planHash: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: z.string(),
    expiresAt: z.string(),
  })
  .strict();
export type ResearchPlan = z.infer<typeof researchPlanSchema>;

export const sourceTypeSchema = z.enum([
  "guideline",
  "systematic_review",
  "randomized_trial",
  "observational_study",
  "preprint",
  "commentary",
  "other",
  "unknown",
]);
export type SourceType = z.infer<typeof sourceTypeSchema>;

export const passageSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["highlight", "text_excerpt"]),
    text: z.string(),
  })
  .strict();
export type Passage = z.infer<typeof passageSchema>;

export const evidenceSourceSchema = z
  .object({
    id: z.string(),
    url: z.string(),
    /** Other URLs merged into this source during de-duplication. */
    duplicateUrls: z.array(z.string()),
    title: z.string(),
    domain: z.string(),
    /** ISO date from the provider when known; null when the provider gave none. */
    publishedDate: z.string().nullable(),
    publishedDateBasis: z.enum(["provider_metadata", "unknown"]),
    retrievedAt: z.string(),
    sourceType: sourceTypeSchema,
    /** Heuristic classification from title/URL/text; never a verified label. */
    sourceTypeBasis: z.literal("heuristic"),
    publicationStatus: z.enum(["unverified", "preprint_unverified"]),
    access: z
      .object({
        contentKind: z.enum([
          "text_excerpt",
          "abstract",
          "highlights_only",
          "none",
        ]),
        characters: z.number().int().min(0),
        limitation: z.string(),
      })
      .strict(),
    relevance: z
      .object({
        score: z.number().min(0).max(1),
        basis: z.literal("question_term_overlap"),
        queryIds: z.array(z.string()),
      })
      .strict(),
    passages: z.array(passageSchema),
    /** Untrusted-content notices, e.g. instruction-like text inside the page. */
    warnings: z.array(z.string()),
  })
  .strict();
export type EvidenceSource = z.infer<typeof evidenceSourceSchema>;

export const citationSchema = z
  .object({
    sourceId: z.string(),
    passageId: z.string(),
    /** Verbatim span from the passage that supports the claim. */
    quote: z.string().min(1),
  })
  .strict();
export type Citation = z.infer<typeof citationSchema>;

export const findingSchema = z
  .object({
    id: z.string(),
    /** `retrieved_fact` restates a source; `interpretation` is the agent's reading. */
    kind: z.enum(["retrieved_fact", "interpretation"]),
    claim: z.string().min(1).max(600),
    citations: z.array(citationSchema).min(1),
    confidence: z.enum(["low", "medium", "high"]),
  })
  .strict();
export type Finding = z.infer<typeof findingSchema>;

export const executedQuerySchema = z
  .object({
    queryId: z.string(),
    text: z.string(),
    provider: z.enum(["exa", "fake"]),
    status: z.enum(["ok", "failed", "skipped"]),
    resultCount: z.number().int().min(0),
    errorCode: z.string().optional(),
    providerRequestId: z.string().optional(),
  })
  .strict();
export type ExecutedQuery = z.infer<typeof executedQuerySchema>;

export const evidenceBriefSchema = z
  .object({
    contractVersion: z.literal(RESEARCH_CONTRACT_VERSION),
    requestId: z.uuid(),
    status: z.enum(["completed", "sources_only", "failed", "cancelled"]),
    question: z.string(),
    jurisdiction: z.string().optional(),
    dateRange: dateRangeSchema.optional(),
    researchedAt: z.string(),
    executedQueries: z.array(executedQuerySchema),
    scope: z
      .object({
        description: z.string(),
        /** Always false: a bounded web search is not a systematic review. */
        isSystematicReview: z.literal(false),
        searchProvider: z.string(),
        budget: researchBudgetSchema,
        discardedLowRelevance: z.number().int().min(0),
        duplicatesMerged: z.number().int().min(0),
      })
      .strict(),
    findings: z.array(findingSchema),
    sources: z.array(evidenceSourceSchema),
    conflictingFindings: z.array(
      z
        .object({ description: z.string(), sourceIds: z.array(z.string()).min(1) })
        .strict(),
    ),
    unansweredQuestions: z.array(z.string()),
    limitations: z.array(z.string()),
    uncertainties: z.array(z.string()),
    synthesis: z
      .object({
        provider: z.enum(["none", "openai", "fake"]),
        model: z.string().optional(),
        status: z.enum(["completed", "unavailable", "failed", "rejected"]),
        note: z.string(),
        rejectedFindings: z.number().int().min(0),
      })
      .strict(),
    warnings: z.array(z.string()),
    error: z
      .object({ code: z.string(), message: z.string() })
      .strict()
      .optional(),
  })
  .strict();
export type EvidenceBrief = z.infer<typeof evidenceBriefSchema>;

/** Session-visible state for one request; returned by status reads. */
export const researchRecordViewSchema = z
  .object({
    requestId: z.uuid(),
    status: researchStatusSchema,
    plan: researchPlanSchema.optional(),
    brief: evidenceBriefSchema.optional(),
    startedAt: z.string().optional(),
    finishedAt: z.string().optional(),
  })
  .strict();
export type ResearchRecordView = z.infer<typeof researchRecordViewSchema>;



/** Controlled error codes; messages are safe to show in a browser. */
export const researchErrorCodeSchema = z.enum([
  "invalid_request",
  "not_found",
  "plan_mismatch",
  "already_decided",
  "expired",
  "not_running",
  "search_unconfigured",
  "budget_exhausted",
  "too_many_requests",
  "detection_unconfigured",
  "detection_failed",
]);
export type ResearchErrorCode = z.infer<typeof researchErrorCodeSchema>;

/* ------------------------- transcript medical-content detection ------------------------- */

/**
 * Input for the transcript scan. This is the one operation that sends meeting
 * text to a cloud model, so it must be triggered by an explicit user action
 * with a visible disclosure; the server never calls it on its own.
 */
export const detectionInputSchema = z
  .object({
    meetingId: z.string().trim().min(1).max(120),
    transcript: z.string().min(1).max(50_000),
  })
  .strict();
export type DetectionInput = z.infer<typeof detectionInputSchema>;

export const medicalTopicSchema = z
  .object({
    topic: z.string().min(1).max(160),
    category: z.enum(["symptom", "condition", "medication", "treatment", "test", "lifestyle", "other"]),
    /** Verbatim transcript span; validated server-side, never invented. */
    evidence: z.string().min(1).max(400),
  })
  .strict();
export type MedicalTopic = z.infer<typeof medicalTopicSchema>;

export const suggestedQuestionSchema = z
  .object({
    question: z.string().min(12).max(600),
    rationale: z.string().min(1).max(300),
    /** Heuristic privacy flags from the planner; the reviewer still decides. */
    privacyFlags: z.array(z.string()),
  })
  .strict();
export type SuggestedQuestion = z.infer<typeof suggestedQuestionSchema>;

export const medicalDetectionSchema = z
  .object({
    meetingId: z.string(),
    detectedAt: z.string(),
    detector: z.object({ provider: z.enum(["openai", "fake"]), model: z.string() }).strict(),
    /** Characters of transcript actually sent; the rest was truncated. */
    scannedCharacters: z.number().int().min(0),
    truncated: z.boolean(),
    medicalContentDetected: z.boolean(),
    confidence: z.enum(["low", "medium", "high"]),
    summary: z.string().max(600),
    topics: z.array(medicalTopicSchema).max(12),
    suggestedQuestions: z.array(suggestedQuestionSchema).max(6),
    /** Topics the model returned whose evidence was not found verbatim in the transcript. */
    rejectedTopics: z.number().int().min(0),
    warnings: z.array(z.string()),
  })
  .strict();
export type MedicalDetection = z.infer<typeof medicalDetectionSchema>;

/** HTTP command envelope accepted by POST /api/research. */
export const researchCommandSchema = z.discriminatedUnion("operation", [
  z
    .object({ operation: z.literal("prepare"), input: researchQuestionInputSchema })
    .strict(),
  z
    .object({
      operation: z.literal("approve"),
      requestId: z.uuid(),
      planHash: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
  z.object({ operation: z.literal("decline"), requestId: z.uuid() }).strict(),
  z.object({ operation: z.literal("cancel"), requestId: z.uuid() }).strict(),
  z.object({ operation: z.literal("detect"), input: detectionInputSchema }).strict(),
]);
export type ResearchCommand = z.infer<typeof researchCommandSchema>;
