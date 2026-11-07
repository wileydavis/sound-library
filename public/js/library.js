// "Library" tab: search (incl. what people said), preview, edit, delete, download.
import { api } from './api.js';
import { makeZip } from './zip.js';
import { findLocationInText } from './geowords.js';
import { $, h, fmtDur, fmtDb, fmtSize, fmtRate, drawWave, toast, TYPES } from './util.js';

const state = { q: '', type: '', tag: '', sort: 'recent', items: [], total: 0, selected: new Set(), offset: 0, view: 'list', bbox: '' };
let map = null, markerLayer = null, mapFitted = false, mapTimer = null;
const PAGE = 100;
const player = new Audio();
player.preload = 'none';
let playing = null; // item id
let searchTimer = null;

export function initLibrary() {
  $('#q').addEventListener('input', (e) => { state.q = e.target.value; clearTimeout(searchTimer); searchTimer = setTimeout(() => load(), 220); });
  $('#f-type').append(...TYPES.map(([v, l]) => h('option', { value: v }, l)));
  $('#f-type').addEventListener('change', (e) => { state.type = e.target.value; load(); });
  $('#f-sort').addEventListener('change', (e) => { state.sort = e.target.value; load(); });
  $('#f-tag').addEventListener('change', (e) => { state.tag = e.target.value; load(); });
  $('#sel-all').addEventListener('change', (e) => { state.items.forEach((i) => (e.target.checked ? state.selected.add(i.id) : state.selected.delete(i.id))); render(); });
  $('#dl-zip').addEventListener('click', () => downloadSelected('zip'));
  $('#dl-folder').addEventListener('click', () => downloadSelected('folder'));
  if (!window.showDirectoryPicker) $('#dl-folder').title = 'Needs Chrome or Edge';
  $('#more').addEventListener('click', () => load(true));
  for (const b of document.querySelectorAll('#view-toggle button')) b.addEventListener('click', () => setView(b.dataset.view));
  $('#map-filter').addEventListener('change', () => { state.bbox = $('#map-filter').checked && map ? bboxString() : ''; load(); });
  if (localStorage.getItem('sl.view') === 'map') setView('map');
  document.addEventListener('library:changed', () => load());
  player.addEventListener('timeupdate', paintProgress);
  player.addEventListener('ended', () => { playing = null; render(); });
  player.addEventListener('pause', () => render());
  player.addEventListener('play', () => render());
  window.addEventListener('resize', () => render());
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !/INPUT|TEXTAREA|SELECT|BUTTON/.test(document.activeElement.tagName) && playing && !$('#tab-library').hidden) {
      e.preventDefault(); player.paused ? player.play() : player.pause();
    }
  });
  load();
}

async function load(more = false) {
  state.offset = more ? state.offset + PAGE : 0;
  const qs = new URLSearchParams({ q: state.q, type: state.type, tag: state.tag, sort: state.sort, limit: PAGE, offset: state.offset });
  if (state.view === 'map' && state.bbox) qs.set('bbox', state.bbox);
  if (state.view === 'map' && !more) loadMarkers();
  try {
    const r = await api.get(`/api/items?${qs}`);
    state.items = more ? state.items.concat(r.items) : r.items;
    state.total = r.total;
    render();
    loadTags();
  } catch (e) {
    $('#results').replaceChildren(h('p', { class: 'err' }, e.message));
  }
}

async function loadTags() {
  try {
    const tags = await api.get('/api/tags');
    const sel = $('#f-tag');
    const cur = state.tag;
    sel.replaceChildren(h('option', { value: '' }, 'Any tag'), ...tags.slice(0, 200).map((t) => h('option', { value: t.tag, selected: t.tag === cur }, `${t.tag} (${t.n})`)));
  } catch { /* non-fatal */ }
}

