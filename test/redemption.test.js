const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRedemptionEngine, sleep, nowSeconds, makeSign } = require('../features/redemption');

process.env.FAST_TEST_MODE = '1';

const OK = { code: 0, msg: 'SUCCESS', err_code: 20000 };
const RATE_LIMITED = { code: 1, msg: 'CAPTCHA CHECK TOO FREQUENT.', err_code: 40101 };
const EXPIRED = { code: 1, msg: 'EXPIRED', err_code: 40007 };

// A WOS-flavored classifier, the shape ByteMe injects.
function classify(data) {
  if (data?.code === 0 && data?.err_code === 20000) return { success: true, result: 'redeemed' };
  if (data?.err_code === 40008) return { success: false, result: 'already_redeemed' };
  if (data?.err_code === 40007) return { success: false, result: 'expired' };
  if (data?.err_code === 40011) return { success: false, result: 'same_type_exchange' };
  if (data?.err_code === 40020) return { success: false, result: 'invalid_player_info' };
  return null;
}

function looksLikeRateLimit(errCode, msg) {
  if (errCode === 40101 || errCode === 40004) return true;
  return /too frequent|timeout retry/i.test(msg || '');
}

const DELAYS = { DELAY_MS: 3500, RETRY_DELAY_MS: 2500, RATE_LIMIT_BACKOFF_MS: 8000, BATCH_GAP_MS: 10000 };

// Builds an engine whose redeemOnce is scripted: behavior(player_id, code, nthCallForThisPlayer)
// returns response data or throws. Records every call.
function makeEngine(behavior, options = {}) {
  const calls = [];
  const perPlayer = {};
  const engine = createRedemptionEngine({
    redeemOnce: async ({ player_id, code, kid, attempt }) => {
      perPlayer[player_id] = (perPlayer[player_id] || 0) + 1;
      calls.push({ player_id, code, kid, attempt });
      return behavior(player_id, code, perPlayer[player_id]);
    },
    classifyResponse: classify,
    looksLikeRateLimit,
    delays: DELAYS,
    ...options
  });
  return { engine, calls, perPlayer };
}

// ─── helpers ────────────────────────────────────────────────────────────────

test('sleep resolves immediately under FAST_TEST_MODE', async () => {
  const start = Date.now();
  await sleep(5000);
  assert.ok(Date.now() - start < 500);
});

test('nowSeconds is Unix seconds, not milliseconds', () => {
  const s = nowSeconds();
  assert.ok(Math.abs(s - Math.floor(Date.now() / 1000)) < 2);
  assert.ok(String(s).length === 10);
});

test('makeSign: md5 over sorted query string + secret, objects JSON-encoded, values URL-encoded', () => {
  const sign = makeSign({ fid: '123', time: 1700000000, cdk: 'A B' }, 'secret');
  const crypto = require('crypto');
  const expected = crypto.createHash('md5').update('cdk=A%20B&fid=123&time=1700000000secret').digest('hex');
  assert.equal(sign, expected);
  assert.notEqual(sign, makeSign({ fid: '123', time: 1700000000, cdk: 'A B' }, 'other'));
});

test('createRedemptionEngine refuses to run without every delay and hook (no silent defaults for tuning)', () => {
  const base = { redeemOnce: async () => OK, classifyResponse: classify, looksLikeRateLimit };
  assert.throws(() => createRedemptionEngine({ ...base }), /delays\.DELAY_MS/);
  assert.throws(() => createRedemptionEngine({ ...base, delays: { ...DELAYS, BATCH_GAP_MS: undefined } }), /BATCH_GAP_MS/);
  assert.throws(() => createRedemptionEngine({ classifyResponse: classify, looksLikeRateLimit, delays: DELAYS }), /redeemOnce/);
  assert.doesNotThrow(() => createRedemptionEngine({ ...base, delays: DELAYS }));
});

// ─── redeemForPlayer ────────────────────────────────────────────────────────

test('redeemForPlayer: clean success returns redeemed with exactly one call, passing kid and attempt through', async () => {
  const { engine, calls } = makeEngine(() => OK);
  const result = await engine.redeemForPlayer('P1', 'CODE1', '929');
  assert.deepEqual(result, { success: true, result: 'redeemed' });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { player_id: 'P1', code: 'CODE1', kid: '929', attempt: 1 });
});

