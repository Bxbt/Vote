import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../src/db.js';
import { createService, ApiError } from '../src/service.js';

/** Fresh in-memory service for each test. */
function newService() {
  return createService(createDb(':memory:'));
}

/** Build an open session with `categories` categories and `nPresenters` presenters (a1..aN). */
function openSessionWith(service, { categories = ['Wow Factor', 'Creativity'], nPresenters = 10 } = {}) {
  const session = service.createSession({ name: 'Test Vote', eventDate: '2026-07-03' });
  const cats = categories.map((name, i) => service.addCategory(session.id, { name, displayOrder: i + 1 }));
  const presenters = [];
  for (let i = 1; i <= nPresenters; i++) {
    presenters.push(service.addPresenter(session.id, { participantCode: `a${i}`, displayName: `Presenter A${i}`, presentationOrder: i }));
  }
  service.openSession(session.id);
  return { session, cats, presenters };
}

const participantId = (service, session, code) => service._q.participantByCode.get(session.id, code).id;
const fullScores = (cats, value = 5) => cats.map((c) => ({ categoryId: c.id, score: value }));

test('TC-1: create session starts in draft (FR-1)', () => {
  const service = newService();
  const session = service.createSession({ name: 'System Design Vote', eventDate: '2026-07-03' });
  assert.equal(session.status, 'draft');
  assert.ok(session.id);
});

test('TC-2: add categories with display order (FR-2)', () => {
  const service = newService();
  const session = service.createSession({ name: 'Vote' });
  const wow = service.addCategory(session.id, { name: 'Wow Factor', displayOrder: 1 });
  const creative = service.addCategory(session.id, { name: 'Creativity', displayOrder: 2 });
  assert.equal(wow.displayOrder, 1);
  assert.equal(creative.displayOrder, 2);
});

test('TC-3: cannot open a session with no categories (FR-2, FR-13)', () => {
  const service = newService();
  const session = service.createSession({ name: 'Vote' });
  for (let i = 1; i <= 10; i++) service.addPresenter(session.id, { participantCode: `a${i}`, displayName: `A${i}`, presentationOrder: i });
  assert.throws(() => service.openSession(session.id), (e) => e instanceof ApiError && e.status === 400);
});

test('TC-4: opening with 10 presenters + categories succeeds (FR-3, FR-12)', () => {
  const service = newService();
  const { session } = openSessionWith(service);
  assert.equal(service.getSessionOrThrow(session.id).status, 'open');
});

test('TC-5: ballot shows 10 presenters, categories, and voted status (FR-4, FR-9)', () => {
  const service = newService();
  const { session } = openSessionWith(service);
  const ballot = service.getBallot(session.id, participantId(service, session, 'a1'));
  assert.equal(ballot.presenters.length, 10);
  assert.equal(ballot.categories.length, 2);
  assert.ok(ballot.presenters.every((p) => p.alreadyVoted === false));
});

test('TC-6: a1 can vote for a1 (self-vote allowed, FR-6)', () => {
  const service = newService();
  const { session, cats, presenters } = openSessionWith(service);
  const a1 = presenters[0];
  const vote = service.submitVote(session.id, { voterId: participantId(service, session, 'a1'), presenterId: a1.id, scores: fullScores(cats) });
  assert.ok(vote.id);
});

test('TC-7: a1 cannot vote for a1 twice -> 409 (FR-7)', () => {
  const service = newService();
  const { session, cats, presenters } = openSessionWith(service);
  const voterId = participantId(service, session, 'a1');
  service.submitVote(session.id, { voterId, presenterId: presenters[0].id, scores: fullScores(cats) });
  assert.throws(
    () => service.submitVote(session.id, { voterId, presenterId: presenters[0].id, scores: fullScores(cats, 3) }),
    (e) => e instanceof ApiError && e.status === 409,
  );
  // No duplicate vote row was created.
  const votes = service._q.votedPresenterIds.all(session.id, voterId);
  assert.equal(votes.length, 1);
});

test('TC-8: a1 votes for a2..a10 and completes the ballot (FR-6, FR-9)', () => {
  const service = newService();
  const { session, cats, presenters } = openSessionWith(service);
  const voterId = participantId(service, session, 'a1');
  for (const p of presenters) service.submitVote(session.id, { voterId, presenterId: p.id, scores: fullScores(cats, 4) });
  const ballot = service.getBallot(session.id, voterId);
  assert.ok(ballot.presenters.every((p) => p.alreadyVoted === true));
});

test('TC-9: score of 0 or 6 is rejected (FR-5, FR-13)', () => {
  const service = newService();
  const { session, cats, presenters } = openSessionWith(service);
  const voterId = participantId(service, session, 'a1');
  assert.throws(
    () => service.submitVote(session.id, { voterId, presenterId: presenters[1].id, scores: [{ categoryId: cats[0].id, score: 0 }, { categoryId: cats[1].id, score: 6 }] }),
    (e) => e instanceof ApiError && e.status === 400,
  );
});

test('TC-10: incomplete scores are rejected (FR-13, FR-14)', () => {
  const service = newService();
  const { session, cats, presenters } = openSessionWith(service);
  const voterId = participantId(service, session, 'a1');
  assert.throws(
    () => service.submitVote(session.id, { voterId, presenterId: presenters[1].id, scores: [{ categoryId: cats[0].id, score: 4 }] }),
    (e) => e instanceof ApiError && e.status === 400,
  );
});

