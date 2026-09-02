// drives.js — interoception + homeostatic drives. The brain already has ONE bodily variable (metabolism = energy), but
// it's a load-shedding gate, not a FELT NEED. This is the felt layer: a handful of drives that read the brain's own
// state, accumulate PRESSURE when a need goes unmet, relax when it's met, and MOTIVATE — the thing that turns a listed
// goal into a wanted one. Interoception (the insula sensing the body) + homeostatic drive (a deficit that pushes
// behaviour to restore a setpoint); Damasio's somatic markers are the nearby idea.
//
// The four drives, each mapped to a signal the brain already produces:
//   • connection  — social/bond need; unmet by absence + cold/disengaged turns, met by warm engagement (ToM).
//   • rest        — the interoceptive READ of `metabolism` (low energy → a felt need to rest). Not a duplicate variable.
//   • stimulation — need for novelty; unmet when turns are repetitive/low-novelty, met by something new.
//   • esteem      — need to feel effective; unmet when actions don't land (negative reward), met when they do.
//
// SAFETY: drives motivate through the PROMPT (a felt-need disposition line) and the ATTENTION workspace (a strong need
// competes for the spotlight — a lonely brain attends to connection). They deliberately do NOT feed back into the
// substrate's neuromodulation/firing — closed chemistry loops have caused runaways here before. Feed-forward only.
import { clamp, clamp01 } from "./math.js";


const SPEC = {
  connection: { setpoint: 0.4, directive: "You feel a quiet pull toward connection right now — lean a little warmer and more present.", need: "a pull toward connection" },
  rest:       { setpoint: 0.3, directive: "Your energy feels low — it's okay to be a little briefer and gentler right now.", need: "low energy, a need to rest" },
  stimulation:{ setpoint: 0.4, directive: "You feel restless for something new — let a thread of curiosity or play in.", need: "restlessness for something new" },
  esteem:     { setpoint: 0.35, directive: "Your efforts lately haven't quite landed — steady yourself and focus on being genuinely useful.", need: "a need to feel useful" },
  // clarity — the felt need to UNDERSTAND. Unmet by open gaps / confusion / a held contradiction (the epistemic itch from
  // epistemicAffect.js); met by resolving them. This is what gives "I don't know" TEETH: not-knowing isn't a passive note,
  // it accumulates PRESSURE that pulls the attention workspace toward checking/asking instead of glossing over the gap.
  clarity:    { setpoint: 0.35, directive: "Something here you don't fully understand — let the not-knowing pull you to check or ask, not gloss it over.", need: "a pull to understand what you don't yet know" },
};

export function makeDrives({ relax = 0.1, gain = 0.16, margin = 0.22, urgentAt = 0.25 } = {}) {
  const level = {}; for (const k in SPEC) level[k] = SPEC[k].setpoint; // start satisfied (at rest)

  // Per-turn deficits in [0,1] (0.5 = neutral): >0.5 raises the drive, <0.5 lets it relax toward the setpoint.
  function deficits({ engagement = 0.5, stance = 0, reward = 0, novelty = 0.5, energy = 1, away = 0, unresolved = 0 }) {
    // Rigidity-gate principle (mined 2607.00022 — don't over-trust one thin signal): message LENGTH is a noisy proxy for
    // engagement, so a short-but-WARM turn read as disengaged and (bench-longitudinal meter G) SATURATED the connection
    // drive — a terse-but-warm session looked chronically lonely. Let warmth corroborate: a warm interaction lifts
    // effective engagement even when brief, so warmth can satisfy connection. Coldness still starves it (no bonus).
    const effEngagement = clamp01(engagement + Math.max(0, stance) * 0.5);
    const satisfaction = clamp01(0.5 + 0.5 * stance) * effEngagement; // warm AND/OR engaged = a met connection need
    return {
      connection: clamp01(1 - satisfaction + 0.4 * clamp01(away)),  // absence + coldness/disengagement grow it
      rest: clamp01(1 - clamp01(energy)),                            // interoceptive read of the energy budget
      stimulation: clamp01(1 - clamp01(novelty)),                    // boredom = low novelty
      esteem: clamp01(0.5 - 0.5 * clamp(reward, -1, 1)),             // actions not landing → a competence deficit
      clarity: clamp01(unresolved),                                  // open gaps / confusion / a held contradiction (0 = all understood)
    };
  }

  function update(signals = {}) {
    const d = deficits(signals);
    for (const k in SPEC) level[k] = clamp01(level[k] + relax * (SPEC[k].setpoint - level[k]) + gain * (d[k] - 0.5));
    return snapshot();
  }

  // The felt need = the drive whose pressure (how far it's pushed past its comfort band) is greatest. Null when every
  // drive sits inside its band (contentment — no felt need to voice).
  function dominant() {
    let best = null, bestP = 0;
    for (const k in SPEC) { const p = level[k] - (SPEC[k].setpoint + margin); if (p > bestP) { bestP = p; best = k; } }
    return best ? { name: best, level: +level[best].toFixed(2), pressure: +bestP.toFixed(2) } : null;
  }

  function snapshot() { const o = {}; for (const k in SPEC) o[k] = +level[k].toFixed(2); return o; }

  return {
    update, snapshot, dominant,
    pressure: (name) => Math.max(0, level[name] - (SPEC[name].setpoint + margin)),

    // Felt-need disposition line for the mouth — colours HOW the brain engages, like the mood/ToM directives. Silent
    // when content.
    block() { const d = dominant(); return d ? SPEC[d.name].directive : ""; },

    // Attention candidate: a strong unmet need competes for the workspace spotlight (interoception steers attention —
    // when you're very lonely, that need pulls focus). Null when content.
    candidate() {
      const d = dominant();
      if (!d) return null;
      return { source: `drive:${d.name}`, text: SPEC[d.name].need, salience: clamp01(d.pressure * 2.5), tags: d.pressure >= urgentAt ? ["urgent"] : [] };
    },

    serialize() { return { ...level }; },
    restore(s) { if (s) for (const k in SPEC) if (typeof s[k] === "number") level[k] = clamp01(s[k]); },
  };
}
