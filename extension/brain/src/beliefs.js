// beliefs.js — Phase 9: modelling the OTHER's mind beyond affect. theoryOfMind reads how the user FEELS; this tracks
// what they THINK — their opinions on topics (so the companion remembers "you love the sea, you can't stand crowds"
// and notices when a view shifts) and their REGARD for the brain (do they seem to find it helpful/trustworthy?),
// which feeds the relationship's trust. Plus CONVERSATIONAL REPAIR: when a turn reads as "you misunderstood me," it
// proposes a repair to the council instead of doubling down.
//
// Opinion mechanics are backported from the town's society.js: a stated view is ABSORBED as a confidence-weighted
// running mean (repetition builds conviction), and confidence DECAYS in absence (so abandoned opinions soften and can
// be re-shaped — no calcified echo chamber). Feed-forward: it informs the prompt + a council candidate, never the
// substrate chemistry.
import { tokenize, STOP_WORDS as STOP } from "./text.js"; // shared stop set (function + evaluative words → never a topic)
import { entities } from "./salience.js";
import { clamp } from "./math.js";
const BELIEF_CUE = /\b(i think|i believe|i feel like|i reckon|in my opinion|i love|i hate|i like|i prefer|can'?t stand|i'?m into|my favou?rite|i adore|i despise|is (the )?(best|worst|great|terrible|amazing|awful|wonderful|horrible))\b/i;
const REPAIR_CUE = /\b(no,? that'?s not|that'?s not what|not what i (meant|said)|you misunderstood|misunderstood me|i meant|that'?s wrong|got it wrong|misread|that'?s not (right|it|what)|you don'?t (get|understand)|you'?re not (getting|listening)|i didn'?t (say|mean))\b/i;

function pickTopic(message) {
  const lower = String(message || "").toLowerCase();
  // The OBJECT of a preference/opinion verb — "I love <mountains>", "into <jazz>", "about <politics>".
  let m = lower.match(/\b(?:love|loved|hate|hated|like|liked|adore|adored|prefer|despise|enjoy|enjoyed|into|about|stand)\s+(?:the|a|an|my|your|this|that|these|those|really|totally|so)?\s*([a-z][a-z']{2,})/);
  if (m && !STOP.has(m[1])) return m[1];
  // The SUBJECT of "<X> is/are [evaluative]".
  m = lower.match(/\b([a-z][a-z']{2,})\s+(?:is|are|was|were)\s+(?:the|so|really|very|quite|just)?\s*(?:best|worst|great|terrible|amazing|awful|wonderful|horrible|good|bad|beautiful|lovely|perfect|useless|brilliant|stupid|the\s+\w+)/);
  if (m && !STOP.has(m[1])) return m[1];
  const ents = entities(message, { limit: 1 });
  if (ents.length) return ents[0].toLowerCase();
  const toks = tokenize(message).filter((t) => t.length >= 4 && !STOP.has(t));
  return toks.length ? toks.sort((a, b) => b.length - a.length)[0] : null; // fallback: the most specific content word
}

export function makeBeliefs({ decayRate = 0.01, dropFloor = 0.05, regardGain = 0.06 } = {}) {
  const op = new Map(); // topic -> { stance, confidence }
  let regard = 0.5;     // the user's apparent regard for the brain (0..1) — feeds relationship trust

  // Confidence-weighted running mean (society.js): repetition builds conviction; stance is the weighted average.
  function absorb(topic, stance) {
    if (!topic) return;
    const cur = op.get(topic) || { stance: 0, confidence: 0 };
    const w = 0.6;
    const denom = cur.confidence + w;
    op.set(topic, { stance: clamp((cur.stance * cur.confidence + stance * w) / denom, -1, 1), confidence: clamp(cur.confidence + w * (1 - cur.confidence), 0, 1) });
  }

  // Is this turn a repair signal ("you misunderstood me")? Detection lives here so mind can propose a repair pre-council.
  const isRepair = (message) => REPAIR_CUE.test(String(message || ""));
  // A council candidate: when the user reads as feeling misunderstood, advocate a repair RESPOND (check understanding,
  // don't double down). Null otherwise.
  function repairCandidate(message) {
    return isRepair(message) ? { by: "repair", action: "RESPOND", conf: 0.72, tags: ["repair", "approach"] } : null;
  }

  // Fold a turn into the user model (post-turn): learn a stated opinion, update regard, decay old convictions.
  function observe({ message = "", valence = 0, reward = 0, threat = 0 } = {}) {
    const topic = pickTopic(message);
    if (topic && (BELIEF_CUE.test(message) || Math.abs(valence) >= 0.45)) absorb(topic, clamp(valence, -1, 1));
    regard = clamp(regard + regardGain * clamp(reward, 0, 1) - 0.09 * clamp(threat, 0, 1), 0, 1);
    for (const [t, o] of op) { o.confidence -= decayRate; if (o.confidence <= dropFloor) op.delete(t); }
    return { topic: topic && (BELIEF_CUE.test(message) || Math.abs(valence) >= 0.45) ? topic : null, regard: +regard.toFixed(3) };
  }

  const opinion = (topic) => op.get(String(topic || "").toLowerCase()) || { stance: 0, confidence: 0 };
  const held = () => [...op.entries()].filter(([, o]) => o.confidence >= 0.25).map(([topic, o]) => ({ topic, stance: +o.stance.toFixed(2), confidence: +o.confidence.toFixed(2) })).sort((a, b) => b.confidence - a.confidence);

  // Common-ground line for the mouth — the strongest thing you know they believe (so the brain speaks to shared history).
  function block() {
    const top = held()[0];
    if (!top) return "";
    const lean = top.stance > 0.2 ? "warmly toward" : top.stance < -0.2 ? "against" : "with mixed feelings about";
    return `You know they lean ${lean} "${top.topic}" — hold that shared ground; don't act like you've never discussed it.`;
  }

  return {
    absorb, observe, opinion, held, isRepair, repairCandidate,
    regard: () => +regard.toFixed(3),
    block,
    snapshot: () => ({ op: [...op.entries()], regard }),
    restore: (s) => { if (s) { op.clear(); (s.op || []).forEach(([t, o]) => op.set(t, o)); regard = clamp(s.regard ?? 0.5, 0, 1); } },
  };
}
