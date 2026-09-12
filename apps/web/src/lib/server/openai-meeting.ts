import { z } from "zod";
import { meetingPrompt } from "./openai-meeting-prompt";
import {
  meetingResultSchema,
  parseMeetingResult,
  type MeetingResult,
} from "../local-ai/result-schema";

export const openAIMeetingRequestSchema = z
  .object({
    meetingId: z.string().min(1).max(120),
    transcript: z.string().min(1).max(50000),
    question: z.string().trim().min(1).max(1000),
    structured: z.boolean(),
  })
  .strict();

const openAIResponseSchema = z.object({
  output: z.array(
    z.object({
      type: z.string(),
      content: z
        .array(z.object({ type: z.string(), text: z.string().optional() }))
        .optional(),
    }),
  ),
});

const recapJSONSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "decisions", "actions", "questions"],
  properties: {
    summary: { type: "string" },
    decisions: {
      type: "array",
      maxItems: 6,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "evidence"],
        properties: {
          text: { type: "string" },
          evidence: { type: "string" },
        },
      },
    },
    actions: {
      type: "array",
      maxItems: 6,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "description", "owner", "due", "evidence"],
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          owner: { type: "string" },
          due: { type: "string" },
          evidence: { type: "string" },
        },
      },
    },
    questions: {
      type: "array",
      maxItems: 6,
      items: { type: "string" },
    },
  },
} as const;

type GenerateOptions = {
  apiKey: string;
  model: string;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
};

export type OpenAIMeetingResponse = {
  text: string;
  result?: MeetingResult;
};

function outputText(payload: unknown) {
  const response = openAIResponseSchema.parse(payload);
  return response.output
    .flatMap((item) => item.content ?? [])
    .filter((item) => item.type === "output_text")
    .map((item) => item.text ?? "")
    .join("\n")
    .trim();
}

export async function generateOpenAIMeeting(
  input: z.infer<typeof openAIMeetingRequestSchema>,
  { apiKey, model, fetcher = fetch, signal }: GenerateOptions,
): Promise<OpenAIMeetingResponse> {
  const messages = meetingPrompt(
    input.transcript,
    input.question,
    input.structured,
  );
  const instructions = String(messages[0]?.content ?? "");
  const request = String(messages[1]?.content ?? "");
  const response = await fetcher("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      instructions,
      input: request,
      max_output_tokens: input.structured ? 1800 : 1000,
      store: false,
      ...(input.structured
        ? {
            text: {
              format: {
                type: "json_schema",
                name: "hablabla_meeting_recap",
                strict: true,
                schema: recapJSONSchema,
              },
            },
          }
        : {}),
    }),
    signal,
  });
  if (!response.ok)
    throw new Error(`OpenAI request failed with HTTP ${response.status}.`);
  const raw = outputText(await response.json());
  if (!raw) throw new Error("OpenAI returned no text.");
  if (!input.structured) return { text: raw };
  const result = parseMeetingResult(raw, input.transcript);
  return {
    text: `Your recap is ready. I found ${result.decisions.length} decisions and ${result.actions.length} suggested actions. Review the recap and the evidence before saving anything.`,
    result: meetingResultSchema.parse(result),
  };
}

export function configuredOpenAIModel(
  env: { OPENAI_MODEL?: string } = { OPENAI_MODEL: process.env.OPENAI_MODEL },
) {
  return env.OPENAI_MODEL?.trim() || "gpt-5.6-sol";
}
