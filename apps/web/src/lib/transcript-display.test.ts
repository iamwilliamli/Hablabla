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

test("renders the reported MOSS decimal-timestamp transcript without hiding or truncating words", () => {
  const source = "[0.00]Also the doctor can now.[1.80][5.58]So the doctor now can speak.[7.14][11.10]Yeah, get something done.[13.14][13.14]Yep.[13.74][13.74]Good work. All right.[15.24][15.96]What did you uh, what did you make?[17.82][17.82]So we made a um offline transcription[21.54][22.26]system.[23.22][23.88]Okay.[24.66][24.66]That can identify different speakers and generate a summary and[29.64][30.78]maybe uh some research in medicine.[34.74][34.74]Okay.[35.64][35.64]Afterwards.[36.24][36.24]Okay.[37.44][38.64]And all of the transcription are done on device.[41.40][41.40]Right. Yeah. No, that's really good.[44.28][45.54]And afterwards we can tell the difference between[48.54]";
  const turns = renderTranscriptTurns(source);
  assert.equal(turns.length, 17);
  assert.deepEqual(turns[0], {id: 0, speaker: "Transcript", time: "00:00", text: "Also the doctor can now."});
  assert.equal(turns[1].time, "00:05.58");
  assert.equal(turns.at(-1)?.time, "00:45.54");
  assert.equal(turns.at(-1)?.text, "And afterwards we can tell the difference between");
  assert.equal(turns.map(turn => turn.text).join(""), source.replace(/\[\d+\.\d+\]/g, ""));
  assert.ok(turns.every(turn => turn.speaker === "Transcript"));
});

test("combines timestamp pairs with speaker tags and keeps unknown or incomplete markup literal", () => {
  assert.deepEqual(renderTranscriptTurns("[S01][0.00]Hello.[1.50][S02][2.25]Hi.[3.00]"), [
    {id: 0, speaker: "Speaker 1", time: "00:00", text: "Hello."},
    {id: 1, speaker: "Speaker 2", time: "00:02.25", text: "Hi."},
  ]);
  assert.deepEqual(renderTranscriptTurns("Speaker 2 [00:00]: [60.25]One minute.[62.00][3600.005]An hour.[3601.00]").map(turn => turn.time), ["01:00.25", "01:00:00.005"]);
  const source = "[0.00]<script>literal</script> [other].[1.00][2.00]unfinished text";
  const turns = renderTranscriptTurns(source);
  assert.equal(turns[0].text, "<script>literal</script> [other].");
  assert.equal(turns[1].text, "[2.00]unfinished text");
  for (const literal of ["Dose [2] tablets [4] times.", "Notes [2.00] and [4.00] stay literal.", "[5.00]Invalid range.[2.00]"]) {
    assert.equal(renderTranscriptTurns(literal)[0].text, literal);
  }
});
