const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openCoreTestDb } = require('./helpers/coreDb');

const { db, cleanup } = openCoreTestDb('queries');
process.on('exit', cleanup);

// ─── Player-Guild Links ─────────────────────────────────────────────────────

test('playerGuilds.link + isLinked', () => {
  db.players.add('P5', 'tester');
  db.playerGuilds.link('guildA', 'P5', 'tester');
  assert.equal(db.playerGuilds.isLinked('guildA', 'P5'), true);
  assert.equal(db.playerGuilds.isLinked('guildB', 'P5'), false);
});

test('playerGuilds.link across two guilds -- shared player row, two links', () => {
  db.players.add('P6', 'tester');
  db.playerGuilds.link('guildA', 'P6', 'tester');
  db.playerGuilds.link('guildB', 'P6', 'tester');
  const links = db.playerGuilds.getAllLinks().filter(l => l.player_id === 'P6');
  assert.deepEqual(links.map(l => l.guild_id).sort(), ['guildA', 'guildB']);
});

test('playerGuilds.getActivePlayerIds only returns players linked to the given guild IDs', () => {
  db.players.add('ACTIVE1', 'tester');
  db.players.add('INACTIVE1', 'tester');
  db.playerGuilds.link('activeGuild', 'ACTIVE1', 'tester');
  db.playerGuilds.link('departedGuild', 'INACTIVE1', 'tester');

  const active = db.playerGuilds.getActivePlayerIds(['activeGuild']);
  assert.ok(active.has('ACTIVE1'));
  assert.ok(!active.has('INACTIVE1'));
});

test('playerGuilds.getActivePlayerIds returns empty set for empty/missing guildIds', () => {
  assert.deepEqual(db.playerGuilds.getActivePlayerIds([]), new Set());
  assert.deepEqual(db.playerGuilds.getActivePlayerIds(null), new Set());
});

test('playerGuilds.unlink removes the link but keeps the player row if still linked elsewhere', () => {
  db.players.add('P7', 'tester');
  db.playerGuilds.link('guildA', 'P7', 'tester');
  db.playerGuilds.link('guildB', 'P7', 'tester');

  const result = db.playerGuilds.unlink('guildA', 'P7');
  assert.equal(result.fullyRemoved, false);
  assert.ok(db.players.getById('P7'));
  assert.equal(db.playerGuilds.isLinked('guildA', 'P7'), false);
  assert.equal(db.playerGuilds.isLinked('guildB', 'P7'), true);
});

test('playerGuilds.unlink deletes the shared player row once its last link is gone', () => {
  db.players.add('P8', 'tester');
  db.playerGuilds.link('guildA', 'P8', 'tester');

  const result = db.playerGuilds.unlink('guildA', 'P8');
  assert.equal(result.fullyRemoved, true);
  assert.equal(db.players.getById('P8'), undefined);
});

test('playerGuilds.getGuildsForPlayer returns every guild_id a player is linked to, [] when unlinked', () => {
  db.players.add('P9B', 'tester');
  db.playerGuilds.link('guildY', 'P9B', 'tester');
  db.playerGuilds.link('guildZ2', 'P9B', 'tester');
  assert.deepEqual(db.playerGuilds.getGuildsForPlayer('P9B').sort(), ['guildY', 'guildZ2']);
  assert.deepEqual(db.playerGuilds.getGuildsForPlayer('NOSUCHPLAYER'), []);
});

test('playerGuilds.removeEverywhere clears every guild link plus the shared player row', () => {
  db.players.add('P9C', 'tester');
  db.playerGuilds.link('guildM', 'P9C', 'tester');
  db.playerGuilds.link('guildN', 'P9C', 'tester');

  db.playerGuilds.removeEverywhere('P9C');

  assert.equal(db.players.getById('P9C'), undefined);
  assert.equal(db.playerGuilds.isLinked('guildM', 'P9C'), false);
  assert.equal(db.playerGuilds.isLinked('guildN', 'P9C'), false);
  assert.deepEqual(db.playerGuilds.getGuildsForPlayer('P9C'), []);
});