function render() {
  $('#count').textContent = state.total ? `${state.total} sound${state.total === 1 ? '' : 's'}` : '';
  const nSel = state.selected.size;
  $('#sel-info').textContent = nSel ? `${nSel} selected` : '';
  $('#dl-zip').disabled = $('#dl-folder').disabled = !nSel;
  $('#more').hidden = state.items.length >= state.total;
  const list = $('#results');
  if (!state.items.length) {
    const msg = state.view === 'map' && state.bbox ? 'No sounds in this part of the map — zoom out or move it.'
      : state.q || state.type || state.tag ? 'Nothing matches.' : 'Nothing here yet — add some recordings.';
    list.replaceChildren(h('p', { class: 'muted empty' }, msg));
    return;
  }
  list.replaceChildren(...state.items.map(row));
  requestAnimationFrame(() => {
    for (const c of list.querySelectorAll('canvas[data-id]')) {
      const it = state.items.find((i) => i.id === c.dataset.id);
      drawWave(c, it.peaks || '', { progress: it.id === playing && player.duration ? player.currentTime / player.duration : 0 });
    }
  });
}

function paintProgress() {
  const c = document.querySelector(`canvas[data-id="${playing}"]`);
  const it = state.items.find((i) => i.id === playing);
  if (c && it) drawWave(c, it.peaks || '', { progress: player.duration ? player.currentTime / player.duration : 0 });
}

function play(it, at = null) {
  if (playing !== it.id) {
    player.src = api.fileUrl(it.clip_key);
    playing = it.id;
  }
  if (at !== null) {
    const go = () => { player.currentTime = at * (player.duration || it.duration); player.play(); };
    if (player.readyState >= 1) go(); else player.addEventListener('loadedmetadata', go, { once: true });
    player.play().catch(() => {});
    return;
  }
  if (player.paused) player.play(); else player.pause();
}

function row(it) {
  const isPlaying = playing === it.id && !player.paused;
  const tags = String(it.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
  const canvas = h('canvas', { class: 'wave', 'data-id': it.id });
  canvas.addEventListener('click', (e) => { const r = canvas.getBoundingClientRect(); play(it, (e.clientX - r.left) / r.width); });
  const needsRelease = it.type === 'voice' && !['verbal', 'written', 'n/a'].includes(it.release_status);
  return h('article', { class: `item ${state.selected.has(it.id) ? 'sel' : ''}` },
    h('input', { type: 'checkbox', checked: state.selected.has(it.id), onchange: (e) => { e.target.checked ? state.selected.add(it.id) : state.selected.delete(it.id); render(); } }),
    h('button', { class: 'play', onclick: () => play(it) }, isPlaying ? '❚❚' : '▶'),
    h('div', { class: 'body' },
      h('div', { class: 'top' },
        h('span', { class: 'title' }, it.title),
        h('span', { class: `type t-${it.type}` }, it.type),
        needsRelease && h('span', { class: 'badge warn' }, 'no release'),
        h('span', { class: 'meta' }, [fmtDur(it.duration), (it.recorded_at || '').slice(0, 10), it.location, it.people].filter(Boolean).join(' · ')),
      ),
      canvas,
      it.description && h('div', { class: 'desc' }, it.description),
      it.transcript_hit && h('div', { class: 'hit', html: highlight(it.transcript_hit) }),
      h('div', { class: 'tags' }, tags.map((t) => h('button', { class: 'tag', onclick: () => { state.tag = t; loadTags().then(() => ($('#f-tag').value = t)); load(); } }, t))),
    ),
    h('div', { class: 'actions' },
      h('a', { class: 'btn', href: api.fileUrl(it.clip_key, { download: true, name: downloadName(it) }), title: 'Download clip' }, '⬇ clip'),
      h('a', { class: 'btn ghost', href: api.fileUrl(it.original_key, { download: true, name: downloadName(it, true) }), title: `Original, ${fmtSize(it.original_size)}` }, '⬇ original'),
      h('button', { class: 'btn ghost', onclick: () => edit(it) }, 'Edit'),
      h('span', { class: 'tech' }, [fmtRate(it.sample_rate), it.bit_depth === 32 ? '32f' : `${it.bit_depth}b`, `${it.channels}ch`, fmtDb(it.lufs, 'LUFS')].join(' ')),
    ),
  );
}

function highlight(snip) {
  const e = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  return '“' + e(snip).replace(/\[([^\]]*)\]/g, '<mark>$1</mark>') + '”';
}

