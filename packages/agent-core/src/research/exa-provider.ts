/**
 * Exa search adapter for the research pipeline (exa-js 2.19, `/search` with
 * inline contents). Non-deep search types only: the deep-* profiles run Exa's
 * own LLM synthesis, which would be an undisclosed second synthesis provider.
 *
 * The installed SDK does not accept an AbortSignal, so cancellation and the
 * deadline are enforced by racing the call: a late response is discarded, but
 * the outbound HTTP request itself is not torn down.
 */
import { Exa, ExaError } from "exa-js";
import type { PlannedQuery } from "./contract";
import { SearchProviderError } from "./errors";
import {
  abortError,
  raceWithSignal,
  type SearchExecution,
  type SearchOptions,
  type SearchProvider,
} from "./providers";

export const RESEARCH_SEARCH_TYPES = [
  "instant",
  "fast",
  "auto",
  "keyword",
  "neural",
  "hybrid",
] as const;
export type ResearchSearchType = (typeof RESEARCH_SEARCH_TYPES)[number];

export function resolveSearchType(
  value: string | undefined,
  fallback: ResearchSearchType = "auto",
): ResearchSearchType {
  return (RESEARCH_SEARCH_TYPES as readonly string[]).includes(value ?? "")
    ? (value as ResearchSearchType)
    : fallback;
}

/** Maps Exa's error envelope to the closed code set; never forwards its message. */
export function classifyExaError(error: unknown): SearchProviderError {
  if (error instanceof ExaError) {
    const code = (error.code ?? error.type ?? "").toUpperCase();
    if (
      error.statusCode === 402 ||
      code === "NO_MORE_CREDITS" ||
      code.endsWith("BUDGET_EXCEEDED")
    )
      return new SearchProviderError(
        "credits_exhausted",
        "The search provider reports exhausted credits or budget.",
      );
    if (error.statusCode === 429 || code === "RATE_LIMIT_EXCEEDED")
      return new SearchProviderError(
        "rate_limited",
        "The search provider rate limit was reached.",
      );
    if (error.statusCode === 401 || error.statusCode === 403 || code === "INVALID_API_KEY")
      return new SearchProviderError(
        "unauthorized",
        "The search provider rejected the configured credentials.",
      );
    return new SearchProviderError(
      "provider_error",
      `The search provider returned HTTP ${error.statusCode}.`,
    );
  }
  if (error instanceof SearchProviderError) return error;
  return new SearchProviderError(
    "provider_error",
    "The search provider could not be reached.",
  );
}

export function createExaSearchProvider(options: {
  apiKey: string | undefined;
  searchType?: string;
  client?: Pick<Exa, "search">;
}): SearchProvider {
  const apiKey = options.apiKey?.trim();
  const searchType = resolveSearchType(options.searchType);
  const client = apiKey ? (options.client ?? new Exa(apiKey)) : undefined;
  return {
    kind: "exa",
    searchType,
    configured: Boolean(client),
    async search(query: PlannedQuery, search: SearchOptions): Promise<SearchExecution> {
      if (!client)
        throw new SearchProviderError(
          "unconfigured",
          "EXA_API_KEY is not configured on the server.",
        );
      const call = client.search(query.text, {
        type: searchType,
        numResults: search.numResults,
        ...(query.includeDomains?.length ? { includeDomains: query.includeDomains } : {}),
        ...(query.startPublishedDate ? { startPublishedDate: query.startPublishedDate } : {}),
        ...(query.endPublishedDate ? { endPublishedDate: query.endPublishedDate } : {}),
        contents: {
          text: { maxCharacters: search.maxCharacters },
          highlights: { query: search.highlightQuery, maxCharacters: 600 },
          filterEmptyResults: false,
        },
      });
      let response: Awaited<typeof call>;
      try {
        response = await raceWithSignal(call, search.signal, () => abortError(search.signal));
      } catch (error) {
        throw classifyExaError(error);
      }
      return {
        providerRequestId: response.requestId,
        results: response.results.map((hit) => ({
          url: hit.url,
          title: hit.title,
          publishedDate: hit.publishedDate,
          author: hit.author,
          text: typeof hit.text === "string" ? hit.text : undefined,
          highlights: Array.isArray(hit.highlights) ? hit.highlights : undefined,
          providerId: hit.id,
        })),
      };
    },
  };
}
