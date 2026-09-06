const crypto = require('crypto');

// ─── Shared helpers ──────────────────────────────────────────────────────────

// FAST_TEST_MODE (set by the test helpers) collapses every deliberate pacing
// delay -- DELAY_MS, RETRY_DELAY_MS, RATE_LIMIT_BACKOFF_MS, BATCH_GAP_MS --
// to effectively zero. Those delays are tuned against each game's real rate
// limiter and stay untouched in production; this only exists so the
// redemption-heavy tests don't have to burn real wall-clock time waiting on
// pauses that only matter against a real API.
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, process.env.FAST_TEST_MODE ? 0 : ms));
}

// `time` is Unix SECONDS, not milliseconds -- confirmed against a real
// captured browser payload (~July 2026): a working request sent a 10-digit
// value (e.g. 1784771907), not Date.now()'s 13-digit milliseconds figure.
// Using milliseconds made `time` roughly 1000x larger than the API's own
// clock, which a server-side freshness/anti-replay check would reasonably
// reject -- found on ByteMe as the actual root cause behind a bogus
// "time Expired" result on a code independently confirmed still live.
function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

// Sign is computed by: sorting all param keys, building a query string,
// appending the secret key, then md5-hashing the result -- the same scheme
// on both Century Games gift-code APIs. Matches the sites' own JS:
// md5(sortedQueryString + SECRET_KEY)
function makeSign(params, secretKey) {
  const sorted = Object.keys(params).sort().reduce((acc, key) => {
    return (acc ? acc + '&' : '') + key + '=' + (
      typeof params[key] === 'object'
        ? JSON.stringify(params[key])
        : encodeURIComponent(params[key])
    );
  }, '');
  return crypto.createHash('md5').update(sorted + secretKey).digest('hex');
}

const REQUIRED_DELAYS = ['DELAY_MS', 'RETRY_DELAY_MS', 'RATE_LIMIT_BACKOFF_MS', 'BATCH_GAP_MS'];

