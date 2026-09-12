import { z } from "zod";

export const meetingResultSchema = z.object({
  summary: z.string().trim().min(1).max(1200),
  decisions: z
    .array(
      z.object({
        text: z.string().min(1).max(500),
        evidence: z.string().min(1).max(700),
      }),
    )
    .max(6),
  actions: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(200),
        description: z.string().trim().min(1).max(1000),
        owner: z.string().max(100),
        due: z.string().max(100),
        evidence: z.string().min(1).max(700),
      }),
    )
    .max(6),
  questions: z.array(z.string().min(1).max(500)).max(6),
});
export type MeetingResult = z.infer<typeof meetingResultSchema>;

const normalize = (text: string) =>
  text.replace(/\s+/g, " ").trim().toLowerCase();

export function parseMeetingResult(
  raw: string,
  transcript: string,
): MeetingResult {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/, "")
    .replace(/\s*```$/, "");
  const result = meetingResultSchema.parse(JSON.parse(cleaned));
  const source = normalize(transcript);
  for (const item of [...result.decisions, ...result.actions]) {
    if (!source.includes(normalize(item.evidence))) {
      throw new Error(
        "The result contained evidence that could not be found in this transcript.",
      );
    }
  }
  return result;
}