// ---------------------------------------------------------------- edit
async function edit(summary) {
  const it = await api.get(`/api/items/${summary.id}`);
  const dlg = $('#edit-dialog');
  const fields = [
    ['title', 'Title'], ['type', 'Type'], ['tags', 'Tags'], ['description', 'Description'], ['location', 'Location'],
    ['location_words', 'Location words'], ['recorded_at', 'Recorded'], ['people', 'People'], ['release_status', 'Release'], ['notes', 'Notes'],
  ];
  const inputs = {};
  const body = h('div', { class: 'form' }, fields.map(([k, label]) => {
    let input;
    if (k === 'type') input = h('select', {}, TYPES.map(([v, l]) => h('option', { value: v, selected: it.type === v }, l)));
    else if (k === 'release_status') input = h('select', {}, [['', '—'], ['none', 'No release yet'], ['verbal', 'Verbal OK (on tape)'], ['written', 'Written release'], ['n/a', 'Not needed']].map(([v, l]) => h('option', { value: v, selected: (it.release_status || '') === v }, l)));
    else input = h('input', { value: it[k] ?? '' });
    inputs[k] = input;
    return h('label', {}, h('span', {}, label), input);
  }));
  let transcriptEl = null;
  if (it.transcript) {
    let segs = [];
    try { segs = JSON.parse(it.transcript_json || '[]'); } catch { /* old rows */ }
    transcriptEl = h('details', { class: 'transcript' }, h('summary', {}, 'Transcript'),
      segs.length ? segs.map((s) => h('p', {}, h('button', { class: 'ts', onclick: (e) => { e.preventDefault(); play(it, Math.max(0, s.start) / it.duration); } }, fmtDur(Math.max(0, s.start))), ' ', s.text))
        : h('p', {}, it.transcript));
  }
  let delArmed = false;
  const delBtn = h('button', { class: 'danger', type: 'button', onclick: async () => {
    if (!delArmed) { delArmed = true; delBtn.textContent = 'Click again to delete for good'; return; }
    await api.del(`/api/items/${it.id}`);
    dlg.close(); toast('Deleted'); load();
  } }, 'Delete');
  const info = h('p', { class: 'muted small' },
    `${it.filename} · from ${it.original_name} · ${fmtRate(it.sample_rate)} ${it.channels}ch · peak ${fmtDb(it.peak_db)} · ${fmtDb(it.lufs, 'LUFS')} · floor ${fmtDb(it.noise_floor_db)}`,
    it.lat != null ? h('span', {}, ' · ', h('a', { href: `https://www.openstreetmap.org/?mlat=${it.lat}&mlon=${it.lon}#map=17/${it.lat}/${it.lon}`, target: '_blank', rel: 'noopener' }, 'map')) : '',
    it.slate ? h('span', {}, ` · slate: “${it.slate}”`) : '');
  dlg.replaceChildren(h('form', { method: 'dialog' },
    h('h2', {}, 'Edit'), body, info, transcriptEl,
    h('footer', {},
      delBtn,
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'ghost', onclick: () => dlg.close() }, 'Cancel'),
      h('button', { class: 'primary', type: 'button', onclick: async () => {
        const patch = {};
        for (const [k] of fields) if (String(inputs[k].value) !== String(it[k] ?? '')) patch[k] = inputs[k].value;
        if ('location_words' in patch) {
          const v = patch.location_words.trim();
          const loc = v && findLocationInText(`location ${v}`);
          if (v && !loc) { toast("Those aren't four location words", 'err'); return; }
          Object.assign(patch, loc ? { location_words: loc.words.join(' '), lat: loc.lat, lon: loc.lon } : { location_words: '', lat: null, lon: null });
        }
        if (Object.keys(patch).length) { await api.patch(`/api/items/${it.id}`, patch); toast('Saved'); load(); }
        dlg.close();
      } }, 'Save'),
    )));
  dlg.showModal();
}

