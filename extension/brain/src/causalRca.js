// causalRca.js — Tier-2 spike PB-22 [G2]: root-cause analysis over a causal DAG without a 2^n blow-up. Each node carries
// a `value` (its observed deviation from baseline) and `deps` (its upstream causes). A node's ULTIMATE contribution is
// its own deviation PLUS a decayed share of its dependents' unexplained deviation flowing back up — so an upstream cause
// accumulates credit for the downstream anomalies it drives, and ranks above the symptoms it merely produced. For the
// brain: model neuromodulator/drive/affect state as this DAG and turn self-report from "these are correlated" into
// "THIS upstream cause best explains the dysregulation" (validate in the disorders lab: inject a known lesion, check RCA
// recovers it). PURE: deterministic; memoized; cycle-safe.

export function rca(nodes = [], { threshold = 0.15, decay = 0.8 } = {}) {   // decay < 1 discounts distance but stays high enough that the ROOT out-scores a high-deviation intermediate it drives
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const dev = (n) => Math.abs(Number(n && n.value) || 0);
  const dependentsOf = (id) => nodes.filter((m) => (m.deps || []).includes(id));

  const memo = new Map();
  function ultimate(id, seen = new Set()) {
    if (memo.has(id)) return memo.get(id);
    if (seen.has(id)) return 0;                         // cycle guard
    const n = byId.get(id); if (!n) return 0;
    const nextSeen = new Set(seen).add(id);
    let up = 0;
    for (const d of dependentsOf(id)) up += decay * ultimate(d.id, nextSeen) / Math.max(1, (d.deps || []).length);
    const score = dev(n) + up;
    if (!seen.size) memo.set(id, score);               // only cache full (root) computations
    return score;
  }

  const ranked = nodes.map((n) => ({ id: n.id, adjacent: +dev(n).toFixed(3), ultimate: +ultimate(n.id).toFixed(3) }))
    .sort((a, b) => b.ultimate - a.ultimate);
  const total = ranked.reduce((s, x) => s + x.ultimate, 0) || 1;
  const rootCauses = ranked.filter((x) => x.ultimate / total >= threshold).map((x) => ({ ...x, share: +(x.ultimate / total).toFixed(3) }));
  return { ranked, rootCauses };
}
