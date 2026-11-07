// Builds MixPre-like test recordings: node test/make-fixtures.mjs <outdir>
import fs from 'node:fs';
import { encodeWav } from '../public/js/wav.js';
const out = process.argv[2] || '/tmp/e2e';
let seed = 3; const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;

// Insert an iXML chunk into an encoded WAV (before 'data').
function withIxml(buf, xml) {
  const u = new Uint8Array(buf);
  const v = new DataView(buf);
  let off = 12;
  while (String.fromCharCode(...u.subarray(off, off + 4)) !== 'data') off += 8 + v.getUint32(off + 4, true);
  const x = new TextEncoder().encode(xml);
  const pad = x.length & 1;
  const chunk = new Uint8Array(8 + x.length + pad);
  chunk.set([...'iXML'].map((c) => c.charCodeAt(0)));
  new DataView(chunk.buffer).setUint32(4, x.length, true);
  chunk.set(x, 8);
  const res = new Uint8Array(u.length + chunk.length);
  res.set(u.subarray(0, off)); res.set(chunk, off); res.set(u.subarray(off), off + chunk.length);
  new DataView(res.buffer).setUint32(4, res.length - 8, true);
  return res;
}

function mixpre(sr, sec, nch, { slate = true, overs = false } = {}) {
  const n = Math.round(sr * sec);
  const ch = Array.from({ length: nch }, () => new Float32Array(n));
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let s = rand() * 0.003 + 0.02 * Math.sin(2 * Math.PI * 18 * t); // hiss + rumble
    if (slate && t < 5) s += 0.4 * Math.sin(2 * Math.PI * 220 * t) * (Math.sin(2 * Math.PI * 3 * t) > 0 ? 1 : 0.1); // "talking"
    if (t > 7 && t < 9) s += (overs ? 1.4 : 0.6) * Math.sin(2 * Math.PI * 900 * t) * Math.exp(-(t - 7) * 1.5); // the event
    for (let c = 0; c < nch; c++) ch[c][i] = s * (c === 0 ? 1 : 0.7);
  }
  return ch;
}
const ix = (scene, take, note) => `<?xml version="1.0" encoding="UTF-8"?><BWFXML><IXML_VERSION>1.61</IXML_VERSION><PROJECT>WINTER</PROJECT><SCENE>${scene}</SCENE><TAKE>${take}</TAKE><TAPE>2026-11-07</TAPE><NOTE>${note}</NOTE><TRACK_LIST><TRACK_COUNT>3</TRACK_COUNT><TRACK><CHANNEL_INDEX>1</CHANNEL_INDEX><NAME>416</NAME></TRACK><TRACK><CHANNEL_INDEX>2</CHANNEL_INDEX><NAME>L</NAME></TRACK><TRACK><CHANNEL_INDEX>3</CHANNEL_INDEX><NAME>R</NAME></TRACK></TRACK_LIST></BWFXML>`;
const bext = { description: 'sSPEED=096.000-ND\r\nsTAKE=03', originator: 'Sound Devices', originationDate: '2026-11-07', originationTime: '08:12:30', timeReference: 96000 * 3600 * 8 };

fs.writeFileSync(`${out}/261107_003.WAV`, withIxml(encodeWav(mixpre(96000, 14, 3, { overs: true }), 96000, { float: true, bext }), ix('RAILYARD', '3', 'wind from north')));
fs.writeFileSync(`${out}/261107_004.WAV`, new Uint8Array(encodeWav(mixpre(48000, 9, 2, { slate: false }), 48000, { bitDepth: 24, bext: { ...bext, originationTime: "09:40:00" } })));
fs.writeFileSync(`${out}/261107_005_long.WAV`, withIxml(encodeWav(mixpre(96000, 160, 2), 96000, { float: true, bext }), ix('CREEK', '5', '')));
for (const f of fs.readdirSync(out)) console.log(f, (fs.statSync(`${out}/${f}`).size / 1e6).toFixed(1), 'MB');
