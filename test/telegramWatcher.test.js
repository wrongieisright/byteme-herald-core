const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const { createTelegramWatcher, DEFAULT_TIMINGS } = require('../features/telegramWatcher');

// The watcher's network plumbing is exercised against an injected fake
// client (createClient) so every defense -- push handler, poll fallback,
// liveness probe, scheduled reconnect, stop() -- is covered without a real
// Telegram account. Both bots run this exact code; only channel, detector
// and handleCode differ, so a regression here is a regression on both.

const ENV_KEYS = ['TELEGRAM_API_ID', 'TELEGRAM_API_HASH', 'TELEGRAM_SESSION'];

function setCreds() {
  process.env.TELEGRAM_API_ID = '12345';
  process.env.TELEGRAM_API_HASH = 'abc';
  process.env.TELEGRAM_SESSION = 'session-string';
}

function clearCreds() {
  for (const k of ENV_KEYS) delete process.env[k];
}

// Simple detector standing in for createGiftCodeDetector: every
// whitespace-separated token that looks like CODE123.
function extractGiftCodes(text) {
  if (!text) return [];
  return (text.match(/\b[A-Z]{4}\d{3}\b/g) || []);
}

function makeFakeClient(opts = {}) {
  const calls = { connect: 0, disconnect: 0, getMe: 0, invoke: 0, getMessages: [] };
  let handler = null;
  const client = {
    connected: true,
    calls,
    filter: null,
    async connect() {
      calls.connect++;
      if (opts.connectFails) throw new Error('boom');
    },
    async disconnect() { calls.disconnect++; },
    async getEntity(name) {
      if (opts.entityFails) throw new Error('no such channel');
      return { id: 42, username: name };
    },
    async invoke() {
      calls.invoke++;
      if (opts.joinError) throw new Error(opts.joinError);
      return true;
    },
    async getMessages(channel, params) {
      calls.getMessages.push(params);
      return opts.getMessages ? opts.getMessages(params) : [];
    },
    addEventHandler(fn, filter) { handler = fn; client.filter = filter; },
    // Simulates a NewMessage push event from the channel.
    emit(message) { return handler({ message }); },
    async getMe() {
      calls.getMe++;
      if (opts.getMe) return opts.getMe();
      return { id: 1 };
    }
  };
  return client;
}

function makeWatcher(overrides = {}) {
  const handled = [];
  const client = makeFakeClient(overrides.client || {});
  const watcher = createTelegramWatcher({
    channelUsername: 'testrewards',
    extractGiftCodes,
    handleCode: overrides.handleCode || (async (discordClient, code, meta) => { handled.push({ code, meta, discordClient }); }),
    timings: overrides.timings,
    createClient: (args) => { client.constructedWith = args; return client; }
  });
  return { watcher, client, handled };
}

async function flush() {
  for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r));
}

const discordClient = { guilds: { cache: new Map() } };

// ─── construction ───────────────────────────────────────────────────────────

test('createTelegramWatcher refuses to construct without channel, detector or handler', () => {
  const ok = { channelUsername: 'x', extractGiftCodes: () => [], handleCode: async () => {} };
  assert.throws(() => createTelegramWatcher({ ...ok, channelUsername: '' }), /channelUsername/);
  assert.throws(() => createTelegramWatcher({ ...ok, extractGiftCodes: null }), /extractGiftCodes/);
  assert.throws(() => createTelegramWatcher({ ...ok, handleCode: 'nope' }), /handleCode/);
  assert.doesNotThrow(() => createTelegramWatcher(ok));
});

test('DEFAULT_TIMINGS are the intervals both bots shipped', () => {
  assert.deepEqual(DEFAULT_TIMINGS, {
    LIVENESS_CHECK_MS: 5 * 60 * 1000,
    LIVENESS_TIMEOUT_MS: 15 * 1000,
    HEARTBEAT_MS: 60 * 60 * 1000,
    FORCE_RECONNECT_EVERY_N_HEARTBEATS: 6,
    POLL_INTERVAL_MS: 15 * 60 * 1000
  });
});

