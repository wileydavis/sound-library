// Turning a transcribed head-of-file into slate info and metadata guesses. Pure functions.
import { findLocationInText } from './geowords.js';

const countWords = (s) => (String(s).match(/[\p{L}\p{N}']+/gu) || []).length;

/**
 * segments: [{start, end, text}] from the first ~30 s of a recording.
 * A slate is speech that starts near the top and is followed by a pause.
 */
export function parseSlate(segments, headDur) {
  const segs = (segments || []).filter((s) => s.text && s.text.trim()).sort((a, b) => a.start - b.start);
  if (!segs.length || segs[0].start > 8) return null;
  const taken = [segs[0]];
  let endedByPause = false;
  for (let i = 1; i < segs.length; i++) {
    const s = segs[i], last = taken[taken.length - 1];
    if (s.start - last.end > 1.5) { endedByPause = true; break; }
    if (s.start > 25) break;
    taken.push(s);
  }
  if (taken.length === segs.length) endedByPause = taken[taken.length - 1].end < headDur - 1.5;
  const text = taken.map((s) => s.text.trim()).join(' ').replace(/\s+/g, ' ');
  const after = segs.slice(taken.length);
  const wordsAfter = after.reduce((a, s) => a + countWords(s.text), 0);
  const words = countWords(text);
  const location = findLocationInText(text);
  return {
    text,
    start: taken[0].start,
    end: Math.min(headDur, taken[taken.length - 1].end + 0.35),
    words,
    wordsAfter,
    location,
    // Cut it from the clip only when it really looks like a slate.
    looksLikeSlate: words <= 45 && (endedByPause || !!location),
  };
}

/** Remove "location w1 w2 w3 w4" from slate text before describing it. */
export function stripLocation(text) {
  return String(text || '').replace(/\b(location|locations|locate|located)\b[\s,:.-]*(?:is\s+)?(?:[\p{L}']+[\s,.]*){0,4}/giu, ' ').replace(/\s+/g, ' ').trim();
}

/** Metadata guess straight from slate phrases, used if the AI describe step is unavailable. */
export function heuristicMeta(slateText) {
  const phrases = stripLocation(slateText).split(/[,.;:!?]|\band\b/i).map((p) => p.trim()).filter(Boolean);
  if (!phrases.length) return {};
  const title = phrases[0].split(/\s+/).slice(0, 6).join(' ').toLowerCase();
  const tags = phrases.filter((p) => p.split(/\s+/).length <= 3).map((p) => p.toLowerCase());
  return { title, tags, description: stripLocation(slateText) };
}

export function guessType({ filename = '', slate = null, headWords = 0 }) {
  if (/(^|[^a-z])(ir|sweep|impulse)([^a-z]|$)/i.test(filename)) return 'ir';
  if (slate && slate.wordsAfter > 8) return 'voice';
  if (!slate && headWords > 20) return 'voice';
  if (slate && !slate.looksLikeSlate && slate.words > 20) return 'voice';
  return 'field';
}

/** MixPre writes bext dates as YYYY-MM-DD (some recorders use : or /). */
export function recordedDate(bext, lastModified) {
  const d = (bext && bext.originationDate || '').replace(/[:/.]/g, '-');
  if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d !== '0000-00-00') {
    const t = (bext.originationTime || '').replace(/[-.]/g, ':');
    return /^\d{2}:\d{2}(:\d{2})?$/.test(t) ? `${d}T${t.length === 5 ? t + ':00' : t}` : d;
  }
  const dt = new Date(lastModified || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`;
}
