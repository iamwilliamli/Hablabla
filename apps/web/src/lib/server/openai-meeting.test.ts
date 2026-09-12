import assert from "node:assert/strict";
import test from "node:test";
import { exampleRecaps } from "../meeting-examples";
import { sampleMeetings } from "../meetings";
import {
  configuredOpenAIModel,
  generateOpenAIMeeting,
} from "./openai-meeting";

function responseWith(text: string) {
  return new Response(
    JSON.stringify({
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text }],
        },
      ],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

test("OpenAI meeting requests keep the key server-side and disable response storage", async () => {
  let url = "";
  let authorization = "";
  let body: Record<string, unknown> = {};
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    url = String(input);
    authorization = new Headers(init?.headers).get("Authorization") ?? "";
    body = JSON.parse(String(init?.body));
    return responseWith("Maya committed to send the launch brief.");
  }) as typeof fetch;
  const output = await generateOpenAIMeeting(
    {
      meetingId: "MTG-launch",
      transcript: sampleMeetings[0].transcript,
      question: "What did Maya commit to?",
      structured: false,
    },
    { apiKey: "sk-test", model: "gpt-test", fetcher },
  );
  assert.equal(url, "https://api.openai.com/v1/responses");
  assert.equal(authorization, "Bearer sk-test");
  assert.equal(body.model, "gpt-test");
  assert.equal(body.store, false);
  assert.match(String(body.instructions), /using OpenAI/);
  assert.doesNotMatch(String(body.instructions), /running locally/);
  assert.match(String(body.input), /MEETING DATA/);
  assert.equal(output.text, "Maya committed to send the launch brief.");
});

test("OpenAI structured recaps are grounded before reaching the browser", async () => {
  const recap = exampleRecaps["MTG-launch"];
  let body: Record<string, unknown> = {};
  const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return responseWith(JSON.stringify(recap));
  }) as typeof fetch;
  const output = await generateOpenAIMeeting(
    {
      meetingId: "MTG-launch",
      transcript: sampleMeetings[0].transcript,
      question: "Create a recap.",
      structured: true,
    },
    { apiKey: "sk-test", model: "gpt-test", fetcher },
  );
  assert.deepEqual(output.result, recap);
  assert.match(output.text, /recap is ready/);
  assert.equal(
    (body.text as { format: { type: string } }).format.type,
    "json_schema",
  );
});

test("OpenAI model configuration has a dedicated safe default", () => {
  assert.equal(configuredOpenAIModel({}), "gpt-5.6-sol");
  assert.equal(
    configuredOpenAIModel({ OPENAI_MODEL: " gpt-custom " }),
    "gpt-custom",
  );
});
