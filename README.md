# byteme-herald-core

Shared framework for two Discord bots by the same author:

- **ByteMe** (`wrongieisright/byteme`) — Whiteout Survival
- **Herald** (`wrongieisright/kingshotbot`) — Kingshot

Both bots grew the same skeleton independently (SQLite via `better-sqlite3`, the same
multi-guild player model, the same proactive-message tracking, the same dashboard shape).
This package is where the parts that are genuinely identical live once, so a fix or feature
lands in both bots by bumping a version instead of being hand-ported.

## What's in it

| Export | What it is |
|---|---|
| `initSharedSchema(db)` | Creates the 11 shared tables (`channel_config`, `user_prefs`, `schedules`, `reminders`, `player_changes`, `player_guilds`, `banned_players`, `banned_users`, `blocked_codes`, `bot_messages`, `channel_errors`) and runs their migrations. |
| `createSharedQueries(db)` | Query objects over those tables — `playerGuilds`, `bannedPlayers`, `bannedUsers`, `schedules`, `reminders`, `channels`, `userPrefs`, `blockedCodes`, `botMessages`, `playerChanges`, `channelErrors`. |
| `createBotMessages({ db, ... })` | Tracks every proactive message the bot sends (so a dashboard can list/delete them), self-heals `channel_errors`, and backfills history from Discord. |
| `createScheduler({ db, botMessages })` | Daily/weekly/interval/one-time schedules and reminders, DST-aware via `node-cron`'s timezone option, with "Test Send". The pure datetime/cron helpers are also exported standalone. |
| `createRedemptionEngine({ redeemOnce, classifyResponse, looksLikeRateLimit, delays, ... })` | The gift-code redemption engine: per-player attempt loop with transient vs. rate-limit backoff, a fully serialized queue with a gap between batches, progress callbacks, lazy player resolution, and per-player code sweeps. The bot injects its HTTP call, result-code vocabulary, and tuning. `makeSign`/`nowSeconds`/`sleep` are exported too. |
| `createGiftCodeDetector({ labeledRegex, bareLineRegexes })` + `labeledCodeRegex`/`bareLineRegex` | Finds gift codes in channel text: every `code:`/`cdk:`-labeled match (with a URL guard) plus every whole line that is nothing but a code, de-duplicated in order. The bot builds its own game-shaped regexes with the helpers and injects them. |
| `createTelegramWatcher({ channelUsername, extractGiftCodes, handleCode, timings?, createClient? })` | Watches a public Telegram channel for gift codes over a user-account MTProto session (teleproto), with the four stall defenses both bots converged on: a `getMe()` liveness probe, an unconditional 6-hourly reconnect, an hourly heartbeat log, and a `getMessages()` polling fallback. The bot injects the channel, its detector, and what to do with each code. |
| `createDashboard({ db, viewsDir, channelConfigKeys, registrationChannelKeys, giftcode, redeemSources?, backfillMessages, registerRoutes? })` | The dashboard skeleton: Express, the SQLite session store, Discord OAuth locked to `OWNER_DISCORD_ID`, the auth routes, `/health`, and the 22 `/api` routes both bots serve identically (guilds, channels and channel config, player changes, redemptions list/detail/redeem/progress/delete, bot messages list/delete/backfill, channel errors). The bot injects its channel keys, its giftcode functions, its redeem `source` labels, and a `registerRoutes(app, { requireAuth, client })` hook for its own game-shaped routes; the page itself (`index.html`, `login.html`) stays in the bot's `viewsDir`. `registerSharedRoutes` is exported for tests. |
| `createRegistrySync({ game, urlEnvVar, secretEnvVar, buildPayload, http, logTag?, batchSize? })` / `createRegistryBackfill({ game, http, supabaseUrl, supabaseKey, getGaps, fieldMap, applyUpdate, chunkSize? })` | The player-registry sync with the shared registry app (wos-registry, multi-game since its migration 013): the outbound `POST /api/bot-sync` of `{ game, players }` on every new add and monitor-detected change (optional — a bot without the env vars skips it, logged), and the read-only reverse pull that fills a bot's NULL nickname/level from what a human entered in the registry, never overwriting a known value. The bot injects which game it is, its env var names, how a player maps to the registry's columns, and its axios. |
| `test/helpers/testDb.js`, `test/helpers/mockAxios.js` | The test scaffolding both bots use. |

The bot keeps owning what differs per game: its `players` table (progression columns),
its `redemptions` table, its game's redemption HTTP call and result-code vocabulary (fed
into the engine), gift-code detection rules, which Telegram channel it watches and what it
does with a detected code, its dashboard pages and game-specific dashboard routes, which registry env vars it reads
and how its players map onto the registry's columns, and every slash command.

## Using it from a bot

The core never opens a database — the bot passes in its own `better-sqlite3` handle and
composes the shared queries with its own:

```js
// db/database.js
const Database = require('better-sqlite3');
const { initSharedSchema, createSharedQueries } = require('@wrongieisright/byteme-herald-core');

const db = new Database(dbPath);
function init() {
  db.exec(`CREATE TABLE IF NOT EXISTS players (... player_id TEXT UNIQUE NOT NULL ...)`);
  initSharedSchema(db);
}
const shared = createSharedQueries(db);
module.exports = { init, ...shared, players: /* game-specific */, getRawDb: () => db };
```

```js
// features/botMessages.js
const { createBotMessages } = require('@wrongieisright/byteme-herald-core');
module.exports = createBotMessages({
  db: require('../db/database'),
  backfillChannelTypes: { schedules: 'scheduled', reminders: 'reminder', giftcode: 'giftcode_summary' },
  classifyMessage: (message, configKey) => /* game-specific */
});

// features/scheduler.js
const { createScheduler } = require('@wrongieisright/byteme-herald-core');
module.exports = createScheduler({ db: require('../db/database'), botMessages: require('./botMessages') });
```

Requirements on the bot's side: a `players` table with a `player_id TEXT UNIQUE NOT NULL`
column (the shared `playerGuilds.unlink`/`removeEverywhere` delete from it), and the
`channel_config` keys the scheduler resolves default channels from (`'schedules'`,
`'reminders'`).

## Versioning

Tagged releases (`v0.1.0`, ...). Each bot pins a tag in its `package.json`; upgrading a bot
is a deliberate one-line bump, a test run, and a deploy — never implicit.

## Tests

```
npm install
npm test
```

`node:test`, one process per file, no framework. `test/helpers/coreDb.js` stands in for a
bot's `db/database.js` (a minimal `players` table plus the shared schema).
