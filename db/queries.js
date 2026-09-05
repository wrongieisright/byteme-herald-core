// Query objects over the shared tables in db/schema.js, built against
// whatever better-sqlite3 handle the bot opened -- the core never opens a
// database itself, so the bot keeps owning its file path and lifetime.
//
// Each bot composes these into its own `db/database.js` exports alongside
// its game-specific objects (`players`, `redemptions`), and can extend one
// where it needs a game-specific query -- e.g. playerGuilds.getForGuild()
// selects each game's own progression columns, so it lives in the bot:
//
//   const shared = createSharedQueries(db);
//   const playerGuilds = { ...shared.playerGuilds, getForGuild(guild_id) { ... } };

function createSharedQueries(db) {
  // ─── Player-Guild Links ───────────────────────────────────────────────────

  const playerGuilds = {
    link(guild_id, player_id, added_by) {
      return db.prepare(`
        INSERT OR IGNORE INTO player_guilds (guild_id, player_id, added_by)
        VALUES (?, ?, ?)
      `).run(guild_id, player_id, added_by);
    },

    isLinked(guild_id, player_id) {
      return !!db.prepare(`
        SELECT 1 FROM player_guilds WHERE guild_id = ? AND player_id = ?
      `).get(guild_id, player_id);
    },

    // All (guild_id, player_id) pairs in one query -- used by the
    // dashboard to annotate the full player list with guild membership
    // without an N+1 query per player.
    getAllLinks() {
      return db.prepare(`SELECT guild_id, player_id FROM player_guilds`).all();
    },

    // Player IDs linked to at least one of the given guild IDs. Callers pass
    // the bot's *currently active* guild IDs (discordClient.guilds.cache) so
    // gift-code redemption only runs for players whose server still has the
    // bot -- a server that leaves or gets removed (see unlink()/removeserver)
    // keeps its player_guilds rows in case the bot is re-added, but those
    // players shouldn't keep burning redemption attempts in the meantime.
    getActivePlayerIds(guildIds) {
      if (!guildIds || guildIds.length === 0) return new Set();
      const placeholders = guildIds.map(() => '?').join(',');
      const rows = db.prepare(`
        SELECT DISTINCT player_id FROM player_guilds WHERE guild_id IN (${placeholders})
      `).all(...guildIds);
      return new Set(rows.map(r => r.player_id));
    },

    // Unlinks a player from one guild. If that was their last remaining guild
    // link, the shared player row is deleted too since nothing references it
    // anymore. Returns whether the player was fully removed.
    unlink(guild_id, player_id) {
      db.prepare(`
        DELETE FROM player_guilds WHERE guild_id = ? AND player_id = ?
      `).run(guild_id, player_id);

      const { n } = db.prepare(`
        SELECT COUNT(*) AS n FROM player_guilds WHERE player_id = ?
      `).get(player_id);

      if (n === 0) {
        db.prepare(`DELETE FROM players WHERE player_id = ?`).run(player_id);
        return { fullyRemoved: true };
      }
      return { fullyRemoved: false };
    },

    // Every guild a player is currently linked to -- used before a full
    // removeEverywhere() so the caller can notify each affected guild before
    // the rows (and the guild list itself) are gone.
    getGuildsForPlayer(player_id) {
      return db.prepare(`
        SELECT guild_id FROM player_guilds WHERE player_id = ?
      `).all(player_id).map(r => r.guild_id);
    },

    // Unlike unlink() (one guild at a time), this always clears every guild
    // at once -- for when the player-ID/state pairing itself is confirmed
    // wrong (err_code 40020, "USER INFO ERROR", on both games' APIs), which
    // isn't specific to whichever guild's redemption attempt happened to
    // discover it.
    removeEverywhere(player_id) {
      db.prepare(`DELETE FROM player_guilds WHERE player_id = ?`).run(player_id);
      db.prepare(`DELETE FROM players WHERE player_id = ?`).run(player_id);
    }
  };

  // ─── Bans ─────────────────────────────────────────────────────────────────
  // Both scoped by guild_id, same as player_guilds -- a ban in one server has
  // no effect in another.

  const bannedPlayers = {
    ban(guild_id, player_id, reason, banned_by) {
      return db.prepare(`
        INSERT OR REPLACE INTO banned_players (guild_id, player_id, reason, banned_by)
        VALUES (?, ?, ?, ?)
      `).run(guild_id, player_id, reason || null, banned_by);
    },

    unban(guild_id, player_id) {
      return db.prepare(`DELETE FROM banned_players WHERE guild_id = ? AND player_id = ?`).run(guild_id, player_id);
    },

    isBanned(guild_id, player_id) {
      return !!db.prepare(`SELECT 1 FROM banned_players WHERE guild_id = ? AND player_id = ?`).get(guild_id, player_id);
    },

    getForGuild(guild_id) {
      return db.prepare(`SELECT * FROM banned_players WHERE guild_id = ? ORDER BY banned_at DESC`).all(guild_id);
    }
  };

  const bannedUsers = {
    ban(guild_id, discord_user_id, reason, banned_by) {
      return db.prepare(`
        INSERT OR REPLACE INTO banned_users (guild_id, discord_user_id, reason, banned_by)
        VALUES (?, ?, ?, ?)
      `).run(guild_id, discord_user_id, reason || null, banned_by);
    },

    unban(guild_id, discord_user_id) {
      return db.prepare(`DELETE FROM banned_users WHERE guild_id = ? AND discord_user_id = ?`).run(guild_id, discord_user_id);
    },

    isBanned(guild_id, discord_user_id) {
      return !!db.prepare(`SELECT 1 FROM banned_users WHERE guild_id = ? AND discord_user_id = ?`).get(guild_id, discord_user_id);
    },

    getForGuild(guild_id) {
      return db.prepare(`SELECT * FROM banned_users WHERE guild_id = ? ORDER BY banned_at DESC`).all(guild_id);
    }
  };

  // ─── Schedules ────────────────────────────────────────────────────────────

  const schedules = {
    add({ guild_id, channel_id, message, cron_expr, timezone, dst_follow, one_time, fire_at, label, created_by, recurrence_type, interval_days, anchor_date }) {
      return db.prepare(`
        INSERT INTO schedules (guild_id, channel_id, message, cron_expr, timezone, dst_follow, one_time, fire_at, label, created_by, recurrence_type, interval_days, anchor_date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(guild_id, channel_id, message, cron_expr, timezone, dst_follow ? 1 : 0, one_time ? 1 : 0, fire_at, label, created_by, recurrence_type || null, interval_days || null, anchor_date || null);
    },

    edit(id, fields) {
      const allowed = ['channel_id', 'message', 'cron_expr', 'timezone', 'dst_follow', 'fire_at', 'label', 'active', 'recurrence_type', 'interval_days', 'anchor_date'];
      const keys = Object.keys(fields).filter(k => allowed.includes(k));
      if (!keys.length) return null;
      const set = keys.map(k => `${k} = ?`).join(', ');
      const vals = keys.map(k => fields[k]);
      return db.prepare(`UPDATE schedules SET ${set} WHERE id = ?`).run(...vals, id);
    },

    delete(id) {
      return db.prepare(`DELETE FROM schedules WHERE id = ?`).run(id);
    },

    getAll(guild_id) {
      return db.prepare(`SELECT * FROM schedules WHERE guild_id = ? AND active = 1 ORDER BY id`).all(guild_id);
    },

    getById(id) {
      return db.prepare(`SELECT * FROM schedules WHERE id = ?`).get(id);
    },

    getAllActive() {
      return db.prepare(`SELECT * FROM schedules WHERE active = 1`).all();
    },

    deactivate(id) {
      return db.prepare(`UPDATE schedules SET active = 0 WHERE id = ?`).run(id);
    }
  };

  // ─── Reminders ────────────────────────────────────────────────────────────

  const reminders = {
    add({ guild_id, channel_id, user_id, message, fire_at, timezone, created_by }) {
      return db.prepare(`
        INSERT INTO reminders (guild_id, channel_id, user_id, message, fire_at, timezone, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(guild_id, channel_id, user_id, message, fire_at, timezone, created_by);
    },

    getPending() {
      return db.prepare(`SELECT * FROM reminders WHERE fired = 0`).all();
    },

    markFired(id) {
      return db.prepare(`UPDATE reminders SET fired = 1 WHERE id = ?`).run(id);
    },

    delete(id) {
      return db.prepare(`DELETE FROM reminders WHERE id = ?`).run(id);
    },

    getAll(guild_id) {
      return db.prepare(`SELECT * FROM reminders WHERE guild_id = ? AND fired = 0 ORDER BY fire_at`).all(guild_id);
    },

    getById(id) {
      return db.prepare(`SELECT * FROM reminders WHERE id = ?`).get(id);
    },

    edit(id, fields) {
      const allowed = ['channel_id', 'message', 'fire_at', 'timezone', 'user_id'];
      const keys = Object.keys(fields).filter(k => allowed.includes(k));
      if (!keys.length) return null;
      const set = keys.map(k => `${k} = ?`).join(', ');
      const vals = keys.map(k => fields[k]);
      return db.prepare(`UPDATE reminders SET ${set} WHERE id = ?`).run(...vals, id);
    }
  };

  // ─── Channel Config ───────────────────────────────────────────────────────

  const channels = {
    set(guild_id, config_key, channel_id) {
      return db.prepare(`
        INSERT OR REPLACE INTO channel_config (guild_id, config_key, channel_id)
        VALUES (?, ?, ?)
      `).run(guild_id, config_key, channel_id);
    },

    get(guild_id, config_key) {
      const row = db.prepare(`SELECT channel_id FROM channel_config WHERE guild_id = ? AND config_key = ?`).get(guild_id, config_key);
      return row ? row.channel_id : null;
    },

    getAll(guild_id) {
      return db.prepare(`SELECT config_key, channel_id FROM channel_config WHERE guild_id = ?`).all(guild_id);
    }
  };

  // ─── User Prefs ───────────────────────────────────────────────────────────

  const userPrefs = {
    // guild_id '' (or omitted) is the user's global default.
    setTimezone(user_id, guild_id, timezone) {
      const gid = guild_id || '';
      return db.prepare(`INSERT OR REPLACE INTO user_prefs (user_id, guild_id, timezone) VALUES (?, ?, ?)`).run(user_id, gid, timezone);
    },

    // Falls back to the user's global default (guild_id '') when a
    // guild-specific timezone hasn't been set yet.
    getTimezone(user_id, guild_id) {
      const gid = guild_id || '';
      if (gid) {
        const row = db.prepare(`SELECT timezone FROM user_prefs WHERE user_id = ? AND guild_id = ?`).get(user_id, gid);
        if (row) return row.timezone;
      }
      const globalRow = db.prepare(`SELECT timezone FROM user_prefs WHERE user_id = ? AND guild_id = ''`).get(user_id);
      return globalRow ? globalRow.timezone : 'UTC';
    }
  };

  // ─── Blocked Codes ────────────────────────────────────────────────────────
  // A code deleted from the dashboard as a mistake (typo, misdetected text)
  // stays permanently blocked -- global, not per-guild, since a mistaken code
  // is wrong everywhere, not just on the server that first noticed it.

  const blockedCodes = {
    block(code) {
      return db.prepare(`INSERT OR IGNORE INTO blocked_codes (code) VALUES (?)`).run(code);
    },

    isBlocked(code) {
      return !!db.prepare(`SELECT 1 FROM blocked_codes WHERE code = ?`).get(code);
    }
  };

  // ─── Bot Messages ─────────────────────────────────────────────────────────

  const botMessages = {
    // sent_at defaults to the column's own datetime('now') for live tracking
    // (called right after the message actually sends, so "now" is accurate),
    // but a backfill scan can pass the real historical Discord timestamp
    // explicitly -- otherwise every backfilled row would be stamped with
    // whenever the scan happened to run instead of when the message was
    // actually posted, which could be days or weeks earlier.
    log(guild_id, channel_id, message_id, message_type, preview, sent_at = null) {
      return db.prepare(`
        INSERT INTO bot_messages (guild_id, channel_id, message_id, message_type, preview, sent_at)
        VALUES (?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
      `).run(guild_id, channel_id, message_id, message_type, preview || null, sent_at);
    },

    getById(id) {
      return db.prepare(`SELECT * FROM bot_messages WHERE id = ?`).get(id);
    },

    // Used by the backfill scan to avoid re-importing a message it's already
    // seen on a previous run -- message_id is Discord's own snowflake, so
    // it's a reliable dedupe key across repeated scans of the same channel.
    existsByMessageId(message_id) {
      return !!db.prepare(`SELECT 1 FROM bot_messages WHERE message_id = ?`).get(message_id);
    },

    // guild_id is optional -- omit it (or "All Servers" in the dashboard) to
    // see every server's sent messages in one list, same convention as
    // redemptions/playerChanges.
    getRecent(limit = 100, guild_id) {
      if (guild_id) {
        return db.prepare(`
          SELECT * FROM bot_messages WHERE guild_id = ? ORDER BY sent_at DESC LIMIT ?
        `).all(guild_id, limit);
      }
      return db.prepare(`SELECT * FROM bot_messages ORDER BY sent_at DESC LIMIT ?`).all(limit);
    },

    remove(id) {
      return db.prepare(`DELETE FROM bot_messages WHERE id = ?`).run(id);
    }
  };

  // ─── Player Changes ───────────────────────────────────────────────────────

  const playerChanges = {
    log(player_id, change_type, old_value, new_value) {
      return db.prepare(`
        INSERT INTO player_changes (player_id, change_type, old_value, new_value)
        VALUES (?, ?, ?, ?)
      `).run(player_id, change_type, old_value, new_value);
    },

    // guild_id is optional -- player_changes itself has no guild_id column
    // (a change is detected once per shared player row, not per server), so
    // scoping to one guild means joining through player_guilds, same pattern
    // as the bots' redemptions.getByCode/getAllCodes.
    getRecent(limit = 50, guild_id) {
      if (guild_id) {
        return db.prepare(`
          SELECT pc.* FROM player_changes pc
          JOIN player_guilds pg ON pg.player_id = pc.player_id AND pg.guild_id = ?
          ORDER BY pc.detected_at DESC LIMIT ?
        `).all(guild_id, limit);
      }
      return db.prepare(`SELECT * FROM player_changes ORDER BY detected_at DESC LIMIT ?`).all(limit);
    }
  };

  // ─── Channel Errors ───────────────────────────────────────────────────────

  const channelErrors = {
    // Upserts so a repeatedly-broken channel keeps exactly one row -- its
    // latest error and timestamp -- instead of growing unbounded.
    log(guild_id, channel_id, context, error_message) {
      return db.prepare(`
        INSERT INTO channel_errors (guild_id, channel_id, context, error_message, occurred_at)
        VALUES (?, ?, ?, ?, datetime('now'))
        ON CONFLICT(guild_id, channel_id) DO UPDATE SET
          context = excluded.context,
          error_message = excluded.error_message,
          occurred_at = excluded.occurred_at
      `).run(guild_id, channel_id, context, error_message);
    },

    // Called from trackSentMessage on every successful send -- self-heals the
    // warning the moment a previously-broken channel starts working again,
    // without every individual success-path call site needing to know about it.
    clear(guild_id, channel_id) {
      return db.prepare(`DELETE FROM channel_errors WHERE guild_id = ? AND channel_id = ?`).run(guild_id, channel_id);
    },

    // guild_id optional, same convention as botMessages/playerChanges.
    getRecent(limit = 50, guild_id) {
      if (guild_id) {
        return db.prepare(`
          SELECT * FROM channel_errors WHERE guild_id = ? ORDER BY occurred_at DESC LIMIT ?
        `).all(guild_id, limit);
      }
      return db.prepare(`SELECT * FROM channel_errors ORDER BY occurred_at DESC LIMIT ?`).all(limit);
    }
  };

  return { playerGuilds, bannedPlayers, bannedUsers, schedules, reminders, channels, userPrefs, blockedCodes, botMessages, playerChanges, channelErrors };
}

module.exports = { createSharedQueries };
