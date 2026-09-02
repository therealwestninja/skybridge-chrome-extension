// engagement.js — ENGAGEMENT AS A CONTROLLABLE STATE (2606.18189, arxiv-mine-v5 Cluster B3). Our proactivity fires on
// an open-loop silence timer + drive pressure — it doesn't actually MODEL how engaged the user is, nor budget how much
// it may intrude. This treats engagement as a estimated scalar STATE held at a target by a closed-loop controller:
//
//   • observe(signals) updates a running engagement estimate from what the turn revealed — message length, whether they
//     asked a question, their affect, response latency, terseness. Rich, curious, warm turns raise it; short, slow, flat
//     turns let it decay.
//   • control() is a target-tracking controller: when the estimate drifts BELOW the target band it recommends a light
//     re-engagement — but only while a WORKLOAD BUDGET remains, so the brain never nags. When engagement is ON target it
//     holds; when it's ABOVE, it deliberately gives the user space. The budget replenishes slowly over quiet turns.
//
// This is the difference between "it's been 8 hours, reach out" and "they've gone quiet and flat for a few turns and I
// have budget to spare — offer one genuine hook back in." Deterministic, dependency-free; pairs with proactivity (an
// additional, smarter reach-out signal) and exposes the live estimate for the trace.
const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0));
const ema = (prev, x, b) => prev * (1 - b) + x * b;

export function makeEngagement({ target = 0.6, deadband = 0.12, beta = 0.3, budgetMax = 3, replenishEvery = 4, fullLen = 40 } = {}) {
  let level = target;          // engagement estimate [0,1], starts at target (no evidence yet)
  let budget = budgetMax;      // remaining re-engagement "workload" budget
  let sinceReplenish = 0;

  return {
    level: () => +level.toFixed(3),
    budget: () => budget,

    // Fold one turn's signals into the estimate. valence is [-1,1]; latencyMs is time since our last message (null = unknown).
    observe({ messageLength = 0, askedQuestion = false, valence = 0, latencyMs = null, terse = false } = {}) {
      const lenSig = clamp01(messageLength / fullLen);
      const aff = clamp01(0.5 + valence * 0.5);
      const lat = latencyMs == null ? 0.5 : clamp01(1 - latencyMs / 60000);   // replies within ~a minute read as engaged
      const inst = clamp01(lenSig * 0.4 + aff * 0.3 + lat * 0.2 + (askedQuestion ? 0.2 : 0) - (terse ? 0.15 : 0));
      level = ema(level, inst, beta);
      // a quiet turn ticks the budget back up slowly
      if (++sinceReplenish >= replenishEvery) { budget = Math.min(budgetMax, budget + 1); sinceReplenish = 0; }
      return +level.toFixed(3);
    },

    // The controller. Returns { act, reason, level, deficit, directive }. act=true recommends a light re-engagement AND
    // spends one unit of budget; it fires only when engagement is below target AND budget remains.
    control() {
      const below = level < target - deadband;
      const above = level > target + deadband;
      if (below && budget > 0) {
        budget -= 1;
        return { act: true, reason: "engagement below target", level: +level.toFixed(3), deficit: +(target - level).toFixed(3), directive: "Their engagement has drifted — offer ONE light, genuine hook back into the conversation (a small question or a warm observation). Keep it brief; do not pile on." };
      }
      if (below) return { act: false, reason: "below target but workload budget spent", level: +level.toFixed(3), deficit: +(target - level).toFixed(3), directive: "" };
      return { act: false, reason: above ? "engagement high — give them space" : "engagement on target", level: +level.toFixed(3), deficit: 0, directive: "" };
    },

    snapshot() { return { level, budget, sinceReplenish }; },
    restore(s) { if (!s) return; level = clamp01(s.level ?? target); budget = Math.max(0, Math.min(budgetMax, s.budget ?? budgetMax)); sinceReplenish = Math.max(0, s.sinceReplenish | 0); },
  };
}