// ─── start(): credentials and connection ────────────────────────────────────

test('start() returns null and never builds a client when credentials are missing or partial', async () => {
  clearCreds();
  let built = 0;
  const watcher = createTelegramWatcher({
    channelUsername: 'testrewards', extractGiftCodes, handleCode: async () => {},
    createClient: () => { built++; return makeFakeClient(); }
  });
  assert.equal(await watcher.start(discordClient), null);

  process.env.TELEGRAM_API_ID = '12345';
  process.env.TELEGRAM_API_HASH = 'abc';
  assert.equal(await watcher.start(discordClient), null);
  assert.equal(built, 0);
  clearCreds();
});

test('start() passes the parsed credentials and infinite-retry options to the client factory', async () => {
  setCreds();
  const { watcher, client } = makeWatcher();
  const handle = await watcher.start(discordClient);
  assert.ok(handle);
  assert.deepEqual(client.constructedWith, {
    sessionString: 'session-string', apiId: 12345, apiHash: 'abc',
    options: { connectionRetries: Infinity, autoReconnect: true }
  });
  assert.equal(typeof client.onError, 'function');
  await handle.stop();
  clearCreds();
});

test('start() returns null when connect() or channel resolution fails', async () => {
  setCreds();
  const a = makeWatcher({ client: { connectFails: true } });
  assert.equal(await a.watcher.start(discordClient), null);
  assert.equal(a.client.calls.invoke, 0);

  const b = makeWatcher({ client: { entityFails: true } });
  assert.equal(await b.watcher.start(discordClient), null);
  assert.equal(b.client.calls.invoke, 0);
  clearCreds();
});

test('start() joins the channel, tolerates "already a participant", and subscribes to that channel only', async () => {
  setCreds();
  const errors = [];
  const restore = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    const { watcher, client } = makeWatcher({ client: { joinError: 'USER_ALREADY_PARTICIPANT: already a participant' } });
    const handle = await watcher.start(discordClient);
    assert.ok(handle);
    assert.equal(client.calls.invoke, 1);
    assert.deepEqual(client.filter, { chats: ['testrewards'] });
    assert.equal(errors.filter(e => e.includes('Failed to join')).length, 0);
    await handle.stop();

    const other = makeWatcher({ client: { joinError: 'CHANNEL_PRIVATE' } });
    const h2 = await other.watcher.start(discordClient);
    assert.ok(h2, 'a join failure is logged but does not abort the watcher');
    assert.equal(errors.filter(e => e.includes('Failed to join')).length, 1);
    await h2.stop();
  } finally {
    console.error = restore;
    clearCreds();
  }
});

test('start() seeds the polling baseline from the newest message so the first poll skips history', async () => {
  setCreds();
  const { watcher, client } = makeWatcher({
    client: { getMessages: (params) => (params.limit === 1 ? [{ id: 900, message: 'old' }] : []) }
  });
  const handle = await watcher.start(discordClient);
  assert.equal(handle.getState().lastSeenMessageId, 900);
  assert.deepEqual(client.calls.getMessages[0], { limit: 1 });
  await handle.stop();
  clearCreds();
});

// ─── push handler ───────────────────────────────────────────────────────────

test('push handler dispatches every code in a message to handleCode with via: push, in order', async () => {
  setCreds();
  const { watcher, client, handled } = makeWatcher();
  const handle = await watcher.start(discordClient);

  client.emit({ id: 10, message: 'New codes: ABCD123 and EFGH456' });
  await flush();

  assert.deepEqual(handled.map(h => h.code), ['ABCD123', 'EFGH456']);
  assert.deepEqual(handled[0].meta, { via: 'push' });
  assert.equal(handled[0].discordClient, discordClient);
  assert.equal(handle.getState().lastSeenMessageId, 10);
  await handle.stop();
  clearCreds();
});

