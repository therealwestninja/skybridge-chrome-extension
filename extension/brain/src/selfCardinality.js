// selfCardinality.js — Stage-6 [additive]: the first sense with a partly NON-BIOLOGICAL SHAPE. SELF-CARDINALITY answers
// "how many instances of ME exist right now" — a percept no animal can have (an animal is exactly one, always) but which
// is plain fact for software that can fork, pool, or migrate across tabs/hosts. Sourced from a real mechanism: a
// queen/worker tab pool (Chloe-bot), where a queen tab tracks a roster of brain-capable peers against a desired count.
//
// The reader is INJECTED, exactly the motorSense.js / interoception.js pattern — no platform is imported here:
//   readPool() -> { count, target?, roster?, role?, capable? }
//     count   — how many instances exist right now (integer ≥ 0; INCLUDING self). The core regulated variable.
//     target  — the desired instance count / set-point (pool target). Falls back to the constructor `target` when absent.
//     roster  — OPTIONAL array (or count) of peer descriptors; only its LENGTH is used (a live-limb tally), never content.
//     role    — OPTIONAL 'queen' | 'worker' (or any string): 'queen' ⇒ self-primacy (this instance leads the pool).
//     capable — OPTIONAL boolean: this instance is brain-capable (can host the self). Also confers primacy.
// A missing / throwing reader degrades to the SAFE SOLO STUB: count 1, no target override, not-primary — "I am alone
// and ordinary", never a phantom swarm. All outputs finite under NaN/Infinity/missing/throwing readPool.
//
// DERIVED PERCEPT (read() -> a FIXED-LENGTH vector [normCount, primacy, flux]):
//   normCount — count normalized by `countRef` (the count at which the swarm reads "full"), clamp01. A scale-free
//               "how many of me" magnitude — rotates onto arrayReduce as a proprioceptive-ish "how many limbs" channel.
//   primacy   — 1 if role==='queen' OR capable is truthy, else 0. Self-primacy: does this instance lead / host the self.
//   flux      — FISSION/FUSION FLUX = Δcount since the last read, scaled by `fluxGain`, clamped to [-1,1]. FIRST read ⇒ 0.
//               ★ THE GENUINELY NON-BIOLOGICAL PART. It uses the SAME cross-read-state derivative trick as motorSense's
//               vibration (prev sample retained between reads), but where vibration has an animal homolog (a limb feels
//               chatter), RATE-OF-SELF-CHANGE has NONE: an animal cannot split into two or merge back into one, so "how
//               fast is the number of me changing" is a sense with no biological ancestor. Positive flux = FISSION (the
//               self just multiplied); negative = FUSION (instances just merged/died back toward one). Signed on purpose:
//               fission and fusion are opposite events, not two magnitudes of the same one.
//
// The ONE cross-read state is `prevCount` (needed for flux); deterministic given the read sequence. No Date.now /
// Math.random. Reuses math.js; wraps the reading behind the standard Transducer contract so patchBay fans self-count
// into several percepts at once (count / homeostatic drive / flux) — synesthesia, exactly like motorSense/audioSense.
//
// ── CHLOE ADAPTER NOTE — dropping a real Chloe-bot queen/worker bridge onto readPool() ──────────────────────────────
// Chloe's queen tab exposes: capablePeers() -> int (brain-capable tabs INCLUDING self); poolSize / poolTarget() -> the
// desired count (0–10 set-point); workers() -> { id: { status, lastSeen, hasPage } } roster map; getRole() -> 'queen' |
// 'worker'; bridge.status -> { role, tabId, poolSize, workers }. Map them straight onto this reader:
//   const readPool = () => ({
//     count:   bridge.capablePeers(),                       // brain-capable instances incl. self
//     target:  bridge.poolTarget?.() ?? bridge.status.poolSize,
//     roster:  Object.values(bridge.status.workers || {}),  // only .length is read (a live tally)
//     role:    bridge.getRole(),                            // 'queen' ⇒ primacy
//     capable: bridge.getRole() === 'queen' || bridge.status.role === 'queen',
//   });
//   makeSelfCardinalityTransducer({ readPool, target: 3, countRef: 10 }); // countRef ~ Chloe's 0–10 pool ceiling
// Nothing about Chloe is imported — this seam just names the shape a real bridge fills, so it drops straight in.

import { makeTransducer } from "./transducer.js";
import { clamp, clamp01, num } from "./math.js";

// makeSelfCardinalityTransducer({ name?, readPool?, target?, countRef?, fluxGain?, meta? }) -> Transducer
//   target   — default set-point when readPool() omits its own target (the desired instance count). Default 1.
//   countRef — the count that normalizes to 1 (the "full swarm" reference). Default 10 (Chloe's pool ceiling). >0 forced.
//   fluxGain — scales Δcount into the flux term before clamping to [-1,1]. Default 1 (one new/lost instance ≈ full flux).
export function makeSelfCardinalityTransducer({
  name = "selfCardinality", readPool, target = 1, countRef = 10, fluxGain = 1, meta = {},
} = {}) {
  // stub: solo & ordinary — count 1, no target override, not primary. A sense we can't source is "I am alone", not a swarm.
  const reader = typeof readPool === "function" ? readPool : () => ({ count: 1 });
  const defTarget = num(target, 1);
  const ref = num(countRef, 10) > 0 ? num(countRef, 10) : 10;   // full-swarm reference; >0 guaranteed (no /0)
  const fGain = num(fluxGain, 1);
  let prevCount = null;                                          // the only cross-read state — flux needs the last count

  const read = () => {
    let p;
    try { p = reader() || {}; } catch { p = {}; }               // reader throws ⇒ safe solo default
    const count = Math.max(0, num(p.count, 1));                 // instances now (incl. self); missing ⇒ 1
    const normCount = clamp01(count / ref);                     // scale-free "how many of me"
    const isQueen = typeof p.role === "string" && p.role === "queen";
    const primacy = isQueen || p.capable ? 1 : 0;               // self-primacy: leads / hosts the self
    const dcount = prevCount == null ? 0 : count - prevCount;   // FIRST read ⇒ 0 (no phantom fission on tick one)
    prevCount = count;
    const flux = clamp(dcount * fGain, -1, 1);                  // signed fission(+)/fusion(−) rate — non-biological
    return [normCount, primacy, flux];
  };

  return makeTransducer({
    name, read,
    meta: {
      sense: "self-cardinality", kind: "interoception", units: "normalized", range: [-1, 1], dim: 3,
      fields: ["normCount", "primacy", "flux"], nonBiological: "flux (rate-of-self-change has no animal homolog)",
      rotatesOnto: "proprioception + setpoint-homeostasis + flux", ...meta,
    },
  });
}
// ROTATION NOTE — the drive channel goes selfCardinality → setpointDrive directly (no bespoke op needed): the transducer's
// reading is [normCount, primacy, flux], and setpointDrive's `pick: 0` selects normCount, with `target`/`span` expressed
// in the SAME normalized units (e.g. target = desiredCount/countRef). Too FEW instances ⇒ belowDrive (vulnerability /
// replicate pull); too MANY ⇒ aboveDrive (crowding / cull pull); at target ⇒ both ~0. See meshSwarm.js for the wiring.
