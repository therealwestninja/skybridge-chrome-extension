// affinity.js — REVEALED preference: preferences Rook earns from living, not ones it is told.
//
// `src/beliefs.js` models ESPOUSED preference — a *stated* view absorbed as a confidence-weighted mean
// that decays in absence. This is the missing half: revealed preference, accumulated from what Rook and
// the user actually *do*. Having both is what lets Rook later notice the gap between them.
//
// Three load-bearing design decisions:
//   1. FREQUENCY IS NOT PREFERENCE. A tally alone calls your commute your favourite journey. Every
//      encounter carries a valence in [-1,+1]; affinity is the valence-weighted mean, not the count.
//   2. CONFIDENCE is a separate axis from the value. It saturates with sample size (n/(n+halfAt)) so a
//      "favourite" at n=1 (a first impression) is honestly distinguished from one earned over many visits.
//   3. Revealed preference is normalised by OPPORTUNITY. You don't visit your favourite place because it
//      is four hours away, not because you stopped loving it. Each encounter records whether the thing was
//      merely offered or actually chosen; chosen/offered is tracked separately from valence.
//
// Design rule inherited from beliefs.js (deliberately): the affinity VALUE does not decay — you do not
// stop having loved something. CONFIDENCE decays in absence, so a stale favourite quietly drops out of
// "these days" (ranked by affinity x confidence) without its history being erased. The high-water `peak`
// never fades.
//
// Determinism: no Date.now(), no Math.random(). Time advances ONLY via tick() from the caller. Every
// tuning number is a named, caller-overridable option.

import { clamp, ema } from "./math.js";

const isId = (id) => typeof id === "string" && id.length > 0;
const clamp01 = (v) => (Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0);
const clampVal = (v) => (Number.isFinite(v) ? clamp(v, -1, 1) : 0);
const numOr = (v, d) => (Number.isFinite(v) ? v : d);

