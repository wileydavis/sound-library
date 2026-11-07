// WAV / Broadcast WAV reading and writing.
// Handles what a Sound Devices MixPre writes: 16/24-bit PCM and 32-bit float, mono or
// polyphonic, any sample rate, with bext and iXML chunks (and RF64 for very large files).

const FMT_PCM = 1;
const FMT_FLOAT = 3;
const FMT_EXT = 0xfffe;

function str(view, off, len) {
  let end = off;
  while (end < off + len && end < view.byteLength && view.getUint8(end) !== 0) end++;
  const bytes = new Uint8Array(view.buffer, view.byteOffset + off, end - off);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return new TextDecoder('latin1').decode(bytes); }
}

/** Parse a WAV file. Returns null if it isn't a WAV this parser understands. */
export function parseWav(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  if (view.byteLength < 12) return null;
  const riff = str(view, 0, 4);
  if ((riff !== 'RIFF' && riff !== 'RF64' && riff !== 'BW64') || str(view, 8, 4) !== 'WAVE') return null;

  let fmt = null;
  let dataOff = -1;
  let dataLen = 0;
  let ds64DataSize = null;
  const bext = {};
  let ixml = '';
  const info = {};

  let off = 12;
  while (off + 8 <= view.byteLength) {
    const id = str(view, off, 4);
    let size = view.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'ds64') {
      ds64DataSize = view.getUint32(body + 8, true) + view.getUint32(body + 12, true) * 2 ** 32;
    } else if (id === 'fmt ') {
      let format = view.getUint16(body, true);
      const channels = view.getUint16(body + 2, true);
      const sampleRate = view.getUint32(body + 4, true);
      const bitDepth = view.getUint16(body + 14, true);
      if (format === FMT_EXT && size >= 26) format = view.getUint16(body + 24, true); // SubFormat GUID's first 2 bytes
      fmt = { format, channels, sampleRate, bitDepth };
    } else if (id === 'data') {
      dataOff = body;
      if (size === 0xffffffff && ds64DataSize != null) size = ds64DataSize;
      dataLen = Math.min(size, view.byteLength - body);
      size = dataLen;
    } else if (id === 'bext' && size >= 346) {
      bext.description = str(view, body, 256).trim();
      bext.originator = str(view, body + 256, 32).trim();
      bext.originatorReference = str(view, body + 288, 32).trim();
      bext.originationDate = str(view, body + 320, 10).trim();
      bext.originationTime = str(view, body + 330, 8).trim();
      bext.timeReference = view.getUint32(body + 338, true) + view.getUint32(body + 342, true) * 2 ** 32;
    } else if (id === 'iXML') {
      ixml = new TextDecoder().decode(new Uint8Array(arrayBuffer, body, Math.min(size, view.byteLength - body)));
    } else if (id === 'LIST' && str(view, body, 4) === 'INFO') {
      let p = body + 4;
      while (p + 8 <= body + size) {
        const sid = str(view, p, 4);
        const ssz = view.getUint32(p + 4, true);
        info[sid] = str(view, p + 8, ssz).trim();
        p += 8 + ssz + (ssz & 1);
      }
    }
    off = body + size + (size & 1);
  }
  if (!fmt || dataOff < 0) return null;
  const { format, channels, sampleRate, bitDepth } = fmt;
  const okFormat = (format === FMT_PCM && [8, 16, 24, 32].includes(bitDepth)) || (format === FMT_FLOAT && [32, 64].includes(bitDepth));
  if (!okFormat || channels < 1) return null;

  const bps = bitDepth / 8;
  const frames = Math.floor(dataLen / (bps * channels));
  const data = Array.from({ length: channels }, () => new Float32Array(frames));
  const isFloat = format === FMT_FLOAT;

  // Hot loop: one branch per format, not per sample.
  if (isFloat && bitDepth === 32) {
    for (let i = 0, p = dataOff; i < frames; i++) for (let c = 0; c < channels; c++, p += 4) data[c][i] = view.getFloat32(p, true);
  } else if (isFloat) {
    for (let i = 0, p = dataOff; i < frames; i++) for (let c = 0; c < channels; c++, p += 8) data[c][i] = view.getFloat64(p, true);
  } else if (bitDepth === 24) {
    const u8 = new Uint8Array(arrayBuffer);
    for (let i = 0, p = dataOff; i < frames; i++) for (let c = 0; c < channels; c++, p += 3) {
      let v = u8[p] | (u8[p + 1] << 8) | (u8[p + 2] << 16);
      if (v & 0x800000) v |= ~0xffffff;
      data[c][i] = v / 8388608;
    }
  } else if (bitDepth === 16) {
    for (let i = 0, p = dataOff; i < frames; i++) for (let c = 0; c < channels; c++, p += 2) data[c][i] = view.getInt16(p, true) / 32768;
  } else if (bitDepth === 32) {
    for (let i = 0, p = dataOff; i < frames; i++) for (let c = 0; c < channels; c++, p += 4) data[c][i] = view.getInt32(p, true) / 2147483648;
  } else {
    for (let i = 0, p = dataOff; i < frames; i++) for (let c = 0; c < channels; c++, p += 1) data[c][i] = (view.getUint8(p) - 128) / 128;
  }

  return {
    sampleRate, channels, bitDepth, isFloat, frames,
    duration: frames / sampleRate,
    data, bext, ixml: parseIxml(ixml), info,
  };
}

