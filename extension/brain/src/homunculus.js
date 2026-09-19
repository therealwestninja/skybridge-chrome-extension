// homunculus.js — Stage-2 KEYSTONE [additive]: the CORTICAL HOMUNCULUS as a WEIGHTING, not anatomy. Holds a live,
// named, inspectable, serializable per-channel weight map over the fused sense channels (the keys organFusion.fuse /
// patchBay consume). Representational "area" = weight: the value function enlarges the channels it cares about and lets
// the unused ones atrophy — exactly the cortical-remapping finding, expressed as a plastic gain vector rather than wiring.
//
// WHY ADDITIVE / how weights reach fusion: organFusion.fuse already has a weight seam — it computes, per organ,
// `w = weights[o] * reliability[o] * live` and then `v.map(x => x*w)` before concatenating and L2-normalizing. But that
// `weights` map is FIXED at makeOrganFusion() construction; there is no per-tick weight input. Rather than edit the
// spine to thread a live map, we inject the homunculus gain by PRE-SCALING each channel's vector before handing it to
// the UNMODIFIED fuse (via `weightedFuse`). Because fuse applies its own `weights[o]` as a plain scalar multiply over the
// vector, and every factor (weights·reliability·live·gain) commutes before the concat + single L2 norm, pre-scaling
// channel c by gain g yields a fused VECTOR/layout/present/dim byte-identical to fuse having been given
// `weights[c] = g · weights_fuse[c]` — for ANY base weights, reliability, and live/liveness, and for any g > 0.
//   EXACT SCOPE OF THE IDENTITY (the safety argument, proven across all fuse paths in the tests):
//     - The fused VECTOR (what the decider consumes), plus layout/present/dim, is identical. That is the output that matters.
//     - The ONE field that does not match is the `contributions` audit scalar: fuse reports its own internal
//       w = weights_fuse[c]·reliability·live, blind to the pre-scaling, so it reads the same whether g=1 or g=5. Treat
//       `contributions` as "the spine's static blend", NOT a readout of effective gain — read gain from snapshot()/toJSON().
//       (At g=1 contributions matches too, hence OFF is fully byte-identical including metadata.)
//     - g <= 0 is the lone place the VECTOR could diverge: fuse DROPS an organ whose total weight is <=0, so weightedFuse
//       drops a g<=0 channel as well (see the guard) instead of feeding a zero vector fuse would keep. Unreachable at the
//       default floor (0.1>0); guarded only for configs with floor <= 0. So:
//   • OFF (every weight == 1, reinforce never called)  ⇒  scaled === input  ⇒  fuse output is BYTE-IDENTICAL to today.
//   • A channel whose weight grows occupies a proportionally larger share of the normalized fused vector (its slice
//     norm rises); a channel whose weight decays shrinks toward the floor. The homunculus is visible in the geometry.
// This keeps organFusion.js and codec.js completely untouched (the Stage-2 constraint).
//
// THE PLASTICITY RULE (reinforce(activity, affect)) — use-dependent potentiation fighting homeostatic relaxation:
//   perChannel:  w ← w + rate · affect · activity[c]          // Hebbian-ish: co-occurrence of USE (activity) and VALUE
//                w ← decayTowardSetpoint(w, baseline, decay)   // (affect) potentiates; relax pulls back toward baseline
//                w ← clamp(w, floor, ceil)                     // hard floor (recoverable) + ceil (can't blow up)
//   • affect is the value/reward scalar (≈[-1,1]); positive grows the co-active channels, negative depresses them.
//   • activity[c] is that channel's use this tick (e.g. the L2 norm of its raw percept slice) — no activity ⇒ no
//     potentiation, so an unrewarded / unused channel just relaxes toward baseline.
//   • baseline DEFAULTS TO floor: the resting model is ATROPHY — unused area is reclaimed down to the floor, never to
//     zero (floor keeps every channel recoverable: a later reward lifts it straight back up). Raise `baseline` above
//     `floor` for a model where idle channels settle at a non-trivial rest gain instead of fully atrophying.
//   • Equilibrium for a steadily rewarded channel: rate·affect·activity = decay·(w − baseline) ⇒ bounded, then ceil-clamped.
// PURE & deterministic: no Date.now / Math.random; affect + activity are injected. Reuses math.js clamp/num/decayTowardSetpoint.

import { clamp, num, decayTowardSetpoint } from "./math.js";

