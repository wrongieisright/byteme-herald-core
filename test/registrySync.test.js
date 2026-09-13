const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const { createRegistrySync, createRegistryBackfill } = require('../features/registrySync');

// Both factories take an injected axios-like client, so every test here runs
// against a fake `http` that records calls -- no network, no env leakage
// (env vars are set per test and cleared in finally).

const URL_VAR = 'TEST_REGISTRY_URL';
const SECRET_VAR = 'TEST_REGISTRY_BOT_SECRET';

function setEnv(url = 'https://registry.example', secret = 'shh') {
  process.env[URL_VAR] = url;
  process.env[SECRET_VAR] = secret;
}
function clearEnv() {
  delete process.env[URL_VAR];
  delete process.env[SECRET_VAR];
}

function fakeHttp({ postResponse = { data: { created: 1, updated: 0, unchanged: 0, errors: [] } }, postError = null, getRows = () => [] } = {}) {
  const posts = [];
  const gets = [];
  return {
    posts,
    gets,
    async post(url, body, opts) {
      posts.push({ url, body, opts });
      if (postError) throw postError;
      return typeof postResponse === 'function' ? postResponse(body) : postResponse;
    },
    async get(url, opts) {
      gets.push({ url, opts });
      return { data: getRows(url) };
    }
  };
}

// A ByteMe-shaped payload builder: the registry's column names, the player
// ID standing in for a missing nickname.
function buildPayload(player_id, scraped = {}) {
  const payload = { player_id, primary_name: scraped.nickname || player_id };
  if (scraped.level != null) payload.furnace_level = scraped.level;
  if (scraped.state) payload.state = parseInt(scraped.state, 10);
  return payload;
}

function makeSync(http, extra = {}) {
  return createRegistrySync({ game: 'wos', urlEnvVar: URL_VAR, secretEnvVar: SECRET_VAR, buildPayload, http, logTag: '[TestRegistry]', ...extra });
}

// ─── createRegistrySync ─────────────────────────────────────────────────────

test('createRegistrySync refuses to construct without its required options', () => {
  const http = fakeHttp();
  assert.throws(() => createRegistrySync({ secretEnvVar: SECRET_VAR, buildPayload, http }), /urlEnvVar and secretEnvVar/);
  assert.throws(() => createRegistrySync({ urlEnvVar: URL_VAR, secretEnvVar: SECRET_VAR, http }), /buildPayload is required/);
  assert.throws(() => createRegistrySync({ urlEnvVar: URL_VAR, secretEnvVar: SECRET_VAR, buildPayload }), /http/);
});

test('syncPlayer posts one player to <url>/api/bot-sync with the batch-level game, the secret header and a 15s timeout', async () => {
  setEnv('https://registry.example/');
  const http = fakeHttp();
  const log = mock.method(console, 'log', () => {});
  try {
    const sync = makeSync(http);
    assert.equal(sync.getSyncUrl(), 'https://registry.example/api/bot-sync', 'trailing slash on the base is tolerated');
    await sync.syncPlayer('123456', { nickname: 'Frost', level: 30, state: '1233' });
    assert.equal(http.posts.length, 1);
    const { url, body, opts } = http.posts[0];
    assert.equal(url, 'https://registry.example/api/bot-sync');
    assert.deepEqual(body, { game: 'wos', players: [{ player_id: '123456', primary_name: 'Frost', furnace_level: 30, state: 1233 }] });
    assert.deepEqual(opts.headers, { 'Content-Type': 'application/json', 'x-bot-secret': 'shh' });
    assert.equal(opts.timeout, 15000);
    assert.ok(log.mock.calls.some(c => /\[TestRegistry\] Synced 1 player\(s\) -- created 1, updated 0, unchanged 0\.$/.test(c.arguments[0])));
  } finally {
    log.mock.restore();
    clearEnv();
  }
});

test('with no game configured the body carries only players (the pre-multi-game shape the registry still accepts)', async () => {
  setEnv();
  const http = fakeHttp();
  const log = mock.method(console, 'log', () => {});
  try {
    const sync = makeSync(http, { game: null });
    await sync.syncPlayer('1', {});
    assert.deepEqual(http.posts[0].body, { players: [{ player_id: '1', primary_name: '1' }] });
  } finally {
    log.mock.restore();
    clearEnv();
  }
});

