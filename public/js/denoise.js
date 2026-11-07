// Spectral noise reduction (stationary spectral gating).
//
// 1. Learn the noise: take the quietest ~10% of moments in the recording and measure, per
//    frequency, how loud the steady background is (mean + spread, in dB).
// 2. Everywhere, any time-frequency cell that isn't clearly above that background is turned
//    down by `reductionDb` — not muted, so ambiences keep their air and nothing "pumps".
// 3. The on/off decisions are smoothed across ~50 ms and ~300 Hz to avoid warbly
//    "musical noise", and one shared mask is applied to every channel so the stereo
//    image doesn't shift.
//
// Streams frame by frame, so memory stays small even for 10-minute 192 kHz files.

const fftCache = new Map();

function fftPlan(n) {
  if (fftCache.has(n)) return fftCache.get(n);
  const bits = Math.log2(n);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / n); sin[i] = Math.sin((2 * Math.PI * i) / n); }
  const plan = { n, rev, cos, sin };
  fftCache.set(n, plan);
  return plan;
}

/** In-place complex FFT. inverse=true computes the unscaled inverse. */
export function fft(re, im, inverse = false) {
  const { n, rev, cos, sin } = fftPlan(re.length);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  const sgn = inverse ? 1 : -1;
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0, tw = 0; k < half; k++, tw += step) {
        const wr = cos[tw], wi = sgn * sin[tw];
        const a = start + k, b = a + half;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
}

export const DENOISE_LEVELS = { off: 0, light: 8, medium: 14, strong: 22 };

/**
 * Reduce steady background noise. Returns new channel arrays.
 * @param {Float32Array[]} channels
 * @param {number} sr
 * @param {{reductionDb?: number, onProgress?: (f:number)=>void}} opts
 */
