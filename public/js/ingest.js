// "Add" tab: drop files → read MixPre metadata → transcribe the slate → suggest metadata
// → you review → process a clean clip in the browser → upload original + clip + sidecar.
import { parseWav, encodeWav } from './wav.js';
import * as dsp from './dsp.js';
import { api, uploadBlob } from './api.js';
import { parseSlate, stripLocation, heuristicMeta, guessType, recordedDate } from './slate.js';
import { findLocationInText, decodeWords } from './geowords.js';
import { $, h, fmtDur, fmtDb, fmtSize, fmtRate, slug, shortId, sha256Hex, drawWave, toast, TYPES } from './util.js';

const jobs = [];
let analyzeChain = Promise.resolve();
let uploadChain = Promise.resolve();
const PREFS_KEY = 'sl.ingest.prefs';
const prefs = Object.assign({ highpass: 40, normalize: 'peak', fadeIn: 5, fadeOut: 20, format: '24', trim: false }, safeJson(localStorage.getItem(PREFS_KEY)));

// MixPre fills the bext description with machine fields (sSPEED=…, sTAKE=…); keep only human text.
function humanBext(desc) {
  const lines = String(desc || '').split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
  const note = lines.find((l) => /^sNOTE=/i.test(l));
  if (note) return note.replace(/^sNOTE=/i, '').trim();
  return lines.filter((l) => !/^[a-z]{0,2}[A-Z0-9_]+=/.test(l)).join(' ');
}

function safeJson(s) { try { return JSON.parse(s) || {}; } catch { return {}; } }
function savePrefs(o) { Object.assign(prefs, o); try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* private mode */ } }

export function initIngest() {
  const drop = $('#drop');
  const input = $('#file-input');
  drop.addEventListener('click', () => input.click());
  input.addEventListener('change', () => { addFiles([...input.files]); input.value = ''; });
  for (const ev of ['dragenter', 'dragover']) document.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
  for (const ev of ['dragleave', 'drop']) document.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'drop' || !e.relatedTarget) drop.classList.remove('over'); });
  document.addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer?.files || [])].filter((f) => /^audio\/|\.(wav|bwf|aif|aiff|flac|mp3|m4a|ogg|caf)$/i.test(f.type || f.name));
    if (files.length) { document.querySelector('[data-tab="add"]').click(); addFiles(files); }
  });
  $('#batch-apply').addEventListener('click', applyBatch);
  $('#upload-all').addEventListener('click', () => jobs.filter((j) => j.status === 'ready').forEach(queueUpload));
  window.addEventListener('beforeunload', (e) => { if (jobs.some((j) => j.status === 'uploading' || j.status === 'processing')) { e.preventDefault(); e.returnValue = ''; } });
  window.addEventListener('resize', () => jobs.forEach(drawJobWave));
}

function addFiles(files) {
  for (const file of files) {
    const job = { id: shortId(), file, status: 'queued', form: {}, dirty: new Set(), options: {}, el: null };
    jobs.push(job);
    renderJob(job);
    analyzeChain = analyzeChain.then(() => analyze(job)).catch((e) => fail(job, e));
  }
  updateCounts();
}