export function makeAffinity({
  confidenceHalfAt = 5,    // encounters at which confidence reaches 0.5
  confidenceDecay = 0.01,  // per tick, in absence (mirrors beliefs.js)
  driftFast = 0.30,        // EMA rate: recent feeling
  driftSlow = 0.05,        // EMA rate: settled baseline
  opportunityFloor = 1,    // treat this many offers as the minimum denominator
  driftDeadband = 0.05,    // |fast - slow| within this reads as "steady"
  tentativeBelow = 0.4,    // a superlative below this confidence is stated but flagged as a hunch
} = {}) {
  const halfAt = numOr(confidenceHalfAt, 5);
  const decay = numOr(confidenceDecay, 0.01);
  const aFast = numOr(driftFast, 0.30);
  const aSlow = numOr(driftSlow, 0.05);
  const floor = numOr(opportunityFloor, 1);
  const deadband = numOr(driftDeadband, 0.05);

  /** @type {Map<string, object>} */
  const map = new Map();

  function ensure(id, kind) {
    let e = map.get(id);
    if (!e) {
      e = {
        kind: kind || null,
        n: 0, wsum: 0, mean: 0, m2: 0,   // Welford (weighted) running mean + second moment
        fast: 0, slow: 0,                // drift EMAs, seeded on the first encounter
        confidence: 0,
        offered: 0, chosen: 0,
        peak: null,                      // { affinity, n } high-water mark; never fades
        fresh: false,
      };
      map.set(id, e);
    } else if (kind && !e.kind) {
      e.kind = kind;
    }
    return e;
  }

  // An encounter: a lived data point with a valence. Welford keeps mean + variance exact in one pass.
  function encounter(id, { kind, valence = 0, chosen = true, weight = 1 } = {}) {
    if (!isId(id)) return;
    const v = clampVal(valence);
    const w = Number.isFinite(weight) && weight > 0 ? weight : 1;
    const e = ensure(id, kind);

    // Seed the drift EMAs on the first encounter so "steady" input reads as steady, not as warming-from-zero.
    if (e.n === 0) { e.fast = v; e.slow = v; }
    else { e.fast = ema(e.fast, v, aFast); e.slow = ema(e.slow, v, aSlow); }

    // Weighted Welford (West, 1979).
    e.wsum += w;
    const meanOld = e.mean;
    e.mean += (w / e.wsum) * (v - e.mean);
    e.m2 += w * (v - meanOld) * (v - e.mean);

    e.n += 1;
    e.confidence = e.n / (e.n + halfAt);
    e.offered += 1;
    if (chosen) e.chosen += 1;
    e.fresh = true;

    const aff = clamp(e.mean, -1, 1);
    if (!e.peak || aff > e.peak.affinity) e.peak = { affinity: aff, n: e.n };
  }

  // The thing was on the table but not (necessarily) taken — availability without a valence.
  function offer(id, kind) {
    if (!isId(id)) return;
    ensure(id, kind).offered += 1;
  }

  const get = (id) => (isId(id) ? map.get(id) : undefined);

  const affinity = (id) => { const e = get(id); return e ? clamp(e.mean, -1, 1) : 0; };
  const confidence = (id) => { const e = get(id); return e ? clamp01(e.confidence) : 0; };

  // Normalised spread from Welford's m2: population variance / max possible (=1 for values in [-1,1]).
  // NOT a mean near zero — [+0.9,-0.9,...] is conflict, [0,0,...] is indifference.
  function ambivalence(id) {
    const e = get(id);
    if (!e || e.n < 2 || e.wsum <= 0) return 0;
    return clamp01(e.m2 / e.wsum);
  }

  // The revealed draw: how strongly, how surely, how freely-chosen. What superlatives should rank on.
  function pull(id) {
    const e = get(id);
    if (!e) return 0;
    const opportunityWeight = e.chosen / Math.max(floor, e.offered || 0);
    return clamp(e.mean, -1, 1) * clamp01(e.confidence) * opportunityWeight;
  }

  const peak = (id) => { const e = get(id); return e && e.peak ? { affinity: e.peak.affinity, n: e.peak.n } : null; };

  // Drift: recent feeling minus settled baseline. Positive = warming, negative = cooling.
  const drift = (id) => { const e = get(id); return e ? e.fast - e.slow : 0; };

  function drifting(id) {
    const d = drift(id);
    if (d > deadband) return "warming";
    if (d < -deadband) return "cooling";
    return "steady";
  }

  // Confidence fades in absence (the beliefs.js rule); the VALUE and the PEAK never do.
  function tick() {
    for (const e of map.values()) {
      if (!e.fresh) e.confidence = clamp01(e.confidence - decay);
      e.fresh = false;
    }
  }

  const tent = numOr(tentativeBelow, 0.4);

  // --- superlatives & choosing: the surface Rook speaks preference through ---

  const kinds = () => [...new Set([...map.values()].map((e) => e.kind).filter((k) => typeof k === "string"))].sort();

  function row(id, e) {
    return {
      id,
      affinity: clamp(e.mean, -1, 1),
      confidence: clamp01(e.confidence),
      pull: pull(id),
      ambivalence: ambivalence(id),
      drift: e.fast - e.slow,
    };
  }

  // Best-first within a kind, ranked on opportunity-weighted pull (not raw frequency); ties by id ascending.
  function ranked(kind, { minConfidence = 0 } = {}) {
    const floorConf = numOr(minConfidence, 0);
    return [...map.entries()]
      .filter(([, e]) => e.kind === kind && e.confidence >= floorConf)
      .map(([id, e]) => row(id, e))
      .sort((a, b) => (b.pull - a.pull) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  // The end entries of a ranking. null when the kind is unknown, or when a demanded minConfidence is unmet.
  // Below tentativeBelow (and no minConfidence demanded), the entry is returned but flagged tentative — the
  // honest "I think" hedge rather than a false superlative.
  function endOf(kind, pickLast, opts = {}) {
    const hasMin = opts && typeof opts.minConfidence === "number";
    const r = ranked(kind, opts);
    if (!r.length) return null;
    const entry = pickLast ? r[r.length - 1] : r[0];
    if (!hasMin && entry.confidence < tent) return { ...entry, tentative: true };
    return entry;
  }

  const favorite = (kind, opts) => endOf(kind, false, opts);
  const least = (kind, opts) => endOf(kind, true, opts);

  // Which of two is preferred, and by how much (opportunity-weighted). null winner for same/equal/unknown.
  function compare(idA, idB) {
    const eA = get(idA), eB = get(idB);
    if (!eA || !eB || idA === idB) return { winner: null, margin: 0, tentative: false };
    const pA = pull(idA), pB = pull(idB);
    const tentative = eA.confidence < tent || eB.confidence < tent;
    if (pA === pB) return { winner: null, margin: 0, tentative };
    return pA > pB
      ? { winner: idA, margin: pA - pB, tentative }
      : { winner: idB, margin: pB - pA, tentative };
  }

  // The novelty budget (Task 1): should Rook reach past its favourites? Driven by how much it knows of a kind.
  function shouldTrySomethingNew(kind, explorer, uniform) {
    if (!explorer || typeof explorer.decide !== "function") return false;
    const known = [...map.values()].filter((e) => e.kind === kind).length;
    return explorer.decide(known, uniform);
  }

  // --- divergence: what you SAY vs what you DO (espoused vs revealed) ---
  //
  // Decoupled by design: takes an injected lookup (id) => { stance, confidence } (beliefs.opinion satisfies it),
  // never a beliefs object. Reported only when BOTH sides are confident AND opportunity was really there —
  // circumstance constrains choice, so a divergence is a question to ask, not a correction to make. The note
  // names the softer reading so callers phrase it that way.
  function divergence(statedLookup, {
    minStatedConfidence = 0.5,
    minRevealedConfidence = 0.5,
    minGap = 0.6,
    minOpportunity = 2,
  } = {}) {
    if (typeof statedLookup !== "function") return [];
    const out = [];
    for (const [id, e] of map) {
      let said = 0, saidConf = 0;
      try {
        const s = statedLookup(id) || {};
        said = clampVal(s.stance);
        saidConf = clamp01(s.confidence);
      } catch { continue; }
      const did = clamp(e.mean, -1, 1);
      const gap = Math.abs(said - did);
      if (saidConf < minStatedConfidence) continue;
      if (e.confidence < minRevealedConfidence) continue;
      if (gap < minGap) continue;
      if (e.chosen < minOpportunity) continue;
      out.push({
        id, kind: e.kind, said, did, gap,
        note: "evidence, not proof — circumstance may limit the opportunity, so ask rather than conclude",
      });
    }
    return out.sort((a, b) => (b.gap - a.gap) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  // --- persistence (the skillMastery shape): plain JSON, tolerant of malformed input ---
  function snapshot() {
    const entities = {};
    for (const [id, e] of map) {
      entities[id] = {
        kind: e.kind, n: e.n, wsum: e.wsum, mean: e.mean, m2: e.m2,
        fast: e.fast, slow: e.slow, confidence: e.confidence,
        offered: e.offered, chosen: e.chosen,
        peak: e.peak ? { affinity: e.peak.affinity, n: e.peak.n } : null,
      };
    }
    return { version: 1, entities };
  }

  function restore(s) {
    if (!s || typeof s !== "object") return;
    const entities = s.entities;
    if (!entities || typeof entities !== "object") return;
    map.clear();
    for (const id of Object.keys(entities)) {
      if (!isId(id)) continue;
      const r = entities[id];
      if (!r || typeof r !== "object") continue;
      map.set(id, {
        kind: typeof r.kind === "string" ? r.kind : null,
        n: numOr(r.n, 0), wsum: numOr(r.wsum, 0), mean: numOr(r.mean, 0), m2: numOr(r.m2, 0),
        fast: numOr(r.fast, 0), slow: numOr(r.slow, 0), confidence: clamp01(numOr(r.confidence, 0)),
        offered: numOr(r.offered, 0), chosen: numOr(r.chosen, 0),
        peak: r.peak && typeof r.peak === "object" && Number.isFinite(r.peak.affinity)
          ? { affinity: r.peak.affinity, n: numOr(r.peak.n, 0) } : null,
        fresh: false,
      });
    }
  }

  return {
    encounter, offer,
    affinity, confidence, ambivalence, pull,
    peak, drift, drifting,
    tick,
    kinds, ranked, favorite, least, compare, shouldTrySomethingNew,
    divergence,
    snapshot, restore,
  };
}

export default makeAffinity;