test('an unconfigured sync logs once that it is skipping and never touches http', async () => {
  clearEnv();
  const http = fakeHttp();
  const log = mock.method(console, 'log', () => {});
  try {
    const sync = makeSync(http);
    assert.equal(sync.getSyncUrl(), null);
    await sync.syncPlayer('1', { nickname: 'x' });
    await sync.syncPlayers([{ player_id: '1' }, { player_id: '2' }]);
    assert.equal(http.posts.length, 0);
    assert.equal(log.mock.calls.length, 2);
    assert.equal(log.mock.calls[0].arguments[0], `[TestRegistry] ${URL_VAR}/${SECRET_VAR} not set, skipping registry sync.`);
  } finally {
    log.mock.restore();
  }
});

test('syncPlayers maps every player through buildPayload and chunks to batchSize per request; an empty list is a no-op', async () => {
  setEnv();
  const http = fakeHttp({ postResponse: (body) => ({ data: { created: 0, updated: body.players.length, unchanged: 0 } }) });
  const log = mock.method(console, 'log', () => {});
  try {
    const sync = makeSync(http, { batchSize: 2 });
    await sync.syncPlayers([]);
    assert.equal(http.posts.length, 0, 'nothing to sync -> no request, no config log');
    assert.equal(log.mock.calls.length, 0);

    const players = [
      { player_id: '1', nickname: 'A', level: 10 },
      { player_id: '2', nickname: 'B' },
      { player_id: '3' }
    ];
    await sync.syncPlayers(players);
    assert.equal(http.posts.length, 2);
    assert.deepEqual(http.posts[0].body.players, [
      { player_id: '1', primary_name: 'A', furnace_level: 10 },
      { player_id: '2', primary_name: 'B' }
    ]);
    assert.deepEqual(http.posts[1].body.players, [{ player_id: '3', primary_name: '3' }]);
    assert.equal(http.posts[1].body.game, 'wos');
  } finally {
    log.mock.restore();
    clearEnv();
  }
});

test('a failed post is logged (with the response body when there is one) and never thrown; per-player errors in a 200 are logged too', async () => {
  setEnv();
  const log = mock.method(console, 'log', () => {});
  const error = mock.method(console, 'error', () => {});
  try {
    const failing = fakeHttp({ postError: Object.assign(new Error('Request failed with status code 401'), { response: { data: { error: 'bad secret' } } }) });
    await makeSync(failing).syncPlayer('1', {});
    assert.equal(error.mock.calls.length, 1);
    assert.equal(error.mock.calls[0].arguments[0], '[TestRegistry] Sync request failed for 1 player(s):');
    assert.deepEqual(error.mock.calls[0].arguments[1], { error: 'bad secret' });

    const partial = fakeHttp({ postResponse: { data: { created: 1, updated: 0, unchanged: 0, errors: [{ player_id: '2', error: 'nope' }] } } });
    await makeSync(partial).syncPlayers([{ player_id: '1' }, { player_id: '2' }]);
    assert.ok(log.mock.calls.some(c => /Synced 2 player\(s\) -- created 1, updated 0, unchanged 0, 1 error\(s\)\.$/.test(c.arguments[0])));
    assert.equal(error.mock.calls[1].arguments[0], '[TestRegistry] Sync reported errors:');
    assert.equal(error.mock.calls[1].arguments[1], JSON.stringify([{ player_id: '2', error: 'nope' }]));
  } finally {
    log.mock.restore();
    error.mock.restore();
    clearEnv();
  }
});

// ─── createRegistryBackfill ─────────────────────────────────────────────────

const SUPABASE_URL = 'https://proj.supabase.co';
const SUPABASE_KEY = 'sb_publishable_test';

