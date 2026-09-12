/**
 * Turns raw provider hits into labelled evidence sources: URL canonicalisation
 * and de-duplication, heuristic source typing, honest access labels, bounded
 * passages, term-overlap relevance, and untrusted-content warnings.
 *
 * Nothing here interprets the evidence. Labels are derived from metadata and
 * text patterns and are reported as heuristic in the contract.
 */
import type { EvidenceSource, Passage, SourceType } from "./contract";
import type { RawSearchResult } from "./providers";

const STOPWORDS = new Set(
  "a an and are as at be by for from has have in is it its of on or that the to was were what when which who with does do how should can could would than then this these those there their vs versus into over under between among after before during about not no".split(
    " ",
  ),
);

export function contentTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .map((token) => token.replace(/^-+|-+$/g, ""))
    .filter((token) => token.length > 2 && !STOPWORDS.has(token));
}

/** Question-term overlap in [0,1]; deliberately simple and explainable. */
export function relevanceScore(question: string, candidate: string): number {
  const wanted = new Set(contentTokens(question));
  if (wanted.size === 0) return 0;
  const seen = new Set(contentTokens(candidate));
  let hits = 0;
  for (const token of wanted) if (seen.has(token)) hits++;
  return Math.round((hits / wanted.size) * 1000) / 1000;
}

const TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$|ref$|source$)/i;

export function canonicalUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    for (const key of [...url.searchParams.keys()])
      if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
    url.searchParams.sort();
    let pathname = url.pathname.replace(/\/+$/, "");
    if (pathname === "") pathname = "/";
    url.pathname = pathname;
    return url.toString();
  } catch {
    return raw.trim();
  }
}

export function registrableDomain(hostname: string): string {
  const parts = hostname.toLowerCase().replace(/^www\./, "").split(".");
  if (parts.length <= 2) return parts.join(".");
  // Handle common second-level public suffixes such as ac.uk / gov.au / co.uk.
  const secondLevel = new Set(["ac", "co", "gov", "org", "nhs", "edu", "com", "net"]);
  const last = parts[parts.length - 1] ?? "";
  const penultimate = parts[parts.length - 2] ?? "";
  if (last.length === 2 && secondLevel.has(penultimate)) return parts.slice(-3).join(".");
  return parts.slice(-2).join(".");
}

