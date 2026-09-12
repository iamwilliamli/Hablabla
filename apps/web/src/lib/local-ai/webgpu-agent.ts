import {
  AbstractAgent,
  EventType,
  type BaseEvent,
  type RunAgentInput,
} from "@ag-ui/client";
import { Observable } from "rxjs";
import { z } from "zod";
import { modelRuntime } from "./model-runtime";
import { meetingPrompt } from "./meeting-prompt";
import { parseMeetingResult } from "./result-schema";

const requestSchema = z.object({
  meetingId: z.string(),
  transcript: z.string().max(50000),
  structured: z.boolean(),
});

export class WebGPUAgent extends AbstractAgent {
  constructor() {
    super({
      agentId: "default",
      description: "Private meeting assistant running in this browser",
    });
  }
  override abortRun() {
    modelRuntime.cancel();
  }
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      const emit = (event: BaseEvent) => subscriber.next(event);
      let completed = false;
      void (async () => {
        emit({
          type: EventType.RUN_STARTED,
          threadId: input.threadId,
          runId: input.runId,
        });
        try {
          const request = requestSchema.parse(input.forwardedProps);
          const last = [...input.messages]
            .reverse()
            .find((message) => message.role === "user");
          const question =
            last && typeof last.content === "string"
              ? last.content
              : "Summarize this meeting.";
          const messageId = crypto.randomUUID();
          if (!request.structured)
            emit({
              type: EventType.TEXT_MESSAGE_START,
              messageId,
              role: "assistant",
            });
          let raw = "";
          for await (const delta of modelRuntime.generate(
            meetingPrompt(request.transcript, question, request.structured),
            request.structured,
          )) {
            raw += delta;
            if (!request.structured)
              emit({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta });
          }
          if (request.structured) {
            let result;
            try {
              result = parseMeetingResult(raw, request.transcript);
            } catch {
              throw new Error(
                "The model returned an invalid recap. No action was created. Try again with a shorter transcript.",
              );
            }
            emit({
              type: EventType.STATE_SNAPSHOT,
              snapshot: { meetingId: request.meetingId, result },
            });
            emit({
              type: EventType.TEXT_MESSAGE_START,
              messageId,
              role: "assistant",
            });
            emit({
              type: EventType.TEXT_MESSAGE_CONTENT,
              messageId,
              delta: `Your recap is ready. I found ${result.decisions.length} decisions and ${result.actions.length} suggested actions. Review the recap and the evidence before saving anything.`,
            });
          }
          emit({ type: EventType.TEXT_MESSAGE_END, messageId });
          emit({
            type: EventType.RUN_FINISHED,
            threadId: input.threadId,
            runId: input.runId,
          });
        } catch (error) {
          emit({
            type: EventType.RUN_ERROR,
            message:
              error instanceof Error
                ? error.message
                : "The local assistant couldn't complete this request.",
          });
        } finally {
          completed = true;
          subscriber.complete();
        }
      })();
      return () => {
        if (!completed) modelRuntime.cancel();
      };
    });
  }
}