// ---------------------------------------------------------------- analysis
async function analyze(job) {
  if (job.removed) return;
  setStatus(job, 'reading', 'Reading file…');
  const buf = await job.file.arrayBuffer();
  job.sha256 = await sha256Hex(buf);
  api.get(`/api/items/exists?sha256=${job.sha256}`).then((r) => {
    if (r.exists) { job.duplicate = r.item; renderJob(job); }
  }).catch(() => {});

  let w = parseWav(buf);
  if (!w) w = await decodeOther(buf);
  job.audio = w;
  const peak = dsp.peakDb(w.data);
  job.analysis = {
    peak, lufs: dsp.integratedLoudness(w.data, w.sampleRate), floor: dsp.noiseFloorDb(w.data, w.sampleRate),
  };
  job.peaks = dsp.waveformPeaks(w.data, 600);
  job.form.recorded_at = recordedDate(w.bext, job.file.lastModified);
  const ix = w.ixml || {};
  job.options = {
    cutSlate: false, slateEnd: 0, trim: prefs.trim, highpass: prefs.highpass, normalize: prefs.normalize,
    fadeIn: prefs.fadeIn, fadeOut: prefs.fadeOut, format: prefs.format, channels: 'all',
  };
  job.form.title = (ix.scene || job.file.name.replace(/\.[^.]+$/, '')).toLowerCase().replace(/[_]+/g, ' ');
  job.form.notes = [ix.note, humanBext(w.bext?.description)].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(' — ');
  job.form.type = guessType({ filename: job.file.name });
  setStatus(job, 'listening', 'Listening for a slate…');
  renderJob(job);

  // Transcribe the first 30 s for a spoken slate.
  try {
    const headDur = Math.min(w.duration, 30);
    const head = await to16kMono(w.data, w.sampleRate, 0, headDur);
    const tr = await api.transcribe(encodeWav([head], 16000, { bitDepth: 16 }));
    if (tr.error) job.aiNote = tr.error;
    const slate = parseSlate(tr.segments || [], headDur);
    const headWords = (tr.text || '').split(/\s+/).filter(Boolean).length;
    job.slate = slate;
    job.headTranscript = tr;
    const type = guessType({ filename: job.file.name, slate, headWords });
    if (!job.dirty.has('type')) job.form.type = type;
    if (slate && slate.looksLikeSlate) {
      job.options.cutSlate = true;
      job.options.slateEnd = slate.end;
      const loc = slate.location;
      if (loc) await applyLocation(job, loc);
      const hm = heuristicMeta(slate.text);
      fill(job, { title: hm.title, tags: (hm.tags || []).join(', '), description: hm.description });
      setStatus(job, 'describing', 'Describing…');
      renderJob(job);
      const d = await api.post('/api/describe', { slate: stripLocation(slate.text), filename: job.file.name, notes: job.form.notes, type: job.form.type }).catch(() => ({}));
      if (d.result) {
        const r = d.result;
        fill(job, {
          title: r.title, tags: (r.tags || []).join(', '), description: r.description,
          people: (r.people || []).join(', '),
        });
        if (r.location && !job.form.location) fill(job, { location: r.location });
        if (r.gear) fill(job, { notes: [job.form.notes, r.gear].filter(Boolean).join(' — ') });
      }
    }
    if (job.form.type === 'voice') {
      job.form.release_status = job.form.release_status || 'none';
      transcribeFull(job); // runs in the background; upload waits for it
    }
  } catch (e) {
    job.aiNote = `Slate step skipped: ${e.message}`;
  }
  setStatus(job, 'ready', 'Ready — review and upload');
  renderJob(job);
}

async function applyLocation(job, loc) {
  job.form.lat = loc.lat;
  job.form.lon = loc.lon;
  job.form.location_words = loc.words.join(' ');
  job.locationCorrected = loc.corrected;
  try {
    const near = await api.get(`/api/near?lat=${loc.lat}&lon=${loc.lon}`);
    job.nearPlaces = near;
    if (near.length && near[0].meters < 1500) fill(job, { location: near[0].location });
  } catch { /* offline catalog lookups are optional */ }
}

function fill(job, values) {
  for (const [k, v] of Object.entries(values)) if (v && !job.dirty.has(k)) job.form[k] = v;
}

async function decodeOther(buf) {
  const ctx = new OfflineAudioContext(1, 1, 48000);
  const ab = await ctx.decodeAudioData(buf.slice(0));
  const data = Array.from({ length: ab.numberOfChannels }, (_, c) => ab.getChannelData(c).slice());
  return { sampleRate: ab.sampleRate, channels: ab.numberOfChannels, bitDepth: 0, isFloat: true, frames: ab.length, duration: ab.duration, data, bext: {}, ixml: {}, info: {}, compressed: true };
}

