// echoChamberGuard.js — kills the SWARM "reflexive hallucination echo-chamber" (Cluster J; from a reflexivity essay on
// self-reinforcing map scars). The failure it prevents: one bot logs a PHANTOM obstacle → relays it → the swarm routes
// around the phantom → because nobody ever crosses the phantom cell, it is NEVER disproven → it hardens into a permanent
// "map scar" that degrades the whole swarm's world model forever. The root cause is that a RELAYED belief looks as
// trustworthy as a DIRECTLY-OBSERVED one, and an unchallenged belief has no way to die.
//
// FIX (two independent locks, both required):
//   1. INDEPENDENT CONFIRMATION — a shared/relayed belief is only TRUSTED once it has been independently observed by
//      >= k DISTINCT bots. A bot cannot confirm its own phantom, and an echo of that bot (a relay carrying the same
//      source id) does not count as a second witness. Only genuinely separate sensors corroborate.
//   2. DECAY / EXPIRY — an UNCONFIRMED belief is not permanent. Its confidence decays with a half-life since it was last
//      observed, and prune() expires it once it is both unconfirmed AND stale. A confirmed belief persists; any
//      re-observation refreshes it. So a phantom nobody re-sees simply evaporates instead of scarring the map.
//
// The caller (kinship/mesh) feeds observations here and consults confirmed()/confidence() before acting on a belief.
// Deterministic, dependency-free: no Math.random, no Date.now — `now` is always supplied by the caller.

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
// Half-life recency in [0,1]: 1.0 at the moment of observation, halving every `halfLife` time units since lastSeen.
const recency = (dt, halfLife) => (halfLife <= 0 ? (dt <= 0 ? 1 : 0) : Math.pow(2, -Math.max(0, dt) / halfLife));

export function makeEchoChamberGuard(opts = {}) {
  const {
    k = 2,               // distinct independent sources required to CONFIRM a shared belief
    ttl = 100,           // an unconfirmed belief goes stale after this long without re-observation
    halfLife = 40,       // confidence half-life (time units) since lastSeen — mirrors world.js belief decay
    confFloor = 0,       // optional floor on the recency term so a belief never fully vanishes (0 = allowed to reach ~0)
    saturateAt = null,   // source count at which the corroboration term saturates to 1 (defaults to k)
  } = opts;
  const sat = saturateAt == null ? k : saturateAt;

  // beliefId -> { sources:Set<sourceId>, weights:Map<sourceId,weight>, firstSeen, lastSeen }
  const store = new Map();

  const get = (id) => store.get(id) || null;

  // TRUST-WEIGHTED QUORUM (closes the source-label Sybil hole): the naive ">= k DISTINCT sources" test counts unauthenticated
  // label strings, so ONE body can mint k fake source ids and mint a false confirmation. Each observation now carries an
  // optional per-source `weight` in [0,∞) (default 1.0) — the caller passes the source's trust weight (e.g. verified/known
  // = 1.0, an unknown/fromBeacon source = 0.25). A belief is confirmed once the SUM of its distinct sources' weights clears
  // k. k phantom low-trust sources (0.25 each) stay below the bar unless a genuinely trusted `known`+ witness co-signs. With
  // every weight left at the 1.0 default the weighted sum equals the distinct-source count, so all existing callers/tests are
  // byte-identical. A repeated observation of the same source takes the MAX weight seen (a spoofed low-trust echo can't
  // downgrade a real witness, and a real witness can't be inflated by re-reporting — distinctness still gates).
  const observe = (beliefId, sourceId, { now = 0, weight = 1 } = {}) => {
    let b = store.get(beliefId);
    if (!b) {
      b = { sources: new Set(), weights: new Map(), firstSeen: now, lastSeen: now };
      store.set(beliefId, b);
    }
    if (sourceId != null) {
      b.sources.add(sourceId);
      const w = Math.max(0, Number(weight));
      b.weights.set(sourceId, Math.max(b.weights.get(sourceId) ?? 0, Number.isFinite(w) ? w : 1));
    }
    b.lastSeen = now;
    return b;
  };

  // Distinct independent witnesses for a belief (unweighted count — unchanged).
  const sourceCount = (beliefId) => { const b = get(beliefId); return b ? b.sources.size : 0; };

  // Trust-weighted witness mass: Σ over distinct sources of their weight (default 1.0 ⇒ equals sourceCount).
  const witnessWeight = (beliefId) => {
    const b = get(beliefId);
    if (!b) return 0;
    let sum = 0;
    for (const s of b.sources) sum += b.weights.get(s) ?? 1;
    return sum;
  };

  // Trusted iff the trust-weighted witness mass clears k. Default weights ⇒ identical to ">= k distinct sources".
  const confirmed = (beliefId) => witnessWeight(beliefId) >= k;

  // Confidence in [0,1] = corroboration (saturating in weighted witness mass) × recency (half-life since lastSeen).
  const confidence = (beliefId, { now = 0 } = {}) => {
    const b = get(beliefId);
    if (!b) return 0;
    const corrob = sat <= 0 ? 1 : clamp01(witnessWeight(beliefId) / sat);
    const rec = Math.max(confFloor, recency(now - b.lastSeen, halfLife));
    return clamp01(corrob * rec);
  };

  // Expire beliefs that are UNCONFIRMED (< k sources) AND stale (untouched longer than ttl). Confirmed beliefs persist
  // regardless of age; a re-observed belief refreshed its lastSeen so it survives. Returns the expired belief ids.
  const prune = ({ now = 0 } = {}) => {
    const expired = [];
    for (const [id, b] of store) {
      if (witnessWeight(id) >= k) continue;        // (trust-weighted) confirmed → permanent
      if (now - b.lastSeen > ttl) { expired.push(id); store.delete(id); }
    }
    return expired;
  };

  const beliefs = () => [...store.keys()];
  const forget = (id) => store.delete(id);

  // Serializable state (Set → array) for persistence / mind-fission handoff.
  const snapshot = () => {
    const out = {};
    for (const [id, b] of store) {
      const e = { sources: [...b.sources], firstSeen: b.firstSeen, lastSeen: b.lastSeen };
      // Only emit weights when any source carries a non-default (≠1) weight, so default-weight snapshots stay byte-identical.
      const nonDefault = [...b.weights.entries()].filter(([, w]) => w !== 1);
      if (nonDefault.length) e.weights = Object.fromEntries(nonDefault);
      out[id] = e;
    }
    return { k, ttl, halfLife, beliefs: out };
  };
  const restore = (snap) => {
    if (!snap || !snap.beliefs) return;
    store.clear();
    for (const [id, b] of Object.entries(snap.beliefs)) {
      const sources = new Set(b.sources || []);
      const weights = new Map();
      for (const s of sources) weights.set(s, b.weights && b.weights[s] != null ? b.weights[s] : 1);
      store.set(id, { sources, weights, firstSeen: b.firstSeen ?? 0, lastSeen: b.lastSeen ?? 0 });
    }
  };

  return { observe, confirmed, confidence, sourceCount, witnessWeight, prune, beliefs, forget, snapshot, restore, get config() { return { k, ttl, halfLife, sat }; } };
}
