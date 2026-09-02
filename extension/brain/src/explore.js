// explore.js — the self-annealing explore/exploit rule: curiosity that is high when you know little and
// falls away as your known set grows, driven by KNOWLEDGE, not elapsed time.
//
// There is deliberately no clock here: no epsilon-decay schedule, no tuning curve keyed to ticks. An
// affinity system that only reinforces what it already likes becomes a prison — preference drives
// exposure, exposure drives preference, and nothing new is ever tried again. The fix (FRACTALRABBIT
// transfer T1, docs/specs/2026-07-29-fractalrabbit-mine.md) is five lines:
//
//     P(explore) = phi / (phi + nKnown - 1)
//
// phi IS the curiosity dial: bigger phi keeps exploring across a larger known set. Built standalone
// because curiosity, lookups, Moot deliberation breadth and skill choice all want the same rule.
//
// Determinism: no Date.now(), no Math.random(). Randomness enters only as a caller-supplied uniform.

const clamp01 = (v) => (Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0);

export function makeExplorer({ phi = 2 } = {}) {
  if (!Number.isFinite(phi) || phi <= 0) throw new Error("makeExplorer: phi must be a finite number > 0");

  // High when nKnown is small; anneals toward 0 as the known set grows. Non-finite/negative n → 0 known → 1.
  function probability(nKnown) {
    const n = Number.isFinite(nKnown) && nKnown > 0 ? nKnown : 0;
    return clamp01(phi / (phi + n - 1));
  }

  // Explore iff a caller-supplied uniform falls below the current probability. No hidden randomness.
  function decide(nKnown, uniform) {
    return Number.isFinite(uniform) && uniform < probability(nKnown);
  }

  return { probability, decide, phi };
}

export default makeExplorer;
