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
*engine* is shared (see below) but the `redemptions` *table* isn't — don't fold it in here
as a side effect of something else.

## Redemption engine (`features/redemption.js`)

`createRedemptionEngine(config)` is the most incident-tuned code in either bot, extracted
in Phase 2. It owns *how* a roster gets redeemed: the per-player attempt loop with its two
backoff flavors (plain transient retry vs. rate-limit backoff, and no pointless sleep after
the last attempt), the fully serialized queue with its `BATCH_GAP_MS` pause, batch
iteration with progress callbacks, lazy player resolution (`redeemForAllLazy` — the fix for
a real double-redeem race), and the per-player code sweep (`redeemCodesForPlayer`, which
stops at the first `invalid_player_info`). Everything game-specific is injected:

- `redeemOnce({ player_id, code, kid, attempt, maxAttempts })` — the one HTTP call, owned
  by the bot: endpoint, headers, signing, and its own per-attempt logging. Throws on
  network failure (an axios error's `.response.status === 429` is understood).
- `classifyResponse(data)` — the game's result-code vocabulary; returns
  `{ success, result }` or `null`. Order matters and is preserved from the originals:
  explicit codes first, then the engine's `looksLikeRateLimit`, then a fallback of the
  API's own message text.
- `looksLikeRateLimit(errCode, msg)` — what counts as "slow down" (WOS: 40101 + 40004 +
  wording; Kingshot: 40101 + wording incl. "rate limit").
- `delays` — **all four required, no defaults**, so a bot's tuning can never change
  silently by a package bump: `DELAY_MS`, `RETRY_DELAY_MS`, `RATE_LIMIT_BACKOFF_MS`,
  `BATCH_GAP_MS`. `sleep()` collapses them under `FAST_TEST_MODE`.
- `retryRateLimitedAtEnd` — ByteMe's end-of-batch second pass for players who exhausted
  their attempts on rate limiting (real incident: 2 of 63 stuck, fixed by a manual re-run
  ~40 min later). Off by default.
- `stopOnExpired` — Herald's "stop the batch at the first `expired`" (its API returns that
  for a nonexistent code, true for everyone). Off by default; ByteMe must not turn it on
  because WOS reuses code strings for later promotions.

The two bots' `scraper.js` files therefore differ only in those injected pieces plus their
own `scrapePlayer`/`scrapeAllPlayers` (per-game progression fields — still bot-owned).
`makeSign(params, secretKey)` and `nowSeconds()` are shared too (identical signing scheme
on both Century Games APIs; `time` is Unix *seconds*, a real bug when it was milliseconds).

Contract on the bot's `players` table: it must have `player_id TEXT UNIQUE NOT NULL`.
`playerGuilds.unlink`/`removeEverywhere` delete from it, and guild-scoped queries join
through `player_guilds` on that column. (ByteMe's column was `wos_player_id` until Sept 2026
and was renamed specifically so both bots could share this schema.)

## Scheduler (`features/scheduler.js`)

The incident history lives in the bots' CLAUDE.md files (the DST re-check bug, the silent
one-time deactivation). One thing to keep in step here: **`nextFireTime(schedule, now)`
must mirror the live firing path**, not re-derive it. node-cron ticks `cron_expr` in
`schedule.timezone` when `dst_follow` is set and in UTC when pinned (`scheduleJob`), and
every tick is then gated by `shouldFireInterval`; `nextFireTime` walks candidate ticks with
exactly those two rules and returns the first one ahead of `now` as a UTC ISO string (or
`null`: a one-time schedule already past, or nothing within 400 days). Both dashboards
show it as the Schedules tab's NEXT SEND column (v0.7.0), which is the reason it exists —
an every-N-days row used to show only "from <anchor_date>". If the firing rules ever
change (a new gate, a different zone rule), change `nextFireTime` in the same commit or
the dashboards will show a time the bot doesn't send at.

## Migrations