/** Pull the useful fields out of an iXML chunk (MixPre writes project/scene/take/note/track names). */
export function parseIxml(xml) {
  if (!xml) return {};
  const get = (tag) => {
    const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
    return m ? decodeXml(m[1].trim()) : '';
  };
  const tracks = [];
  const tl = xml.match(/<TRACK_LIST>([\s\S]*?)<\/TRACK_LIST>/);
  if (tl) {
    for (const t of tl[1].matchAll(/<TRACK>([\s\S]*?)<\/TRACK>/g)) {
      const n = t[1].match(/<NAME>([\s\S]*?)<\/NAME>/);
      tracks.push(n ? decodeXml(n[1].trim()) : '');
    }
  }
  const out = {
    project: get('PROJECT'), scene: get('SCENE'), take: get('TAKE'), tape: get('TAPE'),
    note: get('NOTE'), tracks,
  };
  for (const k of Object.keys(out)) if (!out[k] || (Array.isArray(out[k]) && !out[k].some(Boolean))) delete out[k];
  return out;
}

function decodeXml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/**
 * Encode channels as a Broadcast WAV.
 * @param {Float32Array[]} channels
 * @param {number} sampleRate
 * @param {{bitDepth?: 16|24|32, float?: boolean, bext?: object, info?: object}} opts
 *   bitDepth 24 → 24-bit PCM (default); float: true → 32-bit float.
 */
export function encodeWav(channels, sampleRate, opts = {}) {
  const float = !!opts.float;
  const bitDepth = float ? 32 : (opts.bitDepth || 24);
  const nch = channels.length;
  const frames = channels[0].length;
  const bps = bitDepth / 8;
  const dataLen = frames * nch * bps;

  const enc = new TextEncoder();
  // bext v2 (602 bytes fixed + empty coding history)
  const bext = opts.bext || null;
  const bextLen = bext ? 602 : 0;
  // LIST/INFO
  const infoEntries = Object.entries(opts.info || {}).filter(([, v]) => v);
  const infoParts = infoEntries.map(([k, v]) => {
    const b = enc.encode(String(v).slice(0, 1000) + '\0');
    return { k, b, len: 8 + b.length + (b.length & 1) };
  });
  const infoLen = infoParts.length ? 4 + infoParts.reduce((a, p) => a + p.len, 0) : 0;

  const total = 12 + (8 + 16) + (bextLen ? 8 + bextLen : 0) + (infoLen ? 8 + infoLen : 0) + 8 + dataLen + (dataLen & 1);
  const buf = new ArrayBuffer(total);
  const v = new DataView(buf);
  const u8 = new Uint8Array(buf);
  let p = 0;
  const w4 = (s) => { for (let i = 0; i < 4; i++) v.setUint8(p++, s.charCodeAt(i)); };
  const wstr = (s, len) => { const b = enc.encode(s || ''); for (let i = 0; i < len; i++) v.setUint8(p++, i < b.length ? b[i] : 0); };

  w4('RIFF'); v.setUint32(p, total - 8, true); p += 4; w4('WAVE');

  w4('fmt '); v.setUint32(p, 16, true); p += 4;
  v.setUint16(p, float ? FMT_FLOAT : FMT_PCM, true); p += 2;
  v.setUint16(p, nch, true); p += 2;
  v.setUint32(p, sampleRate, true); p += 4;
  v.setUint32(p, sampleRate * nch * bps, true); p += 4;
  v.setUint16(p, nch * bps, true); p += 2;
  v.setUint16(p, bitDepth, true); p += 2;

  if (bextLen) {
    w4('bext'); v.setUint32(p, bextLen, true); p += 4;
    const start = p;
    wstr(bext.description, 256);
    wstr(bext.originator || 'Sound Library', 32);
    wstr(bext.originatorReference, 32);
    wstr(bext.originationDate, 10);
    wstr(bext.originationTime, 8);
    const tr = bext.timeReference || 0;
    v.setUint32(p, tr % 2 ** 32, true); p += 4;
    v.setUint32(p, Math.floor(tr / 2 ** 32), true); p += 4;
    v.setUint16(p, 2, true); p += 2; // version
    p += 64; // UMID
    const lufs = (x) => (Number.isFinite(x) ? Math.round(x * 100) : 0x7fff);
    v.setInt16(p, lufs(bext.loudness), true); p += 2;
    v.setInt16(p, 0x7fff, true); p += 2; // loudness range (unknown)
    v.setInt16(p, lufs(bext.truePeak), true); p += 2;
    v.setInt16(p, 0x7fff, true); p += 2;
    v.setInt16(p, 0x7fff, true); p += 2;
    p = start + bextLen;
  }

  if (infoLen) {
    w4('LIST'); v.setUint32(p, infoLen, true); p += 4; w4('INFO');
    for (const part of infoParts) {
      w4(part.k); v.setUint32(p, part.b.length, true); p += 4;
      u8.set(part.b, p); p += part.b.length + (part.b.length & 1);
    }
  }

  w4('data'); v.setUint32(p, dataLen, true); p += 4;
  if (float) {
    for (let i = 0; i < frames; i++) for (let c = 0; c < nch; c++, p += 4) v.setFloat32(p, channels[c][i], true);
  } else if (bitDepth === 24) {
    for (let i = 0; i < frames; i++) for (let c = 0; c < nch; c++, p += 3) {
      let s = channels[c][i];
      s = s > 1 ? 1 : s < -1 ? -1 : s;
      const x = Math.max(-8388608, Math.min(8388607, Math.round(s * 8388608)));
      u8[p] = x & 0xff; u8[p + 1] = (x >> 8) & 0xff; u8[p + 2] = (x >> 16) & 0xff;
    }
  } else {
    for (let i = 0; i < frames; i++) for (let c = 0; c < nch; c++, p += 2) {
      const s = channels[c][i];
      v.setInt16(p, Math.max(-32768, Math.min(32767, Math.round(s * 32768))), true);
    }
  }
  return buf;
}
