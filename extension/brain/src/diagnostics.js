// diagnostics.js — cheap, deterministic, offline SELF-INSTRUMENTS for the substrate and memory. Mined from
// the 2026-07-06 sweep (roadmap v3, Tier 1): four questions the fitness-gated STDP ledger can't answer on its
// own — is the memory code geometrically STABLE (interference-resistant), are the learned WEIGHTS doing real
// work (or is topology carrying everything), does new learning CLOBBER old memories, and is a channel
// HABITUATING or SENSITIZING to a repeated stimulus. Every metric is a pure function over plain data (matrices
// / vectors / trajectories) so it is trivially unit-testable and seed-free; thin drivers at the bottom pull the
// data off a live organism/app. Surfaced through vitals/explain and the disorders lab.

// ── shared math (no deps) ───────────────────────────────────────────────────────────────────────────────
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const ma = mean(a.slice(0, n)), mb = mean(b.slice(0, n));
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  const den = Math.sqrt(da * db);
  return den < 1e-12 ? 0 : num / den;
}
// Spearman = Pearson over rank-transformed values (average ranks for ties).
function ranks(xs) {
  const idx = xs.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]);
  const r = new Array(xs.length);
  for (let i = 0; i < idx.length;) {
    let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;               // 1-based average rank across the tie block
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
    i = j + 1;
  }
  return r;
}
const spearman = (a, b) => pearson(ranks(a), ranks(b));
// A tiny seeded PRNG (mulberry32) so the null-test's shuffle is reproducible without importing rng.js.
function seeded(seed = 1) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// ── 1 · SPLIT-HALF RDM STABILITY ("Shesha", 2605.17199) ─────────────────────────────────────────────────
// A rigid, interference-resistant memory code should represent the SAME relationships between stored cues no
// matter which random half of the neurons you read it from. Build a representational-dissimilarity matrix
// (pairwise 1−correlation between cue population-vectors) from each of two disjoint neuron halves, then
// Spearman-correlate the two RDMs' upper triangles. ~1 = crystalline/stable; ~0 = "mist" (the geometry is
// noise). Catches memory-geometry degradation BEFORE recall accuracy visibly collapses.
export function rdmStability(responses, { seed = 1 } = {}) {
  const m = responses.length;
  const n = m ? responses[0].length : 0;
  if (m < 3 || n < 4) return { stability: null, cues: m, neurons: n, note: "need ≥3 cues and ≥4 neurons" };
  // Deterministic random split of neuron indices into two halves.
  const rnd = seeded(seed);
  const order = [...Array(n).keys()].sort(() => rnd() - 0.5);
  const half = Math.floor(n / 2);
  const H1 = order.slice(0, half), H2 = order.slice(half, 2 * half);
  const rdm = (cols) => {
    const flat = [];
    for (let i = 0; i < m; i++) for (let j = i + 1; j < m; j++) {
      const vi = cols.map((c) => responses[i][c]), vj = cols.map((c) => responses[j][c]);
      flat.push(1 - pearson(vi, vj));          // correlation distance
    }
    return flat;
  };
  const stability = spearman(rdm(H1), rdm(H2));
  return { stability: +stability.toFixed(4), cues: m, neurons: n, band: stability > 0.6 ? "crystalline" : stability > 0.3 ? "structured" : "mist" };
}

