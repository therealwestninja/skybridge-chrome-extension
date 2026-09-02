// attention.js — the thalamus + global workspace. The council (basal ganglia) gates ACTIONS; this gates CONTENTS.
// Each turn the faculties surface competing contents (recalled memories, the read of the user, a standing goal, the
// held focus…); they compete for a capacity-limited "workspace," and only the winners are broadcast into the turn —
// the rest are suppressed. This is Global Workspace Theory (Baars/Dehaene): specialized processors compete for a
// limited broadcast; the winner "speaks." The single highest-weighted content is the FOCUS — what the turn is most
// about — broadcast to the mouth.
//
// Neuromodulation IS the gate (the thalamic part): acetylcholine sharpens attention (multiplies salience so the
// already-relevant pull further ahead = higher signal-to-noise), norepinephrine is urgency (contents tagged urgent/
// threat seize the spotlight when NE is high — the interrupt). Attentional inertia: last turn's focus gets a small
// boost so attention HOLDS rather than thrashing turn to turn.
import { clamp } from "./math.js";
import { DEFAULT_SETPOINTS } from "./neuromodulation.js";

// attention only reads the ACh + NE setpoints, but drawing them from the single source of truth means a retune of the
// channel baselines can't silently desync this gate (a hardcoded copy here would keep the old baseline).
const REST = DEFAULT_SETPOINTS;

export function makeAttention({ capacity = 8, achGain = 1.2, neGain = 1.1, inertia = 0.15, rest = REST } = {}) {
  let lastFocus = null;

  function weigh(c, chem) {
    let w = clamp(Number(c.salience) || 0, 0, 1);
    const tags = c.tags || [];
    if (chem) {
      const ach = chem.acetylcholine ?? rest.acetylcholine, ne = chem.norepinephrine ?? rest.norepinephrine;
      // ACh sharpens SNR: it boosts above-average salience and suppresses below-average (widens the gap), rather than
      // scaling everything uniformly — so elevated acetylcholine makes attention MORE selective. Neutral at rest.
      w *= clamp(1 + achGain * (ach - rest.acetylcholine) * (2 * w - 1), 0.2, 3);
      // NE urgency: urgent/threat-tagged contents seize the spotlight when norepinephrine is high (the interrupt).
      if (tags.includes("urgent") || tags.includes("threat")) w *= clamp(1 + neGain * (ne - rest.norepinephrine), 0.5, 3);
    }
    if (lastFocus && c.source === lastFocus) w *= 1 + inertia;                               // attentional hold
    return w;
  }

  return {
    // Gate competing contents into the capacity-limited workspace. `candidates`: [{source, text, salience, tags?}].
    // Returns the admitted (broadcast) set, the suppressed set, the single focus, and the per-source weights (legible).
    // Stable: ties break by input order. Empty/textless candidates are ignored.
    gate(candidates = [], { chem = null } = {}) {
      const scored = candidates
        .filter((c) => c && c.text)
        .map((c, i) => ({ ...c, _w: weigh(c, chem), _i: i }))
        .sort((a, b) => b._w - a._w || a._i - b._i);
      const admitted = scored.slice(0, Math.max(0, capacity));
      const suppressed = scored.slice(Math.max(0, capacity));
      const focus = admitted.length ? admitted[0] : null;
      lastFocus = focus ? focus.source : lastFocus; // hold the spotlight into next turn (inertia)
      return {
        admitted, suppressed,
        focus: focus ? { source: focus.source, text: focus.text } : null,
        admittedSources: new Set(admitted.map((c) => c.source)),
        weights: Object.fromEntries(scored.map((c) => [c.source, +c._w.toFixed(3)])),
      };
    },
    snapshot() { return { lastFocus }; },
    restore(s) { if (s) lastFocus = s.lastFocus ?? null; },
    focus: () => lastFocus,
  };
}