// makeHomunculus({ channels?, rate?, decay?, floor?, ceil?, baseline?, init? })
//   channels — optional seed list; channels also auto-register the first time reinforce()/set() sees them.
//   init     — starting weight for a channel (default 1 ⇒ identity / byte-identical fusion when no reinforcement runs).
//   rate     — potentiation gain on (affect × activity).           decay   — homeostatic relax rate toward baseline.
//   floor    — hard lower clamp (recoverable, never starves).      ceil    — hard upper clamp (can't blow up).
//   baseline — homeostatic setpoint the relax pulls toward (default = floor: pure use-it-or-lose-it atrophy).
export function makeHomunculus({ channels = [], rate = 0.2, decay = 0.05, floor = 0.1, ceil = 4, baseline, init = 1 } = {}) {
  const cfg = {
    rate: num(rate, 0.2), decay: clamp(num(decay, 0.05)), floor: num(floor, 0.1),
    ceil: num(ceil, 4), init: num(init, 1),
  };
  cfg.baseline = baseline != null ? num(baseline, cfg.floor) : cfg.floor; // default: atrophy toward the floor
  if (cfg.ceil < cfg.floor) cfg.ceil = cfg.floor;                          // keep the clamp window well-formed

  const W = new Map();
  const clampW = (w) => clamp(num(w, cfg.init), cfg.floor, cfg.ceil);
  const ensure = (c) => { if (!W.has(c)) W.set(c, clampW(cfg.init)); return W.get(c); };
  for (const c of channels) ensure(c);

  // --- inspection / mutation ---
  const has = (c) => W.has(c);
  const get = (c) => (W.has(c) ? W.get(c) : cfg.init);           // unknown channel ⇒ identity gain (1 by default)
  const set = (c, w) => { W.set(c, clampW(w)); return api; };
  const names = () => [...W.keys()];
  const snapshot = () => { const o = {}; for (const [c, w] of W) o[c] = w; return o; }; // plain {channel: weight} copy

  // --- the plasticity step ---
  // activity: { channel: useScalar } (any subset; missing ⇒ 0 use). affect: the value/reward scalar (≈[-1,1]).
  // Relaxation is applied to EVERY known channel (so idle channels atrophy even on ticks where activity omits them).
  // Returns { delta: {channel: Δ}, weights } for observability/testing.
  function reinforce(activity = {}, affect = 0) {
    const a = num(affect, 0);
    for (const c of Object.keys(activity || {})) ensure(c);       // a newly-used channel joins the map at init
    const before = snapshot();
    for (const c of W.keys()) {
      const use = num(activity ? activity[c] : 0, 0);
      let w = W.get(c) + cfg.rate * a * use;                      // use-dependent, affect-gated potentiation/depression
      w = decayTowardSetpoint(w, cfg.baseline, cfg.decay);         // homeostatic relaxation toward baseline
      W.set(c, clampW(w));                                        // hard floor + ceil
    }
    const delta = {}; for (const [c, w] of W) delta[c] = w - before[c];
    return { delta, weights: snapshot() };
  }

  // --- apply the gain through organFusion's existing weight seam, WITHOUT editing it ---
  // weightedFuse(fusion, vectors, live): pre-scale each channel's percept by its weight, then call the unmodified
  // fusion.fuse. `fusion` is any object with a .fuse(vectors, live) (i.e. a makeOrganFusion() instance). Channels absent
  // from the map use the identity gain (get() ⇒ init, default 1), so an un-reinforced homunculus is a perfect pass-through.
  function weightedFuse(fusion, vectors = {}, live = {}) {
    if (!fusion || typeof fusion.fuse !== "function") throw new Error("homunculus.weightedFuse: a fusion with .fuse() is required");
    const scaled = {};
    for (const c of Object.keys(vectors)) {
      const v = vectors[c];
      const arr = Array.isArray(v) ? v : [v];
      const g = get(c);
      // g<=0 means the channel is silenced. fuse's own seam DROPS an organ whose total weight w<=0 (the `if (w<=0) continue`).
      // To stay identical to "fuse given weights[c]=g" we must DROP here too — NOT pass a zero vector, which fuse would keep
      // (a dead channel still occupying a layout slice + dragging the L2 norm). With the default floor (0.1>0) this never
      // fires; it only guards configs whose floor is <=0. (Equivalence is over the fused VECTOR/layout/present — see header.)
      if (g <= 0) continue;
      scaled[c] = g === 1 ? arr.slice() : arr.map((x) => x * g); // g===1 ⇒ exact copy ⇒ byte-identical to raw fuse
    }
    const out = fusion.fuse(scaled, live);

    // EFFECTIVE-WEIGHT SURFACING (Stage-3, additive): organFusion's `contributions[c]` is the SPINE's static blend
    // w = weights_fuse[c]·reliability[c]·live — it is BLIND to the homunculus gain (documented in Stage 2). So the
    // TRUE per-channel effective gain is gain · (that static w) = get(c)·contributions[c]. We expose it as a derived
    // `effectiveWeights` map for audit/demo rendering WITHOUT touching organFusion. For a channel fuse dropped (w<=0,
    // or g<=0 here) there is no contribution, so it is absent from effectiveWeights too.
    //   CRITICAL: this is attached NON-ENUMERABLE so the byte-identical-OFF contract holds — a deep toEqual() against
    //   a raw fuse() result ignores non-enumerable own props, so weightedFuse at g==1 stays byte-identical including
    //   metadata. snapshot()/toJSON() remain the authoritative weight source; effectiveWeights is a read-only convenience.
    const effectiveWeights = {};
    for (const c of Object.keys(out.contributions || {})) {
      effectiveWeights[c] = +(get(c) * out.contributions[c]).toFixed(4);
    }
    Object.defineProperty(out, "effectiveWeights", { value: effectiveWeights, enumerable: false, configurable: true });
    return out;
  }

  // --- serialization (round-trippable) ---
  const toJSON = () => ({ v: 1, cfg: { ...cfg }, weights: snapshot() });
  function fromJSON(s) {
    if (!s) return api;
    if (s.cfg) Object.assign(cfg, { ...cfg, ...s.cfg });
    if (s.weights) { W.clear(); for (const c of Object.keys(s.weights)) W.set(c, clampW(s.weights[c])); }
    return api;
  }

  const api = { has, get, set, reinforce, weightedFuse, channels: names, snapshot, toJSON, fromJSON, config: () => ({ ...cfg }) };
  return api;
}

// Rehydrate a homunculus straight from a toJSON() blob.
makeHomunculus.fromJSON = (s) => makeHomunculus({}).fromJSON(s);
