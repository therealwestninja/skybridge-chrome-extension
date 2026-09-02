// Chemistry test harness: systematically sweep the four neuromodulator SETPOINTS (dopamine,
// norepinephrine, serotonin, acetylcholine) -- individually, in pairs, triples, and the full quad --
// stepping each min..max, to characterize WHAT each chemical does, WHERE the effects saturate / go
// inert / fail, and how they interact. This is the measurement layer for making the chemistry actually
// matter (Path A). Pure substrate (no LLM); deterministic at noiseStd 0.
import { makeOrganism } from "./organism.js";
import { DEFAULT_SETPOINTS } from "./neuromodulation.js";

export const CHEMS = ["dopamine", "norepinephrine", "serotonin", "acetylcholine"];
export const DEFAULTS = { ...DEFAULT_SETPOINTS };
const SMALL = { sensory: 30, memory: 20, association: 60, salience: 30, decision: 30 };
const r3 = (x) => +Number(x).toFixed(3);

// Build an organism at the given setpoints, run a fixed stimulus battery, and return the behavioural
// signals the chemistry is supposed to move: rest mood, excitability (spikes to a standard drive), the
// action it selects, and mood under reward / threat.
export function probeChem(setpoints = {}, { seed = 5, noiseStd = 0, ticks = 30, sizes = SMALL } = {}) {
  // Pass the setpoints as the constructed personality so the chem LEVELS START at the setpoints
  // (setTrait would keep the old levels, making a setpoint sweep read as inert/inverted).
  const org = makeOrganism({ seed, sizes, noiseStd, personality: { setpoints: { ...DEFAULTS, ...setpoints } } });

  org.settle();
  const rest = org.mood();

  // Excitability + action to a standard sensory drive.
  org.settle();
  org.inject("sensory", 0.6);
  let spikes = 0;
  for (let t = 0; t < ticks; t++) spikes += org.tick({ noLearn: true }).length;
  org.inject("sensory", 0);
  const routed = org.readAction();

  const moodUnder = (channel, value) => {
    org.settle();
    org.inject("sensory", 0.4);
    org.inject(channel, value);
    for (let t = 0; t < 20; t++) org.tick({ noLearn: true });
    const m = org.mood();
    org.inject(channel, 0); org.inject("sensory", 0);
    return m;
  };
  const rewardMood = moodUnder("reward", 0.9);
  const threatMood = moodUnder("threat", 0.9);

  return {
    restV: r3(rest.valence), restA: r3(rest.arousal),
    spikes, action: routed.action, conf: r3(routed.confidence || 0),
    rewardV: r3(rewardMood.valence), threatA: r3(threatMood.arousal),
  };
}

// Cartesian product of level arrays for a set of chem names.
function grid(names, levels) {
  let combos = [[]];
  for (let i = 0; i < names.length; i++) {
    const next = [];
    for (const c of combos) for (const L of levels) next.push([...c, L]);
    combos = next;
  }
  return combos.map((vals) => Object.fromEntries(names.map((n, i) => [n, vals[i]])));
}
const kCombos = (arr, k) => k === 0 ? [[]] : arr.flatMap((v, i) => kCombos(arr.slice(i + 1), k - 1).map((c) => [v, ...c]));

// Sweep every k-subset of the chems over `levels` (others held at default). Returns
// [{ chems:[...], setpoints, metrics }]. k=1 singles, 2 pairs, 3 triples, 4 quad.
export function sweep(k, { levels = [0, 0.25, 0.5, 0.75, 1], probeOpts = {} } = {}) {
  const out = [];
  for (const names of kCombos(CHEMS, k)) {
    for (const sp of grid(names, levels)) {
      out.push({ chems: names, setpoints: sp, metrics: probeChem(sp, probeOpts) });
    }
  }
  return out;
}

// Per-single analysis: for each chem, how much does each output signal MOVE across its 0..1 sweep, is it
// monotonic, and is it saturated/inert? Flags the failure modes.
export function analyzeSingles(levels = [0, 0.25, 0.5, 0.75, 1], probeOpts = {}) {
  const report = {};
  for (const chem of CHEMS) {
    const rows = levels.map((L) => ({ L, m: probeChem({ [chem]: L }, probeOpts) }));
    const col = (f) => rows.map((r) => r.m[f]);
    const range = (a) => +(Math.max(...a) - Math.min(...a)).toFixed(3);
    const monotonic = (a) => a.every((v, i) => i === 0 || v >= a[i - 1]) || a.every((v, i) => i === 0 || v <= a[i - 1]);
    const actions = new Set(col("action"));
    const flags = [];
    if (range(col("restV")) < 0.05 && Math.abs(col("restV")[Math.floor(rows.length / 2)]) > 0.85) flags.push("valence SATURATED (pinned, barely moves)");
    if (range(col("spikes")) === 0) flags.push("excitability INERT (no spike effect)");
    if (col("spikes").some((s) => s === 0) && col("spikes").some((s) => s > 0)) flags.push("excitability can go DEAD (0 spikes at some level)");
    if (actions.size === 1) flags.push(`routing INERT (always ${[...actions][0]})`);
    report[chem] = {
      rows: rows.map((r) => ({ L: r.L, ...r.m })),
      moves: { restV: range(col("restV")), restA: range(col("restA")), spikes: range(col("spikes")), rewardV: range(col("rewardV")), threatA: range(col("threatA")), conf: range(col("conf")) },
      monotonic: { restV: monotonic(col("restV")), spikes: monotonic(col("spikes")) },
      actions: [...actions],
      flags,
    };
  }
  return report;
}

// Roll a sweep up into failure-mode counts + notable extremes, for the pair/triple/quad tiers.
export function summarize(results) {
  let saturatedV = 0, deadSpikes = 0, quiet = 0, runaway = 0;
  const spikesAll = results.map((r) => r.metrics.spikes);
  const cap = Math.max(50, 3 * (spikesAll.reduce((a, b) => a + b, 0) / spikesAll.length));
  for (const r of results) {
    const m = r.metrics;
    if (Math.abs(m.restV) > 0.95) saturatedV++;
    if (m.spikes === 0) deadSpikes++;
    if (m.action === "QUIET") quiet++;
    if (m.spikes > cap) runaway++;
  }
  const n = results.length;
  const actions = {};
  for (const r of results) actions[r.metrics.action] = (actions[r.metrics.action] || 0) + 1;
  return { configs: n, valenceSaturated: `${saturatedV}/${n}`, spikesDead: `${deadSpikes}/${n}`, quiet: `${quiet}/${n}`, runaway: `${runaway}/${n}`, actionMix: actions };
}