async function to16kMono(channels, sr, startSec, endSec) {
  const a = Math.floor(startSec * sr), b = Math.min(channels[0].length, Math.floor(endSec * sr));
  const m = dsp.mono(channels.map((c) => c.subarray(a, b)));
  const outLen = Math.max(1, Math.ceil((m.length * 16000) / sr));
  const ctx = new OfflineAudioContext(1, outLen, 16000);
  const src = ctx.createBufferSource();
  const ab = ctx.createBuffer(1, m.length, sr);
  ab.copyToChannel(m, 0);
  src.buffer = ab;
  src.connect(ctx.destination);
  src.start();
  return (await ctx.startRendering()).getChannelData(0);
}

/** Whole-file transcript for voice recordings, in 28 s chunks. */
function transcribeFull(job) {
  if (job.fullTranscript) return job.fullTranscript;
  job.fullTranscript = (async () => {
    const w = job.audio;
    const segs = [];
    const step = 28;
    for (let t = 0; t < w.duration; t += step) {
      job.transcribing = `Transcribing ${fmtDur(t)} / ${fmtDur(w.duration)}`;
      renderStatusLine(job);
      const chunk = await to16kMono(w.data, w.sampleRate, t, Math.min(w.duration, t + step));
      const r = await api.transcribe(encodeWav([chunk], 16000, { bitDepth: 16 }));
      for (const s of r.segments || []) segs.push({ start: +(s.start + t).toFixed(2), end: +(s.end + t).toFixed(2), text: s.text });
    }
    job.transcribing = '';
    job.transcript = segs;
    renderStatusLine(job);
    return segs;
  })().catch((e) => { job.transcribing = `Transcript failed: ${e.message}`; renderStatusLine(job); return []; });
  return job.fullTranscript;
}

// ---------------------------------------------------------------- processing + upload
function queueUpload(job) {
  if (job.status !== 'ready') return;
  if (!job.form.title?.trim()) { toast('Give it a title first', 'err'); return; }
  setStatus(job, 'waiting', 'Waiting to upload…');
  renderJob(job);
  uploadChain = uploadChain.then(() => processAndUpload(job)).catch((e) => fail(job, e));
}

function buildClip(job) {
  const w = job.audio;
  const o = job.options;
  const sr = w.sampleRate;
  // Channel selection
  let chans;
  if (o.channels === 'mono') chans = [dsp.mono(w.data)];
  else if (o.channels.startsWith('t')) chans = [w.data[Number(o.channels.slice(1))]];
  else chans = w.data;
  const startFrame = o.cutSlate ? Math.round(o.slateEnd * sr) : 0;
  chans = dsp.cut(chans, startFrame, chans[0].length); // copies — originals untouched
  if (o.trim) {
    const b = dsp.findSoundBounds(chans, sr);
    chans = dsp.cut(chans, b.start, b.end);
  }
  if (o.highpass) dsp.highpass(chans, sr, Number(o.highpass));
  if (o.normalize === 'peak') dsp.normalizePeak(chans, -1);
  else if (o.normalize === 'loudness') dsp.normalizeLoudness(chans, sr, -18, -1);
  else if (dsp.peakDb(chans) > 0 && o.format !== 'float') dsp.normalizePeak(chans, -0.1); // never clip a 24-bit file
  dsp.fade(chans, sr, Number(o.fadeIn) || 0, Number(o.fadeOut) || 0);
  return { chans, startFrame };
}