// ─── Bans ────────────────────────────────────────────────────────────────────

test('bannedPlayers ban/unban/isBanned/getForGuild are guild-scoped', () => {
  db.bannedPlayers.ban('guildA', 'BADPLAYER', 'spam', 'admin1');
  assert.equal(db.bannedPlayers.isBanned('guildA', 'BADPLAYER'), true);
  assert.equal(db.bannedPlayers.isBanned('guildB', 'BADPLAYER'), false);

  const list = db.bannedPlayers.getForGuild('guildA');
  assert.ok(list.some(b => b.player_id === 'BADPLAYER' && b.reason === 'spam'));

  db.bannedPlayers.unban('guildA', 'BADPLAYER');
  assert.equal(db.bannedPlayers.isBanned('guildA', 'BADPLAYER'), false);
});

test('bannedUsers ban/unban/isBanned/getForGuild are guild-scoped', () => {
  db.bannedUsers.ban('guildA', 'discordUser1', 'rude', 'admin1');
  assert.equal(db.bannedUsers.isBanned('guildA', 'discordUser1'), true);
  assert.equal(db.bannedUsers.isBanned('guildB', 'discordUser1'), false);

  const list = db.bannedUsers.getForGuild('guildA');
  assert.ok(list.some(b => b.discord_user_id === 'discordUser1' && b.reason === 'rude'));

  db.bannedUsers.unban('guildA', 'discordUser1');
  assert.equal(db.bannedUsers.isBanned('guildA', 'discordUser1'), false);
});

// ─── Schedules ───────────────────────────────────────────────────────────────

const baseSchedule = (overrides) => ({
  guild_id: 'schedGuild', channel_id: 'chan1', message: 'Hello', cron_expr: '0 9 * * *',
  timezone: 'UTC', dst_follow: true, one_time: false, fire_at: null, label: null,
  created_by: 'tester', recurrence_type: 'daily', ...overrides
});

test('schedules.add + getById + getAll + getAllActive', () => {
  const id = db.schedules.add(baseSchedule({ guild_id: 'schedGuild1', label: 'Morning' })).lastInsertRowid;
  const row = db.schedules.getById(id);
  assert.equal(row.message, 'Hello');
  assert.equal(row.cron_expr, '0 9 * * *');
  assert.equal(row.dst_follow, 1);
  assert.equal(row.active, 1);
  assert.ok(db.schedules.getAll('schedGuild1').some(s => s.id === id));
  assert.ok(db.schedules.getAllActive().some(s => s.id === id));
});

test('schedules.edit only updates allowed fields', () => {
  const id = db.schedules.add(baseSchedule({ guild_id: 'schedGuild2', message: 'Old' })).lastInsertRowid;
  db.schedules.edit(id, { message: 'New', guild_id: 'shouldNotChange' });
  const row = db.schedules.getById(id);
  assert.equal(row.message, 'New');
  assert.equal(row.guild_id, 'schedGuild2');
  assert.equal(db.schedules.edit(id, { guild_id: 'nope' }), null); // nothing allowed -> no-op
});

test('schedules.deactivate excludes it from getAll (active-only) but not getById', () => {
  const id = db.schedules.add(baseSchedule({ guild_id: 'schedGuild3' })).lastInsertRowid;
  db.schedules.deactivate(id);
  assert.ok(!db.schedules.getAll('schedGuild3').some(s => s.id === id));
  assert.ok(db.schedules.getById(id));
});

test('schedules.delete removes the row entirely', () => {
  const id = db.schedules.add(baseSchedule({ guild_id: 'schedGuild4' })).lastInsertRowid;
  db.schedules.delete(id);
  assert.equal(db.schedules.getById(id), undefined);
});

// ─── Reminders ───────────────────────────────────────────────────────────────

