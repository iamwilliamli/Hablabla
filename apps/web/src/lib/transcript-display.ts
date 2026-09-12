export type TranscriptTurn = {
  id: number;
  speaker: string;
  time: string;
  text: string;
};

function displaySeconds(value: string) {
  const milliseconds = Math.round(Number(value) * 1000);
  if (!Number.isSafeInteger(milliseconds)) return undefined;
  const seconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  const fraction = milliseconds % 1000;
  return `${hours ? `${hours.toString().padStart(2, "0")}:` : ""}${minutes.toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}${fraction ? `.${fraction.toString().padStart(3, "0").replace(/0$/, "")}` : ""}`;
}

// Presentation only: the original transcript remains the editable source.
export function renderTranscriptTurns(transcript: string): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const paragraph of transcript.split(/\n\s*\n/).filter(Boolean)) {
    const heading = paragraph.match(/^([^\n:]+?)\s*\[(\d+:\d{2}(?::\d{2})?)\]:\s*([\s\S]*)$/);
    let speaker = heading?.[1] ?? "Transcript";
    const time = heading?.[2] ?? "";
    const body = heading?.[3] ?? paragraph;
    const appendBody = (text: string, startTime: string) => {
      let cursor = 0;
      let current: TranscriptTurn | undefined;
      const append = (part: string) => {
        if (!part.trim()) return;
        if (current?.speaker === speaker) {
          current.text += part;
        } else {
          current = { id: turns.length, speaker, time: startTime, text: part };
          turns.push(current);
        }
        startTime = "";
      };
      for (const marker of text.matchAll(/\[S(\d+)\]/g)) {
        append(text.slice(cursor, marker.index));
        speaker = `Speaker ${marker[1].replace(/^0+(?=\d)/, "")}`;
        cursor = marker.index + marker[0].length;
      }
      append(text.slice(cursor));
    };

    // MOSS can return adjacent [start seconds]text[end seconds] spans.
    // Require a timestamp-led body so bracketed numbers in ordinary notes stay literal.
    let cursor = 0;
    if (/^\s*(?:\[S\d+\]\s*)*\[\d+\.\d+\]/.test(body)) {
      for (const span of body.matchAll(/\[(\d+\.\d+)\]([\s\S]*?)\[(\d+\.\d+)\]/g)) {
        const startTime = displaySeconds(span[1]);
        if (!startTime || !displaySeconds(span[3]) || Number(span[3]) < Number(span[1]) || !span[2].replace(/\[S\d+\]/g, "").trim()) continue;
        appendBody(body.slice(cursor, span.index), cursor === 0 ? time : "");
        appendBody(span[2], startTime);
        cursor = span.index + span[0].length;
      }
    }
    appendBody(body.slice(cursor), cursor === 0 ? time : "");
  }
  return turns.map((turn) => ({ ...turn, text: turn.text.trim() }));
}
