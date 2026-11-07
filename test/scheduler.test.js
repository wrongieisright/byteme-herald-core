const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DateTime } = require('luxon');
const { openCoreTestDb } = require('./helpers/coreDb');
const { createBotMessages } = require('../features/botMessages');
const schedulerModule = require('../features/scheduler');

const { db, cleanup } = openCoreTestDb('scheduler');
process.on('exit', cleanup);

const scheduler = schedulerModule.createScheduler({ db, botMessages: createBotMessages({ db }) });

// ─── pure helpers are exported standalone too ───────────────────────────────

test('the pure datetime/cron helpers are exported without needing a db', () => {
  assert.equal(schedulerModule.buildCronExpr('09:30', 'daily'), '30 9 * * *');
  assert.equal(schedulerModule.isValidTimezone('UTC'), true);
  assert.equal(typeof schedulerModule.createScheduler, 'function');
});

// ─── isValidTimezone / searchTimezones ──────────────────────────────────────

test('isValidTimezone: accepts UTC and real IANA zones, rejects a made-up name', () => {
  assert.equal(scheduler.isValidTimezone('UTC'), true);
  assert.equal(scheduler.isValidTimezone('America/New_York'), true);
  assert.equal(scheduler.isValidTimezone('Europe/London'), true);
  assert.equal(scheduler.isValidTimezone('Not/A_Real_Zone'), false);
});

test('searchTimezones: empty query returns up to 25, prefix matches rank first, capped at 25', () => {
  const empty = scheduler.searchTimezones('');
  assert.ok(empty.length > 0 && empty.length <= 25);
  const results = scheduler.searchTimezones('america/new');
  assert.ok(results.indexOf('America/New_York') < 5);
  assert.ok(scheduler.searchTimezones('a').length <= 25);
});

// ─── parseDateTime / isInFuture ─────────────────────────────────────────────

test('parseDateTime: accepts "yyyy-MM-dd HH:mm" and the T-separated form in a timezone, null when unparseable', () => {
  assert.match(scheduler.parseDateTime('2026-04-25 18:00', 'America/New_York'), /2026-04-25T22:00/);
  assert.match(scheduler.parseDateTime('2026-04-25T18:00', 'UTC'), /2026-04-25T18:00/);
  assert.equal(scheduler.parseDateTime('not a date', 'UTC'), null);
});

test('isInFuture: future is true, past and the current instant are false', () => {
  assert.equal(scheduler.isInFuture(DateTime.utc().plus({ minutes: 5 }).toISO()), true);
  assert.equal(scheduler.isInFuture(DateTime.utc().minus({ minutes: 5 }).toISO()), false);
  assert.equal(scheduler.isInFuture(DateTime.utc().toISO()), false);
});

// ─── buildCronExpr ──────────────────────────────────────────────────────────

test('buildCronExpr: daily / weekly (default Sunday, explicit day) / interval shapes', () => {
  assert.equal(scheduler.buildCronExpr('09:30', 'daily'), '30 9 * * *');
  assert.equal(scheduler.buildCronExpr('09:30', 'weekly'), '30 9 * * 0');
  assert.equal(scheduler.buildCronExpr('09:30', 'weekly', 3), '30 9 * * 3');
  assert.equal(scheduler.buildCronExpr('09:30', 'weekly', 6), '30 9 * * 6');
  assert.equal(scheduler.buildCronExpr('09:30', 'interval'), '30 9 * * *');
});

test('buildCronExpr: rejects an out-of-range/non-integer dayOfWeek, unknown recurrence, unparseable time', () => {
  assert.equal(scheduler.buildCronExpr('09:30', 'weekly', 7), null);
  assert.equal(scheduler.buildCronExpr('09:30', 'weekly', -1), null);
  assert.equal(scheduler.buildCronExpr('09:30', 'weekly', 'Wednesday'), null);
  assert.equal(scheduler.buildCronExpr('09:30', 'monthly'), null);
  assert.equal(scheduler.buildCronExpr('not-a-time', 'daily'), null);
});

// ─── buildIntervalSchedule ──────────────────────────────────────────────────

