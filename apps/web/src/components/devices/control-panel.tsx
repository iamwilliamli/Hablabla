"use client";
import { useState } from "react";
import { keyNames, type ControlAction, type DeviceState } from "@/lib/devices-protocol";

const outcomes: Record<string, string> = {
  awaiting_approval: "Review this request in Hablabla Companion on your Mac.",
  executing: "Approved on your Mac. The companion is attempting the action once.",
  shared: "Your selected window list is ready. Choose a window below.",
  succeeded: "The companion verified that the selected window is focused.",
  dispatched: "Input sent once. Check the target app or request a fresh snapshot to see its result.",
  unknown: "The result is uncertain. Check your Mac before requesting another action; it may already have happened.",
  denied: "Declined on your Mac. No action was performed.",
  cancelled: "Cancelled before execution.",
  expired: "This request expired. Share a fresh list if needed.",
  failed: "The companion could not complete this request. Check its status and refresh the window list.",
};
export function ControlPanel({ state, busy, now, act }: { state: DeviceState; busy: boolean; now: number; act: (body: unknown) => Promise<void> }) {
  const [selected, setSelected] = useState("");
  const [mode, setMode] = useState("activate_window");
  const [x, setX] = useState(50), [y, setY] = useState(50), [endX, setEndX] = useState(60), [endY, setEndY] = useState(60);
  const [dx, setDx] = useState(0), [dy, setDy] = useState(-200);
  const [text, setText] = useState("");
  const [key, setKey] = useState<(typeof keyNames)[number]>("Tab");
  const [modifiers, setModifiers] = useState<("command" | "shift" | "option" | "control")[]>([]);
  const device = state.device;
  const pending = state.request && ["awaiting_approval", "executing"].includes(state.request.status);
  const available = !!device?.online && device.permissions.accessibility;
  const catalog = state.catalog && Date.parse(state.catalog.expiresAt) > now ? state.catalog : null;
  const window = catalog?.windows.find(w => w.id === selected);
  const pointer = ["move", "click", "double_click", "right_click", "drag", "scroll"].includes(mode);
  const validPoint = [x, y, ...(mode === "drag" ? [endX, endY] : [])].every(n => Number.isFinite(n) && n >= 0 && n <= 100);
  const validText = text.length > 0 && text.length <= 500 && !/[\u0000-\u001f\u007f]/u.test(text);
  const validScroll = [dx, dy].every(n => Number.isInteger(n) && Math.abs(n) <= 600);
  const blocked = !available || busy || !!pending;
  const request = state.request?.kind !== "snapshot" ? state.request : null;
  async function submit() {
    if (!device || !catalog || !window || blocked) return;
    let action: ControlAction;
    const point = { x: x / 100, y: y / 100 };
    if (mode === "activate_window") action = { kind: "activate_window" };
    else if (mode === "type_text") action = { kind: "type_text", text };
    else if (mode === "key") action = { kind: "key", key, modifiers };
    else if (mode === "scroll") action = { kind: "scroll", point, dx, dy };
    else action = { kind: "pointer", mode: mode as "move" | "click" | "double_click" | "right_click" | "drag", point, ...(mode === "drag" ? { end: { x: endX / 100, y: endY / 100 } } : {}) };
    await act({ operation: "control", requestId: crypto.randomUUID(), deviceId: device.id, catalogId: catalog.id, windowId: window.id, action });
    if (mode === "type_text") setText("");
  }
  function coordinate(label: string, value: number, set: (v: number) => void, min = 0, max = 100) {
    return <label>{label}<input type="number" min={min} max={max} required value={Number.isNaN(value) ? "" : value} onChange={event => set(event.target.valueAsNumber)} /></label>;
  }
  return <section className="dv-control dv-card" aria-labelledby="control-heading">
    <div className="dv-control-heading"><div><p className="dv-eyebrow">ONE ACTION, WITH YOUR APPROVAL</p><h2 id="control-heading">Windows & controls</h2></div><span className="dv-pill">Accessibility</span></div>
    <p>Share selected windows from your Mac, then choose an action. The companion shows the exact target and input for approval every time.</p>
    {!available && <p>{device ? "Enable Accessibility for the installed companion, then refresh its Setup status." : "Pair your Mac to get started."}</p>}
    <button disabled={blocked} onClick={() => device && void act({ operation: "list_windows", deviceId: device.id, requestId: crypto.randomUUID() })}>{catalog ? "Refresh window list" : "Request window list"}</button>
    {request && <div className="dv-control-status"><p role="status">{outcomes[request.status]}</p>{pending && <button disabled={busy} onClick={() => void act({ operation: "clear" })}>{request.status === "executing" ? "Stop waiting — action may have happened" : "Cancel request"}</button>}</div>}
    {catalog && <>
      <p className="dv-small">{catalog.windows.length} shared windows · expires at {new Date(catalog.expiresAt).toLocaleTimeString()}. Refresh after a window closes or its title changes.</p>
      {catalog.windows.length === 0 ? <p>No windows were selected on the Mac. Request another list to choose some.</p> : <form onSubmit={event => { event.preventDefault(); void submit(); }} className="dv-control-form">
        <label>Target window<select value={window?.id ?? ""} onChange={event => setSelected(event.target.value)} required><option value="">Choose a shared window</option>{catalog.windows.map(w => <option key={w.id} value={w.id}>{w.app} — {w.title}{w.minimized ? " (minimized)" : ""}</option>)}</select></label>
        <label>Action<select value={mode} onChange={event => setMode(event.target.value)}>
          <option value="activate_window">Bring window to front</option><option value="move">Move pointer</option><option value="click">Click</option><option value="double_click">Double click</option><option value="right_click">Right click</option><option value="drag">Drag within window</option><option value="scroll">Scroll</option><option value="type_text">Type text</option><option value="key">Press key / shortcut</option>
        </select></label>
        {pointer && <fieldset><legend>Position within the target window</legend><p>Percentages from its top-left corner. The app verifies the point belongs to your selected window. These coordinates refer to the window, not the snapshot above.</p><div className="dv-fields">{coordinate("X · % from left", x, setX)}{coordinate("Y · % from top", y, setY)}{mode === "drag" && <>{coordinate("End X · %", endX, setEndX)}{coordinate("End Y · %", endY, setEndY)}</>}</div></fieldset>}
        {mode === "scroll" && <fieldset><legend>Scroll distance in pixels</legend><p>Positive values scroll up or left; negative values scroll down or right.</p><div className="dv-fields">{coordinate("Horizontal", dx, setDx, -600, 600)}{coordinate("Vertical", dy, setDy, -600, 600)}</div></fieldset>}
        {mode === "type_text" && <label>Text to type (up to 500 characters)<input type="text" value={text} maxLength={500} autoComplete="off" spellCheck={false} onChange={event => setText(event.target.value)} /><span>Goes to the selected window’s focused field. Return is a separate key action.</span></label>}
        {mode === "key" && <><label>Key<select value={key} onChange={event => setKey(event.target.value as typeof key)}>{keyNames.map(value => <option key={value}>{value}</option>)}</select></label><fieldset><legend>Modifier keys</legend><div className="dv-modifiers">{(["command", "shift", "option", "control"] as const).map(modifier => <label key={modifier}><input type="checkbox" checked={modifiers.includes(modifier)} onChange={event => setModifiers(current => event.target.checked ? [...current, modifier] : current.filter(m => m !== modifier))} />{modifier}</label>)}</div></fieldset></>}
        <button className="dv-primary" disabled={blocked || !window || (pointer && !validPoint) || (mode === "type_text" && !validText) || (mode === "scroll" && !validScroll)} type="submit">Request approval on Mac ↗</button>
      </form>}
    </>}
    <p className="dv-small">Controls bring the selected window forward first. Input delivery does not confirm what the receiving app did. Secure input and unavailable or obscured targets are blocked.</p>
  </section>;
}
