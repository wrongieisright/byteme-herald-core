const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { createDashboard, registerSharedRoutes } = require('../web/dashboard');
const { openCoreTestDb } = require('./helpers/coreDb');

// The shared /api routes are mounted on a bare express app with a stub
// requireAuth (the bots' own smoke tests reached the same conclusion: faking
// passport's real Discord handshake isn't worth it). The bootstrap itself --
// session store, passport, auth routes, /health -- gets the same three smoke
// checks both bots run, through createDashboard proper.

// discord.js Collections are Maps with a few array-ish helpers; the routes
// use .map/.filter/.get/.has.
class Collection extends Map {
  map(fn) { return [...this.values()].map(fn); }
  filter(fn) { const c = new Collection(); for (const [k, v] of this) if (fn(v)) c.set(k, v); return c; }
}

function makeGuild(id, name, channels = []) {
  const guild = {
    id, name, left: false,
    channels: { cache: new Collection(channels.map(c => [c.id, c])) },
    async leave() { guild.left = true; }
  };
  return guild;
}

function makeClient({ guilds = [], channelFetch } = {}) {
  return {
    guilds: { cache: new Collection(guilds.map(g => [g.id, g])) },
    channels: { fetch: channelFetch || (async () => { throw new Error('not used'); }) }
  };
}

function makeStubs() {
  const calls = { redeemCode: [], redeemCodeForGuild: [], welcome: [], reminder: [], backfill: [] };
  let needing = ['p1'];
  let needingForGuild = ['p1'];
  const giftcode = {
    redeemCode: async (client, code, opts) => { calls.redeemCode.push({ code, opts }); },
    redeemCodeForGuild: async (client, guildId, code, opts) => { calls.redeemCodeForGuild.push({ guildId, code, opts }); },
    getPlayersNeedingRedemption: () => needing,
    getPlayersNeedingRedemptionForGuild: () => needingForGuild,
    postRegistrationWelcome: async (client, guildId, channelId) => { calls.welcome.push({ guildId, channelId }); },
    broadcastRegistrationReminder: async (client, guildId) => { calls.reminder.push(guildId); return 3; },
    getRedemptionProgress: () => ({ code: 'ABC', done: 2, total: 5 })
  };
  const backfillMessages = async (client, guildId) => { calls.backfill.push(guildId); return { imported: 4, scanned: 9 }; };
  return {
    calls, giftcode, backfillMessages,
    setNeeding(a, b) { needing = a; needingForGuild = b; }
  };
}

const opened = [];
after(() => { for (const o of opened) o.cleanup(); });

// A bot-shaped db: the real shared tables (coreDb) plus a recording stub for
// the bot-owned redemptions table.
function makeDb(label) {
  const core = openCoreTestDb(label);
  opened.push(core);
  const redemptionCalls = { getAllCodes: [], getByCode: [], deleteByCode: [] };
  core.db.redemptions = {
    getAllCodes(guildId) { redemptionCalls.getAllCodes.push(guildId); return [{ code: 'ABC', total: 2 }]; },
    getByCode(code, guildId) { redemptionCalls.getByCode.push({ code, guildId }); return [{ code, player_id: 'p1', result: 'redeemed' }]; },
    deleteByCode(code) { redemptionCalls.deleteByCode.push(code); }
  };
  return { db: core.db, redemptionCalls };
}

async function mount({ client, db, giftcode, backfillMessages, channelConfigKeys = ['giftcode', 'monitor', 'wosupdates'], registrationChannelKeys = ['giftcode', 'wosupdates'], redeemSources = { global: 'dashboard', perGuild: 'dashboard' } }) {
  const app = express();
  app.use(express.json());
  const requireAuth = (req, res, next) => { req.user = { id: 'owner' }; next(); };
  registerSharedRoutes(app, { client, requireAuth, db, channelConfigKeys, registrationChannelKeys, giftcode, redeemSources, backfillMessages });
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: res.status, body: await res.json() };
  };
  return { call, close: () => new Promise(r => server.close(r)) };
}

const quiet = (fn) => async (...a) => {
  const restore = console.error; console.error = () => {};
  try { return await fn(...a); } finally { console.error = restore; }
};

// ─── construction ───────────────────────────────────────────────────────────

