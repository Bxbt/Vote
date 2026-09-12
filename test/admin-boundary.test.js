import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createDb } from '../src/db.js';
import { createService } from '../src/service.js';
import { createApp } from '../src/server.js';

// A stand-in for the real Cloudflare Access verifier: accepts exactly one opaque token.
// Signature/issuer/audience verification itself is covered in test/cf-access.test.js.
const GOOD_TOKEN = 'good-token';
const mockVerifier = {
  async verify(token) {
    if (token !== GOOD_TOKEN) throw new Error('bad token');
    return { sub: 'admin-1', email: 'admin@example.com' };
  },
};

let server;
let base;

before(async () => {
  const service = createService(createDb(':memory:'));
  const app = createApp(service, { accessVerifier: mockVerifier });
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

/** Raw request so the encoded path reaches the server byte-for-byte (fetch/URL would normalise it). */
function raw(rawPath, { method = 'GET', token, body } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (token) headers['Cf-Access-Jwt-Assertion'] = token;
    let payload;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const { port } = server.address();
    const req = http.request({ host: '127.0.0.1', port, method, path: rawPath, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location, text }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const ADMIN_MARKERS = [
  'admin.js',            // the admin bundle reference in admin-ui/index.html
  'System Design',       // admin page heading text
  '/admin/sessions',     // API paths baked into admin-ui/admin.js
  'createSession',
];

function assertNoAdminContent(res, label) {
  for (const marker of ADMIN_MARKERS) {
    assert.ok(!res.text.includes(marker), `${label}: response leaked admin marker ${JSON.stringify(marker)}`);
  }
  assert.ok(!/<!doctype html|<script/i.test(res.text), `${label}: response contained HTML/JS`);
}

// --- the variants that must never reach admin content -------------------------------------
const VARIANTS = [
  '/admin',
  '/admin/',
  '/admin/index.html',
  '/admin/admin.js',
  '/admin%2f',
  '/admin%2F/',
  '/admin%252f',
  '/admin%5c',
  '/admin%2fadmin.js',
  '/admin%2fsessions',
  '/admin%5Cadmin.js',
  '/admin\\admin.js',
  '/admin%2e%2e%2f',
  '/admin%zz',
];

for (const variant of VARIANTS) {
  test(`SEC-14: ${variant} without a token is denied`, async () => {
    const res = await raw(variant);
    assert.ok([400, 401, 403, 404].includes(res.status), `${variant}: expected 400/401/403/404, got ${res.status}`);
    assert.equal(res.location, undefined, `${variant}: must not redirect (got Location: ${res.location})`);
    assertNoAdminContent(res, variant);
  });
}

for (const variant of VARIANTS) {
  test(`SEC-14: ${variant} with a valid token still never serves admin content via an encoded path`, async () => {
    const res = await raw(variant, { token: GOOD_TOKEN });
    const isCanonical = /^\/admin(\/|$)/.test(variant) && !variant.includes('%') && !variant.includes('\\');
    if (isCanonical) {
      assert.equal(res.status, 200, `${variant}: authenticated canonical path should work`);
    } else {
      assert.ok([400, 401, 403, 404].includes(res.status), `${variant}: expected denial, got ${res.status}`);
      assert.equal(res.location, undefined, `${variant}: must not redirect`);
      assertNoAdminContent(res, variant);
    }
  });
}

// --- the admin UI is genuinely reachable once authenticated -------------------------------
test('SEC-14: /admin and /admin/ serve the admin UI with a valid token', async () => {
  for (const p of ['/admin', '/admin/', '/admin/index.html']) {
    const res = await raw(p, { token: GOOD_TOKEN });
    assert.equal(res.status, 200, `${p}: expected 200`);
    assert.match(res.text, /<!DOCTYPE html>/i, `${p}: expected the admin page`);
    assert.match(res.text, /\/admin\/admin\.js/, `${p}: expected the admin bundle reference`);
  }
  const js = await raw('/admin/admin.js', { token: GOOD_TOKEN });
  assert.equal(js.status, 200);
  assert.match(js.text, /\/admin\/sessions/);
});

test('SEC-14: the admin UI is not reachable through the public static root', async () => {
  for (const p of ['/admin-ui/index.html', '/index.html', '/app.js']) {
    const res = await raw(p);
    assert.ok(!res.text.includes('/admin/sessions'), `${p}: leaked admin API paths`);
  }
});

// --- canonical admin API across verbs ------------------------------------------------------
test('SEC-14: canonical admin API GET/POST/PATCH/DELETE require a valid token', async () => {
  const calls = [
    ['POST', '/admin/sessions', { name: 'S' }],
    ['GET', '/admin/sessions', undefined],
  ];
  for (const [method, p, body] of calls) {
    const anon = await raw(p, { method, body });
    assert.equal(anon.status, 401, `${method} ${p}: anonymous should be 401`);
    const bad = await raw(p, { method, body, token: 'nope' });
    assert.equal(bad.status, 403, `${method} ${p}: bad token should be 403`);
  }

  const created = await raw('/admin/sessions', { method: 'POST', body: { name: 'S' }, token: GOOD_TOKEN });
  assert.equal(created.status, 201);
  const sessionId = JSON.parse(created.text).id;

  const cat = await raw(`/admin/sessions/${sessionId}/categories`, {
    method: 'POST', body: { name: 'Clarity' }, token: GOOD_TOKEN,
  });
  assert.equal(cat.status, 201);
  const categoryId = JSON.parse(cat.text).id;

  const patched = await raw(`/admin/sessions/${sessionId}/categories/${categoryId}`, {
    method: 'PATCH', body: { name: 'Clarity v2' }, token: GOOD_TOKEN,
  });
  assert.equal(patched.status, 200);

  // Same four verbs must be rejected without a token.
  for (const [method, p, body] of [
    ['PATCH', `/admin/sessions/${sessionId}/categories/${categoryId}`, { name: 'x' }],
    ['DELETE', `/admin/sessions/${sessionId}/categories/${categoryId}`, undefined],
    ['DELETE', `/admin/sessions/${sessionId}`, undefined],
  ]) {
    const res = await raw(p, { method, body });
    assert.equal(res.status, 401, `${method} ${p}: anonymous should be 401`);
  }

  const deleted = await raw(`/admin/sessions/${sessionId}/categories/${categoryId}`, {
    method: 'DELETE', token: GOOD_TOKEN,
  });
  assert.equal(deleted.status, 200);
});

// --- fail closed when the app is misconfigured ---------------------------------------------
test('SEC-14: with no verifier configured, /admin is closed even with a token', async () => {
  const service = createService(createDb(':memory:'));
  const closed = http.createServer(createApp(service, { accessVerifier: null }));
  await new Promise((r) => closed.listen(0, '127.0.0.1', r));
  const { port } = closed.address();
  try {
    for (const p of ['/admin/', '/admin/sessions']) {
      const res = await new Promise((resolve, reject) => {
        const req = http.request(
          { host: '127.0.0.1', port, path: p, headers: { 'Cf-Access-Jwt-Assertion': GOOD_TOKEN } },
          (r2) => { let t = ''; r2.setEncoding('utf8'); r2.on('data', (c) => { t += c; }); r2.on('end', () => resolve({ status: r2.statusCode, text: t })); },
        );
        req.on('error', reject);
        req.end();
      });
      assert.equal(res.status, 403, `${p}: unconfigured app must fail closed`);
      assert.ok(!res.text.includes('<!DOCTYPE'), `${p}: leaked HTML`);
    }
  } finally {
    await new Promise((r) => closed.close(r));
  }
});

// --- public voter surface must be untouched -------------------------------------------------
test('SEC-14: public voter routes still work', async () => {
  const service = createService(createDb(':memory:'));
  const app = createApp(service, { accessVerifier: mockVerifier });
  const pub = http.createServer(app);
  await new Promise((r) => pub.listen(0, '127.0.0.1', r));
  const port = pub.address().port;
  const call = (p, opts = {}) => new Promise((resolve, reject) => {
    const headers = {};
    let payload;
    if (opts.body !== undefined) {
      payload = JSON.stringify(opts.body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request({ host: '127.0.0.1', port, path: p, method: opts.method || 'GET', headers }, (res) => {
      let t = ''; res.setEncoding('utf8'); res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, text: t }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });

  try {
    const index = await call('/');
    assert.equal(index.status, 200);
    assert.match(index.text, /<!DOCTYPE html>/i);

    const appJs = await call('/app.js');
    assert.equal(appJs.status, 200);

    // Build an open session through the authenticated admin API.
    const s = JSON.parse((await raw('/admin/sessions', { method: 'POST', body: { name: 'Public' }, token: GOOD_TOKEN })).text);
    await raw(`/admin/sessions/${s.id}/categories`, { method: 'POST', body: { name: 'Clarity' }, token: GOOD_TOKEN });
    await raw(`/admin/sessions/${s.id}/presenters`, { method: 'POST', body: { participantCode: 'p1', displayName: 'P1', presentationOrder: 1 }, token: GOOD_TOKEN });
    await raw(`/admin/sessions/${s.id}/open`, { method: 'POST', token: GOOD_TOKEN });

    // These hit the shared in-memory service behind `server`, not `pub`, so use raw().
    const byCode = await raw(`/voting-sessions/by-code/${s.joinCode}`);
    assert.equal(byCode.status, 200);
    const found = JSON.parse(byCode.text);
    assert.equal(found.sessionId, s.id);

    const joined = await raw(`/voting-sessions/${s.id}/join`, { method: 'POST', body: { displayName: 'Voter A' } });
    assert.equal(joined.status, 201);
    const voter = JSON.parse(joined.text);
    const voterId = voter.id; // joinAsVoter returns the participant row

    const ballot = await raw(`/voting-sessions/${s.id}/ballot?voterId=${encodeURIComponent(voterId)}`);
    assert.equal(ballot.status, 200);
    const b = JSON.parse(ballot.text);

    const vote = await raw(`/voting-sessions/${s.id}/votes`, {
      method: 'POST',
      body: {
        voterId,
        presenterId: b.presenters[0].id,
        scores: b.categories.map((c) => ({ categoryId: c.id, score: 5 })),
      },
    });
    assert.equal(vote.status, 201, `vote failed: ${vote.text}`);
  } finally {
    await new Promise((r) => pub.close(r));
  }
});

// --- environment wiring for the verifier -----------------------------------------------------
test('SEC-14: accessVerifierFromEnv fails closed and never bypasses in production', async () => {
  const { accessVerifierFromEnv } = await import('../src/server.js');
  const quiet = { error: console.error, warn: console.warn };
  console.error = () => {}; console.warn = () => {};
  try {
    assert.equal(accessVerifierFromEnv({}), null, 'no config must deny everyone');
    assert.equal(accessVerifierFromEnv({ CF_ACCESS_TEAM_DOMAIN: 't.cloudflareaccess.com' }), null, 'AUD alone missing must deny');
    assert.equal(accessVerifierFromEnv({ CF_ACCESS_AUD: 'aud' }), null, 'team domain missing must deny');
    assert.equal(
      accessVerifierFromEnv({ NODE_ENV: 'production', CF_ACCESS_DEV_BYPASS: '1' }),
      null,
      'the dev bypass must be inert in production',
    );

    const configured = accessVerifierFromEnv({ CF_ACCESS_TEAM_DOMAIN: 't.cloudflareaccess.com', CF_ACCESS_AUD: 'aud' });
    assert.ok(configured && typeof configured.verify === 'function');
    assert.notEqual(configured.bypass, true, 'a configured verifier must never be a bypass');

    const bypass = accessVerifierFromEnv({ CF_ACCESS_DEV_BYPASS: '1' });
    assert.equal(bypass.bypass, true, 'outside production the opt-in bypass is available');
  } finally {
    console.error = quiet.error; console.warn = quiet.warn;
  }
});

test('SEC-14: a dev-bypass verifier serves the admin UI without a token, encoded paths still blocked', async () => {
  const service = createService(createDb(':memory:'));
  const srv = http.createServer(createApp(service, { accessVerifier: { bypass: true, verify: async () => ({}) } }));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  const call = (p) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p }, (res) => {
      let t = ''; res.setEncoding('utf8'); res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, text: t }));
    });
    req.on('error', reject);
    req.end();
  });
  try {
    assert.equal((await call('/admin')).status, 200);
    assert.equal((await call('/admin/admin.js')).status, 200);
    assert.equal((await call('/admin%2f')).status, 400, 'the path guard runs regardless of the verifier');
  } finally {
    await new Promise((r) => srv.close(r));
  }
});
