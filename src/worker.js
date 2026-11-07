// Sound Library — Cloudflare Worker API.
// Static UI is served from ./public by the assets binding; everything under /api/* lands here.

const KEY_PREFIXES = ['originals/', 'clips/', 'meta/'];
const SINGLE_PUT_LIMIT = 95 * 1024 * 1024; // bigger bodies must use multipart

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    const auth = await authorize(request, env);
    if (!auth.ok) return json({ error: auth.error }, 401);

    try {
      return await route(request, env, url);
    } catch (err) {
      console.error(err);
      return json({ error: String(err && err.message || err) }, 500);
    }
  },
};

async function route(request, env, url) {
  const p = url.pathname;
  const m = request.method;

  if (p === '/api/health') return json({ ok: true });

  // ---------- AI ----------
  if (p === '/api/transcribe' && m === 'POST') return transcribe(request, env);
  if (p === '/api/describe' && m === 'POST') return describe(request, env);

  // ---------- uploads ----------
  if (p === '/api/put' && m === 'PUT') {
    const key = checkKey(url.searchParams.get('key'));
    const len = Number(request.headers.get('content-length') || 0);
    if (len > SINGLE_PUT_LIMIT) return json({ error: 'too large for single put; use multipart' }, 413);
    const obj = await env.BUCKET.put(key, request.body, {
      httpMetadata: { contentType: request.headers.get('content-type') || 'application/octet-stream' },
    });
    return json({ key, size: obj.size, etag: obj.etag });
  }
  if (p === '/api/upload/start' && m === 'POST') {
    const { key, contentType } = await request.json();
    const up = await env.BUCKET.createMultipartUpload(checkKey(key), {
      httpMetadata: { contentType: contentType || 'application/octet-stream' },
    });
    return json({ key: up.key, uploadId: up.uploadId });
  }
  if (p === '/api/upload/part' && m === 'PUT') {
    const key = checkKey(url.searchParams.get('key'));
    const uploadId = url.searchParams.get('uploadId');
    const n = Number(url.searchParams.get('n'));
    const up = env.BUCKET.resumeMultipartUpload(key, uploadId);
    const part = await up.uploadPart(n, request.body);
    return json(part);
  }
  if (p === '/api/upload/finish' && m === 'POST') {
    const { key, uploadId, parts } = await request.json();
    const up = env.BUCKET.resumeMultipartUpload(checkKey(key), uploadId);
    const obj = await up.complete(parts);
    return json({ key: obj.key, size: obj.size });
  }
  if (p === '/api/upload/abort' && m === 'POST') {
    const { key, uploadId } = await request.json();
    await env.BUCKET.resumeMultipartUpload(checkKey(key), uploadId).abort();
    return json({ ok: true });
  }

  // ---------- files ----------
  if (p === '/api/file' && (m === 'GET' || m === 'HEAD')) return serveFile(request, env, url);

  // ---------- catalog ----------
  if (p === '/api/items' && m === 'GET') return search(env, url);
  if (p === '/api/items' && m === 'POST') return createItem(request, env);
  if (p === '/api/items/exists' && m === 'GET') {
    const sha = url.searchParams.get('sha256');
    const row = await env.DB.prepare('SELECT id, title FROM items WHERE sha256 = ?').bind(sha).first();
    return json({ exists: !!row, item: row || null });
  }
  if (p === '/api/tags' && m === 'GET') return tagCounts(env);
  if (p === '/api/near' && m === 'GET') return nearPlaces(env, url);

  const idMatch = p.match(/^\/api\/items\/([A-Za-z0-9_-]+)$/);
  if (idMatch) {
    const id = idMatch[1];
    if (m === 'GET') {
      const row = await env.DB.prepare('SELECT * FROM items WHERE id = ?').bind(id).first();
      return row ? json(row) : json({ error: 'not found' }, 404);
    }
    if (m === 'PATCH') return updateItem(request, env, id);
    if (m === 'DELETE') return deleteItem(env, id);
  }

  return json({ error: 'not found' }, 404);
}

// ======================================================================
// Auth: verify the Cloudflare Access JWT (RS256) on every API request.
// ======================================================================
let certCache = { at: 0, keys: null };

