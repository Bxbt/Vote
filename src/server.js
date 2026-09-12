import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createDb } from './db.js';
import { createService, ApiError } from './service.js';
import { createAccessVerifier, extractAccessToken, AccessError } from './cf-access.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
// Admin UI lives OUTSIDE public/ so express.static(public) can never reach it, however the
// request path is encoded. Only the authenticated /admin router serves it.
const ADMIN_UI_DIR = path.join(__dirname, '..', 'admin-ui');

// Anything that makes the raw path ambiguous between Cloudflare Access (which matches the raw,
// still-encoded path) and Express (whose static middleware decodes, but whose Router does not).
//   %2f / %5c  -> decode to a path separator inside static, so /admin%2f/ used to serve admin-ui
//   %25        -> double encoding; %252f survives one decode round and becomes %2f
//   backslash  -> separator on Windows and in several proxies
// CWE-647: never normalise-then-authorize. We reject the ambiguous request outright instead of
// trying to decide what it "really meant".
const AMBIGUOUS_PATH = /%(?:25|2f|5c)/i;
const MALFORMED_PERCENT = /%(?![0-9a-fA-F]{2})/;

/** Reject encoded separators and malformed escapes before any middleware decodes anything. */
export function rejectAmbiguousPath(req, res, next) {
  const rawPath = req.originalUrl.split('?', 1)[0];
  if (rawPath.includes('\\') || AMBIGUOUS_PATH.test(rawPath) || MALFORMED_PERCENT.test(rawPath)) {
    // 400 with a JSON body: no redirect, no HTML, nothing that leaks admin content.
    res.status(400).json({ error: 'Bad request' });
    return;
  }
  next();
}

/**
 * Build the /admin gate. `verifier` is injected so tests can supply a mock; when it is null the
 * gate fails closed (the app is misconfigured, so nobody gets in).
 */
export function createAccessGuard(verifier) {
  return (req, res, next) => {
    if (!verifier) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    // A dev bypass verifier skips the token requirement entirely; it can only be built outside
    // production (see accessVerifierFromEnv).
    if (verifier.bypass === true) {
      req.accessClaims = { sub: 'dev-bypass', email: 'dev@localhost' };
      next();
      return;
    }
    const token = extractAccessToken(req);
    if (!token) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    Promise.resolve(verifier.verify(token)).then(
      (claims) => { req.accessClaims = claims; next(); },
      (err) => {
        if (!(err instanceof AccessError)) console.error('Access verification error:', err);
        res.status(403).json({ error: 'Forbidden' });
      },
    );
  };
}

/**
 * Build the Express app around a service instance (injectable so tests can use an in-memory DB).
 * `accessVerifier` gates everything under /admin; pass a mock in tests, leave undefined to build
 * one from the environment. A null verifier means "deny all admin access".
 */
