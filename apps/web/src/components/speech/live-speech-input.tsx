"use client";

import { useEffect, useRef, useState } from "react";
import { createLiveSpeech, parseLiveHotwords, type LiveSpeechState } from "@/lib/live-speech";
import { Icon } from "../icons";

export function LiveSpeechInput({ connected, nemotronAvailable, onTranscript, onBusyChange, editing = false }: {
  editing?: boolean;
  connected: boolean;
  nemotronAvailable: boolean;
  onTranscript: (text: string) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [selectedModel, setModel] = useState<"nemotron" | "parakeet" | null>(null);
  const model = selectedModel ?? (nemotronAvailable ? "nemotron" : "parakeet");
  const [language, setLanguage] = useState("en");
  const [hotwords, setHotwords] = useState("");
  const [state, setState] = useState<LiveSpeechState | "idle">("idle");
  const [status, setStatus] = useState("");
  const [text, setText] = useState("");
  const [seconds, setSeconds] = useState(0);
  const session = useRef<ReturnType<typeof createLiveSpeech> | null>(null);
  const busy = state === "loading" || state === "listening" || state === "finishing";
  useEffect(() => () => session.current?.dispose(), []);
  useEffect(() => {
    if (state !== "listening") return;
    const start = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [state]);
  function start() {
    if (busy) return;
    try {
      const words = model === "nemotron" ? parseLiveHotwords(hotwords) : [];
      session.current?.dispose();
      setText(""); setSeconds(0);
      session.current = createLiveSpeech({
        model, language, hotwords: words,
        onState(next, message) {
          setState(next); setStatus(editing && next === "completed" && message.startsWith("Transcript ready") ? "Transcript ready. Review the words before updating this meeting." : message);
          onBusyChange(next === "loading" || next === "listening" || next === "finishing");
        },
        onText(next) {
          setText(next);
          if (next) onTranscript(`Speaker [00:00]: ${next}`);
        },
      });
      void session.current.start();
    } catch (error) { setState("error"); setStatus((error as Error).message); }
  }
  return <div className="live-speech">
    <div className="live-speech-options">
      <label>Transcription model<select value={model} disabled={busy} onChange={event => { setModel(event.target.value as typeof model); setLanguage("en"); }}>
        <option value="nemotron" disabled={!nemotronAvailable}>Nemotron · multilingual{!nemotronAvailable ? " (unavailable)" : ""}</option>
        <option value="parakeet">Parakeet</option>
      </select></label>
      <label>Spoken language<select value={language} disabled={busy} onChange={event => setLanguage(event.target.value)}>
        <option value="en">English</option>
        {model === "nemotron" && <><option value="zh">中文</option><option value="ja">日本語</option></>}
        <option value="es">Español</option><option value="fr">Français</option><option value="de">Deutsch</option>
      </select></label>
    </div>
    {model === "nemotron" && <label className="live-hotwords">Hotwords <span>Optional</span>
      <input value={hotwords} disabled={busy} maxLength={5200} onChange={event => setHotwords(event.target.value)} placeholder="e.g. amoxicillin, allergy, 250 milligrams" aria-describedby="live-hotwords-hint" />
      <small id="live-hotwords-hint">Separate terms with commas. Up to 64 terms.</small>
    </label>}
    <div className="speech-controls live-recorder">
      <div><strong>{state === "listening" ? "Recording" : state === "finishing" ? "Finishing…" : state === "loading" ? "Preparing…" : "Ready to record"}</strong><p className="live-help">Microphone starts after the model is ready · Up to 10 minutes</p></div>
      <time aria-label="Recording duration">{Math.floor(seconds / 60).toString().padStart(2, "0")}:{(seconds % 60).toString().padStart(2, "0")}</time>
      {busy ? <>
        {state === "listening" && <button type="button" className="button primary" onClick={() => session.current?.finish()}><Icon name="stop" size={16} /> Finish</button>}
        <button type="button" className="button" onClick={() => session.current?.cancel()}>Cancel</button>
      </> : <button type="button" className="button primary" onClick={start} disabled={!connected}>Start recording</button>}
    </div>
    {status && <p className="speech-status" role={state === "error" ? "alert" : "status"}>{status}</p>}
    {text && <div className="live-transcript"><div><strong>Live transcript</strong><span>{state === "completed" ? "Final" : "Partial · may change"}</span></div><p>{text}</p></div>}
  </div>;
}
