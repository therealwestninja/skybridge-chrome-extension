// theoryOfMind.js — a LIVE, inferred model of the OTHER (the user): how they seem to feel, their stance TOWARD this
// brain, how engaged they are, and what they appear to need — updated every turn. This is the faculty that turns
// "remembers facts about you" into "tracks where your head is at right now."
//
// Deliberately distinct from three things it is easy to confuse it with:
//   • the organism's own mood()  — that's how *I* feel; this is a model of how *they* feel (empathy = representing the
//     other's state as SEPARATE from your own).
//   • profile.js                 — that's a STATIC, user-authored character sheet; this is INFERRED and dynamic.
//   • predictor.js               — that predicts *input* affect for surprise; this predicts the *person* and is
//     surprised by social shifts (they turn cold, they warm up).
//
// Load-bearing outputs: (1) block() — a concise attunement line the mouth uses to meet the user where they are;
// (2) propose() — a caring RESPOND candidate for the council (basal ganglia) when the user reads as needing support,
// so "respond to their state" becomes a vote in action selection, not just prompt text. Pure EMA, no network.
import { clamp, clamp01, ema } from "./math.js";


// What the user appears to want this turn, from their intent + affect + stance toward us. Coarse and honest — a small
// set of needs a companion can actually act on, not a psychological taxonomy.
function inferNeed(intent, valence, stance) {
  if (stance < -0.35) return "conflict";                                             // cold/hostile toward me
  if (valence < -0.25) return ["question", "task", "code", "ground"].includes(intent) ? "help" : "comfort";
  if (["question", "task", "code", "ground"].includes(intent)) return "information";
  if (["greet", "ack", "chitchat"].includes(intent)) return "company";
  if (valence > 0.35) return "connection";                                           // sharing something good
  return "presence";                                                                  // default: just being together
}

const NEED_PHRASE = {
  comfort: "comfort and reassurance", venting: "to be heard", help: "help working through a problem",
  information: "a clear, direct answer", company: "light, easy company", connection: "to share something good with you",
  conflict: "they seem frustrated with you — tread carefully and don't get defensive", presence: "mostly just your presence",
};
const stanceWord = (s) => (s > 0.35 ? "warm" : s > 0.12 ? "at ease" : s < -0.35 ? "cold" : s < -0.12 ? "guarded" : "neutral");
const affectWord = (v, a) => `${v > 0.3 ? "upbeat" : v < -0.3 ? "low" : "even"}${a > 0.6 ? ", keyed-up" : a < 0.3 ? ", subdued" : ""}`;

