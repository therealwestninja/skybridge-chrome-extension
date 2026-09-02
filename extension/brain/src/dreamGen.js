// Procedural dream generation: recombine REAL stored episodes (and prior dreams) into plausible variants
// ("dreams") to rehearse through the consolidation substrate WITHOUT fabricating new standalone facts.
//
// Idea transfer (algorithm/idea only, NO code copied): aerox/eventum's *procedural generation* — cheaply
// respawn imagined variants from existing material — applied to the brain's consolidation machinery
// (consolidation.js sleep() replays real episodes; here we recombine them and let sleep()'s SAME inject/tick
// loop distil the result).
//
// Dreams that MEAN something (not random word-salad) — all via INJECTED functions so this file stays PURE and
// reuses faculties without importing them:
//   • SALIENT selection — bias sources by `salienceOf` (inject consolidation.salience: affect + recency + pinned).
//   • MOOD-CONGRUENT — a warm mood surfaces reward memories, a low mood surfaces threat/unresolved (`moodValence`).
//   • ASSOCIATIVE recombination — pair episodes that SHARE content words (theme), not random pairs.
//   • EMOTIONAL PROCESSING — an aversive (threat) seed is paired with a comforting (reward) memory (regulation).
//   • COHERENT splicing — cut at clause boundaries, not mid-phrase; carry a short `gist` (impression) for the voice.
//   • CONTINUATION / REVISION — seed from prior dreams (`priorDreams`) to recur/evolve a dream over nights.
//
// HONESTY holds at the generator: every dream is pure RECOMBINATION — its tokens are drawn only from its sources
// (episodes / prior dreams named in `seedFrom`), so it asserts nothing new. PURE + deterministic: same inputs +
// seed → identical dreams. Uses the brain's seeded rng, never Math.random.
import { makeRng } from "./rng.js";
import { words, STOP_WORDS } from "./text.js";

const contentWords = (text) => words(text).filter((w) => w.length > 2 && !STOP_WORDS.has(w));
const clauses = (text) => String(text || "").split(/\s*[,;:.!?]+\s*/).map((s) => s.trim()).filter(Boolean);

// Coherent splice: head clause(s) of A + tail clause(s) of B. Falls back to word-level splice when a text is a
// single clause. Either way, every output token comes from A or B (recombination, not fabrication).
function spliceCoherent(a, b, rng) {
  const ca = clauses(a.text), cb = clauses(b.text);
  if (ca.length >= 2 && cb.length >= 2) {
    const ka = 1 + Math.floor(rng.next() * (ca.length - 1));   // head clauses of A: [0..ka)
    const kb = Math.floor(rng.next() * (cb.length - 1));       // tail clauses of B: [kb..end)
    return [...ca.slice(0, ka), ...cb.slice(kb)].join(", ");
  }
  const wa = words(a.text), wb = words(b.text);
  if (!wa.length) return wb.join(" ");
  if (!wb.length) return wa.join(" ");
  const cutA = 1 + Math.floor(rng.next() * Math.max(1, wa.length - 1));
  const cutB = Math.floor(rng.next() * Math.max(1, wb.length - 1));
  return [...wa.slice(0, cutA), ...wb.slice(cutB)].join(" ");
}

// A short IMPRESSION for the inner voice ("I dreamt of the harbor and a storm") — the first few distinct content
// words, in order. Derived from the dream text, so still pure recombination.
function gistOf(text) {
  const seen = new Set(), keep = [];
  for (const w of contentWords(text)) { if (!seen.has(w)) { seen.add(w); keep.push(w); } if (keep.length >= 4) break; }
  return keep.join(" ");
}

