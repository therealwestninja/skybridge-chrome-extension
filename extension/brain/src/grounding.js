// grounding.js — ACTION GROUNDING: feasibility from the world + the body's real capabilities, not from the instruction
// (GroundAct 2508.05614, arxiv-mine-v6 Cluster I). Our council/verifier gate on instruction + safety but SILENTLY ASSUME
// the act is physically possible. This module supplies the missing precondition, on three axes, plus the two cheap wins:
//
//   • I1 3-AXIS FEASIBILITY (ground):
//       (a) attribute-compare — resolve a superlative target ("the heaviest / nearest / hottest") by arg-max over a
//           continuous property, NOT a predicate lookup.
//       (b) capability-gap — the act needs an ability the body lacks → veto (or a hint to acquire a tool).
//       (c) capacity-boundary — payload/effort exceeds the body's limit → emit a COLLABORATION-REQUEST instead of
//           retrying. (This is literally the swarm trigger: hand the shortfall to kinship.delegate.)
//   • I2 DYNAMIC TOOL→CAPABILITY BINDING — holding a tool UNIONS its provided abilities into what the body can do;
//       releasing retracts them. Capability becomes state-dependent, and (wired to kinship) the body's own beacon
//       changes to advertise what it can now do.
//   • I3 OBSERVABILITY MODE — more world-state helps a SEARCH but HURTS a feasibility/collaboration decision (irrelevant
//       props obscure whether help is needed); a one-flag filtered surface of the state.
//   • I4 PER-AXIS DIAGNOSTICS — never blend one competence number; tally pass/fail PER AXIS so an inverted profile
//       (great at attributes, blind to capacity) isn't masked by an aggregate.
//
// Deterministic, dependency-free. Reusable by any body; the Go2 decider grounds each motor intent, a text brain can
// ground a proposed action, and the capacity axis feeds straight into the kinship swarm.

// Named superlatives → (property, direction). Extend freely; unknown names fall through to null (caller passes {key,dir}).
const SUPERLATIVE = {
  heaviest: ["mass", "max"], lightest: ["mass", "min"], nearest: ["distance", "min"], closest: ["distance", "min"],
  farthest: ["distance", "max"], hottest: ["temp", "max"], coldest: ["temp", "min"], biggest: ["size", "max"],
  largest: ["size", "max"], smallest: ["size", "min"], strongest: ["signal", "max"], loudest: ["volume", "max"], quietest: ["volume", "min"],
};

export function makeGrounding({ capabilities = [], capacities = {}, tools = {} } = {}) {
  const base = new Set(capabilities);          // the body's innate abilities
  const held = new Map();                       // toolName → { provides:[caps], capacities:{cap:limit} }
  let mode = "search";                          // I3 observability mode: "search" (expand) | "constraint" (filter)
  const diag = { attribute: { pass: 0, fail: 0 }, capability: { pass: 0, fail: 0 }, capacity: { pass: 0, fail: 0 } };
  const tally = (axis, ok) => { diag[axis][ok ? "pass" : "fail"]++; };

  const capsNow = () => { const s = new Set(base); for (const t of held.values()) for (const c of t.provides || []) s.add(c); return s; };
  const capacityFor = (cap) => { let v = capacities[cap] ?? 0; for (const t of held.values()) if (t.capacities && t.capacities[cap] != null) v = Math.max(v, t.capacities[cap]); return v; };

  // Attribute arg-max/min (I1a). attr = a superlative string, or { key, dir:"max"|"min" }. Returns the winning candidate.
  const resolve = (attr, candidates = []) => {
    let key, dir;
    if (typeof attr === "string") { const m = SUPERLATIVE[attr.toLowerCase()]; if (!m) return null; [key, dir] = m; }
    else if (attr && attr.key) { key = attr.key; dir = attr.dir === "min" ? "min" : "max"; }
    else return null;
    const valid = candidates.filter((c) => c && typeof c[key] === "number");
    if (!valid.length) return null;
    return valid.reduce((best, c) => ((dir === "max" ? c[key] > best[key] : c[key] < best[key]) ? c : best));
  };

  return {
    // I2 — bind / unbind a tool's abilities.
    hold(toolName) { const t = tools[toolName]; if (!t) return null; held.set(toolName, t); return this.capabilities(); },
    release(toolName) { held.delete(toolName); return this.capabilities(); },
    holding: () => [...held.keys()],
    can: (cap) => capsNow().has(cap),
    capacityFor,
    capabilities: () => [...capsNow()],          // current abilities (feed to kinship.setCapabilities for beacon sync)

    resolve,

    // I1 — the 3-axis feasibility precondition. action = { needs:[caps], target:{attr, among:[...]}, effort:{cap, amount} }.
    // Returns { feasible, axis?, reason?, missingCapability?, collaboration?, resolvedTarget? }. Order: capability → capacity → attribute.
    ground(action = {}) {
      const { needs = [], target = null, effort = null } = action;
      for (const c of needs) if (!capsNow().has(c)) { tally("capability", false); return { feasible: false, axis: "capability", missingCapability: c, reason: `body lacks capability: ${c}` }; }
      if (needs.length) tally("capability", true);
      if (effort && effort.cap != null && effort.amount != null) {
        const limit = capacityFor(effort.cap);
        if (effort.amount > limit) { tally("capacity", false); return { feasible: false, axis: "capacity", collaboration: { capability: effort.cap, amount: effort.amount, shortfall: +(effort.amount - limit).toFixed(3) }, reason: `${effort.cap} ${effort.amount} exceeds capacity ${limit} — request collaboration` }; }
        tally("capacity", true);
      }
      let resolvedTarget = null;
      if (target && target.attr != null && Array.isArray(target.among)) {
        resolvedTarget = resolve(target.attr, target.among);
        if (!resolvedTarget) { tally("attribute", false); return { feasible: false, axis: "attribute", reason: "could not resolve the target attribute over the candidates" }; }
        tally("attribute", true);
      }
      return { feasible: true, resolvedTarget };
    },

    // I3 — surface world-state per the current mode. "search" returns items whole; "constraint" projects to only the
    // constraint-relevant keys, so a feasibility/collaboration decision isn't drowned in task-irrelevant props.
    setObservability(m) { mode = m === "constraint" ? "constraint" : "search"; return mode; },
    observability: () => mode,
    surface(items = [], constraintKeys = []) {
      if (mode === "search" || !constraintKeys.length) return items;
      return items.map((it) => { const o = {}; for (const k of constraintKeys) if (k in it) o[k] = it[k]; return o; });
    },

    // I4 — per-axis diagnostics (never one blended number).
    diagnostics: () => ({ attribute: { ...diag.attribute }, capability: { ...diag.capability }, capacity: { ...diag.capacity } }),

    snapshot() { return { held: [...held.keys()], mode, diag: JSON.parse(JSON.stringify(diag)) }; },
    restore(s) { if (!s) return; held.clear(); for (const n of s.held || []) if (tools[n]) held.set(n, tools[n]); mode = s.mode || "search"; if (s.diag) Object.assign(diag, s.diag); },
  };
}
