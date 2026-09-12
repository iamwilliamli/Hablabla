/**
 * Server-held research sessions. A plan is stored against the requesting
 * session; approval must come from the same session, echo the plan hash,
 * arrive before expiry, and happen once. Execution runs in the background
 * with a deadline and can be cancelled. Nothing external is called until
 * `approve` succeeds.
 */
import {
  type DetectionInput,
  type EvidenceBrief,
  type MedicalDetection,
  type ResearchBudget,
  type ResearchPlan,
  type ResearchQuestionInput,
  type ResearchRecordView,
  type ResearchStatus,
  detectionInputSchema,
  researchQuestionInputSchema,
} from "./contract";
import { DetectionFailure, detectMedicalContent, type DetectorProvider } from "./detector";
import { ResearchError } from "./errors";
import { executeResearch } from "./pipeline";
import { buildPlan, DEFAULT_BUDGET } from "./planner";
import type { SearchProvider, SynthesisProvider } from "./providers";

export interface ResearchServiceOptions {
  search: SearchProvider;
  synthesis: SynthesisProvider | null;
  /** Optional transcript scanner; only runs on an explicit `detect` call. */
  detector?: DetectorProvider | null;
  budget?: Partial<ResearchBudget>;
  /** Plan approval window. Default 10 minutes. */
  planTtlMs?: number;
  /** How long finished records stay readable. Default 30 minutes. */
  resultTtlMs?: number;
  /** Rolling search budget: at most `maxSearches` provider queries per `windowMs`. */
  searchBudget?: { maxSearches: number; windowMs: number };
  /** Rolling transcript-scan budget. Default 30 per hour. */
  detectBudget?: { maxDetections: number; windowMs: number };
  detectDeadlineMs?: number;
  maxPendingPerSession?: number;
  maxRecords?: number;
  now?: () => Date;
}

interface ResearchRecord {
  sessionId: string;
  status: ResearchStatus;
  plan: ResearchPlan;
  brief?: EvidenceBrief;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  controller?: AbortController;
  run?: Promise<void>;
}

const SESSION_PATTERN = /^[a-f0-9]{64}$/;

export class ResearchService {
  private readonly records = new Map<string, ResearchRecord>();
  private readonly searchTimestamps: number[] = [];
  private readonly detectTimestamps: number[] = [];
  private readonly now: () => Date;
  private readonly planTtlMs: number;
  private readonly resultTtlMs: number;
  private readonly searchBudget: { maxSearches: number; windowMs: number };
  private readonly detectBudget: { maxDetections: number; windowMs: number };
  private readonly detectDeadlineMs: number;
  private readonly maxPendingPerSession: number;
  private readonly maxRecords: number;
  readonly budget: ResearchBudget;

  constructor(private readonly options: ResearchServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.planTtlMs = options.planTtlMs ?? 10 * 60_000;
    this.resultTtlMs = options.resultTtlMs ?? 30 * 60_000;
    this.searchBudget = options.searchBudget ?? { maxSearches: 60, windowMs: 60 * 60_000 };
    this.detectBudget = options.detectBudget ?? { maxDetections: 30, windowMs: 60 * 60_000 };
    this.detectDeadlineMs = options.detectDeadlineMs ?? 30_000;
    this.maxPendingPerSession = options.maxPendingPerSession ?? 5;
    this.maxRecords = options.maxRecords ?? 200;
    this.budget = { ...DEFAULT_BUDGET, ...options.budget };
  }

  capabilities() {
    return {
      search: {
        provider: this.options.search.kind,
        searchType: this.options.search.searchType,
        configured: this.options.search.configured,
      },
      synthesis: {
        provider: this.options.synthesis?.kind ?? ("none" as const),
        ...(this.options.synthesis ? { model: this.options.synthesis.model } : {}),
        configured: this.options.synthesis?.configured ?? false,
      },
      detection: {
        provider: this.options.detector?.kind ?? ("none" as const),
        ...(this.options.detector ? { model: this.options.detector.model } : {}),
        configured: this.options.detector?.configured ?? false,
        maxTranscriptCharacters: 16_000,
      },
      budget: this.budget,
      searchBudget: { ...this.searchBudget, remaining: this.remainingSearches() },
    };
  }

