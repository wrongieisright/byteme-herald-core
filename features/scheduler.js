const cron = require('node-cron');
const { DateTime } = require('luxon');

// ─── Timezone Helpers ─────────────────────────────────────────────────────────
// Pure datetime/cron helpers, independent of any database -- exported both
// standalone (module.exports below) and on every createScheduler() instance,
// so a bot's slash commands can import them without a db handle.

const VALID_TIMEZONES = Intl.supportedValuesOf('timeZone');

function isValidTimezone(tz) {
  try {
    DateTime.now().setZone(tz);
    return VALID_TIMEZONES.includes(tz) || tz === 'UTC';
  } catch {
    return false;
  }
}

// Matches used to power Discord slash-command autocomplete on timezone
// options -- prefix matches first, then substring matches, capped at
// Discord's 25-choice limit.
function searchTimezones(query) {
  const all = VALID_TIMEZONES.includes('UTC') ? VALID_TIMEZONES : ['UTC', ...VALID_TIMEZONES];
  const q = (query || '').trim().toLowerCase();
  if (!q) return all.slice(0, 25);

  const starts = [];
  const contains = [];
  for (const tz of all) {
    const lower = tz.toLowerCase();
    if (lower.startsWith(q)) starts.push(tz);
    else if (lower.includes(q)) contains.push(tz);
  }
  return [...starts, ...contains].slice(0, 25);
}

/**
 * Parse a human datetime string into a UTC ISO string.
 * Accepts: "2026-04-25 18:00", "2026-04-25T18:00", etc.
 */
function parseDateTime(str, timezone = 'UTC') {
  const formats = [
    "yyyy-MM-dd'T'HH:mm",
    "yyyy-MM-dd HH:mm",
    "yyyy-MM-dd'T'HH:mm:ss",
    "yyyy-MM-dd HH:mm:ss"
  ];

  for (const fmt of formats) {
    const dt = DateTime.fromFormat(str, fmt, { zone: timezone });
    if (dt.isValid) return dt.toUTC().toISO();
  }

  return null;
}

// Whether a UTC ISO datetime string (as returned by parseDateTime/
// buildIntervalSchedule) is actually still in the future. Shared by every
// one-time schedule/reminder create-or-edit path -- both dashboard routes
// and Discord slash commands (/schedule, /editschedule, /remind) -- so a
// past fire_at is rejected consistently everywhere instead of wherever
// someone remembered to add the check. This matters more than it used to:
// checkOneTimeSchedules no longer has a catch-up ceiling (see its comment),
// so a bad-but-technically-valid past date now fires almost immediately on
// the next 60s tick instead of just sitting inert.
function isInFuture(isoString) {
  return DateTime.fromISO(isoString) > DateTime.utc();
}

/**
 * Convert a time string like "18:00" and recurrence to a cron expression.
 * For DST-aware schedules, cron runs in local time via UTC offset calculation at fire time.
 *
 * 'interval' (every N days from an anchor date) gets the same daily cron
 * pattern as 'daily' -- cron's own day-of-month step syntax resets at the
 * start of every month, so it can't express "every 2 days starting from
 * whatever date I picked". Instead an interval schedule's job fires daily
 * like any other, and shouldFireInterval() below decides on each firing
 * whether today is actually one of the every-N days.
 *
 * dayOfWeek only applies to 'weekly' (0=Sunday..6=Saturday, matching cron's
 * own day-of-week field and JS Date#getDay()) -- defaults to 0 so every
 * pre-existing caller keeps the original Sunday-only behavior unchanged.
 * A real user request: weekly schedules used to be hardcoded to Sunday with
 * no way to pick a different day.
 */
function buildCronExpr(timeStr, recurrence, dayOfWeek = 0) {
  const [hour, minute] = timeStr.split(':').map(Number);
  if (isNaN(hour) || isNaN(minute)) return null;

  switch (recurrence) {
    case 'daily':     return `${minute} ${hour} * * *`;
    case 'weekly': {
      const dow = Number(dayOfWeek);
      if (!Number.isInteger(dow) || dow < 0 || dow > 6) return null;
      return `${minute} ${hour} * * ${dow}`;
    }
    case 'interval':  return `${minute} ${hour} * * *`;
    default:          return null;
  }
}

