import Database from 'better-sqlite3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS VotingSession (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  eventDate  TEXT,
  status     TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','open','closed')),
  joinCode   TEXT,
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

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L to avoid confusion
function randomCode(len = 6) {
  let s = '';
  for (let i = 0; i < len; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return s;
}

/** Bring an existing database up to the current schema (add columns / backfill) without data loss. */
function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(VotingSession)').all();
  if (!cols.some((c) => c.name === 'joinCode')) {
    db.exec('ALTER TABLE VotingSession ADD COLUMN joinCode TEXT');
  }
  // Backfill a join code for any session created before this column existed.
  const missing = db.prepare("SELECT id FROM VotingSession WHERE joinCode IS NULL OR joinCode = ''").all();
  const setCode = db.prepare('UPDATE VotingSession SET joinCode = ? WHERE id = ?');
  const exists = db.prepare('SELECT 1 FROM VotingSession WHERE joinCode = ?');
  for (const row of missing) {
    let code;
    do { code = randomCode(); } while (exists.get(code));
    setCode.run(code, row.id);
  }
  // Safe to create now that every row has a joinCode.
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_session_joincode ON VotingSession(joinCode)');
}

/**
 * Create a database connection and apply the schema.
 * @param {string} filename  Path to the SQLite file, or ':memory:' for an ephemeral DB (used in tests).
 */
export function createDb(filename = 'voting.db') {
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

export { randomCode };