test('push handler advances lastSeenMessageId on code-less messages too, and never calls handleCode for them', async () => {
  setCreds();
  const { watcher, client, handled } = makeWatcher();
  const handle = await watcher.start(discordClient);

  client.emit({ id: 11, message: 'just chatting' });
  client.emit({ id: 5, message: 'an older id must not move the baseline backwards' });
  client.emit({});
  await flush();

  assert.equal(handled.length, 0);
  assert.equal(handle.getState().lastSeenMessageId, 11);
  await handle.stop();
  clearCreds();
});

test('a rejecting handleCode is logged, not thrown, and does not stop later codes', async () => {
  setCreds();
  const errors = [];
  const restore = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    const seen = [];
    const { watcher, client } = makeWatcher({
      handleCode: async (_c, code) => { seen.push(code); if (code === 'ABCD123') throw new Error('queue exploded'); }
    });
    const handle = await watcher.start(discordClient);
    client.emit({ id: 12, message: 'ABCD123\nEFGH456' });
    await flush();
    assert.deepEqual(seen, ['ABCD123', 'EFGH456']);
    assert.equal(errors.filter(e => e.includes('Error processing code ABCD123') && e.includes('queue exploded')).length, 1);
    await handle.stop();
  } finally {
    console.error = restore;
    clearCreds();
  }
});

// ─── poll fallback ──────────────────────────────────────────────────────────

test('pollForMissedMessages asks for messages after the baseline and processes them oldest-first via poll', async () => {
  setCreds();
  const warns = [];
  const restoreWarn = console.warn;
  console.warn = (...args) => warns.push(args.join(' '));
  try {
    const { watcher, client, handled } = makeWatcher({
      client: {
        getMessages: (params) => {
          if (params.limit === 1) return [{ id: 100, message: 'seed' }];
          // newest-first, the way getMessages actually returns
          return [{ id: 103, message: 'IJKL789' }, { id: 101, message: 'ABCD123' }, { id: 102, message: 'no code' }];
        }
      }
    });
    const handle = await watcher.start(discordClient);
    await handle.pollForMissedMessages();
    await flush();

    assert.deepEqual(client.calls.getMessages[1], { minId: 100, limit: 50 });
    assert.deepEqual(handled.map(h => h.code), ['ABCD123', 'IJKL789']);
    assert.deepEqual(handled[0].meta, { via: 'poll' });
    assert.equal(handle.getState().lastSeenMessageId, 103);
    assert.equal(warns.filter(w => w.includes('Poll fallback found 3 message(s)')).length, 1);
    await handle.stop();
  } finally {
    console.warn = restoreWarn;
    clearCreds();
  }
});

test('pollForMissedMessages is silent when push has kept up, and survives a failing getMessages', async () => {
  setCreds();
  const warns = [];
  const errors = [];
  const restoreWarn = console.warn;
  const restoreErr = console.error;
  console.warn = (...args) => warns.push(args.join(' '));
  console.error = (...args) => errors.push(args.join(' '));
  try {
    let fail = false;
    const { watcher, handled } = makeWatcher({
      client: { getMessages: () => { if (fail) throw new Error('FLOOD_WAIT'); return []; } }
    });
    const handle = await watcher.start(discordClient);
    await handle.pollForMissedMessages();
    assert.equal(handled.length, 0);
    assert.equal(warns.length, 0);

    fail = true;
    await handle.pollForMissedMessages();
    assert.equal(errors.filter(e => e.includes('Poll fallback failed') && e.includes('FLOOD_WAIT')).length, 1);
    await handle.stop();
  } finally {
    console.warn = restoreWarn;
    console.error = restoreErr;
    clearCreds();
  }
});

// ─── timers: liveness, heartbeat, poll interval, stop ───────────────────────

const FAST = { LIVENESS_CHECK_MS: 1000, LIVENESS_TIMEOUT_MS: 100, HEARTBEAT_MS: 10000, FORCE_RECONNECT_EVERY_N_HEARTBEATS: 3, POLL_INTERVAL_MS: 5000 };

