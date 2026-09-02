// eventSegment.js — Tier 2 (2605.31473, "the metastable mind"): a single EVENT-BOUNDARY signal that ties the
// otherwise-parallel memory / working-memory / prediction faculties together. Cognition is a nested hierarchy of
// quasi-stable "events" punctuated by boundaries; a boundary is a moment of high SURPRISE where the current
// generative expectation stops explaining the input. At a boundary the mind turns the page: it flushes working
// memory, resets the predictor's expectation, and stamps memories formed there more strongly (boundary-locked
// encoding). One cheap deterministic signal that INTEGRATES existing organs rather than adding another silo.
//
// Bayesian surprise is approximated offline as the cosine DISTANCE between the turn's content vector and a running
// expectation (an EMA of in-event content) — no model, no network. Two nested levels: a FAST one for content/turn
// shifts and a SLOW one for topic/goal shifts. The threshold is neuromodulator-gated (acetylcholine sharpens →
// finer segmentation) and hysteresis comes from a minimum event length, so we get stable events, not chatter.
import { STOP_WORDS } from "./text.js";
import { clamp01 } from "./math.js";

// A cheap, deterministic content vector: a normalized bag of hashed CONTENT tokens (stopwords + very short tokens
// dropped so "the/a/you" don't make unrelated turns look similar). null when the turn carries no content words.
function contentVec(text, dim) {
  const v = new Array(dim).fill(0);
  const toks = (String(text).toLowerCase().match(/[a-z0-9]+/g) || []).filter((t) => t.length > 2 && !STOP_WORDS.has(t));
  for (const t of toks) { let h = 5381; for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0; v[(h >>> 0) % dim] += 1; }
  let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n);
  if (n === 0) return null;
  return v.map((x) => x / n);
}

// One segmentation level: running expectation (EMA of content), surprise = 1 − cosine, an ACh-gated threshold, and
// a minimum-event-length refractory that both gives hysteresis and prevents every-turn segmentation.
function makeLevel({ dim, alpha, base, minTurns, achGain }) {
  let expectation = null, inCount = 0;
  return {
    observe(vec, { ach = 0.3, achRef = 0.3 } = {}) {
      if (!expectation) { expectation = vec.slice(); inCount = 1; return { boundary: false, surprise: 0, inEvent: 1 }; }
      let dot = 0; for (let i = 0; i < dim; i++) dot += vec[i] * expectation[i];
      const surprise = clamp01(1 - dot);
      const thresh = clamp01(base - achGain * (ach - achRef));       // sharper attention (high ACh) → lower threshold → finer events
      const boundary = surprise > thresh && inCount >= minTurns;      // refractory: no boundary until the event is minTurns long
      if (boundary) { expectation = vec.slice(); inCount = 1; }
      else {
        for (let i = 0; i < dim; i++) expectation[i] = (1 - alpha) * expectation[i] + alpha * vec[i];
        let n = 0; for (const x of expectation) n += x * x; n = Math.sqrt(n) || 1; for (let i = 0; i < dim; i++) expectation[i] /= n;
        inCount++;
      }
      return { boundary, surprise: +surprise.toFixed(3), inEvent: inCount };
    },
    snapshot: () => ({ expectation: expectation ? expectation.slice() : null, inCount }),
    restore: (s) => { if (s) { expectation = Array.isArray(s.expectation) ? s.expectation.slice() : null; inCount = s.inCount || 0; } },
  };
}

export function makeEventSegment({ dim = 64, neRef = 0.3,
  fast = { alpha: 0.4, base: 0.66, minTurns: 2, achGain: 0.4 },   // content/turn shifts
  slow = { alpha: 0.15, base: 0.75, minTurns: 4, achGain: 0.3 },  // topic/goal shifts
} = {}) {
  const content = makeLevel({ dim, ...fast });
  const topic = makeLevel({ dim, ...slow });

  return {
    // Fold this turn's content in and read the boundary. `chem` supplies acetylcholine (threshold gate) and
    // norepinephrine (boundary encoding boost). Returns { boundary, level, surprise, topicSurprise, encodingBoost }.
    observe({ text = "", chem = {} } = {}) {
      const vec = contentVec(text, dim);
      if (!vec) return { boundary: false, level: null, surprise: 0, topicSurprise: 0, encodingBoost: 0 }; // contentless turn — no signal
      const ach = chem.acetylcholine ?? 0.3, ne = chem.norepinephrine ?? 0.3;
      const c = content.observe(vec, { ach });
      const t = topic.observe(vec, { ach });
      const boundary = c.boundary || t.boundary;
      // A memory formed AT a boundary is stamped harder — norepinephrine (novelty/arousal) sets how much.
      const encodingBoost = boundary ? +clamp01(ne - neRef).toFixed(3) : 0;
      return { boundary, level: t.boundary ? "topic" : c.boundary ? "content" : null, surprise: c.surprise, topicSurprise: t.surprise, encodingBoost };
    },
    snapshot: () => ({ content: content.snapshot(), topic: topic.snapshot() }),
    restore: (s) => { if (s) { content.restore(s.content); topic.restore(s.topic); } },
  };
}