test('createDashboard refuses to construct without every injected piece, naming each one', () => {
  assert.throws(() => createDashboard({}), (err) => {
    for (const name of ['db', 'viewsDir', 'channelConfigKeys', 'registrationChannelKeys', 'backfillMessages', 'giftcode.redeemCode', 'giftcode.getRedemptionProgress']) {
      assert.ok(err.message.includes(name), `should name ${name}: ${err.message}`);
    }
    return true;
  });
});

// ─── guilds / channels ──────────────────────────────────────────────────────

test('/api/guilds lists id and name only; DELETE leaves the guild or 404s', async () => {
  const { db } = makeDb('guilds');
  const { giftcode, backfillMessages } = makeStubs();
  const g1 = makeGuild('g1', 'One');
  const { call, close } = await mount({ client: makeClient({ guilds: [g1, makeGuild('g2', 'Two')] }), db, giftcode, backfillMessages });
  try {
    assert.deepEqual((await call('GET', '/api/guilds')).body, [{ id: 'g1', name: 'One' }, { id: 'g2', name: 'Two' }]);

    const gone = await call('DELETE', '/api/guilds/nope');
    assert.equal(gone.status, 404);
    assert.equal(gone.body.error, 'Guild not found');

    const left = await call('DELETE', '/api/guilds/g1');
    assert.deepEqual(left.body, { ok: true, name: 'One' });
    assert.equal(g1.left, true);
  } finally { await close(); }
});

test('/api/channels/:guildId returns only text channels, sorted by name', async () => {
  const { db } = makeDb('channels');
  const { giftcode, backfillMessages } = makeStubs();
  const g1 = makeGuild('g1', 'One', [
    { id: 'c3', name: 'zulu', type: 0 }, { id: 'c1', name: 'alpha', type: 0 }, { id: 'c2', name: 'voice', type: 2 }
  ]);
  const { call, close } = await mount({ client: makeClient({ guilds: [g1] }), db, giftcode, backfillMessages });
  try {
    assert.deepEqual((await call('GET', '/api/channels/g1')).body, [{ id: 'c1', name: 'alpha' }, { id: 'c3', name: 'zulu' }]);
    assert.equal((await call('GET', '/api/channels/g9')).status, 404);
  } finally { await close(); }
});