test('liveness probe forces a reconnect when getMe() rejects, and again when it hangs past the timeout', async () => {
  setCreds();
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const restoreWarn = console.warn;
  console.warn = () => {};
  try {
    let mode = 'ok';
    const { watcher, client } = makeWatcher({
      timings: FAST,
      client: {
        getMe: () => {
          if (mode === 'reject') return Promise.reject(new Error('AUTH_KEY_UNREGISTERED'));
          if (mode === 'hang') return new Promise(() => {});
          return { id: 1 };
        }
      }
    });
    const handle = await watcher.start(discordClient);
    assert.equal(client.calls.connect, 1);

    mock.timers.tick(FAST.LIVENESS_CHECK_MS);
    await flush();
    assert.equal(client.calls.getMe, 1);
    assert.equal(client.calls.disconnect, 0, 'healthy probe does not reconnect');

    mode = 'reject';
    mock.timers.tick(FAST.LIVENESS_CHECK_MS);
    await flush();
    assert.equal(client.calls.disconnect, 1);
    assert.equal(client.calls.connect, 2);

    mode = 'hang';
    mock.timers.tick(FAST.LIVENESS_CHECK_MS);
    await flush();
    assert.equal(client.calls.disconnect, 1, 'not yet -- the probe is still hanging');
    mock.timers.tick(FAST.LIVENESS_TIMEOUT_MS);
    await flush();
    assert.equal(client.calls.disconnect, 2, 'a hang past the timeout counts as a failure');
    assert.equal(client.calls.connect, 3);

    await handle.stop();
  } finally {
    console.warn = restoreWarn;
    mock.timers.reset();
    clearCreds();
  }
});

test('heartbeat logs every interval and forces an unconditional reconnect every Nth beat', async () => {
  setCreds();
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const logs = [];
  const restoreLog = console.log;
  const restoreWarn = console.warn;
  console.log = (...args) => logs.push(args.join(' '));
  console.warn = (...args) => logs.push(args.join(' '));
  try {
    const { watcher, client } = makeWatcher({ timings: FAST });
    const handle = await watcher.start(discordClient);

    mock.timers.tick(FAST.HEARTBEAT_MS);
    await flush();
    mock.timers.tick(FAST.HEARTBEAT_MS);
    await flush();
    assert.equal(handle.getState().heartbeatCount, 2);
    assert.equal(logs.filter(l => l.startsWith('[Telegram] Heartbeat -- connected: true')).length, 2);
    assert.equal(client.calls.disconnect, 0);

    mock.timers.tick(FAST.HEARTBEAT_MS);
    await flush();
    assert.equal(handle.getState().heartbeatCount, 3);
    assert.equal(client.calls.disconnect, 1, 'third beat (N=3) cycles the connection');
    assert.equal(client.calls.connect, 2);
    assert.equal(logs.filter(l => l.includes('Scheduled periodic reconnect')).length, 1);
    assert.equal(logs.filter(l => l === '[Telegram] Reconnected.').length, 1);

    await handle.stop();
  } finally {
    console.log = restoreLog;
    console.warn = restoreWarn;
    mock.timers.reset();
    clearCreds();
  }
});

test('the poll interval runs the fallback on schedule, and stop() clears every timer and disconnects', async () => {
  setCreds();
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  try {
    const { watcher, client } = makeWatcher({ timings: FAST });
    const handle = await watcher.start(discordClient);
    assert.equal(client.calls.getMessages.length, 1, 'only the seed call so far');

    mock.timers.tick(FAST.POLL_INTERVAL_MS);
    await flush();
    assert.equal(client.calls.getMessages.length, 2);
    assert.deepEqual(client.calls.getMessages[1], { minId: 0, limit: 50 });

    await handle.stop();
    assert.equal(client.calls.disconnect, 1);
    const before = { ...client.calls, getMessages: client.calls.getMessages.length };
    mock.timers.tick(FAST.HEARTBEAT_MS * 10);
    await flush();
    assert.equal(client.calls.getMe, before.getMe);
    assert.equal(client.calls.getMessages.length, before.getMessages);
    assert.equal(handle.getState().heartbeatCount, 0);
  } finally {
    mock.timers.reset();
    clearCreds();
  }
});
