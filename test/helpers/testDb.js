// Points a bot's db/database.js at a fresh temp SQLite file before anything
// requires it, so each test file (and the process running it, per node:test's
// default one-process-per-file isolation) gets its own database instead of
// touching the real one or colliding with other test files.
//
// A bot's own test/helpers/testDb.js wraps this with its file-name prefix and
// a callback that requires its db module -- the require has to happen inside
// the callback, after DB_PATH is set, which is why it's not just a path:
//
//   const { setupTestDb } = require('@wrongieisright/byteme-herald-core/test/helpers/testDb');
//   module.exports = {
//     setup: (label) => setupTestDb(label, { prefix: 'byteme', requireDb: () => require('../../db/database') })
//   };
const path = require('path');
const os = require('os');
const fs = require('fs');

function setupTestDb(label, { prefix = 'bot', requireDb, env = {} } = {}) {
  const dbPath = path.join(os.tmpdir(), `${prefix}-test-${label}-${process.pid}-${Date.now()}.db`);
  process.env.DB_PATH = dbPath;
  // Collapses the bots' real redemption pacing delays (see sleep() in each
  // bot's features/scraper.js) to ~0 for the duration of this test file.
  process.env.FAST_TEST_MODE = '1';
  // Any bot-specific defaults (e.g. a fake API secret) -- only filled in when
  // the environment doesn't already provide them.
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = process.env[key] || value;
  }

  const db = requireDb();
  db.init();

  return {
    db,
    cleanup() {
      try { fs.unlinkSync(dbPath); } catch {}
    }
  };
}

module.exports = { setupTestDb };
