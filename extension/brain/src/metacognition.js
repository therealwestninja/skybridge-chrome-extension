// Metacognition (Personhood P4): a self-model of Rook's own knowing. Each turn it reads the brain's
// own signals -- did a fact hit, how relevant is recall, how decisive was the choice, how surprised
// was it -- into an explicit epistemic state: where an answer would come FROM (basis), whether it's
// actually grounded (known), a calibrated certainty, and whether it's confused. This is what lets Rook
// be honest about the limits of what it knows instead of confabulating, and notice its own confusion.
// Distinct from the `clarify` path (which resolves ambiguous ROUTING, not content certainty).
import { clamp } from "./math.js";

export function makeMetacognition({ groundThreshold = 0.2, certaintyFloor = 0.35, confuseSurprise = 0.6, confuseConfidence = 0.1, ema = 0.2 } = {}) {
  let avgCertainty = null, confusion = 0, turns = 0;

  // Per-turn epistemic self-model from signals already computed in the turn.
  function assess({ intent = "respond", factHit = false, relevance = 0, confidence = 0, surprise = 0 } = {}) {
    const isKnowledgeQ = intent === "question";
    const basis = factHit ? "fact"
      : relevance >= groundThreshold ? "memory"
      : isKnowledgeQ ? "none" : "social";
    const known = basis !== "none";
    // How well an answer is grounded, how decisive the choice was, discounted by surprise.
    const groundScore = basis === "fact" ? 1 : basis === "memory" ? clamp(0.5 + relevance) : basis === "social" ? 0.7 : 0.12;
    const decisiveness = clamp(confidence * 2.5);
    const certainty = clamp(0.5 * groundScore + 0.3 * decisiveness + 0.2 * (1 - clamp(surprise)));
    const confused = surprise >= confuseSurprise && confidence < confuseConfidence;
    // Own the uncertainty: a knowledge question with no grounding and low certainty.
    const hedge = isKnowledgeQ && basis === "none" && certainty < certaintyFloor;
    return { certainty: +certainty.toFixed(2), known, confused, basis, hedge };
  }

  // Running self-monitor: how sure Rook has been lately, and how often confused.
  function observe(a) {
    turns += 1;
    avgCertainty = avgCertainty == null ? a.certainty : avgCertainty + (a.certainty - avgCertainty) * ema;
    confusion += ((a.confused ? 1 : 0) - confusion) * ema;
    return state();
  }
  function state() {
    return { avgCertainty: avgCertainty == null ? null : +avgCertainty.toFixed(2), confusionRate: +confusion.toFixed(2), turns };
  }

  return { assess, observe, state };
}
