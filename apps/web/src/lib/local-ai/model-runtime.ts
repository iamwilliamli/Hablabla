import type {
  WebWorkerMLCEngine,
  ChatCompletionMessageParam,
} from "@mlc-ai/web-llm";

export type ModelPhase =
  | "checking"
  | "unsupported"
  | "idle"
  | "downloading"
  | "loading"
  | "ready"
  | "generating"
  | "cancelled"
  | "error";
export type ModelSnapshot = {
  phase: ModelPhase;
  progress: number;
  detail: string;
  model: "3B" | "1B";
  canFallback: boolean;
};
const initial: ModelSnapshot = {
  phase: "checking",
  progress: 0,
  detail: "Checking browser support…",
  model: "3B",
  canFallback: false,
};
// Store only an interrupted-model marker, never meeting or chat content.
const attemptKey = "hablabla:model-in-progress";
function rememberAttempt(model?: "3B" | "1B") {
  try {
    if (model) sessionStorage.setItem(attemptKey, model);
    else sessionStorage.removeItem(attemptKey);
  } catch {
    /* Storage can be unavailable in private browsing. */
  }
}

class ModelRuntime {
  private snapshot = initial;
  private listeners = new Set<() => void>();
  private engine?: WebWorkerMLCEngine;
  private worker?: Worker;
  private checking?: Promise<void>;
  private loading = false;
  private cancelled = false;
  private active = false;
  private workerFailure?: Promise<never>;
  getSnapshot = () => this.snapshot;
  getServerSnapshot = () => initial;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(patch: Partial<ModelSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  check() {
    return (this.checking ??= this.checkSupport());
  }
  private async checkSupport() {
    try {
      const gpu = (
        navigator as Navigator & {
          gpu?: {
            requestAdapter(): Promise<{
              requestDevice(): Promise<{ destroy(): void }>;
            } | null>;
          };
        }
      ).gpu;
      if (!gpu) throw new Error("unsupported");
      const adapter = await gpu.requestAdapter();
      if (!adapter) throw new Error("unsupported");
      const device = await adapter.requestDevice();
      device.destroy();
      let interrupted = false;
      try {
        interrupted = sessionStorage.getItem(attemptKey) === "3B";
      } catch {}
      this.update({
        phase: interrupted ? "error" : "idle",
        canFallback: interrupted,
        detail: interrupted
          ? "The previous 3B model session was interrupted. Retry it or try the smaller model for lower GPU memory use."
          : "Your browser supports local AI. Load the model to get started.",
      });
    } catch {
      this.update({
        phase: "unsupported",
        detail:
          "A compatible WebGPU device isn't available. Try current Chrome on a supported computer with hardware acceleration enabled.",
      });
    }
  }
  async load(model: "3B" | "1B" = "3B") {
    if (this.loading || this.active || this.snapshot.phase === "unsupported")
      return;
    if (model === "1B" && !this.snapshot.canFallback) return;
    this.loading = true;
    rememberAttempt(model);
    this.update({
      phase: "loading",
      model,
      progress: 0,
      detail: "Preparing the local model…",
    });
    try {
      // Terminating the prior worker also handles a dead worker that cannot answer unload().
      this.worker?.terminate();
      this.engine = undefined;
      const { CreateWebWorkerMLCEngine, prebuiltAppConfig } = await import(
        "@mlc-ai/web-llm"
      );
      const id = `Llama-3.2-${model}-Instruct-q4f16_1-MLC`;
      if (!prebuiltAppConfig.model_list.some((entry) => entry.model_id === id))
        throw new Error("model unavailable");
      this.worker = new Worker(
        new URL("../../workers/webllm.worker.ts", import.meta.url),
        { type: "module" },
      );
      this.workerFailure = new Promise<never>((_resolve, reject) => {
        this.worker!.addEventListener(
          "error",
          () => {
            this.update({
              phase: "error",
              canFallback: true,
              detail:
                "The local model worker stopped. Retry loading the model.",
            });
            reject(new Error("Local model worker failed."));
          },
          { once: true },
        );
      });
      // The worker can fail between requests. Keep its rejection handled until the next race.
      void this.workerFailure.catch(() => {});
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Model initialization timed out.")),
          10 * 60_000,
        );
      });
      try {
        this.engine = await Promise.race([
          CreateWebWorkerMLCEngine(
            this.worker,
            id,
            {
              logLevel: "SILENT",
              initProgressCallback: ({ progress, text }) =>
                this.update({
                  phase: /load.*param|fetch|download/i.test(text)
                    ? "downloading"
                    : "loading",
                  progress: Math.max(0, Math.min(1, progress)),
                  detail: text,
                }),
            },
            { context_window_size: 4096 },
          ),
          this.workerFailure,
          deadline,
        ]);
      } finally {
        clearTimeout(timeout);
      }
      this.update({
        phase: "ready",
        progress: 1,
        detail: `Llama 3.2 ${model} is ready. Inference stays in this browser.`,
      });
      rememberAttempt();
    } catch {
      this.worker?.terminate();
      this.engine = undefined;
      this.update({
        phase: "error",
        canFallback: true,
        detail:
          "The model couldn't load. Check your connection and available GPU memory, then retry or try the smaller model.",
      });
    } finally {
      this.loading = false;
    }
  }
  cancel() {
    if (!this.active) return;
    this.cancelled = true;
    this.engine?.interruptGenerate();
    this.update({ detail: "Stopping local generation…" });
  }
  async *generate(messages: ChatCompletionMessageParam[], structured = false) {
    if (!this.engine || !["ready", "cancelled"].includes(this.snapshot.phase))
      throw new Error("Load the local model before asking the assistant.");
    if (this.active) throw new Error("Please wait for the current response.");
    this.active = true;
    rememberAttempt(this.snapshot.model);
    this.cancelled = false;
    this.update({
      phase: "generating",
      detail: structured
        ? "Reading the meeting and preparing your recap…"
        : "Thinking with your meeting context…",
    });
    try {
      const failure = this.workerFailure!;
      const stream = await Promise.race([
        this.engine.chat.completions.create({
          messages,
          stream: true,
          max_tokens: 768,
          temperature: 0.2,
          ...(structured
            ? { response_format: { type: "json_object" as const } }
            : {}),
        }),
        failure,
      ]);
      const iterator = stream[Symbol.asyncIterator]();
      while (true) {
        const next = await Promise.race([iterator.next(), failure]);
        if (next.done) break;
        const chunk = next.value;
        if (this.cancelled) break;
        const delta = chunk.choices[0]?.delta.content;
        if (delta) yield delta;
      }
      if (this.cancelled)
        throw new DOMException(
          "Generation cancelled. Nothing was saved.",
          "AbortError",
        );
      this.update({ phase: "ready", detail: "Ready for your next question." });
      rememberAttempt();
    } catch (error) {
      if (this.cancelled) {
        rememberAttempt();
        this.update({
          phase: "cancelled",
          detail: "Generation cancelled. Nothing was saved.",
        });
        throw new DOMException(
          "Generation cancelled. Nothing was saved.",
          "AbortError",
        );
      }
      this.update({
        phase: "error",
        canFallback: true,
        detail: "Local generation failed. Reload the model to try again.",
      });
      throw new Error(
        "Local generation failed. Reload the model to try again.",
      );
    } finally {
      this.active = false;
    }
  }
}

// One runtime per browser module; React renders never reload the model.
export const modelRuntime = new ModelRuntime();
