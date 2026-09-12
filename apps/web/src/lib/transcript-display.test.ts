import assert from "node:assert/strict";
import test from "node:test";
import { renderTranscriptTurns } from "./transcript-display";

test("renders embedded speaker changes without repeating labels or inventing times", () => {
  const turns = renderTranscriptTurns("Speaker 1 [00:00]: Record.[S01] Um,[S01] in real time. [S02] Oh really? [S01] Yeah.");
  assert.deepEqual(turns, [
    { id: 0, speaker: "Speaker 1", time: "00:00", text: "Record. Um, in real time." },
    { id: 1, speaker: "Speaker 2", time: "", text: "Oh really?" },
    { id: 2, speaker: "Speaker 1", time: "", text: "Yeah." },
  ]);
});

test("keeps named speakers, timestamps, multiline notes and literal markup", () => {
  assert.deepEqual(renderTranscriptTurns("Doctor [01:04]: First line\nSecond line\n\nPatient [01:08]: <script>hello</script>").map(({ speaker, time, text }) => ({ speaker, time, text })), [
    { speaker: "Doctor", time: "01:04", text: "First line\nSecond line" },
    { speaker: "Patient", time: "01:08", text: "<script>hello</script>" },
  ]);
  assert.equal(renderTranscriptTurns("Notes [other] stay intact.")[0].text, "Notes [other] stay intact.");
  assert.deepEqual(renderTranscriptTurns(""), []);
});

test("does not truncate long transcripts or renumber speaker identifiers", () => {
  const body = "word ".repeat(12000);
  const turns = renderTranscriptTurns(`[S03]${body}[S12]Last word.`);
  assert.equal(turns[0].speaker, "Speaker 3");
  assert.equal(turns[0].text, body.trim());
  assert.equal(turns[1].speaker, "Speaker 12");
  assert.equal(turns[1].text, "Last word.");
});
