// Location tab: GPS → four words to say in your slate. Works offline; nothing is sent anywhere.
import { encodeLocation } from './geowords.js';
import { $ } from './util.js';

let last = null, watch = null, ticker = null, started = 0, wakeLock = null, active = false;
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
const LOG = 'sl.where.log';

export function initWhere() {
  $('#w-mark').onclick = mark;
  $('#w-refresh').onclick = () => { $('#w-err').textContent = ''; start(); };
  $('#w-copy').onclick = () => last && navigator.clipboard?.writeText(`location ${last.words.join(' ')}`);
  document.addEventListener('visibilitychange', () => {
    if (!active) return;
    if (document.visibilityState === 'visible') { wake(); start(); } else stop();
  });
  const net = () => ($('#w-net').textContent = navigator.onLine ? '' : 'offline — still works');
  addEventListener('online', net); addEventListener('offline', net); net();
  renderLog();
}

/** Called when the tab is shown / hidden, so location is only used while you're looking at it. */
export function setWhereActive(on) {
  active = on;
  if (on) { wake(); start(); } else { stop(); wakeLock?.release?.().catch(() => {}); wakeLock = null; }
}

function show(pos) {
  const { latitude: lat, longitude: lon, accuracy } = pos.coords;
  last = { lat, lon, accuracy, time: pos.timestamp, words: encodeLocation(lat, lon) };
  const el = $('#w-words');
  el.replaceChildren(...last.words.map((w) => Object.assign(document.createElement('span'), { textContent: w })));
  el.classList.toggle('stale', accuracy > 50);
  const q = accuracy <= 15 ? 'good' : accuracy <= 50 ? 'fair' : 'poor';
  $('#w-acc').innerHTML = `accuracy <b class="${q}">±${Math.round(accuracy)} m · ${q}</b>`;
  $('#w-coords').textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  $('#w-err').textContent = '';
  $('#w-mark').disabled = false;
}

function onErr(e) {
  if (last) return; // keep showing the last good fix
  $('#w-err').textContent = e.code === 1
    ? (isIOS ? 'Location is blocked. iPhone Settings → Privacy & Security → Location Services → your browser → While Using, with Precise Location on. Then reload.' : 'Location permission is off for this site — allow it in the browser, then tap Refresh.')
    : `No fix yet (${e.message || 'code ' + e.code}). Keep waiting, or step outside.`;
}

function start() {
  if (!window.isSecureContext) { $('#w-err').textContent = 'Needs https.'; return; }
  if (!('geolocation' in navigator)) { $('#w-err').textContent = 'This browser has no location access.'; return; }
  stop();
  started = Date.now();
  // A quick coarse fix first (iOS sometimes never answers a watch until asked directly), then keep refining.
  navigator.geolocation.getCurrentPosition(show, onErr, { enableHighAccuracy: false, maximumAge: 60000, timeout: 15000 });
  watch = navigator.geolocation.watchPosition(show, onErr, { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 });
  ticker = setInterval(() => {
    if (last) { clearInterval(ticker); return; }
    const sec = Math.round((Date.now() - started) / 1000);
    $('#w-acc').textContent = `waiting for location… ${sec}s`;
    if (sec >= 12 && !$('#w-err').textContent) $('#w-err').textContent = isIOS
      ? 'Still nothing. Check iPhone Settings → Privacy & Security → Location Services: on, and your browser set to “While Using” with Precise Location. Then close and reopen the browser.'
      : 'Still nothing. Check that location is on for this device and browser, then tap Refresh.';
  }, 1000);
}

function stop() {
  if (watch !== null) navigator.geolocation.clearWatch(watch);
  watch = null;
  clearInterval(ticker);
}

async function wake() { try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* not supported */ } }

const readLog = () => { try { return JSON.parse(localStorage.getItem(LOG)) || []; } catch { return []; } };
function mark() {
  if (!last) return;
  const log = readLog();
  log.unshift(last);
  try { localStorage.setItem(LOG, JSON.stringify(log.slice(0, 500))); } catch { /* full */ }
  renderLog();
  navigator.vibrate?.(30);
}
function renderLog() {
  $('#w-log').replaceChildren(...readLog().slice(0, 50).map((e) => {
    const li = document.createElement('li');
    const t = document.createElement('time');
    t.textContent = new Date(e.time).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    li.append(t, e.words.join(' '), ` ±${Math.round(e.accuracy)}m`);
    return li;
  }));
}