export function makeTheoryOfMind({ alpha = 0.3, stanceAlpha = 0.25, floor = 3, blockFloor = 0.34, proposeFloor = 0.45, driftBeta = 0.3, driftThreshold = 0.45 } = {}) {
  let valence = 0, arousal = 0.4, stance = 0, engagement = 0.5, acuteV = 0; // acuteV = this-turn valence (fast channel)
  let driftEwma = 0, resyncs = 0; // sustained-misprediction signal + how often the model has been re-anchored
  const needScores = new Map();
  let need = "presence";
  let n = 0;
  let expV = 0, expS = 0, certainty = 0; // expectation of the user (for social surprise) + model confidence

  const argmaxNeed = () => { let best = "presence", m = -Infinity; for (const [k, v] of needScores) if (v > m) { m = v; best = k; } return best; };

  function read({ features = {}, intent = "", message = "" } = {}) {
    const v = Number(features.valence) || 0;
    const social = clamp((Number(features.reward) || 0) - (Number(features.threat) || 0), -1, 1); // warmth toward me, proxied by reward−threat
    const words = String(message).trim().split(/\s+/).filter(Boolean).length;
    const turnEng = clamp01(words / 25 + (intent === "question" ? 0.15 : 0)); // substance + curiosity = investment

    // Social surprise: how far this turn's (valence, stance) reading deviates from what the model expected. A sharp
    // shift (they suddenly turn cold, or brighten) is the ToM analogue of predictive-coding surprise, and it
    // transiently lowers the model's confidence — I misread them, so I trust the model less this turn.
    const surprise = n === 0 ? 0 : clamp01((Math.abs(v - expV) + Math.abs(social - expS)) / 2);

    valence = ema(valence, v, alpha);
    arousal = ema(arousal, Number(features.arousal) || 0, alpha);
    stance = ema(stance, social, stanceAlpha);
    engagement = ema(engagement, turnEng, alpha);
    acuteV = v;

    // Need reads the FAST channel too: acute distress (a single "i feel terrible" turn) should register as a need for
    // comfort NOW, not wait for the slow mood EMA to catch up — grief is salient immediately. Stance/mood stay smoothed
    // (a relationship shifts gradually); only the need responds to the sharpest of (sustained, acute) distress.
    const turnNeed = inferNeed(intent, Math.min(valence, acuteV), stance);
    for (const k of needScores.keys()) needScores.set(k, needScores.get(k) * 0.7); // decay, so a one-off need doesn't flip the dominant read
    needScores.set(turnNeed, (needScores.get(turnNeed) || 0) + 1);
    need = argmaxNeed();

    expV += 0.3 * (v - expV); expS += 0.3 * (social - expS);
    n += 1;
    certainty = clamp01((n / (n + floor)) * (1 - 0.5 * surprise));
    // Drift-resync (mined 2605.24662): a SMOOTHED misprediction signal. One surprising turn is noise (the EWMA absorbs
    // it — "hold on abrupt spikes"), but SUSTAINED surprise means the model of the user has gone stale, so hard-RESYNC:
    // re-anchor expectations on the present and drop confidence, letting the model re-derive fast instead of clinging
    // to a wrong prior. Graduated: track (EWMA) → resync (sustained) — the paper's exact discipline.
    driftEwma = ema(driftEwma, surprise, driftBeta);
    let resynced = false;
    if (driftEwma > driftThreshold && n > floor) { expV = v; expS = social; certainty = clamp01(certainty * 0.4); driftEwma = 0; resyncs += 1; resynced = true; }
    return { ...snapshot(), surprise: +surprise.toFixed(2), drift: +driftEwma.toFixed(2), resynced };
  }

  function snapshot() {
    return { valence: +valence.toFixed(2), arousal: +arousal.toFixed(2), stance: +stance.toFixed(2), engagement: +engagement.toFixed(2), need, certainty: +certainty.toFixed(2) };
  }

  return {
    read, snapshot,
    getNeed: () => need,
    getStance: () => +stance.toFixed(2),

    // Attunement block for the mouth — a read of the person so the reply meets their state. Silent until the model has
    // enough evidence to be worth trusting (early turns don't inject a low-confidence guess). Framed as inference the
    // model should ATTUNE to, never narrate back at the user.
    block() {
      if (certainty < blockFloor) return "";
      return `Read of the person you're talking with (your inference — may be wrong): they seem ${affectWord(Math.min(valence, acuteV), arousal)} and ${stanceWord(stance)} toward you, and appear to want ${NEED_PHRASE[need] || "your presence"}. Let this shape HOW you meet them — attune to it, don't state it back to them.`;
    },

    // Council candidate: when the user reads as needing support (and the model is confident enough), advocate a caring
    // RESPOND — tagged approach+protect so it draws on both engagement and protective chemistry. Returns null otherwise,
    // so a fresh or neutral read adds NO proposal and the council is unchanged (default suite stays green).
    propose() {
      if (certainty < proposeFloor) return null;
      const distress = Math.min(valence, acuteV); // acute OR sustained low mood advocates for care
      const care = (need === "comfort" || need === "venting") && distress < -0.15;
      if (!care) return null;
      const conf = clamp(0.4 + 0.3 * certainty + 0.3 * Math.min(1, -distress), 0, 0.75);
      return { by: "tom", action: "RESPOND", conf: +conf.toFixed(3), tags: ["approach", "protect"] };
    },

    serialize() {
      return { valence, arousal, stance, engagement, acuteV, need, n, expV, expS, certainty, driftEwma, resyncs, needScores: Array.from(needScores.entries()) };
    },
    restore(s) {
      if (!s) return;
      valence = s.valence || 0; arousal = s.arousal ?? 0.4; stance = s.stance || 0; engagement = s.engagement ?? 0.5; acuteV = s.acuteV || 0;
      need = s.need || "presence"; n = s.n || 0; expV = s.expV || 0; expS = s.expS || 0; certainty = s.certainty || 0; driftEwma = s.driftEwma || 0; resyncs = s.resyncs || 0;
      needScores.clear(); if (Array.isArray(s.needScores)) for (const [k, v] of s.needScores) needScores.set(k, v);
    },
  };
}
