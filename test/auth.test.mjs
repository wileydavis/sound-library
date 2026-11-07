// Checks the Access JWT gate: node test/auth.test.mjs
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

const team = 'example.cloudflareaccess.com', aud = 'aud-123';
const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', publicKey)), kid: 'k1' };
globalThis.fetch = async (u) => { assert.equal(String(u), `https://${team}/cdn-cgi/access/certs`); return new Response(JSON.stringify({ keys: [jwk] })); };
const b64u = (b) => Buffer.from(b).toString('base64url');
async function token(payload, key = privateKey) {
  const h = b64u(JSON.stringify({ alg: 'RS256', kid: 'k1' })), p = b64u(JSON.stringify(payload));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64u(new Uint8Array(sig))}`;
}
const env = { ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: aud, ASSETS: { fetch: () => new Response('asset') } };
const call = (hdrs, e = env) => worker.fetch(new Request('https://x/api/health', { headers: hdrs }), e);
const good = { iss: `https://${team}`, aud: [aud], exp: Date.now() / 1000 + 600, email: 'me@example.com' };

assert.equal((await call({})).status, 401);
assert.equal((await call({ 'cf-access-jwt-assertion': await token(good) })).status, 200);
assert.equal((await call({ cookie: `CF_Authorization=${await token(good)}` })).status, 200);
assert.equal((await call({ 'cf-access-jwt-assertion': await token({ ...good, aud: ['other'] }) })).status, 401);
assert.equal((await call({ 'cf-access-jwt-assertion': await token({ ...good, exp: 1 }) })).status, 401);
const other = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign']);
assert.equal((await call({ 'cf-access-jwt-assertion': await token(good, other.privateKey) })).status, 401);
assert.equal((await call({}, { ...env, ACCESS_AUD: '' })).status, 401); // unconfigured = locked
assert.equal(await (await worker.fetch(new Request('https://x/'), env)).text(), 'asset');
console.log('auth tests ok');
