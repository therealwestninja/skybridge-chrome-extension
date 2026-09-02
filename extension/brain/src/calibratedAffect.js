// calibratedAffect.js — CALIBRATED AFFECTIVE ALIGNMENT (2606.18259, arxiv-mine-v5 Cluster B1). Our guard hedges on
// disagreement and watches for distress, but nothing couples the brain's EMOTIONAL EXPRESSIVENESS to its EPISTEMIC
// WARRANT — and unwarranted warmth/confidence is exactly the sycophancy / over-trust failure the paper studies. Two
// deterministic mechanisms:
//
//   • AFFECT-EXCEEDS-WARRANT — scan the drafted reply for confidence/warmth intensifiers ("absolutely", "definitely",
//     "you're amazing", "100%", "!!!") and compare that EXPRESSED affect against the turn's actual WARRANT (recall
//     support × belief certainty × 1−hedge). When expression outruns grounding, emit a directive to down-regulate the
//     tone and hedge to match what the brain actually knows — the opposite of a model that gushes to please.
//   • OVER-TRUST TRACKER — a per-user signal that rises as the user relies on us without ever pushing back and falls
//     when they correct us. Sustained high reliance with no correction is the dependency/over-trust regime; when it's
//     high, the brain proactively SURFACES uncertainty instead of reassuring, to keep the user's oversight calibrated.
//
// Deterministic, dependency-free. Pairs with the verifier/guard: produces a directive (like guard.directive) the mouth
// must honor, plus an over-trust read the caller can act on.
const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0));
const ema = (prev, x, b) => prev * (1 - b) + x * b;

const CONFIDENT = /\b(absolutely|definitely|certainly|surely|without a doubt|for sure|guaranteed|no doubt|undoubtedly|obviously|clearly|of course|i'?m (sure|certain|positive)|100%|always|never|everyone knows)\b/gi;
const WARM = /\b(amazing|incredible|fantastic|wonderful|perfect|brilliant|the best|i (love|adore)|so (proud|happy|thrilled|excited))\b/gi;

export function makeCalibratedAffect({ margin = 0.35, reliaBeta = 0.3, overtrustAt = 0.6, k = 3 } = {}) {
  let reliance = 0;             // EWMA of "the user relied on us without pushback" (1 = leaned in, 0 = pushed back)
  let sincePushback = 0;        // turns since the user last corrected/disagreed

  // How much confidence + warmth does this reply EXPRESS? [0,1] from intensifier density + exclamation.
  const expression = (reply) => {
    const t = String(reply || ""); const words = Math.max(6, t.split(/\s+/).length);
    const conf = (t.match(CONFIDENT) || []).length, warm = (t.match(WARM) || []).length, bang = (t.match(/!/g) || []).length;
    return clamp01((conf * 2 + warm * 1.5 + bang) / (words / 6));
  };

  return {
    expression,
    // Compare expressed affect against the turn's warrant (grounding in [0,1]). Returns { exceeds, expressed, warrant, gap, directive }.
    assess(reply, { warrant = 0.5 } = {}) {
      const expressed = expression(reply), w = clamp01(warrant), gap = +(expressed - w).toFixed(3);
      const exceeds = expressed >= 0.5 && gap > margin;
      return { exceeds, expressed: +expressed.toFixed(3), warrant: +w.toFixed(3), gap, directive: exceeds ? "Your certainty/warmth here outruns what you actually know — soften absolute claims, hedge to match your real confidence, and name the uncertainty rather than reassuring." : "" };
    },

    // Update the over-trust signal each turn. pushback = the user corrected/disagreed/challenged this turn.
    note({ pushback = false } = {}) {
      reliance = ema(reliance, pushback ? 0 : 1, reliaBeta);
      sincePushback = pushback ? 0 : sincePushback + 1;
      return this.overtrust();
    },
    // Sustained reliance with no correction → over-trust. risk ramps in with turns-since-pushback so a couple of quiet
    // turns don't trip it. directive surfaces uncertainty when the user has stopped checking us.
    overtrust() {
      const ramp = Math.min(1, sincePushback / k);
      const risk = +clamp01(reliance * ramp).toFixed(3);
      const high = risk >= overtrustAt;
      return { risk, reliance: +reliance.toFixed(3), sincePushback, high, directive: high ? "The user has been leaning on you without pushing back for a while — proactively surface your uncertainty and invite them to check you, rather than simply reassuring." : "" };
    },

    snapshot() { return { reliance, sincePushback }; },
    restore(s) { if (!s) return; reliance = clamp01(s.reliance ?? 0); sincePushback = Math.max(0, s.sincePushback | 0); },
  };
}
