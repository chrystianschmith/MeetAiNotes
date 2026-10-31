// Banco local (SQLite embutido no Node). Tudo fica em data/meetainotes.sqlite.
const { DatabaseSync } = require("node:sqlite");

function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS meetings (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      duration_sec REAL DEFAULT 0,
      has_system_audio INTEGER DEFAULT 0,
      status TEXT NOT NULL,            -- recording | processing | summarizing | ready | error
      progress TEXT,
      error TEXT,
      summary_json TEXT,
      my_notes TEXT DEFAULT '',
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      channel TEXT NOT NULL,           -- me | others
      start REAL NOT NULL,
      end REAL NOT NULL,
      text TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_segments_meeting ON segments(meeting_id, start);
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      description TEXT NOT NULL,
      owner TEXT,
      due TEXT,
      quote TEXT,
      mine INTEGER DEFAULT 0,
      done INTEGER DEFAULT 0,
      manual INTEGER DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_meeting ON tasks(meeting_id);
    CREATE TABLE IF NOT EXISTS chat (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      role TEXT NOT NULL,              -- user | assistant
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

module.exports = { openDb };
