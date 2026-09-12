export type TranscriptTurn = {
  id: number;
  speaker: string;
  time: string;
  text: string;
};

// Presentation only: the original transcript remains the editable source.
export function renderTranscriptTurns(transcript: string): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const paragraph of transcript.split(/\n\s*\n/).filter(Boolean)) {
    const heading = paragraph.match(/^([^\n:]+?)\s*\[(\d+:\d{2}(?::\d{2})?)\]:\s*([\s\S]*)$/);
    let speaker = heading?.[1] ?? "Transcript";
    let time = heading?.[2] ?? "";
    const body = heading?.[3] ?? paragraph;
    let cursor = 0;
    let current: TranscriptTurn | undefined;
    const append = (text: string) => {
      if (!text.trim()) return;
      if (current?.speaker === speaker) {
        current.text += text;
      } else {
        current = { id: turns.length, speaker, time, text };
        turns.push(current);
      }
      time = "";
    };
    for (const marker of body.matchAll(/\[S(\d+)\]/g)) {
      append(body.slice(cursor, marker.index));
      speaker = `Speaker ${marker[1].replace(/^0+(?=\d)/, "")}`;
      cursor = marker.index + marker[0].length;
    }
    append(body.slice(cursor));
  }
  return turns.map((turn) => ({ ...turn, text: turn.text.trim() }));
}
