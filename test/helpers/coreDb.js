// A minimal "bot" for the core's own tests: opens a temp database, creates
// the one bot-owned table the shared queries rely on (`players`, see
// db/schema.js's contract), runs initSharedSchema, and composes the shared
// queries the same way a real bot's db/database.js does.
const path = require('path');
const os = require('os');
const fs = require('fs');
const Database = require('better-sqlite3');
const { initSharedSchema } = require('../../db/schema');
const { createSharedQueries } = require('../../db/queries');

function openCoreTestDb(label) {
  const dbPath = path.join(os.tmpdir(), `core-test-${label}-${process.pid}-${Date.now()}.db`);
  const raw = new Database(dbPath);

  raw.exec(`
    CREATE TABLE IF NOT EXISTS players (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id TEXT UNIQUE NOT NULL,
      nickname TEXT,
      state TEXT,
      added_by TEXT,
      added_at TEXT DEFAULT (datetime('now'))
    );
  `);
  initSharedSchema(raw);

  const players = {
    add(player_id, added_by, state = null) {
      return raw.prepare(`INSERT OR IGNORE INTO players (player_id, added_by, state) VALUES (?, ?, ?)`).run(player_id, added_by, state);
    },
    getById(player_id) {
      return raw.prepare(`SELECT * FROM players WHERE player_id = ?`).get(player_id);
    }
  };

  const db = {
    ...createSharedQueries(raw),
    players,
    init: () => initSharedSchema(raw),
    getRawDb: () => raw
  };

  return {
    db,
    raw,
    dbPath,
    cleanup() {
      try { raw.close(); } catch {}
      try { fs.unlinkSync(dbPath); } catch {}
    }
  };
}

module.exports = { openCoreTestDb };
