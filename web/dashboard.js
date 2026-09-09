// The dashboard skeleton both bots run: Express + a SQLite-backed session
// store + Discord OAuth (passport-discord) locked to OWNER_DISCORD_ID, the
// auth routes, and every /api route whose logic is the same on both bots.
// The bots' web/server.js files were line-for-line identical here apart
// from three things, which are the injection points:
//
//   channelConfigKeys        which channel_config keys the Channels tab may
//                            set (ByteMe has schedules/reminders/wosupdates,
//                            Herald has kingshotupdates)
//   redeemSources            the `source` label a dashboard-triggered
//                            redemption is logged with, global vs per-server
//                            (ByteMe uses 'dashboard' for both, Herald
//                            'dashboard_global' / 'dashboard_per_server')
//   registerRoutes           the bot's own game-shaped routes (players,
//                            ByteMe's schedules/reminders/timezone/registry
//                            backfill, Herald's kingdom edit), registered on
//                            the same app with the same requireAuth
//
// Everything else the shared routes touch is injected as plain functions
// (the bot's giftcode module, its backfillMessages) or reached through the
// bot's db module, which the core never opens itself. The page itself
// (views/index.html, views/login.html) stays in each bot: the two dashboards
// have different themes and different tab sets, and sharing the frontend is
// its own decision, not a side effect of sharing the server.
//
// start(client) returns the http.Server so a caller (tests, a graceful-
// shutdown path) can close it; index.js ignores the value.

const express = require('express');
const session = require('express-session');
const passport = require('passport');
const { Strategy: DiscordStrategy } = require('passport-discord');
const path = require('path');

const SQLiteStore = require('better-sqlite3-session-store')(session);

const REQUIRED_GIFTCODE_FNS = [
  'redeemCode', 'redeemCodeForGuild', 'getPlayersNeedingRedemption', 'getPlayersNeedingRedemptionForGuild',
  'postRegistrationWelcome', 'broadcastRegistrationReminder', 'getRedemptionProgress'
];

function validate(opts) {
  const missing = [];
  if (!opts.db) missing.push('db');
  if (!opts.viewsDir) missing.push('viewsDir');
  if (!Array.isArray(opts.channelConfigKeys) || opts.channelConfigKeys.length === 0) missing.push('channelConfigKeys');
  if (!Array.isArray(opts.registrationChannelKeys)) missing.push('registrationChannelKeys');
  if (typeof opts.backfillMessages !== 'function') missing.push('backfillMessages');
  for (const fn of REQUIRED_GIFTCODE_FNS) {
    if (typeof (opts.giftcode || {})[fn] !== 'function') missing.push(`giftcode.${fn}`);
  }
  if (missing.length) throw new Error(`createDashboard: missing ${missing.join(', ')}`);
}

