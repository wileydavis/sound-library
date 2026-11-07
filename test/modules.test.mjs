// Node tests for the browser audio modules: node test/modules.test.mjs
import assert from 'node:assert/strict';
import { parseWav, encodeWav } from '../public/js/wav.js';
import * as dsp from '../public/js/dsp.js';
import { makeZip, crc32 } from '../public/js/zip.js';
import { encodeLocation, decodeWords, findLocationInText, matchWord, distanceM } from '../public/js/geowords.js';

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log('ok -', name); };

const sine = (sr, sec, f, amp) => Float32Array.from({ length: Math.round(sr * sec) }, (_, i) => amp * Math.sin((2 * Math.PI * f * i) / sr));
let seed = 1;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;

t('24-bit WAV round trip with bext + INFO', () => {
  const sr = 96000;
  const ch = [sine(sr, 0.5, 440, 0.5), sine(sr, 0.5, 660, 0.25)];
  const buf = encodeWav(ch, sr, { bitDepth: 24, bext: { description: 'freight brakes', originationDate: '2026-11-07', originationTime: '08:12:00', timeReference: 123456789 }, info: { INAM: 'railyard brakes', IKEY: 'metal, train' } });
  const w = parseWav(buf);
  assert.equal(w.sampleRate, sr); assert.equal(w.channels, 2); assert.equal(w.bitDepth, 24);
  assert.equal(w.frames, ch[0].length);
  assert.equal(w.bext.description, 'freight brakes');
  assert.equal(w.bext.originationDate, '2026-11-07');
  assert.equal(w.bext.timeReference, 123456789);
  assert.equal(w.info.INAM, 'railyard brakes');
  let maxErr = 0;
  for (let i = 0; i < ch[0].length; i++) maxErr = Math.max(maxErr, Math.abs(w.data[0][i] - ch[0][i]), Math.abs(w.data[1][i] - ch[1][i]));
  assert.ok(maxErr < 1e-6, `24-bit error ${maxErr}`);
});

t('32-bit float WAV keeps overs above 0 dBFS', () => {
  const sr = 48000;
  const ch = [sine(sr, 0.1, 100, 2.0)];
  const w = parseWav(encodeWav(ch, sr, { float: true }));
  assert.ok(w.isFloat); assert.equal(w.bitDepth, 32);
  assert.ok(dsp.peakDb(w.data) > 5.9);
});

t('MixPre-style iXML + WAVE_FORMAT_EXTENSIBLE float poly file parses', () => {
  // Hand-build: extensible fmt (float subformat), 3 channels, iXML with track names.
  const sr = 48000, frames = 480, nch = 3;
  const ixml = '<?xml version="1.0"?><BWFXML><PROJECT>TRIP</PROJECT><SCENE>RAILYARD</SCENE><TAKE>3</TAKE><NOTE>cold &amp; windy</NOTE><TRACK_LIST><TRACK><NAME>416</NAME></TRACK><TRACK><NAME>L</NAME></TRACK><TRACK><NAME>R</NAME></TRACK></TRACK_LIST></BWFXML>';
  const ix = new TextEncoder().encode(ixml);
  const ixPad = ix.length & 1;
  const dataLen = frames * nch * 4;
  const size = 12 + 8 + 40 + 8 + ix.length + ixPad + 8 + dataLen;
  const b = new ArrayBuffer(size), v = new DataView(b), u = new Uint8Array(b);
  let p = 0; const w4 = (s) => { for (const c of s) v.setUint8(p++, c.charCodeAt(0)); };
  w4('RIFF'); v.setUint32(p, size - 8, true); p += 4; w4('WAVE');
  w4('fmt '); v.setUint32(p, 40, true); p += 4;
  v.setUint16(p, 0xfffe, true); v.setUint16(p + 2, nch, true); v.setUint32(p + 4, sr, true);
  v.setUint32(p + 8, sr * nch * 4, true); v.setUint16(p + 12, nch * 4, true); v.setUint16(p + 14, 32, true);
  v.setUint16(p + 16, 22, true); v.setUint16(p + 18, 32, true); v.setUint32(p + 20, 7, true); v.setUint16(p + 24, 3, true);
  p += 40;
  w4('iXML'); v.setUint32(p, ix.length, true); p += 4; u.set(ix, p); p += ix.length + ixPad;
  w4('data'); v.setUint32(p, dataLen, true); p += 4;
  for (let i = 0; i < frames; i++) for (let c = 0; c < nch; c++, p += 4) v.setFloat32(p, (c + 1) * 0.1, true);
  const w = parseWav(b);
  assert.equal(w.channels, 3); assert.ok(w.isFloat);
  assert.ok(Math.abs(w.data[2][10] - 0.3) < 1e-6);
  assert.equal(w.ixml.scene, 'RAILYARD'); assert.equal(w.ixml.take, '3');
  assert.equal(w.ixml.note, 'cold & windy');
  assert.deepEqual(w.ixml.tracks, ['416', 'L', 'R']);
});

