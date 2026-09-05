# byteme-herald-core — Claude Code notes

The shared framework package for **ByteMe** (`wrongieisright/byteme`, Whiteout Survival) and
**Herald** (`wrongieisright/kingshotbot`, Kingshot). `README.md` says what's in it and how a
bot consumes it; this file is the conventions and rationale a session shouldn't have to
re-derive. Both bots' own `CLAUDE.md` files carry the game-specific history (incidents,
tuning, result-code vocabularies) — this file only covers what's shared.

## Why this package exists, and its ground rules

The two bots were copy-paste forks that drifted: features were hand-ported one at a time
(both bots' `CLAUDE.md` literally documented "port from the sibling repo, adapt field
names"), so Herald was permanently a few incidents behind ByteMe. The extraction is
deliberately **incremental and risk-ordered** — framework-only code with zero game logic
first, incident-tuned game-shaped code last — and every slice ships to ByteMe first, gets
confirmed live, then is ported to Herald. Rules that follow from that:

- **The core never opens a database.** Every factory takes the bot's own `better-sqlite3`
  handle (`initSharedSchema(db)`, `createSharedQueries(db)`) or composed `db` module
  (`createBotMessages`, `createScheduler`). The bot owns the file path, the lifetime, and
  its game-specific tables. `better-sqlite3` is therefore only a devDependency here.
- **Factories, not singletons.** Each bot's `features/scheduler.js` / `features/botMessages.js`
  became a thin shim that calls the factory and exports the exact same API it always had,
  so none of the bot's consumers or tests changed. Keep new shared modules in that shape.
- **Game-specific behavior is injected, not branched on.** `createBotMessages` takes the
  bot's posting-channel roles and its message classifier; `playerGuilds.getForGuild` lives
  in each bot because it selects that game's progression columns (`fc_level`/`fc_sublevel`
  vs `level`). Never add an `if (game === 'wos')` in here — add an option or leave it in
  the bot.
- **No build step, no bundler, no TypeScript** — same as both bots. Plain CommonJS.
- **Zero behavior change for an existing consumer is the bar for a shared-module change**
  unless it's an explicit, versioned feature. Anything that would alter what ByteMe or
  Herald does on the next bump needs to be an opt-in option (see `useMessageTimestamps`
  on `createBotMessages` — Herald's backfill wanted real Discord timestamps, ByteMe's
  didn't have that, so it's off by default).

## What's shared vs. what stays in each bot

Shared (11 tables, `db/schema.js`): `channel_config`, `user_prefs`, `schedules`,
`reminders`, `player_changes`, `player_guilds`, `banned_players`, `banned_users`,
`blocked_codes`, `bot_messages`, `channel_errors`. These were byte-identical between the
bots, or (schedules/reminders/user_prefs/channel_errors) existed only in ByteMe and have no
game logic at all — Herald gets them, and the scheduler, for free when it adopts this.

Bot-owned, deliberately: `players` (progression columns differ per game) and `redemptions`
(the two copies had already diverged: `display_name` vs `nickname`, ByteMe counts
`same_type_exchange` as already-redeemed, Herald has `getActiveCodes`). The redemption
engine is a later extraction phase with its own gate — don't fold `redemptions` in here as
a side effect of something else.

Contract on the bot's `players` table: it must have `player_id TEXT UNIQUE NOT NULL`.
`playerGuilds.unlink`/`removeEverywhere` delete from it, and guild-scoped queries join
through `player_guilds` on that column. (ByteMe's column was `wos_player_id` until Sept 2026
and was renamed specifically so both bots could share this schema.)

## Migrations

Same hand-rolled convention as both bots: `CREATE TABLE IF NOT EXISTS` for everything,
then `PRAGMA table_info(...)` checks + `ALTER TABLE` for columns added after a table
already existed in production. `initSharedSchema` carries the two migrations for tables it
now owns (`user_prefs` per-guild timezones, `schedules` `recurrence_type`). A migration for
a *bot-owned* table stays in that bot's `init()` — e.g. ByteMe's `wos_player_id →
player_id` rename touches shared tables but is ByteMe-history-specific, so it lives in
ByteMe and runs alongside `initSharedSchema`; order doesn't matter since `CREATE TABLE IF
NOT EXISTS` no-ops on an existing table.

## Testing

`npm test` — `node:test`, one process per file, no `--test-force-exit` (the scheduler
exposes `stopOneTimeChecker()` and the tests cancel every cron job they register, so nothing
lingers; if a new test file seems to need the flag, find the leaked handle instead — both
bots learned the hard way that the flag silently truncates runs).

- `test/helpers/coreDb.js` is the stand-in for a bot's `db/database.js`: a minimal `players`
  table + `initSharedSchema` + `createSharedQueries`.
- `test/scheduler.test.js` and `test/botMessages.test.js` are ports of ByteMe's own tests
  for the same code (its suite still runs them too, against its shims — that's the
  integration check). Keep the two in step: a behavior change here should show up as a
  test change here first.
- `test/helpers/testDb.js` / `mockAxios.js` are what the bots re-export from their own
  `test/helpers/`; the bots keep their game-specific default axios handlers locally.

## Releasing

Tag a release (`git tag v0.x.y && git push --tags`) and bump the tag each bot pins in its
`package.json`. Never move an existing tag. A change that alters a shared module's behavior
for an existing consumer is a minor bump at least, and gets called out in the consuming
bot's `CHANGELOG.md` when the bump lands there.
