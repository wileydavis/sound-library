// Runs the clip chain off the main thread so the page stays responsive.
import { processClip } from './clip.js';
import { encodeWav } from './wav.js';
import { waveformPeaks } from './dsp.js';

self.onmessage = (e) => {
  const { id, channels, sr, options, type, bext, info } = e.data;
  try {
    let last = 0;
    const r = processClip(channels, sr, options, type, (f) => {
      if (f - last > 0.02) { last = f; self.postMessage({ id, progress: f }); }
    });
    const buf = encodeWav(r.chans, sr, {
      float: options.format === 'float', bitDepth: 24,
      bext: { ...bext, timeReference: (bext.timeReference || 0) + r.startFrame, loudness: r.lufs, truePeak: r.peak },
      info,
    });
    self.postMessage({
      id, done: true, buf,
      peaks: waveformPeaks(r.chans, 600),
      frames: r.chans[0].length, nch: r.chans.length, startFrame: r.startFrame,
      lufs: r.lufs, peak: r.peak, floorBefore: r.floorBefore, floorCleaned: r.floorCleaned, gainDb: r.gainDb, floorAfter: r.floorAfter,
      denoiseLevel: r.denoiseLevel, normalize: r.normalize,
    }, [buf]);
  } catch (err) {
    self.postMessage({ id, error: err.message || String(err) });
  }
};