test('TC-11: voting a closed session is rejected -> 403 (FR-12)', () => {
  const service = newService();
  const { session, cats, presenters } = openSessionWith(service);
  service.closeSession(session.id);
  assert.throws(
    () => service.submitVote(session.id, { voterId: participantId(service, session, 'a1'), presenterId: presenters[0].id, scores: fullScores(cats) }),
    (e) => e instanceof ApiError && e.status === 403,
  );
});

test('TC-12: results show vote count, averages, overall, and ranking (FR-10, FR-11)', () => {
  const service = newService();
  const { session, cats, presenters } = openSessionWith(service);
  // a2 and a3 each vote for a1 with full 5s.
  for (const code of ['a2', 'a3']) {
    service.submitVote(session.id, { voterId: participantId(service, session, code), presenterId: presenters[0].id, scores: fullScores(cats, 5) });
  }
  const { results } = service.getResults(session.id);
  const a1 = results.find((r) => r.code === 'a1');
  assert.equal(a1.voteCount, 2);
  assert.equal(a1.overallAverage, 5);
  assert.equal(a1.rank, 1);
  assert.equal(a1.categoryAverages.length, 2);
});

test('TC-13: presenters with equal averages share a rank (tie, FR-11)', () => {
  const service = newService();
  const { session, cats, presenters } = openSessionWith(service);
  // a1 and a2 both receive identical top scores from voter a3.
  const voter = participantId(service, session, 'a3');
  service.submitVote(session.id, { voterId: voter, presenterId: presenters[0].id, scores: fullScores(cats, 5) });
  service.submitVote(session.id, { voterId: voter, presenterId: presenters[1].id, scores: fullScores(cats, 5) });
  const { results } = service.getResults(session.id);
  const top = results.filter((r) => r.overallAverage === 5);
  assert.ok(top.length >= 2);
  assert.ok(top.every((r) => r.rank === 1));
});

test('TC-14: presenterId not in session is rejected (FR-13)', () => {
  const service = newService();
  const { session, cats } = openSessionWith(service);
  assert.throws(
    () => service.submitVote(session.id, { voterId: participantId(service, session, 'a1'), presenterId: 'presenter-does-not-exist', scores: fullScores(cats) }),
    (e) => e instanceof ApiError && e.status === 400,
  );
});

// ---- New behaviours -----------------------------------------------------

test('presenters are unlimited: a session with 1 presenter can open, and 15 can be added', () => {
  const service = newService();
  const one = openSessionWith(service, { nPresenters: 1 });
  assert.equal(service.getSessionOrThrow(one.session.id).status, 'open');

  const many = service.createSession({ name: 'Big' });
  service.addCategory(many.id, { name: 'Wow' });
  for (let i = 1; i <= 15; i++) service.addPresenter(many.id, { participantCode: `p${i}`, displayName: `P${i}`, presentationOrder: i });
  service.openSession(many.id);
  assert.equal(service._q.presenterCount.get(many.id).n, 15);
});

test('join by code: voter joins with only the session code and gets a fresh identity', () => {
  const service = newService();
  const { session } = openSessionWith(service, { nPresenters: 3 });
  const code = service.getSessionOrThrow(session.id).joinCode;
  assert.match(code, /^[A-Z2-9]{6}$/);

  // Code resolves case-insensitively.
  const resolved = service.getSessionByCode(code.toLowerCase());
  assert.equal(resolved.id, session.id);

  const v1 = service.joinAsVoter(session.id, { displayName: 'Walk-in 1' });
  const v2 = service.joinAsVoter(session.id, {});
  assert.notEqual(v1.id, v2.id); // each join is a distinct voter identity
  assert.equal(v2.displayName, 'Guest voter');
});

test('unknown session code is rejected with 404', () => {
  const service = newService();
  assert.throws(() => service.getSessionByCode('ZZZZZZ'), (e) => e instanceof ApiError && e.status === 404);
});

test('editing a category renames it and reordering a presenter persists', () => {
  const service = newService();
  const { session, cats, presenters } = openSessionWith(service, { nPresenters: 2 });
  const edited = service.editCategory(session.id, cats[0].id, { name: 'Renamed', displayOrder: 9 });
  assert.equal(edited.name, 'Renamed');
  assert.equal(service._q.categoryById.get(cats[0].id).displayOrder, 9);

  const p = service.editPresenter(session.id, presenters[1].id, { displayName: 'New Name', presentationOrder: 1 });
  assert.equal(p.displayName, 'New Name');
  assert.equal(service._q.presenterById.get(presenters[1].id).presentationOrder, 1);
});

test('deleting a presenter is allowed with no votes but blocked once votes exist', () => {
  const service = newService();
  const { session, cats, presenters } = openSessionWith(service, { nPresenters: 3 });
  // No votes yet -> deletable.
  assert.deepEqual(service.removePresenter(session.id, presenters[2].id), { ok: true });

  // Vote for presenter[0], then deletion is blocked.
  service.submitVote(session.id, { voterId: participantId(service, session, 'a2'), presenterId: presenters[0].id, scores: fullScores(cats) });
  assert.throws(() => service.removePresenter(session.id, presenters[0].id), (e) => e instanceof ApiError && e.status === 409);
});

test('deleting a category with recorded scores is blocked', () => {
  const service = newService();
  const { session, cats, presenters } = openSessionWith(service, { nPresenters: 2 });
  service.submitVote(session.id, { voterId: participantId(service, session, 'a2'), presenterId: presenters[0].id, scores: fullScores(cats) });
  assert.throws(() => service.removeCategory(session.id, cats[0].id), (e) => e instanceof ApiError && e.status === 409);
});
