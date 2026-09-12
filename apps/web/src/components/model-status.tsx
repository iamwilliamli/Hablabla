"use client";
import { modelRuntime, type ModelSnapshot } from "@/lib/local-ai/model-runtime";
import { Icon } from "./icons";

export const phaseLabels: Record<ModelSnapshot["phase"], string> = {
  checking: "Checking your browser",
  unsupported: "Local AI unavailable",
  idle: "Set up your local assistant",
  downloading: "Downloading model",
  loading: "Loading local model",
  ready: "Ready on your device",
  generating: "Thinking locally",
  cancelled: "Generation stopped",
  error: "Let's try that again",
};
export function ModelStatus({ model }: { model: ModelSnapshot }) {
  const pending = model.phase === "downloading" || model.phase === "loading";
  const ready = ["ready", "generating", "cancelled"].includes(model.phase);
  return (
    <section
      className={`model-card ${ready ? "model-ready" : ""}`}
      aria-label="Local model status"
    >
      <div className="model-card-title">
        <span className="model-icon">
          <Icon name={ready ? "check" : "spark"} size={16} />
        </span>
        <strong>{phaseLabels[model.phase]}</strong>
        {ready && <span className="status-dot" />}
      </div>
      <p role="status">
        {pending
          ? "The first load can take a few minutes. Model files are cached for next time."
          : model.phase === "idle"
            ? "Download Llama 3.2 once. Your conversations stay right here."
            : model.detail}
      </p>
      {pending && (
        <>
          <progress
            value={model.progress}
            max={1}
            aria-label="Model initialization progress"
          />
          <div className="progress-detail">
            <span>{Math.round(model.progress * 100)}%</span>
            <span>
              {model.phase === "downloading"
                ? "Downloading weights"
                : "Preparing your GPU"}
            </span>
          </div>
        </>
      )}
      {(model.phase === "idle" || model.phase === "error") && (
        <button
          className="button primary model-load"
          onClick={() => void modelRuntime.load(model.model)}
        >
          <Icon
            name={model.phase === "error" ? "refresh" : "download"}
            size={16}
          />
          {model.phase === "error" ? "Retry model" : "Load local model"}
          <span>{model.model}</span>
        </button>
      )}
      {model.phase === "error" && model.canFallback && model.model === "3B" && (
        <button
          className="text-button smaller-model"
          onClick={() => void modelRuntime.load("1B")}
        >
          Try the smaller 1B model <Icon name="arrow" size={14} />
        </button>
      )}
      {model.phase === "idle" && (
        <small>About 2.3 GB GPU memory · No API key needed</small>
      )}
      {ready && (
        <small>Llama 3.2 {model.model} · WebGPU · In this browser</small>
      )}
    </section>
  );
}