function normalizedTitle(title: string | null): string {
  return (title ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** Guideline/public-health publishers; membership alone never sets evidence quality. */
const GUIDELINE_HOSTS = [
  "who.int",
  "nice.org.uk",
  "cdc.gov",
  "sign.ac.uk",
  "uspreventiveservicestaskforce.org",
  "ema.europa.eu",
];
const PREPRINT_HOSTS = ["medrxiv.org", "biorxiv.org", "researchsquare.com", "ssrn.com", "arxiv.org"];

export function classifySourceType(input: {
  url: string;
  title: string;
  text: string;
}): SourceType {
  const host = (() => {
    try {
      return new URL(input.url).hostname.toLowerCase();
    } catch {
      return "";
    }
  })();
  const head = `${input.title}\n${input.text.slice(0, 1500)}`.toLowerCase();
  const title = input.title.toLowerCase();
  if (PREPRINT_HOSTS.some((h) => host === h || host.endsWith(`.${h}`)) || /\bpreprint\b/.test(head))
    return "preprint";
  if (/\b(systematic review|meta-analysis|meta analysis|cochrane review|umbrella review|network meta)/.test(head))
    return "systematic_review";
  if (/\b(randomi[sz]ed|randomised controlled|randomized controlled|\bRCT\b|placebo-controlled|double-blind)/i.test(head))
    return "randomized_trial";
  if (/\b(cohort study|case-control|cross-sectional|observational study|retrospective|registry study|prospective study)/.test(head))
    return "observational_study";
  if (/\b(editorial|commentary|opinion|perspective|viewpoint|letter to the editor|blog|news release|press release)\b/.test(title) || /\/(blog|news|opinion)\//.test(input.url))
    return "commentary";
  if (/\b(guideline|guidelines|guidance|recommendation|recommendations|consensus statement|position statement)\b/.test(title) || GUIDELINE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`)))
    return "guideline";
  if (!input.title && !input.text) return "unknown";
  return "other";
}

/** Phrases that mark page text as instruction-like. Flagged only; never executed. */
const INJECTION_PATTERNS = [
  /ignore (all |any )?(previous|prior|above) (instructions|prompts)/i,
  /\byou are (now )?(an?|the) (assistant|ai|model)\b/i,
  /\bsystem prompt\b/i,
  /\b(call|invoke|use) (the )?(tool|function|api)\b/i,
  /\b(send|email|message|forward) (this|the) (patient|user|record|data)\b/i,
  /\bdo not (tell|inform) the (user|doctor|clinician)\b/i,
  /<\s*(script|iframe)\b/i,
];

export function untrustedContentWarnings(text: string): string[] {
  const warnings: string[] = [];
  if (INJECTION_PATTERNS.some((pattern) => pattern.test(text)))
    warnings.push(
      "Page text contains instruction-like phrases. It was treated as data only; nothing in it was followed.",
    );
  return warnings;
}

export interface BuiltSource {
  source: EvidenceSource;
  /** Ids of queries that returned this URL, used to explain provenance. */
  queryIds: Set<string>;
}

function squash(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

export function buildPassages(
  sourceId: string,
  raw: RawSearchResult,
  maxPassageCharacters: number,
): Passage[] {
  const passages: Passage[] = [];
  let index = 0;
  const seen = new Set<string>();
  for (const highlight of raw.highlights ?? []) {
    const text = squash(highlight).slice(0, 600);
    if (text.length < 20 || seen.has(text)) continue;
    seen.add(text);
    passages.push({ id: `${sourceId}-p${++index}`, kind: "highlight", text });
    if (passages.length >= 3) break;
  }
  if (raw.text) {
    const text = squash(raw.text).slice(0, maxPassageCharacters);
    if (text.length >= 20 && !seen.has(text))
      passages.push({ id: `${sourceId}-p${++index}`, kind: "text_excerpt", text });
  }
  return passages;
}

function accessLabel(raw: RawSearchResult, host: string) {
  const textLength = raw.text?.trim().length ?? 0;
  const highlightCount = raw.highlights?.filter((h) => h.trim().length > 0).length ?? 0;
  if (textLength === 0 && highlightCount === 0)
    return {
      contentKind: "none" as const,
      characters: 0,
      limitation:
        "No page content was retrievable; only the title and URL are known. Do not cite this source for specific claims.",
    };
  if (/(^|\.)pubmed\.ncbi\.nlm\.nih\.gov$/.test(host) || (textLength > 0 && textLength < 1200))
    return {
      contentKind: "abstract" as const,
      characters: textLength,
      limitation:
        "Only an abstract or short excerpt was retrieved; full text, methods, and effect estimates were not verified.",
    };
  if (textLength === 0)
    return {
      contentKind: "highlights_only" as const,
      characters: 0,
      limitation:
        "Only provider highlights were retrieved, not the page text. Context around each passage is unverified.",
    };
  return {
    contentKind: "text_excerpt" as const,
    characters: textLength,
    limitation:
      "A bounded excerpt of the page text was retrieved; it may not be the complete document.",
  };
}

/**
 * Merge raw hits across queries into ranked, de-duplicated sources.
 * Returns the kept sources plus counts for the scope section.
 */
export function assembleSources(input: {
  question: string;
  hits: { queryId: string; result: RawSearchResult }[];
  retrievedAt: string;
  maxSources: number;
  maxPassageCharacters: number;
  minRelevance?: number;
}): { sources: EvidenceSource[]; duplicatesMerged: number; discardedLowRelevance: number } {
  const minRelevance = input.minRelevance ?? 0.1;
  const groups = new Map<
    string,
    { raw: RawSearchResult; urls: Set<string>; queryIds: Set<string> }
  >();
  let duplicatesMerged = 0;
  const titleKeys = new Map<string, string>();
  for (const { queryId, result } of input.hits) {
    const url = canonicalUrl(result.url);
    let host = "";
    try {
      host = new URL(url).hostname;
    } catch {
      continue;
    }
    const titleKey = `${registrableDomain(host)}|${normalizedTitle(result.title)}`;
    const key = groups.has(url)
      ? url
      : normalizedTitle(result.title).length > 12 && titleKeys.has(titleKey)
        ? titleKeys.get(titleKey)!
        : url;
    const existing = groups.get(key);
    if (existing) {
      duplicatesMerged++;
      existing.urls.add(url);
      existing.queryIds.add(queryId);
      // Keep the richer content when a duplicate carries more text.
      if ((result.text?.length ?? 0) > (existing.raw.text?.length ?? 0)) existing.raw = { ...existing.raw, text: result.text, highlights: result.highlights ?? existing.raw.highlights };
      if (!existing.raw.publishedDate && result.publishedDate) existing.raw.publishedDate = result.publishedDate;
      continue;
    }
    groups.set(key, { raw: { ...result, url }, urls: new Set([url]), queryIds: new Set([queryId]) });
    if (normalizedTitle(result.title).length > 12) titleKeys.set(titleKey, key);
  }

  const scored = [...groups.values()].map((group) => {
    const title = group.raw.title?.trim() || group.raw.url;
    const text = group.raw.text ?? "";
    const highlights = (group.raw.highlights ?? []).join(" ");
    const score = relevanceScore(input.question, `${title} ${highlights} ${text.slice(0, 4000)}`);
    return { group, title, text, score };
  });
  const relevant = scored.filter((entry) => entry.score >= minRelevance);
  const discardedLowRelevance = scored.length - relevant.length;
  relevant.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));

  const sources: EvidenceSource[] = relevant.slice(0, input.maxSources).map((entry, index) => {
    const id = `S${index + 1}`;
    const url = entry.group.raw.url;
    const host = new URL(url).hostname;
    const sourceType = classifySourceType({ url, title: entry.title, text: entry.text });
    const publishedDate = entry.group.raw.publishedDate && !Number.isNaN(Date.parse(entry.group.raw.publishedDate))
      ? entry.group.raw.publishedDate
      : null;
    return {
      id,
      url,
      duplicateUrls: [...entry.group.urls].filter((u) => u !== url),
      title: entry.title,
      domain: host,
      publishedDate,
      publishedDateBasis: publishedDate ? "provider_metadata" : "unknown",
      retrievedAt: input.retrievedAt,
      sourceType,
      sourceTypeBasis: "heuristic",
      publicationStatus: sourceType === "preprint" ? "preprint_unverified" : "unverified",
      access: accessLabel(entry.group.raw, host),
      relevance: {
        score: entry.score,
        basis: "question_term_overlap",
        queryIds: [...entry.group.queryIds].sort(),
      },
      passages: buildPassages(id, entry.group.raw, input.maxPassageCharacters),
      warnings: untrustedContentWarnings(`${entry.title}\n${(entry.group.raw.highlights ?? []).join("\n")}\n${entry.text}`),
    };
  });
  return { sources, duplicatesMerged, discardedLowRelevance };
}
