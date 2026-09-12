import crypto from 'node:crypto';

/**
 * Cloudflare Access JWT verification (CWE-647 defence-in-depth).
 *
 * The origin must not trust the mere presence of `Cf-Access-Jwt-Assertion`: anyone who can
 * reach the origin directly can set that header. We verify the RS256 signature against the
 * team's published JWKS and check issuer / audience / expiry ourselves.
 *
 * Implemented on node:crypto (Node >= 20 supports importing a JWK directly) so the admin
 * boundary does not depend on a third-party JWT library.
 */

export class AccessError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AccessError';
  }
}

const ACCESS_HEADER = 'cf-access-jwt-assertion';
const ACCESS_COOKIE = 'CF_Authorization';
const JWKS_TTL_MS = 10 * 60 * 1000; // Cloudflare rotates keys roughly every 6 weeks; 10 min is ample.
const CLOCK_SKEW_S = 60;

function b64urlToBuffer(s) {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s)) throw new AccessError('malformed token segment');
  return Buffer.from(s, 'base64url');
}

function decodeJson(segment) {
  try {
    return JSON.parse(b64urlToBuffer(segment).toString('utf8'));
  } catch {
    throw new AccessError('malformed token segment');
  }
}

/** Normalise "team.cloudflareaccess.com" / "https://team.cloudflareaccess.com/" to a bare origin. */
export function normaliseTeamDomain(raw) {
  const trimmed = String(raw || '').trim().replace(/\/+$/, '');
  if (!trimmed) throw new AccessError('CF_ACCESS_TEAM_DOMAIN is empty');
  const host = trimmed.replace(/^https?:\/\//i, '');
  if (!/^[a-z0-9.-]+$/i.test(host)) throw new AccessError('CF_ACCESS_TEAM_DOMAIN is not a hostname');
  return `https://${host}`;
}

/**
 * Build a verifier bound to one team domain + application AUD.
 * `fetchImpl` is injectable so tests never touch the network.
 */
export function createAccessVerifier({ teamDomain, aud, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
  const issuer = normaliseTeamDomain(teamDomain);
  const audience = String(aud || '').trim();
  if (!audience) throw new AccessError('CF_ACCESS_AUD is empty');
  const certsUrl = `${issuer}/cdn-cgi/access/certs`;

  let cache = { keys: null, fetchedAt: 0 };
  let inFlight = null;

  async function loadKeys(force) {
    if (!force && cache.keys && now() - cache.fetchedAt < JWKS_TTL_MS) return cache.keys;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const res = await fetchImpl(certsUrl, { headers: { accept: 'application/json' } });
      if (!res || !res.ok) throw new AccessError(`cannot fetch Access certs (status ${res && res.status})`);
      const body = await res.json();
      const keys = new Map();
      for (const jwk of body?.keys ?? []) {
        if (jwk.kty !== 'RSA' || !jwk.kid) continue;
        try {
          keys.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: 'jwk' }));
        } catch {
          // Ignore a key we cannot import rather than failing the whole set.
        }
      }
      if (keys.size === 0) throw new AccessError('Access certs contained no usable RSA keys');
      cache = { keys, fetchedAt: now() };
      return keys;
    })().finally(() => { inFlight = null; });
    return inFlight;
  }

  /** @returns the verified claims; throws AccessError otherwise. Never returns on failure. */
  async function verify(token) {
    if (typeof token !== 'string' || token.length === 0) throw new AccessError('missing token');
    const parts = token.split('.');
    if (parts.length !== 3) throw new AccessError('token is not a JWS compact serialization');
    const [headerB64, payloadB64, signatureB64] = parts;

    const header = decodeJson(headerB64);
    if (header.alg !== 'RS256') throw new AccessError(`unsupported alg ${header.alg}`);
    if (!header.kid) throw new AccessError('token has no kid');

    let keys = await loadKeys(false);
    let key = keys.get(header.kid);
    if (!key) {
      // Unknown kid: refresh once in case Cloudflare rotated keys, then give up.
      keys = await loadKeys(true);
      key = keys.get(header.kid);
    }
    if (!key) throw new AccessError('unknown signing key');

    const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, 'ascii');
    const signature = b64urlToBuffer(signatureB64);
    if (!crypto.verify('RSA-SHA256', signingInput, key, signature)) throw new AccessError('bad signature');

    const claims = decodeJson(payloadB64);

    if (claims.iss !== issuer) throw new AccessError('issuer mismatch');

    // The AUD tag is a public application identifier, not a secret, so a plain compare is fine.
    const audClaim = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audClaim.includes(audience)) throw new AccessError('audience mismatch');

    const nowS = Math.floor(now() / 1000);
    if (typeof claims.exp !== 'number') throw new AccessError('token has no exp');
    if (nowS >= claims.exp + CLOCK_SKEW_S) throw new AccessError('token expired');
    if (typeof claims.nbf === 'number' && nowS + CLOCK_SKEW_S < claims.nbf) throw new AccessError('token not yet valid');
    if (typeof claims.iat === 'number' && nowS + CLOCK_SKEW_S < claims.iat) throw new AccessError('token issued in the future');

    return claims;
  }

  return { verify, issuer, audience, certsUrl };
}

/** Pull the assertion out of the header, falling back to the CF_Authorization cookie. */
export function extractAccessToken(req) {
  const header = req.headers[ACCESS_HEADER];
  if (typeof header === 'string' && header.length > 0) return header;
  const cookieHeader = req.headers.cookie;
  if (typeof cookieHeader !== 'string') return null;
  for (const pair of cookieHeader.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    if (pair.slice(0, eq).trim() === ACCESS_COOKIE) return pair.slice(eq + 1).trim();
  }
  return null;
}