// ── 2 · WEIGHT GEOMETRY: effective memory depth + GFM null-test (2606.25826) ─────────────────────────────
// Does the LEARNED weight geometry carry functional structure, or is the topology doing all the work? Propagate
// a unit influence vector along the (signed, weight-scaled) edges; the discounted decay curve of its magnitude
// has a center-of-mass = "effective memory depth" (how deep influence persists). Then the GFM null-test:
// shuffle the weights across the SAME edges and recompute — a large drop (real ≫ shuffled) means the weights
// encode real long-range structure; ~0 means the region has degenerated to topology-only (learning is inert).
function buildAdj(graph) {
  const { n, edges } = graph;
  const out = Array.from({ length: n }, () => []);       // source -> [[target, weight], ...]
  let maxAbsColSum = 0; const colSum = new Array(n).fill(0);
  for (const [s, t, w] of edges) { if (s < n && t < n) { out[s].push([t, w]); colSum[t] += Math.abs(w); } }
  for (const c of colSum) if (c > maxAbsColSum) maxAbsColSum = c;
  return { out, scale: maxAbsColSum || 1 };
}
export function effectiveMemoryDepth(graph, { beta = 0.15, maxDepth = 40 } = {}) {
  const { n, edges } = graph;
  if (!n || !edges.length) return 0;
  const { out, scale } = buildAdj(graph);
  let infl = new Array(n).fill(1);                        // unit influence everywhere
  let num = 0, den = 0;
  for (let k = 0; k <= maxDepth; k++) {
    let norm = 0; for (const x of infl) norm += x * x; norm = Math.sqrt(norm);
    const m = Math.exp(-beta * k) * norm;                 // discounted magnitude at depth k
    num += k * m; den += m;
    if (m < 1e-9 && k > 2) break;
    const next = new Array(n).fill(0);                    // propagate one step: influence flows source→target
    for (let s = 0; s < n; s++) { const is = infl[s]; if (is === 0) continue; for (const [t, w] of out[s]) next[t] += (w / scale) * is; }
    infl = next;
  }
  return den < 1e-12 ? 0 : +(num / den).toFixed(4);       // center-of-mass depth of the influence-decay curve
}
export function gfmNullTest(graph, { seed = 1, shuffles = 8, beta = 0.15, maxDepth = 40 } = {}) {
  const real = effectiveMemoryDepth(graph, { beta, maxDepth });
  const rnd = seeded(seed);
  const weights = graph.edges.map((e) => e[2]);
  const shuffledDepths = [];
  for (let r = 0; r < shuffles; r++) {
    const w = weights.slice();
    for (let i = w.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [w[i], w[j]] = [w[j], w[i]]; } // Fisher-Yates
    const edges = graph.edges.map((e, i) => [e[0], e[1], w[i]]);   // same topology, permuted weights
    shuffledDepths.push(effectiveMemoryDepth({ n: graph.n, edges }, { beta, maxDepth }));
  }
  const shuffled = +mean(shuffledDepths).toFixed(4);
  const drop = +(real - shuffled).toFixed(4);
  return { real, shuffled, drop, ratio: shuffled > 1e-9 ? +(real / shuffled).toFixed(3) : null, functional: drop > 0.15 * Math.max(real, 1e-6) };
}

// ── 3 · STAGED MEMORY-INTEGRITY (2606.12449) ────────────────────────────────────────────────────────────
// Recall accuracy alone is shortcut-prone. Score a learn→interfere→cue run on three axes: RETENTION (did the
// first memory survive learning a later one), INTERFERENCE-RESISTANCE (how little the interfering memory
// degraded it), and STAGE-STRUCTURE (did the idle "rest" stay quiet instead of spuriously firing). Pure scorer
// over observations the driver collects; the driver `runStagedIntegrity` is below.
export function scoreStagedIntegrity({ recallBefore = 0, recallAfter = 0, interfererRecall = 0, restActivity = 0 } = {}) {
  const retention = recallBefore > 1e-6 ? clamp01(recallAfter / recallBefore) : (recallAfter > 0 ? 1 : 0);
  const interferenceResistance = clamp01(1 - Math.max(0, recallBefore - recallAfter));  // absolute drop, floored
  const stageStructure = clamp01(1 - restActivity);                                     // rest should be quiet
  const learnedBoth = clamp01(Math.min(recallAfter, interfererRecall) / Math.max(recallBefore, interfererRecall, 1e-6));
  const overall = +(0.4 * retention + 0.3 * interferenceResistance + 0.2 * stageStructure + 0.1 * learnedBoth).toFixed(4);
  return { retention: +retention.toFixed(4), interferenceResistance: +interferenceResistance.toFixed(4), stageStructure: +stageStructure.toFixed(4), overall, band: overall > 0.75 ? "robust" : overall > 0.5 ? "lossy" : "catastrophic-interference" };
}

