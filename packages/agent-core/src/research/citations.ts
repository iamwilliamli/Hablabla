/**
 * Validates synthesis output against the retrieved evidence.
 *
 * A citation passes only when (1) the source and passage IDs exist, (2) the
 * quote is a verbatim span of that passage, and (3) the claim shares content
 * terms with the quote. Matching IDs alone never make a claim supported.
 */
import { z } from "zod";
import {
  type EvidenceSource,
  type Finding,
  findingSchema,
} from "./contract";
import { contentTokens } from "./evidence";

/** Shape the synthesis provider must return; anything else is a synthesis failure. */
export const synthesisOutputSchema = z
  .object({
    findings: z
      .array(
        z
          .object({
            kind: z.enum(["retrieved_fact", "interpretation"]),
            claim: z.string().min(1).max(600),
            citations: z
              .array(
                z
                  .object({
                    sourceId: z.string(),
                    passageId: z.string(),
                    quote: z.string().min(1).max(600),
                  })
                  .strict(),
              )
              .max(6),
            confidence: z.enum(["low", "medium", "high"]),
          })
          .strict(),
      )
      .max(12),
    conflictingFindings: z
      .array(
        z.object({ description: z.string().min(1).max(600), sourceIds: z.array(z.string()).max(8) }).strict(),
      )
      .max(6),
    limitations: z.array(z.string().min(1).max(400)).max(10),
    unansweredQuestions: z.array(z.string().min(1).max(400)).max(10),
  })
  .strict();
export type SynthesisOutput = z.infer<typeof synthesisOutputSchema>;

function normalize(text: string) {
  return text.toLowerCase().replace(/[“”"'‘’]/g, "").replace(/\s+/g, " ").trim();
}

export interface CitationRejection {
  claim: string;
  reason: string;
}

export function validateCitation(
  citation: { sourceId: string; passageId: string; quote: string },
  claim: string,
  sources: EvidenceSource[],
): string | null {
  const source = sources.find((s) => s.id === citation.sourceId);
  if (!source) return `unknown source ${citation.sourceId}`;
  const passage = source.passages.find((p) => p.id === citation.passageId);
  if (!passage) return `unknown passage ${citation.passageId}`;
  if (source.access.contentKind === "none") return `source ${source.id} has no retrieved content`;
  const quote = normalize(citation.quote);
  if (quote.length < 15) return "quote too short to verify";
  if (!normalize(passage.text).includes(quote)) return "quote is not verbatim from the passage";
  const claimTokens = new Set(contentTokens(claim));
  const quoteTokens = new Set(contentTokens(citation.quote));
  if (claimTokens.size === 0) return "claim has no content terms";
  let shared = 0;
  for (const token of claimTokens) if (quoteTokens.has(token)) shared++;
  if (shared < Math.min(2, claimTokens.size) || shared / claimTokens.size < 0.15)
    return "quote does not support the claim (insufficient shared content)";
  return null;
}

export function validateFindings(
  output: SynthesisOutput,
  sources: EvidenceSource[],
): { findings: Finding[]; rejected: CitationRejection[]; conflicting: SynthesisOutput["conflictingFindings"] } {
  const findings: Finding[] = [];
  const rejected: CitationRejection[] = [];
  const knownIds = new Set(sources.map((s) => s.id));
  output.findings.forEach((candidate, index) => {
    const reasons: string[] = [];
    const citations = candidate.citations.filter((citation) => {
      const reason = validateCitation(citation, candidate.claim, sources);
      if (reason) reasons.push(reason);
      return !reason;
    });
    if (citations.length === 0) {
      rejected.push({
        claim: candidate.claim,
        reason: reasons.length ? reasons.join("; ") : "no citations supplied",
      });
      return;
    }
    // Interpretations must still point at the evidence they interpret.
    const finding = findingSchema.safeParse({
      id: `F${index + 1}`,
      kind: candidate.kind,
      claim: candidate.claim,
      citations,
      confidence: candidate.confidence,
    });
    if (finding.success) findings.push(finding.data);
    else rejected.push({ claim: candidate.claim, reason: "finding failed contract validation" });
  });
  // Conflicts may only reference sources that exist and were cited or retrieved.
  const conflicting = output.conflictingFindings
    .map((conflict) => ({
      description: conflict.description,
      sourceIds: conflict.sourceIds.filter((id) => knownIds.has(id)),
    }))
    .filter((conflict) => conflict.sourceIds.length > 0);
  return { findings: findings.map((f, i) => ({ ...f, id: `F${i + 1}` })), rejected, conflicting };
}