// Given a "first fire" datetime string/timezone (same input an interval
// schedule is created or edited with, and now also what daily/weekly
// schedules pass when the user opts into an explicit first-send date --
// see the recurrenceType param), returns the pieces it needs to persist:
// the UTC instant of that first fire (for display), the local calendar
// date it falls on (the recurrence anchor -- see shouldFireInterval), and
// a cron_expr for the time of day matching recurrenceType's own cadence.
// Returns null if the datetime string doesn't parse. recurrenceType
// defaults to 'interval' to keep every pre-existing caller unchanged.
// dayOfWeek is forwarded to buildCronExpr for the 'weekly' case; see its
// comment above.
function buildIntervalSchedule(timeStr, timezone, recurrenceType = 'interval', dayOfWeek = 0) {
  const fireAtUtc = parseDateTime(timeStr, timezone);
  if (!fireAtUtc) return null;
  const local = DateTime.fromISO(fireAtUtc, { zone: 'UTC' }).setZone(timezone);
  return {
    fireAtUtc,
    anchor_date: local.toFormat('yyyy-MM-dd'),
    cron_expr: buildCronExpr(local.toFormat('HH:mm'), recurrenceType, dayOfWeek)
  };
}

// Whether a recurring schedule should actually send right now. Covers two
// cases, both gated by anchor_date -- schedules without one (the common
// case) always pass:
//  - Interval schedules (interval_days set): only true every N days from
//    anchor_date -- see buildIntervalSchedule's comment for why this can't
//    just be expressed in cron syntax directly.
//  - Daily/weekly schedules with an optional first-send anchor_date but no
//    interval_days: the cron_expr already encodes the right time/day-of-week,
//    this just holds it back until that date is reached, then it fires
//    normally (every day, or every cron-selected day-of-week) from then on.
// Compares calendar dates in the schedule's own timezone (not a raw
// millisecond span) so a DST transition day -- 23 or 25 real hours long --
// can't shift the day count off by one; Math.round absorbs the sub-hour
// rounding noise real-elapsed-time diffing introduces around that transition.
function shouldFireInterval(schedule, now = DateTime.now()) {
  if (!schedule.anchor_date) return true;

  const today = now.setZone(schedule.timezone).startOf('day');
  const anchor = DateTime.fromISO(schedule.anchor_date, { zone: schedule.timezone }).startOf('day');
  const daysSince = Math.round(today.diff(anchor, 'days').days);

  if (daysSince < 0) return false;
  if (!schedule.interval_days) return true;
  return daysSince % schedule.interval_days === 0;
}

/**
 * Format a UTC ISO string for display in both user TZ and UTC.
 * e.g. "6:00 PM EDT (22:00 UTC)"
 */
function formatTimeDisplay(utcIso, userTimezone = 'UTC') {
  const dt = DateTime.fromISO(utcIso, { zone: 'UTC' });
  const local = dt.setZone(userTimezone);
  const utcStr = dt.toFormat('HH:mm') + ' UTC';

  if (userTimezone === 'UTC') return utcStr;

  const localStr = local.toFormat('h:mm a ZZZZ');
  return `${localStr} (${utcStr})`;
}

// Reverse-formats a stored UTC fire_at + timezone back into "yyyy-MM-dd
// HH:mm" -- the same format parseDateTime accepts as input -- so the
// dashboard's edit form can pre-fill a time field that round-trips cleanly
// back through parseDateTime on save. Shared by one-time schedules and
// reminders, which both store fire_at the same way.
function formatFireAtForEdit(fire_at, timezone) {
  if (!fire_at) return '';
  return DateTime.fromISO(fire_at, { zone: 'UTC' }).setZone(timezone || 'UTC').toFormat('yyyy-MM-dd HH:mm');
}

// Same idea as formatFireAtForEdit, but for a recurring schedule: reverses
// cron_expr (and anchor_date, when set -- always true for interval
// schedules, optionally true for daily/weekly's first-send date) back into
// whatever string buildCronExpr/buildIntervalSchedule originally accepted,
// so the edit form's time field pre-fills with something that round-trips.
function getEditableTime(schedule) {
  if (schedule.one_time) return formatFireAtForEdit(schedule.fire_at, schedule.timezone);

  const [minute, hour] = schedule.cron_expr.split(' ').map(Number);
  const hhmm = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

  if (schedule.anchor_date) {
    return `${schedule.anchor_date} ${hhmm}`;
  }
  return hhmm;
}

const pureHelpers = {
  isValidTimezone,
  searchTimezones,
  parseDateTime,
  isInFuture,
  buildCronExpr,
  buildIntervalSchedule,
  shouldFireInterval,
  formatTimeDisplay,
  formatFireAtForEdit,
  getEditableTime
};