export function denoise(channels, sr, { reductionDb = 12, onProgress } = {}) {
  const nch = channels.length;
  const len = channels[0].length;
  let N = 1024;
  while (N < sr * 0.043) N <<= 1;          // ~43 ms frames: 2048 @ 48k, 4096 @ 96k
  const hop = N / 4;
  const bins = N / 2 + 1;
  if (len < N * 2 || reductionDb <= 0) return channels.map((c) => c.slice());

  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const olaNorm = 1.5; // sum of hann² at 75% overlap

  const F = Math.ceil((len + N) / hop);    // frame t covers [t*hop - N + hop, t*hop + hop)
  const frameStart = (t) => t * hop - (N - hop);

  // ---- spectra of one frame for every channel (two real channels per complex FFT)
  const pairs = Math.ceil(nch / 2);
  const fre = Array.from({ length: pairs }, () => new Float64Array(N));
  const fim = Array.from({ length: pairs }, () => new Float64Array(N));
  function frameSpectra(t, outRe, outIm) {
    // outRe/outIm: per channel Float32Array(bins)
    const s0 = frameStart(t);
    for (let p = 0; p < pairs; p++) {
      const a = channels[2 * p], b = channels[2 * p + 1];
      const re = fre[p], im = fim[p];
      for (let i = 0; i < N; i++) {
        const k = s0 + i;
        const inR = k >= 0 && k < len;
        re[i] = inR ? a[k] * win[i] : 0;
        im[i] = inR && b ? b[k] * win[i] : 0;
      }
      fft(re, im);
      // Split the packed spectrum: A = (X[k] + conj X[N-k]) / 2, B = (X[k] - conj X[N-k]) / 2i
      for (let k = 0; k < bins; k++) {
        const j = (N - k) % N;
        const xr = re[k], xi = im[k], yr = re[j], yi = im[j];
        outRe[2 * p][k] = 0.5 * (xr + yr);
        outIm[2 * p][k] = 0.5 * (xi - yi);
        if (b) { outRe[2 * p + 1][k] = 0.5 * (xi + yi); outIm[2 * p + 1][k] = -0.5 * (xr - yr); }
      }
    }
  }
  const powerDb = (sRe, sIm, out) => {
    for (let k = 0; k < bins; k++) {
      let pw = 0;
      for (let c = 0; c < nch; c++) pw += sRe[c][k] * sRe[c][k] + sIm[c][k] * sIm[c][k];
      out[k] = 10 * Math.log10(pw / nch + 1e-20);
    }
  };

  // ---- 1. noise profile from the quietest frames
  const energy = new Float64Array(F);
  for (let t = 0; t < F; t++) {
    const s0 = Math.max(0, frameStart(t)), s1 = Math.min(len, frameStart(t) + N);
    let e = 0;
    for (let c = 0; c < nch; c++) { const x = channels[c]; for (let i = s0; i < s1; i += 4) e += x[i] * x[i]; }
    energy[t] = s1 > s0 ? e / (s1 - s0) : 0;
  }
  const candidates = [];
  for (let t = 2; t < F - 2; t++) if (energy[t] > 1e-14) candidates.push(t); // skip digital silence & edges
  if (candidates.length < 8) return channels.map((c) => c.slice());
  candidates.sort((a, b) => energy[a] - energy[b]);
  let quiet = candidates.slice(0, Math.max(8, Math.floor(candidates.length * 0.1)));
  if (quiet.length > 400) quiet = quiet.filter((_, i) => i % Math.ceil(quiet.length / 400) === 0);

  const tmpRe = Array.from({ length: nch }, () => new Float32Array(bins));
  const tmpIm = Array.from({ length: nch }, () => new Float32Array(bins));
  const db = new Float32Array(bins);
  const sum = new Float64Array(bins), sum2 = new Float64Array(bins);
  for (const t of quiet) {
    frameSpectra(t, tmpRe, tmpIm);
    powerDb(tmpRe, tmpIm, db);
    for (let k = 0; k < bins; k++) { sum[k] += db[k]; sum2[k] += db[k] * db[k]; }
  }
  const thresh = new Float32Array(bins);
  for (let k = 0; k < bins; k++) {
    const m = sum[k] / quiet.length;
    const sd = Math.sqrt(Math.max(0, sum2[k] / quiet.length - m * m));
    thresh[k] = m + 1.5 * sd + 2;
  }

  // ---- 2. stream: mask, smooth, apply, resynthesize
  const floorGain = 10 ** (-reductionDb / 20);
  const binHz = sr / N;
  const fHalf = Math.max(1, Math.round(80 / binHz));                // ±80 Hz widen, then ±80 Hz smooth
  const tHalf = Math.max(1, Math.round(0.025 / (hop / sr)));        // ±25 ms
  const R = 2 * tHalf + 1;
  const ringRe = Array.from({ length: R }, () => Array.from({ length: nch }, () => new Float32Array(bins)));
  const ringIm = Array.from({ length: R }, () => Array.from({ length: nch }, () => new Float32Array(bins)));
  const ringMask = Array.from({ length: R }, () => new Float32Array(bins));
  const out = Array.from({ length: nch }, () => new Float32Array(len));
  const raw = new Float32Array(bins);
  const prefix = new Float64Array(bins + 1);
  const dil = new Float32Array(bins);
  const gain = new Float32Array(bins);
  const holdBuf = new Float32Array(bins);
  const ore = new Float64Array(N), oim = new Float64Array(N);

  for (let t = 0; t < F + tHalf; t++) {
    if (t < F) {
      const slot = t % R;
      frameSpectra(t, ringRe[slot], ringIm[slot]);
      powerDb(ringRe[slot], ringIm[slot], db);
      for (let k = 0; k < bins; k++) {
        const x = (db[k] - thresh[k] + 3) / 6;             // soft knee over 6 dB
        raw[k] = x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x);
      }
      // Widen (max) first so narrow pitched sounds keep their full level, then smooth the edges.
      for (let k = 0; k < bins; k++) {
        let mx = 0;
        for (let j = Math.max(0, k - fHalf), e = Math.min(bins - 1, k + fHalf); j <= e; j++) if (raw[j] > mx) mx = raw[j];
        dil[k] = mx;
      }
      prefix[0] = 0;
      for (let k = 0; k < bins; k++) prefix[k + 1] = prefix[k] + dil[k];
      const m = ringMask[slot];
      for (let k = 0; k < bins; k++) {
        const a = Math.max(0, k - fHalf), b = Math.min(bins, k + fHalf + 1);
        m[k] = (prefix[b] - prefix[a]) / (b - a);
      }
    }
    const u = t - tHalf;                                      // frame ready to output
    if (u < 0 || u >= F) continue;
    // Time: average for smoothness, but never below the frame's own decision or half the
    // neighbourhood peak, so attacks and decays aren't shaved off.
    gain.fill(0);
    const peak = holdBuf; peak.fill(0);
    let count = 0;
    for (let d = -tHalf; d <= tHalf; d++) {
      const v = u + d;
      if (v < 0 || v >= F) continue;
      const m = ringMask[v % R];
      for (let k = 0; k < bins; k++) { gain[k] += m[k]; if (m[k] > peak[k]) peak[k] = m[k]; }
      count++;
    }
    const own = ringMask[u % R];
    for (let k = 0; k < bins; k++) {
      const m = Math.max(gain[k] / count, own[k], 0.5 * peak[k]);
      gain[k] = floorGain + (1 - floorGain) * m;
    }

    const sRe = ringRe[u % R], sIm = ringIm[u % R];
    const s0 = frameStart(u);
    for (let p = 0; p < pairs; p++) {
      const ca = 2 * p, cb = 2 * p + 1 < nch ? 2 * p + 1 : -1;
      // Repack two real spectra into one complex spectrum: Z = A + iB (full N, Hermitian halves)
      for (let k = 0; k < bins; k++) {
        const g = gain[k];
        const ar = sRe[ca][k] * g, ai = sIm[ca][k] * g;
        const br = cb >= 0 ? sRe[cb][k] * g : 0, bi = cb >= 0 ? sIm[cb][k] * g : 0;
        ore[k] = ar - bi; oim[k] = ai + br;
        if (k > 0 && k < N / 2) { ore[N - k] = ar + bi; oim[N - k] = -ai + br; }
      }
      fft(ore, oim, true);
      const oa = out[ca], ob = cb >= 0 ? out[cb] : null;
      const scale = 1 / (N * olaNorm);
      for (let i = 0; i < N; i++) {
        const k = s0 + i;
        if (k < 0 || k >= len) continue;
        oa[k] += ore[i] * win[i] * scale;
        if (ob) ob[k] += oim[i] * win[i] * scale;
      }
    }
    if (onProgress && u % 256 === 0) onProgress(u / F);
  }
  return out;
}
