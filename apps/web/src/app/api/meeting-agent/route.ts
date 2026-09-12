import {
  configuredOpenAIModel,
  generateOpenAIMeeting,
  openAIMeetingRequestSchema,
} from "@/lib/server/openai-meeting";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({
    configured: Boolean(process.env.OPENAI_API_KEY?.trim()),
    model: configuredOpenAIModel(),
  });
}

export async function POST(request: Request) {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey)
    return Response.json(
      {
        error:
          "OpenAI mode isn't configured. Add OPENAI_API_KEY to the root .env and restart Hablabla.",
      },
      { status: 503 },
    );
  try {
    const input = openAIMeetingRequestSchema.parse(await request.json());
    return Response.json(
      await generateOpenAIMeeting(input, {
        apiKey,
        model: configuredOpenAIModel(),
        signal: request.signal,
      }),
    );
  } catch (error) {
    const message =
      error instanceof z.ZodError
        ? "The meeting request was invalid. Nothing was sent to OpenAI."
        : error instanceof Error && error.name === "AbortError"
          ? "OpenAI generation stopped."
          : "OpenAI couldn't complete this request. Check the API key, model access, and account balance, then try again.";
    return Response.json({ error: message }, { status: 502 });
  }
}