// ---------------------------------------------------------------- downloads
async function downloadSelected(mode) {
  const items = state.items.filter((i) => state.selected.has(i.id));
  const withOriginals = $('#dl-originals').checked;
  const files = [];
  const used = new Set();
  const unique = (path) => {
    let p = path, n = 2;
    while (used.has(p.toLowerCase())) p = path.replace(/(\.[^.]+)$/, ` (${n++})$1`);
    used.add(p.toLowerCase());
    return p;
  };
  for (const it of items) {
    files.push({ key: it.clip_key, path: unique(`${it.type}/${downloadName(it)}`), size: it.clip_size });
    if (withOriginals) files.push({ key: it.original_key, path: unique(`originals/${downloadName(it, true)}`), size: it.original_size });
  }
  const status = $('#dl-status');
  try {
    if (mode === 'folder') {
      if (!window.showDirectoryPicker) { toast('Saving to a folder needs Chrome or Edge — use .zip instead', 'err'); return; }
      const root = await window.showDirectoryPicker({ id: 'sound-library', mode: 'readwrite' });
      let i = 0;
      for (const f of files) {
        status.textContent = `Saving ${++i}/${files.length}…`;
        const parts = f.path.split('/');
        let dir = root;
        for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
        const fh = await dir.getFileHandle(parts.at(-1), { create: true });
        const res = await fetch(api.fileUrl(f.key));
        if (!res.ok) throw new Error(`Couldn't fetch ${f.path}`);
        const ws = await fh.createWritable();
        await res.body.pipeTo(ws);
      }
      toast(`Saved ${files.length} file${files.length === 1 ? '' : 's'} to “${root.name}”`);
    } else {
      const total = files.reduce((a, f) => a + (f.size || 0), 0);
      if (total > 3.5 * 1024 ** 3) { toast('Over 3.5 GB — save to a folder instead, or pick fewer', 'err'); return; }
      const entries = [];
      let i = 0;
      for (const f of files) {
        status.textContent = `Fetching ${++i}/${files.length}…`;
        const res = await fetch(api.fileUrl(f.key));
        if (!res.ok) throw new Error(`Couldn't fetch ${f.path}`);
        entries.push({ name: f.path, data: new Uint8Array(await res.arrayBuffer()) });
      }
      status.textContent = 'Zipping…';
      const blob = makeZip(entries);
      const a = h('a', { href: URL.createObjectURL(blob), download: `sounds_${new Date().toISOString().slice(0, 10)}.zip` });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    }
  } catch (e) {
    if (e.name !== 'AbortError') toast(e.message, 'err');
  } finally {
    status.textContent = '';
  }
}

// ---------------------------------------------------------------- download names
/** "freight brakes squeal.wav" — the title, made safe for every OS. */
export function downloadName(it, original = false) {
  const base = String(it.title || 'untitled').replace(/\s*[:/\\|]+\s*/g, ' - ').replace(/[\x00-\x1f*?"<>]+/g, '').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 120) || 'untitled';
  if (!original) return `${base}.wav`;
  const ext = (String(it.original_name || '').match(/\.[^.]+$/) || ['.wav'])[0].toLowerCase();
  return `${base} (original)${ext}`;
}

// ---------------------------------------------------------------- map
function setView(view) {
  state.view = view;
  try { localStorage.setItem('sl.view', view); } catch { /* private mode */ }
  for (const b of document.querySelectorAll('#view-toggle button')) b.classList.toggle('on', b.dataset.view === view);
  $('#map-wrap').hidden = view !== 'map';
  if (view === 'map') {
    if (!map) initMap();
    setTimeout(() => map.invalidateSize(), 0);
    state.bbox = $('#map-filter').checked && mapFitted ? bboxString() : '';
  } else {
    state.bbox = '';
  }
  load();
}

function initMap() {
  if (!window.L) { $('#map').textContent = 'Map library failed to load.'; return; }
  map = L.map('map', { worldCopyJump: true, zoomControl: true }).setView([45.68, -111.04], 9);
  // Free, keyless tile sources. Streets are darkened with CSS to match the app.
  const streets = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, className: 'tiles-dark',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  });
  const topo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    maxZoom: 17, subdomains: 'abc',
    attribution: 'Map: &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA), &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  });
  const layers = { Streets: streets, Topo: topo };
  let chosen = 'Streets';
  try { chosen = localStorage.getItem('sl.maplayer') || 'Streets'; } catch { /* ignore */ }
  (layers[chosen] || streets).addTo(map);
  L.control.layers(layers, null, { position: 'topright' }).addTo(map);
  map.on('baselayerchange', (e) => { try { localStorage.setItem('sl.maplayer', e.name); } catch { /* ignore */ } });
  markerLayer = L.layerGroup().addTo(map);
  map.on('moveend', () => {
    if (!$('#map-filter').checked || !mapFitted) return;
    clearTimeout(mapTimer);
    mapTimer = setTimeout(() => { state.bbox = bboxString(); load(); }, 250);
  });
}