async function authorize(request, env) {
  if (env.ALLOW_UNAUTHENTICATED === 'true') return { ok: true };
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    return { ok: false, error: 'Access not configured (set ACCESS_TEAM_DOMAIN and ACCESS_AUD)' };
  }
  const token = request.headers.get('cf-access-jwt-assertion') || cookie(request, 'CF_Authorization');
  if (!token) return { ok: false, error: 'missing Access token' };
  try {
    const [h, pl, sig] = token.split('.');
    const header = JSON.parse(b64urlText(h));
    const payload = JSON.parse(b64urlText(pl));
    const team = env.ACCESS_TEAM_DOMAIN.replace(/^https?:\/\//, '').replace(/\/$/, '');
    if (payload.iss !== `https://${team}`) throw new Error('bad issuer');
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(env.ACCESS_AUD)) throw new Error('bad audience');
    if (payload.exp * 1000 < Date.now()) throw new Error('expired');

    if (!certCache.keys || Date.now() - certCache.at > 3600_000) {
      const r = await fetch(`https://${team}/cdn-cgi/access/certs`);
      certCache = { at: Date.now(), keys: (await r.json()).keys };
    }
    const jwk = certCache.keys.find((k) => k.kid === header.kid);
    if (!jwk) throw new Error('unknown key');
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(sig), new TextEncoder().encode(`${h}.${pl}`));
    if (!valid) throw new Error('bad signature');
    return { ok: true, email: payload.email };
  } catch (e) {
    return { ok: false, error: `Access token rejected: ${e.message}` };
  }
}

function cookie(request, name) {
  const c = request.headers.get('cookie') || '';
  const m = c.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}
function b64urlBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64urlText(s) { return new TextDecoder().decode(b64urlBytes(s)); }

// ======================================================================
// AI
// ======================================================================
async function transcribe(request, env) {
  // Body: a small 16 kHz mono WAV (≤ ~30 s) made in the browser.
  const buf = new Uint8Array(await request.arrayBuffer());
  if (buf.length > 4 * 1024 * 1024) return json({ error: 'chunk too large' }, 413);
  if (env.DEV_FAKE_AI === 'true') return json(fakeTranscript(buf));
  if (!env.AI) return json({ text: '', segments: [], error: 'AI binding unavailable' });
  try {
    const res = await env.AI.run(env.WHISPER_MODEL || '@cf/openai/whisper-large-v3-turbo', {
      audio: bytesToBase64(buf),
      vad_filter: true,
    });
    const segments = (res.segments || []).map((s) => ({
      start: +s.start || 0, end: +s.end || 0, text: String(s.text || '').trim(),
    })).filter((s) => s.text);
    return json({ text: String(res.text || '').trim(), segments });
  } catch (e) {
    return json({ text: '', segments: [], error: `transcription failed: ${e.message}` });
  }
}

async function describe(request, env) {
  // Turns a spoken slate (plus file context) into tidy metadata.
  const { slate, filename, notes, type } = await request.json();
  if (env.DEV_FAKE_AI === 'true' && slate) {
    const parts = slate.split(/[,.]/).map((x) => x.trim()).filter(Boolean);
    return json({ result: { title: parts[0].toLowerCase(), tags: parts.slice(1, 4).map((x) => x.toLowerCase()), description: `Recording of ${slate}`, location: '', people: [], gear: '' } });
  }
  if (!env.AI || !slate) return json({ error: 'nothing to describe' });
  const prompt = `You catalog field recordings for an electronic musician's sample library.
The recordist spoke a short "slate" at the start of the recording describing it.
Return ONLY a JSON object with keys:
 "title": 2-6 word lowercase title naming the sound source (no dates, no mic names),
 "tags": array of 3-8 short lowercase tags (sound source, texture, environment, mood),
 "description": one plain sentence describing the sound,
 "location": place name if the slate mentions one, else "",
 "people": array of names of people speaking/singing if mentioned, else [],
 "gear": microphone or recorder if mentioned, else "".
Slate: ${JSON.stringify(slate)}
Filename: ${JSON.stringify(filename || '')}
Recorder notes: ${JSON.stringify(notes || '')}
Guessed type: ${JSON.stringify(type || '')}`;
  try {
    const res = await env.AI.run(env.LLM_MODEL || '@cf/meta/llama-3.1-8b-instruct', {
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 300,
      temperature: 0.2,
    });
    const text = typeof res.response === 'string' ? res.response : JSON.stringify(res.response || '');
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return json({ error: 'no json in model output' });
    return json({ result: JSON.parse(m[0]) });
  } catch (e) {
    return json({ error: `describe failed: ${e.message}` });
  }
}

// Local development only (no Workers AI): a canned slate when the audio starts with sound.
function fakeTranscript(buf) {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const n = Math.floor((buf.length - 44) / 2);
  let loud = 0;
  for (let i = 0; i < Math.min(n, 16000 * 3); i++) loud = Math.max(loud, Math.abs(v.getInt16(44 + i * 2, true)));
  if (loud < 3000 || n < 16000 * 6) return { text: '', segments: [] };
  return {
    text: 'Railyard, freight brakes, cold morning. Location scorpion cotton sea point.',
    segments: [
      { start: 0.2, end: 2.6, text: 'Railyard, freight brakes, cold morning.' },
      { start: 2.8, end: 5.1, text: 'Location scorpion cotton sea point.' },
    ],
  };
}

