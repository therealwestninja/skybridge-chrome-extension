import { clamp01, relaxToward } from "./math.js";
// A lightweight predictive-coding layer over perception. Maintains a running EXPECTATION of the
// input's affective signature (an exponential moving average); SURPRISE is how far the actual input
// deviates from that expectation. Surprise drives more learning + arousal -- the brain learns most
// from, and is roused by, the unexpected. This is the tractable core of predictive coding: predict,
// measure the error, adapt the prediction -- without a full spiking generative model.

export function makePredictor({ alpha = 0.3, dims = ["valence", "arousal", "reward", "threat"] } = {}) {
  let expected = null;
  return {
    // Surprise in [0,1] for these features; then move the expectation toward them.
    observe(features = {}) {
      if (!expected) { expected = {}; for (const d of dims) expected[d] = features[d] || 0; return 0; }
      let err = 0;
      for (const d of dims) err += Math.abs((features[d] || 0) - expected[d]);
      const surprise = clamp01(err / dims.length);
      for (const d of dims) expected[d] = relaxToward(expected[d], features[d] || 0, alpha);
      return surprise;
    },
    expectation: () => (expected ? { ...expected } : null),
    reset() { expected = null; },
  };
}
