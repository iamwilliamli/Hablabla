"use client";

import Link from "next/link";
import { ControlPanel } from "./control-panel";
import { OpenAIControlPanel } from "./openai-panel";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { deviceStateSchema, type DeviceState } from "@/lib/devices-protocol";

const empty: DeviceState = { device: null, request: null, catalog: null };
const pairingSchema = z.object({ code: z.string().regex(/^[a-f0-9]{32}$/), expiresAt: z.iso.datetime() });
const messages = {
  awaiting_approval: "Choose and capture a source in the Mac app, then click Share with Dashboard.",
  shared: "Shared by your Mac. This is a still image, captured at the time shown below.",
  denied: "Declined on your Mac. No image was shared.",
  cancelled: "Request cancelled. You can request a fresh snapshot.",
  expired: "This request or image has expired. Request a fresh snapshot when you’re ready.",
  executing: "An action is in progress on your Mac.",
  succeeded: "Window focused.",
  dispatched: "Input sent. Check your Mac for the result.",
  unknown: "The result is uncertain. Check your Mac before retrying.",
  failed: "Capture did not complete. Check the companion and try again.",
};
async function api(body?: unknown) {
  const response = await fetch("/api/devices", { method: body ? "POST" : "GET", cache: "no-store", credentials: "same-origin",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10_000) });
  const value = await response.json();
  if (!response.ok) throw new Error(typeof value.error === "string" ? value.error : "Local connection is unavailable.");
  return value as unknown;
}
function Monitor({ small = false }: { small?: boolean }) {
  return <svg width={small ? 34 : 76} height={small ? 34 : 76} viewBox="0 0 64 64" fill="none" aria-hidden="true">
    <rect x="6" y="9" width="52" height="35" rx="5" stroke="currentColor" strokeWidth="2" />
    <path d="M22 54h20M27 44v10m10-10v10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    <path d="m25 26 5 5 10-11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}