function bboxString() {
  const b = map.getBounds();
  const wrap = (x) => ((((x + 180) % 360) + 360) % 360) - 180;
  const w = b.getWest(), e = b.getEast();
  if (e - w >= 360) return `-180,${b.getSouth().toFixed(5)},180,${b.getNorth().toFixed(5)}`;
  return [wrap(w), b.getSouth(), wrap(e), b.getNorth()].map((x) => x.toFixed(5)).join(',');
}

async function loadMarkers() {
  if (!map) return;
  const qs = new URLSearchParams({ q: state.q, type: state.type, tag: state.tag, geo: 1, lite: 1, limit: 500 });
  let r;
  try { r = await api.get(`/api/items?${qs}`); } catch (e) { $('#map-note').textContent = e.message; return; }
  markerLayer.clearLayers();
  // One marker per spot (~10 m); several takes at the same place share it.
  const spots = new Map();
  for (const it of r.items) {
    const k = `${it.lat.toFixed(4)},${it.lon.toFixed(4)}`;
    if (!spots.has(k)) spots.set(k, []);
    spots.get(k).push(it);
  }
  const pts = [];
  for (const items of spots.values()) {
    const { lat, lon } = items[0];
    pts.push([lat, lon]);
    const m = L.circleMarker([lat, lon], {
      radius: Math.min(16, 6 + Math.sqrt(items.length) * 2.5), color: '#e8c547', weight: 1.5, fillColor: '#e8c547', fillOpacity: 0.35,
    }).addTo(markerLayer);
    m.bindTooltip(items.length > 1 ? `${items.length} sounds` : items[0].title, { direction: 'top', offset: [0, -6] });
    m.bindPopup(() => popupFor(items), { maxWidth: 320 });
  }
  const located = r.total;
  $('#map-note').textContent = located ? `${located} sound${located === 1 ? '' : 's'} with a location${r.total > 500 ? ' (showing 500)' : ''}` : 'No sounds with a location match this search yet. Say “location …” in a slate, or add location words when editing.';
  if (!mapFitted && pts.length) {
    map.fitBounds(L.latLngBounds(pts).pad(0.3), { maxZoom: 15 });
    mapFitted = true;
    if ($('#map-filter').checked) { state.bbox = bboxString(); load(); }
  } else if (!pts.length) {
    mapFitted = true;
  }
}

function popupFor(items) {
  const el = h('div', { class: 'pop' },
    h('h4', {}, items[0].location || `${items[0].lat.toFixed(5)}, ${items[0].lon.toFixed(5)}`),
    items.slice(0, 20).map((it) => h('div', { class: 'pi' },
      h('button', { onclick: () => play(it) }, '▶'),
      h('span', {}, it.title),
      h('small', {}, [fmtDur(it.duration), (it.recorded_at || '').slice(0, 10)].join(' · ')))),
    items.length > 20 ? h('small', {}, `+${items.length - 20} more`) : null);
  return el;
}
