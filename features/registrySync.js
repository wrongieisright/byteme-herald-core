// The player-registry sync both bots run against the shared registry app
// (wrongieisright/wos-registry -- one Supabase-backed registry holding both
// games' players, each row tagged with a `game` discriminator since its
// migration 013). Two factories, both pure of game logic:
//
//   createRegistrySync      the outbound push: POST { game, players } to the
//                           registry's /api/bot-sync with an x-bot-secret
//                           header, on every new player add and for every
//                           player the monitor finds a change for. The bot
//                           injects which game it is, which env vars hold
//                           the URL/secret, how to shape a player into the
//                           registry's field names (buildPayload), and its
//                           HTTP client (axios -- injected rather than
//                           depended on here, so each bot's axios mock in
//                           tests covers this code too).
//   createRegistryBackfill  the reverse direction: a read-only pull from the
//                           registry's `players` table (Supabase REST, the
//                           app's own public anon key + public-SELECT RLS)
//                           to fill fields the bot has NULL for -- nickname
//                           and level -- now that neither game's player
//                           lookup API exists any more. Never overwrites a
//                           value the bot already has: the registry is where
//                           a human types names in, the bot is where they
//                           were once scraped, and nobody knows which side
//                           is more current for anything the dead APIs used
//                           to be the sole source of truth for.
//
// History worth knowing (ByteMe's, but it applies to both): the sync used
// to be gated behind a successful scrape ("it'll sync later when a scrape
// works"). Once WOS's /player lookup died for good that gate quietly became
// "never sync a new player", with zero visible symptom for weeks -- a
// skipped sync doesn't error, it just never runs. So neither bot gates on
// scrape success any more: a brand-new player syncs immediately with the
// ID and state/kingdom the user supplied and the player ID standing in as
// primary_name (the registry's NOT NULL column), and a human replaces the
// placeholder in the registry later.

function requireFn(name, value, where) {
  if (typeof value !== 'function') throw new Error(`${where}: ${name} is required`);
}

function createRegistrySync({ game = null, urlEnvVar, secretEnvVar, buildPayload, http, logTag = '[Registry]', batchSize = 500 } = {}) {
  if (!urlEnvVar || !secretEnvVar) throw new Error('createRegistrySync: urlEnvVar and secretEnvVar are required');
  requireFn('buildPayload', buildPayload, 'createRegistrySync');
  if (!http || typeof http.post !== 'function') throw new Error('createRegistrySync: http (an axios-like client with post()) is required');

  function getSyncUrl() {
    const base = process.env[urlEnvVar];
    return base ? `${base.replace(/\/$/, '')}/api/bot-sync` : null;
  }

  // Returns null (and logs why) when the sync is unconfigured -- optional by
  // design, a bot without a registry just skips it.
  function config() {
    const url = getSyncUrl();
    const secret = process.env[secretEnvVar];
    if (!url || !secret) {
      console.log(`${logTag} ${urlEnvVar}/${secretEnvVar} not set, skipping registry sync.`);
      return null;
    }
    return { url, secret };
  }

  async function postBatch(url, secret, players) {
    // The batch-level game is what the registry keys on; it is deliberately
    // not repeated per player (the endpoint strips a per-player game field).
    const body = game ? { game, players } : { players };
    try {
      const resp = await http.post(url, body, {
        headers: { 'Content-Type': 'application/json', 'x-bot-secret': secret },
        timeout: 15000
      });
      const { created = 0, updated = 0, unchanged = 0, errors = [] } = resp.data || {};
      console.log(`${logTag} Synced ${players.length} player(s) -- created ${created}, updated ${updated}, unchanged ${unchanged}${errors.length ? `, ${errors.length} error(s)` : ''}.`);
      if (errors.length > 0) {
        console.error(`${logTag} Sync reported errors:`, JSON.stringify(errors));
      }
    } catch (err) {
      console.error(`${logTag} Sync request failed for ${players.length} player(s):`, err.response?.data || err.message);
    }
  }

  async function syncPlayer(player_id, scraped) {
    const cfg = config();
    if (!cfg) return;
    await postBatch(cfg.url, cfg.secret, [buildPayload(player_id, scraped)]);
  }

  // Batched sibling for the player monitor, which can find several players
  // changed in one run -- one request for all of them instead of one HTTP
  // round trip per player. players is an array of scraped-shaped objects,
  // each with player_id plus whatever buildPayload reads off it. Chunked to
  // the registry's per-request cap.
  async function syncPlayers(players) {
    if (players.length === 0) return;
    const cfg = config();
    if (!cfg) return;
    for (let i = 0; i < players.length; i += batchSize) {
      const batch = players.slice(i, i + batchSize).map(p => buildPayload(p.player_id, p));
      await postBatch(cfg.url, cfg.secret, batch);
    }
  }

  return { syncPlayer, syncPlayers, buildPayload, getSyncUrl };
}

function createRegistryBackfill({ game = null, http, supabaseUrl, supabaseKey, getGaps, fieldMap, applyUpdate, chunkSize = 150 } = {}) {
  if (!http || typeof http.get !== 'function') throw new Error('createRegistryBackfill: http (an axios-like client with get()) is required');
  if (!supabaseUrl || !supabaseKey) throw new Error('createRegistryBackfill: supabaseUrl and supabaseKey are required');
  requireFn('getGaps', getGaps, 'createRegistryBackfill');
  requireFn('applyUpdate', applyUpdate, 'createRegistryBackfill');
  if (!fieldMap || Object.keys(fieldMap).length === 0) throw new Error('createRegistryBackfill: fieldMap ({ localField: registryField }) is required');

  const localFields = Object.keys(fieldMap);
  const registryFields = [...new Set(Object.values(fieldMap))];

  function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }

  // PostgREST URL length gets unwieldy well before this many numeric IDs in
  // one `in.(...)` filter -- chunk to stay comfortably under typical proxy/
  // server URL length limits. Scoped to this bot's game so a WOS ID that
  // happens to equal a Kingshot ID can't feed the wrong bot.
  async function fetchRegistryDataForIds(playerIds) {
    const found = new Map(); // player_id -> registry row
    for (const batch of chunk(playerIds, chunkSize)) {
      const url = `${supabaseUrl}/rest/v1/players?select=player_id,${registryFields.join(',')}&player_id=in.(${batch.join(',')})${game ? `&game=eq.${game}` : ''}`;
      const resp = await http.get(url, {
        headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` }
      });
      for (const row of resp.data) {
        if (row.player_id) found.set(row.player_id, row);
      }
    }
    return found;
  }

  // Only fills a field that's currently NULL locally -- never overwrites one
  // that already has a value (see the header comment).
  async function backfill() {
    const gaps = getGaps();
    if (gaps.length === 0) {
      return { gaps: 0, backfilled: 0, stillMissing: 0, updates: [] };
    }

    const registryData = await fetchRegistryDataForIds(gaps.map(p => p.player_id));

    const updates = [];
    let stillMissing = 0;

    for (const p of gaps) {
      const match = registryData.get(p.player_id);
      if (!match) { stillMissing++; continue; }

      const fields = {};
      for (const local of localFields) {
        const remote = match[fieldMap[local]];
        if (p[local] == null && remote != null && remote !== '') fields[local] = remote;
      }

      if (Object.keys(fields).length === 0) { stillMissing++; continue; }

      applyUpdate(p.player_id, fields);
      updates.push({ player_id: p.player_id, ...fields });
    }

    return { gaps: gaps.length, backfilled: updates.length, stillMissing, updates };
  }

  return { backfill, fetchRegistryDataForIds };
}

module.exports = { createRegistrySync, createRegistryBackfill };