const baseReminder = (overrides) => ({
  guild_id: 'remGuild', channel_id: 'chan1', user_id: 'user1', message: 'Do the thing',
  fire_at: '2026-01-01T00:00:00.000Z', timezone: 'UTC', created_by: 'tester', ...overrides
});

test('reminders.add + getById + getAll + getPending', () => {
  const id = db.reminders.add(baseReminder({ guild_id: 'remGuild1' })).lastInsertRowid;
  const row = db.reminders.getById(id);
  assert.equal(row.message, 'Do the thing');
  assert.equal(row.fired, 0);
  assert.ok(db.reminders.getAll('remGuild1').some(r => r.id === id));
  assert.ok(db.reminders.getPending().some(r => r.id === id));
});

test('reminders.markFired excludes it from getPending and getAll', () => {
  const id = db.reminders.add(baseReminder({ guild_id: 'remGuild2' })).lastInsertRowid;
  db.reminders.markFired(id);
  assert.ok(!db.reminders.getPending().some(r => r.id === id));
  assert.ok(!db.reminders.getAll('remGuild2').some(r => r.id === id));
});

test('reminders.delete removes the row; edit only updates allowed fields', () => {
  const id = db.reminders.add(baseReminder({ guild_id: 'remGuild4', message: 'Old message' })).lastInsertRowid;
  db.reminders.edit(id, { message: 'New message', guild_id: 'shouldNotChange' });
  const row = db.reminders.getById(id);
  assert.equal(row.message, 'New message');
  assert.equal(row.guild_id, 'remGuild4');

  db.reminders.delete(id);
  assert.equal(db.reminders.getById(id), undefined);
});

// ─── Channel Config ──────────────────────────────────────────────────────────

test('channels set/get/getAll, set overwrites (INSERT OR REPLACE)', () => {
  db.channels.set('guildA', 'giftcode', 'chan1');
  db.channels.set('guildA', 'monitor', 'chan2');
  assert.equal(db.channels.get('guildA', 'giftcode'), 'chan1');
  assert.equal(db.channels.get('guildA', 'nonexistent'), null);
  assert.equal(db.channels.getAll('guildA').length, 2);

  db.channels.set('guildA', 'giftcode', 'chanNew');
  assert.equal(db.channels.get('guildA', 'giftcode'), 'chanNew');
});

// ─── User Prefs ──────────────────────────────────────────────────────────────

test('userPrefs.setTimezone + getTimezone, per-guild override with global fallback, UTC default', () => {
  assert.equal(db.userPrefs.getTimezone('brandNewUser', 'anyGuild'), 'UTC');

  db.userPrefs.setTimezone('user1', '', 'America/New_York');
  assert.equal(db.userPrefs.getTimezone('user1', 'someGuild'), 'America/New_York');

  db.userPrefs.setTimezone('user1', 'someGuild', 'Europe/London');
  assert.equal(db.userPrefs.getTimezone('user1', 'someGuild'), 'Europe/London');
  assert.equal(db.userPrefs.getTimezone('user1', 'otherGuild'), 'America/New_York');
});

// ─── Blocked Codes ───────────────────────────────────────────────────────────

test('blockedCodes.block + isBlocked, block is idempotent', () => {
  assert.equal(db.blockedCodes.isBlocked('NEVERBLOCKED'), false);
  db.blockedCodes.block('BADCODE');
  db.blockedCodes.block('BADCODE');
  assert.equal(db.blockedCodes.isBlocked('BADCODE'), true);
});

// ─── Bot Messages ────────────────────────────────────────────────────────────

