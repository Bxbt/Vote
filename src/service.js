import { randomUUID } from 'node:crypto';
import { randomCode } from './db.js';

/** An error that carries an HTTP status code so the API layer can translate it into a response. */
export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.name = 'ApiError';
  }
}

const now = () => new Date().toISOString();
const id = (prefix) => `${prefix}-${randomUUID().slice(0, 8)}`;

/**
 * Build the voting service bound to a database connection.
 * All business rules (FR-1..FR-14) live here so they are enforced regardless of the caller (API or UI).
 */
export function createService(db) {
  const q = {
    session:       db.prepare('SELECT * FROM VotingSession WHERE id = ?'),
    sessionByCode: db.prepare('SELECT * FROM VotingSession WHERE joinCode = ?'),
    listSessions:  db.prepare(`
      SELECT s.id, s.name, s.status, s.joinCode, s.eventDate, s.createdAt,
        (SELECT COUNT(*) FROM ScoreCategory c WHERE c.sessionId = s.id) AS categories,
        (SELECT COUNT(*) FROM Presenter p WHERE p.sessionId = s.id) AS presenters,
        (SELECT COUNT(*) FROM Vote v WHERE v.sessionId = s.id) AS votes
      FROM VotingSession s ORDER BY s.createdAt DESC`),
    delScores:      db.prepare('DELETE FROM VoteScore WHERE voteId IN (SELECT id FROM Vote WHERE sessionId = ?)'),
    delVotes:       db.prepare('DELETE FROM Vote WHERE sessionId = ?'),
    delPresenters:  db.prepare('DELETE FROM Presenter WHERE sessionId = ?'),
    delCategories:  db.prepare('DELETE FROM ScoreCategory WHERE sessionId = ?'),
    delParticipants:db.prepare('DELETE FROM Participant WHERE sessionId = ?'),
    delSession:     db.prepare('DELETE FROM VotingSession WHERE id = ?'),
    insertSession: db.prepare('INSERT INTO VotingSession (id, name, eventDate, status, joinCode, createdAt, updatedAt) VALUES (@id, @name, @eventDate, @status, @joinCode, @createdAt, @updatedAt)'),
    setStatus:     db.prepare('UPDATE VotingSession SET status = ?, updatedAt = ? WHERE id = ?'),

    activeCategories: db.prepare('SELECT * FROM ScoreCategory WHERE sessionId = ? AND isActive = 1 ORDER BY displayOrder, name'),
    categoryById:     db.prepare('SELECT * FROM ScoreCategory WHERE id = ?'),
    insertCategory:   db.prepare('INSERT INTO ScoreCategory (id, sessionId, name, description, displayOrder, isActive) VALUES (@id, @sessionId, @name, @description, @displayOrder, 1)'),
    updateCategory:   db.prepare('UPDATE ScoreCategory SET name = @name, description = @description, displayOrder = @displayOrder, isActive = @isActive WHERE id = @id'),
    deleteCategory:   db.prepare('DELETE FROM ScoreCategory WHERE id = ?'),
    scoresForCategory: db.prepare('SELECT COUNT(*) AS n FROM VoteScore WHERE categoryId = ?'),

    participantByCode: db.prepare('SELECT * FROM Participant WHERE sessionId = ? AND code = ?'),
    participantById:   db.prepare('SELECT * FROM Participant WHERE id = ?'),
    insertParticipant: db.prepare('INSERT INTO Participant (id, sessionId, code, displayName, role, createdAt) VALUES (@id, @sessionId, @code, @displayName, @role, @createdAt)'),
    updateParticipantName: db.prepare('UPDATE Participant SET displayName = ? WHERE id = ?'),

    presenters:       db.prepare('SELECT * FROM Presenter WHERE sessionId = ? ORDER BY presentationOrder'),
    presenterById:    db.prepare('SELECT * FROM Presenter WHERE id = ?'),
    presenterCount:   db.prepare('SELECT COUNT(*) AS n FROM Presenter WHERE sessionId = ?'),
    insertPresenter:  db.prepare('INSERT INTO Presenter (id, sessionId, participantId, presentationOrder, topicTitle) VALUES (@id, @sessionId, @participantId, @presentationOrder, @topicTitle)'),
    updatePresenter:  db.prepare('UPDATE Presenter SET presentationOrder = @presentationOrder, topicTitle = @topicTitle WHERE id = @id'),
    deletePresenter:  db.prepare('DELETE FROM Presenter WHERE id = ?'),
    votesForPresenter: db.prepare('SELECT COUNT(*) AS n FROM Vote WHERE presenterId = ?'),

    votedPresenterIds: db.prepare('SELECT presenterId FROM Vote WHERE sessionId = ? AND voterId = ?'),
    findVote:          db.prepare('SELECT * FROM Vote WHERE sessionId = ? AND voterId = ? AND presenterId = ?'),
    insertVote:        db.prepare('INSERT INTO Vote (id, sessionId, voterId, presenterId, submittedAt) VALUES (@id, @sessionId, @voterId, @presenterId, @submittedAt)'),
    insertScore:       db.prepare('INSERT INTO VoteScore (id, voteId, categoryId, score) VALUES (@id, @voteId, @categoryId, @score)'),

    resultRows: db.prepare(`
      SELECT p.id AS presenterId, part.displayName AS displayName, part.code AS code,
             vs.categoryId AS categoryId, vs.score AS score, v.id AS voteId
      FROM Presenter p
      JOIN Participant part ON part.id = p.participantId
      LEFT JOIN Vote v      ON v.presenterId = p.id
      LEFT JOIN VoteScore vs ON vs.voteId = v.id
      WHERE p.sessionId = ?
    `),
  };

  function getSessionOrThrow(sessionId) {
    const session = q.session.get(sessionId);
    if (!session) throw new ApiError(404, 'Voting session not found');
    return session;
  }

  // ---- Setup (admin) -----------------------------------------------------

  function createSession({ name, eventDate = null }) {
    if (!name || !name.trim()) throw new ApiError(400, 'Session name is required');
    let joinCode;
    do { joinCode = randomCode(); } while (q.sessionByCode.get(joinCode));
    const session = { id: id('session'), name: name.trim(), eventDate, status: 'draft', joinCode, createdAt: now(), updatedAt: now() };
    q.insertSession.run(session);
    return session;
  }

  /** List every session (most recent first) with quick counts for the admin session picker. */
  function listSessions() {
    return q.listSessions.all();
  }

  /** Permanently delete a session and everything under it (votes, scores, presenters, categories, participants). */
  function deleteSession(sessionId) {
    getSessionOrThrow(sessionId);
    const wipe = db.transaction(() => {
      q.delScores.run(sessionId);
      q.delVotes.run(sessionId);
      q.delPresenters.run(sessionId);
      q.delCategories.run(sessionId);
      q.delParticipants.run(sessionId);
      q.delSession.run(sessionId);
    });
    wipe();
    return { ok: true };
  }

  /** Resolve a short human-friendly join code to its session (used by the voter page). */
  function getSessionByCode(code) {
    const session = q.sessionByCode.get(String(code || '').trim().toUpperCase());
    if (!session) throw new ApiError(404, 'Session code not found');
    return session;
  }

  function addCategory(sessionId, { name, description = null, displayOrder = 0 }) {
    const session = getSessionOrThrow(sessionId);
    if (session.status === 'closed') throw new ApiError(400, 'Cannot modify a closed session');
    if (!name || !name.trim()) throw new ApiError(400, 'Category name is required');
    const category = { id: id('category'), sessionId, name: name.trim(), description, displayOrder };
    q.insertCategory.run(category);
    return { ...category, isActive: 1 };
  }

  function editCategory(sessionId, categoryId, { name, description, displayOrder, isActive }) {
    const session = getSessionOrThrow(sessionId);
    if (session.status === 'closed') throw new ApiError(400, 'Cannot modify a closed session');
    const existing = q.categoryById.get(categoryId);
    if (!existing || existing.sessionId !== sessionId) throw new ApiError(404, 'Category not found');
    const updated = {
      id: categoryId,
      name: name != null && name.trim() ? name.trim() : existing.name,
      description: description !== undefined ? description : existing.description,
      displayOrder: displayOrder != null ? displayOrder : existing.displayOrder,
      isActive: isActive != null ? (isActive ? 1 : 0) : existing.isActive,
    };
    q.updateCategory.run(updated);
    return updated;
  }

  function removeCategory(sessionId, categoryId) {
    const session = getSessionOrThrow(sessionId);
    if (session.status === 'closed') throw new ApiError(400, 'Cannot modify a closed session');
    const existing = q.categoryById.get(categoryId);
    if (!existing || existing.sessionId !== sessionId) throw new ApiError(404, 'Category not found');
    if (q.scoresForCategory.get(categoryId).n > 0) {
      throw new ApiError(409, 'Cannot delete a category that already has votes; deactivate it instead');
    }
    q.deleteCategory.run(categoryId);
    return { ok: true };
  }

  function addPresenter(sessionId, { participantCode, displayName, presentationOrder, topicTitle = null }) {
    const session = getSessionOrThrow(sessionId);
    if (session.status === 'closed') throw new ApiError(400, 'Cannot modify a closed session');
    if (!participantCode || !displayName) throw new ApiError(400, 'participantCode and displayName are required');

    // Reuse the participant if their code already exists in this session, otherwise create one.
    let participant = q.participantByCode.get(sessionId, participantCode);
    if (!participant) {
      participant = { id: id('participant'), sessionId, code: participantCode, displayName, role: 'presenter_voter', createdAt: now() };
      q.insertParticipant.run(participant);
    }

    const presenter = {
      id: id('presenter'),
      sessionId,
      participantId: participant.id,
      presentationOrder: presentationOrder ?? q.presenterCount.get(sessionId).n + 1,
      topicTitle,
    };
    try {
      q.insertPresenter.run(presenter);
    } catch (e) {
      if (String(e.message).includes('UNIQUE')) throw new ApiError(400, 'This participant is already a presenter in this session');
      throw e;
    }
    return { ...presenter, participantId: participant.id };
  }

  function editPresenter(sessionId, presenterId, { displayName, presentationOrder, topicTitle }) {
    const session = getSessionOrThrow(sessionId);
    if (session.status === 'closed') throw new ApiError(400, 'Cannot modify a closed session');
    const presenter = q.presenterById.get(presenterId);
    if (!presenter || presenter.sessionId !== sessionId) throw new ApiError(404, 'Presenter not found');
    q.updatePresenter.run({
      id: presenterId,
      presentationOrder: presentationOrder != null ? presentationOrder : presenter.presentationOrder,
      topicTitle: topicTitle !== undefined ? topicTitle : presenter.topicTitle,
    });
    if (displayName != null && displayName.trim()) {
      q.updateParticipantName.run(displayName.trim(), presenter.participantId);
    }
    const participant = q.participantById.get(presenter.participantId);
    return { id: presenterId, sessionId, participantId: presenter.participantId, code: participant.code, displayName: participant.displayName, presentationOrder: presentationOrder ?? presenter.presentationOrder, topicTitle: topicTitle ?? presenter.topicTitle };
  }

  function removePresenter(sessionId, presenterId) {
    const session = getSessionOrThrow(sessionId);
    if (session.status === 'closed') throw new ApiError(400, 'Cannot modify a closed session');
    const presenter = q.presenterById.get(presenterId);
    if (!presenter || presenter.sessionId !== sessionId) throw new ApiError(404, 'Presenter not found');
    if (q.votesForPresenter.get(presenterId).n > 0) {
      throw new ApiError(409, 'Cannot delete a presenter who already has votes');
    }
    q.deletePresenter.run(presenterId);
    return { ok: true };
  }

  /** Register a plain voter (no presentation) so people who are not presenters can still cast votes. */
  function addVoter(sessionId, { code, displayName }) {
    getSessionOrThrow(sessionId);
    if (!code || !displayName) throw new ApiError(400, 'code and displayName are required');
    let participant = q.participantByCode.get(sessionId, code);
    if (participant) return participant;
    participant = { id: id('participant'), sessionId, code, displayName, role: 'voter', createdAt: now() };
    q.insertParticipant.run(participant);
    return participant;
  }

  /**
   * Self-service voter join used by the public voter page: the browser presents only a session code,
   * so we mint an anonymous voter participant and hand back its id (the browser then remembers it).
   */
  function joinAsVoter(sessionId, { displayName = null } = {}) {
    getSessionOrThrow(sessionId);
    let code;
    do { code = 'v-' + randomUUID().slice(0, 8); } while (q.participantByCode.get(sessionId, code));
    const participant = {
      id: id('participant'),
      sessionId,
      code,
      displayName: (displayName && displayName.trim()) || 'Guest voter',
      role: 'voter',
      createdAt: now(),
    };
    q.insertParticipant.run(participant);
    return participant;
  }

  function openSession(sessionId) {
    const session = getSessionOrThrow(sessionId);
    const categories = q.activeCategories.all(sessionId);
    const presenterCount = q.presenterCount.get(sessionId).n;
    if (categories.length < 1 || presenterCount < 1) {
      throw new ApiError(400, 'At least one score category and one presenter are required before opening voting');
    }
    q.setStatus.run('open', now(), sessionId);
    return { ...session, status: 'open' };
  }

  function closeSession(sessionId) {
    const session = getSessionOrThrow(sessionId);
    q.setStatus.run('closed', now(), sessionId);
    return { ...session, status: 'closed' };
  }

  // ---- Voting ------------------------------------------------------------

  /** Ballot for a voter: categories + presenters annotated with whether this voter already voted for them. */
  function getBallot(sessionId, voterId) {
    const session = getSessionOrThrow(sessionId);
    const categories = q.activeCategories.all(sessionId);
    const votedIds = new Set(q.votedPresenterIds.all(sessionId, voterId).map((r) => r.presenterId));
    const presenters = q.presenters.all(sessionId).map((p) => {
      const participant = q.participantById.get(p.participantId);
      return {
        id: p.id,
        code: participant.code,
        displayName: participant.displayName,
        participantId: p.participantId,
        presentationOrder: p.presentationOrder,
        topicTitle: p.topicTitle,
        alreadyVoted: votedIds.has(p.id),
      };
    });
    return {
      sessionId,
      status: session.status,
      categories: categories.map((c) => ({ id: c.id, name: c.name, description: c.description, displayOrder: c.displayOrder })),
      presenters,
    };
  }

  /**
   * Submit one vote (a set of category scores) from a voter to a presenter.
   * Enforces: session open, voter/presenter exist in session, every active category scored 1–5, no duplicate.
   */
  function submitVote(sessionId, { voterId, presenterId, scores }) {
    const session = getSessionOrThrow(sessionId);
    if (session.status !== 'open') throw new ApiError(403, 'Voting session is not open');

    const voter = q.participantById.get(voterId);
    if (!voter || voter.sessionId !== sessionId) throw new ApiError(400, 'Voter is not part of this session');

    const presenter = q.presenterById.get(presenterId);
    if (!presenter || presenter.sessionId !== sessionId) throw new ApiError(400, 'Presenter is not part of this session');

    const categories = q.activeCategories.all(sessionId);
    const scoreByCategory = new Map((scores ?? []).map((s) => [s.categoryId, s.score]));

    // Every active category must have exactly one integer score in 1..5.
    for (const category of categories) {
      const value = scoreByCategory.get(category.id);
      if (!Number.isInteger(value) || value < 1 || value > 5) {
        throw new ApiError(400, 'Every active score category must have one score from 1 to 5');
      }
    }
    if (scoreByCategory.size !== categories.length) {
      throw new ApiError(400, 'Every active score category must have one score from 1 to 5');
    }

    if (q.findVote.get(sessionId, voterId, presenterId)) {
      throw new ApiError(409, 'You have already voted for this presenter in this session');
    }

    const vote = { id: id('vote'), sessionId, voterId, presenterId, submittedAt: now() };
    const write = db.transaction(() => {
      q.insertVote.run(vote);
      for (const category of categories) {
        q.insertScore.run({ id: id('votescore'), voteId: vote.id, categoryId: category.id, score: scoreByCategory.get(category.id) });
      }
    });
    try {
      write();
    } catch (e) {
      // Guards against a race where the same (voter, presenter) is submitted twice concurrently.
      if (String(e.message).includes('UNIQUE')) throw new ApiError(409, 'You have already voted for this presenter in this session');
      throw e;
    }
    return vote;
  }

  // ---- Results -----------------------------------------------------------

  function getResults(sessionId) {
    getSessionOrThrow(sessionId);
    const categories = q.activeCategories.all(sessionId);
    const rows = q.resultRows.all(sessionId);

    // Aggregate per presenter: total & count per category, plus the set of distinct votes.
    const byPresenter = new Map();
    for (const r of rows) {
      if (!byPresenter.has(r.presenterId)) {
        byPresenter.set(r.presenterId, { presenterId: r.presenterId, displayName: r.displayName, code: r.code, votes: new Set(), sums: new Map() });
      }
      const p = byPresenter.get(r.presenterId);
      if (r.voteId) p.votes.add(r.voteId);
      if (r.categoryId != null && r.score != null) {
        const acc = p.sums.get(r.categoryId) ?? { total: 0, count: 0 };
        acc.total += r.score;
        acc.count += 1;
        p.sums.set(r.categoryId, acc);
      }
    }

    const round = (n) => Math.round(n * 100) / 100;
    const results = [...byPresenter.values()].map((p) => {
      const categoryAverages = categories.map((c) => {
        const acc = p.sums.get(c.id);
        return { categoryId: c.id, name: c.name, average: acc && acc.count ? round(acc.total / acc.count) : 0 };
      });
      const scored = categoryAverages.filter((c) => c.average > 0);
      const overallAverage = scored.length ? round(scored.reduce((s, c) => s + c.average, 0) / scored.length) : 0;
      return { presenterId: p.presenterId, displayName: p.displayName, code: p.code, voteCount: p.votes.size, categoryAverages, overallAverage };
    });

    // Rank by overall average (desc); equal averages share a rank (competition ranking: 1,1,3).
    results.sort((a, b) => b.overallAverage - a.overallAverage || a.displayName.localeCompare(b.displayName));
    let rank = 0;
    let prev = null;
    results.forEach((r, i) => {
      if (prev === null || r.overallAverage !== prev) rank = i + 1;
      r.rank = rank;
      prev = r.overallAverage;
    });

    return { sessionId, results };
  }

  return {
    createSession, listSessions, deleteSession, getSessionByCode, addCategory, editCategory, removeCategory,
    addPresenter, editPresenter, removePresenter, addVoter, joinAsVoter,
    openSession, closeSession, getBallot, submitVote, getResults, getSessionOrThrow,
    _q: q,
  };
}