export function DeviceDashboard() {
  const [state, setState] = useState<DeviceState>(empty);
  const [pairing, setPairing] = useState<z.infer<typeof pairingSchema> | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [image, setImage] = useState<{ id: string; url: string } | null>(null);
  const revision = useRef(0);
  const mutating = useRef(false);
  const mounted = useRef(true);
  const load = useCallback(async () => {
    if (mutating.current) return;
    const current = revision.current;
    try {
      const next = deviceStateSchema.parse(await api());
      if (!mounted.current || current !== revision.current) return;
      setState(next); setReady(true); setError("");
      if (next.device) setPairing(null);
    } catch (cause) {
      if (!mounted.current || current !== revision.current) return;
      setError(cause instanceof Error ? cause.message : "Local connection is unavailable.");
      setState(empty); // Never leave a stale image visible after connection loss.
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => { await load(); if (!stopped) timer = setTimeout(poll, 1500); };
    void poll();
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => { stopped = true; mounted.current = false; clearTimeout(timer); clearInterval(clock); };
  }, [load]);

  const snapshot = state.request?.kind === "snapshot" ? state.request : null;
  const imageId = snapshot?.status === "shared" && snapshot.imageExpiresAt && Date.parse(snapshot.imageExpiresAt) > now ? snapshot.id : null;
  useEffect(() => {
    setImage(null);
    if (!imageId) return;
    const controller = new AbortController();
    let url: string | undefined;
    let hidden = false;
    const hide = () => {
      if (document.hidden) { hidden = true; controller.abort(); if (url) URL.revokeObjectURL(url); setImage(null); setNotice("Preview cleared when the tab was hidden. Request a fresh snapshot to view it again."); }
    };
    document.addEventListener("visibilitychange", hide);
    void (async () => {
      try {
        const response = await fetch(`/api/devices?image=${encodeURIComponent(imageId)}`, { cache: "no-store", credentials: "same-origin", signal: controller.signal });
        if (!response.ok) throw new Error("This image has expired or was cleared.");
        const blob = await response.blob();
        if (controller.signal.aborted || hidden) return;
        url = URL.createObjectURL(blob);
        setImage({ id: imageId, url });
      } catch { if (!controller.signal.aborted) setNotice("Image unavailable. Request a fresh snapshot."); }
    })();
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); document.removeEventListener("visibilitychange", hide); };
  }, [imageId]);

  async function act(body: unknown, isPairing = false) {
    if (mutating.current) return;
    revision.current++;
    mutating.current = true;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await api(body);
      if (!mounted.current) return;
      if (isPairing) setPairing(pairingSchema.parse(result));
      else { setState(deviceStateSchema.parse(result)); setPairing(null); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Please try again."); }
    finally { revision.current++; mutating.current = false; setBusy(false); }
  }
  const device = state.device;
  const waiting = snapshot?.status === "awaiting_approval";
  const anyPending = state.request && ["awaiting_approval", "executing"].includes(state.request.status);
  const codeValid = pairing && Date.parse(pairing.expiresAt) > now;
  const status = snapshot ? messages[snapshot.status] : "Your Mac will ask you to choose and approve each snapshot.";

  return <div className="dv-page">
    <a className="dv-skip" href="#device-main">Skip to device controls</a>
    <header className="dv-nav"><Link className="dv-brand" href="/">h<span>↗</span> Hablabla</Link><Link href="/">← Meeting workspace</Link><span className="dv-pill">On this Mac</span></header>
    <main id="device-main" className="dv-main">
      <div className="dv-heading"><div><p className="dv-eyebrow">YOUR COMPUTER, WITH YOUR PERMISSION</p><h1>A little closer to your Mac.</h1><p>Choose what to share. See it here. Stay in control.</p></div><span className="dv-mode">◉ &nbsp; Local connection</span></div>
      {error && <p className="dv-error" role="alert">{error}</p>}
      <div className="dv-grid">
        <aside className="dv-sidebar" aria-label="Mac connection">
          <section className="dv-card">
            <div className="dv-card-icon"><Monitor small /></div>
            <h2>{device?.name ?? "Pair your Mac"}</h2>
            <p className={`dv-connection ${device?.online ? "is-online" : ""}`}><span aria-hidden="true">●</span> {device ? device.online ? "Companion connected" : "Companion offline" : "Not connected"}</p>
            {!device ? <>
              <p>Connect this browser to Hablabla Companion to request snapshots and computer controls.</p>
              <ol className="dv-steps"><li>Open <strong>Hablabla Companion</strong>.</li><li>Choose <strong>Local Dashboard…</strong> from its menu bar icon.</li><li>Create a code here and paste it into the app.</li></ol>
              <button className="dv-primary" disabled={!ready || busy} onClick={() => void act({ operation: "pairing" }, true)}>{codeValid ? "Create a new code" : "Create pairing code"}</button>
              {pairing && <div className="dv-pairing"><label htmlFor="pair-code">One-time pairing code</label><input id="pair-code" readOnly value={codeValid ? pairing.code : "Code expired"} spellCheck={false} onFocus={event => event.currentTarget.select()} />
                <p>{codeValid ? "Valid for two minutes. Pair only with the app on this Mac." : "Create a new code to continue."}</p>
                <button disabled={!codeValid} onClick={() => void navigator.clipboard.writeText(pairing.code).then(() => setNotice("Pairing code copied."), () => setNotice("Select the code and copy it manually."))}>Copy code</button>
              </div>}
            </> : <>
              <dl className="dv-permissions"><div><dt>Screen Recording</dt><dd>{device.permissions.screenRecording ? "Granted" : "Not granted"}</dd></div><div><dt>Accessibility</dt><dd>{device.permissions.accessibility ? "Granted" : "Not granted"}</dd></div></dl>
              <p className="dv-small">Reported by the running companion. Screen capture uses the macOS picker; Accessibility enables approved window, mouse, and keyboard actions.</p>
              <button className="dv-danger" disabled={busy} onClick={() => { setState(empty); void act({ operation: "disconnect" }); }}>Disconnect & clear</button>
            </>}
          </section>
          <section className="dv-note"><span aria-hidden="true">↗</span><h3>You decide what leaves the preview.</h3><p>The Mac app shows each image before you share it. Shared images stay on this Mac and disappear here after one minute.</p><p>No AI model receives your screen.</p></section>
        </aside>
        <section className="dv-viewer" aria-labelledby="snapshot-heading">
          <div className="dv-viewer-heading"><div><p className="dv-eyebrow">A MOMENT, SHARED BY YOU</p><h2 id="snapshot-heading">Screen snapshot</h2></div><span className="dv-pill">Still image</span></div>
          <div className="dv-canvas">
            {image && image.id === imageId && snapshot?.metadata ? <img src={image.url} alt={`Shared ${snapshot.metadata.kind}: ${snapshot.metadata.target}`} /> : <div className="dv-empty"><Monitor /><h3>{waiting ? "Your Mac has the request." : device ? "Your next view starts on your Mac." : "Your Mac will appear here."}</h3><p>{waiting ? "Pick a window or display in the companion. Review the capture, then choose Share with Dashboard." : "One window or one display. A single image you approve, whenever you need it."}</p></div>}
          </div>
          <div className="dv-viewer-footer"><p role="status" aria-live="polite">{status}</p>
            {snapshot?.metadata && imageId && <dl className="dv-metadata"><div><dt>Source</dt><dd>{snapshot.metadata.target}</dd></div><div><dt>Captured</dt><dd><time dateTime={snapshot.metadata.capturedAt}>{new Date(snapshot.metadata.capturedAt).toLocaleTimeString()}</time></dd></div><div><dt>Size</dt><dd>{snapshot.metadata.width} × {snapshot.metadata.height}</dd></div></dl>}
            <div className="dv-actions"><button className="dv-primary" disabled={!device?.online || busy || !!anyPending} onClick={() => device && void act({ operation: "snapshot", requestId: crypto.randomUUID(), deviceId: device.id })}>{waiting ? "Waiting for your approval…" : "Request snapshot"}<span aria-hidden="true"> ↗</span></button>
              {snapshot && <button disabled={busy} onClick={() => { setState(s => ({ ...s, request: null })); void act({ operation: "clear" }); }}>{waiting ? "Cancel request" : "Clear snapshot"}</button>}
            </div>
          </div>
        </section>
      </div>
      <ControlPanel state={state} busy={busy} now={now} act={act} />
      <OpenAIControlPanel state={state} ready={ready} busy={busy} now={now} act={act} />
      <p className="dv-bottom" role="status">{notice || "Pairing lasts for this session. Closing the companion connection window stops sharing."}</p>
    </main>
  </div>;
}
