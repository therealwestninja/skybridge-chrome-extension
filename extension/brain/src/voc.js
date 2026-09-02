// voc.js — VALUE-OF-COMPUTATION gate (cognitive economy, 2606.19136, arxiv-mine-v5 Cluster B4). Our expensive faculties
// (deep recall + MMR re-ranking, forward simulation, the distiller's consolidation pass, imagination) run per-turn
// regardless of whether the turn warrants them. A resource-rational agent spends effort only while its MARGINAL VALUE
// exceeds its MARGINAL COST — think hard only when it pays. This gate makes that explicit:
//
//   value  = uncertainty × stakes      (the expected decision improvement from computing harder)
//   worth  = value ≥ cost × sensitivity
//
// So an expensive faculty (high cost) only fires when BOTH the outcome is genuinely uncertain AND the stakes are high;
// a cheap faculty clears the bar more easily; a trivial, confident turn skips the deliberation and takes the cheap
// default. A rolling spend tracker exposes how much compute was spent vs saved. Deterministic, dependency-free; faculties
// (or the host) call worth() before running, and the brain attaches a per-turn advisory read to the trace.
const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0));

// Relative cost of each expensive faculty in [0,1]. Callers may override per-call via ctx.cost.
export const FACULTY_COST = {
  recall: 0.25, mmr: 0.4, forwardSim: 0.55, imagination: 0.7, distiller: 0.8, deliberate: 0.5, planner: 0.6,
};

export function makeVoC({ sensitivity = 1, costs = FACULTY_COST } = {}) {
  let spent = 0, saved = 0, calls = 0;

  return {
    costOf: (faculty) => costs[faculty] ?? 0.3,

    // Is it worth running `faculty` this turn? ctx: { uncertainty, stakes, cost? }. Returns
    // { run, value, cost, margin, reason }. Also accrues the spend/save tally for telemetry.
    worth(faculty, { uncertainty = 0.5, stakes = 0.5, cost = null } = {}) {
      const c = cost != null ? clamp01(cost) : (costs[faculty] ?? 0.3);
      const value = clamp01(uncertainty) * clamp01(stakes);
      const bar = c * sensitivity;
      const run = value >= bar;
      calls += 1; if (run) spent += c; else saved += c;
      return { run, value: +value.toFixed(3), cost: +c.toFixed(3), margin: +(value - bar).toFixed(3), reason: run ? "value clears the cost bar — compute" : "value below the cost bar — take the cheap default" };
    },

    // Advisory read for a whole set of faculties given the turn's uncertainty + stakes (does NOT accrue spend).
    plan(faculties, { uncertainty = 0.5, stakes = 0.5 } = {}) {
      const value = clamp01(uncertainty) * clamp01(stakes);
      const out = {};
      for (const f of faculties) { const c = costs[f] ?? 0.3; out[f] = value >= c * sensitivity; }
      return { value: +value.toFixed(3), run: out };
    },

    stats: () => ({ calls, spent: +spent.toFixed(2), saved: +saved.toFixed(2), efficiency: calls ? +(saved / (spent + saved || 1)).toFixed(3) : 0 }),
    snapshot() { return { spent, saved, calls }; },
    restore(s) { if (!s) return; spent = s.spent || 0; saved = s.saved || 0; calls = s.calls | 0; },
  };
}