  private remainingDetections(): number {
    const cutoff = this.now().getTime() - this.detectBudget.windowMs;
    while (this.detectTimestamps.length && (this.detectTimestamps[0] ?? 0) < cutoff)
      this.detectTimestamps.shift();
    return Math.max(0, this.detectBudget.maxDetections - this.detectTimestamps.length);
  }

  /**
   * Scans a transcript for medical content with the configured detector.
   * This is the only path that sends meeting text to a model, and it runs
   * only when a caller explicitly asks. Nothing is stored server-side.
   */
  async detect(sessionId: string, rawInput: unknown): Promise<MedicalDetection> {
    this.assertSession(sessionId);
    const input: DetectionInput = detectionInputSchema.parse(rawInput);
    const detector = this.options.detector;
    if (!detector || !detector.configured)
      throw new ResearchError("detection_unconfigured", "Transcript scanning is not configured on this server (OPENAI_API_KEY). Nothing was sent.");
    if (this.remainingDetections() < 1)
      throw new ResearchError("budget_exhausted", "The server's transcript-scan budget for this period is exhausted. Nothing was sent.");
    this.detectTimestamps.push(this.now().getTime());
    const controller = new AbortController();
    const deadline = setTimeout(() => {
      const error = new Error("The scan deadline passed.");
      error.name = "TimeoutError";
      controller.abort(error);
    }, this.detectDeadlineMs);
    try {
      return await detectMedicalContent(input, { detector, signal: controller.signal, now: this.now });
    } catch (error) {
      if (error instanceof DetectionFailure)
        throw new ResearchError(error.code === "unconfigured" ? "detection_unconfigured" : "detection_failed", error.message);
      throw error;
    } finally {
      clearTimeout(deadline);
    }
  }

  private assertSession(sessionId: string) {
    if (!SESSION_PATTERN.test(sessionId))
      throw new ResearchError("invalid_request", "A browser session is required.");
  }

  private remainingSearches(): number {
    const cutoff = this.now().getTime() - this.searchBudget.windowMs;
    while (this.searchTimestamps.length && (this.searchTimestamps[0] ?? 0) < cutoff)
      this.searchTimestamps.shift();
    return Math.max(0, this.searchBudget.maxSearches - this.searchTimestamps.length);
  }

  /** Builds and stores a plan. Makes no external call. */
  prepare(sessionId: string, rawInput: unknown): ResearchPlan {
    this.assertSession(sessionId);
    this.sweep();
    const input: ResearchQuestionInput = researchQuestionInputSchema.parse(rawInput);
    const pending = [...this.records.values()].filter(
      (r) => r.sessionId === sessionId && (r.status === "awaiting_approval" || r.status === "running"),
    );
    if (pending.length >= this.maxPendingPerSession)
      throw new ResearchError(
        "too_many_requests",
        "Too many open research requests in this session. Decline or wait for them first.",
      );
    if (this.records.size >= this.maxRecords)
      throw new ResearchError("too_many_requests", "The research service is at capacity. Try again later.");
    const plan = buildPlan(input, {
      budget: this.budget,
      searchProvider: {
        provider: this.options.search.kind,
        searchType: this.options.search.searchType,
        configured: this.options.search.configured,
      },
      synthesis: {
        provider: this.options.synthesis?.kind ?? "none",
        ...(this.options.synthesis ? { model: this.options.synthesis.model } : {}),
        configured: this.options.synthesis?.configured ?? false,
        dataSent: this.options.synthesis
          ? ["research question", "jurisdiction (if given)", "source titles, heuristic types, dates", "bounded passages from retrieved public pages"]
          : [],
      },
      planTtlMs: this.planTtlMs,
      now: this.now,
    });
    this.records.set(plan.requestId, {
      sessionId,
      status: "awaiting_approval",
      plan,
      createdAt: this.now().getTime(),
    });
    return plan;
  }

  private lookup(sessionId: string, requestId: string): ResearchRecord {
    this.assertSession(sessionId);
    this.sweep();
    const record = this.records.get(requestId);
    // Cross-session lookups are indistinguishable from unknown IDs on purpose.
    if (!record || record.sessionId !== sessionId)
      throw new ResearchError("not_found", "No research request with that ID exists in this session.");
    return record;
  }