test('botMessages.log + getById + existsByMessageId + getRecent + remove', () => {
  db.botMessages.log('guildM', 'chanM', 'msg123', 'giftcode_summary', 'preview text');
  const rows = db.botMessages.getRecent(100, 'guildM');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].message_id, 'msg123');
  assert.equal(rows[0].preview, 'preview text');
  assert.ok(rows[0].sent_at); // defaulted to datetime('now')

  assert.ok(db.botMessages.getById(rows[0].id));
  assert.equal(db.botMessages.existsByMessageId('msg123'), true);
  assert.equal(db.botMessages.existsByMessageId('msg-does-not-exist'), false);

  db.botMessages.remove(rows[0].id);
  assert.equal(db.botMessages.getById(rows[0].id), undefined);
});

test('botMessages.log accepts an explicit historical sent_at (for backfill)', () => {
  db.botMessages.log('guildH', 'chanH', 'msgH', 'giftcode_summary', 'old', '2025-01-02 03:04:05');
  const row = db.botMessages.getRecent(100, 'guildH')[0];
  assert.equal(row.sent_at, '2025-01-02 03:04:05');
});

test('botMessages.getRecent is guild-scoped, omitting guild_id returns everything', () => {
  db.botMessages.log('guildP', 'c1', 'mp1', 'player_monitor', 'p1');
  db.botMessages.log('guildQ', 'c2', 'mq1', 'player_monitor', 'q1');
  assert.ok(db.botMessages.getRecent(100, 'guildP').every(r => r.guild_id === 'guildP'));
  const all = db.botMessages.getRecent(100);
  assert.ok(all.some(r => r.guild_id === 'guildP'));
  assert.ok(all.some(r => r.guild_id === 'guildQ'));
});

// ─── Channel Errors ──────────────────────────────────────────────────────────

test('channelErrors.log upserts one row per (guild, channel), keeping the latest error', () => {
  db.channelErrors.log('guildCE', 'chanCE', 'giftcode_summary', 'Missing Access');
  db.channelErrors.log('guildCE', 'chanCE', 'giftcode_retry_summary', 'Missing Access (again)');
  const rows = db.channelErrors.getRecent(100, 'guildCE');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].context, 'giftcode_retry_summary');
  assert.equal(rows[0].error_message, 'Missing Access (again)');
});

test('channelErrors.clear removes the row; getRecent is guild-scoped, omitting guild_id returns everything', () => {
  db.channelErrors.log('guildCE2', 'chanCE2', 'scheduled_message', 'Unknown Channel');
  assert.equal(db.channelErrors.getRecent(100, 'guildCE2').length, 1);
  db.channelErrors.clear('guildCE2', 'chanCE2');
  assert.equal(db.channelErrors.getRecent(100, 'guildCE2').length, 0);

  db.channelErrors.log('guildCE3', 'c1', 'reminder', 'boom');
  db.channelErrors.log('guildCE4', 'c2', 'reminder', 'boom');
  assert.ok(db.channelErrors.getRecent(100, 'guildCE3').every(r => r.guild_id === 'guildCE3'));
  const all = db.channelErrors.getRecent(100);
  assert.ok(all.some(r => r.guild_id === 'guildCE3') && all.some(r => r.guild_id === 'guildCE4'));
});

// ─── Player Changes ──────────────────────────────────────────────────────────

test('playerChanges.log + getRecent unscoped, guild-scoping joins through player_guilds', () => {
  db.playerChanges.log('CP1', 'level', '10', '20');
  assert.ok(db.playerChanges.getRecent(50).some(c => c.player_id === 'CP1' && c.change_type === 'level'));

  db.players.add('CGA', 'tester');
  db.playerGuilds.link('cGuildA', 'CGA', 'tester');
  db.players.add('CGB', 'tester');
  db.playerGuilds.link('cGuildB', 'CGB', 'tester');
  db.playerChanges.log('CGA', 'nickname', 'Old', 'New');
  db.playerChanges.log('CGB', 'nickname', 'Old2', 'New2');

  const scopedToA = db.playerChanges.getRecent(50, 'cGuildA');
  assert.ok(scopedToA.some(c => c.player_id === 'CGA'));
  assert.ok(!scopedToA.some(c => c.player_id === 'CGB'));
});
