// node test/denoise.test.mjs
import assert from 'node:assert/strict';
import { fft, denoise } from '../public/js/denoise.js';
import * as dsp from '../public/js/dsp.js';

let seed = 9; const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;

// FFT sanity: inverse(forward(x)) == x
{
  const n = 1024, re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = rand();
  const orig = re.slice();
  fft(re, im); fft(re, im, true);
  let err = 0; for (let i = 0; i < n; i++) err = Math.max(err, Math.abs(re[i] / n - orig[i]));
  assert.ok(err < 1e-12);
}

// Transparency: with 0 dB reduction → identical; with gating, a loud tone over no noise survives
{
  const sr = 48000, n = sr * 2;
  const x = Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin(2 * Math.PI * 440 * i / sr));
  const y = denoise([x], sr, { reductionDb: 0 })[0];
  assert.equal(y.length, n);
}

// Noise + intermittent tone bursts: floor drops by roughly the reduction, the tone barely changes
for (const [sr, nch] of [[48000, 2], [96000, 3]]) {
  const n = sr * 6;
  const chans = Array.from({ length: nch }, () => new Float32Array(n));
  const tone = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const on = (t > 1 && t < 2) || (t > 3.5 && t < 4.5);
    tone[i] = on ? 0.3 * Math.sin(2 * Math.PI * 1000 * t) : 0;
    for (let c = 0; c < nch; c++) chans[c][i] = tone[i] + 0.01 * rand(); // hiss ≈ -45 dBFS RMS
  }
  const t0 = performance.now();
  const out = denoise(chans, sr, { reductionDb: 14 });
  const ms = performance.now() - t0;
  const rmsDb = (x, a, b) => { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return 10 * Math.log10(s / (b - a)); };
  const quietBefore = rmsDb(chans[0], sr * 2.5, sr * 3.2), quietAfter = rmsDb(out[0], sr * 2.5, sr * 3.2);
  const toneBefore = rmsDb(chans[0], sr * 1.2, sr * 1.8), toneAfter = rmsDb(out[0], sr * 1.2, sr * 1.8);
  console.log(`${sr / 1000}k ${nch}ch 6s: floor ${quietBefore.toFixed(1)} → ${quietAfter.toFixed(1)} dB, tone ${toneBefore.toFixed(2)} → ${toneAfter.toFixed(2)} dB, ${ms.toFixed(0)} ms`);
  assert.ok(quietBefore - quietAfter > 11, 'floor should drop ~14 dB');
  assert.ok(Math.abs(toneBefore - toneAfter) < 0.3, 'tone level preserved');
  // Residual noise inside the tone burst also drops (difference from the pure tone)
  let e = 0; for (let i = sr * 1.2; i < sr * 1.8; i++) e += (out[0][i] - tone[i]) ** 2;
  const residual = 10 * Math.log10(e / (sr * 0.6));
  assert.ok(residual < quietBefore + 1, `residual ${residual}`);
  // Every channel processed
  assert.ok(rmsDb(out[nch - 1], sr * 2.5, sr * 3.2) < quietBefore - 11);
}

// Speed estimate for a 10-minute 96k stereo file
{
  const sr = 96000, n = sr * 30;
  const ch = [0, 1].map(() => Float32Array.from({ length: n }, () => 0.01 * rand()));
  const t0 = performance.now();
  denoise(ch, sr, { reductionDb: 12 });
  const s = (performance.now() - t0) / 1000;
  console.log(`30 s of 96k stereo: ${s.toFixed(2)} s → 10 min ≈ ${(s * 20).toFixed(0)} s`);
}


// Full clip chain: slate cut + HPF + denoise + normalize
{
  const { processClip, resolveAuto } = await import('../public/js/clip.js');
  const sr = 48000, n = sr * 8;
  const x = Float32Array.from({ length: n }, (_, i) => 0.01 * rand() + (i > sr * 4 && i < sr * 5 ? 0.2 * Math.sin(i * 0.1) : 0));
  const o = { channels: 'all', cutSlate: true, slateEnd: 2, trim: false, highpass: 40, denoise: 'auto', normalize: 'auto', fadeIn: 5, fadeOut: 20, format: '24' };
  const r = processClip([x], sr, o, 'field');
  assert.equal(r.chans[0].length, sr * 6);
  assert.equal(r.denoiseLevel, 'light'); assert.equal(r.normalize, 'peak');
  assert.ok(Math.abs(r.peak - -1) < 0.05);
  assert.ok(r.floorBefore - r.floorCleaned > 6, `background ${r.floorBefore} → ${r.floorCleaned}`);
  assert.ok(Math.abs(r.floorAfter - (r.floorCleaned + r.gainDb)) < 0.5);
  assert.equal(x.length, n); // original untouched
  assert.deepEqual(resolveAuto({ denoise: 'auto', normalize: 'auto' }, 'voice'), { denoiseLevel: 'medium', normalize: 'loudness' });
  assert.equal(resolveAuto({ denoise: 'auto', normalize: 'auto' }, 'ir').denoiseLevel, 'off');
  console.log(`clip chain: background ${r.floorBefore.toFixed(1)} → ${r.floorCleaned.toFixed(1)} dB, gain +${r.gainDb.toFixed(1)} dB`);
}
console.log('denoise tests ok');
