// Watches a public Telegram channel for gift codes via a full user-account
// MTProto session (not the Bot API -- reading an arbitrary public channel
// you don't administer requires a real user session), using teleproto
// rather than the original gramjs ('telegram' on npm): gramjs is archived
// upstream, and critically, teleproto actually implements the update-resync
// mechanism (UpdateManager.catchUp(), backed by a real updates.getState()
// call tracking pts/qts/date/seq) that gramjs left as an unimplemented stub.
// That stub is the likely root cause behind two real incidents on ByteMe
// where the update stream silently stopped delivering channel posts.
//
// History worth knowing before touching this: both incidents left ZERO trace
// in the logs -- no error, no reconnect attempt. Telegram's server stops
// delivering channel updates if the client doesn't send a "content-related
// request" at least hourly, even while the connection and plain RPC calls
// (getMe()) stay fully healthy. The four defenses below all predate the
// teleproto migration and stay in place as defense in depth:
//   1. A getMe() liveness probe every 5 min, forcing reconnect on
//      failure/timeout.
//   2. An UNCONDITIONAL reconnect every ~6 hours regardless of apparent
//      health.
//   3. An hourly heartbeat log (connected: bool, Xh since last channel
//      event) so a future incident leaves actual data instead of silence.
//   4. A polling fallback: getMessages() every 15 min, independent of the
//      push event stream. Under normal operation the poll finds nothing --
//      it only ever turns something up when push has genuinely missed
//      messages. "[Telegram] Poll fallback found N message(s)..." in the
//      logs is the confirmation push actually failed, as opposed to the
//      channel just being quiet.
//
// Both bots run the identical watcher; what differs is injected:
//   channelUsername   the public channel to watch, without the @
//   extractGiftCodes  the bot's detector (see createGiftCodeDetector)
//   handleCode        (discordClient, code, { via }) => Promise -- what to
//                     do with each detected code; via is 'push' or 'poll'.
//                     The bot decides the redeem options (ByteMe passes
//                     retryExpired: true, Herald retryDeferred: true --
//                     a fresh Telegram post is the signal a deferred code
//                     may be live again).
//   timings           optional overrides of the intervals above, mainly
//                     for tests; the defaults are what both bots ran.
//   createClient      optional factory replacing teleproto's TelegramClient,
//                     for tests. Signature: ({ sessionString, apiId, apiHash,
//                     options }) => client. teleproto is required lazily
//                     inside start(), only when credentials are present.

const DEFAULT_TIMINGS = {
  LIVENESS_CHECK_MS: 5 * 60 * 1000,
  LIVENESS_TIMEOUT_MS: 15 * 1000,
  HEARTBEAT_MS: 60 * 60 * 1000,
  FORCE_RECONNECT_EVERY_N_HEARTBEATS: 6,
  POLL_INTERVAL_MS: 15 * 60 * 1000
};

