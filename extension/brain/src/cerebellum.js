import { clamp } from "./math.js";
// cerebellum.js — a forward model of the brain's OWN actions; the action-side twin of predictor.js (which models
// perception). Anatomy: the basal ganglia (council.js) SELECTS one action from the competing candidates; the
// cerebellum takes an efference copy of that selected act and predicts its SENSORY CONSEQUENCE (how it will land),
// compares that prediction to the realized outcome, and uses the error to (a) SMOOTH / pre-correct the act's vigour
// before it commits and (b) refine the internal model. Where `predictor` asks "is this INPUT what I expected?", the
// cerebellum asks "will THIS ACT land the way I expect — and should I temper it?".
//
// The internal models are CONTEXT-SPECIFIC (as real cerebellar micro-zones are): keyed by (intent, action), the same
// key the procedural-habit store uses. Distinct from procedural: procedural learns WHICH act to run in a context (the
// habit); the cerebellum predicts the OUTCOME of the chosen act and pre-corrects its confidence. Pure EMA, no network
// — the tractable core of a cerebellar forward model, matching predictor.js's style.


export function makeCerebellum({ alpha = 0.25, gain = 0.3, noveltyFloor = 3 } = {}) {
  // per-(intent|action) forward model: an EMA of the realized reward signal + a visit count `n` (how much evidence
  // backs the model — a young model predicts nothing, so it can't yet steer).
  const model = new Map();
  const key = (intent, action) => `${intent || "?"}|${action || "?"}`;
  const cell = (k) => { let c = model.get(k); if (!c) { c = { expected: 0, n: 0 }; model.set(k, c); } return c; };

  return {
    // Efference copy → forward model: how is this (intent, action) expected to land? `expected` in [-1,1] (reward−threat
    // space); `confidence` in [0,1] = how much data backs the estimate (saturates as evidence accrues); `novel` flags an
    // under-sampled act the model can't vouch for yet.
    predict({ intent, action } = {}) {
      const c = model.get(key(intent, action));
      const n = c ? c.n : 0;
      return { expected: c ? c.expected : 0, confidence: clamp(n / (n + noveltyFloor), 0, 1), novel: n < noveltyFloor };
    },

    // Online correction: temper the committed act by the forward model's forecast, weighted by the model's OWN
    // reliability. A well-backed forecast that the act lands POORLY damps confidence (hesitation / a lighter touch); a
    // forecast that it lands WELL lifts it. An untrained model (confidence 0) → zero adjustment, so early turns and any
    // caller that hasn't accumulated evidence are unaffected.
    smooth({ confidence = 0.5, forecast } = {}) {
      if (!forecast || !forecast.confidence) return { confidence, adjust: 0 };
      const adjust = gain * forecast.expected * forecast.confidence;
      return { confidence: clamp(confidence * (1 + adjust), 0, 1), adjust: +adjust.toFixed(3) };
    },

    // Compare the prediction to the realized outcome and correct the model — the cerebellar error (teaching) signal.
    // `reward` is the realized signal (reward − threat) credited to the act just delivered. Returns the prediction
    // error = actual − predicted.
    record({ intent, action, reward = 0 } = {}) {
      const c = cell(key(intent, action));
      const error = reward - c.expected;
      c.expected = clamp(c.expected + alpha * error, -1, 1);
      c.n += 1;
      return { error: +error.toFixed(3), expected: +c.expected.toFixed(3), n: c.n };
    },

    snapshot() { return { model: Array.from(model.entries()).map(([k, v]) => [k, { expected: v.expected, n: v.n }]) }; },
    restore(s) { if (s && Array.isArray(s.model)) { model.clear(); for (const [k, v] of s.model) model.set(k, { expected: v.expected || 0, n: v.n || 0 }); } },
    size: () => model.size,
  };
}
