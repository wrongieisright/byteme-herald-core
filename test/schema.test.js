const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const Database = require('better-sqlite3');
const { initSharedSchema, SHARED_TABLES } = require('../db/schema');

const columnsOf = (raw, table) => raw.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);

function tempDb(label) {
  const dbPath = path.join(os.tmpdir(), `core-schema-${label}-${process.pid}-${Date.now()}.db`);
  const raw = new Database(dbPath);
  process.on('exit', () => { try { raw.close(); } catch {} try { fs.unlinkSync(dbPath); } catch {} });
  return raw;
}

test('initSharedSchema creates every shared table on a fresh database', () => {
  const raw = tempDb('fresh');
  initSharedSchema(raw);
  const tables = raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map(r => r.name);
  for (const t of SHARED_TABLES) {
    assert.ok(tables.includes(t), `${t} should exist`);
  }
});

test('initSharedSchema is idempotent on an already-current database', () => {
  const raw = tempDb('idempotent');
  initSharedSchema(raw);
  assert.doesNotThrow(() => initSharedSchema(raw));
  assert.ok(columnsOf(raw, 'schedules').includes('recurrence_type'));
});

test('migrates a pre-per-guild user_prefs table, turning existing rows into global defaults', () => {
  const raw = tempDb('userprefs');
  raw.exec(`
    CREATE TABLE user_prefs (user_id TEXT PRIMARY KEY, timezone TEXT NOT NULL DEFAULT 'UTC');
    INSERT INTO user_prefs (user_id, timezone) VALUES ('u1', 'America/New_York');
  `);
  initSharedSchema(raw);

  assert.ok(columnsOf(raw, 'user_prefs').includes('guild_id'));
  const row = raw.prepare(`SELECT * FROM user_prefs WHERE user_id = 'u1'`).get();
  assert.equal(row.guild_id, '');
  assert.equal(row.timezone, 'America/New_York');
});

test('migrates a pre-recurrence_type schedules table, inferring daily vs weekly from cron_expr', () => {
  const raw = tempDb('schedules');
  raw.exec(`
    CREATE TABLE schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, channel_id TEXT,
      message TEXT NOT NULL, cron_expr TEXT NOT NULL, timezone TEXT NOT NULL DEFAULT 'UTC',
      dst_follow INTEGER NOT NULL DEFAULT 1, one_time INTEGER NOT NULL DEFAULT 0, fire_at TEXT,
      label TEXT, created_by TEXT, created_at TEXT DEFAULT (datetime('now')), active INTEGER NOT NULL DEFAULT 1
    );
    INSERT INTO schedules (guild_id, message, cron_expr) VALUES ('g', 'daily one', '0 9 * * *');
    INSERT INTO schedules (guild_id, message, cron_expr) VALUES ('g', 'weekly one', '0 9 * * 0');
    INSERT INTO schedules (guild_id, message, cron_expr, one_time, fire_at) VALUES ('g', 'once', '0 0 1 1 *', 1, '2099-01-01T00:00:00Z');
  `);
  initSharedSchema(raw);

  const cols = columnsOf(raw, 'schedules');
  for (const c of ['recurrence_type', 'interval_days', 'anchor_date']) assert.ok(cols.includes(c), `${c} added`);

  const byMessage = Object.fromEntries(raw.prepare(`SELECT message, recurrence_type FROM schedules`).all().map(r => [r.message, r.recurrence_type]));
  assert.equal(byMessage['daily one'], 'daily');
  assert.equal(byMessage['weekly one'], 'weekly');
  assert.equal(byMessage['once'], null); // one-time rows are left without a recurrence_type
});