Same hand-rolled convention as both bots: `CREATE TABLE IF NOT EXISTS` for everything,
then `PRAGMA table_info(...)` checks + `ALTER TABLE` for columns added after a table
already existed in production. `initSharedSchema` carries the two migrations for tables it
now owns (`user_prefs` per-guild timezones, `schedules` `recurrence_type`). A migration for
a *bot-owned* table stays in that bot's `init()` — e.g. ByteMe's `wos_player_id →
player_id` rename touches shared tables but is ByteMe-history-specific, so it lives in
ByteMe and runs alongside `initSharedSchema`; order doesn't matter since `CREATE TABLE IF
NOT EXISTS` no-ops on an existing table.

## Gift-code detection (`features/giftcodeDetection.js`)

`createGiftCodeDetector({ labeledRegex, bareLineRegexes })` (Phase 3) is the shared
*algorithm*: every labeled match, then every whole line that is nothing but a code,
first-appearance order, de-duplicated. The regex *shapes* are deliberately not shared —
the two games' real codes differ enough that one regex would regress one bot: WOS codes
are regularly pure letters as short as 4–7 chars (`gogoWOS`, `EidMubarak`), while
Kingshot's digit-free codes were all 10+ chars and short bare words (`thanks`, `awesome`)
must not match. Each bot builds its own with `labeledCodeRegex({ labels, allowBackticks,
trailingBoundary, minLength, maxLength })` and `bareLineRegex({ minLength, maxLength,
requireLetter, requireDigit, lettersOnly })`, and `test/giftcodeDetection.test.js` pins the
builders' output to the exact literals both bots shipped with — change a builder and that
test tells you which bot's behavior you just changed. The same test file replays both
bots' own detection cases (including Herald's list of real past Kingshot codes) against
their configs. Both bots' labeled patterns are backtick-tolerant as of 2026-09-09 (ByteMe
adopted Herald's shape after a real code arrived wrapped in backticks; the test pins its
original literal alongside the new one). One thing stays in Herald: its
`VALID_UNTIL_REGEX` (its announcement format, not detection).

## Telegram watcher (`features/telegramWatcher.js`)

`createTelegramWatcher({ channelUsername, extractGiftCodes, handleCode, timings, createClient })`
(Phase 4) returns `{ start }`; `start(discordClient)` resolves to `null` when
`TELEGRAM_API_ID`/`TELEGRAM_API_HASH`/`TELEGRAM_SESSION` aren't all set (or connect/channel
resolution fails), otherwise to a handle `{ client, pollForMissedMessages, getState, stop }`.
The two bots' watchers were line-for-line identical apart from the channel (`wosrewards` /
`ksrewards`) and the redeem options they pass, so those are the injection points:
`handleCode(discordClient, code, { via })` is called per detected code with `via` `'push'`
or `'poll'`, and the bot decides what a fresh Telegram post means for its deferred results
(ByteMe `retryExpired: true`, Herald `retryDeferred: true`). Every one of the four stall
defenses in the file header (liveness probe, unconditional reconnect, heartbeat, poll
fallback) exists because of a real incident where a posted code was never detected with
zero trace in the logs — they're defense in depth, not redundancy, and none should be
removed because another one "covers" it. `DEFAULT_TIMINGS` are what both bots shipped;
`timings` exists for tests, not for the bots to tune independently.

teleproto is a real dependency of this package (the bots no longer require it directly)
but is `require`d lazily inside `start()`, only once credentials are present, so a bot
without Telegram configured never loads it. `createClient` swaps the `TelegramClient`
constructor for a fake; `test/telegramWatcher.test.js` drives one through push events,
the poll fallback, a rejecting and a hanging `getMe()`, the Nth-heartbeat reconnect, and
`stop()`, with `node:test`'s mock timers. The one thing not covered here or anywhere is
teleproto's own `catchUp()` resync against a live server — this sandbox can't reach
Telegram, so that's confirmed only by the bots' 6-hour heartbeat cycles in production.

## Dashboard skeleton (`web/dashboard.js`)

`createDashboard({ ... })` (Phase 5) returns `{ start }`; `start(client)` builds the Express
app, session store, passport strategy and every route, listens, and returns the
`http.Server` (ByteMe's original returned nothing; its smoke test captured the server by
wrapping `http.createServer`, which still works). The two bots' `web/server.js` were
identical from the first `express()` call through `/health` and across 22 `/api` routes;
the whole diff was three injection points, and those are the options:

- `channelConfigKeys` — the `config_key` values `POST /api/channels-config` accepts
  (ByteMe `schedules/reminders/giftcode/monitor/wosupdates`, Herald
  `giftcode/monitor/kingshotupdates`), plus `registrationChannelKeys` for which of those
  trigger the registration welcome post.
- `redeemSources` — the `source` label a dashboard-triggered redemption logs, `global` vs
  `perGuild` (ByteMe `'dashboard'` for both, Herald `'dashboard_global'` /
  `'dashboard_per_server'`). Not unified: each bot's `redemptions.source` column already
  carries its own vocabulary and its dashboard filters on it.
- `registerRoutes(app, { requireAuth, client })` — the bot's own routes (players, ByteMe's
  timezone/schedules/reminders/registry-backfill, Herald's kingdom edit), registered on
  the same app with the same `requireAuth`. None of their paths overlap a shared route, so
  the hook runs after the shared routes and order never affects matching.

Two routes now pass `req.body.guildId || null` through where ByteMe's originals passed
nothing: `/api/announce-registration` and `/api/messages/backfill`. Herald's already did,
ByteMe's `broadcastRegistrationReminder(client)` ignores the extra argument and its
`backfillMessages` is this package's (a null guild means every guild), and ByteMe's
frontend sends no body on either — so it's the same call on both bots. Herald also gains
`GET /api/channel-errors` (it has the table since Phase 1 but no banner yet — that's a
frontend feature port, not part of this). ByteMe's `express.static('public')` was dropped:
the directory never existed.

The frontend is deliberately **not** shared. The two `index.html` files differ in theme
(WOS blue/Rajdhani vs Kingshot gold/Cinzel), tab set (ByteMe has Schedules/Reminders,
Herald doesn't), localStorage keys, even the `api()` helper's signature, and Herald has
neither the scoped-controls badges nor the channel-errors banner. Sharing any of that
means rewriting one bot's page to the other's conventions — a feature decision to make
explicitly, with a browser check, not a side effect of sharing the server.

`test/dashboard.test.js` mounts `registerSharedRoutes` on a bare app with a stub
`requireAuth` (the real Discord handshake isn't worth faking — same conclusion both bots'
smoke tests reached) and drives every shared route against `coreDb` plus a recording
`redemptions` stub, then boots `createDashboard` proper for the three smoke checks. The
session store starts an un-unref'd 15-minute cleanup interval on construction; the boot
test unrefs intervals created during `start()` so the file exits without
`--test-force-exit`.

## Registry sync and backfill (`features/registrySync.js`)

Track B of the overhaul (v0.6.0). The shared registry app (wrongieisright/wos-registry —
one Supabase project holding both games' players, every row tagged with a `game` column
since its migration 013, `'wos'` or `'kingshot'`) has two directions of traffic with a
bot, and both live here:

- `createRegistrySync({ game, urlEnvVar, secretEnvVar, buildPayload, http, logTag?,
  batchSize? })` → `{ syncPlayer(player_id, scraped), syncPlayers(players), buildPayload,
  getSyncUrl }`. Posts `{ game, players }` to `<url>/api/bot-sync` with an `x-bot-secret`
  header. `game` is batch-level and the registry keys its lookups on `(game, player_id)`;
  a `null` game sends the pre-multi-game `{ players }` shape, which the endpoint still
  accepts as WOS. Unconfigured (either env var unset) → logs one skip line and does
  nothing; a failed post is logged, never thrown — the sync must never break an add or a
  monitor run. `syncPlayers` chunks at `batchSize` (500, the endpoint's cap) and maps each
  entry through `buildPayload(p.player_id, p)`.
- `createRegistryBackfill({ game, http, supabaseUrl, supabaseKey, getGaps, fieldMap,
  applyUpdate, chunkSize? })` → `{ backfill(), fetchRegistryDataForIds(ids) }`. Reads the
  registry's `players` table over Supabase REST with the app's public anon key (public
  SELECT under RLS, by that repo's design), filtered to this bot's `game` so equal numeric
  IDs across games can't cross-contaminate. `fieldMap` is `{ localField: registryField }`
  (ByteMe `{ nickname: 'primary_name', fc_level: 'furnace_level' }`, Herald
  `{ nickname: 'primary_name', level: 'furnace_level' }`). **Only fills a local field that
  is currently NULL** — never overwrites, because neither side is a known source of truth
  now that both games' player-lookup APIs are dead. Returns `{ gaps, backfilled,
  stillMissing, updates }`.

Why `http` is injected instead of `require('axios')` here: each bot's test suite patches
`axios` through `Module.prototype.require` (`test/helpers/mockAxios.js`), and the bots'
existing registry tests assert on the captured `/bot-sync` body — injecting the bot's own
axios keeps those tests meaningful against the shim. The bot also keeps `buildPayload`,
because the registry's column names are the registry's (`furnace_level` holds Kingshot's
level too) and the mapping from each game's scrape shape is the bot's business.

ByteMe's history that shaped this (see its `CLAUDE.md`, "wos-registry sync"): the sync
used to be gated on a successful scrape, which became "never sync" the day WOS's `/player`
died, silently, for weeks. Neither factory gates on scrape success; the bot passes whatever
it knows and `buildPayload` falls back to the player ID as `primary_name`.

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
- `test/dashboard.test.js` boots a real listener on port 0 per test and closes it in
  `finally`; see the dashboard section for the session-store interval.
- `test/telegramWatcher.test.js` enables `mock.timers` for the interval tests and resets it
  in `finally`; a test that starts a watcher must `await handle.stop()` or the three
  intervals keep the process alive.
- `test/registrySync.test.js` runs both registry factories against a recording fake `http`
  and sets/clears its own env vars per test.
- `test/helpers/testDb.js` / `mockAxios.js` are what the bots re-export from their own
  `test/helpers/`; the bots keep their game-specific default axios handlers locally.

## Releasing

Tag a release (`git tag v0.x.y && git push --tags`) and bump the tag each bot pins in its
`package.json`. Never move an existing tag. A change that alters a shared module's behavior
for an existing consumer is a minor bump at least, and gets called out in the consuming
bot's `CHANGELOG.md` when the bump lands there.
