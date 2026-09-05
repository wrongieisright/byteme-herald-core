const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openCoreTestDb } = require('./helpers/coreDb');
const { createBotMessages, previewFromContent } = require('../features/botMessages');

const { db, cleanup } = openCoreTestDb('botmessages');
process.on('exit', cleanup);

// Configured the way ByteMe wires it: three posting channels, with the
// giftcode channel carrying two embed kinds told apart by title.
const botMessages = createBotMessages({
  db,
  backfillChannelTypes: { schedules: 'scheduled', reminders: 'reminder', giftcode: 'giftcode_summary' },
  classifyMessage: (message, configKey) => {
    if (configKey !== 'giftcode') return { schedules: 'scheduled', reminders: 'reminder' }[configKey];
    const title = message.embeds?.[0]?.title || '';
    return title.includes('Code Catch-Up') ? 'catchup_summary' : 'giftcode_summary';
  }
});

// ─── previewFromContent ─────────────────────────────────────────────────────

test('previewFromContent: returns short content unchanged, truncates long content to 200 chars + ellipsis, empty for falsy', () => {
  assert.equal(previewFromContent('short message'), 'short message');
  const preview = previewFromContent('x'.repeat(250));
  assert.equal(preview.length, 201);
  assert.ok(preview.endsWith('…'));
  assert.equal(previewFromContent(''), '');
  assert.equal(previewFromContent(null), '');
  assert.equal(botMessages.previewFromContent(undefined), ''); // also exposed per-instance
});

// ─── trackSentMessage ───────────────────────────────────────────────────────

test('trackSentMessage logs a row with the sent message\'s guild/channel/message IDs', async () => {
  await botMessages.trackSentMessage({ guildId: 'trackGuild', channelId: 'trackChannel', id: 'trackMsg1' }, 'giftcode_summary', 'Gift code X results');
  const rows = db.botMessages.getRecent(100, 'trackGuild');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].message_id, 'trackMsg1');
  assert.equal(rows[0].message_type, 'giftcode_summary');
  assert.equal(rows[0].preview, 'Gift code X results');
});

test('trackSentMessage self-heals a previously-logged channel_errors row for the same channel', async () => {
  db.channelErrors.log('healGuild', 'healChannel', 'giftcode_summary', 'Missing Access');
  assert.equal(db.channelErrors.getRecent(100, 'healGuild').length, 1);
  await botMessages.trackSentMessage({ guildId: 'healGuild', channelId: 'healChannel', id: 'healMsg1' }, 'giftcode_summary', 'x');
  assert.equal(db.channelErrors.getRecent(100, 'healGuild').length, 0);
});

test('trackSentMessage never throws even if logging fails (e.g. malformed input)', async () => {
  await assert.doesNotReject(botMessages.trackSentMessage({}, 'giftcode_summary', 'preview'));
});

// ─── backfillMessages ───────────────────────────────────────────────────────

function makeFakeDiscordMessage({ authorId, content, embeds, createdAt }) {
  return { author: { id: authorId }, content, embeds: embeds || [], createdAt };
}

function makeFakeBackfillClient({ botUserId, guilds }) {
  const channelIdFor = (guildId, key) => `${guildId}-${key}-channel`;
  for (const [guildId, config] of Object.entries(guilds)) {
    for (const key of Object.keys(config)) db.channels.set(guildId, key, channelIdFor(guildId, key));
  }
  return {
    user: { id: botUserId },
    guilds: { cache: new Map(Object.keys(guilds).map(id => [id, { id }])) },
    channels: {
      fetch: async (channelId) => {
        for (const [guildId, config] of Object.entries(guilds)) {
          for (const key of Object.keys(config)) {
            if (channelIdFor(guildId, key) === channelId) {
              const msgs = config[key];
              return { messages: { fetch: async () => new Map(msgs.map((m, i) => [`${channelId}-msg${i}`, { ...m, id: `${channelId}-msg${i}` }])) } };
            }
          }
        }
        throw new Error('channel not found: ' + channelId);
      }
    }
  };
}

test('backfillMessages: imports bot-authored messages, skips messages from other authors', async () => {
  const client = makeFakeBackfillClient({
    botUserId: 'BOT1',
    guilds: { backfillGuildA: { giftcode: [
      makeFakeDiscordMessage({ authorId: 'BOT1', content: '', embeds: [{ title: '🎁 Gift Code Redemption — `X`' }] }),
      makeFakeDiscordMessage({ authorId: 'someHuman', content: 'unrelated chatter' })
    ] } }
  });
  const result = await botMessages.backfillMessages(client);
  assert.equal(result.scanned, 2);
  assert.equal(result.imported, 1);
  const rows = db.botMessages.getRecent(100, 'backfillGuildA');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].message_type, 'giftcode_summary');
  assert.equal(rows[0].preview, '🎁 Gift Code Redemption — `X`'); // embed title, no content
});

