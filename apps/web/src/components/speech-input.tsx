"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons";

type SpeechError = { code?: string; message?: string; retryable?: boolean; requestId?: string };
type MossSegment = { id: string; startMs: number; endMs: number; speakerId: string | null; text: string };
type MossJob = {
  jobId: string;
  status: "queued" | "processing" | "completed" | "failed" | "cancelled";
  progress: number;
  result?: { text: string; durationMs: number; segments: MossSegment[] };
  error?: SpeechError;
};
type LiveEvent = {
  type: "connected" | "progress" | "ready" | "transcript" | "error";
  progress?: number;
  stage?: string;
  revision?: number;
  confirmedText?: string;
  volatileText?: string;
  isFinal?: boolean;
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

export function SpeechInput({ onTranscript }: { onTranscript: (transcript: string) => void }) {
  const [mode, setMode] = useState<"upload" | "live">("upload");
  const [connection, setConnection] = useState<"checking" | "connected" | "offline" | "needs-configuration">("checking");
  const [file, setFile] = useState<File>();
  const [job, setJob] = useState<MossJob>();
  const [status, setStatus] = useState("");
  const [requestId, setRequestId] = useState("");
  const [busy, setBusy] = useState(false);
  const idempotencyKey = useRef(crypto.randomUUID());
  const pollController = useRef<AbortController | null>(null);
  const liveCleanup = useRef<(() => void) | null>(null);
  const liveStop = useRef<(() => void) | null>(null);

  useEffect(() => {
    let active = true;
    void fetch("/api/speech", { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!active) return;
        setConnection(response.ok && body.status === "connected" ? "connected" : body.status === "needs-configuration" ? "needs-configuration" : "offline");
      })
      .catch(() => active && setConnection("offline"));
    return () => {
      active = false;
      pollController.current?.abort();
      liveCleanup.current?.();
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
        setStatus("Transcript ready. Review it below, then add the meeting.");
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

  async function startLive() {
    if (busy) return;
    setBusy(true);
    setStatus("Getting the microphone ready…");
    setRequestId("");
    let context: AudioContext | undefined;
    let media: MediaStream | undefined;
    let source: MediaStreamAudioSourceNode | undefined;
    let worklet: AudioWorkletNode | undefined;
    let socket: WebSocket | undefined;
    let stopping = false;
    let latestRevision = -1;
    let sequence = 0;
    const cleanup = () => {
      media?.getTracks().forEach((track) => track.stop());
      try { source?.disconnect(); } catch {}
      try { worklet?.disconnect(); } catch {}
      if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
      void context?.close();
      liveCleanup.current = null;
      liveStop.current = null;
    };
    liveCleanup.current = cleanup;
    try {
      context = new AudioContext({ sampleRate: 16000 });
      if (context.sampleRate !== 16000) throw new Error(`This browser opened the microphone at ${context.sampleRate} Hz. Live captions need 16 kHz audio.`);
      await context.resume();
      await context.audioWorklet.addModule("/hablababla-pcm16-worklet.js");
      media = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      source = context.createMediaStreamSource(media);
      worklet = new AudioWorkletNode(context, "hablababla-pcm16");
      const session = await readResponse(await fetch("/api/speech/parakeet-session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ language: "en" }),
      })) as { websocketUrl: string };
      socket = new WebSocket(session.websocketUrl);
      socket.binaryType = "arraybuffer";
      const activeSocket = socket;
      const activeWorklet = worklet;
      const activeSource = source;
      activeWorklet.port.onmessage = ({ data }) => {
        if (data?.type === "flushed") {
          if (activeSocket.readyState === WebSocket.OPEN) activeSocket.send(JSON.stringify({ type: "finish" }));
          return;
        }
        if (activeSocket.readyState !== WebSocket.OPEN) return;
        const samples = new Int16Array(data as ArrayBuffer);
        const packet = new ArrayBuffer(8 + samples.byteLength);
        const view = new DataView(packet);
        view.setUint32(0, sequence++, true);
        view.setUint32(4, samples.length, true);
        new Uint8Array(packet, 8).set(new Uint8Array(samples.buffer));
        activeSocket.send(packet);
      };
      activeSocket.addEventListener("open", () => activeSocket.send(JSON.stringify({ type: "start" })));
      activeSocket.addEventListener("message", ({ data }) => {
        const event = JSON.parse(String(data)) as LiveEvent;
        if (event.type === "ready") {
          activeSource.connect(activeWorklet);
          setStatus("Listening… speak naturally, then press Finish.");
          liveStop.current = () => {
            if (stopping) return;
            stopping = true;
            media?.getTracks().forEach((track) => track.stop());
            activeSource.disconnect();
            activeWorklet.port.postMessage({ type: "flush" });
            setStatus("Finishing your transcript…");
          };
        }
        if (event.type === "progress") setStatus(event.stage === "loading-model" ? "Loading live captions on this computer…" : "Preparing live captions…");
        if (event.type === "transcript" && typeof event.revision === "number" && event.revision > latestRevision) {
          latestRevision = event.revision;
          const text = `${event.confirmedText || ""}${event.volatileText || ""}`.trim();
          if (text) onTranscript(`Speaker [00:00]: ${text}`);
          if (event.isFinal) {
            setStatus("Live transcript ready. Review it below, then add the meeting.");
            setBusy(false);
            cleanup();
          }
        }
        if (event.type === "error") {
          setRequestId(event.error?.requestId || "");
          setStatus(event.error?.message || "Live captions stopped unexpectedly.");
          setBusy(false);
          cleanup();
        }
      });
      activeSocket.addEventListener("error", () => {
        setStatus("Could not connect to live captions.");
        setBusy(false);
        cleanup();
      });
      activeSocket.addEventListener("close", () => {
        if (!stopping && liveCleanup.current) {
          setStatus("Live captions ended before a final transcript arrived.");
          setBusy(false);
          cleanup();
        }
      });
      setStatus("Connecting to live captions…");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not start live captions.");
      setBusy(false);
      cleanup();
    }
  }

  const progress = Math.round((job?.progress || 0) * 100);
  return (
    <section className="speech-input" aria-labelledby="speech-input-title">
      <div className="speech-input-heading">
        <div>
          <h3 id="speech-input-title">Transcribe a doctor–patient conversation</h3>
          <p>Processed by the speech backend connected to this app.</p>
        </div>
        <span className={`speech-connection ${connection}`}>{connection === "connected" ? "Speech ready" : connection === "checking" ? "Checking…" : "Speech offline"}</span>
      </div>
      <div className="speech-mode" role="tablist" aria-label="Audio source">
        <button type="button" role="tab" aria-selected={mode === "upload"} onClick={() => setMode("upload")} disabled={busy}>Upload recording</button>
        <button type="button" role="tab" aria-selected={mode === "live"} onClick={() => setMode("live")} disabled={busy}>Live captions</button>
      </div>
      {mode === "upload" ? (
        <div className="speech-controls">
          <label className="audio-picker">
            <Icon name="upload" size={19} />
            <span>{file?.name || "Choose a visit recording"}</span>
            <input type="file" accept="audio/*,video/mp4,video/webm" onChange={(event) => chooseFile(event.target.files?.[0])} disabled={busy} />
          </label>
          {busy ? <button type="button" className="button" onClick={cancelJob}>Cancel</button> : <button type="button" className="button primary" onClick={upload} disabled={!file || connection !== "connected"}>Transcribe</button>}
        </div>
      ) : (
        <div className="speech-controls">
          <p className="live-help">Use your microphone for a live, revisable transcript.</p>
          {busy ? <button type="button" className="button primary" onClick={() => liveStop.current?.()} disabled={!liveStop.current}><Icon name="stop" size={16} /> Finish</button> : <button type="button" className="button primary" onClick={startLive} disabled={connection !== "connected"}>Start listening</button>}
        </div>
      )}
      {(busy || job) && mode === "upload" && <progress value={progress} max="100" aria-label={`Transcription ${progress}% complete`} />}
      {status && <p className="speech-status" role="status">{status}{requestId && <small> Request ID: {requestId}</small>}</p>}
    </section>
  );
}
