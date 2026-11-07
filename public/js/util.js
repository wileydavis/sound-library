import { decodePeaks } from './dsp.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function fmtDur(sec) {
  if (!Number.isFinite(sec)) return '–';
  if (sec < 10) return `${sec.toFixed(1)}s`;
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return m ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
}
export const fmtDb = (x, unit = 'dB') => (Number.isFinite(x) ? `${x.toFixed(1)} ${unit}` : '–');
export function fmtSize(b) {
  if (!b) return '–';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (b >= 1024 && i < 3) { b /= 1024; i++; }
  return `${b.toFixed(i ? 1 : 0)} ${u[i]}`;
}
export const fmtRate = (sr) => (sr ? `${(sr / 1000).toFixed(sr % 1000 ? 1 : 0)}k` : '');

export function slug(s, max = 48) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '') || 'untitled';
}

export const shortId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 12);

export async function sha256Hex(buf) {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Draw a waveform from either raw channels or stored base64 peaks. */
export function drawWave(canvas, peaksB64, { progress = 0, marks = [] } = {}) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 300, hgt = canvas.clientHeight || 40;
  if (canvas.width !== w * dpr) { canvas.width = w * dpr; canvas.height = hgt * dpr; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, hgt);
  const p = typeof peaksB64 === 'string' ? decodePeaks(peaksB64) : peaksB64;
  const n = p.length / 2;
  if (!n) return;
  const style = getComputedStyle(canvas);
  const fg = style.getPropertyValue('--wave').trim() || '#bbb';
  const done = style.getPropertyValue('--wave-done').trim() || '#e8c547';
  const mid = hgt / 2;
  for (let x = 0; x < w; x++) {
    const b = Math.floor((x / w) * n);
    const lo = p[b * 2] / 127, hi = p[b * 2 + 1] / 127;
    ctx.fillStyle = x / w < progress ? done : fg;
    ctx.fillRect(x, mid - hi * mid, 1, Math.max(1, (hi - lo) * mid));
  }
  for (const m of marks) {
    ctx.fillStyle = m.color || 'rgba(232,90,71,.25)';
    ctx.fillRect(m.from * w, 0, Math.max(1, (m.to - m.from) * w), hgt);
  }
}

export function toast(msg, kind = '') {
  const t = h('div', { class: `toast ${kind}` }, msg);
  document.body.append(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 4000);
}

export const TYPES = [
  ['field', 'Field / ambience'],
  ['voice', 'Voice (speech, singing)'],
  ['ir', 'Impulse response'],
  ['tonal', 'Tonal / instrument'],
  ['other', 'Other'],
];
