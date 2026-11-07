// The clip-making chain, shared by the background worker and the tests.
import * as dsp from './dsp.js';
import { denoise, DENOISE_LEVELS } from './denoise.js';

/** What "auto" means for each type of recording. */
export function resolveAuto(o, type) {
  const denoiseLevel = o.denoise !== 'auto' ? o.denoise
    : ({ voice: 'medium', field: 'light', tonal: 'light', ir: 'off', other: 'light' }[type] || 'light');
  const normalize = o.normalize !== 'auto' ? o.normalize
    : ({ voice: 'loudness', ir: 'peak' }[type] || 'peak');
  return { denoiseLevel, normalize };
}

/**
 * @param {Float32Array[]} data  original channels (not modified)
 * @param {number} sr
 * @param {object} o  options: channels, cutSlate, slateEnd, trim, highpass, denoise, normalize, fadeIn, fadeOut, format
 * @param {string} type
 */
export function processClip(data, sr, o, type, onProgress = () => {}) {
  const { denoiseLevel, normalize } = resolveAuto(o, type);
  let chans;
  if (o.channels === 'mono') chans = [dsp.mono(data)];
  else if (String(o.channels).startsWith('t')) chans = [data[Number(String(o.channels).slice(1))]];
  else chans = data;

  const startFrame = o.cutSlate ? Math.round(o.slateEnd * sr) : 0;
  chans = dsp.cut(chans, startFrame, chans[0].length); // copies — originals untouched
  const floorBefore = dsp.noiseFloorDb(chans, sr);

  if (o.highpass) dsp.highpass(chans, sr, Number(o.highpass));
  const red = DENOISE_LEVELS[denoiseLevel] || 0;
  if (red) chans = denoise(chans, sr, { reductionDb: red, onProgress: (f) => onProgress(0.1 + f * 0.8) });
  onProgress(0.9);
  // Trim after cleanup so the quieter floor makes the edges easier to find.
  if (o.trim) {
    const b = dsp.findSoundBounds(chans, sr);
    chans = dsp.cut(chans, b.start, b.end);
  }
  const floorCleaned = dsp.noiseFloorDb(chans, sr);
  let gainDb = 0;
  if (normalize === 'peak') gainDb = dsp.normalizePeak(chans, -1);
  else if (normalize === 'loudness') gainDb = dsp.normalizeLoudness(chans, sr, -18, -1);
  else if (dsp.peakDb(chans) > 0 && o.format !== 'float') gainDb = dsp.normalizePeak(chans, -0.1); // never clip a 24-bit file
  dsp.fade(chans, sr, Number(o.fadeIn) || 0, Number(o.fadeOut) || 0);

  return {
    chans, startFrame, denoiseLevel, normalize,
    floorBefore, floorCleaned, gainDb, floorAfter: dsp.noiseFloorDb(chans, sr),
    lufs: dsp.integratedLoudness(chans, sr), peak: dsp.peakDb(chans),
  };
}