test('buildIntervalSchedule: returns fireAtUtc, a LOCAL-date anchor_date, and a cron_expr shaped by recurrenceType/dayOfWeek', () => {
  const basic = scheduler.buildIntervalSchedule('2026-04-25 09:30', 'UTC');
  assert.match(basic.fireAtUtc, /2026-04-25T09:30/);
  assert.equal(basic.anchor_date, '2026-04-25');
  assert.equal(basic.cron_expr, '30 9 * * *');

  // 23:30 in New York on April 25th is already April 26th UTC -- anchor stays local.
  const local = scheduler.buildIntervalSchedule('2026-04-25 23:30', 'America/New_York');
  assert.equal(local.anchor_date, '2026-04-25');
  assert.match(local.fireAtUtc, /2026-04-26T/);

  assert.equal(scheduler.buildIntervalSchedule('2026-04-25 09:30', 'UTC', 'weekly').cron_expr, '30 9 * * 0');
  assert.equal(scheduler.buildIntervalSchedule('2026-04-25 09:30', 'UTC', 'weekly', 5).cron_expr, '30 9 * * 5');
  assert.equal(scheduler.buildIntervalSchedule('garbage', 'UTC'), null);
});

// ─── nextFireTime ───────────────────────────────────────────────────────────

test('nextFireTime: every-N-days schedule -- today\'s tick if still ahead, else the next qualifying day', () => {
  // Every 2 days from 2026-09-30 at 20:50 New York (the shape the dashboard's
  // "from 2026-09-30" row hides the next send of).
  const s = { cron_expr: '50 20 * * *', timezone: 'America/New_York', dst_follow: 1, anchor_date: '2026-09-30', interval_days: 2 };
  const before = DateTime.fromISO('2026-09-30T20:00:00', { zone: 'America/New_York' });
  assert.equal(scheduler.nextFireTime(s, before), '2026-10-01T00:50:00.000Z');
  const after = DateTime.fromISO('2026-09-30T21:00:00', { zone: 'America/New_York' });
  assert.equal(scheduler.nextFireTime(s, after), '2026-10-03T00:50:00.000Z');
  // An off day skips straight to the next on-day.
  const offDay = DateTime.fromISO('2026-10-01T09:00:00', { zone: 'America/New_York' });
  assert.equal(scheduler.nextFireTime(s, offDay), '2026-10-03T00:50:00.000Z');
});

test('nextFireTime: the next send crosses a DST change at the schedule\'s local wall-clock time', () => {
  // New York leaves DST on 2026-11-01. Every 2 days from 10-30: 10-30 (EDT), 11-01 (EST).
  const s = { cron_expr: '50 20 * * *', timezone: 'America/New_York', dst_follow: 1, anchor_date: '2026-10-30', interval_days: 2 };
  const now = DateTime.fromISO('2026-10-30T21:00:00', { zone: 'America/New_York' });
  assert.equal(scheduler.nextFireTime(s, now), '2026-11-02T01:50:00.000Z');
});

test('nextFireTime: daily and weekly schedules, with and without a first-send date', () => {
  const now = DateTime.fromISO('2026-10-01T12:00:00Z'); // a Thursday
  const daily = { cron_expr: '0 9 * * *', timezone: 'UTC', dst_follow: 1 };
  assert.equal(scheduler.nextFireTime(daily, now), '2026-10-02T09:00:00.000Z');
  const later = { cron_expr: '0 15 * * *', timezone: 'UTC', dst_follow: 1 };
  assert.equal(scheduler.nextFireTime(later, now), '2026-10-01T15:00:00.000Z');
  const wednesday = { cron_expr: '30 9 * * 3', timezone: 'UTC', dst_follow: 1 };
  assert.equal(scheduler.nextFireTime(wednesday, now), '2026-10-07T09:30:00.000Z');
  const sunday = { cron_expr: '30 9 * * 0', timezone: 'UTC', dst_follow: 1 };
  assert.equal(scheduler.nextFireTime(sunday, now), '2026-10-04T09:30:00.000Z');
  const held = { cron_expr: '0 9 * * *', timezone: 'UTC', dst_follow: 1, anchor_date: '2026-10-20' };
  assert.equal(scheduler.nextFireTime(held, now), '2026-10-20T09:00:00.000Z');
});