t('LUFS: 1 kHz sine at -20 dBFS mono ≈ -23 LUFS', () => {
  const l = dsp.integratedLoudness([sine(48000, 5, 1000, 0.1)], 48000);
  assert.ok(Math.abs(l - -23) < 0.15, `got ${l}`);
  const l96 = dsp.integratedLoudness([sine(96000, 5, 1000, 0.1)], 96000);
  assert.ok(Math.abs(l96 - -23) < 0.15, `96k got ${l96}`);
});

t('High-pass removes 20 Hz rumble, keeps 1 kHz', () => {
  const sr = 48000;
  const low = [sine(sr, 2, 20, 0.5)], high = [sine(sr, 2, 1000, 0.5)];
  dsp.highpass(low, sr, 80); dsp.highpass(high, sr, 80);
  const tail = (x) => [x[0].subarray(sr)];
  assert.ok(dsp.peakDb(tail(low)) < -40, `20 Hz left at ${dsp.peakDb(tail(low))}`);
  assert.ok(Math.abs(dsp.peakDb(tail(high)) - dsp.gainToDb(0.5)) < 0.1);
});

t('Peak normalize to -1 dBFS (including float overs)', () => {
  const ch = [sine(48000, 0.2, 300, 1.8)];
  dsp.normalizePeak(ch, -1);
  assert.ok(Math.abs(dsp.peakDb(ch) - -1) < 0.01);
});

t('Loudness normalize respects the peak ceiling', () => {
  const ch = [sine(48000, 3, 1000, 0.01)];
  dsp.normalizeLoudness(ch, 48000, -10, -1);
  assert.ok(dsp.peakDb(ch) <= -0.99);
});

t('Silence trim finds a sound inside quiet ambience', () => {
  const sr = 48000;
  const x = new Float32Array(sr * 4);
  for (let i = 0; i < x.length; i++) x[i] = rand() * 0.001; // ~-60 dBFS hiss
  for (let i = sr * 1.5; i < sr * 2.5; i++) x[i] += 0.5 * Math.sin(i * 0.05);
  const { start, end } = dsp.findSoundBounds([x], sr);
  assert.ok(Math.abs(start / sr - 1.48) < 0.03, `start ${start / sr}`);
  assert.ok(Math.abs(end / sr - 2.75) < 0.05, `end ${end / sr}`);
});

t('Noise floor estimate', () => {
  const sr = 48000;
  const x = new Float32Array(sr * 3);
  for (let i = 0; i < x.length; i++) x[i] = rand() * 0.01;
  const nf = dsp.noiseFloorDb([x], sr);
  assert.ok(nf > -48 && nf < -43, `nf ${nf}`);
});

t('Waveform peaks encode/decode', () => {
  const p = dsp.decodePeaks(dsp.waveformPeaks([sine(8000, 1, 5, 0.5)], 100));
  assert.equal(p.length, 200);
  assert.equal(Math.max(...p), 127);
});

t('Zip CRC and structure', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  const z = makeZip([{ name: 'a.wav', data: new Uint8Array([1, 2, 3]) }, { name: 'dir/b.json', data: new TextEncoder().encode('{}') }]);
  assert.equal(z.size, 30 + 5 + 3 + 30 + 10 + 2 + 46 + 5 + 46 + 10 + 22);
});

t('Location words round trip within ~10 m, worldwide', () => {
  const places = [[45.857612, -111.330421], [29.951065, -90.071533], [33.322, -115.729], [-33.8568, 151.2153], [64.1466, -21.9426], [0, 0], [-89.99, 179.99], [89.99, -180]];
  for (const [lat, lon] of places) {
    const w = encodeLocation(lat, lon);
    assert.equal(w.length, 4);
    const d = decodeWords(w);
    assert.ok(distanceM({ lat, lon }, d) < 10, `${lat},${lon} → ${w.join(' ')} off by ${distanceM({ lat, lon }, d)} m`);
  }
  // Neighbours 1 km apart share the first two words.
  const a = encodeLocation(45.8576, -111.3304), b = encodeLocation(45.8666, -111.3304);
  assert.deepEqual(a.slice(0, 2), b.slice(0, 2));
});

t('Location words found in a messy slate transcript', () => {
  const w = encodeLocation(45.857612, -111.330421);
  const said = `Railyard, freight brakes, cold morning, 416 on the boom. Location: ${w.join(', ')}.`;
  const f = findLocationInText(said);
  assert.ok(f); assert.deepEqual(f.words, w); assert.equal(f.corrected, false);
  // Whisper mishearings: plural, one-letter slip.
  // scorpion cotton sea point → plural, a doubled letter, a homophone
  const garbled = 'Location is scorpions cottton see point.';
  const g = findLocationInText(garbled);
  assert.ok(g, `failed on: ${garbled}`);
  assert.deepEqual(g.words, w);
  assert.equal(findLocationInText('cold windy morning by the river'), null);
  assert.equal(matchWord('abandon').word, 'abandon');
});

console.log(`\n${passed} passed`);
