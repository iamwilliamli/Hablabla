/** Live gateway checks. Audio and results stay in the caller-selected local output directory. */
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { basename, extname, resolve } from 'node:path';
import WebSocket from 'ws';

const base = process.env.HABLABLA_TEST_URL || 'http://127.0.0.1:8765';
const key = process.env.HABLABLA_SPEECH_API_KEYS?.split(',')[0];
assert(key, 'HABLABLA_SPEECH_API_KEYS is required');
const origin = process.env.HABLABLA_TEST_ORIGIN || 'http://localhost:3100';
const output = resolve(process.env.HABLABLA_TEST_OUTPUT || '.data/backend-demo');
await mkdir(output, { recursive: true });
const checks = [];
async function check(name, run) {
  const start = Date.now();
  try { await run(); checks.push({ name, status: 'passed', milliseconds: Date.now() - start }); }
  catch (error) { checks.push({ name, status: 'failed', error: error.message }); }
  console.log(JSON.stringify(checks.at(-1)));
  await writeFile(`${output}/speech-checks.json`, JSON.stringify(checks, null, 2));
}
async function request(path, options = {}) {
  return fetch(base + path, { ...options, headers: { authorization: `Bearer ${key}`, ...options.headers }, signal: options.signal || AbortSignal.timeout(15000) });
}
async function expect(path, status, options) { const r = await request(path, options); assert.equal(r.status, status); return r.json(); }
const sessionBody = { origin, language: 'en', audio: { encoding: 'pcm_s16le', sampleRateHz: 16000, channels: 1 } };
const json = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function session() { return expect('/v1/parakeet/sessions', 201, json(sessionBody)); }
await check('GET healthz', async () => assert.equal((await expect('/healthz', 200)).status, 'ok'));
await check('GET capabilities', async () => assert.equal((await expect('/v1/capabilities', 200)).streaming.audio.sampleRateHz, 16000));
for (const [method, path] of [['GET','/v1/capabilities'],['POST','/v1/parakeet/sessions'],['POST','/v1/moss/transcriptions'],['GET','/v1/moss/transcriptions/missing'],['GET','/v1/moss/transcriptions/missing/events'],['DELETE','/v1/moss/transcriptions/missing']]) {
  await check(`${method} ${path} rejects missing authorization`, () => expect(path, 401, { method, headers: { authorization: '' } }));
}
await check('Unknown job', () => expect('/v1/moss/transcriptions/missing', 404));
await check('Disallowed origin', () => expect('/v1/capabilities', 403, { headers: { origin: 'https://invalid.example' } }));
await check('Invalid stream config', () => expect('/v1/parakeet/sessions', 400, json({ ...sessionBody, audio: {} })));
await check('Create stream ticket', async () => assert((await session()).websocketUrl));
await check('Invalid WebSocket ticket', async () => {
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(base.replace('http', 'ws') + '/v1/parakeet/stream?ticket=invalid', { origin, handshakeTimeout: 5000 });
    ws.on('unexpected-response', (_, r) => { r.resume(); ws.terminate(); try { assert.equal(r.statusCode, 403); resolve(); } catch(e) { reject(e); } });
    ws.on('open', () => { ws.close(); reject(new Error('Invalid ticket accepted')); });
    ws.on('error', () => {});
  });
});
const uploadPath = '/v1/moss/transcriptions';
async function upload(bytes, type = 'audio/wav', id = randomUUID(), name = 'invalid.wav') {
  const form = new FormData(); form.set('audio', new Blob([bytes], { type }), name); form.set('language','en');
  return request(uploadPath, { method: 'POST', headers: { 'idempotency-key': id }, body: form });
}
await check('Upload requires idempotency key', () => expect(uploadPath, 400, { method: 'POST' }));
await check('Unsupported upload type', async () => assert.equal((await upload('invalid', 'text/plain')).status, 415));
let invalidJob;
await check('Create invalid-audio job and reuse idempotency key', async () => {
  const id = randomUUID(); const response = await upload('not audio', 'audio/wav', id);
  assert.equal(response.status, 202); invalidJob = await response.json();
  const retry = await upload('not audio', 'audio/wav', id); assert.equal(retry.status, 200);
  assert.equal((await retry.json()).jobId, invalidJob.jobId);
});
async function terminal(path, timeout = 600000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { const job = await expect(path, 200); if (['completed','failed','cancelled'].includes(job.status)) return job; await new Promise(r => setTimeout(r, 1000)); }
  throw new Error('Job timed out');
}
await check('Invalid audio reaches failed job', async () => assert.equal((await terminal(invalidJob.statusUrl, 15000)).error.code, 'INVALID_AUDIO'));
await check('SSE closes for already terminal job', async () => {
  const r = await request(invalidJob.eventsUrl, { signal: AbortSignal.timeout(3000) }); assert.equal(r.status, 200);
  const text = await r.text(); assert(text.includes('"failed"'));
});
await check('DELETE terminal job preserves state', async () => assert.equal((await expect(invalidJob.statusUrl, 200, { method: 'DELETE' })).status, 'failed'));
const audioPath = process.argv[2];
if (audioPath) {
  const source = await readFile(audioPath);
  const pcm = spawnSync(process.env.HABLABLA_FFMPEG || 'ffmpeg', ['-v','error','-i',audioPath,'-f','s16le','-ac','1','-ar','16000','pipe:1'], { maxBuffer: 200 * 1024 * 1024 });
  assert.equal(pcm.status, 0, pcm.stderr.toString());
  await check('Real audio Parakeet final transcript', async () => {
    const ticket = await session(); const events = [];
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(ticket.websocketUrl, { origin });
      const timer = setTimeout(() => { ws.terminate(); reject(new Error('Stream timed out')); }, 600000);
      ws.on('message', async data => {
        let event; try { event = JSON.parse(data); } catch(e) { reject(e); ws.close(); return; }
        events.push(event);
        if (event.type === 'ready') {
          for (let offset = 0, sequence = 0; offset < pcm.stdout.length && ws.readyState === WebSocket.OPEN; offset += 3200, sequence++) {
            const chunk = pcm.stdout.subarray(offset, offset + 3200); const packet = Buffer.alloc(chunk.length + 8);
            packet.writeUInt32LE(sequence,0); packet.writeUInt32LE(chunk.length / 2,4); chunk.copy(packet,8); ws.send(packet);
            await new Promise(r => setTimeout(r,100));
          }
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'finish' }));
        }
      });
      ws.on('open', () => ws.send(JSON.stringify({ type: 'start' })));
      ws.on('error', reject);
      ws.on('close', () => { clearTimeout(timer); resolve(); });
    });
    await writeFile(`${output}/parakeet-events.json`, JSON.stringify(events,null,2));
    const final = events.findLast(e => e.type === 'transcript' && e.isFinal);
    assert(final?.confirmedText?.trim(), 'No non-empty final transcript');
    assert.equal(final.audioEndMs, Math.round(pcm.stdout.length / 32));
  });
  const type = ({ '.wav':'audio/wav','.mp3':'audio/mpeg','.m4a':'audio/mp4','.webm':'audio/webm','.mp4':'audio/mp4','.ogg':'audio/ogg' })[extname(audioPath).toLowerCase()];
  assert(type, 'Unsupported test audio extension');
  let job;
  await check('Real audio MOSS upload', async () => { const r = await upload(source,type,randomUUID(),basename(audioPath)); assert.equal(r.status,202); job = await r.json(); });
  await check('Real audio MOSS SSE and final transcript', async () => {
    const r = await request(job.eventsUrl, { signal: AbortSignal.timeout(600000) });
    const events = await r.text(); await writeFile(`${output}/moss-events.txt`,events);
    const final = await terminal(job.statusUrl); await writeFile(`${output}/moss-result.json`,JSON.stringify(final,null,2));
    assert.equal(final.status,'completed'); assert(final.result.text.trim()); assert(final.result.segments.length > 0);
  });
  await check('Cancel real audio job', async () => {
    const r = await upload(source,type,randomUUID(),basename(audioPath)); const created = await r.json();
    const cancelled = await expect(created.statusUrl,200,{method:'DELETE'}); assert.equal(cancelled.status,'cancelled');
    assert.equal((await expect(created.statusUrl,200)).status,'cancelled');
  });
} else {
  checks.push({ name: 'Real consultation Parakeet/MOSS success and active cancellation', status: 'blocked', reason: 'Audio path not supplied' });
}
await writeFile(`${output}/speech-checks.json`,JSON.stringify(checks,null,2));
process.exitCode = checks.some(c => c.status === 'failed') ? 1 : 0;
