// Truncated previews are all the dashboard needs to recognize which message
// a row refers to -- reproducing a full embed there would be noise.
const PREVIEW_MAX = 200;

function previewFromContent(content) {
  if (!content) return '';
  return content.length > PREVIEW_MAX ? content.slice(0, PREVIEW_MAX) + '…' : content;
}

function defaultPreviewFromEmbed(embed) {
  const title = embed?.title ?? embed?.data?.title;
  const description = embed?.description ?? embed?.data?.description;
  return previewFromContent([title, description].filter(Boolean).join(' — '));
}

function defaultPreviewFromMessage(message) {
  if (message.content) return previewFromContent(message.content);
  if (message.embeds?.[0]) return defaultPreviewFromEmbed(message.embeds[0]);
  return '';
}

// Backfill deliberately caps at the most recent N messages per channel (one
// Discord API call each) rather than paging back through full history, to
// keep a manual "scan" click fast and cheap.
const BACKFILL_LIMIT_PER_CHANNEL = 100;

// Builds the message-tracking module for one bot. Everything a bot's
// messages have in common lives here; what differs per bot -- which
// configured channels it posts to, and how a fetched message's type is
// recognized after the fact -- is injected:
//
//   db                    the bot's composed db module (needs botMessages,
//                         channelErrors, channels)
//   backfillChannelTypes  { [channel config_key]: default message_type }
//                         -- the channel roles the bot posts to, each with
//                         the message_type a message found there is
//                         assumed to be when nothing more specific matches
//   classifyMessage       optional (message, configKey) => message_type,
//                         for bots whose channels carry several message
//                         kinds; defaults to the backfillChannelTypes lookup
//   previewFromMessage    optional override of how a fetched message is
//                         previewed (e.g. to include embed fields)
//   useMessageTimestamps  when true, backfilled rows are stamped with the
//                         message's real Discord createdAt instead of the
//                         scan time
function createBotMessages({
  db,
  backfillChannelTypes = {},
  classifyMessage,
  previewFromMessage = defaultPreviewFromMessage,
  useMessageTimestamps = false
}) {
  const classify = classifyMessage || ((message, configKey) => backfillChannelTypes[configKey]);

  // Called right after every proactive channel.send() (scheduled messages,
  // reminders, gift-code summaries, catch-up summaries, monitor alerts) so
  // the dashboard can list and delete them later -- especially useful in
  // servers the bot owner isn't personally a member of and so can't
  // moderate by hand. Never lets a logging failure take down the caller; a
  // message that fails to get tracked just can't be deleted from the
  // dashboard later, which is far better than the message itself failing
  // to send.
  async function trackSentMessage(sentMessage, messageType, preview) {
    try {
      db.botMessages.log(sentMessage.guildId, sentMessage.channelId, sentMessage.id, messageType, preview);
      // Any successful send self-heals a previously-logged channel_errors row
      // for this channel -- see that table's comment in db/schema.js for why
      // this is the one place that needs to know about clearing it.
      db.channelErrors.clear(sentMessage.guildId, sentMessage.channelId);
    } catch (err) {
      console.error('[BotMessages] Failed to log sent message:', err.message);
    }
  }

  // ─── Backfill ─────────────────────────────────────────────────────────────
  // Messages sent before this tracking existed were never logged anywhere --
  // there's no way to enumerate "everything the bot has ever sent" after the
  // fact, but a fetched Message object still tells us who sent it, so
  // scanning each configured channel's recent history and keeping the ones
  // authored by the bot recovers as much of that as Discord still has.
  // Scoped to the same channel roles as live tracking (backfillChannelTypes)
  // so the Messages tab stays consistent about what it does and doesn't
  // cover, whether a row got there live or via backfill. Safe to re-run --
  // existsByMessageId skips anything it's already seen.
  //
  // guildId scopes the scan to just that one server (a dashboard's Messages
  // tab can pass its currently-selected server) -- omit it to scan every
  // server the bot is in.
  async function backfillMessages(discordClient, guildId) {
    let scanned = 0;
    let imported = 0;

    const guildIds = guildId ? [guildId] : [...discordClient.guilds.cache.keys()];

    for (const gId of guildIds) {
      for (const configKey of Object.keys(backfillChannelTypes)) {
        const channelId = db.channels.get(gId, configKey);
        if (!channelId) continue;

        let channel;
        try {
          channel = await discordClient.channels.fetch(channelId);
        } catch (err) {
          console.error(`[BotMessages] Backfill: could not fetch channel ${channelId}:`, err.message);
          db.channelErrors.log(gId, channelId, 'backfill_fetch_channel', err.message);
          continue;
        }

        let messages;
        try {
          messages = await channel.messages.fetch({ limit: BACKFILL_LIMIT_PER_CHANNEL });
        } catch (err) {
          console.error(`[BotMessages] Backfill: could not read history for ${channelId}:`, err.message);
          db.channelErrors.log(gId, channelId, 'backfill_read_history', err.message);
          continue;
        }

        for (const message of messages.values()) {
          scanned++;
          if (message.author.id !== discordClient.user.id) continue;
          if (db.botMessages.existsByMessageId(message.id)) continue;

          const messageType = classify(message, configKey);
          // message.createdAt is the message's real original send time; the
          // SQLite-style "YYYY-MM-DD HH:MM:SS" matches what datetime('now')
          // writes for live-tracked rows, so the two sort together.
          const sentAt = useMessageTimestamps && message.createdAt
            ? message.createdAt.toISOString().slice(0, 19).replace('T', ' ')
            : null;
          db.botMessages.log(gId, channelId, message.id, messageType, previewFromMessage(message), sentAt);
          imported++;
        }
      }
    }

    return { scanned, imported };
  }

  return { trackSentMessage, previewFromContent, previewFromMessage, backfillMessages };
}

module.exports = { createBotMessages, previewFromContent, defaultPreviewFromEmbed, defaultPreviewFromMessage };
