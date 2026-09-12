"use client";
import { useEffect, useRef, useState } from "react";
import { computerProposalSchema, describeControl, type ComputerProposal } from "@/lib/computer-use";
import type { DeviceState } from "@/lib/devices-protocol";

async function api(body: unknown, signal?: AbortSignal) {
  const response = await fetch("/api/devices", { method: "POST", credentials: "same-origin", cache: "no-store",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: signal ?? AbortSignal.timeout(10_000) });
  const value = await response.json();
  if (!response.ok) throw new Error(typeof value.error === "string" ? value.error : "OpenAI is unavailable.");
  return value;
}

export function OpenAIControlPanel({ state, ready, busy, now, act }: {
  state: DeviceState; ready: boolean; busy: boolean; now: number; act: (body: unknown) => Promise<void>;
}) {
  const [configuration, setConfiguration] = useState<{ configured: boolean; model: string } | null>(null);
  const [selected, setSelected] = useState("");
  const [instruction, setInstruction] = useState("");
  const [planning, setPlanning] = useState(false);
  const [proposal, setProposal] = useState<ComputerProposal | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const catalog = state.catalog && Date.parse(state.catalog.expiresAt) > now ? state.catalog : null;
  const target = catalog?.windows.find(window => window.id === selected);
  const pending = !!state.request && ["awaiting_approval", "executing"].includes(state.request.status);
  const available = !!state.device?.online && state.device.permissions.accessibility && !!target;
  const validProposal = proposal && target && proposal.deviceId === state.device?.id && proposal.catalogId === catalog?.id && proposal.windowId === target.id && Date.parse(proposal.expiresAt) > now;

  useEffect(() => {
    if (!ready) return;
    const abort = new AbortController();
    void api({ operation: "ai_status" }, abort.signal).then(value => {
      if (!abort.signal.aborted) setConfiguration(value);
    }).catch(() => { if (!abort.signal.aborted) setError("Could not read OpenAI configuration. Reload the page to retry."); });
    return () => abort.abort();
  }, [ready]);

  // A changed/expired target or another manual command invalidates any proposal.
  useEffect(() => {
    generation.current++; controller.current?.abort(); controller.current = null;
    setPlanning(false); setProposal(null); setNotice("");
  }, [state.device?.id, state.device?.online, state.device?.permissions.accessibility, catalog?.id, selected, state.request?.id]);
  useEffect(() => {
    const hide = () => {
      if (!document.hidden) return;
      generation.current++; controller.current?.abort(); controller.current = null;
      setPlanning(false); setProposal(null); setInstruction("");
    };
    document.addEventListener("visibilitychange", hide);
    return () => { generation.current++; controller.current?.abort(); document.removeEventListener("visibilitychange", hide); };
  }, []);

  async function plan() {
    if (!available || !catalog || !target || !state.device || !instruction.trim() || busy || pending || controller.current) return;
    const abort = new AbortController(); controller.current = abort;
    const revision = ++generation.current;
    setPlanning(true); setProposal(null); setError(""); setNotice("");
    const timer = setTimeout(() => abort.abort(), 50_000);
    try {
      const result = computerProposalSchema.parse(await api({ operation: "ai_plan", planId: crypto.randomUUID(), deviceId: state.device.id,
        catalogId: catalog.id, windowId: target.id, instruction: instruction.trim() }, abort.signal));
      if (!abort.signal.aborted && revision === generation.current) setProposal(result);
    } catch (cause) {
      if (revision === generation.current) setError(abort.signal.aborted ? "OpenAI request stopped or timed out. Nothing was queued on your Mac." : cause instanceof Error ? cause.message : "OpenAI could not plan this action.");
    } finally {
      clearTimeout(timer);
      if (revision === generation.current) { controller.current = null; setPlanning(false); }
    }
  }
  async function stop() {
    generation.current++; controller.current?.abort(); controller.current = null;
    setPlanning(false); setProposal(null); setError(""); setNotice("Stopped. No model action was sent to the Mac.");
    try { await api({ operation: "ai_cancel" }); }
    catch { setError("Could not confirm cancellation with the server. No model action is queued automatically."); }
  }
  async function execute() {
    if (!validProposal || !proposal.action || !available || pending || busy) return;
    const chosen = proposal;
    setProposal(null); setInstruction("");
    setNotice("Sent for approval. Review the exact input in Hablabla Companion; the result appears under Windows & controls.");
    await act({ operation: "control", requestId: crypto.randomUUID(), deviceId: chosen.deviceId,
      catalogId: chosen.catalogId, windowId: chosen.windowId, action: chosen.action });
  }

  return <section className="dv-control dv-card dv-ai" aria-labelledby="openai-control-heading">
    <div className="dv-control-heading"><div><p className="dv-eyebrow">DESCRIBE IT. REVIEW IT. APPROVE ON YOUR MAC.</p><h2 id="openai-control-heading">Ask OpenAI</h2></div><span className="dv-pill">{configuration?.model ?? "OpenAI API"}</span></div>
    <p>Describe one action for a shared window. OpenAI proposes a command; you review it here, then approve it in the companion.</p>
    <p className="dv-ai-disclosure">Send to OpenAI shares your instruction and the selected app/window name with OpenAI. Screenshots, other windows, and meeting data stay local. This uses the server’s API key and may incur API charges.</p>
    {configuration && !configuration.configured && <p role="status">OpenAI is not configured. Set OPENAI_API_KEY on the server and restart the web app.</p>}
    {!catalog?.windows.length && <p>Pair the companion and share a window list using Windows & controls above.</p>}
    <form className="dv-control-form" onSubmit={event => { event.preventDefault(); void plan(); }}>
      <label>Window for OpenAI<select required value={target?.id ?? ""} disabled={planning || busy || pending} onChange={event => setSelected(event.target.value)}>
        <option value="">Choose a shared window</option>{catalog?.windows.map(window => <option key={window.id} value={window.id}>{window.app} — {window.title}</option>)}
      </select></label>
      <label>Your instruction<textarea value={instruction} maxLength={2000} rows={3} required disabled={planning} autoComplete="off" placeholder={'For example: Type “Hello from Hablabla”'} onChange={event => { setInstruction(event.target.value); setProposal(null); }} />
        <span>One step at a time. The model cannot see the screen or locate buttons by appearance.</span>
      </label>
      <div className="dv-actions"><button className="dv-primary" type="submit" disabled={!configuration?.configured || !available || !instruction.trim() || planning || busy || pending}>{planning ? "Asking OpenAI…" : "Send to OpenAI"}</button>
        {(planning || proposal) && <button type="button" onClick={() => void stop()}>{planning ? "Stop OpenAI request" : "Discard proposal"}</button>}</div>
    </form>
    {error && <p className="dv-error" role="alert">{error}</p>}
    {proposal && <div className="dv-ai-proposal" aria-label="OpenAI proposal">
      <p>{proposal.message}</p>
      {proposal.action && <><h3>Proposed input</h3><p className="dv-ai-action">{describeControl(proposal.action)}</p><p>Target: {target?.app} — {target?.title}</p>
        <button className="dv-primary" disabled={!validProposal || !available || busy || pending} onClick={() => void execute()}>Request Mac approval for this action</button></>}
      {!validProposal && <p>This proposal expired or its window is no longer available. Request a fresh proposal.</p>}
    </div>}
    <p role="status" aria-live="polite">{planning ? "Waiting for OpenAI. Your Mac has no new action request." : notice || "OpenAI suggestions never execute automatically."}</p>
  </section>;
}
