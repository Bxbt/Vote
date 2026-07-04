import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createDb } from './db.js';
import { createService, ApiError } from './service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Build the Express app around a service instance (injectable so tests can use an in-memory DB). */
export function createApp(service) {
  const app = express();
  app.use(express.json());
  // no-cache = browsers may store but must revalidate (via ETag) before use, so a redeploy
  // never leaves a device running a stale app.js/index.html.
  app.use(express.static(path.join(__dirname, '..', 'public'), {
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

  app.post('/voting-sessions', h((req, res) => {
    res.status(201);
    return service.createSession(req.body ?? {});
  }));

  app.get('/voting-sessions', h(() => service.listSessions()));

  app.delete('/voting-sessions/:sessionId', h((req) => service.deleteSession(req.params.sessionId)));

  app.post('/voting-sessions/:sessionId/categories', h((req, res) => {
    res.status(201);
    return service.addCategory(req.params.sessionId, req.body ?? {});
  }));

  app.patch('/voting-sessions/:sessionId/categories/:categoryId', h((req) =>
    service.editCategory(req.params.sessionId, req.params.categoryId, req.body ?? {})));

  app.delete('/voting-sessions/:sessionId/categories/:categoryId', h((req) =>
    service.removeCategory(req.params.sessionId, req.params.categoryId)));

  app.post('/voting-sessions/:sessionId/presenters', h((req, res) => {
    res.status(201);
    return service.addPresenter(req.params.sessionId, req.body ?? {});
  }));

  app.patch('/voting-sessions/:sessionId/presenters/:presenterId', h((req) =>
    service.editPresenter(req.params.sessionId, req.params.presenterId, req.body ?? {})));

  app.delete('/voting-sessions/:sessionId/presenters/:presenterId', h((req) =>
    service.removePresenter(req.params.sessionId, req.params.presenterId)));

  app.post('/voting-sessions/:sessionId/voters', h((req, res) => {
    res.status(201);
    return service.addVoter(req.params.sessionId, req.body ?? {});
  }));

  // Public voter self-join: resolve a short code, then mint an anonymous voter identity.
  app.get('/voting-sessions/by-code/:code', h((req) => {
    const s = service.getSessionByCode(req.params.code);
    return { sessionId: s.id, name: s.name, status: s.status, joinCode: s.joinCode };
  }));

  app.post('/voting-sessions/:sessionId/join', h((req, res) => {
    res.status(201);
    return service.joinAsVoter(req.params.sessionId, req.body ?? {});
  }));

  app.post('/voting-sessions/:sessionId/open', h((req) => service.openSession(req.params.sessionId)));

  app.post('/voting-sessions/:sessionId/close', h((req) => service.closeSession(req.params.sessionId)));

  app.get('/voting-sessions/:sessionId/ballot', h((req) => {
    const { voterId } = req.query;
    if (!voterId) throw new ApiError(400, 'voterId query parameter is required');
    return service.getBallot(req.params.sessionId, String(voterId));
  }));

  app.post('/voting-sessions/:sessionId/votes', h((req, res) => {
    res.status(201);
    return service.submitVote(req.params.sessionId, req.body ?? {});
  }));

  app.get('/voting-sessions/:sessionId/results', h((req) => service.getResults(req.params.sessionId)));

  app.get('/voting-sessions/:sessionId', h((req) => service.getSessionOrThrow(req.params.sessionId)));

  return app;
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
    console.log(`Admin UI:  http://localhost:${port}/admin.html`);
  });
}
