// Audio analysis and cleanup. Pure functions on Float32Array[] (one array per channel).
// Everything is applied to a copy for the clip; originals are never touched.

export const dbToGain = (db) => 10 ** (db / 20);
export const gainToDb = (g) => (g > 0 ? 20 * Math.log10(g) : -Infinity);

export function peakDb(channels) {
  let m = 0;
  for (const ch of channels) for (let i = 0; i < ch.length; i++) { const a = Math.abs(ch[i]); if (a > m) m = a; }
  return gainToDb(m);
}

/** RMS envelope in dB, one value per window, max across channels. */
export function rmsEnvelopeDb(channels, sampleRate, windowSec = 0.05) {
  const win = Math.max(1, Math.round(sampleRate * windowSec));
  const n = Math.floor(channels[0].length / win);
  const out = new Float32Array(n);
  for (let w = 0; w < n; w++) {
    let best = 0;
    for (const ch of channels) {
      let s = 0;
      for (let i = w * win, e = i + win; i < e; i++) s += ch[i] * ch[i];
      if (s > best) best = s;
    }
    out[w] = 10 * Math.log10(best / win + 1e-20);
  }
  return out;
}

/** Noise floor estimate: 10th percentile of 50 ms RMS windows. */
export function noiseFloorDb(channels, sampleRate) {
  const env = Array.from(rmsEnvelopeDb(channels, sampleRate, 0.05)).sort((a, b) => a - b);
  if (!env.length) return -Infinity;
  return env[Math.floor(env.length * 0.1)];
}

// ---------- biquads ----------
function runBiquad(x, b0, b1, b2, a1, a2) {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i];
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
    x[i] = y0;
  }
}

function highpassCoefs(fc, q, fs) {
  const w0 = (2 * Math.PI * fc) / fs;
  const cos = Math.cos(w0), alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  return [(1 + cos) / 2 / a0, -(1 + cos) / a0, (1 + cos) / 2 / a0, (-2 * cos) / a0, (1 - alpha) / a0];
}

/** 4th-order (24 dB/oct) Butterworth high-pass, in place. */
export function highpass(channels, sampleRate, fc) {
  if (!fc) return;
  for (const q of [0.5411961, 1.3065630]) {
    const c = highpassCoefs(fc, q, sampleRate);
    for (const ch of channels) runBiquad(ch, ...c);
  }
}

// ---------- loudness (ITU-R BS.1770-4 integrated, LUFS) ----------
function kWeightCoefs(fs) {
  // Stage 1: high shelf
  let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / fs);
  const Vh = 10 ** (G / 20), Vb = Vh ** 0.4996667741545416;
  let a0 = 1 + K / Q + K * K;
  const s1 = [(Vh + (Vb * K) / Q + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q + K * K) / a0, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0];
  // Stage 2: high pass
  f0 = 38.13547087602444; Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / fs);
  a0 = 1 + K / Q + K * K;
  const s2 = [1, -2, 1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0];
  return [s1, s2];
}

export function integratedLoudness(channels, sampleRate) {
  const [s1, s2] = kWeightCoefs(sampleRate);
  // Only the first two channels count (L/R); extra poly tracks would skew it.
  const chans = channels.slice(0, 2).map((ch) => {
    const x = Float32Array.from(ch);
    runBiquad(x, ...s1);
    runBiquad(x, ...s2);
    return x;
  });
  const block = Math.round(0.4 * sampleRate);
  const hop = Math.round(0.1 * sampleRate);
  const n = chans[0].length;
  if (n < block) return -Infinity;
  const blocks = [];
  for (let start = 0; start + block <= n; start += hop) {
    let z = 0;
    for (const x of chans) {
      let s = 0;
      for (let i = start; i < start + block; i++) s += x[i] * x[i];
      z += s / block;
    }
    blocks.push(z);
  }
  const L = (z) => -0.691 + 10 * Math.log10(z + 1e-20);
  const abs = blocks.filter((z) => L(z) > -70);
  if (!abs.length) return -Infinity;
  const meanAbs = abs.reduce((a, b) => a + b, 0) / abs.length;
  const rel = abs.filter((z) => L(z) > L(meanAbs) - 10);
  if (!rel.length) return -Infinity;
  return L(rel.reduce((a, b) => a + b, 0) / rel.length);
}

