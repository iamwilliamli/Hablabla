import test from 'node:test';
import assert from 'node:assert/strict';
import { compareTranscript } from './quality.js';
import { wavBlob } from './capture.js';

test('Reference comparison counts omitted negation and numbers, ignoring punctuation/case', () => {
  assert.equal(compareTranscript('I do not take 250 milligrams.', 'i do take 500 milligrams').errors, 2);
  assert.equal(compareTranscript('HELLO, world!', 'hello world').rate, 0);
  assert.equal(compareTranscript('no', 'no pain and no cough').rate, 4);
  assert.equal(compareTranscript('', 'hello'), null);
});
test('Chinese uses character error rate and preserves a missing negation', () => {
  const result = compareTranscript('我没有药物过敏。', '我有药物过敏');
  assert.equal(result.errors, 1); assert.equal(result.units, 7); assert.match(result.metric, /CER/);
  assert.equal(compareTranscript('你好'.repeat(2500), '你好').limited, true);
});
test('Recorded WAV includes every final partial PCM sample at the actual 16 kHz rate', async () => {
  const samples = new Int16Array([0, 32767, -32768, 150]);
  const blob = wavBlob([samples.buffer.slice(0,6), samples.buffer.slice(6)]);
  const view = new DataView(await blob.arrayBuffer());
  assert.equal(blob.type, 'audio/wav'); assert.equal(blob.size, 52);
  assert.equal(view.getUint32(24,true),16000); assert.equal(view.getUint16(22,true),1);
  assert.equal(view.getUint32(40,true),8); assert.equal(view.getInt16(48,true),-32768); assert.equal(view.getInt16(50,true),150);
});