test('channels-config: only the injected keys are accepted, and a new registration channel posts the welcome once', async () => {
  const { db } = makeDb('chanconfig');
  const { calls, giftcode, backfillMessages } = makeStubs();
  const { call, close } = await mount({
    client: makeClient(), db, giftcode, backfillMessages,
    channelConfigKeys: ['giftcode', 'monitor', 'kingshotupdates'], registrationChannelKeys: ['giftcode', 'kingshotupdates']
  });
  try {
    const bad = await call('POST', '/api/channels-config/g1', { config_key: 'schedules', channel_id: 'c1' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'Invalid config key');

    assert.deepEqual((await call('POST', '/api/channels-config/g1', { config_key: 'monitor', channel_id: 'c9' })).body, { ok: true });
    assert.equal(calls.welcome.length, 0, 'monitor is not a registration channel');

    await call('POST', '/api/channels-config/g1', { config_key: 'giftcode', channel_id: 'c1' });
    await call('POST', '/api/channels-config/g1', { config_key: 'giftcode', channel_id: 'c1' });
    assert.deepEqual(calls.welcome, [{ guildId: 'g1', channelId: 'c1' }], 'same channel again is not a new registration channel');

    // The Channels tab clears a key by sending an empty string (channel_id
    // is NOT NULL in channel_config), and the welcome never fires for that.
    await call('POST', '/api/channels-config/g1', { config_key: 'giftcode', channel_id: '' });
    assert.equal(calls.welcome.length, 1, 'clearing never posts');

    const cfg = Object.fromEntries((await call('GET', '/api/channels-config/g1')).body.map(c => [c.config_key, c.channel_id]));
    assert.deepEqual(cfg, { monitor: 'c9', giftcode: '' });
  } finally { await close(); }
});

test('/api/announce-registration forwards guildId or null and reports the count', async () => {
  const { db } = makeDb('announce');
  const { calls, giftcode, backfillMessages } = makeStubs();
  const { call, close } = await mount({ client: makeClient(), db, giftcode, backfillMessages });
  try {
    assert.deepEqual((await call('POST', '/api/announce-registration', {})).body, { ok: true, posted: 3 });
    await call('POST', '/api/announce-registration', { guildId: 'g1' });
    assert.deepEqual(calls.reminder, [null, 'g1']);
  } finally { await close(); }
});

test('/api/player-changes returns the shared table, guild-scoped when asked', async () => {
  const { db } = makeDb('changes');
  const { giftcode, backfillMessages } = makeStubs();
  db.players.add('p1', 'tester');
  db.playerGuilds.link('g1', 'p1', 'tester');
  db.playerChanges.log('p1', 'nickname', 'Old', 'New');
  const { call, close } = await mount({ client: makeClient(), db, giftcode, backfillMessages });
  try {
    const all = (await call('GET', '/api/player-changes')).body;
    assert.equal(all.length, 1);
    assert.equal(all[0].new_value, 'New');
    assert.equal((await call('GET', '/api/player-changes?guildId=g1')).body.length, 1);
    assert.equal((await call('GET', '/api/player-changes?guildId=g2')).body.length, 0);
  } finally { await close(); }
});

// ─── redemptions ────────────────────────────────────────────────────────────

test('/api/redemptions list and detail pass the optional guildId straight to the bot-owned table', async () => {
  const { db, redemptionCalls } = makeDb('redlist');
  const { giftcode, backfillMessages } = makeStubs();
  const { call, close } = await mount({ client: makeClient(), db, giftcode, backfillMessages });
  try {
    assert.deepEqual((await call('GET', '/api/redemptions')).body, [{ code: 'ABC', total: 2 }]);
    await call('GET', '/api/redemptions?guildId=g1');
    assert.deepEqual(redemptionCalls.getAllCodes, [undefined, 'g1']);
    assert.equal((await call('GET', '/api/redemptions/ABC?guildId=g1')).body[0].player_id, 'p1');
    assert.deepEqual(redemptionCalls.getByCode, [{ code: 'ABC', guildId: 'g1' }]);
  } finally { await close(); }
});

test('/api/redeem: blocked, already_redeemed, and started globally or per server with the injected source labels', async () => {
  const { db } = makeDb('redeem');
  const { calls, giftcode, backfillMessages, setNeeding } = makeStubs();
  const { call, close } = await mount({
    client: makeClient(), db, giftcode, backfillMessages,
    redeemSources: { global: 'dashboard_global', perGuild: 'dashboard_per_server' }
  });
  try {
    assert.equal((await call('POST', '/api/redeem', { code: '  ' })).status, 400);

    db.blockedCodes.block('DEAD');
    assert.deepEqual((await call('POST', '/api/redeem', { code: 'DEAD' })).body, { ok: true, status: 'blocked' });

    setNeeding([], []);
    assert.deepEqual((await call('POST', '/api/redeem', { code: 'ABC' })).body, { ok: true, status: 'already_redeemed' });
    assert.deepEqual((await call('POST', '/api/redeem', { code: 'ABC', guildId: 'g1' })).body, { ok: true, status: 'already_redeemed' });
    assert.equal(calls.redeemCode.length + calls.redeemCodeForGuild.length, 0);

    setNeeding(['p1'], ['p1']);
    assert.deepEqual((await call('POST', '/api/redeem', { code: ' ABC ' })).body, { ok: true, status: 'started' });
    assert.deepEqual((await call('POST', '/api/redeem', { code: 'ABC', guildId: 'g1' })).body, { ok: true, status: 'started' });
    assert.deepEqual(calls.redeemCode, [{ code: 'ABC', opts: { source: 'dashboard_global' } }]);
    assert.deepEqual(calls.redeemCodeForGuild, [{ guildId: 'g1', code: 'ABC', opts: { source: 'dashboard_per_server' } }]);
  } finally { await close(); }
});

test('/api/redeem-progress returns whatever the bot reports', async () => {
  const { db } = makeDb('progress');
  const { giftcode, backfillMessages } = makeStubs();
  const { call, close } = await mount({ client: makeClient(), db, giftcode, backfillMessages });
  try {
    assert.deepEqual((await call('GET', '/api/redeem-progress')).body, { code: 'ABC', done: 2, total: 5 });
  } finally { await close(); }
});

test('DELETE /api/redemptions/:code wipes the history and blocks the code for good', async () => {
  const { db, redemptionCalls } = makeDb('delcode');
  const { giftcode, backfillMessages } = makeStubs();
  const { call, close } = await mount({ client: makeClient(), db, giftcode, backfillMessages });
  try {
    assert.deepEqual((await call('DELETE', '/api/redemptions/TYPO1')).body, { ok: true });
    assert.deepEqual(redemptionCalls.deleteByCode, ['TYPO1']);
    assert.equal(db.blockedCodes.isBlocked('TYPO1'), true);
  } finally { await close(); }
});

// ─── messages / channel errors ──────────────────────────────────────────────

test('/api/messages enriches rows with guild and channel names, falling back to ids', async () => {
  const { db } = makeDb('messages');
  const { giftcode, backfillMessages } = makeStubs();
  db.botMessages.log('g1', 'c1', 'm1', 'giftcode_summary', 'hello');
  db.botMessages.log('g9', 'c9', 'm2', 'giftcode_summary', 'orphan');
  const g1 = makeGuild('g1', 'One', [{ id: 'c1', name: 'codes', type: 0 }]);
  const { call, close } = await mount({ client: makeClient({ guilds: [g1] }), db, giftcode, backfillMessages });
  try {
    const rows = (await call('GET', '/api/messages')).body;
    const byId = Object.fromEntries(rows.map(r => [r.message_id, r]));
    assert.equal(byId.m1.guild_name, 'One');
    assert.equal(byId.m1.channel_name, 'codes');
    assert.equal(byId.m2.guild_name, 'g9');
    assert.equal(byId.m2.channel_name, 'c9');
    assert.equal((await call('GET', '/api/messages?guildId=g1')).body.length, 1);
  } finally { await close(); }
});

test('DELETE /api/messages/:id deletes from Discord too, tolerates an already-deleted message, and keeps the row on any other error', quiet(async () => {
  const { db } = makeDb('delmsg');
  const { giftcode, backfillMessages } = makeStubs();
  db.botMessages.log('g1', 'c1', 'm1', 'giftcode_summary', 'a');
  db.botMessages.log('g1', 'c1', 'm2', 'giftcode_summary', 'b');
  db.botMessages.log('g1', 'c1', 'm3', 'giftcode_summary', 'c');
  const rows = db.botMessages.getRecent(10);
  const idOf = (mid) => rows.find(r => r.message_id === mid).id;
  const deleted = [];
  const channelFetch = async () => ({
    messages: {
      fetch: async (mid) => {
        if (mid === 'm2') { const e = new Error('Unknown Message'); e.code = 10008; throw e; }
        if (mid === 'm3') { const e = new Error('Missing Access'); e.code = 50001; throw e; }
        return { delete: async () => { deleted.push(mid); } };
      }
    }
  });
  const { call, close } = await mount({ client: makeClient({ channelFetch }), db, giftcode, backfillMessages });
  try {
    assert.equal((await call('DELETE', '/api/messages/999999')).status, 404);
    assert.deepEqual((await call('DELETE', `/api/messages/${idOf('m1')}`)).body, { ok: true });
    assert.deepEqual(deleted, ['m1']);
    assert.deepEqual((await call('DELETE', `/api/messages/${idOf('m2')}`)).body, { ok: true });
    const other = await call('DELETE', `/api/messages/${idOf('m3')}`);
    assert.equal(other.status, 500);
    assert.equal(other.body.error, 'Missing Access');
    assert.deepEqual(db.botMessages.getRecent(10).map(r => r.message_id), ['m3']);
  } finally { await close(); }
}));

test('/api/messages/backfill forwards guildId or null and spreads the result', async () => {
  const { db } = makeDb('backfill');
  const { calls, giftcode, backfillMessages } = makeStubs();
  const { call, close } = await mount({ client: makeClient(), db, giftcode, backfillMessages });
  try {
    assert.deepEqual((await call('POST', '/api/messages/backfill')).body, { ok: true, imported: 4, scanned: 9 });
    await call('POST', '/api/messages/backfill', { guildId: 'g1' });
    assert.deepEqual(calls.backfill, [null, 'g1']);
  } finally { await close(); }
});

test('/api/channel-errors lists unresolved rows with names, guild-scoped when asked', async () => {
  const { db } = makeDb('chanerr');
  const { giftcode, backfillMessages } = makeStubs();
  db.channelErrors.log('g1', 'c1', 'giftcode_summary', 'Missing Access');
  db.channelErrors.log('g2', 'c2', 'reminder', 'Unknown Channel');
  const g1 = makeGuild('g1', 'One', [{ id: 'c1', name: 'codes', type: 0 }]);
  const { call, close } = await mount({ client: makeClient({ guilds: [g1] }), db, giftcode, backfillMessages });
  try {
    const rows = (await call('GET', '/api/channel-errors')).body;
    assert.equal(rows.length, 2);
    const one = rows.find(r => r.guild_id === 'g1');
    assert.equal(one.guild_name, 'One');
    assert.equal(one.channel_name, 'codes');
    assert.equal(one.error_message, 'Missing Access');
    assert.equal(rows.find(r => r.guild_id === 'g2').channel_name, 'c2');
    assert.equal((await call('GET', '/api/channel-errors?guildId=g1')).body.length, 1);
    db.channelErrors.clear('g1', 'c1');
    assert.equal((await call('GET', '/api/channel-errors')).body.length, 1);
  } finally { await close(); }
});

// ─── createDashboard bootstrap (the smoke checks both bots run) ─────────────

test('createDashboard boots, serves /health, gates /api/* with 401, redirects / to /login, and registers the bot\'s own routes', async () => {
  process.env.DISCORD_CLIENT_ID = 'test_client_id';
  process.env.DISCORD_CLIENT_SECRET = 'test_client_secret';
  process.env.SESSION_SECRET = 'test_session_secret';
  process.env.DASHBOARD_URL = 'http://localhost:0';
  process.env.OWNER_DISCORD_ID = 'owner123';
  process.env.PORT = '0';

  const viewsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-views-'));
  fs.writeFileSync(path.join(viewsDir, 'login.html'), '<h1>login</h1>');
  const { db } = makeDb('boot');
  const { giftcode, backfillMessages } = makeStubs();
  let hookArgs = null;
  const dashboard = createDashboard({
    db, viewsDir, sessionSecretFallback: 'x',
    channelConfigKeys: ['giftcode'], registrationChannelKeys: ['giftcode'],
    giftcode, backfillMessages,
    registerRoutes(app, ctx) {
      hookArgs = ctx;
      app.get('/api/bot-only', ctx.requireAuth, (req, res) => res.json({ bot: true }));
      app.get('/bot-public', (req, res) => res.json({ open: true }));
    }
  });

  // better-sqlite3-session-store starts an un-unref'd 15-minute cleanup
  // interval the moment the store is constructed -- correct in production,
  // but it would keep this test process alive forever (both bots run their
  // smoke test under --test-force-exit for exactly this reason). Unref any
  // interval created during start() so the file exits on its own.
  const restoreLog = console.log; console.log = () => {};
  const realSetInterval = global.setInterval;
  global.setInterval = (...args) => { const t = realSetInterval(...args); if (t.unref) t.unref(); return t; };
  let server;
  try {
    server = dashboard.start(makeClient());
  } finally { console.log = restoreLog; global.setInterval = realSetInterval; }
  assert.ok(server, 'start() returns the http server');
  if (!server.listening) await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal(typeof hookArgs.requireAuth, 'function');
    assert.ok(hookArgs.client);

    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, 'ok');

    assert.equal((await fetch(`${base}/api/guilds`)).status, 401);
    assert.equal((await fetch(`${base}/api/bot-only`)).status, 401, 'the hook gets the same requireAuth');
    assert.deepEqual(await (await fetch(`${base}/bot-public`)).json(), { open: true });

    const root = await fetch(`${base}/`, { redirect: 'manual' });
    assert.equal(root.status, 302);
    assert.match(root.headers.get('location'), /\/login/);

    const login = await fetch(`${base}/login`);
    assert.equal(login.status, 200);
    assert.equal(await login.text(), '<h1>login</h1>');
  } finally {
    await new Promise(r => server.close(r));
    fs.rmSync(viewsDir, { recursive: true, force: true });
  }
});
