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
