import type { ResearchErrorCode } from "./contract";

/** Controlled, browser-safe service errors. Never wrap raw provider text. */
export class ResearchError extends Error {
  constructor(
    readonly code: ResearchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ResearchError";
  }
}

export type SearchProviderErrorCode =
  | "unconfigured"
  | "unauthorized"
  | "rate_limited"
  | "credits_exhausted"
  | "timeout"
  | "cancelled"
  | "provider_error";

/** Search failures are mapped to a small closed set so the brief can report them honestly. */
export class SearchProviderError extends Error {
  constructor(
    readonly code: SearchProviderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SearchProviderError";
  }
}
