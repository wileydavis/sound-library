import assert from 'node:assert/strict';
import { parseSlate, stripLocation, heuristicMeta, guessType, recordedDate } from '../public/js/slate.js';
import { encodeLocation } from '../public/js/geowords.js';

const w = encodeLocation(45.857612, -111.330421);
// Slate, pause, then ambience only
let s = parseSlate([
  { start: 0.4, end: 3.1, text: 'Railyard, freight brakes, cold morning.' },
  { start: 3.3, end: 6.0, text: `416 on the boom. Location ${w.join(' ')}.` },
], 30);
assert.ok(s.looksLikeSlate); assert.ok(Math.abs(s.end - 6.35) < 0.01);
assert.deepEqual(s.location.words, w);
assert.equal(guessType({ filename: 'TAKE_003.WAV', slate: s }), 'field');
assert.equal(stripLocation(s.text), 'Railyard, freight brakes, cold morning. 416 on the boom.');
const h = heuristicMeta(s.text);
assert.equal(h.title, 'railyard');
assert.ok(h.tags.includes('freight brakes'));

// Slate then interview
s = parseSlate([
  { start: 0.5, end: 3, text: 'Interview with June at the bar.' },
  { start: 6, end: 12, text: 'So I grew up out past the levee, and my daddy used to sing every morning' },
  { start: 12.2, end: 20, text: 'when the boats came in, all of them old songs nobody remembers now.' },
], 30);
assert.ok(s.looksLikeSlate); assert.equal(guessType({ slate: s }), 'voice');

// Someone talking from the first second, no slate pause
s = parseSlate(Array.from({ length: 8 }, (_, i) => ({ start: i * 3.5, end: i * 3.5 + 3.3, text: 'and then we walked down to the water and sat a while' })), 30);
assert.equal(s.looksLikeSlate, false);
assert.equal(guessType({ slate: s }), 'voice');

assert.equal(guessType({ filename: 'church_sweep_ir.wav' }), 'ir');
assert.equal(parseSlate([], 30), null);
assert.equal(recordedDate({ originationDate: '2026-11-07', originationTime: '08:12:30' }), '2026-11-07T08:12:30');
assert.equal(recordedDate({ originationDate: '2026:11:07', originationTime: '08-12-30' }), '2026-11-07T08:12:30');
assert.match(recordedDate({}, Date.UTC(2026, 0, 2)), /^2026-01-0[12]T/);
console.log('slate tests ok');