function makeBackfill({ rows = [], getGaps, applyUpdate, ...extra } = {}) {
  const http = fakeHttp({ getRows: () => rows });
  const updates = [];
  const backfill = createRegistryBackfill({
    game: 'wos',
    http,
    supabaseUrl: SUPABASE_URL,
    supabaseKey: SUPABASE_KEY,
    getGaps: getGaps || (() => []),
    fieldMap: { nickname: 'primary_name', fc_level: 'furnace_level' },
    applyUpdate: applyUpdate || ((player_id, fields) => updates.push({ player_id, fields })),
    ...extra
  });
  return { backfill, http, updates };
}

test('createRegistryBackfill refuses to construct without its required options', () => {
  const http = fakeHttp();
  const base = { http, supabaseUrl: SUPABASE_URL, supabaseKey: SUPABASE_KEY, getGaps: () => [], fieldMap: { nickname: 'primary_name' }, applyUpdate: () => {} };
  assert.throws(() => createRegistryBackfill({ ...base, http: undefined }), /http/);
  assert.throws(() => createRegistryBackfill({ ...base, supabaseKey: undefined }), /supabaseUrl and supabaseKey/);
  assert.throws(() => createRegistryBackfill({ ...base, getGaps: undefined }), /getGaps is required/);
  assert.throws(() => createRegistryBackfill({ ...base, applyUpdate: undefined }), /applyUpdate is required/);
  assert.throws(() => createRegistryBackfill({ ...base, fieldMap: {} }), /fieldMap/);
});

test('backfill with no gaps returns zeros without querying the registry', async () => {
  const { backfill, http } = makeBackfill();
  assert.deepEqual(await backfill.backfill(), { gaps: 0, backfilled: 0, stillMissing: 0, updates: [] });
  assert.equal(http.gets.length, 0);
});

test('fetchRegistryDataForIds selects only the mapped registry fields, filters by game, and chunks the in.(...) list', async () => {
  const { backfill, http } = makeBackfill({ chunkSize: 2, rows: [{ player_id: '1', primary_name: 'One', furnace_level: 5 }] });
  const found = await backfill.fetchRegistryDataForIds(['1', '2', '3']);
  assert.equal(http.gets.length, 2);
  assert.equal(http.gets[0].url, `${SUPABASE_URL}/rest/v1/players?select=player_id,primary_name,furnace_level&player_id=in.(1,2)&game=eq.wos`);
  assert.equal(http.gets[1].url, `${SUPABASE_URL}/rest/v1/players?select=player_id,primary_name,furnace_level&player_id=in.(3)&game=eq.wos`);
  assert.deepEqual(http.gets[0].opts.headers, { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` });
  assert.equal(found.get('1').primary_name, 'One');
});

test('backfill fills only fields that are NULL locally, never overwrites a known value, and counts gaps it could not fill', async () => {
  const gaps = [
    { player_id: '1', nickname: null, fc_level: null },   // both fillable
    { player_id: '2', nickname: 'Kept', fc_level: null }, // registry has a different name -> must not overwrite
    { player_id: '3', nickname: null, fc_level: null },   // registry row exists but has nothing useful
    { player_id: '4', nickname: null, fc_level: 7 }       // not in the registry at all
  ];
  const rows = [
    { player_id: '1', primary_name: 'One', furnace_level: 30 },
    { player_id: '2', primary_name: 'Other', furnace_level: 12 },
    { player_id: '3', primary_name: '', furnace_level: null }
  ];
  const { backfill, updates } = makeBackfill({ rows, getGaps: () => gaps });
  const result = await backfill.backfill();
  assert.deepEqual(updates, [
    { player_id: '1', fields: { nickname: 'One', fc_level: 30 } },
    { player_id: '2', fields: { fc_level: 12 } }
  ]);
  assert.deepEqual(result, {
    gaps: 4,
    backfilled: 2,
    stillMissing: 2,
    updates: [
      { player_id: '1', nickname: 'One', fc_level: 30 },
      { player_id: '2', fc_level: 12 }
    ]
  });
});

test('a backfill with no game omits the game filter (single-game registries)', async () => {
  const { backfill, http } = makeBackfill({ game: null });
  await backfill.fetchRegistryDataForIds(['9']);
  assert.equal(http.gets[0].url, `${SUPABASE_URL}/rest/v1/players?select=player_id,primary_name,furnace_level&player_id=in.(9)`);
});