export function createApp(service, { accessVerifier = accessVerifierFromEnv() } = {}) {
  const app = express();
  // FIRST middleware: everything below it, including express.static, sees only unambiguous paths.
  app.use(rejectAmbiguousPath);
  app.use(express.json());
  // no-cache = browsers may store but must revalidate (via ETag) before use, so a redeploy
  // never leaves a device running a stale app.js/index.html.
  app.use(express.static(PUBLIC_DIR, {
    etag: true,
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
  }));

  // Wrap async/sync handlers so thrown ApiErrors become clean JSON responses.
  const h = (fn) => (req, res) => {
    try {
      const result = fn(req, res);
      if (result !== undefined && !res.headersSent) res.json(result);
    } catch (e) {
      if (e instanceof ApiError) return res.status(e.status).json({ error: e.message });
      console.error(e);
      res.status(500).json({ error: 'Internal server error' });
    }
  };

  // ---- ฝั่งคนโหวต: เปิดสาธารณะ --------------------------------------------
  // ห้ามย้าย path เหล่านี้ หน้าโหวต (public/app.js) เรียกอยู่ตรงๆ
  app.get('/voting-sessions/by-code/:code', h((req) => {
    const s = service.getSessionByCode(req.params.code);
    return { sessionId: s.id, name: s.name, status: s.status, joinCode: s.joinCode };
  }));

  app.post('/voting-sessions/:sessionId/join', h((req, res) => {
    res.status(201);
    return service.joinAsVoter(req.params.sessionId, req.body ?? {});
  }));

  app.get('/voting-sessions/:sessionId/ballot', h((req) => {
    const { voterId } = req.query;
    if (!voterId) throw new ApiError(400, 'voterId query parameter is required');
    return service.getBallot(req.params.sessionId, String(voterId));
  }));

  app.post('/voting-sessions/:sessionId/votes', h((req, res) => {
    res.status(201);
    return service.submitVote(req.params.sessionId, req.body ?? {});
  }));

  // ---- ฝั่ง admin: อยู่ใต้ /admin ทั้งหมด (SEC-13) ---------------------------
  // หน้าเว็บ admin อยู่ที่ admin-ui/ (นอก static root) เสิร์ฟผ่าน router ตัวนี้หลังผ่าน auth ทำให้เอา
  // Cloudflare Access มาครอบที่ vote.bboybezz.xyz/admin ได้ทีเดียวครบทั้ง UI และ API
  const admin = express.Router();

  // Authorization runs before every admin route AND before the admin UI is served, so an
  // unauthenticated request can never receive admin HTML or JS.
  admin.use(createAccessGuard(accessVerifier));
  // serve-static refuses to serve a mount-root index without first emitting a 301 to the
  // trailing-slash form, so serve it directly: /admin and /admin/ both arrive here as '/'.
  // No redirect means nothing to probe the boundary with.
  admin.get('/', (req, res, next) => {
    res.sendFile(path.join(ADMIN_UI_DIR, 'index.html'), {
      headers: { 'Cache-Control': 'no-store' },
    }, (err) => { if (err) next(err); });
  });
  admin.use(express.static(ADMIN_UI_DIR, {
    etag: true,
    redirect: false,
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
  }));

  admin.post('/sessions', h((req, res) => { res.status(201); return service.createSession(req.body ?? {}); }));
  admin.get('/sessions', h(() => service.listSessions()));
  admin.get('/sessions/:sessionId', h((req) => service.getSessionOrThrow(req.params.sessionId)));
  admin.delete('/sessions/:sessionId', h((req) => service.deleteSession(req.params.sessionId)));

  admin.post('/sessions/:sessionId/categories', h((req, res) => {
    res.status(201);
    return service.addCategory(req.params.sessionId, req.body ?? {});
  }));
  admin.patch('/sessions/:sessionId/categories/:categoryId', h((req) =>
    service.editCategory(req.params.sessionId, req.params.categoryId, req.body ?? {})));
  admin.delete('/sessions/:sessionId/categories/:categoryId', h((req) =>
    service.removeCategory(req.params.sessionId, req.params.categoryId)));

  admin.post('/sessions/:sessionId/presenters', h((req, res) => {
    res.status(201);
    return service.addPresenter(req.params.sessionId, req.body ?? {});
  }));
  admin.patch('/sessions/:sessionId/presenters/:presenterId', h((req) =>
    service.editPresenter(req.params.sessionId, req.params.presenterId, req.body ?? {})));
  admin.delete('/sessions/:sessionId/presenters/:presenterId', h((req) =>
    service.removePresenter(req.params.sessionId, req.params.presenterId)));

  admin.post('/sessions/:sessionId/voters', h((req, res) => {
    res.status(201);
    return service.addVoter(req.params.sessionId, req.body ?? {});
  }));

  admin.post('/sessions/:sessionId/open', h((req) => service.openSession(req.params.sessionId)));
  admin.post('/sessions/:sessionId/close', h((req) => service.closeSession(req.params.sessionId)));

  admin.get('/sessions/:sessionId/ballot', h((req) =>
    service.getBallot(req.params.sessionId, String(req.query.voterId || '__admin__'))));
  admin.get('/sessions/:sessionId/results', h((req) => service.getResults(req.params.sessionId)));

  app.use('/admin', admin);

  // Any unmatched /admin* path must not fall through to a generic handler that might leak.
  app.use('/admin', (req, res) => res.status(404).json({ error: 'Not found' }));

  return app;
}

/**
 * Build a verifier from CF_ACCESS_TEAM_DOMAIN / CF_ACCESS_AUD.
 * Returns null when unset or invalid, which makes the admin gate deny everything (fail closed).
 * CF_ACCESS_DEV_BYPASS=1 disables the gate, but only outside production and never by default.
 */
export function accessVerifierFromEnv(env = process.env) {
  if (env.CF_ACCESS_DEV_BYPASS === '1') {
    if (env.NODE_ENV === 'production') {
      console.error('SECURITY: CF_ACCESS_DEV_BYPASS is ignored in production; /admin stays closed.');
    } else {
      console.warn('SECURITY: CF_ACCESS_DEV_BYPASS=1 — /admin is UNAUTHENTICATED. Never use this in production.');
      return { bypass: true, verify: async () => ({ sub: 'dev-bypass', email: 'dev@localhost' }) };
    }
  }
  const teamDomain = env.CF_ACCESS_TEAM_DOMAIN;
  const aud = env.CF_ACCESS_AUD;
  if (!teamDomain || !aud) {
    console.error('SECURITY: CF_ACCESS_TEAM_DOMAIN / CF_ACCESS_AUD are not set — /admin is closed to everyone.');
    return null;
  }
  try {
    return createAccessVerifier({ teamDomain, aud });
  } catch (e) {
    console.error(`SECURITY: cannot build Access verifier (${e.message}) — /admin is closed to everyone.`);
    return null;
  }
}

// Start the server only when run directly (not when imported by tests).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = createDb(process.env.DB_FILE || 'voting.db');
  const service = createService(db);
  const app = createApp(service);
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`Voting server listening on http://localhost:${port}`);
    console.log(`Voter UI:  http://localhost:${port}/`);
    console.log(`Admin UI:  http://localhost:${port}/admin/`);
  });
}