// The /api routes both bots serve identically. Exported on its own so the
// core's tests can mount them on a bare app with a stub requireAuth --
// getting past passport's real Discord handshake in a test isn't worth
// building, same conclusion both bots' smoke tests reached.
function registerSharedRoutes(app, { client, requireAuth, db, channelConfigKeys, registrationChannelKeys, giftcode, redeemSources, backfillMessages }) {
  const {
    redeemCode, redeemCodeForGuild, getPlayersNeedingRedemption, getPlayersNeedingRedemptionForGuild,
    postRegistrationWelcome, broadcastRegistrationReminder, getRedemptionProgress
  } = giftcode;

  // API: Guilds
  app.get('/api/guilds', requireAuth, async (req, res) => {
    try {
      const guilds = client.guilds.cache.map(g => ({ id: g.id, name: g.name }));
      res.json(guilds);
    } catch (err) {
      console.error('[Dashboard] Error in /api/guilds:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Leaves a server the bot is in. Works even for servers you (the owner)
  // aren't personally a member of -- unlike /removeserver, which can only
  // be run from inside the target server. Doesn't touch that guild's
  // players/schedules/settings in the DB, so re-adding the bot later
  // picks up right where it left off.
  app.delete('/api/guilds/:guildId', requireAuth, async (req, res) => {
    try {
      const guild = client.guilds.cache.get(req.params.guildId);
      if (!guild) return res.status(404).json({ error: 'Guild not found' });
      const name = guild.name;
      await guild.leave();
      res.json({ ok: true, name });
    } catch (err) {
      console.error('[Dashboard] Error in /api/guilds DELETE:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // API: Channels
  app.get('/api/channels/:guildId', requireAuth, async (req, res) => {
    try {
      const guild = client.guilds.cache.get(req.params.guildId);
      if (!guild) return res.status(404).json({ error: 'Guild not found' });
      const channels = guild.channels.cache
        .filter(c => c.type === 0)
        .map(c => ({ id: c.id, name: c.name }))
        .sort((a, b) => a.name.localeCompare(b.name));
      res.json(channels);
    } catch (err) {
      console.error('[Dashboard] Error in /api/channels:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // API: Channel Config
  app.get('/api/channels-config/:guildId', requireAuth, (req, res) => {
    try {
      const config = db.channels.getAll(req.params.guildId);
      res.json(config);
    } catch (err) {
      console.error('[Dashboard] Error in /api/channels-config GET:', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/channels-config/:guildId', requireAuth, (req, res) => {
    try {
      const { config_key, channel_id } = req.body;
      if (!channelConfigKeys.includes(config_key)) return res.status(400).json({ error: 'Invalid config key' });

      const previousChannelId = db.channels.get(req.params.guildId, config_key);
      db.channels.set(req.params.guildId, config_key, channel_id);

      // Same rule as /setchannel: only for the channels that actually
      // accept registration, only when it's genuinely new/different, and
      // never when clearing the config. Fire-and-forget so it doesn't
      // delay the response.
      if (registrationChannelKeys.includes(config_key) && channel_id && previousChannelId !== channel_id) {
        postRegistrationWelcome(client, req.params.guildId, channel_id).catch(err => {
          console.error('[Dashboard] Failed to post registration welcome:', err.message);
        });
      }

      res.json({ ok: true });
    } catch (err) {
      console.error('[Dashboard] Error in /api/channels-config POST:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Re-announces the registration reminder to every server's already-
  // configured gift-code channel, or just one if guildId is given (see
  // broadcastRegistrationReminder's comment in giftcode.js). The
  // dashboard's whole OAuth login is already restricted to
  // OWNER_DISCORD_ID (see the callback route in createDashboard), so
  // requireAuth alone is enough gating here -- same as every other route.
  app.post('/api/announce-registration', requireAuth, async (req, res) => {
    try {
      const posted = await broadcastRegistrationReminder(client, req.body.guildId || null);
      res.json({ ok: true, posted });
    } catch (err) {
      console.error('[Dashboard] Error in /api/announce-registration:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // API: Player Changes
  app.get('/api/player-changes', requireAuth, (req, res) => {
    try {
      res.json(db.playerChanges.getRecent(100, req.query.guildId));
    } catch (err) {
      console.error('[Dashboard] Error in /api/player-changes:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // API: Redemptions
  // guildId is optional, dashboard-display-only scoping (see getAllCodes/
  // getByCode in the bot's db/database.js) -- omit it (or pick "All
  // Servers") to see every server's players. Redemption itself always runs
  // globally.
  app.get('/api/redemptions', requireAuth, (req, res) => {
    try {
      res.json(db.redemptions.getAllCodes(req.query.guildId));
    } catch (err) {
      console.error('[Dashboard] Error in /api/redemptions (list):', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/redemptions/:code', requireAuth, (req, res) => {
    try {
      res.json(db.redemptions.getByCode(req.params.code, req.query.guildId));
    } catch (err) {
      console.error('[Dashboard] Error in /api/redemptions:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Redemption runs in the background (players are redeemed one at a time
  // with a deliberate delay between each, so a roster of any size would
  // blow past a normal HTTP request timeout) -- reuses the exact same
  // redeemCode() pipeline the gift-code watchers use, so results/dedupe/
  // per-guild summaries behave identically no matter which path triggered
  // it. Uses getPlayersNeedingRedemption (not a blanket "any row exists
  // for this code" check) so a code stays redeemable from the dashboard
  // for any player who hasn't actually succeeded yet -- including players
  // added after the first run, or ones whose only attempt so far failed.
  // An optional guildId scopes the whole run to just that server's roster
  // (redeemCodeForGuild) instead of the global player pool, for a
  // "retry just this server" action without touching everyone else's.
  app.post('/api/redeem', requireAuth, (req, res) => {
    try {
      const code = (req.body.code || '').trim();
      const guildId = req.body.guildId || null;
      if (!code) return res.status(400).json({ error: 'code required' });

      if (db.blockedCodes.isBlocked(code)) {
        return res.json({ ok: true, status: 'blocked' });
      }

      if (guildId) {
        if (getPlayersNeedingRedemptionForGuild(code, guildId).length === 0) {
          return res.json({ ok: true, status: 'already_redeemed' });
        }
        redeemCodeForGuild(client, guildId, code, { source: redeemSources.perGuild }).catch(err => {
          console.error(`[Dashboard] Error redeeming ${code} for guild ${guildId}:`, err.message);
        });
      } else {
        if (getPlayersNeedingRedemption(code, client).length === 0) {
          return res.json({ ok: true, status: 'already_redeemed' });
        }
        redeemCode(client, code, { source: redeemSources.global }).catch(err => {
          console.error(`[Dashboard] Error redeeming ${code}:`, err.message);
        });
      }

      res.json({ ok: true, status: 'started' });
    } catch (err) {
      console.error('[Dashboard] Error in /api/redeem:', err);
      // err.message can be an empty string (e.g. a bare `throw new Error()`
      // somewhere, or a non-Error value thrown) -- the frontend's error
      // banner just shows "Error: " with nothing after it in that case,
      // so fall back to a message that at least points at where to look.
      res.status(500).json({ error: err.message || 'Unknown error -- check Railway logs for this line.' });
    }
  });

  // Polled by the dashboard while a redemption is running, so "started in
  // the background" isn't the last thing you see for however long the
  // roster takes -- returns null once nothing is actively running (either
  // it finished, or nothing has been kicked off since the last poll).
  app.get('/api/redeem-progress', requireAuth, (req, res) => {
    res.json(getRedemptionProgress());
  });

  // Deletes a mistaken code (typo, misdetected text, etc): wipes every
  // logged attempt for it (so it drops out of the dashboard's codes list/
  // detail and out of catchUpNewPlayer, which sources its code list from
  // getAllCodes()) and permanently blocks it so it can't be auto-detected,
  // manually redeemed, or retried again from any server going forward.
  app.delete('/api/redemptions/:code', requireAuth, (req, res) => {
    try {
      const code = req.params.code.trim();
      if (!code) return res.status(400).json({ error: 'code required' });

      db.redemptions.deleteByCode(code);
      db.blockedCodes.block(code);

      res.json({ ok: true });
    } catch (err) {
      console.error('[Dashboard] Error in /api/redemptions DELETE:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // API: Bot Messages
  // Every message the bot has proactively sent -- see the bot's
  // features/botMessages.js for where these get logged. guildId is
  // optional, same "All Servers" convention as redemptions/player-changes.
  app.get('/api/messages', requireAuth, (req, res) => {
    try {
      const rows = db.botMessages.getRecent(100, req.query.guildId);
      // Enrich with human-readable names -- a message can belong to any
      // guild when "All Servers" is selected, so this can't reuse the
      // current guild's already-loaded channel list the way other tabs do.
      const enriched = rows.map(r => {
        const guild = client.guilds.cache.get(r.guild_id);
        return {
          ...r,
          guild_name: guild?.name || r.guild_id,
          channel_name: guild?.channels.cache.get(r.channel_id)?.name || r.channel_id
        };
      });
      res.json(enriched);
    } catch (err) {
      console.error('[Dashboard] Error in /api/messages:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Deletes the message from Discord too, not just the tracking row. A
  // 10008 (Unknown Message -- already deleted by hand in Discord) is fine:
  // the row is stale, drop it and move on.
  app.delete('/api/messages/:id', requireAuth, async (req, res) => {
    try {
      const row = db.botMessages.getById(req.params.id);
      if (!row) return res.status(404).json({ error: 'Message not found' });

      try {
        const channel = await client.channels.fetch(row.channel_id);
        const message = await channel.messages.fetch(row.message_id);
        await message.delete();
      } catch (err) {
        if (err.code !== 10008) throw err;
      }

      db.botMessages.remove(row.id);
      res.json({ ok: true });
    } catch (err) {
      console.error('[Dashboard] Error in /api/messages DELETE:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // One-time-per-click recovery for messages sent before this tracking
  // existed -- scans just the currently-selected guild's posting channels
  // if guildId is given, or every active guild's if not (see the bot's
  // features/botMessages.js). Backfilled rows go through the exact same
  // bot_messages table as live-tracked ones, so they're deletable from
  // the Messages tab (and from Discord itself) the same way. Awaited
  // directly rather than fire-and-forget -- capped at 100 messages per
  // channel, so even a handful of guilds finishes in a few seconds.
  app.post('/api/messages/backfill', requireAuth, async (req, res) => {
    try {
      const result = await backfillMessages(client, req.body.guildId || null);
      res.json({ ok: true, ...result });
    } catch (err) {
      console.error('[Dashboard] Error in /api/messages/backfill:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // API: Channel Errors
  // Currently-unresolved channel-send failures (e.g. Discord "Missing
  // Access" after the bot's role loses View Channel/Send Messages) -- see
  // db.channelErrors. One row per broken (guild, channel), auto-cleared the
  // moment a send to that channel succeeds again, so this only ever lists
  // things that still need attention right now. guildId optional, same
  // "All Servers" convention as /api/messages.
  app.get('/api/channel-errors', requireAuth, (req, res) => {
    try {
      const rows = db.channelErrors.getRecent(50, req.query.guildId);
      const enriched = rows.map(r => {
        const guild = client.guilds.cache.get(r.guild_id);
        return {
          ...r,
          guild_name: guild?.name || r.guild_id,
          channel_name: guild?.channels.cache.get(r.channel_id)?.name || r.channel_id
        };
      });
      res.json(enriched);
    } catch (err) {
      console.error('[Dashboard] Error in /api/channel-errors:', err);
      res.status(500).json({ error: err.message });
    }
  });
}

function createDashboard(opts = {}) {
  validate(opts);
  const {
    db, viewsDir, sessionSecretFallback = 'bot-dashboard-secret',
    channelConfigKeys, registrationChannelKeys, giftcode,
    redeemSources = { global: 'dashboard', perGuild: 'dashboard' },
    backfillMessages, registerRoutes
  } = opts;

  function start(client) {
    console.log('[Dashboard] Starting initialization...');

    try {
      const app = express();
      console.log('[Dashboard] Express app created');

      // ─── Middleware ─────────────────────────────────────────────────────

      app.use(express.json());
      app.use(express.urlencoded({ extended: true }));
      console.log('[Dashboard] Basic middleware added');

      // ─── Session Store ──────────────────────────────────────────────────

      console.log('[Dashboard] Creating session store...');
      let sessionStore;
      try {
        sessionStore = new SQLiteStore({ client: db.getRawDb() });
        console.log('[Dashboard] Session store created successfully');
      } catch (err) {
        console.error('[Dashboard] FAILED to create session store:', err.message);
        throw err;
      }

      app.use(session({
        store: sessionStore,
        secret: process.env.SESSION_SECRET || sessionSecretFallback,
        resave: false,
        saveUninitialized: false,
        cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
      }));
      console.log('[Dashboard] Session middleware added');

      // ─── Passport ───────────────────────────────────────────────────────

      console.log('[Dashboard] Initializing passport...');
      app.use(passport.initialize());
      app.use(passport.session());
      console.log('[Dashboard] Passport middleware added');

      console.log('[Dashboard] Setting up Discord OAuth strategy...');
      try {
        passport.use(new DiscordStrategy({
          clientID: process.env.DISCORD_CLIENT_ID,
          clientSecret: process.env.DISCORD_CLIENT_SECRET,
          callbackURL: `${process.env.DASHBOARD_URL}/auth/callback`,
          scope: ['identify'],
          // The oauth library's default Node User-Agent reads as bot-like to
          // Cloudflare (which fronts discord.com's API) and can trip its WAF.
          customHeaders: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
          }
        }, (accessToken, refreshToken, profile, done) => {
          if (profile.id !== process.env.OWNER_DISCORD_ID) {
            return done(null, false, { message: 'Unauthorized' });
          }
          return done(null, profile);
        }));
        console.log('[Dashboard] Discord OAuth strategy configured');
      } catch (err) {
        console.error('[Dashboard] FAILED to configure Discord OAuth:', err.message);
        throw err;
      }

      passport.serializeUser((user, done) => done(null, user));
      passport.deserializeUser((user, done) => done(null, user));
      console.log('[Dashboard] Passport serialization configured');

      // ─── Auth Middleware ────────────────────────────────────────────────

      function requireAuth(req, res, next) {
        if (req.isAuthenticated()) return next();
        if (req.path.startsWith('/api/')) {
          return res.status(401).json({ error: 'Not authenticated' });
        }
        res.redirect('/login');
      }

      // ─── Routes ─────────────────────────────────────────────────────────

      console.log('[Dashboard] Setting up routes...');

      // Auth routes
      app.get('/login', (req, res) => {
        res.sendFile(path.join(viewsDir, 'login.html'));
      });

      app.get('/auth/discord', passport.authenticate('discord'));

      app.get('/auth/callback', (req, res, next) => {
        passport.authenticate('discord', (err, user, info) => {
          if (err) {
            console.error('[Dashboard] OAuth callback error:', err.message);
            // InternalOAuthError wraps the raw response Discord's token endpoint
            // returned (e.g. invalid_client, invalid_grant) — log it so a bad
            // secret or redirect URI mismatch shows up instead of a bare 500.
            if (err.oauthError) {
              console.error('[Dashboard] Discord token endpoint response:', err.oauthError.data || err.oauthError);
            }
            return res.redirect('/login');
          }
          if (!user) {
            console.warn('[Dashboard] OAuth callback: authentication rejected', info);
            return res.redirect('/login');
          }
          req.logIn(user, (loginErr) => {
            if (loginErr) {
              console.error('[Dashboard] Session login error:', loginErr);
              return res.redirect('/login');
            }
            return res.redirect('/');
          });
        })(req, res, next);
      });

      app.get('/auth/logout', (req, res) => {
        req.logout(() => res.redirect('/login'));
      });

      // Dashboard page
      app.get('/', requireAuth, (req, res) => {
        res.sendFile(path.join(viewsDir, 'index.html'));
      });

      // Health check (no auth)
      app.get('/health', (req, res) => {
        res.json({ status: 'ok', timestamp: new Date().toISOString() });
      });

      registerSharedRoutes(app, {
        client, requireAuth, db, channelConfigKeys, registrationChannelKeys, giftcode, redeemSources, backfillMessages
      });

      // The bot's own routes. None of their paths overlap the shared ones,
      // so registration order doesn't affect matching.
      if (registerRoutes) registerRoutes(app, { requireAuth, client });

      console.log('[Dashboard] All routes configured');

      // ─── Start Server ───────────────────────────────────────────────────

      const port = process.env.PORT || process.env.DASHBOARD_PORT || 3000;
      console.log(`[Dashboard] Attempting to listen on port ${port}...`);

      const server = app.listen(port, '0.0.0.0', () => {
        console.log(`[Dashboard] Running at ${process.env.DASHBOARD_URL || `http://localhost:${port}`}`);
      });

      server.on('error', (err) => {
        console.error('[Dashboard] Server error:', err);
        process.exit(1);
      });

      server.on('listening', () => {
        console.log('[Dashboard] Server is now listening');
      });

      // Handle process errors
      process.on('uncaughtException', (err) => {
        console.error('[Dashboard] Uncaught exception:', err);
        process.exit(1);
      });

      process.on('unhandledRejection', (reason, promise) => {
        console.error('[Dashboard] Unhandled rejection:', reason);
      });

      return server;

    } catch (err) {
      console.error('[Dashboard] Failed to start:', err.message);
      console.error('[Dashboard] Stack:', err.stack);
      process.exit(1);
    }
  }

  return { start };
}

module.exports = { createDashboard, registerSharedRoutes };