function bytesToBase64(bytes) {
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(bin);
}

// ======================================================================
// Files
// ======================================================================
async function serveFile(request, env, url) {
  const key = checkKey(url.searchParams.get('key'));
  const rangeHeader = request.headers.get('range');
  let range;
  if (rangeHeader) {
    const m = rangeHeader.match(/bytes=(\d*)-(\d*)/);
    if (m) {
      if (m[1] === '' && m[2] !== '') range = { suffix: Number(m[2]) };
      else range = { offset: Number(m[1]), ...(m[2] !== '' ? { length: Number(m[2]) - Number(m[1]) + 1 } : {}) };
    }
  }
  const obj = request.method === 'HEAD'
    ? await env.BUCKET.head(key)
    : await env.BUCKET.get(key, range ? { range } : undefined);
  if (!obj) return json({ error: 'not found' }, 404);

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  headers.set('accept-ranges', 'bytes');
  headers.set('cache-control', 'private, max-age=3600');
  const name = url.searchParams.get('name');
  if (url.searchParams.get('dl')) {
    const fname = (name || key.split('/').pop()).replace(/["\\\r\n]/g, '');
    headers.set('content-disposition', `attachment; filename="${fname}"`);
  }
  if (request.method === 'HEAD' || !obj.body) {
    headers.set('content-length', String(obj.size));
    return new Response(null, { headers });
  }
  if (range && obj.range) {
    const start = obj.range.offset ?? (obj.size - obj.range.suffix);
    const len = obj.range.length ?? (obj.size - start);
    headers.set('content-range', `bytes ${start}-${start + len - 1}/${obj.size}`);
    headers.set('content-length', String(len));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set('content-length', String(obj.size));
  return new Response(obj.body, { headers });
}

function checkKey(key) {
  if (!key || key.includes('..') || key.startsWith('/') || !KEY_PREFIXES.some((p) => key.startsWith(p))) {
    throw new Error(`invalid key: ${key}`);
  }
  return key;
}

// ======================================================================
// Catalog
// ======================================================================
const FIELDS = [
  'id', 'created_at', 'recorded_at', 'title', 'type', 'tags', 'description', 'location', 'lat', 'lon', 'location_words', 'people',
  'release_status', 'notes', 'slate', 'transcript', 'transcript_json', 'filename', 'clip_key',
  'original_key', 'original_name', 'sha256', 'sample_rate', 'channels', 'bit_depth', 'duration',
  'original_duration', 'peak_db', 'lufs', 'noise_floor_db', 'processing', 'source_meta', 'peaks',
  'clip_size', 'original_size',
];
const EDITABLE = ['recorded_at', 'title', 'type', 'tags', 'description', 'location', 'lat', 'lon', 'location_words', 'people', 'release_status', 'notes'];
const LIST_COLS = FIELDS.filter((f) => f !== 'transcript_json' && f !== 'transcript');

async function createItem(request, env) {
  const item = await request.json();
  item.id = item.id || crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  item.created_at = new Date().toISOString();
  for (const k of ['processing', 'source_meta', 'transcript_json']) {
    if (item[k] && typeof item[k] !== 'string') item[k] = JSON.stringify(item[k]);
  }
  item.tags = normList(item.tags);
  item.people = normList(item.people, false);
  const cols = FIELDS.filter((f) => item[f] !== undefined);
  const sql = `INSERT INTO items (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
  await env.DB.prepare(sql).bind(...cols.map((c) => item[c])).run();
  return json({ id: item.id });
}

async function updateItem(request, env, id) {
  const body = await request.json();
  const cols = EDITABLE.filter((f) => body[f] !== undefined);
  if (!cols.length) return json({ error: 'nothing to update' }, 400);
  if (body.tags !== undefined) body.tags = normList(body.tags);
  if (body.people !== undefined) body.people = normList(body.people, false);
  await env.DB.prepare(`UPDATE items SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
    .bind(...cols.map((c) => body[c]), id).run();
  // Keep the sidecar JSON in R2 in step with the catalog.
  const row = await env.DB.prepare('SELECT * FROM items WHERE id = ?').bind(id).first();
  if (row) await env.BUCKET.put(`meta/${id}.json`, JSON.stringify(sidecar(row), null, 2), { httpMetadata: { contentType: 'application/json' } });
  return json(row);
}

async function deleteItem(env, id) {
  const row = await env.DB.prepare('SELECT clip_key, original_key FROM items WHERE id = ?').bind(id).first();
  if (!row) return json({ error: 'not found' }, 404);
  await env.BUCKET.delete([row.clip_key, row.original_key, `meta/${id}.json`]);
  await env.DB.prepare('DELETE FROM items WHERE id = ?').bind(id).run();
  return json({ ok: true });
}

function sidecar(row) {
  const out = { ...row };
  for (const k of ['processing', 'source_meta', 'transcript_json']) {
    try { out[k] = JSON.parse(out[k] || 'null'); } catch { /* leave as string */ }
  }
  delete out.peaks;
  return out;
}

function normList(v, lower = true) {
  const arr = Array.isArray(v) ? v : String(v || '').split(',');
  const seen = new Set();
  const out = [];
  for (let s of arr) {
    s = String(s).trim();
    if (lower) s = s.toLowerCase();
    if (s && !seen.has(s)) { seen.add(s); out.push(s); }
  }
  return out.join(', ');
}

async function search(env, url) {
  const q = (url.searchParams.get('q') || '').trim();
  const type = url.searchParams.get('type') || '';
  const tag = (url.searchParams.get('tag') || '').toLowerCase();
  const sort = url.searchParams.get('sort') || 'recent';
  const limit = Math.min(Number(url.searchParams.get('limit') || 100), 500);
  const offset = Number(url.searchParams.get('offset') || 0);

  const where = [];
  const binds = [];
  let from = 'items i';
  let select = LIST_COLS.map((c) => `i.${c}`).join(', ');
  let order = {
    recent: 'i.created_at DESC',
    recorded: 'i.recorded_at DESC, i.created_at DESC',
    title: 'i.title COLLATE NOCASE ASC',
    longest: 'i.duration DESC',
    shortest: 'i.duration ASC',
  }[sort] || 'i.created_at DESC';

  if (q) {
    const match = ftsQuery(q);
    if (match) {
      from = 'items_fts f JOIN items i ON i.rowid = f.rowid';
      where.push('items_fts MATCH ?');
      binds.push(match);
      select += `, snippet(items_fts, 7, '[', ']', '…', 12) AS transcript_hit`;
      if (sort === 'recent') order = 'bm25(items_fts, 8.0, 5.0, 3.0, 2.0, 2.0, 1.0, 2.0, 1.0, 1.0)';
    }
  }
  if (type) { where.push('i.type = ?'); binds.push(type); }
  if (tag) { where.push(`(', ' || i.tags || ', ') LIKE ?`); binds.push(`%, ${tag}, %`); }

  const sql = `SELECT ${select} FROM ${from} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT ? OFFSET ?`;
  const { results } = await env.DB.prepare(sql).bind(...binds, limit, offset).all();
  const countSql = `SELECT COUNT(*) AS n FROM ${from} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;
  const total = (await env.DB.prepare(countSql).bind(...binds).first()).n;
  // Only keep transcript snippets that actually contain a hit.
  for (const r of results) if (r.transcript_hit !== undefined && !String(r.transcript_hit).includes('[')) r.transcript_hit = '';
  return json({ total, items: results });
}

// Turn free text into a safe FTS5 query: every word must match (prefix match on the last one).
function ftsQuery(q) {
  const words = q.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  if (!words.length) return '';
  return words.map((w, i) => `"${w}"${i === words.length - 1 ? '*' : ''}`).join(' ');
}

async function tagCounts(env) {
  const { results } = await env.DB.prepare(`SELECT tags FROM items WHERE tags != ''`).all();
  const counts = {};
  for (const r of results) for (const t of r.tags.split(',')) {
    const k = t.trim();
    if (k) counts[k] = (counts[k] || 0) + 1;
  }
  return json(Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([tag, n]) => ({ tag, n })));
}

// Place names already used near a point, closest first — so a decoded location
// can be named without sending coordinates to any outside geocoder.
async function nearPlaces(env, url) {
  const lat = Number(url.searchParams.get('lat')), lon = Number(url.searchParams.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return json({ error: 'lat/lon required' }, 400);
  const d = 0.05; // ~5 km box
  const { results } = await env.DB.prepare(
    `SELECT location, lat, lon FROM items WHERE location != '' AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?`,
  ).bind(lat - d, lat + d, lon - d / Math.max(0.2, Math.cos(lat * Math.PI / 180)), lon + d / Math.max(0.2, Math.cos(lat * Math.PI / 180))).all();
  const best = {};
  for (const r of results) {
    const m = haversine(lat, lon, r.lat, r.lon);
    if (!(r.location in best) || m < best[r.location]) best[r.location] = m;
  }
  return json(Object.entries(best).sort((a, b) => a[1] - b[1]).slice(0, 5).map(([location, m]) => ({ location, meters: Math.round(m) })));
}

function haversine(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const h = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}
