"use client";

import { useEffect, useState } from "react";
import styles from "./recording-preview.module.css";

export function RecordingPreview({ recording }: { recording: File }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    const next = URL.createObjectURL(recording);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [recording]);
  return <div className={styles.recording}>
    <div className={styles.heading}><strong>Meeting recording</strong><span>{recording.name}</span></div>
    {url && <><audio controls preload="metadata" src={url} aria-label="Meeting recording playback" /><a href={url} download={recording.name}>Download audio</a></>}
    <small>Kept with this meeting for this browser session. Download before reloading.</small>
  </div>;
}