async function processAndUpload(job) {
  if (job.removed) return;
  const f = job.form, w = job.audio, o = job.options;
  setStatus(job, 'processing', 'Processing…');
  renderJob(job);
  await new Promise((r) => setTimeout(r, 30)); // let the UI paint

  if (f.type === 'voice') await transcribeFull(job);
  const { chans, startFrame } = buildClip(job);
  const sr = w.sampleRate;
  const lufs = dsp.integratedLoudness(chans, sr);
  const peak = dsp.peakDb(chans);
  const date = (f.recorded_at || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
  const filename = `${date}_${slug(f.title)}_${job.id.slice(0, 4)}.wav`;
  const tags = String(f.tags || '');
  const clipBuf = encodeWav(chans, sr, {
    float: o.format === 'float', bitDepth: 24,
    bext: {
      description: [f.title, f.description].filter(Boolean).join(' - ').slice(0, 255),
      originator: 'Sound Library', originatorReference: job.id,
      originationDate: date, originationTime: (f.recorded_at || '').slice(11, 19),
      timeReference: (w.bext?.timeReference || 0) + startFrame, loudness: lufs, truePeak: peak,
    },
    info: { INAM: f.title, ICMT: f.description, IKEY: tags, ICRD: date, IART: f.people },
  });
  const clipBlob = new Blob([clipBuf], { type: 'audio/wav' });
  const peaks = dsp.waveformPeaks(chans, 600);

  // Transcript times are relative to the original; shift them to the clip.
  const offset = startFrame / sr;
  const transcript = (job.transcript || []).map((s) => ({ ...s, start: +(s.start - offset).toFixed(2), end: +(s.end - offset).toFixed(2) })).filter((s) => s.end > 0);

  const ext = (job.file.name.match(/\.[^.]+$/) || ['.wav'])[0].toLowerCase();
  const origName = job.file.name;
  const keys = {
    original: `originals/${date.slice(0, 4)}/${date}/${job.id}_${slug(origName.replace(/\.[^.]+$/, ''), 60)}${ext}`,
    clip: `clips/${f.type}/${filename}`,
    meta: `meta/${job.id}.json`,
  };

  setStatus(job, 'uploading', 'Uploading…');
  renderJob(job);
  const total = job.file.size + clipBlob.size;
  const prog = (base) => (b) => setProgress(job, (base + b) / total);
  await uploadBlob(keys.original, job.file, job.file.type || 'audio/wav', prog(0));
  await uploadBlob(keys.clip, clipBlob, 'audio/wav', prog(job.file.size));

  const ix = w.ixml || {};
  const item = {
    id: job.id, recorded_at: f.recorded_at, title: f.title.trim(), type: f.type, tags, description: f.description || '',
    location: f.location || '', lat: f.lat ?? null, lon: f.lon ?? null, location_words: f.location_words || '',
    people: f.people || '', release_status: f.type === 'voice' ? (f.release_status || 'none') : (f.release_status || ''),
    notes: f.notes || '', slate: job.slate?.text || '', transcript: transcript.map((s) => s.text).join(' '),
    transcript_json: transcript, filename, clip_key: keys.clip, original_key: keys.original, original_name: origName,
    sha256: job.sha256, sample_rate: sr, channels: chans.length, bit_depth: o.format === 'float' ? 32 : 24,
    duration: chans[0].length / sr, original_duration: w.duration, peak_db: round(peak), lufs: round(lufs),
    noise_floor_db: round(job.analysis.floor), processing: { ...o, slateCutSec: offset },
    source_meta: { bext: w.bext, ixml: ix, info: w.info, sampleRate: sr, bitDepth: w.bitDepth, float: w.isFloat, channels: w.channels, trackNames: ix.tracks || [] },
    peaks, clip_size: clipBlob.size, original_size: job.file.size,
  };
  await uploadBlob(keys.meta, new Blob([JSON.stringify({ ...item, peaks: undefined }, null, 2)], { type: 'application/json' }), 'application/json');
  await api.post('/api/items', item);

  job.audio = null; // free memory
  job.result = item;
  setStatus(job, 'done', 'In the library');
  renderJob(job);
  updateCounts();
  document.dispatchEvent(new CustomEvent('library:changed'));
}

const round = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);

function fail(job, e) {
  console.error(e);
  job.error = e.message || String(e);
  setStatus(job, job.audio ? 'ready' : 'error', job.audio ? `Failed: ${job.error} — fix and retry` : `Couldn't read: ${job.error}`);
  renderJob(job);
}

// ---------------------------------------------------------------- batch
function applyBatch() {
  const loc = $('#batch-location').value.trim();
  const tags = $('#batch-tags').value.trim();
  const people = $('#batch-people').value.trim();
  const date = $('#batch-date').value;
  let n = 0;
  for (const j of jobs) {
    if (!['ready', 'listening', 'describing', 'reading', 'queued'].includes(j.status)) continue;
    if (loc) { j.form.location = loc; j.dirty.add('location'); }
    if (tags) { j.form.tags = [j.form.tags, tags].filter(Boolean).join(', '); j.dirty.add('tags'); }
    if (people) { j.form.people = people; j.dirty.add('people'); }
    if (date) { j.form.recorded_at = date + (j.form.recorded_at || '').slice(10); j.dirty.add('recorded_at'); }
    renderJob(j); n++;
  }
  toast(`Applied to ${n} file${n === 1 ? '' : 's'}`);
}