test('nextFireTime: a schedule pinned to UTC ticks its cron time in UTC, as scheduleJob runs it', () => {
  const pinned = { cron_expr: '0 9 * * *', timezone: 'America/New_York', dst_follow: 0 };
  const now = DateTime.fromISO('2026-10-01T08:00:00Z');
  assert.equal(scheduler.nextFireTime(pinned, now), '2026-10-01T09:00:00.000Z');
  const following = { ...pinned, dst_follow: 1 };
  assert.equal(scheduler.nextFireTime(following, now), '2026-10-01T13:00:00.000Z');
});

test('nextFireTime: one-time schedules return their fire_at while it is ahead, null once passed; junk returns null', () => {
  const now = DateTime.fromISO('2026-10-01T12:00:00Z');
  assert.equal(scheduler.nextFireTime({ one_time: 1, fire_at: '2026-10-02T12:00:00.000Z' }, now), '2026-10-02T12:00:00.000Z');
  assert.equal(scheduler.nextFireTime({ one_time: 1, fire_at: '2026-09-30T12:00:00.000Z' }, now), null);
  assert.equal(scheduler.nextFireTime({ one_time: 1, fire_at: null }, now), null);
  assert.equal(scheduler.nextFireTime({ cron_expr: 'garbage', timezone: 'UTC', dst_follow: 1 }, now), null);
  assert.equal(scheduler.nextFireTime({ cron_expr: '0 9 * * *', timezone: 'Not/A_Zone', dst_follow: 1 }, now), null);
  assert.equal(schedulerModule.nextFireTime({ cron_expr: '0 9 * * *', timezone: 'UTC', dst_follow: 1 }, now), '2026-10-02T09:00:00.000Z');
});

// ─── pinScheduleToUtc ───────────────────────────────────────────────────────

test('pinScheduleToUtc: converts the typed local time to UTC at today\'s offset and stores the schedule in UTC', () => {
  const winter = DateTime.fromISO('2026-11-07T12:00:00', { zone: 'America/New_York' }); // EST, UTC-5
  assert.deepEqual(scheduler.pinScheduleToUtc('19:50', 'America/New_York', 'daily', 0, winter), {
    cron_expr: '50 0 * * *', anchor_date: null, fireAtUtc: '2026-11-08T00:50:00.000Z', timezone: 'UTC', dst_follow: false
  });
  const summer = DateTime.fromISO('2026-07-01T12:00:00', { zone: 'America/New_York' }); // EDT, UTC-4
  assert.equal(scheduler.pinScheduleToUtc('20:50', 'America/New_York', 'daily', 0, summer).cron_expr, '50 0 * * *');
  // What the old pinned path did with 20:50 New York: ran it at 20:50 UTC.
  assert.notEqual(scheduler.pinScheduleToUtc('20:50', 'America/New_York', 'daily', 0, winter).cron_expr, '50 20 * * *');
});

test('pinScheduleToUtc: a first-send date, a weekly across midnight, a UTC input, and junk', () => {
  const winter = DateTime.fromISO('2026-11-07T12:00:00', { zone: 'America/New_York' });
  const interval = scheduler.pinScheduleToUtc('2026-11-08 19:50', 'America/New_York', 'interval', 0, winter);
  assert.equal(interval.cron_expr, '50 0 * * *');
  assert.equal(interval.anchor_date, '2026-11-09');
  assert.equal(interval.fireAtUtc, '2026-11-09T00:50:00.000Z');
  // Sunday 20:50 New York is Monday 01:50 UTC.
  assert.equal(scheduler.pinScheduleToUtc('20:50', 'America/New_York', 'weekly', 0, winter).cron_expr, '50 1 * * 1');
  // Wednesday 09:00 Berlin stays Wednesday.
  assert.equal(scheduler.pinScheduleToUtc('09:00', 'Europe/Berlin', 'weekly', 3, winter).cron_expr, '0 8 * * 3');
  assert.equal(scheduler.pinScheduleToUtc('00:50', 'UTC', 'daily', 0, winter).cron_expr, '50 0 * * *');
  assert.equal(scheduler.pinScheduleToUtc('garbage', 'UTC'), null);
  assert.equal(scheduler.pinScheduleToUtc('09:00', 'Not/A_Zone'), null);
  assert.equal(scheduler.pinScheduleToUtc('09:00', 'UTC', 'weekly', 9), null);
});

// ─── shiftSchedule ──────────────────────────────────────────────────────────