test('redeemForPlayer: every classified result is terminal -- no retry', async () => {
  for (const [data, expected] of [
    [{ code: 1, msg: 'ALREADY REDEEMED', err_code: 40008 }, 'already_redeemed'],
    [EXPIRED, 'expired'],
    [{ code: 1, msg: 'SAME TYPE EXCHANGE.', err_code: 40011 }, 'same_type_exchange'],
    [{ code: 1, msg: 'USER INFO ERROR.', err_code: 40020 }, 'invalid_player_info']
  ]) {
    const { engine, calls } = makeEngine(() => data);
    const result = await engine.redeemForPlayer('P1', 'CODE1');
    assert.equal(result.result, expected);
    assert.equal(result.success, false);
    assert.equal(calls.length, 1);
  }
});

test('redeemForPlayer: an unrecognized error is terminal and surfaces the API message (or err_ code)', async () => {
  const { engine, calls } = makeEngine(() => ({ code: 1, msg: 'SOME WEIRD ERROR', err_code: 12345 }));
  assert.equal((await engine.redeemForPlayer('P1', 'C')).result, 'SOME WEIRD ERROR');
  assert.equal(calls.length, 1);

  const noMsg = makeEngine(() => ({ code: 1, err_code: 777 }));
  assert.equal((await noMsg.engine.redeemForPlayer('P1', 'C')).result, 'err_777');
});

test('redeemForPlayer: a rate-limit response retries and can eventually succeed', async () => {
  const { engine, calls } = makeEngine((p, c, n) => (n < 3 ? RATE_LIMITED : OK));
  const result = await engine.redeemForPlayer('P1', 'CODE1');
  assert.equal(result.success, true);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(c => c.attempt), [1, 2, 3]);
});

test('redeemForPlayer: rate limit on every attempt exhausts maxAttempts and reports rate_limited (N attempts)', async () => {
  const { engine, calls } = makeEngine(() => RATE_LIMITED);
  const result = await engine.redeemForPlayer('P1', 'CODE1');
  assert.equal(result.success, false);
  assert.equal(result.result, 'rate_limited (3 attempts)');
  assert.equal(calls.length, 3);
});

test('redeemForPlayer: the injected looksLikeRateLimit decides what counts (err_code 40004 here) and message text falls through', async () => {
  const { engine, calls } = makeEngine((p, c, n) => (n === 1 ? { code: 1, msg: 'TIMEOUT RETRY.', err_code: 40004 } : OK));
  assert.equal((await engine.redeemForPlayer('P1', 'C')).result, 'redeemed');
  assert.equal(calls.length, 2);

  const byText = makeEngine((p, c, n) => (n === 1 ? { code: 1, msg: 'request too frequent', err_code: 55555 } : OK));
  assert.equal((await byText.engine.redeemForPlayer('P1', 'C')).result, 'redeemed');
  assert.equal(byText.calls.length, 2);
});

test('redeemForPlayer: a thrown network error retries and can succeed; exhausting attempts reports the exception', async () => {
  const { engine, calls } = makeEngine((p, c, n) => { if (n < 2) throw new Error('timeout of 15000ms exceeded'); return OK; });
  assert.equal((await engine.redeemForPlayer('P1', 'C')).success, true);
  assert.equal(calls.length, 2);

  const always = makeEngine(() => { throw new Error('ECONNRESET'); });
  const result = await always.engine.redeemForPlayer('P1', 'C');
  assert.equal(result.result, 'exception: ECONNRESET (3 attempts)');
  assert.equal(always.calls.length, 3);
});

test('redeemForPlayer: an HTTP 429 or a rate-limit-worded exception is treated as rate-limited', async () => {
  const http429 = makeEngine(() => { const e = new Error('Request failed with status code 429'); e.response = { status: 429 }; throw e; });
  assert.equal((await http429.engine.redeemForPlayer('P1', 'C')).result, 'rate_limited (3 attempts)');

  const worded = makeEngine(() => { throw new Error('too frequent'); });
  assert.equal((await worded.engine.redeemForPlayer('P1', 'C')).result, 'rate_limited (3 attempts)');
});

test('redeemForPlayer: maxAttempts is honored', async () => {
  const { engine, calls } = makeEngine(() => RATE_LIMITED, { maxAttempts: 5 });
  assert.equal((await engine.redeemForPlayer('P1', 'C')).result, 'rate_limited (5 attempts)');
  assert.equal(calls.length, 5);
});