test('backfillMessages: the injected classifier decides message_type from the message and channel', async () => {
  const client = makeFakeBackfillClient({
    botUserId: 'BOT1',
    guilds: { backfillGuildB: {
      giftcode: [makeFakeDiscordMessage({ authorId: 'BOT1', embeds: [{ title: '🎁 Code Catch-Up — Alice' }] })],
      schedules: [makeFakeDiscordMessage({ authorId: 'BOT1', content: 'Good morning!' })],
      reminders: [makeFakeDiscordMessage({ authorId: 'BOT1', content: '<@user1> reminder: do the thing' })]
    } }
  });
  await botMessages.backfillMessages(client);
  const types = db.botMessages.getRecent(100, 'backfillGuildB').map(r => r.message_type).sort();
  assert.deepEqual(types, ['catchup_summary', 'reminder', 'scheduled']);
});

test('backfillMessages: without a classifier, backfillChannelTypes is the lookup', async () => {
  const plain = createBotMessages({ db, backfillChannelTypes: { monitor: 'player_monitor' } });
  const client = makeFakeBackfillClient({
    botUserId: 'BOT1',
    guilds: { backfillGuildPlain: { monitor: [makeFakeDiscordMessage({ authorId: 'BOT1', content: 'level up' })] } }
  });
  await plain.backfillMessages(client);
  assert.equal(db.botMessages.getRecent(100, 'backfillGuildPlain')[0].message_type, 'player_monitor');
});

test('backfillMessages: is idempotent -- re-running imports zero duplicates', async () => {
  const client = makeFakeBackfillClient({
    botUserId: 'BOT1',
    guilds: { backfillGuildD: { giftcode: [makeFakeDiscordMessage({ authorId: 'BOT1', embeds: [{ title: '🎁 Gift Code Redemption — `X`' }] })] } }
  });
  assert.equal((await botMessages.backfillMessages(client)).imported, 1);
  const second = await botMessages.backfillMessages(client);
  assert.equal(second.scanned, 1);
  assert.equal(second.imported, 0);
  assert.equal(db.botMessages.getRecent(100, 'backfillGuildD').length, 1);
});

test('backfillMessages: a channel the bot only reads from is never scanned for outbound messages', async () => {
  db.channels.set('backfillGuildE', 'wosupdates', 'someUpdatesChannel'); // no fetch registered -> would throw if scanned
  const client = makeFakeBackfillClient({ botUserId: 'BOT1', guilds: { backfillGuildE: {} } });
  const result = await botMessages.backfillMessages(client);
  assert.equal(result.scanned, 0);
  assert.equal(result.imported, 0);
});

test('backfillMessages: an explicit guildId scopes the scan to that one server', async () => {
  const client = makeFakeBackfillClient({
    botUserId: 'BOT1',
    guilds: {
      scopeGuildA: { schedules: [makeFakeDiscordMessage({ authorId: 'BOT1', content: 'a' })] },
      scopeGuildB: { schedules: [makeFakeDiscordMessage({ authorId: 'BOT1', content: 'b' })] }
    }
  });
  const result = await botMessages.backfillMessages(client, 'scopeGuildA');
  assert.equal(result.imported, 1);
  assert.equal(db.botMessages.getRecent(100, 'scopeGuildA').length, 1);
  assert.equal(db.botMessages.getRecent(100, 'scopeGuildB').length, 0);
});

test('backfillMessages: useMessageTimestamps stamps rows with the message\'s real createdAt, otherwise scan time', async () => {
  const createdAt = new Date('2025-03-04T05:06:07.000Z');
  const guilds = { tsGuild: { schedules: [makeFakeDiscordMessage({ authorId: 'BOT1', content: 'old news', createdAt })] } };

  await botMessages.backfillMessages(makeFakeBackfillClient({ botUserId: 'BOT1', guilds }));
  assert.notEqual(db.botMessages.getRecent(100, 'tsGuild')[0].sent_at, '2025-03-04 05:06:07');

  const stamped = createBotMessages({ db, backfillChannelTypes: { schedules: 'scheduled' }, useMessageTimestamps: true });
  const guilds2 = { tsGuild2: { schedules: [makeFakeDiscordMessage({ authorId: 'BOT1', content: 'old news', createdAt })] } };
  await stamped.backfillMessages(makeFakeBackfillClient({ botUserId: 'BOT1', guilds: guilds2 }));
  assert.equal(db.botMessages.getRecent(100, 'tsGuild2')[0].sent_at, '2025-03-04 05:06:07');
});

test('backfillMessages: a channel that cannot be fetched is logged to channel_errors and skipped', async () => {
  db.channels.set('brokenGuild', 'schedules', 'brokenChan');
  const client = { user: { id: 'BOT1' }, guilds: { cache: new Map([['brokenGuild', { id: 'brokenGuild' }]]) }, channels: { fetch: async () => { throw new Error('Missing Access'); } } };
  const result = await botMessages.backfillMessages(client);
  assert.equal(result.scanned, 0);
  const errors = db.channelErrors.getRecent(100, 'brokenGuild');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].context, 'backfill_fetch_channel');
});
