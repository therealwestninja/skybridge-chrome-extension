// scheduler.js — PB-3: run the per-tick organ loop as a READY-TASK DAG (topological pull), not a fixed serial order —
// so one slow or blocked ganglion can't stall the others (head-of-line blocking). Each wave runs every node whose deps
// have completed, concurrently; a node that throws/times-out fails and only ITS dependents are skipped — independent
// ready nodes still complete this tick. The plan is a STATIC artifact the governance layer can audit/veto before it runs
// (governance-edges). Plus `makeSafeApply`: a disruptive mutation (config/rule/skill/pack change) waits for a
// `safeBoundary()` to go true (not mid-deliberation / mid-maneuver), bounces to the proposer on timeout, and ONLY a
// safety-critical change overrides — graduated, never an instant force.
// PURE: deterministic; `run(node, depResults)` and `safeBoundary`/`now` are injected.

// topologically order a DAG + report validity (missing dep or cycle → ok:false). nodes: [{ id, deps:[ids] }]
export function planDAG(nodes = []) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const order = [], seen = new Set(), temp = new Set();
  let ok = true;
  const visit = (n) => {
    if (seen.has(n.id)) return;
    if (temp.has(n.id)) { ok = false; return; }           // back-edge → cycle
    temp.add(n.id);
    for (const d of n.deps || []) { const dn = byId.get(d); if (dn) visit(dn); else ok = false; }   // missing dep
    temp.delete(n.id); seen.add(n.id); order.push(n.id);
  };
  for (const n of nodes) visit(n);
  return { order, ok };
}

// run the DAG by ready-wave pull. Returns { done:{id→result}, failed:[id], stuck:[id] }.
// A node whose run() rejects (e.g. an injected per-node timeout) is `failed`; its dependents are skipped; unrelated
// ready nodes in the same wave run CONCURRENTLY and complete — that's the no-head-of-line-blocking guarantee.
export async function runReady(nodes = [], run) {
  const done = new Map(), failed = new Set();
  let remaining = nodes.slice();
  while (remaining.length) {
    const ready = remaining.filter((n) => (n.deps || []).every((d) => done.has(d) || failed.has(d)));
    if (!ready.length) break;                              // the rest have unmet deps (cycle/missing) → stuck
    remaining = remaining.filter((n) => !ready.includes(n));
    await Promise.all(ready.map(async (n) => {
      const deps = n.deps || [];
      if (deps.some((d) => failed.has(d))) { failed.add(n.id); return; }   // a dead dependency skips the dependent
      try { done.set(n.id, await run(n, deps.map((d) => done.get(d)))); }
      catch { failed.add(n.id); }
    }));
  }
  return { done: Object.fromEntries(done), failed: [...failed], stuck: remaining.map((n) => n.id) };
}

// apply disruptive mutations only at a safe boundary; bounce on timeout; safety-critical overrides immediately.
export function makeSafeApply({ safeBoundary = () => true } = {}) {
  const q = [];   // { id, apply, queuedAt, deadline }
  function submit(id, apply, { critical = false, now = 0, ttl = Infinity } = {}) {
    if (typeof apply !== "function") return { error: "apply-required" };
    if (critical) { apply(); return { id, applied: true, critical: true }; }   // safety-critical never waits
    q.push({ id, apply, queuedAt: now, deadline: ttl === Infinity ? Infinity : now + ttl });
    return { id, queued: true };
  }
  // call each tick with the current time; applies everything if we're at a safe boundary, else bounces the expired.
  function pump(now = 0) {
    const applied = [], bounced = [];
    const safe = !!safeBoundary();
    for (let i = q.length - 1; i >= 0; i--) {
      const m = q[i];
      if (safe) { q.splice(i, 1); try { m.apply(); applied.push(m.id); } catch { bounced.push(m.id); } }
      else if (now > m.deadline) { q.splice(i, 1); bounced.push(m.id); }   // waited past its window → back to the proposer
    }
    return { applied, bounced, pending: q.length };
  }
  return { submit, pump, pending: () => q.map((m) => m.id) };
}
