/* Interview AI Station, version 1.0.
 * Every spoken line comes from master.json and is played from pre-recorded audio.
 * The applicant never types. Answers are saved on this computer first, then uploaded.
 */
'use strict';

const APP_VERSION = '1.0';
const SAMPLE_RATE = 16000;
const $ = (id) => document.getElementById(id);

const S = {
  cfg: {}, master: null, db: null,
  voiceUrls: {},            // id -> object URL
  audio: { ctx: null, stream: null, node: null, sink: null, frames: [], level: 0, noise: 0.004 },
  rec: null,                // current recording
  session: null,            // current session state
  paused: false, pauseWaiters: [],
  playing: null,            // current HTMLAudioElement
  skip: false, finishPressed: false, hearAgain: null,
  queueBusy: false,
};

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function todayStr() {
  const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function loadCfg() { try { S.cfg = JSON.parse(localStorage.getItem('station.cfg') || '{}'); } catch (e) { S.cfg = {}; } }
function saveCfg() { try { localStorage.setItem('station.cfg', JSON.stringify(S.cfg)); } catch (e) { } }
function show(id) {
  document.querySelectorAll('.screen').forEach((s) => { s.hidden = s.id !== id; });
}
function workDate() { return S.cfg.date || todayStr(); }
function uid() { return (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)); }
function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), Math.max(0, ms)))]);
}

/* ------------------------------------------------------------------ */
/* IndexedDB                                                           */
/* ------------------------------------------------------------------ */
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('interview-station', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('voice')) db.createObjectStore('voice', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('answers')) db.createObjectStore('answers', { keyPath: 'localId' });
      if (!db.objectStoreNames.contains('events')) db.createObjectStore('events', { keyPath: 'localId' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function idb(store, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = S.db.transaction(store, mode);
    const st = tx.objectStore(store);
    let out;
    Promise.resolve(fn(st)).then((v) => { out = v; });
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error);
  });
}
const idbPut = (store, val) => idb(store, 'readwrite', (st) => { st.put(val); });
const idbDel = (store, key) => idb(store, 'readwrite', (st) => { st.delete(key); });
function idbAll(store) {
  return new Promise((resolve, reject) => {
    const tx = S.db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

/* ------------------------------------------------------------------ */
/* Relay calls                                                         */
/* ------------------------------------------------------------------ */
async function api(method, params, timeoutMs) {
  if (!S.cfg.relay) throw new Error('No relay link set.');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 30000);
  try {
    let res;
    if (method === 'GET') {
      const u = new URL(S.cfg.relay);
      Object.entries(Object.assign({}, params, { token: S.cfg.token })).forEach(([k, v]) => u.searchParams.set(k, v));
      res = await fetch(u.toString(), { signal: ctrl.signal, redirect: 'follow' });
    } else {
      res = await fetch(S.cfg.relay, { method: 'POST', body: JSON.stringify(Object.assign({}, params, { token: S.cfg.token })), signal: ctrl.signal, redirect: 'follow' });
    }
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || 'Relay error');
    return j;
  } finally { clearTimeout(timer); }
}

/* ------------------------------------------------------------------ */
/* Events (kept locally, then sent)                                    */
/* ------------------------------------------------------------------ */
async function logEvent(event, detail) {
  const ev = {
    localId: uid(), ts: new Date().toISOString(), station: S.cfg.station,
    sessionId: S.session ? S.session.sessionId : '', code: S.session ? S.session.code : '',
    event, detail: typeof detail === 'string' ? detail : JSON.stringify(detail || '')
  };
  try { await idbPut('events', ev); } catch (e) { }
  pumpQueue();
}

/* ------------------------------------------------------------------ */
/* Voice lines                                                         */
/* ------------------------------------------------------------------ */
function lineText(id) {
  const l = (S.master.voice_lines || []).find((x) => x.id === id);
  return l ? l.text : '';
}
async function loadVoiceFromDb() {
  const all = await idbAll('voice');
  all.forEach((v) => {
    if (v.version === S.master.version && v.text === lineText(v.id)) {
      if (S.voiceUrls[v.id]) URL.revokeObjectURL(S.voiceUrls[v.id]);
      S.voiceUrls[v.id] = URL.createObjectURL(v.blob);
    }
  });
  return Object.keys(S.voiceUrls).length;
}
function b64ToBlob(b64, mime) {
  const bin = atob(b64); const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}
async function downloadVoice(onProgress) {
  const list = await api('GET', { action: 'voicelist' }, 30000);
  const lines = list.lines || [];
  let done = 0, missing = [];
  for (const l of lines) {
    if (!l.fileId) { missing.push(l.id); done++; onProgress(done, lines.length); continue; }
    let tries = 0;
    while (tries < 3) {
      try {
        const v = await api('GET', { action: 'voice', id: l.id }, 30000);
        await idbPut('voice', { id: l.id, text: lineText(l.id), version: S.master.version, blob: b64ToBlob(v.data, v.mime || 'audio/wav') });
        break;
      } catch (e) { tries++; if (tries >= 3) missing.push(l.id); await sleep(800); }
    }
    done++; onProgress(done, lines.length);
  }
  await loadVoiceFromDb();
  return { total: lines.length, missing, unverified: lines.filter((l) => l.fileId && !l.verified).map((l) => l.id) };
}

/* ------------------------------------------------------------------ */
/* Pause gate                                                          */
/* ------------------------------------------------------------------ */
function waitIfPaused() {
  if (!S.paused) return Promise.resolve();
  return new Promise((r) => S.pauseWaiters.push(r));
}
function setPaused(p) {
  S.paused = p;
  if (!p) { const w = S.pauseWaiters; S.pauseWaiters = []; w.forEach((r) => r()); }
}

/* ------------------------------------------------------------------ */
/* Playback                                                            */
/* ------------------------------------------------------------------ */
function setSubtitle(text, isQuestion) {
  const el = $('subtitle'); el.textContent = text || ''; el.classList.toggle('question', !!isQuestion);
}
function playUrlOnce(url) {
  return new Promise((resolve, reject) => {
    const a = new Audio(url);
    S.playing = a;
    a.onended = () => { S.playing = null; resolve('ended'); };
    a.onerror = () => { S.playing = null; reject(new Error('audio error')); };
    a.onpause = () => { if (!a.ended) { S.playing = null; resolve('interrupted'); } };
    a.play().catch((e) => { S.playing = null; reject(e); });
  });
}
function speakFallback(text) {
  return new Promise((resolve) => {
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 0.95; u.onend = () => resolve('ended'); u.onerror = () => resolve('ended');
      speechSynthesis.cancel(); speechSynthesis.speak(u);
    } catch (e) { resolve('ended'); }
  });
}
/* Play one approved line. Shows its exact text. Replays from the start if paused midway. */
async function say(id, opts) {
  opts = opts || {};
  const text = lineText(id);
  if (!text) throw new Error('Unknown line ' + id);
  for (;;) {
    await waitIfPaused();
    setSubtitle(text, !!opts.question);
    let result;
    if (S.voiceUrls[id]) {
      try { result = await playUrlOnce(S.voiceUrls[id]); }
      catch (e) { logEvent('voice_fallback_tts', id); result = await speakFallback(text); }
    } else { logEvent('voice_fallback_tts', id); result = await speakFallback(text); }
    if (result === 'interrupted' && S.paused) continue;
    break;
  }
  if (!opts.keep) await sleep(250);
}
function stopPlayback() {
  if (S.playing) { try { S.playing.pause(); } catch (e) { } }
  try { speechSynthesis.cancel(); } catch (e) { }
}

