// The tables every bot built on this core shares verbatim, plus the
// migrations that reshaped them over time. Each bot still owns its own
// game-specific tables and creates them in its own init() alongside this:
//   - `players` -- the progression columns differ per game (WOS tracks a
//     furnace level and sub-level, Kingshot a plain level).
//   - `redemptions` -- the two bots' copies had already diverged (column
//     names, aggregate queries) before this core existed.
//
// Contract the shared queries rely on: the bot's `players` table must have
// a `player_id TEXT UNIQUE NOT NULL` column. playerGuilds.unlink() and
// removeEverywhere() delete from it once a player's last guild link is gone,
// and playerChanges/redemption-style guild scoping joins through
// player_guilds on that same column.
//
// Migration convention (same one both bots already used): CREATE TABLE IF
// NOT EXISTS for everything, then `PRAGMA table_info(...)` checks with
// ALTER TABLE for columns added after a table already existed in
// production. There is no separate migration tooling.

const SHARED_TABLES = [
  'channel_config',
  'user_prefs',
  'schedules',
  'reminders',
  'player_changes',
  'player_guilds',
  'banned_players',
  'banned_users',
  'blocked_codes',
  'bot_messages',
  'channel_errors'
];

function initSharedSchema(db) {
  db.exec(`
    -- Channel config per guild
    CREATE TABLE IF NOT EXISTS channel_config (
      guild_id TEXT NOT NULL,
      config_key TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      PRIMARY KEY (guild_id, config_key)
    );

    -- User timezone preferences, scoped per-guild so each server a user
    -- belongs to can carry its own timezone. guild_id = '' is the user's
    -- global default (used for the dashboard's "All Servers" view and as
    -- a fallback for any guild that has no override of its own).
    CREATE TABLE IF NOT EXISTS user_prefs (
      user_id TEXT NOT NULL,
      guild_id TEXT NOT NULL DEFAULT '',
      timezone TEXT NOT NULL DEFAULT 'UTC',
      PRIMARY KEY (user_id, guild_id)
    );

    -- Scheduled messages
    -- recurrence_type is 'daily' | 'weekly' | 'interval' for recurring rows,
    -- NULL for one_time rows. interval_days/anchor_date only apply to
    -- 'interval' rows -- see features/scheduler.js for how those two turn
    -- into "fires every N days starting from a specific date" on top of a
    -- plain daily cron_expr, since cron itself can't express that.
    CREATE TABLE IF NOT EXISTS schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      channel_id TEXT,
      message TEXT NOT NULL,
      cron_expr TEXT NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      dst_follow INTEGER NOT NULL DEFAULT 1,
      one_time INTEGER NOT NULL DEFAULT 0,
      fire_at TEXT,
      label TEXT,
      created_by TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      active INTEGER NOT NULL DEFAULT 1,
      recurrence_type TEXT,
      interval_days INTEGER,
      anchor_date TEXT
    );

    -- Reminders (user pings)
    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      channel_id TEXT,
      user_id TEXT NOT NULL,
      message TEXT NOT NULL,
      fire_at TEXT NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      created_by TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      fired INTEGER NOT NULL DEFAULT 0
    );

    -- Player change history log
    CREATE TABLE IF NOT EXISTS player_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id TEXT NOT NULL,
      change_type TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      detected_at TEXT DEFAULT (datetime('now'))
    );

    -- Which guild(s) each player is registered/visible in. A player row can
    -- be shared across guilds (same real account tracked from two servers);
    -- redemption and scraping stay global, but rosters/reporting are scoped
    -- through this table so servers don't see each other's players.
    CREATE TABLE IF NOT EXISTS player_guilds (
      guild_id TEXT NOT NULL,
      player_id TEXT NOT NULL,
      added_by TEXT,
      added_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (guild_id, player_id)
    );

    -- Player IDs banned from being tracked in a specific server. A ban only
    -- blocks linking that player to *this* guild -- the player can still be
    -- tracked elsewhere, same scoping as player_guilds itself.
    CREATE TABLE IF NOT EXISTS banned_players (
      guild_id TEXT NOT NULL,
      player_id TEXT NOT NULL,
      reason TEXT,
      banned_by TEXT,
      banned_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (guild_id, player_id)
    );

    -- Discord users banned from using the bot in a specific server.
    CREATE TABLE IF NOT EXISTS banned_users (
      guild_id TEXT NOT NULL,
      discord_user_id TEXT NOT NULL,
      reason TEXT,
      banned_by TEXT,
      banned_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (guild_id, discord_user_id)
    );

    -- Gift codes deleted from the dashboard as mistakes (typos, misdetected
    -- text, etc). Global, not per-guild -- a mistaken code is wrong for
    -- every server, not just the one where it was noticed. Blocking stops
    -- it from ever being auto-detected, manually redeemed, or swept up by
    -- catch-up-on-add again.
    CREATE TABLE IF NOT EXISTS blocked_codes (
      code TEXT PRIMARY KEY,
      blocked_at TEXT DEFAULT (datetime('now'))
    );

    -- Every message the bot has proactively posted to a channel (scheduled
    -- messages, reminders, gift-code redemption summaries, new-player
    -- catch-up summaries, monitor alerts) -- lets the dashboard show and
    -- delete them, which matters most in servers the owner isn't personally
    -- a member of and so can't moderate by hand. message_id is Discord's own
    -- snowflake, needed to actually delete the message later.
    CREATE TABLE IF NOT EXISTS bot_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      message_type TEXT NOT NULL,
      preview TEXT,
      sent_at TEXT DEFAULT (datetime('now'))
    );

    -- Latest send failure per (guild, channel) -- e.g. Discord's "Missing
    -- Access" when the bot's role loses View Channel/Send Messages on a
    -- configured channel. Every failure previously only ever hit
    -- console.error, so a real incident (a gift-code summary silently never
    -- reaching one of four servers) was invisible without digging through
    -- hosting logs. UNIQUE(guild_id, channel_id) makes every log() call an
    -- upsert -- one row per broken channel showing its most recent error,
    -- not unbounded history -- and self-heals: trackSentMessage clears the
    -- row for a channel the instant a send to it succeeds again, so the
    -- dashboard only ever shows currently-unresolved problems.
    CREATE TABLE IF NOT EXISTS channel_errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      context TEXT NOT NULL,
      error_message TEXT NOT NULL,
      occurred_at TEXT DEFAULT (datetime('now')),
      UNIQUE(guild_id, channel_id)
    );
  `);

  // Migrate pre-existing user_prefs tables (from before per-guild timezones)
  // that don't have a guild_id column yet. Existing rows become each user's
  // global default (guild_id = '').
  const userPrefsCols = db.prepare(`PRAGMA table_info(user_prefs)`).all();
  if (!userPrefsCols.some(c => c.name === 'guild_id')) {
    db.exec(`
      ALTER TABLE user_prefs RENAME TO user_prefs_old;

      CREATE TABLE user_prefs (
        user_id TEXT NOT NULL,
        guild_id TEXT NOT NULL DEFAULT '',
        timezone TEXT NOT NULL DEFAULT 'UTC',
        PRIMARY KEY (user_id, guild_id)
      );

      INSERT INTO user_prefs (user_id, guild_id, timezone)
        SELECT user_id, '', timezone FROM user_prefs_old;

      DROP TABLE user_prefs_old;
    `);
    console.log('[DB] Migrated user_prefs to per-guild timezones');
  }

  // Migrate pre-existing schedules tables (from before the interval
  // recurrence type) that don't have recurrence_type yet. Old rows only
  // ever had 'daily' or 'weekly' cron_expr shapes -- 'M H * * *' vs
  // 'M H * * 0' -- so that's still a reliable way to backfill them once,
  // here, even though the app itself now sets recurrence_type explicitly
  // going forward instead of re-deriving it from cron_expr.
  const scheduleCols = db.prepare(`PRAGMA table_info(schedules)`).all();
  if (!scheduleCols.some(c => c.name === 'recurrence_type')) {
    db.exec(`
      ALTER TABLE schedules ADD COLUMN recurrence_type TEXT;
      ALTER TABLE schedules ADD COLUMN interval_days INTEGER;
      ALTER TABLE schedules ADD COLUMN anchor_date TEXT;

      UPDATE schedules SET recurrence_type = CASE
        WHEN cron_expr LIKE '% * * 0' THEN 'weekly'
        ELSE 'daily'
      END
      WHERE one_time = 0;
    `);
    console.log('[DB] Migrated schedules to explicit recurrence_type');
  }
}

module.exports = { initSharedSchema, SHARED_TABLES };