// Builds the scheduler for one bot. Needs the bot's composed db module
// (schedules, reminders, channels, channelErrors) and its botMessages module
// (trackSentMessage, previewFromContent). Each instance owns its own set of
// live cron jobs and its own one-time-checker timer.
function createScheduler({ db, botMessages }) {
  const { trackSentMessage, previewFromContent } = botMessages;

  const activeCronJobs = new Map(); // scheduleId -> cron task
  let reminderCheckInterval = null;

  // ─── Cron Job Management ──────────────────────────────────────────────────

  // Split out from scheduleJob's cron callback so it's directly unit-testable
  // instead of only reachable through a live cron tick -- see the real
  // incident this was extracted for below ("DST re-check bug").
  async function fireScheduledJob(schedule, client) {
    try {
      // Interval schedules run on the same daily cron as 'daily' ones --
      // this is what actually restricts them to every N days.
      if (!shouldFireInterval(schedule)) return;

      const channelId = schedule.channel_id || db.channels.get(schedule.guild_id, 'schedules');
      if (!channelId) return;

      const channel = await client.channels.fetch(channelId);
      const sent = await channel.send(schedule.message);
      await trackSentMessage(sent, 'scheduled', previewFromContent(schedule.message));

      if (schedule.one_time) {
        db.schedules.deactivate(schedule.id);
        activeCronJobs.get(schedule.id)?.stop();
        activeCronJobs.delete(schedule.id);
      }
    } catch (err) {
      console.error(`[Scheduler] Failed to send schedule ${schedule.id}:`, err.message);
      db.channelErrors.log(schedule.guild_id, schedule.channel_id || db.channels.get(schedule.guild_id, 'schedules'), 'scheduled_message', err.message);
    }
  }

  function scheduleJob(schedule, client) {
    if (activeCronJobs.has(schedule.id)) {
      activeCronJobs.get(schedule.id).stop();
    }

    // node-cron's own `timezone` option below is what makes this DST-aware --
    // it fires at the correct local wall-clock time across DST transitions on
    // its own. An earlier version of this function also re-checked "does now
    // actually match the intended local hour/minute" before sending, as an
    // extra safety net -- but that check compared against
    // cron_expr.split(' ').slice(1, 3), which grabs [hour, dayOfMonthWildcard]
    // instead of [hour, minute] (cron_expr's fields are "minute hour * * *"),
    // so it was comparing the real minute against Number('*') (NaN) and always
    // failed. Every dst_follow schedule in a non-UTC timezone -- effectively
    // every real-world recurring schedule, since almost nobody is in UTC --
    // silently never fired, for the entire life of the repo it was found in
    // (confirmed via git blame: present since the very first commit). Removed
    // rather than fixed in place, since node-cron's timezone option already
    // does the one job this redundant check was trying to do.
    const task = cron.schedule(schedule.cron_expr, () => fireScheduledJob(schedule, client), {
      timezone: schedule.dst_follow ? schedule.timezone : 'UTC'
    });

    activeCronJobs.set(schedule.id, task);
  }

  function cancelJob(scheduleId) {
    if (activeCronJobs.has(scheduleId)) {
      // node-cron@3's ScheduledTask only exposes stop()/start()/now() -- there
      // is no destroy(). Calling a nonexistent .destroy() here used to throw
      // before ever reaching activeCronJobs.delete() below, which meant
      // deleting or editing a recurring schedule never actually stopped its
      // old cron timer -- it kept firing under the stale pre-edit schedule
      // object until the process restarted.
      activeCronJobs.get(scheduleId).stop();
      activeCronJobs.delete(scheduleId);
    }
  }

  function loadAllSchedules(client) {
    const all = db.schedules.getAllActive();
    for (const schedule of all) {
      if (!schedule.one_time) {
        scheduleJob(schedule, client);
      }
    }
    console.log(`[Scheduler] Loaded ${all.length} active schedules`);
  }

  // ─── One-time Schedule Check ──────────────────────────────────────────────
  // Split into checkOneTimeSchedules/checkPendingReminders (rather than
  // inlined in the setInterval callback) so each can be unit tested directly
  // instead of only indirectly through a live 60s timer.

  async function checkOneTimeSchedules(client) {
    const allSchedules = db.schedules.getAllActive();

    for (const schedule of allSchedules) {
      if (!schedule.one_time || !schedule.fire_at) continue;

      const fireAt = DateTime.fromISO(schedule.fire_at, { zone: 'UTC' });
      const diff = fireAt.diffNow('minutes').minutes;

      // No lower bound on diff -- an item overdue by more than a couple
      // minutes (e.g. the bot was down or redeploying at the fire moment)
      // still deserves to fire on the next tick rather than being silently
      // orphaned forever. A real incident found this.
      if (diff <= 0) {
        const channelId = schedule.channel_id || db.channels.get(schedule.guild_id, 'schedules');
        if (!channelId) {
          console.error(`[Scheduler] One-time schedule ${schedule.id} is due but has no channel configured (no per-schedule channel and no default 'schedules' channel set) -- leaving it active so it can be fixed and retried.`);
          continue;
        }
        try {
          const channel = await client.channels.fetch(channelId);
          const sent = await channel.send(schedule.message);
          await trackSentMessage(sent, 'scheduled', previewFromContent(schedule.message));
          db.schedules.deactivate(schedule.id);
        } catch (err) {
          console.error(`[Scheduler] Failed to fire one-time schedule ${schedule.id}:`, err.message);
          db.channelErrors.log(schedule.guild_id, channelId, 'one_time_schedule', err.message);
        }
      }
    }
  }

  async function checkPendingReminders(client) {
    const pendingReminders = db.reminders.getPending();
    for (const reminder of pendingReminders) {
      const fireAt = DateTime.fromISO(reminder.fire_at, { zone: 'UTC' });
      const diff = fireAt.diffNow('minutes').minutes;

      if (diff <= 0) {
        const channelId = reminder.channel_id || db.channels.get(reminder.guild_id, 'reminders');
        if (!channelId) {
          console.error(`[Scheduler] Reminder ${reminder.id} is due but has no channel configured (no per-reminder channel and no default 'reminders' channel set) -- leaving it pending so it can be fixed and retried.`);
          continue;
        }
        try {
          const channel = await client.channels.fetch(channelId);
          const sent = await channel.send(`<@${reminder.user_id}> ⏰ Reminder: ${reminder.message}`);
          await trackSentMessage(sent, 'reminder', previewFromContent(reminder.message));
          db.reminders.markFired(reminder.id);
        } catch (err) {
          console.error(`[Scheduler] Failed to fire reminder ${reminder.id}:`, err.message);
          db.channelErrors.log(reminder.guild_id, channelId, 'reminder', err.message);
        }
      }
    }
  }

  function startOneTimeChecker(client) {
    // Check every minute for one-time schedules/reminders that are due
    reminderCheckInterval = setInterval(async () => {
      await checkOneTimeSchedules(client);
      await checkPendingReminders(client);
    }, 60 * 1000); // every 60 seconds
  }

  // Clears the 60s timer -- for tests, which would otherwise keep the
  // process alive forever (the same lingering-handle trap the bots' own
  // test suites hit with monitor intervals and session stores).
  function stopOneTimeChecker() {
    if (reminderCheckInterval) {
      clearInterval(reminderCheckInterval);
      reminderCheckInterval = null;
    }
  }

  // ─── Test Send ────────────────────────────────────────────────────────────
  // Lets a dashboard user confirm a schedule/reminder's channel and message
  // actually work *before* trusting it to fire unattended -- added after a
  // real incident where a scheduled message silently never went out and
  // there was no way to check it short of waiting for the real fire time.
  // Reuses the same channel-resolution/send/track logic as the real firing
  // paths, tagged with a distinct message_type so a test send is never
  // confused for the real thing in the Messages tab, and deliberately never
  // touches deactivate/markFired -- a test send must never consume the
  // one-shot fire.
  async function sendScheduleNow(client, schedule) {
    const channelId = schedule.channel_id || db.channels.get(schedule.guild_id, 'schedules');
    if (!channelId) {
      throw new Error("No channel configured for this schedule (set one on the schedule itself, or set a default 'schedules' channel for this server).");
    }
    const channel = await client.channels.fetch(channelId);
    const sent = await channel.send(schedule.message);
    await trackSentMessage(sent, 'scheduled_test', previewFromContent(schedule.message));
    return { channelId };
  }

  async function sendReminderNow(client, reminder) {
    const channelId = reminder.channel_id || db.channels.get(reminder.guild_id, 'reminders');
    if (!channelId) {
      throw new Error("No channel configured for this reminder (set one on the reminder itself, or set a default 'reminders' channel for this server).");
    }
    const channel = await client.channels.fetch(channelId);
    const sent = await channel.send(`<@${reminder.user_id}> ⏰ Reminder: ${reminder.message}`);
    await trackSentMessage(sent, 'reminder_test', previewFromContent(reminder.message));
    return { channelId };
  }

  return {
    scheduleJob,
    fireScheduledJob,
    cancelJob,
    loadAllSchedules,
    startOneTimeChecker,
    stopOneTimeChecker,
    checkOneTimeSchedules,
    checkPendingReminders,
    sendScheduleNow,
    sendReminderNow,
    ...pureHelpers
  };
}

module.exports = { createScheduler, ...pureHelpers };