/* A soft two-note chime, generated here so it needs no file. */
function chime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const now = ctx.currentTime;
    [660, 880].forEach((f, i) => {
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0, now + i * 0.18);
      g.gain.linearRampToValueAtTime(0.06, now + i * 0.18 + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.18 + 0.6);
      o.connect(g).connect(ctx.destination); o.start(now + i * 0.18); o.stop(now + i * 0.18 + 0.65);
    });
    setTimeout(() => ctx.close(), 1500);
  } catch (e) { }
}

/* ------------------------------------------------------------------ */
/* Microphone capture (16 kHz mono)                                    */
/* ------------------------------------------------------------------ */
async function initMic() {
  if (S.audio.ctx && S.audio.ctx.state !== 'closed') { await S.audio.ctx.resume(); return; }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  const src = ctx.createMediaStreamSource(stream);
  const code = "class Cap extends AudioWorkletProcessor{process(i){const c=i[0]&&i[0][0];if(c)this.port.postMessage(c.slice(0));return true;}}registerProcessor('cap',Cap);";
  await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: 'application/javascript' })));
  const node = new AudioWorkletNode(ctx, 'cap');
  const sink = ctx.createGain(); sink.gain.value = 0;
  src.connect(node); node.connect(sink); sink.connect(ctx.destination);
  let acc = [], accLen = 0;
  node.port.onmessage = (e) => {
    const f = e.data;
    if (S.rec && !S.paused && !S.rec.stopped) { S.rec.chunks.push(f); S.rec.len += f.length; }
    acc.push(f); accLen += f.length;
    if (accLen >= 1600) {               // every 100 ms
      let sum = 0, n = 0;
      acc.forEach((a) => { for (let i = 0; i < a.length; i++) { sum += a[i] * a[i]; n++; } });
      const rms = Math.sqrt(sum / Math.max(1, n));
      S.audio.level = rms; acc = []; accLen = 0;
      onLevel(rms);
    }
  };
  S.audio = Object.assign(S.audio, { ctx, stream, node, sink });
  await ctx.resume();
}
function threshold() { return Math.max(0.012, S.audio.noise * 3.5); }
function onLevel(rms) {
  const bars = document.querySelectorAll('.meter i');
  const t = threshold();
  bars.forEach((b, i) => { const on = rms > t * (0.6 + i * 0.35); b.style.height = on ? (8 + i * 3.5) + 'px' : '6px'; });
  if (S.rec && !S.paused && !S.rec.stopped) {
    const now = performance.now();
    if (rms > t) { S.rec.loud++; if (S.rec.loud >= 3) { if (!S.rec.speech) S.rec.speechAt = now; S.rec.speech = true; } S.rec.lastVoice = now; S.rec.lastVoiceLen = S.rec.len; }
    else { S.rec.loud = 0; if (rms > t * 0.8) { S.rec.lastVoice = now; S.rec.lastVoiceLen = S.rec.len; } }
    S.rec.peak = Math.max(S.rec.peak, rms);
    if (S.rec.onTick) S.rec.onTick(rms);
  }
}
function concat(chunks, from, to) {
  const len = chunks.reduce((n, c) => n + c.length, 0);
  const all = new Float32Array(len); let o = 0;
  chunks.forEach((c) => { all.set(c, o); o += c.length; });
  return all.subarray(from || 0, to === undefined ? len : to);
}
function toWav(samples) {
  const buf = new ArrayBuffer(44 + samples.length * 2); const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, SAMPLE_RATE, true);
  v.setUint32(28, SAMPLE_RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, samples.length * 2, true);
  let o = 44;
  for (let i = 0; i < samples.length; i++) { const s = Math.max(-1, Math.min(1, samples[i])); v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2; }
  return new Blob([buf], { type: 'audio/wav' });
}
function blobToB64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/* ------------------------------------------------------------------ */
/* Listening for one answer                                            */
/* ------------------------------------------------------------------ */
function fmtClock(s) { s = Math.max(0, Math.ceil(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }

/**
 * Records one answer. Ends after `silence` seconds of quiet once speech has begun,
 * at the window limit plus grace, when the applicant taps "I have finished",
 * or when the proctor ends it. Optionally streams 20-second chunks for transcription.
 */
async function listen(o) {
  const T = S.master.timing;
  const windowSec = o.windowSec, grace = o.grace === undefined ? T.grace_seconds : o.grace;
  const silence = o.silence || T.silence_to_finish_seconds;
  $('listen').hidden = false; $('thinking').hidden = true; $('note').textContent = '';
  $('btn-again').hidden = !o.againId; $('btn-again').disabled = false;
  $('btn-finish').hidden = o.noFinish === true;
  S.finishPressed = false; S.skip = false;
  const rec = { chunks: [], len: 0, loud: 0, speech: false, speechAt: 0, lastVoice: 0, lastVoiceLen: 0, peak: 0, stopped: false, chunkFrom: 0, chunkPromises: [] };
  S.rec = rec;
  const startedAt = new Date().toISOString();
  let elapsed = 0, last = performance.now(), chimed = false, prompted = false, againUsed = false;

  const sendChunk = (from, to) => {
    const wav = toWav(concat(rec.chunks, from, to));
    const p = blobToB64(wav).then((b64) => api('POST', { action: 'transcribe', audio: b64, mime: 'audio/wav' }, 20000))
      .then((r) => r.transcript || '').catch(() => '');
    rec.chunkPromises.push(p);
  };

  await new Promise((resolve) => {
    const tick = setInterval(async () => {
      const now = performance.now();
      if (!S.paused && !S.hearAgain) elapsed += (now - last) / 1000;
      last = now;
      const remaining = windowSec - elapsed;
      $('clock').textContent = remaining > 0 ? fmtClock(remaining) : '';
      if (S.paused) return;
      if (!chimed && windowSec >= 30 && remaining <= T.chime_before_end_seconds) {
        chimed = true; chime(); $('note').textContent = 'About 15 seconds remain';
      }
      if (o.chunked && rec.speech) {
        // Transcribe in pieces while the applicant is still answering, so the follow-up can be chosen quickly.
        const unsent = rec.len - rec.chunkFrom;
        const quiet = S.audio.level < threshold();
        const speechInUnsent = rec.lastVoiceLen > rec.chunkFrom;
        const pausedTalking = speechInUnsent && (now - rec.lastVoice) / 1000 >= 1.5;
        if (speechInUnsent && ((unsent >= 15 * SAMPLE_RATE && quiet) || unsent >= 25 * SAMPLE_RATE || pausedTalking)) {
          sendChunk(rec.chunkFrom, rec.len); rec.chunkFrom = rec.len;
        }
      }
      if (!rec.speech && !prompted && o.silencePrompt !== false && elapsed >= T.no_speech_prompt_seconds && windowSec > T.no_speech_prompt_seconds + 5) {
        prompted = true; S.hearAgain = 'prompt';
        say('T_silence', { keep: true }).then(() => { S.hearAgain = null; setSubtitle(o.questionText || '', true); });
      }
      if (S.hearAgain === 'request' && !againUsed) {
        againUsed = true; S.hearAgain = 'playing'; $('btn-again').disabled = true; logEvent('hear_again', o.qid);
        say(o.againId, { question: true, keep: true }).then(() => { S.hearAgain = null; });
      }
      const silentFor = (now - rec.lastVoice) / 1000;
      const done = S.skip
        || (S.finishPressed && elapsed > 2)
        || (rec.speech && !S.hearAgain && silentFor >= silence && elapsed > 2)
        || (elapsed >= windowSec + grace);
      if (done) { clearInterval(tick); resolve(); }
    }, 100);
  });

  rec.stopped = true; S.rec = null;
  $('listen').hidden = true; $('note').textContent = '';
  const endedAt = new Date().toISOString();
  const samples = concat(rec.chunks);
  const tail = (o.chunked && rec.speech && rec.lastVoiceLen > rec.chunkFrom) ? samples.subarray(rec.chunkFrom) : null;
  return {
    samples, speech: rec.speech, peak: rec.peak, startedAt, endedAt, endedMs: Date.now(),
    durationSec: Math.round(samples.length / SAMPLE_RATE), chunkPromises: rec.chunkPromises, tail
  };
}

/* ------------------------------------------------------------------ */
/* Saving answers                                                      */
/* ------------------------------------------------------------------ */
async function saveAnswer(meta, result, extra) {
  const ses = S.session;
  const rec = {
    localId: uid(), uploaded: false, attempts: 0,
    meta: Object.assign({
      sessionId: ses.sessionId, code: ses.code, station: S.cfg.station, date: ses.date,
      startedAt: result.startedAt, endedAt: result.endedAt, durationSec: result.durationSec,
      speechDetected: result.speech ? 'true' : 'false', liveTranscript: ''
    }, meta, extra || {}),
    blob: toWav(result.samples)
  };
  await idbPut('answers', rec);
  pumpQueue();
  return rec;
}
async function pumpQueue() {
  if (S.queueBusy) return;
  S.queueBusy = true;
  try {
    for (;;) {
      const evs = await idbAll('events');
      if (evs.length) {
        try {
          await api('POST', { action: 'event', events: evs.map((e) => { const c = Object.assign({}, e); delete c.localId; return c; }) }, 20000);
          for (const e of evs) await idbDel('events', e.localId);
        } catch (e) { break; }
      }
      const pending = (await idbAll('answers')).filter((a) => !a.uploaded).sort((a, b) => (a.meta.startedAt < b.meta.startedAt ? -1 : 1));
      if (!pending.length) break;
      const a = pending[0];
      try {
        const b64 = await blobToB64(a.blob);
        await api('POST', { action: 'upload', meta: a.meta, audio: b64, mime: 'audio/wav' }, 120000);
        a.uploaded = true; await idbPut('answers', a);
      } catch (e) {
        a.attempts = (a.attempts || 0) + 1; await idbPut('answers', a);
        break;
      }
    }
  } finally {
    S.queueBusy = false;
    updateUploadStatus();
  }
}
setInterval(() => { if (S.db) pumpQueue(); }, 15000);
async function pendingCount() { return (await idbAll('answers')).filter((a) => !a.uploaded).length; }
async function updateUploadStatus() {
  try {
    const n = await pendingCount();
    const el = $('ctl-status'); if (el) el.dataset.pending = n;
    const d = $('done-upload'); if (d && !$('scr-done').hidden) d.textContent = n ? `Station note: ${n} recording(s) saved here, still uploading.` : 'Station note: all recordings uploaded.';
  } catch (e) { }
}

/* ------------------------------------------------------------------ */
/* Follow-up choice                                                    */
/* ------------------------------------------------------------------ */
async function chooseFollowup(n, res) {
  const T = S.master.timing;
  if (!res.speech) return { choice: 'DEFAULT', basis: '', model: 'no-speech', live: '' };
  const deadline = res.endedMs + T.route_timeout_seconds * 1000;
  let live = '';
  try {
    const parts = await withTimeout(Promise.all(res.chunkPromises), deadline - Date.now() - 2000);
    live = parts.join(' ').replace(/\s+/g, ' ').trim();
    const body = { action: 'route', situation: n, transcript: live };
    if (res.tail && res.tail.length > SAMPLE_RATE / 2) { body.audio = await blobToB64(toWav(res.tail)); body.mime = 'audio/wav'; }
    if (!live && !body.audio) { logEvent('route_timeout', 'empty transcript S' + n); return { choice: 'DEFAULT', basis: '', model: 'empty', live }; }
    const r = await api('POST', body, Math.max(1500, deadline - Date.now()));
    if (r.transcript) live = r.transcript;
    const c = String(r.choice || '').toUpperCase();
    if (!['F1', 'F2', 'F3', 'F4', 'DEFAULT'].includes(c)) return { choice: 'DEFAULT', basis: '', model: 'invalid', live };
    if (r.model === 'gemini') logEvent('route_fallback_gemini', 'S' + n);
    return { choice: c, basis: r.basis || '', model: r.model || '', live };
  } catch (e) {
    logEvent('route_timeout', 'S' + n + ': ' + e.message);
    return { choice: 'DEFAULT', basis: '', model: 'timeout', live };
  }
}

/* ------------------------------------------------------------------ */
/* Proctor waits (calm message for the applicant)                      */
/* ------------------------------------------------------------------ */
function waitForProctor(staffText, buttons) {
  return new Promise((resolve) => {
    $('wait-staff').textContent = staffText;
    const box = $('wait-buttons'); box.innerHTML = '';
    buttons.forEach((b) => {
      const el = document.createElement('button'); el.className = 'btn ' + (b.cls || ''); el.textContent = b.label;
      let t = null;
      const go = () => { $('ov-wait').hidden = true; resolve(b.value); };
      el.addEventListener('pointerdown', () => { t = setTimeout(go, 700); });
      ['pointerup', 'pointerleave'].forEach((ev) => el.addEventListener(ev, () => clearTimeout(t)));
      box.appendChild(el);
    });
    const hint = document.createElement('p'); hint.className = 'tiny'; hint.textContent = 'Proctor: press and hold a button.';
    box.appendChild(hint);
    $('ov-wait').hidden = false;
  });
}

/* ------------------------------------------------------------------ */
/* The session                                                         */
/* ------------------------------------------------------------------ */
function situation(n) { return S.master.situations.find((s) => s.n === n); }
function setSegment(text) { $('seg-label').textContent = text || ''; }
function setScene(key) { $('scene').innerHTML = key ? (window.SCENES[key] || '') : ''; }

function buildUnits() {
  const units = ['welcome', 'consent', 'soundcheck', 'practice', 'frame'];
  [1, 2, 3, 4].forEach((n) => units.push(`S${n}_open`, `S${n}_fu`, `S${n}_esc`, `S${n}_ref`));
  units.push('ratings', 'redo', 'close', 'save');
  return units;
}
function checkpoint() {
  try { localStorage.setItem('station.session', JSON.stringify(S.session)); } catch (e) { }
}
function clearCheckpoint() { try { localStorage.removeItem('station.session'); } catch (e) { } }

async function ack(res) { await say(res.speech ? 'T_ack' : 'T_no_answer'); }

async function runUnit(u) {
  const T = S.master.timing, A = T.answer_seconds;
  const ses = S.session;
  let m;
  if (u === 'welcome') {
    setSegment('Welcome'); setScene(null);
    await say('W1_greeting'); await say('W2_explainer');
  } else if (u === 'consent') {
    setSegment('Welcome');
    let agreed = false;
    for (let attempt = 0; attempt < 2 && !agreed; attempt++) {
      await say('W3_consent', { question: true, keep: true });
      const res = await listen({ qid: 'W3_consent', windowSec: 12, grace: 0, silence: 2, silencePrompt: false, noFinish: true });
      saveAnswer({ qid: 'W3_consent', kind: 'consent', situation: '' }, res);
      if (res.speech) {
        $('thinking').hidden = false;
        try {
          const wav = toWav(res.samples);
          const r = await api('POST', { action: 'transcribe', audio: await blobToB64(wav), mime: 'audio/wav' }, 7000);
          const t = (r.transcript || '').toLowerCase();
          agreed = /\bagree\b/.test(t) && !/\b(don'?t|do not|not|disagree)\b/.test(t);
        } catch (e) { agreed = false; }
        $('thinking').hidden = true;
      }
      if (!agreed) {
        const v = await waitForProctor('Consent was not confirmed automatically. Did the applicant say "I agree"?',
          [{ label: 'Yes, consent given', value: 'yes', cls: 'primary' }, { label: 'Ask again', value: 'again' }, { label: 'Stop session', value: 'stop', cls: 'danger' }]);
        if (v === 'yes') { agreed = true; logEvent('consent_confirmed_by_proctor', ''); }
        else if (v === 'stop') throw new Error('stopped');
      }
    }
    if (!agreed) throw new Error('stopped');
    await say('W3b_consent_thanks');
  } else if (u === 'soundcheck') {
    setSegment('Welcome'); setScene(null);
    for (let attempt = 0; ; attempt++) {
      await say(attempt === 0 ? 'W4_soundcheck' : 'W4c_sound_retry', { question: true, keep: true });
      const before = S.audio.level;
      const res = await listen({ qid: 'W4_soundcheck', windowSec: 8, grace: 0, silence: 1.5, silencePrompt: false, noFinish: true });
      if (attempt === 0) S.audio.noise = Math.min(Math.max(before, 0.002), 0.01);
      if (res.speech && res.peak > 0.02) {
        saveAnswer({ qid: 'W4_soundcheck', kind: 'soundcheck', situation: '' }, res);
        try { const url = URL.createObjectURL(toWav(res.samples)); setSubtitle(''); await playUrlOnce(url); URL.revokeObjectURL(url); } catch (e) { }
        await say('W4b_sound_ok');
        break;
      }
      logEvent('sound_retry', String(res.peak.toFixed(4)));
      if (attempt >= 1) {
        const v = await waitForProctor('The microphone did not pick up the applicant clearly. Check that the headset is plugged in and the microphone is near the mouth.',
          [{ label: 'Try again', value: 'again', cls: 'primary' }, { label: 'Continue anyway', value: 'go' }, { label: 'Stop session', value: 'stop', cls: 'danger' }]);
        if (v === 'go') { await say('W4b_sound_ok'); break; }
        if (v === 'stop') throw new Error('stopped');
      }
    }
  } else if (u === 'practice') {
    await say('W5_practice', { question: true, keep: true });
    const res = await listen({ qid: 'W5_practice', windowSec: T.practice_seconds, againId: 'W5_practice', questionText: lineText('W5_practice') });
    saveAnswer({ qid: 'W5_practice', kind: 'practice', situation: '' }, res);
    await say('W6_practice_done');
  } else if (u === 'frame') {
    setSegment('Situation 1 of 4');
    await say('F1_frame');
  } else if ((m = /^S(\d)_(open|fu|esc|ref)$/.exec(u))) {
    const n = Number(m[1]), part = m[2], sit = situation(n);
    setSegment(sit.screen_label); setScene(sit.scene);
    if (part === 'open') {
      if (n > 1) await say('T_next_' + n);
      const qid = `S${n}_OPEN`;
      await say(qid, { question: true, keep: true });
      const res = await listen({ qid, windowSec: A.opening, chunked: true, againId: qid, questionText: sit.opening });
      const ackP = ack(res);
      $('thinking').hidden = false;
      const route = await chooseFollowup(n, res);
      await ackP;
      $('thinking').hidden = true;
      ses.route[n] = route.choice;
      saveAnswer({ qid, kind: 'opening', situation: n, routeChoice: route.choice, routeBasis: route.basis, routeModel: route.model, liveTranscript: route.live }, res);
    } else if (part === 'fu') {
      const choice = ses.route[n] || 'DEFAULT';
      const qid = choice === 'DEFAULT' ? `S${n}_DEF` : `S${n}_${choice}`;
      await say(qid, { question: true, keep: true });
      const res = await listen({ qid, windowSec: A.followup, againId: qid, questionText: lineText(qid) });
      saveAnswer({ qid, kind: 'followup', situation: n, followupId: choice === 'DEFAULT' ? 'DEF' : choice }, res);
      await ack(res);
    } else if (part === 'esc') {
      const qid = `S${n}_ESC`;
      await say(qid, { question: true, keep: true });
      const res = await listen({ qid, windowSec: A.escalation, againId: qid, questionText: sit.escalation });
      saveAnswer({ qid, kind: 'escalation', situation: n }, res);
      await ack(res);
    } else {
      const qid = `S${n}_REF`;
      await say(qid, { question: true, keep: true });
      const res = await listen({ qid, windowSec: A.reflection, againId: qid, questionText: sit.reflection });
      saveAnswer({ qid, kind: 'reflection', situation: n }, res);
    }
  } else if (u === 'ratings') {
    setSegment('Looking back'); setScene(null);
    await say('L1_intro');
    for (let k = 1; k <= 4; k++) {
      const qid = 'L_s' + k;
      await say(qid, { question: true, keep: true });
      const res = await listen({ qid, windowSec: T.rating_seconds, grace: 3, silence: 2.5, silencePrompt: false, againId: qid, questionText: lineText(qid) });
      saveAnswer({ qid, kind: 'rating', situation: k }, res);
    }
  } else if (u === 'redo') {
    await say('L2_redo', { question: true, keep: true });
    const res = await listen({ qid: 'L2_redo', windowSec: T.redo_seconds, againId: 'L2_redo', questionText: lineText('L2_redo') });
    saveAnswer({ qid: 'L2_redo', kind: 'redo', situation: '' }, res);
  } else if (u === 'close') {
    setSegment('Closing');
    await say('C1_close_question', { question: true, keep: true });
    const res = await listen({ qid: 'C1_close', windowSec: T.close_seconds, silence: 4, againId: 'C1_close_question', questionText: lineText('C1_close_question') });
    saveAnswer({ qid: 'C1_close', kind: 'close', situation: '' }, res);
  } else if (u === 'save') {
    await say('E0_saving', { keep: true });
    $('thinking').hidden = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 30000) { pumpQueue(); if ((await pendingCount()) === 0) break; await sleep(1500); }
    $('thinking').hidden = true;
    await logEvent('session_complete', '');
    await say('E1_closing', { keep: true });
  }
}

async function runSession() {
  const units = buildUnits();
  show('scr-stage');
  try {
    if (S.session.soundFirst) { await runUnit('soundcheck'); S.session.soundFirst = false; checkpoint(); }
    while (S.session.unit < units.length) {
      const u = units[S.session.unit];
      await waitIfPaused();
      if (S.session.stopped) throw new Error('stopped');
      await runUnit(u);
      S.session.unit++; checkpoint();
    }
    clearCheckpoint();
    $('done-text').textContent = lineText('E1_closing');
    show('scr-done'); updateUploadStatus();
  } catch (e) {
    stopPlayback();
    if (e.message !== 'stopped') { logEvent('session_error', e.message); console.error(e); }
    else logEvent('session_stopped', 'unit ' + units[S.session.unit]);
    checkpoint();
    await openList();
  }
}

async function startSession(applicant, resume) {
  await initMic();
  if (resume) {
    S.session = resume; S.session.stopped = false;
    logEvent('session_resumed', 'unit ' + S.session.unit);
  } else {
    S.session = { sessionId: uid(), code: applicant.code, name: applicant.name || '', date: applicant.date || workDate(), unit: 0, route: {}, startedAt: new Date().toISOString(), stopped: false };
    if (applicant.status === 'started' && applicant.continueFromRelay) {
      try {
        const pr = await api('GET', { action: 'progress', code: applicant.code }, 20000);
        const done = new Set((pr.rows || []).map((r) => r.qid));
        (pr.rows || []).forEach((r) => { if (r.kind === 'opening' && r.routeChoice) S.session.route[Number(r.situation)] = r.routeChoice; });
        const units = buildUnits();
        const finished = (u) => {
          let m;
          if (u === 'welcome' || u === 'frame') return done.has('W3_consent');
          if (u === 'consent') return done.has('W3_consent');
          if (u === 'soundcheck') return false;               // always re-check sound on a new computer
          if (u === 'practice') return done.has('W5_practice');
          if ((m = /^S(\d)_(open|fu|esc|ref)$/.exec(u))) {
            const n = m[1];
            if (m[2] === 'open') return done.has(`S${n}_OPEN`);
            if (m[2] === 'fu') return ['F1', 'F2', 'F3', 'F4', 'DEF'].some((f) => done.has(`S${n}_${f}`));
            if (m[2] === 'esc') return done.has(`S${n}_ESC`);
            return done.has(`S${n}_REF`);
          }
          if (u === 'ratings') return done.has('L_s4');
          if (u === 'redo') return done.has('L2_redo');
          if (u === 'close') return done.has('C1_close');
          return false;
        };
        let first = units.findIndex((u) => u !== 'soundcheck' && !finished(u));
        if (first < 0) first = units.length - 1;
        if (first > units.indexOf('practice')) { S.session.unit = first; S.session.soundFirst = true; }
        logEvent('session_continued_on_this_computer', 'from ' + units[first]);
      } catch (e) { logEvent('progress_unavailable', e.message); }
    }
    checkpoint();
  }
  show('scr-ready');
}

/* ------------------------------------------------------------------ */
/* Staff screens                                                       */
/* ------------------------------------------------------------------ */
function li(text, cls) { const el = document.createElement('li'); el.textContent = text; el.className = cls; $('prep-list').appendChild(el); return el; }

async function prepare() {
  S.cfg.relay = $('cfg-relay').value.trim();
  S.cfg.token = $('cfg-token').value.trim();
  S.cfg.station = $('cfg-station').value;
  S.cfg.pin = $('cfg-pin').value.trim() || S.cfg.pin || '';
  S.cfg.date = $('cfg-date').value;
  saveCfg();
  $('prep-list').innerHTML = '';
  if (!S.cfg.pin) { li('Set a proctor PIN.', 'bad'); return; }
  let el = li('Contacting the relay…', 'wait');
  try {
    const p = await api('GET', { action: 'ping' }, 20000);
    el.textContent = `Relay connected (version ${p.version}).`; el.className = 'ok';
    li(p.keys.claude ? 'Claude key present.' : 'Claude key missing in the relay.', p.keys.claude ? 'ok' : 'bad');
    li(p.keys.gemini ? 'Gemini key present.' : 'Gemini key missing in the relay.', p.keys.gemini ? 'ok' : 'bad');
    li(`Voice lines recorded in the relay: ${p.voice.ready} of ${p.voice.total}.`, p.voice.ready === p.voice.total ? 'ok' : 'bad');
  } catch (e) { el.textContent = 'Relay not reachable: ' + e.message; el.className = 'bad'; return; }
  el = li('Loading the approved script…', 'wait');
  try { await fetchMaster(); el.textContent = `Approved script loaded (version ${S.master.version}).`; el.className = 'ok'; }
  catch (e) { el.textContent = 'Script not loaded: ' + e.message; el.className = 'bad'; return; }
  el = li('Downloading the voice lines to this computer…', 'wait');
  $('prep-progress').hidden = false;
  try {
    const r = await downloadVoice((d, t) => { $('prep-progress').firstElementChild.style.width = Math.round(100 * d / Math.max(1, t)) + '%'; });
    el.textContent = r.missing.length ? `Voice lines missing: ${r.missing.join(', ')}` : `All ${r.total} voice lines saved on this computer.`;
    el.className = r.missing.length ? 'bad' : 'ok';
    if (r.unverified.length) li(`Lines not yet verified against the script: ${r.unverified.join(', ')}`, 'bad');
  } catch (e) { el.textContent = 'Voice download failed: ' + e.message; el.className = 'bad'; }
  el = li('Checking the microphone…', 'wait');
  try { await initMic(); await sleep(800); el.textContent = 'Microphone ready.'; el.className = 'ok'; }
  catch (e) { el.textContent = 'Microphone not available: ' + e.message; el.className = 'bad'; }
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) { }
  li('Setup saved. Press "Back to applicant list".', 'ok');
}

async function openList() {
  if (!S.master) { show('scr-setup'); return; }
  show('scr-list');
  $('list-title').textContent = 'Station ' + (S.cfg.station || '?');
  $('list-sub').textContent = 'Interview date ' + workDate() + ' · version ' + APP_VERSION;
  const h = $('health'); h.innerHTML = '';
  const pill = (t, c) => { const s = document.createElement('span'); s.className = 'pill ' + (c || ''); s.textContent = t; h.appendChild(s); };
  const vcount = Object.keys(S.voiceUrls).length, vtotal = S.master.voice_lines.length;
  pill(`Voice ${vcount}/${vtotal}`, vcount === vtotal ? '' : 'bad');
  pill(S.audio.ctx ? 'Microphone ready' : 'Microphone not checked yet', S.audio.ctx ? '' : 'warn');
  try { const n = await pendingCount(); pill(n ? `${n} recording(s) waiting to upload` : 'All recordings uploaded', n ? 'warn' : ''); } catch (e) { }
  let saved = null; try { saved = JSON.parse(localStorage.getItem('station.session') || 'null'); } catch (e) { }
  const rb = $('resume-box');
  if (saved && saved.unit < buildUnits().length) {
    rb.hidden = false;
    rb.innerHTML = '';
    const p = document.createElement('p'); p.textContent = `An unfinished session is saved for ${saved.name || saved.code} (${saved.code}). Resume it from the question that was in progress, or discard it.`;
    const b1 = document.createElement('button'); b1.className = 'btn primary'; b1.textContent = 'Resume';
    const b2 = document.createElement('button'); b2.className = 'btn ghost'; b2.textContent = 'Discard';
    b1.onclick = () => askPin(`Resume ${saved.name || saved.code}`, saved.code, () => startSession(null, saved));
    b2.onclick = () => askPin('Discard the unfinished session', saved.code, () => { clearCheckpoint(); openList(); });
    const row = document.createElement('div'); row.className = 'row gap'; row.append(b1, b2);
    rb.append(p, row);
  } else rb.hidden = true;
  const body = $('list-body'); body.innerHTML = '<tr><td colspan="5" class="muted">Loading…</td></tr>';
  try {
    const r = await api('GET', { action: 'schedule', station: S.cfg.station, date: workDate() }, 20000);
    try { localStorage.setItem('station.schedule.' + workDate(), JSON.stringify(r.applicants)); } catch (e) { }
    renderList(r.applicants);
  } catch (e) {
    let cached = null; try { cached = JSON.parse(localStorage.getItem('station.schedule.' + workDate()) || 'null'); } catch (x) { }
    if (cached) { renderList(cached); pill('Offline: showing the saved list', 'warn'); }
    else body.innerHTML = `<tr><td colspan="5">Could not load the list: ${e.message}</td></tr>`;
  }
}
function renderList(list) {
  const body = $('list-body'); body.innerHTML = '';
  if (!list.length) { body.innerHTML = '<tr><td colspan="5" class="muted">No applicants scheduled for this station on this date.</td></tr>'; return; }
  list.sort((a, b) => Number(a.round) - Number(b.round)).forEach((a) => {
    const tr = document.createElement('tr');
    const st = a.status === 'done' ? '<span class="status-done">Complete</span>' : a.status === 'started' ? '<span class="status-started">Started</span>' : 'Waiting';
    tr.innerHTML = `<td>${a.round}</td><td>${a.time}</td><td class="name"></td><td>${st}</td><td></td>`;
    tr.children[2].textContent = a.name;
    const b = document.createElement('button'); b.className = 'btn primary';
    b.textContent = a.status === 'done' ? 'Run again' : a.status === 'started' ? 'Continue' : 'Start';
    b.onclick = () => askPin(`${b.textContent}: ${a.name}`, a.code, () => startSession(Object.assign({}, a, { continueFromRelay: a.status === 'started' }), null));
    tr.children[4].appendChild(b);
    body.appendChild(tr);
  });
}
function askPin(title, sub, onOk) {
  $('start-title').textContent = title; $('start-sub').textContent = 'Code ' + sub; $('start-pin').value = '';
  $('ov-start').hidden = false; $('start-pin').focus();
  $('start-ok').onclick = () => {
    if ($('start-pin').value !== S.cfg.pin) { $('start-sub').textContent = 'Incorrect PIN.'; return; }
    $('ov-start').hidden = true; onOk();
  };
  $('start-cancel').onclick = () => { $('ov-start').hidden = true; };
}

/* ------------------------------------------------------------------ */
/* Proctor overlay                                                     */
/* ------------------------------------------------------------------ */
function openProctor() {
  $('ov-proctor').hidden = false; $('pin-box').hidden = false; $('ctl-box').hidden = true; $('pin-in').value = ''; $('pin-in').focus();
}
async function refreshCtl() {
  const n = await pendingCount().catch(() => '?');
  $('ctl-status').textContent = (S.session ? `${S.session.name || ''} ${S.session.code} · step ${S.session.unit + 1}` : 'No session') + ` · uploads waiting: ${n}` + (S.paused ? ' · PAUSED' : '');
}
function bindLongPress(el, fn) {
  let t = null;
  el.addEventListener('pointerdown', () => { t = setTimeout(fn, 1500); });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => el.addEventListener(ev, () => clearTimeout(t)));
}