// ── 4 · RECOVERY-TIME HABITUATION / SENSITIZATION (2605.30109) ───────────────────────────────────────────
// A repeated identical stimulus should, depending on the channel's decay/coupling, produce a SHRINKING
// (habituation) or GROWING (sensitization) response — with no dedicated "habituation memory", just the
// decaying-scalar dynamics. recoveryTime: steps for a post-pulse trajectory to return within `tol` of baseline.
// classifyAdaptation: the slope of the per-pulse response magnitude across successive identical pulses.
export function recoveryTime(trajectory, { baseline = null, tol = 0.05 } = {}) {
  if (!trajectory || trajectory.length < 2) return { steps: null, peak: 0 };
  const base = baseline == null ? trajectory[trajectory.length - 1] : baseline;
  let peak = 0, peakIdx = 0;
  for (let i = 0; i < trajectory.length; i++) { const d = Math.abs(trajectory[i] - base); if (d > peak) { peak = d; peakIdx = i; } }
  let steps = null;
  for (let i = peakIdx; i < trajectory.length; i++) { if (Math.abs(trajectory[i] - base) <= tol * Math.max(1, Math.abs(peak))) { steps = i - peakIdx; break; } }
  return { steps, peak: +peak.toFixed(4) };
}
export function classifyAdaptation(responseMagnitudes, { eps = 0.02 } = {}) {
  const y = responseMagnitudes.filter((v) => typeof v === "number");
  if (y.length < 3) return { verdict: "insufficient", slope: 0 };
  const x = y.map((_, i) => i);
  const mx = mean(x), my = mean(y);
  let num = 0, den = 0; for (let i = 0; i < y.length; i++) { num += (x[i] - mx) * (y[i] - my); den += (x[i] - mx) ** 2; }
  const slope = den < 1e-12 ? 0 : num / den;
  const norm = my > 1e-9 ? slope / my : slope;           // per-pulse fractional change
  return { verdict: norm < -eps ? "habituation" : norm > eps ? "sensitization" : "stable", slope: +slope.toFixed(4), perPulseFraction: +norm.toFixed(4) };
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// ── E/I balance + connectome stats — the readouts for the chronic-stress lesion (T1.1, 2606.27529) ────────
// Mean firing of the excitatory vs inhibitory populations from a dense population vector. A falling excMean
// (and falling exc/inh ratio) after strengthening I→E is the chronic-stress signature: excitatory hypofunction
// under inhibitory dominance.
export function eiBalance(popVector, excSet, inhSet) {
  let eSum = 0, eN = 0, iSum = 0, iN = 0;
  for (let id = 0; id < popVector.length; id++) {
    if (excSet.has(id)) { eSum += popVector[id]; eN++; } else if (inhSet.has(id)) { iSum += popVector[id]; iN++; }
  }
  const excMean = eN ? eSum / eN : 0, inhMean = iN ? iSum / iN : 0;
  return { excMean: +excMean.toFixed(4), inhMean: +inhMean.toFixed(4), ratio: +(excMean / (inhMean + 1e-6)).toFixed(4) };
}

// Graph-level structure stats over the weight graph — density, active-edge density, reciprocity, mean |weight|.
// The resilience/rigidity trade-off (train UNDER stress) predicts density + reciprocity SHED; these expose it.
export function connectomeStats(graph, { threshold = 0.5 } = {}) {
  const { n, edges } = graph;
  const key = (a, b) => a * n + b;
  const present = new Set(); let active = 0, absSum = 0;
  for (const [s, t, w] of edges) { present.add(key(s, t)); absSum += Math.abs(w); if (Math.abs(w) >= threshold) active++; }
  let recip = 0; for (const [s, t] of edges) if (present.has(key(t, s))) recip++;
  const E = Math.max(1, edges.length);
  return { n, edges: edges.length, density: +(edges.length / Math.max(1, n * (n - 1))).toFixed(5), activeDensity: +(active / E).toFixed(4), reciprocity: +(recip / E).toFixed(4), meanAbsWeight: +(absSum / E).toFixed(4) };
}

// The chronic-stress cascade, measured NON-DESTRUCTIVELY: probe the E/I balance + weight geometry, apply the
// S[W_IE] lesion, re-probe, restore. Returns the before/after signature so the disorders lab / vitals can show
// "what chronic stress would do to me" without permanently damaging the substrate.
export function chronicStressSignature(organism, { delta = 0.5, ticks = 14, seed = 1 } = {}) {
  const cls = organism.neuronClasses();
  const excSet = new Set(cls.excitatory), inhSet = new Set(cls.inhibitory);
  const probe = () => {
    organism.settle();
    organism.inject("sensory", 0.7); organism.inject("memory", 0.4);
    for (let t = 0; t < ticks; t++) organism.tick({ noLearn: true });
    const b = eiBalance(organism.populationVector(), excSet, inhSet);
    organism.settle();
    return b;
  };
  const st = organism.serialize({ ledger: false });
  try {
    const before = probe();
    const wgBefore = effectiveMemoryDepth(organism.weightGraph(), {});
    const lesion = organism.lesionIE(delta);
    const after = probe();
    const wgAfter = effectiveMemoryDepth(organism.weightGraph(), {});
    const excHypofunction = +(before.excMean - after.excMean).toFixed(4);
    const inhibitoryDominance = +(before.ratio - after.ratio).toFixed(4);
    return {
      delta, lesion,
      excFiring: { before: before.excMean, after: after.excMean }, excHypofunction,   // >0 = excitatory firing fell
      eiRatio: { before: before.ratio, after: after.ratio }, inhibitoryDominance,       // secondary: exc/inh firing ratio shift (less robust than excHypofunction — inhibitory drive can fall too)
      weightDepth: { before: wgBefore, after: wgAfter },
      // The robust, load-bearing signature is EXCITATORY HYPOFUNCTION — strengthening inhibition onto excitatory
      // cells reliably lowers their firing. The exc/inh ratio is reported but not gated on (it wobbles by warmup).
      signature: excHypofunction > 0 ? "chronic-stress (excitatory hypofunction under strengthened I→E)" : "atypical",
    };
  } finally { organism.deserialize(st); organism.settle(); }
}

// ── DRIVERS — pull the data off a live organism/app (kept thin; the metrics above are the tested core) ────

// Collect population responses to a set of cues, then measure RDM stability. `inject(organism, cue)` applies a
// cue; we tick a few times, read the dense population vector, and settle between cues so they don't bleed.
export function substrateRdmStability(organism, cues, { inject, ticks = 12, seed = 1 } = {}) {
  const responses = [];
  for (const cue of cues) {
    organism.settle();
    (inject || ((o, c) => o.inject("sensory", typeof c === "number" ? c : 0.6)))(organism, cue);
    for (let t = 0; t < ticks; t++) organism.tick({ noLearn: true });
    responses.push(organism.populationVector());
    organism.settle();
  }
  return rdmStability(responses, { seed });
}

// Weight-geometry + GFM null-test straight off the substrate's synapse graph.
export function substrateWeightGeometry(organism, opts = {}) {
  return gfmNullTest(organism.weightGraph(), opts);
}

// Pulse a neuromodulator channel repeatedly and classify habituation/sensitization from the response curve.
export function chemRecoveryProbe(organism, chem = "dopamine", { pulses = 5, mag = 1, ticks = 20, tol = 0.05 } = {}) {
  organism.settle();
  const baseline = organism.chemLevel(chem);
  const peaks = [], recoveries = [];
  for (let p = 0; p < pulses; p++) {
    organism.nudgeChem(chem, mag);
    const traj = [];
    for (let t = 0; t < ticks; t++) { organism.tick({ noLearn: true }); traj.push(organism.chemLevel(chem)); }
    const r = recoveryTime(traj, { baseline, tol });
    peaks.push(r.peak); recoveries.push(r.steps);
    for (let t = 0; t < ticks; t++) organism.tick({ noLearn: true });   // let it fully settle before the next pulse
  }
  return { baseline: +baseline.toFixed(4), peaks, recoveries, ...classifyAdaptation(peaks) };
}

// Staged learn→interfere→cue integrity over the app's declarative memory. `recall(text)` returns a 0..1
// similarity of the best match for a probe; supplied by the caller so this stays store-agnostic.
export async function runStagedIntegrity(app, { A = "the sky over Odessa was violet that evening", C = "the number forty-two is written on the blue door", recall } = {}) {
  const sim = recall || (async (q) => { const hits = await app._internals().store.recall(q, 3); return hits && hits[0] ? (hits[0]._sim ?? 0) : 0; });
  // Self-cleaning: this is a PROBE, not real experience — track the ids it writes and remove them after so the
  // diagnostic never pollutes the live store.
  const added = [];
  const learn = async (t) => { const r = await app.addFact(t); if (r && r.id != null) added.push(r.id); };
  try {
    await learn(A);
    const recallBefore = await sim(A);
    const restActivityMid = await sim("an unrelated neutral probe about nothing in particular");
    await learn(C);
    const interfererRecall = await sim(C);
    const recallAfter = await sim(A);
    return scoreStagedIntegrity({ recallBefore, recallAfter, interfererRecall, restActivity: restActivityMid });
  } finally {
    for (const id of added) { try { await app.removeMemory(id); } catch (_) {} }
  }
}