test('shiftSchedule: moves the time of day, carrying the anchor date and weekday across midnight', () => {
  const bear = { cron_expr: '50 20 * * *', timezone: 'America/New_York', dst_follow: 1, anchor_date: '2026-09-30', interval_days: 2 };
  assert.deepEqual(scheduler.shiftSchedule(bear, -1), { cron_expr: '50 19 * * *', anchor_date: '2026-09-30' });
  assert.deepEqual(scheduler.shiftSchedule(bear, 1), { cron_expr: '50 21 * * *', anchor_date: '2026-09-30' });
  const early = { cron_expr: '30 0 * * *', timezone: 'America/New_York', dst_follow: 1, anchor_date: '2026-10-03', interval_days: 2 };
  assert.deepEqual(scheduler.shiftSchedule(early, -1), { cron_expr: '30 23 * * *', anchor_date: '2026-10-02' });
  const daily = { cron_expr: '59 19 * * *', timezone: 'America/New_York', dst_follow: 1 };
  assert.deepEqual(scheduler.shiftSchedule(daily, -1), { cron_expr: '59 18 * * *', anchor_date: null });
  const sunday = { cron_expr: '30 23 * * 0', timezone: 'UTC', dst_follow: 1 };
  assert.deepEqual(scheduler.shiftSchedule(sunday, 1), { cron_expr: '30 0 * * 1', anchor_date: null });
  const monday = { cron_expr: '30 0 * * 1', timezone: 'UTC', dst_follow: 1 };
  assert.deepEqual(scheduler.shiftSchedule(monday, -1), { cron_expr: '30 23 * * 0', anchor_date: null });
});

test('shiftSchedule: the shifted schedule\'s next send is exactly the old one moved by that many hours', () => {
  const now = DateTime.fromISO('2026-11-07T12:00:00Z');
  const s = { cron_expr: '50 20 * * *', timezone: 'America/New_York', dst_follow: 1, anchor_date: '2026-09-30', interval_days: 2 };
  const before = DateTime.fromISO(scheduler.nextFireTime(s, now));
  const after = DateTime.fromISO(scheduler.nextFireTime({ ...s, ...scheduler.shiftSchedule(s, -1) }, now));
  assert.equal(after.toISO(), before.minus({ hours: 1 }).toISO());
});

test('shiftSchedule: null for one-time schedules, a zero shift and an unreadable cron', () => {
  assert.equal(scheduler.shiftSchedule({ one_time: 1, fire_at: '2026-12-01T00:00:00.000Z' }, 1), null);
  assert.equal(scheduler.shiftSchedule({ cron_expr: '0 9 * * *', timezone: 'UTC', dst_follow: 1 }, 0), null);
  assert.equal(scheduler.shiftSchedule({ cron_expr: 'garbage', timezone: 'UTC', dst_follow: 1 }, 1), null);
});

// ─── shouldFireInterval ─────────────────────────────────────────────────────

test('shouldFireInterval: no anchor always fires; future anchor holds; past anchor fires daily; interval_days gates every N days', () => {
  assert.equal(scheduler.shouldFireInterval({ timezone: 'UTC' }), true);
  assert.equal(scheduler.shouldFireInterval({ timezone: 'UTC', anchor_date: '2099-01-01' }, DateTime.fromISO('2026-06-01T12:00:00Z')), false);

  const daily = { timezone: 'UTC', anchor_date: '2026-06-01' };
  assert.equal(scheduler.shouldFireInterval(daily, DateTime.fromISO('2026-06-01T12:00:00Z')), true);
  assert.equal(scheduler.shouldFireInterval(daily, DateTime.fromISO('2026-06-05T12:00:00Z')), true);

  const every3 = { timezone: 'UTC', anchor_date: '2026-06-01', interval_days: 3 };
  assert.equal(scheduler.shouldFireInterval(every3, DateTime.fromISO('2026-06-01T12:00:00Z')), true);
  assert.equal(scheduler.shouldFireInterval(every3, DateTime.fromISO('2026-06-02T12:00:00Z')), false);
  assert.equal(scheduler.shouldFireInterval(every3, DateTime.fromISO('2026-06-04T12:00:00Z')), true);
});

// ─── formatting helpers ─────────────────────────────────────────────────────