// ─── redeemBatch / redeemForAll ─────────────────────────────────────────────

test('redeemForAll: redeems every player, sourcing kid from each player\'s stored state, merging player fields into results', async () => {
  const { engine, calls } = makeEngine(() => OK);
  const players = [{ player_id: 'A', nickname: 'Alice', state: '77' }, { player_id: 'B', nickname: 'Bob', state: '88' }];
  const results = await engine.redeemForAll(players, 'KIDCODE');
  assert.deepEqual(calls.map(c => c.kid), ['77', '88']);
  assert.deepEqual(results.map(r => [r.player_id, r.nickname, r.result]), [['A', 'Alice', 'redeemed'], ['B', 'Bob', 'redeemed']]);
});

test('redeemForAll: progressCallback fires after every player with the running results and the total', async () => {
  const { engine } = makeEngine(() => OK);
  const seen = [];
  await engine.redeemForAll([{ player_id: 'A' }, { player_id: 'B' }, { player_id: 'C' }], 'C', async (results, total) => seen.push([results.length, total]));
  assert.deepEqual(seen, [[1, 3], [2, 3], [3, 3]]);
});

test('redeemForAll (retryRateLimitedAtEnd off, the default): a rate-limited player stays rate_limited after its own attempts', async () => {
  const { engine, perPlayer } = makeEngine((p) => (p === 'RL' ? RATE_LIMITED : OK));
  const results = await engine.redeemForAll([{ player_id: 'RL' }, { player_id: 'OK' }], 'C');
  assert.equal(perPlayer.RL, 3);
  assert.match(results[0].result, /^rate_limited/);
});

test('redeemForAll (retryRateLimitedAtEnd on): a player rate-limited on every attempt gets one more shot at the end of the batch', async () => {
  // ByteMe's real incident: 2 of 63 players stuck on 'rate_limited (3
  // attempts)', fixed by a manual re-run ~40 minutes later.
  const { engine, perPlayer } = makeEngine((p, c, n) => (p === 'RL1' && n <= 3 ? RATE_LIMITED : OK), { retryRateLimitedAtEnd: true });
  const results = await engine.redeemForAll([{ player_id: 'RL1', state: '929' }, { player_id: 'OK1', state: '929' }], 'C');
  assert.equal(perPlayer.RL1, 4);
  assert.equal(results.find(r => r.player_id === 'RL1').result, 'redeemed');
  assert.equal(results.find(r => r.player_id === 'OK1').result, 'redeemed');
});

test('redeemForAll (retryRateLimitedAtEnd on): still rate-limited after the extra pass reports rate_limited, and the pass reports progress', async () => {
  const { engine, perPlayer } = makeEngine(() => RATE_LIMITED, { retryRateLimitedAtEnd: true });
  const seen = [];
  const results = await engine.redeemForAll([{ player_id: 'RL2' }], 'C', async (r, total) => seen.push(total));
  assert.equal(perPlayer.RL2, 6); // 3 in-batch + 3 in the extra pass
  assert.match(results[0].result, /^rate_limited/);
  assert.equal(seen.length, 2);
});

test('redeemForAll (retryRateLimitedAtEnd on): no extra pass when nobody was rate-limited', async () => {
  const { engine, perPlayer } = makeEngine(() => OK, { retryRateLimitedAtEnd: true });
  await engine.redeemForAll([{ player_id: 'F1' }, { player_id: 'F2' }], 'C');
  assert.equal(perPlayer.F1, 1);
  assert.equal(perPlayer.F2, 1);
});

test('redeemForAll (stopOnExpired off, the default): an expired result does not stop the batch', async () => {
  const { engine, calls } = makeEngine(() => EXPIRED);
  const results = await engine.redeemForAll([{ player_id: 'A' }, { player_id: 'B' }], 'DEAD');
  assert.equal(results.length, 2);
  assert.equal(calls.length, 2);
});

test('redeemForAll (stopOnExpired on): stops at the first expired result, leaving the rest unattempted', async () => {
  const { engine, calls } = makeEngine(() => EXPIRED, { stopOnExpired: true });
  const results = await engine.redeemForAll([{ player_id: 'A' }, { player_id: 'B' }, { player_id: 'C' }], 'DEAD');
  assert.equal(results.length, 1);
  assert.equal(results[0].result, 'expired');
  assert.equal(calls.length, 1);
});

// ─── redeemForAllLazy ───────────────────────────────────────────────────────