/* ------------------------------------------------------------------ */
/* Start-up                                                            */
/* ------------------------------------------------------------------ */
async function fetchMaster() {
  // The script comes from the relay (token protected), so the public site never contains the questions.
  const r = await api('GET', { action: 'config' }, 20000);
  if (!r.master || !r.master.voice_lines) throw new Error('No script returned by the relay.');
  S.master = r.master;
  try { localStorage.setItem('station.master', JSON.stringify(S.master)); } catch (e) { }
}
async function boot() {
  loadCfg();
  try { S.master = JSON.parse(localStorage.getItem('station.master') || 'null'); } catch (e) { S.master = null; }
  if (S.cfg.relay && S.cfg.token) { try { await fetchMaster(); } catch (e) { } }
  S.db = await openDb();
  if (S.master) await loadVoiceFromDb();
  if ('serviceWorker' in navigator) { try { await navigator.serviceWorker.register('sw.js'); } catch (e) { } }

  $('cfg-relay').value = S.cfg.relay || ''; $('cfg-token').value = S.cfg.token || '';
  $('cfg-station').value = S.cfg.station || '1'; $('cfg-date').value = S.cfg.date || '';
  $('btn-prepare').onclick = prepare;
  $('btn-setup-back').onclick = openList;
  $('btn-settings').onclick = () => askPin('Open setup', 'station ' + (S.cfg.station || ''), () => { $('cfg-pin').value = ''; show('scr-setup'); });
  $('btn-refresh').onclick = openList;
  $('btn-rehearsal').onclick = () => askPin('Start a rehearsal session', 'R', () => {
    const d = new Date(); const p = (n) => String(n).padStart(2, '0');
    startSession({ code: `R-${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}-S${S.cfg.station}`, name: 'Rehearsal', date: 'rehearsal' }, null);
  });
  $('btn-begin').onclick = async () => {
    try { await initMic(); } catch (e) { }
    if (S.session.unit === 0) logEvent('session_start', S.session.code);
    runSession();
  };
  $('btn-finish').onclick = () => { S.finishPressed = true; };
  $('btn-again').onclick = () => { if (!S.hearAgain) S.hearAgain = 'request'; };

  ['corner', 'corner2'].forEach((id) => bindLongPress($(id), openProctor));
  document.addEventListener('keydown', (e) => { if (e.ctrlKey && e.shiftKey && (e.key === 'P' || e.key === 'p')) openProctor(); });
  $('ov-close').onclick = () => { $('ov-proctor').hidden = true; };
  $('pin-ok').onclick = () => { if ($('pin-in').value === S.cfg.pin) { $('pin-box').hidden = true; $('ctl-box').hidden = false; refreshCtl(); } };
  $('ctl-pause').onclick = async () => { if (!S.paused && S.session) { setPaused(true); stopPlayback(); logEvent('pause', ''); setSubtitle(lineText('P_pause')); if (S.voiceUrls.P_pause) playUrlOnce(S.voiceUrls.P_pause).catch(() => { }); } refreshCtl(); };
  $('ctl-resume').onclick = async () => { if (S.paused) { $('ov-proctor').hidden = true; logEvent('resume', ''); try { await playUrlOnce(S.voiceUrls.P_resume); } catch (e) { } setPaused(false); } refreshCtl(); };
  $('ctl-consent').onclick = () => { if (!$('ov-wait').hidden) { const b = $('wait-buttons').querySelector('button'); if (b) b.dispatchEvent(new PointerEvent('pointerdown')); } $('ov-proctor').hidden = true; };
  $('ctl-skip').onclick = () => { S.skip = true; $('ov-proctor').hidden = true; };
  $('ctl-end').onclick = () => { if (S.session) { S.session.stopped = true; S.skip = true; setPaused(false); stopPlayback(); } $('ov-proctor').hidden = true; };
  $('ctl-list').onclick = () => { $('ov-proctor').hidden = true; if (!S.session || S.session.stopped || !$('scr-done').hidden || !$('scr-ready').hidden) { S.session = null; openList(); } };

  if (!S.cfg.relay || !S.cfg.token || !S.cfg.pin || !S.master) show('scr-setup');
  else openList();
  pumpQueue();
}
window.addEventListener('beforeunload', (e) => { if (S.session && !S.session.stopped && $('scr-stage') && !$('scr-stage').hidden) { e.preventDefault(); e.returnValue = ''; } });
boot();