test('formatTimeDisplay: UTC shows just UTC, other zones show local alongside UTC', () => {
  assert.equal(scheduler.formatTimeDisplay('2026-04-25T22:00:00.000Z', 'UTC'), '22:00 UTC');
  const display = scheduler.formatTimeDisplay('2026-04-25T22:00:00.000Z', 'America/New_York');
  assert.match(display, /6:00 PM/);
  assert.match(display, /22:00 UTC/);
});

test('formatFireAtForEdit: round-trips through parseDateTime, empty for falsy, defaults to UTC', () => {
  const fireAt = scheduler.parseDateTime('2026-04-25 18:00', 'America/New_York');
  const edit = scheduler.formatFireAtForEdit(fireAt, 'America/New_York');
  assert.equal(edit, '2026-04-25 18:00');
  assert.equal(scheduler.parseDateTime(edit, 'America/New_York'), fireAt);
  assert.equal(scheduler.formatFireAtForEdit(null, 'UTC'), '');
  assert.equal(scheduler.formatFireAtForEdit('2026-04-25T18:00:00.000Z', null), '2026-04-25 18:00');
});

test('getEditableTime: one-time -> fire_at; recurring -> HH:mm, with anchor_date prefixed when set', () => {
  assert.equal(scheduler.getEditableTime({ one_time: 1, fire_at: '2026-04-25T18:00:00.000Z', timezone: 'UTC' }), '2026-04-25 18:00');
  assert.equal(scheduler.getEditableTime({ one_time: 0, cron_expr: '30 9 * * *', timezone: 'UTC' }), '09:30');
  assert.equal(scheduler.getEditableTime({ one_time: 0, cron_expr: '0 18 * * 0', timezone: 'UTC' }), '18:00');
  assert.equal(scheduler.getEditableTime({ one_time: 0, cron_expr: '30 9 * * *', timezone: 'UTC', anchor_date: '2026-04-25' }), '2026-04-25 09:30');
});

// ─── checkOneTimeSchedules / checkPendingReminders ─────────────────────────

function makeFakeClient(sentMessages) {
  return {
    channels: {
      fetch: async (channelId) => ({
        send: async (content) => {
          const sent = { guildId: 'schedGuild', channelId, id: `msg-${sentMessages.length}`, content };
          sentMessages.push(sent);
          return sent;
        }
      })
    }
  };
}

const brokenClient = { channels: { fetch: async () => ({ send: async () => { throw new Error('Missing Access'); } }) } };

const oneTime = (overrides) => ({
  guild_id: 'schedGuild', channel_id: 'chanExplicit', message: 'hello there',
  cron_expr: '0 0 1 1 *', timezone: 'UTC', dst_follow: false, one_time: true,
  fire_at: DateTime.utc().minus({ minutes: 1 }).toISO(), label: null, created_by: 'test', ...overrides
});

test('checkOneTimeSchedules: fires a due schedule with an explicit channel and deactivates it', async () => {
  const id = db.schedules.add(oneTime()).lastInsertRowid;
  const sent = [];
  await scheduler.checkOneTimeSchedules(makeFakeClient(sent));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].content, 'hello there');
  assert.equal(db.schedules.getById(id).active, 0);
});

test('checkOneTimeSchedules: a due schedule with NO channel configured is left active and nothing is sent', async () => {
  const id = db.schedules.add(oneTime({ guild_id: 'schedGuildNoChannel', channel_id: null })).lastInsertRowid;
  const sent = [];
  await scheduler.checkOneTimeSchedules(makeFakeClient(sent));
  assert.equal(sent.length, 0);
  assert.equal(db.schedules.getById(id).active, 1);
});

test('checkOneTimeSchedules: a schedule overdue by more than 2 minutes still fires (no catch-up ceiling)', async () => {
  const id = db.schedules.add(oneTime({ message: 'very late', fire_at: DateTime.utc().minus({ minutes: 45 }).toISO() })).lastInsertRowid;
  const sent = [];
  await scheduler.checkOneTimeSchedules(makeFakeClient(sent));
  assert.equal(sent.length, 1);
  assert.equal(db.schedules.getById(id).active, 0);
});

