import { MicrophoneCapture } from './capture.js';
import { compareTranscript } from './quality.js';
const $ = id => document.getElementById(id);
const elements = Object.fromEntries(['mode','language','hotwords','record','file','transcribe','cancel-job','clear','export'].map(id => [id,$(id)]));
let phase = 'idle', generation = 0, capture, socket, file, fileURL, job, jobKey, jobController;
let capabilities, revision = -1, liveResult, mossResult, durationMs = 0, startedAt, stoppedAt, firstAt, loadTimer, finishTimer;
let recordingMode = 'record', jobSettings, sessionController;
let modelSelectionInitialized = false;
const events = [];
function log(type, detail = {}) {
  events.push({ time: new Date().toISOString(), type, ...detail });
  if (events.length > 250) events.shift();
  $('event-count').textContent = `${events.length} events`;
  $('events').textContent = events.map(e => JSON.stringify(e)).join('\n');
  $('events').scrollTop = $('events').scrollHeight;
  elements.export.disabled = false;
}
function status(text, kind = '') { $('status').textContent = text; $('status').dataset.kind = kind; }
function showError(error) {
  const message = error?.name === 'NotAllowedError' ? 'Microphone access was denied. Allow microphone access in your browser site settings, then try again.' : error?.message || String(error);
  $('error').hidden = false; $('error').textContent = message;
  status('Incomplete', 'error'); log('error', { message });
}
function clearError() { $('error').hidden = true; $('error').textContent = ''; }
function clock(ms) { return `${String(Math.floor(ms / 60000)).padStart(2,'0')}:${String(Math.floor(ms / 1000) % 60).padStart(2,'0')}`; }
function seconds(ms) { return `${(ms / 1000).toFixed(1)} s`; }
function renderControls() {
  const active = phase !== 'idle', isJob = phase === 'job';
  for (const id of ['mode','language','hotwords','file','clear']) elements[id].disabled = active;
  elements.record.disabled = isJob || phase === 'stopping';
  $('record-label').textContent = phase === 'recording' ? 'Stop recording' : phase === 'loading' ? 'Cancel loading' : phase === 'finishing' ? 'Cancel waiting' : phase === 'stopping' ? 'Saving recording…' : 'Start recording';
  $('recorder').classList.toggle('recording', phase === 'recording');
  elements.transcribe.disabled = active || !file || !capabilities;
  elements.transcribe.textContent = jobKey ? 'Retry / check MOSS job' : 'Transcribe with MOSS →';
  elements['cancel-job'].hidden = !isJob;
  elements['cancel-job'].disabled = !job;
}
function modeHint() {
  const mode = elements.mode.value;
  if (mode === 'parakeet') {
    if (['zh','auto'].includes(elements.language.value)) elements.language.value = 'en';
    $('mode-hint').textContent = 'For English and other supported languages. Recording starts when the model is ready. For Chinese, use MOSS or configured Nemotron.';
  } else $('mode-hint').textContent = mode === 'nemotron' ? 'Multilingual live transcription with hotwords. Check the final text against your recording.' : 'Record and listen first, then transcribe the full audio. MOSS can return speaker segments.';
  for (const option of elements.language.options) option.disabled = mode === 'parakeet' && ['auto','zh'].includes(option.value);
}
elements.mode.onchange = () => { modelSelectionInitialized = true; modeHint(); };
function hotwords() {
  const words = [...new Set(elements.hotwords.value.split(/[,，\n]/u).map(s => s.trim()).filter(Boolean))];
  if (words.length > 64 || words.some(w => w.length > 80)) throw new Error('Use up to 64 hotwords, each no longer than 80 characters.');
  return words;
}
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'x-hablabla-demo': '1', ...options.headers }, signal: options.signal || AbortSignal.timeout(30000) });
  const body = await response.json();
  if (!response.ok) {
    const message = body.error?.message || body.error || `HTTP ${response.status}`;
    const error = new Error(`${message}${body.error?.requestId ? `\nRequest ID: ${body.error.requestId}` : ''}`);
    throw error;
  }
  return body;
}
async function refresh() {
  try {
    capabilities = await api('/api/capabilities');
    $('connection').textContent = 'Gateway connected'; $('connection-dot').classList.add('green');
    const option = elements.mode.querySelector('[value="nemotron"]');
    option.disabled = !capabilities.nemotron?.configured;
    option.textContent = capabilities.nemotron?.configured ? `Nemotron 3.5 · Multilingual${capabilities.nemotron.chunkMs ? ` · ${capabilities.nemotron.chunkMs / 1000}s` : ''}` : 'Nemotron 3.5 · model not configured';
    if (!modelSelectionInitialized && capabilities.nemotron?.configured && phase === 'idle') { elements.mode.value = 'nemotron'; modeHint(); }
    modelSelectionInitialized = true;
    log('capabilities', { models: ['parakeet','moss'], nemotronConfigured: Boolean(capabilities.nemotron?.configured) });
  } catch (error) {
    capabilities = null; $('connection').textContent = 'Backend unavailable'; $('connection-dot').classList.remove('green'); showError(error);
  }
  renderControls();
}
$('refresh').onclick = refresh;
function resetResults() {
  liveResult = null; mossResult = null; revision = -1; job = null; jobKey = null; jobSettings = null;
  for (const [id,text] of [['live-text','Choose a live mode to see the transcript update as you speak.'],['moss-text','The full transcript and available speaker segments will appear here.']]) { $(id).textContent = text; $(id).classList.add('empty'); }
  $('segments').replaceChildren(); $('live-badge').textContent = 'Not started'; $('moss-badge').textContent = 'Not submitted';
  $('latency').textContent = '—'; $('finish-time').textContent = '—'; $('model-name').textContent = 'No model running';
  $('progress').hidden = true; updateQuality();
}
function setFile(next, ms = 0) {
  if (fileURL) URL.revokeObjectURL(fileURL);
  file = next; durationMs = ms; fileURL = URL.createObjectURL(file);
  $('audio-preview').hidden = false; $('file-name').textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(2)} MB`;
  $('playback').src = fileURL; $('download-audio').href = fileURL; $('download-audio').download = file.name;
  $('duration').textContent = ms ? clock(ms) : 'Reading'; renderControls();
}
$('playback').onloadedmetadata = () => { if (Number.isFinite($('playback').duration)) { durationMs = $('playback').duration * 1000; $('duration').textContent = clock(durationMs); } };
elements.file.onchange = () => {
  const next = elements.file.files[0]; if (!next || phase !== 'idle') return;
  const max = capabilities?.offline?.maximumUploadBytes || 200 * 1024 * 1024;
  if (next.size > max) { showError(new Error(`File exceeds the ${(max / 1024 / 1024).toFixed(0)} MB limit.`)); elements.file.value = ''; return; }
  const types = { wav: 'audio/wav', m4a: 'audio/mp4', mp3: 'audio/mpeg', webm: 'audio/webm', ogg: 'audio/ogg' };
  const type = types[next.name.split('.').pop().toLowerCase()];
  if (!type) { showError(new Error('Choose WAV, M4A, MP3, WebM, or Ogg audio.')); elements.file.value = ''; return; }
  clearError(); resetResults(); setFile(new File([next], next.name, { type: next.type || type })); status('Audio ready'); $('record-state').textContent = 'Audio selected';
};
elements.clear.onclick = () => {
  if (phase !== 'idle') return;
  if (fileURL) URL.revokeObjectURL(fileURL); file = null; fileURL = null; durationMs = 0;
  $('playback').removeAttribute('src'); $('playback').load(); $('audio-preview').hidden = true; elements.file.value = '';
  resetResults(); $('duration').textContent = '—'; $('clock').textContent = '00:00'; clearError(); status('Waiting for audio'); renderControls();
};
function updateQuality() {
  const reference = $('reference').value; const result = $('quality'); result.replaceChildren();
  for (const [label,text] of [['Live transcript',liveResult?.confirmedText],['MOSS',mossResult?.result?.text]]) {
    if (text === undefined || !reference.trim()) continue;
    const comparison = compareTranscript(reference,text);
    if (!comparison) continue;
    const item = document.createElement('div'); item.className = 'quality-score';
    if (comparison.limited) item.textContent = `${label}: comparison is limited to 4,000 words or characters. Use a shorter sample.`;
    else { item.append(`${label} · ${comparison.metric}`); const score = document.createElement('strong'); score.textContent = `${(comparison.rate * 100).toFixed(1)}%`; item.append(score,`${comparison.errors} edits / ${comparison.units} reference units`); }
    result.append(item);
  }
  if (!result.childNodes.length) { const hint = document.createElement('span'); hint.className = 'hint'; hint.textContent = 'Add a reference and finish transcription to see an error rate. This is not model confidence.'; result.append(hint); }
}
$('reference').oninput = updateQuality;
function meter(level, duration) {
  $('clock').textContent = clock(duration * 1000);
  const bars = document.querySelectorAll('.meter span');
  bars.forEach((bar,index) => { bar.style.transform = `scaleY(${1 + Math.min(level * 30,1) * (3 + 5 * Math.sin((index + duration * 10) * .7) ** 2)})`; });
  if (duration >= 600 && phase === 'recording') void stopRecording();
}
function clearTimers() { clearTimeout(loadTimer); clearTimeout(finishTimer); }
async function stopRecording() {
  if (phase !== 'recording') return;
  phase = 'stopping'; renderControls(); stoppedAt = performance.now();
  try {
    const result = await capture.stop();
    setFile(new File([result.blob], `recording-${new Date().toISOString().replace(/[:.]/g,'-')}.wav`, {type:'audio/wav'}), result.durationMs);
    document.querySelectorAll('.meter span').forEach(bar => { bar.style.transform = ''; });
    $('record-state').textContent = 'Recording saved'; $('capture-hint').textContent = 'Listen back, download, or compare with MOSS';
    if (recordingMode !== 'record' && socket?.readyState === WebSocket.OPEN) {
      phase = 'finishing'; status('Waiting for final transcript'); socket.send(JSON.stringify({type:'finish'}));
      finishTimer = setTimeout(() => { void failRecording(new Error('Timed out waiting for the final transcript. Your recording is saved; you can try MOSS.')); },90000);
    } else { phase = 'idle'; status('Recording ready'); }
  } catch (error) { phase = 'idle'; showError(error); socket?.close(); }
  renderControls();
}
async function failRecording(error) {
  clearTimers();
  const wasRecording = phase === 'recording';
  if (wasRecording) { recordingMode = 'record'; await stopRecording(); }
  capture?.dispose(); socket?.close(); phase = 'idle';
  $('record-state').textContent = file ? 'Recording kept' : 'No recording yet';
  $('progress').hidden = true; $('live-badge').textContent = 'Incomplete'; showError(error); renderControls();
}
async function beginRecording() {
  clearError(); const thisGeneration = ++generation;
  let words;
  try { words = hotwords(); } catch(error) { showError(error); return; }
  recordingMode = elements.mode.value;
  resetResults(); phase = 'loading'; renderControls(); $('record-state').textContent = 'Requesting microphone'; $('clock').textContent = '00:00';
  let sequence = 0;
  capture = new MicrophoneCapture({
    onLevel: meter,
    onInterrupted: () => { if (thisGeneration === generation) void failRecording(new Error('The microphone disconnected or audio processing was interrupted.')); },
    onPacket: pcm => {
      if (thisGeneration !== generation || recordingMode === 'record' || socket?.readyState !== WebSocket.OPEN) return;
      if (socket.bufferedAmount > 4 * 1024 * 1024) { void failRecording(new Error('The transcription connection is too slow. Streaming stopped; retry using your saved recording.')); return; }
      const packet = new ArrayBuffer(8 + pcm.byteLength), view = new DataView(packet);
      view.setUint32(0,sequence++,true); view.setUint32(4,pcm.byteLength / 2,true); new Uint8Array(packet,8).set(new Uint8Array(pcm)); socket.send(packet);
    },
  });
  function start() {
    if (thisGeneration !== generation || phase !== 'loading') return;
    clearTimeout(loadTimer); phase = 'recording'; startedAt = performance.now(); stoppedAt = null; firstAt = null;
    capture.start(); $('record-state').textContent = 'Recording'; $('capture-hint').textContent = 'Microphone active · Stop to save the audio';
    $('progress').hidden = true; status(recordingMode === 'record' ? 'Recording' : 'Transcribing live'); renderControls();
  }
  try {
    const currentCapture = capture;
    await currentCapture.prepare();
    if (thisGeneration !== generation) { currentCapture.dispose(); return; }
    if (recordingMode === 'record') { start(); return; }
    $('record-state').textContent = 'Waiting for model'; status('Loading speech model'); $('live-badge').textContent = 'Loading'; $('model-name').textContent = recordingMode;
    sessionController = new AbortController();
    const ticket = await api(`/api/${recordingMode}/sessions`, { method:'POST', headers:{'content-type':'application/json'}, signal:sessionController.signal,
      body:JSON.stringify({origin:location.origin,language:elements.language.value,audio:{encoding:'pcm_s16le',sampleRateHz:16000,channels:1},...(recordingMode === 'nemotron' ? {hotwords:words}: {})}) });
    if (thisGeneration !== generation) return;
    const ws = socket = new WebSocket(ticket.websocketUrl);
    loadTimer = setTimeout(() => { if (thisGeneration === generation) void failRecording(new Error('Model loading exceeded 10 minutes. Check the download progress in the terminal and retry.')); },600000);
    ws.onopen = () => { ws.send(JSON.stringify({type:'start'})); log('stream-connected',{sessionId:ticket.sessionId}); };
    ws.onmessage = ({data}) => {
      if (thisGeneration !== generation) return;
      let event;
      try { event = JSON.parse(data); } catch { void failRecording(new Error('The backend returned an invalid streaming event.')); return; }
      if (event.type !== 'transcript') log(event.type,{stage:event.stage,progress:event.progress,error:event.error});
      if (event.type === 'error') { void failRecording(new Error(`${event.error?.message || 'Speech model failed'}\nRequest ID: ${event.error?.requestId || ticket.sessionId}`)); return; }
      if (event.type === 'progress') { $('progress').hidden = false; $('progress').value = event.progress || 0; }
      if (event.type === 'ready') { $('model-name').textContent = event.model; $('live-badge').textContent = 'Transcribing'; start(); }
      if (event.type === 'transcript' && event.revision > revision) {
        revision = event.revision;
        if (!firstAt && (event.confirmedText || event.volatileText)) { firstAt = performance.now(); $('latency').textContent = seconds(firstAt - startedAt); }
        $('live-text').classList.remove('empty'); $('live-text').replaceChildren(document.createTextNode(event.confirmedText || ''));
        const volatile = document.createElement('span'); volatile.className = 'volatile'; volatile.textContent = event.volatileText || ''; $('live-text').append(volatile);
        if (event.isFinal) {
          clearTimers(); liveResult = event; phase = 'idle';
          $('live-badge').textContent = 'Final result'; $('finish-time').textContent = stoppedAt ? seconds(performance.now() - stoppedAt) : '—';
          status(event.confirmedText?.trim() ? 'Live transcription complete' : 'Complete · no speech recognized', event.confirmedText?.trim() ? 'success' : '');
          log('stream-final',{revision,audioEndMs:event.audioEndMs,characters:event.confirmedText?.length || 0}); updateQuality(); renderControls();
        }
      }
    };
    ws.onerror = () => { if (thisGeneration === generation) void failRecording(new Error('The streaming connection failed. Check that the local speech backend is still running.')); };
    ws.onclose = () => { if (thisGeneration === generation && !liveResult && ['loading','recording','finishing'].includes(phase)) void failRecording(new Error('The connection closed without a final transcript. If your recording was saved, you can submit it to MOSS.')); };
  } catch(error) { if (thisGeneration === generation) await failRecording(error); }
}
elements.record.onclick = async () => {
  if (phase === 'idle') await beginRecording();
  else if (phase === 'recording') await stopRecording();
  else if (['loading','finishing'].includes(phase)) {
    ++generation; sessionController?.abort(); clearTimers(); capture?.dispose(); socket?.close(); phase = 'idle';
    $('record-state').textContent = file ? 'Recording kept' : 'Cancelled'; $('progress').hidden = true; $('live-badge').textContent = 'Cancelled'; status('Cancelled'); renderControls();
  }
};
function renderMoss(value) {
  mossResult = value; $('moss-badge').textContent = 'Final result'; $('moss-text').classList.remove('empty'); $('moss-text').textContent = value.result.text || 'No speech recognized';
  $('segments').replaceChildren();
  for (const segment of value.result.segments || []) {
    const row = document.createElement('div'); row.className = 'segment';
    const seek = document.createElement('button'); seek.textContent = segment.speakerId || 'Unlabeled speaker';
    const time = document.createElement('small'); time.textContent = `${clock(segment.startMs)} – ${clock(segment.endMs)}`; seek.append(time);
    seek.setAttribute('aria-label', `Play ${segment.speakerId || 'this segment'} ${clock(segment.startMs)}`);
    seek.onclick = () => { $('playback').currentTime = segment.startMs / 1000; void $('playback').play().catch(showError); };
    const text = document.createElement('p'); text.textContent = segment.text; row.append(seek,text); $('segments').append(row);
  }
  updateQuality();
}
async function transcribe() {
  if (!file || phase !== 'idle') return;
  clearError(); const thisGeneration = ++generation; jobController = new AbortController();
  try {
    const settings = {language:elements.language.value,hotwords:hotwords()};
    if (!jobKey || JSON.stringify(settings) !== JSON.stringify(jobSettings)) {
      jobKey = crypto.randomUUID(); jobSettings = settings; job = null; mossResult = null;
      $('moss-text').textContent = 'Waiting for the new full transcript…'; $('moss-text').classList.add('empty');
      $('segments').replaceChildren(); updateQuality();
    }
    phase = 'job'; $('progress').hidden = false; $('progress').removeAttribute('value'); status('Uploading recording'); $('model-name').textContent = 'MOSS · full recording'; renderControls();
    const form = new FormData(); form.set('audio',file,file.name); form.set('language',jobSettings.language); form.set('hotwords',JSON.stringify(jobSettings.hotwords));
    const created = await api('/api/jobs',{method:'POST',headers:{'idempotency-key':jobKey},body:form,signal:jobController.signal});
    job = created.jobId; log('moss-created',{jobId:job}); renderControls();
    const began = performance.now(); let previous;
    while (thisGeneration === generation) {
      const value = await api(`/api/jobs/${job}`,{signal:jobController.signal});
      if (value.status !== previous) { log('moss-status',{jobId:job,status:value.status}); previous = value.status; }
      const label = {queued:'Queued',processing:'Transcribing full recording',completed:'Transcription complete',failed:'Transcription failed',cancelled:'Cancelled'}[value.status] || value.status;
      $('moss-badge').textContent = label; status(label); $('progress').value = value.progress || 0;
      if (value.status === 'completed') { renderMoss(value); jobKey = null; status(value.result.text?.trim() ? 'MOSS transcription complete' : 'Complete · no speech recognized','success'); break; }
      if (value.status === 'failed') { jobKey = null; throw new Error(`${value.error?.message || 'MOSS transcription failed'}\nRequest ID: ${value.error?.requestId || job}`); }
      if (value.status === 'cancelled') { jobKey = null; break; }
      if (performance.now() - began > 900000) throw new Error('Waited for 15 minutes. The job may still be running; retry to check the same job.');
      await new Promise(resolve => setTimeout(resolve,800));
    }
  } catch(error) { if (error.name !== 'AbortError') showError(error); }
  finally { if (thisGeneration === generation) { phase = 'idle'; $('progress').hidden = true; renderControls(); } }
}
elements.transcribe.onclick = transcribe;
elements['cancel-job'].onclick = async () => {
  if (!job) { status('Uploading. Cancellation is available once the job is created.'); return; }
  try {
    const result = await api(`/api/jobs/${job}`,{method:'DELETE'}); log('moss-cancel',{jobId:job,status:result.status});
    ++generation; jobController.abort(); phase = 'idle'; $('progress').hidden = true;
    if (result.status === 'completed') { renderMoss(result); status('Transcription already complete','success'); }
    else { status('Cancelled'); $('moss-badge').textContent = 'Cancelled'; jobKey = null; }
    renderControls();
  } catch(error) { showError(error); }
};
elements.export.onclick = () => {
  const report = {createdAt:new Date().toISOString(),audio:file ? {name:file.name,bytes:file.size,durationMs}:null,language:elements.language.value,reference:$('reference').value,live:liveResult,moss:mossResult,events};
  const url = URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));
  const link = document.createElement('a'); link.href = url; link.download = 'hablabla-speech-test.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
};
window.addEventListener('beforeunload',() => { capture?.dispose(); socket?.close(); jobController?.abort(); });
modeHint(); renderControls(); void refresh();
