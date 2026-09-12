import assert from "node:assert/strict";
import test from "node:test";
import { meetingPrompt } from "./meeting-prompt";
import { parseMeetingResult } from "./result-schema";
import { exampleRecaps } from "../meeting-examples";
import { sampleMeetings } from "../meetings";
import { WebGPUAgent } from "./webgpu-agent";
import { modelRuntime } from "./model-runtime";

const result = exampleRecaps["MTG-launch"];
test("structured results reject invented evidence and malformed output", () => {
  assert.deepEqual(
    parseMeetingResult(JSON.stringify(result), sampleMeetings[0].transcript),
    result,
  );
  assert.throws(
    () => parseMeetingResult(JSON.stringify(result), "An unrelated meeting."),
    /evidence/,
  );
  assert.throws(() => parseMeetingResult('{"summary":"incomplete"}', ""));
  assert.throws(() => parseMeetingResult("not json", ""));
});
test("prompt bounds UTF-8 input and reserves generation room even for multibyte text", () => {
  for (const structured of [true, false]) {
    const messages = meetingPrompt(
      "🪴 private transcript ".repeat(10000),
      "Question ".repeat(1000),
      structured,
    );
    const bytes = new TextEncoder().encode(
      messages.map((message) => message.content).join(""),
    ).length;
    assert.ok(bytes < 2900);
    assert.ok(String(messages[0].content).includes("untrusted data"));
    assert.ok(!String(messages[1].content).includes("�"));
  }
});
test("local agent streams responses and associates validated cards with the selected meeting", async () => {
  const original = modelRuntime.generate;
  try {
    modelRuntime.generate = async function* () {
      yield "Hello ";
      yield "locally.";
    };
    const agent = new WebGPUAgent();
    agent.addMessage({
      role: "user",
      id: "message-1",
      content: "What happened?",
    });
    await agent.runAgent({
      forwardedProps: {
        meetingId: "MTG-launch",
        transcript: sampleMeetings[0].transcript,
        structured: false,
      },
    });
    assert.equal(agent.messages.at(-1)?.content, "Hello locally.");
    modelRuntime.generate = async function* () {
      yield JSON.stringify(result);
    };
    await agent.runAgent({
      forwardedProps: {
        meetingId: "MTG-launch",
        transcript: sampleMeetings[0].transcript,
        structured: true,
      },
    });
    assert.equal(agent.state.meetingId, "MTG-launch");
    assert.deepEqual(agent.state.result, result);
  } finally {
    modelRuntime.generate = original;
  }
});