export function generateDreams(episodes, {
  n = 6, seed = 1, priorDreams = [],
  salienceOf = null,   // (ep) => weight ; null ⇒ uniform. Inject consolidation.salience for "dream about what matters".
  moodValence = 0,     // -1..1 ; ≥0 surfaces reward memories, <0 surfaces threat/unresolved (mood-congruent).
  affectOf = null,     // (text) => { reward, threat, ... } ; enables mood-congruence + regulation pairing.
} = {}) {
  const real = (episodes || []).filter((e) => e && (e.text || "").trim().length > 0);
  if (real.length === 0) return [];
  const priors = (priorDreams || []).filter((d) => d && (d.text || "").trim().length > 0);
  const rng = makeRng(seed);
  const idOf = (e, i) => (e.id != null ? e.id : `ep${i}`);

  const affCache = new Map();
  const aff = (e) => { if (!affectOf) return {}; if (!affCache.has(e)) affCache.set(e, affectOf(e.text || "") || {}); return affCache.get(e); };
  // selection weight = salience × mood-congruence
  const weightOf = (e) => {
    let w = salienceOf ? Math.max(0.01, Number(salienceOf(e)) || 0.01) : 1;
    if (affectOf) { const a = aff(e); const congruent = moodValence >= 0 ? (a.reward || 0) : (a.threat || 0); w *= 1 + 0.8 * congruent; }
    return w;
  };
  // seeded weighted pick over `real` → { e, idx }
  const pickW = () => {
    let tot = 0; const ws = real.map((e) => { const w = weightOf(e); tot += w; return w; });
    if (tot <= 0) { const i = Math.floor(rng.next() * real.length); return { e: real[i], idx: i }; }
    let r = rng.next() * tot;
    for (let i = 0; i < real.length; i++) { r -= ws[i]; if (r <= 0) return { e: real[i], idx: i }; }
    return { e: real[real.length - 1], idx: real.length - 1 };
  };
  // ASSOCIATIVE partner ≠ a: prefer the episode sharing the most content words (theme); else a weighted pick.
  const associate = (aIdx, aToks) => {
    let best = -1, bestShare = 0;
    for (let i = 0; i < real.length; i++) { if (i === aIdx) continue; const share = contentWords(real[i].text).filter((w) => aToks.has(w)).length; if (share > bestShare) { bestShare = share; best = i; } }
    if (best >= 0 && rng.next() < 0.8) return { e: real[best], idx: best };
    let p = pickW(); let guard = 0; while (p.idx === aIdx && real.length > 1 && guard++ < 8) p = pickW();
    return p;
  };
  // EMOTIONAL-PROCESSING partner: an aversive (threat) seed → the most comforting (reward) memory. null ⇒ not applicable.
  const comfortFor = (aIdx) => {
    if (!affectOf) return null;
    if ((aff(real[aIdx]).threat || 0) < 0.4) return null;   // only regulate genuinely aversive material
    let best = -1, bestR = 0; for (let i = 0; i < real.length; i++) { if (i === aIdx) continue; const r = aff(real[i]).reward || 0; if (r > bestR) { bestR = r; best = i; } }
    return (best >= 0 && bestR > 0.3) ? { e: real[best], idx: best } : null;
  };

  const uniqSeed = (arr) => [...new Set(arr)];
  const dreams = [];
  for (let i = 0; i < n; i++) {
    // CONTINUATION / REVISION of a prior dream (recur/evolve over nights)
    if (priors.length && rng.next() < 0.4) {
      const p = priors[Math.floor(rng.next() * priors.length)];
      if (real.length && rng.next() < 0.5) {
        const { e, idx } = pickW();
        const text = spliceCoherent(p, e, rng);
        dreams.push({ id: `d${seed}_${i}`, text, gist: gistOf(text), synthetic: true, kind: "continuation", seedFrom: uniqSeed([p.id, idOf(e, idx)]) });
      } else {
        const text = spliceCoherent(p, p, rng);
        dreams.push({ id: `d${seed}_${i}`, text, gist: gistOf(text), synthetic: true, kind: "revision", seedFrom: uniqSeed([p.id]) });
      }
      continue;
    }
    // fresh: SALIENT + MOOD-CONGRUENT seed → REGULATORY or ASSOCIATIVE partner → COHERENT splice
    const A = pickW();
    const reg = comfortFor(A.idx);
    const B = reg || (real.length > 1 ? associate(A.idx, new Set(contentWords(A.e.text))) : { e: A.e, idx: A.idx });
    const text = spliceCoherent(A.e, B.e, rng);
    dreams.push({ id: `d${seed}_${i}`, text, gist: gistOf(text), synthetic: true, kind: reg ? "processing" : "dream", seedFrom: uniqSeed([idOf(A.e, A.idx), idOf(B.e, B.idx)]) });
  }
  return dreams;
}

export default generateDreams;
