// Sleep-like consolidation (Complementary Learning Systems): during idle, replay salient stored
// episodes with the dopamine gate held open, distilling their affective signatures from the
// declarative store into the associative weights. Ledgered under "sleep" (auditable, undoable,
// fitness-gate-wrappable). Semantic content stays declarative; the substrate learns the regularities.
import { extractFeatures } from "./features.js";
import { makePredictor } from "./predictor.js";
import { generateDreams } from "./dreamGen.js";
import { clamp } from "./math.js";

export function makeConsolidation({ organism, store, ticksPerEpisode = 12, replayReward = 1.0, surpriseWeight = 0, predictor = null }) {
  // How consolidation-worthy an episode is: affective intensity + recency + pinned.
  const salience = (e, maxTs) => {
    const f = extractFeatures(e.text || "");
    const affect = f.reward + f.threat + 0.3 * f.arousal;
    const recency = maxTs ? ((e.timestamp || 0) / maxTs) * 0.3 : 0;
    return affect + recency + (e.pinned ? 0.5 : 0);
  };

  function pick(limit) {
    const eps = store.list({ type: "episode" });
    const maxTs = Math.max(1, ...eps.map((e) => e.timestamp || 0));
    let scored;
    if (surpriseWeight > 0) {
      // PREDICTIVE-CODING WRITE-GATE (ported — algorithm not code — from Cortex predictive_coding_gate.py: store what
      // the model could NOT predict). Reuse the brain's OWN predictor: replay episodes oldest→newest through a fresh
      // running expectation; each episode's SURPRISE (how far it deviated from what the prior episodes led us to expect)
      // boosts its consolidation priority, so sleep distils the NOVEL over the already-predictable. Opt-in (weight>0 →
      // otherwise bit-identical). Affect/recency/pinned still count; surprise is an added, bounded term.
      const pred = predictor || makePredictor();
      const surprise = new Map();
      const chrono = eps.slice().sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
      for (const e of chrono) surprise.set(e, pred.observe(extractFeatures(e.text || "")));
      scored = eps.map((e) => ({ e, s: salience(e, maxTs) + surpriseWeight * (surprise.get(e) || 0) }));
    } else {
      scored = eps.map((e) => ({ e, s: salience(e, maxTs) }));
    }
    return scored
      .sort((a, b) => b.s - a.s)
      .slice(0, limit)
      .map((x) => x.e);
  }

  // Replay the most salient episodes. The reward drive opens the dopamine gate so STDP commits;
  // the episode's own arousal/threat shape which pathways are reinforced.
  function sleep({ limit = 8 } = {}) {
    const episodes = pick(limit);
    for (const ep of episodes) {
      organism.settle(); // each replay starts from rest so episode order doesn't bias the next
      const f = extractFeatures(ep.text || "");
      organism.inject("sensory", clamp(0.5 + 0.4 * f.arousal));
      organism.inject("reward", Math.max(f.reward, replayReward)); // dopamine replay -> gate open
      organism.inject("threat", f.threat);
      for (let t = 0; t < ticksPerEpisode; t++) organism.tick({ tags: ["sleep", "consolidation"] });
      organism.inject("sensory", 0); organism.inject("reward", 0); organism.inject("threat", 0);
    }
    return { replayed: episodes.length };
  }

  // RM6: mistake-replay. Episodes tagged "mistake" (via a thumbs-down) are re-presented in an AVERSIVE
  // context and the recorded bad action is punished (setLastAction + feedback "down"), so consolidation
  // ATTENUATES the pathway that produced a disliked reply -- a Reflexion-style "learn from errors" loop
  // grounded in stored provenance, not transient context. Distinct from sleep()'s reward-replay of salient
  // episodes. Ledgered under "sleep"+"mistake" so the same fitness gate can roll it back if it harms.
  function replayMistakes({ limit = 6 } = {}) {
    const mistakes = store.list({ tag: "mistake" }).slice(-limit);
    for (const ep of mistakes) {
      organism.settle();
      const f = extractFeatures(ep.text || "");
      organism.inject("sensory", clamp(0.5 + 0.4 * f.arousal));
      organism.inject("threat", Math.max(f.threat, 0.5)); // aversive framing
      for (let t = 0; t < ticksPerEpisode; t++) organism.tick({ tags: ["sleep", "mistake"] });
      organism.inject("sensory", 0); organism.inject("threat", 0);
      if (ep.mistakeAction && organism.setLastAction && organism.feedback) { organism.setLastAction(ep.mistakeAction); organism.feedback("down"); }
    }
    return { replayed: mistakes.length };
  }

  // DREAMING (opt-in, additive). Procedurally recombine stored REAL episodes into synthetic "dream" episodes
  // (dreamGen.js) and replay them through the SAME inject/tick machinery as sleep() — rehearsing plausible
  // counterfactuals to pre-shape responses without a real event. Idea transfer from aerox/eventum's procedural
  // generation; reuses consolidation's own replay loop (no code copied).
  //
  // HONESTY INVARIANT: a dream NEVER enters the declarative store as a real fact. It shapes the substrate
  // (weights/ledger) ONLY — we read from `store` but never write to it here — so nothing believable is added to
  // memory. Ledgered under ["sleep","dream","synthetic"] so the same fitness gate can roll it back.
  function dream({ n = 6, seed = 1, now = 0, priorDreams = [] } = {}) {
    const episodes = store.list({ type: "episode" });
    const maxTs = Math.max(1, ...episodes.map((e) => e.timestamp || 0));
    // REUSE the brain's own faculties (injected, keeping dreamGen pure): salience picks what MATTERS to dream about,
    // mood makes it congruent (warm → reward memories; low → threat/unresolved), affect enables emotional processing.
    const m = organism.mood ? organism.mood() : null;
    const moodValence = m && typeof m === "object" ? (Number(m.valence) || 0) : (typeof m === "number" ? m : 0);
    const dreams = generateDreams(episodes, {
      n, seed, priorDreams,
      salienceOf: (e) => salience(e, maxTs),
      moodValence,
      affectOf: (t) => extractFeatures(t),
    });
    for (const d of dreams) {
      organism.settle(); // each dream starts from rest so order doesn't bias the next
      const f = extractFeatures(d.text || "");
      organism.inject("sensory", clamp(0.5 + 0.4 * f.arousal));
      organism.inject("reward", Math.max(f.reward, replayReward)); // dopamine replay -> gate open
      organism.inject("threat", f.threat);
      for (let t = 0; t < ticksPerEpisode; t++) organism.tick({ tags: ["sleep", "dream", "synthetic"] });
      organism.inject("sensory", 0); organism.inject("reward", 0); organism.inject("threat", 0);
    }
    return { dreamed: dreams.length, dreams };
  }

  return { pick, sleep, replayMistakes, dream };
}
