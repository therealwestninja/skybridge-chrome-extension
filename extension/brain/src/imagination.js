// Imagination / forward simulation (Personhood P7): deliberate mental rehearsal of a hypothetical.
// Consolidation replays the PAST and predictive coding anticipates the NEXT input, but nothing
// simulates a FUTURE on purpose. This runs the substrate forward on a hypothetical input WITHOUT
// committing -- snapshot -> simulate -> restore -- so Rook can preview "what would I do / feel if X"
// with zero side effects (no learning, no chemistry drift, no persistence leak). The offline
// counterpart to actually responding.
import { extractFeatures } from "./features.js";
import { clamp } from "./math.js";

export function makeImagination({ organism, ticks = 20 } = {}) {
  return {
    // Rehearse a hypothetical message; return the predicted action + affect, leaving the brain exactly
    // as it was (weights, chemistry, ledger, clock all restored).
    simulate(message) {
      const saved = organism.serialize({ ledger: false }); // no ledger deep-copy; rehearsal doesn't learn
      organism.settle();
      const f = extractFeatures(message);
      organism.inject("sensory", clamp(0.5 + 0.4 * f.arousal));
      organism.inject("reward", f.reward);
      organism.inject("threat", f.threat);
      for (let t = 0; t < ticks; t++) organism.tick({ tags: ["imagine"], noLearn: true }); // no weight/ledger side effects
      organism.inject("sensory", 0); organism.inject("reward", 0); organism.inject("threat", 0);
      const routed = organism.readAction();
      const mood = organism.mood();
      organism.deserialize(saved);   // revert everything the rehearsal touched
      organism.settle();
      return {
        action: routed.action,
        confidence: +Number(routed.confidence || 0).toFixed(2),
        mood: { valence: +(mood.valence || 0).toFixed(2), arousal: +(mood.arousal || 0).toFixed(2) },
      };
    },
  };
}
