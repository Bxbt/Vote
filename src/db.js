import Database from 'better-sqlite3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS VotingSession (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  eventDate  TEXT,
  status     TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','open','closed')),
  createdAt  TEXT NOT NULL,
  updatedAt  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ScoreCategory (
  id           TEXT PRIMARY KEY,
  sessionId    TEXT NOT NULL REFERENCES VotingSession(id),
  name         TEXT NOT NULL,
  description  TEXT,
  displayOrder INTEGER NOT NULL DEFAULT 0,
  isActive     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS Participant (
  id          TEXT PRIMARY KEY,
  sessionId   TEXT NOT NULL REFERENCES VotingSession(id),
  code        TEXT NOT NULL,
  displayName TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'presenter_voter',
  createdAt   TEXT NOT NULL,
  UNIQUE (sessionId, code)
);

CREATE TABLE IF NOT EXISTS Presenter (
  id                TEXT PRIMARY KEY,
  sessionId         TEXT NOT NULL REFERENCES VotingSession(id),
  participantId     TEXT NOT NULL REFERENCES Participant(id),
  presentationOrder INTEGER NOT NULL,
  topicTitle        TEXT,
  UNIQUE (sessionId, participantId)
);

CREATE TABLE IF NOT EXISTS Vote (
  id          TEXT PRIMARY KEY,
  sessionId   TEXT NOT NULL REFERENCES VotingSession(id),
  voterId     TEXT NOT NULL REFERENCES Participant(id),
  presenterId TEXT NOT NULL REFERENCES Presenter(id),
  submittedAt TEXT NOT NULL,
  UNIQUE (sessionId, voterId, presenterId)
);

CREATE TABLE IF NOT EXISTS VoteScore (
  id         TEXT PRIMARY KEY,
  voteId     TEXT NOT NULL REFERENCES Vote(id),
  categoryId TEXT NOT NULL REFERENCES ScoreCategory(id),
  score      INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5),
  UNIQUE (voteId, categoryId)
);

CREATE INDEX IF NOT EXISTS idx_session_status      ON VotingSession(status);
CREATE INDEX IF NOT EXISTS idx_participant_lookup   ON Participant(sessionId, code);
CREATE INDEX IF NOT EXISTS idx_presenter_order      ON Presenter(sessionId, presentationOrder);
CREATE INDEX IF NOT EXISTS idx_vote_by_voter        ON Vote(sessionId, voterId);
CREATE INDEX IF NOT EXISTS idx_vote_by_presenter    ON Vote(sessionId, presenterId);
CREATE INDEX IF NOT EXISTS idx_votescore_lookup     ON VoteScore(voteId, categoryId);
CREATE INDEX IF NOT EXISTS idx_category_order        ON ScoreCategory(sessionId, displayOrder);
`;

/**
 * Create a database connection and apply the schema.
 * @param {string} filename  Path to the SQLite file, or ':memory:' for an ephemeral DB (used in tests).
 */
export function createDb(filename = 'voting.db') {
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}