test('checkOneTimeSchedules: falls back to the guild\'s default "schedules" channel', async () => {
  db.channels.set('schedGuildDefault', 'schedules', 'chanDefault');
  db.schedules.add(oneTime({ guild_id: 'schedGuildDefault', channel_id: null }));
  const sent = [];
  await scheduler.checkOneTimeSchedules(makeFakeClient(sent));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].channelId, 'chanDefault');
});

test('checkOneTimeSchedules: a send failure is caught and logged to channel_errors, schedule stays active', async () => {
  const id = db.schedules.add(oneTime({ guild_id: 'schedBrokenGuild2', channel_id: 'brokenChan2' })).lastInsertRowid;
  await assert.doesNotReject(scheduler.checkOneTimeSchedules(brokenClient));
  assert.equal(db.schedules.getById(id).active, 1);
  const errors = db.channelErrors.getRecent(100, 'schedBrokenGuild2');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].channel_id, 'brokenChan2');
  assert.equal(errors[0].context, 'one_time_schedule');
});

const reminder = (overrides) => ({
  guild_id: 'schedGuild', channel_id: 'chanExplicit', user_id: 'user1', message: 'do the thing',
  fire_at: DateTime.utc().minus({ minutes: 1 }).toISO(), timezone: 'UTC', created_by: 'test', ...overrides
});

test('checkPendingReminders: fires a due reminder with an explicit channel and marks it fired', async () => {
  const id = db.reminders.add(reminder()).lastInsertRowid;
  const sent = [];
  await scheduler.checkPendingReminders(makeFakeClient(sent));
  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /<@user1>/);
  assert.equal(db.reminders.getById(id).fired, 1);
});

test('checkPendingReminders: a due reminder with NO channel configured is left pending', async () => {
  const id = db.reminders.add(reminder({ guild_id: 'schedGuildNoChannel', channel_id: null })).lastInsertRowid;
  const sent = [];
  await scheduler.checkPendingReminders(makeFakeClient(sent));
  assert.equal(sent.length, 0);
  assert.equal(db.reminders.getById(id).fired, 0);
});

test('checkPendingReminders: a send failure is caught and logged to channel_errors, reminder stays pending', async () => {
  const id = db.reminders.add(reminder({ guild_id: 'schedBrokenGuild3', channel_id: 'brokenChan3' })).lastInsertRowid;
  await assert.doesNotReject(scheduler.checkPendingReminders(brokenClient));
  assert.equal(db.reminders.getById(id).fired, 0);
  const errors = db.channelErrors.getRecent(100, 'schedBrokenGuild3');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].context, 'reminder');
});

// ─── fireScheduledJob ───────────────────────────────────────────────────────
// Regression coverage for the "DST re-check bug" -- see the comment in
// createScheduler().scheduleJob for the full story. These would have failed
// under the old logic and pass now.

test('fireScheduledJob: a dst_follow schedule in a non-UTC timezone actually sends (the reported bug)', async () => {
  const sent = [];
  await scheduler.fireScheduledJob({ id: 101, guild_id: 'schedGuild', channel_id: 'chanExplicit', message: 'daily reminder', dst_follow: 1, timezone: 'America/New_York', cron_expr: '0 8 * * *', one_time: 0 }, makeFakeClient(sent));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].content, 'daily reminder');
});

test('fireScheduledJob: falls back to the default "schedules" channel; no channel -> nothing sent, no throw', async () => {
  db.channels.set('schedGuildDefault2', 'schedules', 'chanDefault2');
  const sent = [];
  await scheduler.fireScheduledJob({ id: 102, guild_id: 'schedGuildDefault2', channel_id: null, message: 'x', dst_follow: 1, timezone: 'America/New_York', cron_expr: '30 14 * * *', one_time: 0 }, makeFakeClient(sent));
  assert.equal(sent[0].channelId, 'chanDefault2');

  const none = [];
  await scheduler.fireScheduledJob({ id: 103, guild_id: 'schedGuildNoChannel2', channel_id: null, message: 'x', dst_follow: 1, timezone: 'UTC', cron_expr: '0 9 * * *', one_time: 0 }, makeFakeClient(none));
  assert.equal(none.length, 0);
});

test('fireScheduledJob: an interval schedule not due today does not send', async () => {
  const sent = [];
  await scheduler.fireScheduledJob({ id: 104, guild_id: 'schedGuild', channel_id: 'chanExplicit', message: 'every 3 days', dst_follow: 1, timezone: 'UTC', cron_expr: '0 9 * * *', one_time: 0, interval_days: 3, anchor_date: DateTime.utc().plus({ days: 1 }).toFormat('yyyy-MM-dd') }, makeFakeClient(sent));
  assert.equal(sent.length, 0);
});