// ---------------------------------------------------------------- rendering
function setStatus(job, status, text) { job.status = status; job.statusText = text; }
function setProgress(job, frac) {
  const bar = job.el && job.el.querySelector('.progress > i');
  if (bar) bar.style.width = `${Math.round(frac * 100)}%`;
}
function renderStatusLine(job) {
  const el = job.el && job.el.querySelector('.transcribing');
  if (el) el.textContent = job.transcribing || '';
}
function updateCounts() {
  const ready = jobs.filter((j) => j.status === 'ready').length;
  $('#upload-all').disabled = !ready;
  $('#upload-all').textContent = ready ? `Upload all ready (${ready})` : 'Upload all ready';
  $('#batch').hidden = !jobs.some((j) => !j.removed && j.status !== 'done');
}

function drawJobWave(job) {
  const c = job.el && job.el.querySelector('canvas');
  if (!c || !job.peaks) return;
  const d = job.audio?.duration || job.result?.original_duration || 1;
  const marks = job.options.cutSlate ? [{ from: 0, to: job.options.slateEnd / d }] : [];
  drawWave(c, job.peaks, { marks });
}

function renderJob(job) {
  // Keep the cursor where it was if this card re-renders while you're typing in it.
  const focused = job.el && job.el.contains(document.activeElement) ? document.activeElement : null;
  const focusKey = focused && focused.closest('label')?.className;
  const caret = focused && 'selectionStart' in focused ? focused.selectionStart : null;
  const el = h('article', { class: `job ${job.status}`, 'data-id': job.id });
  if (job.el) job.el.replaceWith(el); else $('#jobs').prepend(el);
  job.el = el;
  if (focusKey) queueMicrotask(() => {
    const inp = el.querySelector(`label.${focusKey.split(' ')[0]} input, label.${focusKey.split(' ')[0]} select`);
    if (inp) { inp.focus(); if (caret !== null && inp.setSelectionRange) try { inp.setSelectionRange(caret, caret); } catch { /* select */ } }
  });
  const w = job.audio;
  const editable = ['ready', 'listening', 'describing'].includes(job.status);

  el.append(h('header', {},
    h('span', { class: 'fname' }, job.file.name),
    h('span', { class: 'size' }, fmtSize(job.file.size)),
    h('span', { class: `badge ${job.status}` }, job.statusText || job.status),
    job.status !== 'uploading' && job.status !== 'processing' && h('button', { class: 'icon', title: 'Remove from this list', onclick: () => { job.removed = true; job.audio = null; el.remove(); jobs.splice(jobs.indexOf(job), 1); updateCounts(); } }, '×'),
  ));
  if (job.duplicate) el.append(h('p', { class: 'warn' }, `Already in the library as “${job.duplicate.title}”. Uploading again will fail; remove it or delete the old one first.`));

  if (job.peaks) {
    const audio = h('audio', { preload: 'none' });
    const playBtn = h('button', { class: 'play', title: 'Play original', onclick: () => {
      if (!audio.src) audio.src = URL.createObjectURL(job.file);
      if (audio.paused) audio.play(); else audio.pause();
    } }, '▶');
    audio.onplay = () => (playBtn.textContent = '❚❚');
    audio.onpause = () => (playBtn.textContent = '▶');
    const canvas = h('canvas', { class: 'wave' });
    canvas.addEventListener('click', (e) => {
      if (!audio.src) audio.src = URL.createObjectURL(job.file);
      const r = canvas.getBoundingClientRect();
      const d = w?.duration || job.result?.original_duration || 0;
      audio.currentTime = ((e.clientX - r.left) / r.width) * d;
      audio.play();
    });
    el.append(h('div', { class: 'wave-row' }, playBtn, canvas, audio));
    requestAnimationFrame(() => drawJobWave(job));
  }

  if (w) {
    const ix = w.ixml || {};
    el.append(h('p', { class: 'tech' },
      [fmtRate(w.sampleRate), w.compressed ? 'compressed' : w.isFloat ? '32-bit float' : `${w.bitDepth}-bit`, `${w.channels} ch`, fmtDur(w.duration),
        `peak ${fmtDb(job.analysis.peak)}`, `${fmtDb(job.analysis.lufs, 'LUFS')}`, `floor ${fmtDb(job.analysis.floor)}`,
        ix.project && `project ${ix.project}`, ix.scene && `scene ${ix.scene}`, ix.take && `take ${ix.take}`,
        ix.tracks && ix.tracks.some(Boolean) && `tracks: ${ix.tracks.map((t, i) => t || i + 1).join(' / ')}`,
      ].filter(Boolean).join(' · ')));
  }
  if (job.slate) {
    el.append(h('p', { class: 'slate' }, h('b', {}, job.slate.looksLikeSlate ? 'Slate: ' : 'Heard: '), `“${job.slate.text}”`));
  } else if (['ready'].includes(job.status) && !job.result) {
    el.append(h('p', { class: 'muted' }, 'No spoken slate found — fill in the details below.'));
  }
  if (job.form.location_words) {
    el.append(h('p', { class: 'loc' }, h('b', {}, 'Location words: '), job.form.location_words,
      ` → ${job.form.lat.toFixed(5)}, ${job.form.lon.toFixed(5)} `,
      h('a', { href: `https://www.openstreetmap.org/?mlat=${job.form.lat}&mlon=${job.form.lon}#map=17/${job.form.lat}/${job.form.lon}`, target: '_blank', rel: 'noopener' }, 'check map'),
      job.locationCorrected ? h('span', { class: 'warn-inline' }, ' (corrected a misheard word — worth checking)') : ''));
  }
  if (job.aiNote) el.append(h('p', { class: 'muted' }, job.aiNote));
  if (job.error) el.append(h('p', { class: 'err' }, job.error));
  el.append(h('p', { class: 'transcribing muted' }, job.transcribing || ''));

  if (job.result) {
    el.append(h('p', { class: 'done-line' }, `Saved as ${job.result.filename} (${fmtDur(job.result.duration)}).`));
    return;
  }
  if (!w) return;

  // ---- form
  const f = job.form;
  const field = (key, label, input) => {
    input.addEventListener('input', () => { f[key] = input.value; job.dirty.add(key); if (key === 'type') renderJob(job); });
    input.disabled = !editable;
    return h('label', { class: `f-${key}` }, h('span', {}, label), input);
  };
  const listId = `near-${job.id}`;
  const form = h('div', { class: 'form' },
    field('title', 'Title', h('input', { value: f.title || '', placeholder: 'freight brakes squeal' })),
    field('type', 'Type', h('select', {}, TYPES.map(([v, l]) => h('option', { value: v, selected: f.type === v }, l)))),
    field('tags', 'Tags', h('input', { value: f.tags || '', placeholder: 'metal, train, winter' })),
    field('description', 'Description', h('input', { value: f.description || '' })),
    field('location', 'Location', h('input', { value: f.location || '', list: listId, placeholder: 'Gallatin railyard' })),
    h('datalist', { id: listId }, (job.nearPlaces || []).map((p) => h('option', { value: p.location }, `${p.meters} m away`))),
    field('location_words', 'Location words', h('input', { value: f.location_words || '', placeholder: 'four words from the phone page' })),
    field('recorded_at', 'Recorded', h('input', { value: f.recorded_at || '', placeholder: 'YYYY-MM-DD' })),
    field('people', 'People', h('input', { value: f.people || '', placeholder: 'names of anyone speaking or singing' })),
    f.type === 'voice' && field('release_status', 'Release', h('select', {},
      [['none', 'No release yet'], ['verbal', 'Verbal OK (on tape)'], ['written', 'Written release'], ['n/a', 'Not needed']].map(([v, l]) => h('option', { value: v, selected: f.release_status === v }, l)))),
    field('notes', 'Notes', h('input', { value: f.notes || '' })),
  );
  // Typed location words → coordinates
  const lwInput = form.querySelector('.f-location_words input');
  lwInput.addEventListener('change', () => {
    const v = lwInput.value.trim();
    if (!v) { f.lat = f.lon = undefined; f.location_words = ''; renderJob(job); return; }
    const loc = findLocationInText(`location ${v}`) || (decodeWords(v.split(/\s+/)) && { words: v.split(/\s+/), ...decodeWords(v.split(/\s+/)) });
    if (!loc) { toast('Those aren\'t four location words', 'err'); return; }
    applyLocation(job, loc).then(() => renderJob(job));
  });
  el.append(form);

  // ---- options
  const o = job.options;
  const opt = (key, label, input, persist = true) => {
    const read = () => (input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value);
    input.addEventListener('change', () => { o[key] = read(); if (persist) savePrefs({ [key]: o[key] }); drawJobWave(job); });
    input.disabled = !editable;
    return h('label', { class: 'opt' }, input, h('span', {}, label));
  };
  const tracks = (w.ixml?.tracks || []);
  el.append(h('details', { class: 'options', open: false },
    h('summary', {}, 'Cleanup: ', describeOptions(o)),
    h('div', { class: 'opts' },
      opt('cutSlate', `Cut slate (first ${o.slateEnd.toFixed(1)} s)`, h('input', { type: 'checkbox', checked: o.cutSlate }), false),
      opt('trim', 'Trim silence at head/tail', h('input', { type: 'checkbox', checked: o.trim })),
      opt('highpass', 'High-pass', h('select', {}, [[0, 'off'], [30, '30 Hz'], [40, '40 Hz'], [80, '80 Hz'], [120, '120 Hz']].map(([v, l]) => h('option', { value: v, selected: Number(o.highpass) === v }, l)))),
      opt('normalize', 'Normalize', h('select', {}, [['peak', 'peak −1 dBFS'], ['loudness', '−18 LUFS (peak ≤ −1)'], ['off', 'off']].map(([v, l]) => h('option', { value: v, selected: o.normalize === v }, l)))),
      opt('fadeIn', 'fade in ms', h('input', { type: 'number', min: 0, max: 5000, value: o.fadeIn })),
      opt('fadeOut', 'fade out ms', h('input', { type: 'number', min: 0, max: 10000, value: o.fadeOut })),
      opt('format', 'Clip format', h('select', {}, [['24', '24-bit'], ['float', '32-bit float']].map(([v, l]) => h('option', { value: v, selected: o.format === v }, l)))),
      w.channels > 1 && opt('channels', 'Channels', h('select', {},
        h('option', { value: 'all', selected: o.channels === 'all' }, `all ${w.channels}`),
        h('option', { value: 'mono', selected: o.channels === 'mono' }, 'mix to mono'),
        Array.from({ length: w.channels }, (_, i) => h('option', { value: `t${i}`, selected: o.channels === `t${i}` }, `track ${i + 1}${tracks[i] ? ` (${tracks[i]})` : ''}`))), false),
    ),
    h('p', { class: 'muted small' }, 'The original file is uploaded untouched; these only shape the clip.'),
  ));

  el.append(h('footer', {},
    h('button', { class: 'primary', disabled: job.status !== 'ready' || job.duplicate, onclick: () => queueUpload(job) }, 'Process & upload'),
    h('div', { class: 'progress' }, h('i')),
  ));
  updateCounts();
}

function describeOptions(o) {
  return [o.cutSlate && 'cut slate', o.trim && 'trim', o.highpass ? `HPF ${o.highpass}` : null,
    o.normalize === 'peak' ? 'peak −1' : o.normalize === 'loudness' ? '−18 LUFS' : null,
    o.format === 'float' ? '32f' : '24-bit', o.channels !== 'all' ? o.channels.replace(/^t(\d+)/, (_, n) => `track ${+n + 1}`) : null].filter(Boolean).join(' · ');
}
