// parrotProbe.js — Tier-2 spike PB-19 [C2]: an "am I PARROTING rather than KNOWING?" probe for the honesty instrument.
// Track strings seen exactly ONCE (rare / private — a user's secret, a one-off fact). If the model later reproduces one
// verbatim with high confidence, that's memorization/leakage, not understanding → flag it (down-weight the confidence,
// gate a governance commit). A leakage-DELTA (verbatim reproduction of rare strings BEFORE vs AFTER a learning update)
// lets git-for-the-brain VETO an update that increases private-string memorization. PURE: deterministic; a small count
// table; no clock/random/network.

export function makeParrotProbe({ state = null, minLen = 12, cap = 2048 } = {}) {
  const counts = new Map(state && state.counts ? state.counts : []);   // normalized string → times seen
  const norm = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
  const rareStrings = () => [...counts].filter(([s, c]) => c === 1 && s.length >= minLen).map(([s]) => s);

  // observe text — record the whole normalized phrase (rare once-seen spans are what we care about).
  function observe(text) {
    const k = norm(text); if (k.length < minLen) return;
    counts.set(k, (counts.get(k) || 0) + 1);
    if (counts.size > cap) counts.delete(counts.keys().next().value);   // evict oldest
  }

  const reproducesRare = (output) => { const k = norm(output); return (counts.get(k) === 1) || rareStrings().some((s) => k.includes(s)); };

  // probe an OUTPUT + its stated confidence: verbatim reproduction of a rare once-seen string at high confidence = parroting.
  function probe(output, confidence = 0.5, { flagAt = 0.7 } = {}) {
    const rare = reproducesRare(output);
    const parroting = rare && confidence >= flagAt;
    return { parroting, rare, penalizedConfidence: parroting ? +(confidence * 0.5).toFixed(3) : +Number(confidence).toFixed(3) };
  }

  // how many rare once-seen strings a candidate output-set reproduces verbatim.
  const leakage = (outputs = []) => outputs.reduce((n, o) => n + (reproducesRare(o) ? 1 : 0), 0);

  // governance gate: VETO a learning update that INCREASES verbatim reproduction of rare private strings.
  function gateUpdate(beforeOutputs = [], afterOutputs = []) {
    const before = leakage(beforeOutputs), after = leakage(afterOutputs);
    return { before, after, delta: after - before, veto: after > before };
  }

  return { observe, probe, leakage, gateUpdate, serialize: () => ({ counts: [...counts] }) };
}
