"use client";

import { useEffect, useRef } from "react";
import { renderTranscriptTurns } from "@/lib/transcript-display";
import styles from "./transcript-draft.module.css";

export function TranscriptDraft({ value, onChange }: {
  value: string;
  onChange: (value: string) => void;
}) {
  const editorRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (!value.trim() && editorRef.current) editorRef.current.open = true;
  }, [value]);
  const editor = <>
    <label htmlFor="meeting-transcript">Edit transcript or visit notes</label>
    <textarea
      required
      id="meeting-transcript"
      name="transcript"
      rows={10}
      maxLength={50000}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={"Doctor [00:00]: What brings you in today?\n\nPatient [00:04]: I’ve had…"}
    />
  </>;

  return <div className={styles.draft}>
    <p id="transcript-preview-label" className={styles.label}>Conversation transcript or visit notes</p>
    {value.trim() && <div className={styles.preview} role="region" aria-labelledby="transcript-preview-label" tabIndex={0}>
      {renderTranscriptTurns(value).map((turn) => <article key={turn.id} className={styles.turn}>
        <header><strong>{turn.speaker}</strong>{turn.time && <time>{turn.time}</time>}</header>
        <p>{turn.text}</p>
      </article>)}
    </div>}
    <details ref={editorRef} className={styles.editor} onInvalidCapture={() => {
      if (editorRef.current) editorRef.current.open = true;
    }}>
      <summary>Edit text</summary>
      {editor}
    </details>
  </div>;
}
