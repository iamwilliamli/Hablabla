"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import { LiveSpeechInput } from "./speech/live-speech-input";

type SpeechError = { code?: string; message?: string; retryable?: boolean; requestId?: string };
type MossSegment = { id: string; startMs: number; endMs: number; speakerId: string | null; text: string };
type MossJob = {
  jobId: string;
  status: "queued" | "processing" | "completed" | "failed" | "cancelled";
  progress: number;
  result?: { text: string; durationMs: number; segments: MossSegment[] };
  error?: SpeechError;
};

function errorMessage(payload: unknown, fallback: string) {
  const body = payload as { error?: SpeechError } | undefined;
  const message = body?.error?.message || fallback;
  return { message, requestId: body?.error?.requestId };
}

function timestamp(milliseconds: number) {
  const total = Math.floor(milliseconds / 1000);
  return `${Math.floor(total / 60).toString().padStart(2, "0")}:${(total % 60).toString().padStart(2, "0")}`;
}

function transcriptFromJob(job: MossJob) {
  if (!job.result?.segments.length) return job.result?.text.trim() || "";
  const speakerNames = new Map<string, string>();
  return job.result.segments
    .map((segment) => {
      const source = segment.speakerId || "unknown";
      if (!speakerNames.has(source)) speakerNames.set(source, `Speaker ${speakerNames.size + 1}`);
      return `${speakerNames.get(source)} [${timestamp(segment.startMs)}]: ${segment.text.trim()}`;
    })
    .join("\n\n");
}

export function SpeechInput({ onTranscript, onBusyChange, editing = false }: {
  onTranscript: (transcript: string) => void;
  onBusyChange?: (busy: boolean) => void;
  editing?: boolean;
}) {
  const [mode, setMode] = useState<"upload" | "live">("upload");
  const [connection, setConnection] = useState<"checking" | "connected" | "offline" | "needs-configuration">("checking");
  const [file, setFile] = useState<File>();
  const [job, setJob] = useState<MossJob>();
  const [status, setStatus] = useState("");
  const [requestId, setRequestId] = useState("");
  const [busy, setBusy] = useState(false);
  const idempotencyKey = useRef(crypto.randomUUID());
  const pollController = useRef<AbortController | null>(null);
  const [nemotronAvailable, setNemotronAvailable] = useState(false);

  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);

  useEffect(() => {
    let active = true;
    void fetch("/api/speech", { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!active) return;
        setNemotronAvailable(body.capabilities?.nemotron?.configured === true);
        setConnection(response.ok && body.status === "connected" ? "connected" : body.status === "needs-configuration" ? "needs-configuration" : "offline");
      })
      .catch(() => active && setConnection("offline"));
    return () => {
      active = false;
      pollController.current?.abort();

    };
  }, []);

  function chooseFile(nextFile?: File) {
    setFile(nextFile);
    setJob(undefined);
    setStatus("");
    setRequestId("");
    idempotencyKey.current = crypto.randomUUID();
  }

  async function readResponse(response: Response) {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const problem = errorMessage(body, "The speech service could not complete this request.");
      setRequestId(problem.requestId || "");
      throw new Error(problem.message);
    }
    return body;
  }

  async function poll(jobId: string) {
    pollController.current?.abort();
    const controller = new AbortController();
    pollController.current = controller;
    while (!controller.signal.aborted) {
      await new Promise((resolve) => setTimeout(resolve, 900));
      const response = await fetch(`/api/speech/transcriptions/${encodeURIComponent(jobId)}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const next = (await readResponse(response)) as MossJob;
      setJob(next);
      if (next.status === "completed") {
        const transcript = transcriptFromJob(next);
        if (!transcript) throw new Error("The recording finished without any speech to add.");
        onTranscript(transcript);
        setStatus(editing ? "Transcript ready. Review it below, then update this meeting." : "Transcript ready. Review it below, then add the meeting.");
        setBusy(false);
        return;
      }
      if (next.status === "failed") {
        setRequestId(next.error?.requestId || "");
        throw new Error(next.error?.message || "The recording could not be transcribed.");
      }
      if (next.status === "cancelled") {
        setStatus("Transcription cancelled.");
        setBusy(false);
        return;
      }
    }
  }

  async function upload() {
    if (!file || busy) return;
    setBusy(true);
    setStatus("Uploading recording…");
    setRequestId("");
    const form = new FormData();
    form.set("audio", file, file.name);
    form.set("language", "auto");
    form.set("clientReference", crypto.randomUUID());
    try {
      const created = (await readResponse(await fetch("/api/speech/transcriptions", {
        method: "POST",
        headers: { "idempotency-key": idempotencyKey.current },
        body: form,
      }))) as MossJob;
      setJob(created);
      setStatus("Your recording is queued on this computer.");
      await poll(created.jobId);
    } catch (error) {
      if ((error as Error).name !== "AbortError") setStatus(error instanceof Error ? error.message : "Upload failed.");
      setBusy(false);
    }
  }

  async function cancelJob() {
    if (!job?.jobId) return;
    pollController.current?.abort();
    try {
      const cancelled = (await readResponse(await fetch(`/api/speech/transcriptions/${encodeURIComponent(job.jobId)}`, { method: "DELETE" }))) as MossJob;
      setJob(cancelled);
      setStatus("Transcription cancelled.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not cancel transcription.");
    } finally {
      setBusy(false);
    }
  }

  const progress = Math.round((job?.progress || 0) * 100);
  return (
    <section className="speech-input" aria-labelledby="speech-input-title">
      <div className="speech-input-heading">
        <div>
          <h3 id="speech-input-title">{editing ? "Transcribe audio for this meeting" : "Transcribe a doctor–patient conversation"}</h3>
          <p>Processed by the speech backend connected to this app.</p>
        </div>
        <span className={`speech-connection ${connection}`}>{connection === "connected" ? "Speech ready" : connection === "checking" ? "Checking…" : "Speech offline"}</span>
      </div>
      <div className="speech-mode" role="tablist" aria-label="Audio source">
        <button type="button" role="tab" aria-selected={mode === "upload"} onClick={() => setMode("upload")} disabled={busy}>Upload recording</button>
        <button type="button" role="tab" aria-selected={mode === "live"} onClick={() => setMode("live")} disabled={busy}>Live transcription</button>
      </div>
      {mode === "upload" ? (
        <div className="speech-controls">
          <label className="audio-picker">
            <Icon name="upload" size={19} />
            <span>{file?.name || "Choose a visit recording"}</span>
            <input type="file" accept="audio/*,video/mp4,video/webm" onChange={(event) => chooseFile(event.target.files?.[0])} disabled={busy} />
          </label>
          {busy ? <button type="button" className="button" onClick={cancelJob}>Cancel</button> : <button type="button" className="button primary" onClick={upload} disabled={!file || connection !== "connected"}>Transcribe with MOSS</button>}
        </div>
      ) : (
        <LiveSpeechInput connected={connection === "connected"} nemotronAvailable={nemotronAvailable} onTranscript={onTranscript} onBusyChange={setBusy} editing={editing} />
      )}
      {(busy || job) && mode === "upload" && <progress value={progress} max="100" aria-label={`Transcription ${progress}% complete`} />}
      {mode === "upload" && status && <p className="speech-status" role="status">{status}{requestId && <small> Request ID: {requestId}</small>}</p>}
    </section>
  );
}