test('fireScheduledJob: a send failure is caught and logged to channel_errors', async () => {
  await assert.doesNotReject(scheduler.fireScheduledJob({ id: 105, guild_id: 'schedBrokenGuild', channel_id: 'brokenChan', message: 'x', dst_follow: 1, timezone: 'UTC', cron_expr: '0 9 * * *', one_time: 0 }, brokenClient));
  const errors = db.channelErrors.getRecent(100, 'schedBrokenGuild');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].context, 'scheduled_message');
  assert.match(errors[0].error_message, /Missing Access/);
});

// ─── scheduleJob / cancelJob / loadAllSchedules / one-time checker ─────────

test('scheduleJob registers a cron task and cancelJob stops it; loadAllSchedules only schedules recurring rows', () => {
  const id = db.schedules.add({ guild_id: 'cronGuild', channel_id: 'c', message: 'm', cron_expr: '0 9 * * *', timezone: 'UTC', dst_follow: true, one_time: false, fire_at: null, label: null, created_by: 't', recurrence_type: 'daily' }).lastInsertRowid;
  db.schedules.add(oneTime({ guild_id: 'cronGuild', fire_at: '2099-01-01T00:00:00.000Z' }));

  assert.doesNotThrow(() => scheduler.loadAllSchedules({}));
  assert.doesNotThrow(() => scheduler.cancelJob(id));
  assert.doesNotThrow(() => scheduler.cancelJob(999999)); // unknown id is a no-op
  // Stop any other cron tasks loadAllSchedules registered so the process can exit.
  for (const s of db.schedules.getAllActive()) scheduler.cancelJob(s.id);
});

test('startOneTimeChecker / stopOneTimeChecker manage the 60s timer without leaking it', () => {
  scheduler.startOneTimeChecker(makeFakeClient([]));
  assert.doesNotThrow(() => scheduler.stopOneTimeChecker());
  assert.doesNotThrow(() => scheduler.stopOneTimeChecker()); // idempotent
});

// ─── sendScheduleNow / sendReminderNow (Test Send) ─────────────────────────

test('sendScheduleNow: sends but does NOT deactivate; throws when no channel resolves', async () => {
  const id = db.schedules.add({ guild_id: 'schedGuild', channel_id: 'chanExplicit', message: 'test send me', cron_expr: '30 9 * * *', timezone: 'UTC', dst_follow: true, one_time: false, fire_at: null, label: null, created_by: 'test', recurrence_type: 'daily' }).lastInsertRowid;
  const sent = [];
  const { channelId } = await scheduler.sendScheduleNow(makeFakeClient(sent), db.schedules.getById(id));
  assert.equal(channelId, 'chanExplicit');
  assert.equal(sent[0].content, 'test send me');
  assert.equal(db.schedules.getById(id).active, 1);
  assert.ok(db.botMessages.getRecent(100, 'schedGuild').some(r => r.message_type === 'scheduled_test'));

  await assert.rejects(scheduler.sendScheduleNow(makeFakeClient([]), { id: 999, guild_id: 'schedGuildNoChannel', channel_id: null, message: 'x' }));
});

test('sendReminderNow: sends but does NOT mark fired; throws when no channel resolves', async () => {
  const id = db.reminders.add(reminder({ message: 'test send reminder', fire_at: DateTime.utc().plus({ hours: 1 }).toISO() })).lastInsertRowid;
  const sent = [];
  const { channelId } = await scheduler.sendReminderNow(makeFakeClient(sent), db.reminders.getById(id));
  assert.equal(channelId, 'chanExplicit');
  assert.match(sent[0].content, /<@user1>/);
  assert.equal(db.reminders.getById(id).fired, 0);
  assert.ok(db.botMessages.getRecent(100, 'schedGuild').some(r => r.message_type === 'reminder_test'));

  await assert.rejects(scheduler.sendReminderNow(makeFakeClient([]), { id: 999, guild_id: 'schedGuildNoChannel', channel_id: null, user_id: 'user1', message: 'x' }));
});