// ─── The engine ──────────────────────────────────────────────────────────────
// Everything about *how* a roster gets redeemed that isn't specific to one
// game: the per-player attempt loop with its two flavors of backoff, the
// fully serialized queue, batch iteration with progress reporting, lazy
// player resolution, and the per-player code sweep. What differs per game is
// injected, and nothing here has a default that could quietly change a bot's
// tuning -- every delay is required:
//
//   redeemOnce({ player_id, code, kid, attempt, maxAttempts })
//       Performs ONE HTTP redemption call and returns the API's response
//       body. Owns the game's endpoint, headers, signing, and its own
//       per-attempt logging. Throws on a network-level failure (an axios
//       error with .response is understood for HTTP 429 detection).
//   classifyResponse(data) -> { success, result } | null
//       The game's result-code vocabulary. Return null for anything
//       unrecognized -- the engine then checks looksLikeRateLimit and finally
//       falls back to the API's own message text as the result.
//   looksLikeRateLimit(errCode, msg) -> boolean
//       Which responses (and which thrown error messages) mean "slow down"
//       rather than "this failed" -- retried with RATE_LIMIT_BACKOFF_MS.
//   maxAttempts
//       Attempts per player per code inside redeemForPlayer.
//   delays: { DELAY_MS, RETRY_DELAY_MS, RATE_LIMIT_BACKOFF_MS, BATCH_GAP_MS }
//       DELAY_MS between players in a batch (and between a single player's
//       codes); RETRY_DELAY_MS after a plain transient failure;
//       RATE_LIMIT_BACKOFF_MS after a rate-limit response; BATCH_GAP_MS
//       before the queue advances to its next item.
//   retryRateLimitedAtEnd (default false)
//       After a batch, give every player who exhausted their attempts on
//       rate limiting one more full redeemForPlayer call -- by then the rest
//       of the batch has put real wall-clock time between their last attempt
//       and this one. ByteMe turned this on after a real incident (2 of 63
//       players stuck on rate_limited, fixed by a manual re-run ~40 minutes
//       later).
//   stopOnExpired (default false)
//       Stop a batch at the first 'expired' result -- for a game whose API
//       returns that for "this code doesn't exist," which is true for every
//       remaining player too. Herald turns this on; ByteMe doesn't, because
//       WOS reuses code strings for later promotions.
//   logPrefix (default '[Scraper]')
//       Prefix for the engine's own (rare) log lines.
function createRedemptionEngine({
  redeemOnce,
  classifyResponse,
  looksLikeRateLimit,
  maxAttempts = 3,
  delays,
  retryRateLimitedAtEnd = false,
  stopOnExpired = false,
  logPrefix = '[Scraper]'
}) {
  if (typeof redeemOnce !== 'function') throw new Error('createRedemptionEngine: redeemOnce is required');
  if (typeof classifyResponse !== 'function') throw new Error('createRedemptionEngine: classifyResponse is required');
  if (typeof looksLikeRateLimit !== 'function') throw new Error('createRedemptionEngine: looksLikeRateLimit is required');
  for (const key of REQUIRED_DELAYS) {
    if (!delays || typeof delays[key] !== 'number') throw new Error(`createRedemptionEngine: delays.${key} is required`);
  }
  const { DELAY_MS, RETRY_DELAY_MS, RATE_LIMIT_BACKOFF_MS, BATCH_GAP_MS } = delays;

  // Redeem one code for one player. The loop only exists for transient
  // network blips and the API's own rate limiting -- captcha guessing, the
  // original reason for a retry loop here, is gone from both games.
  async function redeemForPlayer(player_id, code, kid) {
    let lastResult = 'unknown_error';

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const data = await redeemOnce({ player_id, code, kid, attempt, maxAttempts });

        const classified = classifyResponse(data);
        if (classified) return classified;

        if (looksLikeRateLimit(data?.err_code, data?.msg)) {
          // The API's own rate limit -- retrying immediately would just trip
          // it again, so back off longer than a normal retry. No point
          // sleeping after the last attempt: nothing will use the pause since
          // the loop is about to exit, and that was previously up to 8s
          // wasted on every player who exhausted every attempt.
          lastResult = 'rate_limited';
          if (attempt < maxAttempts) await sleep(RATE_LIMIT_BACKOFF_MS);
          continue;
        }

        return { success: false, result: data?.msg || `err_${data?.err_code}` };
      } catch (err) {
        // Network-level failure (the submission itself, or a timeout). An
        // HTTP 429 or a rate-limit-flavored message gets the same longer
        // backoff as the JSON-level case above; anything else still retries
        // at the normal pace rather than giving up on the whole redemption
        // over one blip.
        const rateLimited = err?.response?.status === 429 || looksLikeRateLimit(null, err?.message);
        lastResult = rateLimited ? 'rate_limited' : `exception: ${err?.message}`;
        if (attempt < maxAttempts) await sleep(rateLimited ? RATE_LIMIT_BACKOFF_MS : RETRY_DELAY_MS);
        continue;
      }
    }

    return { success: false, result: `${lastResult} (${maxAttempts} attempts)` };
  }

  // Serializes redemption batches so a manually-triggered /redeem and an
  // auto-detected code (or two of either) never run concurrently -- without
  // this, overlapping batches interleave against the same players, wasting
  // redemption attempts and risking confusing duplicate messages.
  let redemptionQueue = Promise.resolve();

  // BATCH_GAP_MS is a deliberate pause before the queue advances to whatever's
  // next, on top of the DELAY_MS already used between individual players
  // within one batch. Several different codes queued back-to-back (e.g.
  // redeeming a handful of active codes from a dashboard one after another)
  // previously ran with zero gap between batches -- 40+ players' worth of
  // requests inside a couple minutes was enough on its own to trip WOS's
  // rate limiter, independent of any bug in the serialization itself. This
  // only delays the queue's next item, not the current call's own result.
  function queueRedemption(fn) {
    const result = redemptionQueue.then(fn, fn);
    redemptionQueue = result.then(() => sleep(BATCH_GAP_MS), () => sleep(BATCH_GAP_MS));
    return result;
  }

  async function redeemBatch(players, code, progressCallback) {
    const results = [];
    for (const player of players) {
      // player.state is that player's stored kingdom (kid) -- both games'
      // APIs route /gift_code by kingdom now.
      const result = await redeemForPlayer(player.player_id, code, player.state);
      results.push({ ...player, ...result });
      if (progressCallback) await progressCallback(results, players.length);

      if (stopOnExpired && result.result === 'expired') {
        console.log(`${logPrefix} Code ${code} confirmed expired -- stopping early (${players.length - results.length} player(s) not attempted).`);
        break;
      }

      await sleep(DELAY_MS);
    }

    if (retryRateLimitedAtEnd) {
      // A player who exhausted every attempt inside redeemForPlayer against
      // the rate limiter gets one more shot here, after the rest of the batch
      // has actually run. By now real wall-clock time (every other player's
      // own request + DELAY_MS, on top of each rate-limited player's own
      // internal backoff) has passed, which is often enough for the limiter
      // to clear on its own -- the same recovery a human re-running the code
      // later gets, made automatic.
      const stillRateLimited = results
        .map((r, i) => i)
        .filter(i => results[i].result?.startsWith('rate_limited'));

      if (stillRateLimited.length > 0) {
        await sleep(RATE_LIMIT_BACKOFF_MS);
        for (const i of stillRateLimited) {
          const player = results[i];
          const retryResult = await redeemForPlayer(player.player_id, code, player.state);
          results[i] = { ...player, ...retryResult };
          if (progressCallback) await progressCallback(results, players.length);
          await sleep(DELAY_MS);
        }
      }
    }

    return results;
  }

  async function redeemForAll(players, code, progressCallback) {
    return queueRedemption(() => redeemBatch(players, code, progressCallback));
  }

  // Same as redeemForAll, but the player list is computed lazily -- only once
  // this call's turn in the queue actually arrives, not when it's first
  // called. Without this, two calls for the same code queued close together
  // (e.g. two quick redeem clicks before either has logged a result) both
  // compute the same "who still needs this" list up front and both redeem
  // the same players a second time -- a real incident on ByteMe: one code
  // redeemed twice for the same 11 players, and the back-to-back batches
  // tripped the rate limiter. resolvePlayers() re-runs right before the
  // batch starts, so the second call sees whatever the first one already
  // finished -- but only if the caller's onDone (typically persisting
  // results) also runs *inside* this same queued turn via the onDone hook,
  // before the next queued call's resolvePlayers() gets a chance to run.
  // Returning results and awaiting a separate write *after* this call
  // resolves is too late: the queue already advances the moment this
  // callback returns. Returns null instead of running at all if nothing's
  // left to do by then.
  async function redeemForAllLazy(resolvePlayers, code, { progressCallback, onDone } = {}) {
    return queueRedemption(async () => {
      const players = resolvePlayers();
      if (players.length === 0) return null;
      const results = await redeemBatch(players, code, progressCallback);
      if (onDone) await onDone(results);
      return results;
    });
  }

  // Mirror of redeemBatch/redeemForAll but iterating codes for a single
  // player instead of players for a single code -- used to catch a
  // newly-added player up on every code already redeemed for the rest of
  // the roster. Shares the same queue (and its BATCH_GAP_MS pause) so it
  // can't interleave with, or immediately follow, a batch redeem or the
  // auto-watcher. Each code still costs a full round trip -- there's no
  // cheap way to pre-check a code known to be expired without submitting it.
  async function redeemCodesForPlayer(player_id, codes, kid, progressCallback) {
    return queueRedemption(async () => {
      const results = [];
      for (const code of codes) {
        const result = await redeemForPlayer(player_id, code, kid);
        results.push({ code, ...result });
        if (progressCallback) await progressCallback(results, codes.length);
        // invalid_player_info means this fid/kid pairing itself is wrong --
        // every remaining code would fail the exact same way, so stop
        // wasting requests on them instead of looping through the rest.
        if (result.result === 'invalid_player_info') break;
        await sleep(DELAY_MS);
      }
      return results;
    });
  }

  return {
    redeemForPlayer,
    redeemBatch,
    queueRedemption,
    redeemForAll,
    redeemForAllLazy,
    redeemCodesForPlayer,
    sleep,
    delays: { DELAY_MS, RETRY_DELAY_MS, RATE_LIMIT_BACKOFF_MS, BATCH_GAP_MS },
    maxAttempts
  };
}

module.exports = { createRedemptionEngine, sleep, nowSeconds, makeSign };