  view(sessionId: string, requestId: string): ResearchRecordView {
    const record = this.lookup(sessionId, requestId);
    return {
      requestId,
      status: record.status,
      plan: record.plan,
      ...(record.brief ? { brief: record.brief } : {}),
      ...(record.startedAt ? { startedAt: new Date(record.startedAt).toISOString() } : {}),
      ...(record.finishedAt ? { finishedAt: new Date(record.finishedAt).toISOString() } : {}),
    };
  }

  decline(sessionId: string, requestId: string): ResearchRecordView {
    const record = this.lookup(sessionId, requestId);
    if (record.status !== "awaiting_approval")
      throw new ResearchError("already_decided", `This request is ${record.status.replace("_", " ")} and cannot be declined.`);
    record.status = "declined";
    record.finishedAt = this.now().getTime();
    return this.view(sessionId, requestId);
  }

  /**
   * Approves exactly the stored plan and starts research in the background.
   * Rejects hash mismatches, expired plans, and repeated approvals.
   */
  approve(sessionId: string, requestId: string, planHash: string): ResearchRecordView {
    const record = this.lookup(sessionId, requestId);
    if (record.status === "expired")
      throw new ResearchError("expired", "This plan expired before approval. Prepare a new plan.");
    if (record.status !== "awaiting_approval")
      throw new ResearchError("already_decided", `This request is already ${record.status.replace("_", " ")}; approval cannot be repeated.`);
    if (planHash !== record.plan.planHash)
      throw new ResearchError(
        "plan_mismatch",
        "The approved plan does not match the stored plan. Review and approve the current plan, or prepare a new one.",
      );
    if (!this.options.search.configured)
      throw new ResearchError("search_unconfigured", "Search is not configured on this server (EXA_API_KEY). No request was sent.");
    const needed = record.plan.queries.length;
    if (this.remainingSearches() < needed)
      throw new ResearchError(
        "budget_exhausted",
        "The server's search budget for this period is exhausted. No request was sent.",
      );
    const startedAt = this.now().getTime();
    for (let i = 0; i < needed; i++) this.searchTimestamps.push(startedAt);
    const controller = new AbortController();
    record.controller = controller;
    record.status = "running";
    record.startedAt = startedAt;
    const deadline = setTimeout(() => {
      const error = new Error("The research deadline passed.");
      error.name = "TimeoutError";
      controller.abort(error);
    }, record.plan.budget.deadlineMs);
    record.run = executeResearch(record.plan, {
      search: this.options.search,
      synthesis: this.options.synthesis,
      signal: controller.signal,
      now: this.now,
    })
      .then((brief) => {
        record.brief = brief;
        record.status = brief.status;
      })
      .catch(() => {
        record.status = "failed";
        record.brief = undefined;
      })
      .finally(() => {
        clearTimeout(deadline);
        record.finishedAt = this.now().getTime();
        record.controller = undefined;
      });
    return this.view(sessionId, requestId);
  }

  async cancel(sessionId: string, requestId: string): Promise<ResearchRecordView> {
    const record = this.lookup(sessionId, requestId);
    if (record.status !== "running" || !record.controller)
      throw new ResearchError("not_running", "Only a running research request can be cancelled.");
    record.controller.abort(new Error("Cancelled by the user."));
    await record.run;
    return this.view(sessionId, requestId);
  }

  /** Waits for a running request to settle; tests and smoke checks use this. */
  async settle(sessionId: string, requestId: string): Promise<ResearchRecordView> {
    const record = this.lookup(sessionId, requestId);
    await record.run;
    return this.view(sessionId, requestId);
  }

  /** Expires unapproved plans and forgets old finished records. */
  sweep(): void {
    const now = this.now().getTime();
    for (const [id, record] of this.records) {
      if (record.status === "awaiting_approval" && now >= Date.parse(record.plan.expiresAt)) {
        record.status = "expired";
        record.finishedAt = now;
      }
      if (record.status !== "running" && record.status !== "awaiting_approval") {
        const reference = record.finishedAt ?? record.createdAt;
        if (now - reference >= this.resultTtlMs) this.records.delete(id);
      }
    }
  }
}