// ---------- edits ----------
export function cut(channels, startFrame, endFrame) {
  return channels.map((ch) => ch.slice(Math.max(0, startFrame), Math.min(ch.length, endFrame)));
}

/**
 * Find where sound starts and ends (head/tail silence trim). Never cuts inside the clip.
 * Threshold is relative to the file's own noise floor so quiet ambiences survive.
 */
export function findSoundBounds(channels, sampleRate, { marginDb = 10, preRoll = 0.02, postRoll = 0.25 } = {}) {
  const win = 0.01;
  const env = rmsEnvelopeDb(channels, sampleRate, win);
  const sorted = Array.from(env).sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.1)] ?? -120;
  const thresh = Math.max(floor + marginDb, -75);
  let first = env.findIndex((d) => d > thresh);
  let last = -1;
  for (let i = env.length - 1; i >= 0; i--) if (env[i] > thresh) { last = i; break; }
  const n = channels[0].length;
  if (first < 0) return { start: 0, end: n };
  const start = Math.max(0, Math.round((first * win - preRoll) * sampleRate));
  const end = Math.min(n, Math.round(((last + 1) * win + postRoll) * sampleRate));
  return { start, end };
}

/** Sine-shaped fades, in place. */
export function fade(channels, sampleRate, inMs, outMs) {
  const n = channels[0].length;
  const fi = Math.min(n, Math.round((inMs / 1000) * sampleRate));
  const fo = Math.min(n, Math.round((outMs / 1000) * sampleRate));
  for (const ch of channels) {
    for (let i = 0; i < fi; i++) ch[i] *= Math.sin((Math.PI / 2) * (i / fi));
    for (let i = 0; i < fo; i++) ch[n - 1 - i] *= Math.sin((Math.PI / 2) * (i / fo));
  }
}

export function applyGain(channels, gain) {
  for (const ch of channels) for (let i = 0; i < ch.length; i++) ch[i] *= gain;
}

/** Peak-normalize in place to targetDb (e.g. -1). Returns gain applied in dB. */
export function normalizePeak(channels, targetDb = -1) {
  const p = peakDb(channels);
  if (!Number.isFinite(p)) return 0;
  const g = targetDb - p;
  applyGain(channels, dbToGain(g));
  return g;
}

/** Loudness-normalize to targetLufs but never let the peak exceed ceilingDb. Returns gain dB. */
export function normalizeLoudness(channels, sampleRate, targetLufs = -18, ceilingDb = -1) {
  const l = integratedLoudness(channels, sampleRate);
  if (!Number.isFinite(l)) return normalizePeak(channels, ceilingDb);
  const p = peakDb(channels);
  const g = Math.min(targetLufs - l, ceilingDb - p);
  applyGain(channels, dbToGain(g));
  return g;
}

/** Mix to mono (average). */
export function mono(channels) {
  if (channels.length === 1) return channels[0];
  const n = channels[0].length;
  const out = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i];
  for (let i = 0; i < n; i++) out[i] /= channels.length;
  return out;
}

/** Waveform overview: `buckets` min/max pairs as Int8, base64-encoded for storage. */
export function waveformPeaks(channels, buckets = 300) {
  const n = channels[0].length;
  const out = new Int8Array(buckets * 2);
  let m = 0;
  for (const ch of channels) for (let i = 0; i < n; i++) { const a = Math.abs(ch[i]); if (a > m) m = a; }
  const scale = m > 0 ? 127 / Math.max(m, 1e-9) : 0;
  for (let b = 0; b < buckets; b++) {
    const s = Math.floor((b * n) / buckets), e = Math.max(s + 1, Math.floor(((b + 1) * n) / buckets));
    let lo = 0, hi = 0;
    for (const ch of channels) for (let i = s; i < e && i < n; i++) { const x = ch[i]; if (x < lo) lo = x; if (x > hi) hi = x; }
    out[b * 2] = Math.round(lo * scale);
    out[b * 2 + 1] = Math.round(hi * scale);
  }
  let bin = '';
  const u = new Uint8Array(out.buffer);
  for (let i = 0; i < u.length; i++) bin += String.fromCharCode(u[i]);
  return btoa(bin);
}

export function decodePeaks(b64) {
  if (!b64) return new Int8Array(0);
  const bin = atob(b64);
  const out = new Int8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = (bin.charCodeAt(i) << 24) >> 24;
  return out;
}
