import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createAccessVerifier, extractAccessToken, normaliseTeamDomain, AccessError } from '../src/cf-access.js';

const TEAM = 'example.cloudflareaccess.com';
const ISSUER = `https://${TEAM}`;
const AUD = 'aud-tag-for-this-app';

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const { publicKey: otherPublic, privateKey: otherPrivate } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'kid-1', alg: 'RS256', use: 'sig' };
const otherJwk = { ...otherPublic.export({ format: 'jwk' }), kid: 'kid-other', alg: 'RS256', use: 'sig' };

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

function sign(claims, { key = privateKey, kid = 'kid-1', alg = 'RS256' } = {}) {
  const head = b64({ alg, kid, typ: 'JWT' });
  const body = b64(claims);
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`, 'ascii'), key).toString('base64url');
  return `${head}.${body}.${sig}`;
}

const NOW_MS = 1_700_000_000_000;
const nowS = Math.floor(NOW_MS / 1000);
const validClaims = () => ({ iss: ISSUER, aud: [AUD], exp: nowS + 3600, iat: nowS - 10, sub: 'u1', email: 'a@b.c' });

function makeVerifier({ keys = [jwk], onFetch } = {}) {
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    if (onFetch) onFetch(url, calls);
    return { ok: true, status: 200, json: async () => ({ keys }) };
  };
  const v = createAccessVerifier({ teamDomain: TEAM, aud: AUD, fetchImpl, now: () => NOW_MS });
  return { v, calls: () => calls };
}

test('accepts a correctly signed token', async () => {
  const { v } = makeVerifier();
  const claims = await v.verify(sign(validClaims()));
  assert.equal(claims.email, 'a@b.c');
});

test('rejects a token signed by a different key', async () => {
  const { v } = makeVerifier();
  await assert.rejects(() => v.verify(sign(validClaims(), { key: otherPrivate })), AccessError);
});

test('rejects a tampered payload', async () => {
  const { v } = makeVerifier();
  const token = sign(validClaims());
  const [h, , s] = token.split('.');
  const forged = `${h}.${b64({ ...validClaims(), email: 'attacker@evil.test' })}.${s}`;
  await assert.rejects(() => v.verify(forged), AccessError);
});

test('rejects alg:none and unsigned tokens', async () => {
  const { v } = makeVerifier();
  const head = b64({ alg: 'none', kid: 'kid-1', typ: 'JWT' });
  await assert.rejects(() => v.verify(`${head}.${b64(validClaims())}.`), AccessError);
  await assert.rejects(() => v.verify(`${head}.${b64(validClaims())}`), AccessError);
});

test('rejects HS256 (key-confusion attempt)', async () => {
  const { v } = makeVerifier();
  const head = b64({ alg: 'HS256', kid: 'kid-1', typ: 'JWT' });
  const body = b64(validClaims());
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  const mac = crypto.createHmac('sha256', pem).update(`${head}.${body}`).digest('base64url');
  await assert.rejects(() => v.verify(`${head}.${body}.${mac}`), AccessError);
});

test('rejects a wrong issuer', async () => {
  const { v } = makeVerifier();
  await assert.rejects(() => v.verify(sign({ ...validClaims(), iss: 'https://evil.cloudflareaccess.com' })), AccessError);
});

test('rejects a wrong audience', async () => {
  const { v } = makeVerifier();
  await assert.rejects(() => v.verify(sign({ ...validClaims(), aud: ['some-other-app'] })), AccessError);
  await assert.rejects(() => v.verify(sign({ ...validClaims(), aud: undefined })), AccessError);
});

test('rejects an expired token and one that is not yet valid', async () => {
  const { v } = makeVerifier();
  await assert.rejects(() => v.verify(sign({ ...validClaims(), exp: nowS - 120 })), AccessError);
  await assert.rejects(() => v.verify(sign({ ...validClaims(), exp: undefined })), AccessError);
  await assert.rejects(() => v.verify(sign({ ...validClaims(), nbf: nowS + 600 })), AccessError);
});

test('rejects an unknown kid after one JWKS refresh', async () => {
  const { v, calls } = makeVerifier({ keys: [otherJwk] });
  await assert.rejects(() => v.verify(sign(validClaims())), AccessError);
  assert.equal(calls(), 2, 'should refresh the key set exactly once before giving up');
});

test('rejects a missing or malformed token', async () => {
  const { v } = makeVerifier();
  for (const bad of ['', null, undefined, 'not-a-jwt', 'a.b', 'a.b.c.d', '!!!.???.***']) {
    await assert.rejects(() => v.verify(bad), AccessError, `should reject ${JSON.stringify(bad)}`);
  }
});

test('fails closed when the JWKS endpoint is unavailable', async () => {
  const v = createAccessVerifier({
    teamDomain: TEAM,
    aud: AUD,
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    now: () => NOW_MS,
  });
  await assert.rejects(() => v.verify(sign(validClaims())), AccessError);
});

test('caches the JWKS instead of refetching per request', async () => {
  const { v, calls } = makeVerifier();
  await v.verify(sign(validClaims()));
  await v.verify(sign(validClaims()));
  assert.equal(calls(), 1);
});

test('normaliseTeamDomain accepts bare hosts and full URLs, rejects junk', () => {
  assert.equal(normaliseTeamDomain(TEAM), ISSUER);
  assert.equal(normaliseTeamDomain(`https://${TEAM}/`), ISSUER);
  assert.throws(() => normaliseTeamDomain(''), AccessError);
  assert.throws(() => normaliseTeamDomain('https://evil.test/path?x=1'), AccessError);
});

test('createAccessVerifier requires both a team domain and an aud', () => {
  assert.throws(() => createAccessVerifier({ teamDomain: '', aud: AUD }), AccessError);
  assert.throws(() => createAccessVerifier({ teamDomain: TEAM, aud: '' }), AccessError);
});

test('extractAccessToken reads the header, then the CF_Authorization cookie', () => {
  assert.equal(extractAccessToken({ headers: { 'cf-access-jwt-assertion': 'tok' } }), 'tok');
  assert.equal(extractAccessToken({ headers: { cookie: 'a=1; CF_Authorization=tok2; b=2' } }), 'tok2');
  assert.equal(extractAccessToken({ headers: {} }), null);
  assert.equal(extractAccessToken({ headers: { cookie: 'a=1' } }), null);
});
