/**
 * Provider interfaces for the research pipeline plus deterministic fakes.
 *
 * The pipeline only ever sees these interfaces, so tests can prove behaviour
 * (zero calls before approval, partial retrieval, malformed output) without
 * network access. The Exa adapter lives in `exa-provider.ts`; the OpenAI
 * synthesis adapter lives in `openai-synthesis.ts`.
 */
import { SearchProviderError, type SearchProviderErrorCode } from "./errors";
import type { PlannedQuery } from "./contract";

export interface RawSearchResult {
  url: string;
  title: string | null;
  publishedDate?: string;
  author?: string;
  text?: string;
  highlights?: string[];
  providerId?: string;
}

export interface SearchExecution {
  results: RawSearchResult[];
  providerRequestId?: string;
}

export interface SearchOptions {
  numResults: number;
  maxCharacters: number;
  /** Question text used to focus highlight extraction. */
  highlightQuery: string;
  signal: AbortSignal;
}

export interface SearchProvider {
  readonly kind: "exa" | "fake";
  readonly searchType: string;
  readonly configured: boolean;
  search(query: PlannedQuery, options: SearchOptions): Promise<SearchExecution>;
}

/** What the synthesis provider receives: only IDs, titles, and bounded passages. */
export interface SynthesisSource {
  id: string;
  title: string;
  sourceType: string;
  publishedDate: string | null;
  passages: { id: string; text: string }[];
}

export interface SynthesisInput {
  question: string;
  jurisdiction?: string;
  sources: SynthesisSource[];
}

export interface SynthesisProvider {
  readonly kind: "openai" | "fake";
  readonly model: string;
  readonly configured: boolean;
  /** Returns raw JSON; the pipeline validates it and every citation. */
  synthesize(input: SynthesisInput, signal: AbortSignal): Promise<unknown>;
}

/** Resolves with the operation result or rejects when the signal aborts first. */
export function raceWithSignal<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  onAbort: () => Error,
): Promise<T> {
  if (signal.aborted) return Promise.reject(onAbort());
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(onAbort());
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

export function abortError(signal: AbortSignal): SearchProviderError {
  const reason = signal.reason;
  const code: SearchProviderErrorCode =
    reason instanceof Error && (reason.name === "TimeoutError" || reason.name === "QueryTimeoutError")
      ? "timeout"
      : "cancelled";
  return new SearchProviderError(
    code,
    code === "timeout" ? "The research deadline passed." : "Research was cancelled.",
  );
}

/* ----------------------------- deterministic fakes ----------------------------- */

export type FakeSearchBehaviour =
  | { kind: "results"; results: RawSearchResult[] }
  | { kind: "error"; code: SearchProviderErrorCode }
  | { kind: "hang" };

export interface FakeSearchProviderOptions {
  configured?: boolean;
  /** Behaviour per planned query id; `default` applies otherwise. */
  byQueryId?: Record<string, FakeSearchBehaviour>;
  default?: FakeSearchBehaviour;
}

/** Records every call so tests can assert "no external call before approval". */
export class FakeSearchProvider implements SearchProvider {
  readonly kind = "fake" as const;
  readonly searchType = "fake";
  readonly configured: boolean;
  readonly calls: { query: PlannedQuery; options: Omit<SearchOptions, "signal"> }[] = [];
  private readonly options: FakeSearchProviderOptions;

  constructor(options: FakeSearchProviderOptions = {}) {
    this.options = options;
    this.configured = options.configured ?? true;
  }

  async search(query: PlannedQuery, options: SearchOptions): Promise<SearchExecution> {
    const { signal, ...rest } = options;
    this.calls.push({ query, options: rest });
    if (!this.configured)
      throw new SearchProviderError("unconfigured", "Search is not configured.");
    const behaviour =
      this.options.byQueryId?.[query.id] ??
      this.options.default ?? { kind: "results", results: [] };
    if (behaviour.kind === "error")
      throw new SearchProviderError(behaviour.code, `fake ${behaviour.code}`);
    if (behaviour.kind === "hang")
      return raceWithSignal(new Promise<never>(() => {}), signal, () => abortError(signal));
    if (signal.aborted) throw abortError(signal);
    return {
      results: behaviour.results.map((result) => ({ ...result })),
      providerRequestId: `fake-${query.id}`,
    };
  }
}

export type FakeSynthesisBehaviour =
  | { kind: "output"; output: unknown }
  | { kind: "output_from"; build: (input: SynthesisInput) => unknown }
  | { kind: "error" }
  | { kind: "hang" };

export class FakeSynthesisProvider implements SynthesisProvider {
  readonly kind = "fake" as const;
  readonly model = "fake-synthesis";
  readonly configured = true;
  readonly calls: SynthesisInput[] = [];

  constructor(private readonly behaviour: FakeSynthesisBehaviour) {}

  async synthesize(input: SynthesisInput, signal: AbortSignal): Promise<unknown> {
    this.calls.push(input);
    if (this.behaviour.kind === "error") throw new Error("fake synthesis failure");
    if (this.behaviour.kind === "hang")
      return raceWithSignal(new Promise<never>(() => {}), signal, () => abortError(signal));
    if (this.behaviour.kind === "output_from") return this.behaviour.build(input);
    return this.behaviour.output;
  }
}