test('redeemForAllLazy: resolves players when its turn arrives and runs onDone inside the same queued turn', async () => {
  const { engine } = makeEngine(() => OK);
  const order = [];
  const results = await engine.redeemForAllLazy(
    () => { order.push('resolve'); return [{ player_id: 'X1' }]; },
    'LAZY',
    { onDone: async (r) => { order.push('onDone:' + r.length); } }
  );
  assert.equal(results[0].result, 'redeemed');
  assert.deepEqual(order, ['resolve', 'onDone:1']);
});

test('redeemForAllLazy: returns null without calling redeemOnce when resolvePlayers finds nothing', async () => {
  const { engine, calls } = makeEngine(() => OK);
  assert.equal(await engine.redeemForAllLazy(() => [], 'EMPTY'), null);
  assert.equal(calls.length, 0);
});

test('redeemForAllLazy: a second call for the same code sees what the first one persisted (the double-redeem race)', async () => {
  const { engine, calls } = makeEngine(() => OK);
  const done = new Set();
  const pending = () => ['A', 'B'].filter(id => !done.has(id)).map(player_id => ({ player_id }));
  const opts = { onDone: async (r) => r.forEach(x => done.add(x.player_id)) };

  const [first, second] = await Promise.all([
    engine.redeemForAllLazy(pending, 'SAME', opts),
    engine.redeemForAllLazy(pending, 'SAME', opts)
  ]);
  assert.equal(first.length, 2);
  assert.equal(second, null);
  assert.equal(calls.length, 2);
});

// ─── redeemCodesForPlayer ───────────────────────────────────────────────────

test('redeemCodesForPlayer: one result per code, same kid on every call', async () => {
  const { engine, calls } = makeEngine(() => OK);
  const results = await engine.redeemCodesForPlayer('P1', ['CODEA', 'CODEB'], '900');
  assert.deepEqual(results.map(r => r.code), ['CODEA', 'CODEB']);
  assert.ok(results.every(r => r.result === 'redeemed'));
  assert.deepEqual(calls.map(c => c.kid), ['900', '900']);
});

test('redeemCodesForPlayer: stops at the first invalid_player_info, skipping the remaining codes', async () => {
  const { engine, calls } = makeEngine(() => ({ code: 1, msg: 'USER INFO ERROR.', err_code: 40020 }));
  const results = await engine.redeemCodesForPlayer('P1', ['A', 'B', 'C']);
  assert.equal(results.length, 1);
  assert.equal(results[0].result, 'invalid_player_info');
  assert.equal(calls.length, 1);
});

// ─── queue ──────────────────────────────────────────────────────────────────

test('queueRedemption: overlapping batches run strictly one after another, never interleaved', async () => {
  const order = [];
  const { engine } = makeEngine((p) => { order.push(p); return OK; });
  const [r1, r2] = await Promise.all([
    engine.redeemForAll([{ player_id: 'A1' }, { player_id: 'A2' }], 'ONE'),
    engine.redeemForAll([{ player_id: 'B1' }, { player_id: 'B2' }], 'TWO')
  ]);
  assert.deepEqual(order, ['A1', 'A2', 'B1', 'B2']);
  assert.ok(r1.every(r => r.result === 'redeemed') && r2.every(r => r.result === 'redeemed'));
});

test('queueRedemption: a failing item does not wedge the queue for the next one', async () => {
  const { engine } = makeEngine(() => OK);
  await assert.rejects(engine.queueRedemption(async () => { throw new Error('boom'); }));
  const results = await engine.redeemForAll([{ player_id: 'AFTER' }], 'C');
  assert.equal(results[0].result, 'redeemed');
});

test('two engines have independent queues', async () => {
  const order = [];
  const a = makeEngine((p) => { order.push('a:' + p); return OK; }).engine;
  const b = makeEngine((p) => { order.push('b:' + p); return OK; }).engine;
  await Promise.all([a.redeemForAll([{ player_id: '1' }], 'C'), b.redeemForAll([{ player_id: '1' }], 'C')]);
  assert.equal(order.length, 2);
});

test('the engine exposes its configured delays and maxAttempts read-only style for the bot\'s own loops', () => {
  const { engine } = makeEngine(() => OK);
  assert.deepEqual(engine.delays, DELAYS);
  assert.equal(engine.maxAttempts, 3);
  assert.equal(typeof engine.sleep, 'function');
});