function createTelegramWatcher({ channelUsername, extractGiftCodes, handleCode, timings = {}, createClient } = {}) {
  if (!channelUsername) throw new Error('createTelegramWatcher: channelUsername is required');
  if (typeof extractGiftCodes !== 'function') throw new Error('createTelegramWatcher: extractGiftCodes is required');
  if (typeof handleCode !== 'function') throw new Error('createTelegramWatcher: handleCode is required');
  const T = { ...DEFAULT_TIMINGS, ...timings };

  // Reads credentials produced ahead of time by the bot's telegram-login.js.
  // TELEGRAM_API_ID and TELEGRAM_API_HASH come from https://my.telegram.org;
  // TELEGRAM_SESSION is the saved session string from that one-time login,
  // so this reconnects silently on every restart with no interactive step.
  // Returns a handle with stop() (clears every timer and disconnects) or
  // null when the watcher didn't start.
  async function start(discordClient) {
    const apiId = parseInt(process.env.TELEGRAM_API_ID, 10);
    const apiHash = process.env.TELEGRAM_API_HASH;
    const sessionString = process.env.TELEGRAM_SESSION;

    if (!apiId || !apiHash || !sessionString) {
      console.log('[Telegram] TELEGRAM_API_ID/TELEGRAM_API_HASH/TELEGRAM_SESSION not fully set, skipping Telegram watcher.');
      return null;
    }

    let Api, NewMessage;
    let client;
    if (createClient) {
      client = createClient({ sessionString, apiId, apiHash, options: { connectionRetries: Infinity, autoReconnect: true } });
      ({ Api, NewMessage } = client.__teleproto || { Api: null, NewMessage: null });
    } else {
      const teleproto = require('teleproto');
      const { StringSession } = require('teleproto/sessions');
      ({ NewMessage } = require('teleproto/events'));
      Api = teleproto.Api;
      // connectionRetries defaults to 10 retries in the library's own
      // config, and it gives up reconnecting for good once retries are
      // exhausted (no further logging, no recovery) -- Infinity keeps
      // retrying through hosting network blips instead of silently going
      // deaf for the rest of the process lifetime.
      client = new teleproto.TelegramClient(new StringSession(sessionString), apiId, apiHash, {
        connectionRetries: Infinity,
        autoReconnect: true
      });
    }

    // The library's own default logger already prints internal errors (ping
    // failures, sender issues) at its default log level, but routing them
    // through our own onError too guarantees they're tagged and visible in
    // the hosting log capture rather than depending on the library's own
    // formatting -- two real incidents left zero trace of what actually went
    // wrong internally, so anything the library itself knows is worth
    // surfacing.
    client.onError = async (err) => {
      console.error('[Telegram] Internal client error:', err?.message || err);
    };

    try {
      await client.connect();
    } catch (err) {
      console.error('[Telegram] Failed to connect:', err.message);
      return null;
    }

    const channel = await client.getEntity(channelUsername).catch(err => {
      console.error(`[Telegram] Failed to resolve @${channelUsername}:`, err.message);
      return null;
    });
    if (!channel) return null;

    try {
      await client.invoke(Api ? new Api.channels.JoinChannel({ channel }) : { channel, _: 'channels.JoinChannel' });
    } catch (err) {
      // Already being a member is expected on every restart after the first.
      if (!/already.*participant/i.test(err.message || '')) {
        console.error('[Telegram] Failed to join channel:', err.message);
      }
    }

    console.log(`[Telegram] Watching @${channelUsername} for gift codes...`);

    // Updated on every event this handler receives, gift code or not -- the
    // only way (see the heartbeat below) to tell "the channel's just been
    // quiet" apart from "the watcher's gone deaf", since a stalled update
    // stream has twice now left zero trace in the logs.
    let lastEventAt = Date.now();

    // Baseline for the polling fallback below -- seeded to "whatever's
    // current right now" so the first poll only looks at messages posted
    // after this watcher started, not the channel's entire history (10k+
    // subscribers, could be thousands of old messages). Also advanced by the
    // push handler on every event it sees, so under normal operation (push
    // working fine) the poll finds nothing -- it only ever turns something up
    // when push has actually missed messages, which is the whole point.
    let lastSeenMessageId = 0;
    try {
      const latest = await client.getMessages(channel, { limit: 1 });
      if (latest.length > 0) lastSeenMessageId = latest[0].id;
    } catch (err) {
      console.error('[Telegram] Failed to seed polling baseline:', err.message);
    }

    function dispatch(codes, via) {
      for (const code of codes) {
        console.log(via === 'poll'
          ? `[Telegram] Detected gift code via poll fallback: ${code}`
          : `[Telegram] Detected gift code: ${code}`);
        // Each handleCode call is expected to queue through the bot's
        // serialized redemption queue, so multiple codes in one message just
        // run one after another rather than interleaving.
        Promise.resolve(handleCode(discordClient, code, { via })).catch(err => {
          console.error(`[Telegram] Error processing code ${code}:`, err?.message || err);
        });
      }
    }

    client.addEventHandler((event) => {
      lastEventAt = Date.now();
      if (event.message && event.message.id > lastSeenMessageId) lastSeenMessageId = event.message.id;
      const codes = extractGiftCodes(event.message && event.message.message);
      if (codes.length === 0) return;
      dispatch(codes, 'push');
    }, NewMessage ? new NewMessage({ chats: [channelUsername] }) : { chats: [channelUsername] });

    async function forceReconnect(reason) {
      console.warn(`[Telegram] ${reason} -- forcing reconnect...`);
      try {
        await client.disconnect();
      } catch {}
      try {
        await client.connect();
        lastEventAt = Date.now();
        console.log('[Telegram] Reconnected.');
      } catch (err) {
        console.error('[Telegram] Reconnect attempt failed:', err.message);
      }
    }

    // Safety net beyond the library's own autoReconnect. client.connected only
    // reflects whether the underlying TCP socket is open -- confirmed by a
    // real incident where two gift codes posted to the channel were never
    // detected, with no reconnect log and no error at all, while the rest of
    // the process kept running and logging normally the whole time. A stalled
    // MTProto update stream can leave .connected reporting true forever even
    // though no updates are actually arriving, so polling that flag alone
    // never catches this. A real authenticated API call is a much stronger
    // liveness signal: if the connection is actually dead, this either throws
    // or hangs, and a timeout treats a hang the same as a throw.
    const livenessTimer = setInterval(async () => {
      try {
        await Promise.race([
          client.getMe(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), T.LIVENESS_TIMEOUT_MS))
        ]);
      } catch (err) {
        await forceReconnect(`Liveness check failed (${err.message})`);
      }
    }, T.LIVENESS_CHECK_MS);

    // A second real incident happened with the liveness check above already
    // deployed and passing (getMe() kept succeeding) -- the library's own
    // source explains why that's not sufficient on its own: Telegram's server
    // stops delivering updates if the client doesn't send a "content-related
    // request" at least hourly, EVEN WHILE the connection and RPC calls stay
    // fully healthy. Cycling the connection on an unconditional schedule (not
    // dependent on detecting a problem first) resets that internal state
    // directly, sidestepping whatever the exact trigger is. Heartbeat logs
    // every cycle too, so a third incident (if it happens) actually leaves
    // data in the logs instead of the total silence both previous ones did.
    let heartbeatCount = 0;
    const heartbeatTimer = setInterval(async () => {
      heartbeatCount++;
      const idleHours = ((Date.now() - lastEventAt) / 3600000).toFixed(1);
      console.log(`[Telegram] Heartbeat -- connected: ${client.connected}, ${idleHours}h since last channel event.`);

      if (heartbeatCount % T.FORCE_RECONNECT_EVERY_N_HEARTBEATS === 0) {
        await forceReconnect('Scheduled periodic reconnect');
      }
    }, T.HEARTBEAT_MS);

    // ─── Polling fallback ───────────────────────────────────────────────────
    // A direct getMessages() RPC call isn't affected by whatever's actually
    // wrong with the library's update dispatch -- it's not reliant on the
    // update stream at all, so it catches a miss no matter the underlying
    // reason, known or not. This is a reliability backstop, not the primary
    // path: normal detection is still near-instant via the push handler
    // above, and since lastSeenMessageId is advanced by that handler on every
    // event it sees, a poll finds nothing at all when push is working
    // normally -- it only ever turns something up when push has genuinely
    // missed messages.
    async function pollForMissedMessages() {
      try {
        const messages = await client.getMessages(channel, { minId: lastSeenMessageId, limit: 50 });
        if (messages.length === 0) return;

        console.warn(`[Telegram] Poll fallback found ${messages.length} message(s) the push handler apparently missed.`);

        // getMessages returns newest-first -- process oldest-first so codes
        // redeem in the order they were actually posted.
        const ordered = [...messages].sort((a, b) => a.id - b.id);
        for (const message of ordered) {
          lastEventAt = Date.now();
          if (message.id > lastSeenMessageId) lastSeenMessageId = message.id;
          dispatch(extractGiftCodes(message.message), 'poll');
        }
      } catch (err) {
        console.error('[Telegram] Poll fallback failed:', err.message);
      }
    }

    const pollTimer = setInterval(pollForMissedMessages, T.POLL_INTERVAL_MS);

    return {
      client,
      pollForMissedMessages,
      getState: () => ({ lastEventAt, lastSeenMessageId, heartbeatCount }),
      async stop() {
        clearInterval(livenessTimer);
        clearInterval(heartbeatTimer);
        clearInterval(pollTimer);
        try { await client.disconnect(); } catch {}
      }
    };
  }

  return { start };
}

module.exports = { createTelegramWatcher, DEFAULT_TIMINGS };
