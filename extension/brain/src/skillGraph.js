// skillGraph.js — pure graph reasoning over a list of skill packages.
//
// A skill package is `{ name, grants:[cap], requires:[cap] }`. Skills never name each other
// directly: they publish CAPABILITY strings and consume capability strings. So the dependency
// edges run skill -> capability -> skill, and this module resolves that indirection into a real
// directed graph of skill names.
//
// That indirection is exactly why two failure modes are invisible at a glance and worth computing:
//   - DEAD ENDS: a skill requires a capability that NO package in the set grants. It can never
//     load, no matter what order you try. `unsatisfiable()` names them and says what is missing.
//   - CYCLES: two or more skills each wait on a capability the other provides. Load-time
//     prerequisite enforcement (see src/skills.js) just silently never loads them; `cycles()`
//     surfaces the loop instead.
//
// This module is REASONING ONLY — it does not load, enforce, or mutate anything. It is
// deterministic (no clock, no randomness), total (never throws on malformed input), and
// order-stable (all returned lists are sorted).

const asArray = (v) => (Array.isArray(v) ? v : []);
const asName = (v) => (typeof v === "string" && v.length > 0 ? v : null);
const uniqSorted = (xs) => [...new Set(xs)].sort();

export function makeSkillGraph(packages = []) {
  /** @type {Map<string, {grants:string[], requires:string[]}>} */
  const skills = new Map();
  /** @type {Map<string, string>} cap -> first skill that grants it */
  const providers = new Map();

  for (const pkg of asArray(packages)) {
    if (!pkg || typeof pkg !== "object") continue;
    const name = asName(pkg.name);
    if (!name || skills.has(name)) continue;

    const grants = asArray(pkg.grants).filter(asName);
    const requires = asArray(pkg.requires).filter(asName);
    skills.set(name, { grants, requires });

    for (const cap of grants) if (!providers.has(cap)) providers.set(cap, name);
  }

  const providerOf = (cap) => providers.get(cap) ?? null;

  const prereqSkills = (name) => {
    const s = skills.get(name);
    if (!s) return [];
    const out = [];
    for (const cap of s.requires) {
      const p = providers.get(cap);
      if (p && p !== name) out.push(p);
    }
    return uniqSorted(out);
  };

  const unsatisfiable = () => {
    const out = [];
    for (const [name, s] of skills) {
      const missing = s.requires.filter((cap) => !providers.has(cap));
      if (missing.length) out.push({ name, missing: uniqSorted(missing) });
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  };

  // Iterative DFS with a colour map (0=white, 1=grey/on-stack, 2=black/done).
  // Explicit stack — recursion would blow up on deep graphs.
  const cycles = () => {
    const names = [...skills.keys()].sort();
    const edges = new Map(names.map((n) => [n, prereqSkills(n)]));
    const colour = new Map(names.map((n) => [n, 0]));
    const found = [];
    const seenKeys = new Set();

    for (const root of names) {
      if (colour.get(root) !== 0) continue;
      /** @type {string[]} */
      const path = [];
      /** @type {{node:string, i:number}[]} */
      const stack = [{ node: root, i: 0 }];
      colour.set(root, 1);
      path.push(root);

      while (stack.length) {
        const frame = stack[stack.length - 1];
        const kids = edges.get(frame.node) ?? [];
        if (frame.i < kids.length) {
          const next = kids[frame.i++];
          const c = colour.get(next);
          if (c === 1) {
            const at = path.indexOf(next);
            if (at !== -1) {
              const cyc = path.slice(at);
              const key = uniqSorted(cyc).join("|");
              if (!seenKeys.has(key)) {
                seenKeys.add(key);
                found.push(cyc);
              }
            }
          } else if (c === 0) {
            colour.set(next, 1);
            path.push(next);
            stack.push({ node: next, i: 0 });
          }
        } else {
          colour.set(frame.node, 2);
          stack.pop();
          path.pop();
        }
      }
    }
    return found;
  };

  // ---- acquisition planning -------------------------------------------------
  // The three questions an agent actually asks about its own skill set:
  //   "what can I learn NEXT?"  -> frontier()
  //   "how do I get to X?"      -> planFor()
  //   "was learning X worth it?"-> unlockedBy()

  // Everything whose prerequisites are ALREADY met — the reachable edge of the graph.
  // Skills that would teach nothing new (every cap they grant is already held) are dropped:
  // the frontier is about GAIN, not about re-listing what you are.
  const frontier = (haveCaps = [], opts = {}) => {
    const have = new Set(asArray(haveCaps).filter(asName));
    const skip = new Set(asArray(opts && opts.exclude).filter(asName));
    const out = [];
    for (const [name, s] of skills) {
      if (skip.has(name)) continue;
      if (!s.requires.every((cap) => have.has(cap))) continue;
      if (s.grants.length > 0 && s.grants.every((cap) => have.has(cap))) continue;
      out.push(name);
    }
    return uniqSorted(out);
  };

  // Post-order DFS over cap -> provider -> its required caps. Post-order is what makes the
  // result a valid ACQUISITION ORDER: a skill is emitted only after everything it waits on.
  // Held caps prune whole subtrees. Anything unprovidable is collected rather than thrown —
  // an honest "I cannot get there, and here is precisely what is missing".
  const planFor = (targetCap, haveCaps = []) => {
    const have = new Set(asArray(haveCaps).filter(asName));
    const order = [];
    const emitted = new Set();
    const done = new Set();
    const onStack = new Set();
    const missing = [];
    let cyclic = false;

    // EXPLICIT-STACK post-order DFS — same house rule as cycles(): a skill chain is caller-supplied data, so
    // recursion depth is not ours to bound. Each frame is visited twice: phase 0 pushes the providers of its
    // unmet requirements, phase 1 emits the skill itself — which is what makes the output topological
    // (everything a skill needs is emitted before the skill).
    const visitCap = (cap) => {
      if (have.has(cap)) return true;
      const rootProvider = providers.get(cap);
      if (!rootProvider) { missing.push(cap); return false; }

      let ok = true;
      const stack = [{ name: rootProvider, phase: 0 }];
      while (stack.length > 0) {
        const frame = stack[stack.length - 1];
        const name = frame.name;
        if (frame.phase === 0) {
          if (done.has(name)) { stack.pop(); continue; }
          if (onStack.has(name)) {           // a prerequisite loop — refuse rather than spin
            cyclic = true; ok = false; stack.pop(); continue;
          }
          onStack.add(name);
          frame.phase = 1;
          const s = skills.get(name);
          const reqs = s ? s.requires : [];
          // pushed in reverse so they pop in declaration order — keeps the emitted order stable
          for (let i = reqs.length - 1; i >= 0; i--) {
            const need = reqs[i];
            if (have.has(need)) continue;
            const provider = providers.get(need);
            if (!provider) { missing.push(need); ok = false; continue; }
            stack.push({ name: provider, phase: 0 });
          }
        } else {
          onStack.delete(name);
          done.add(name);
          if (!emitted.has(name)) { emitted.add(name); order.push(name); }
          stack.pop();
        }
      }
      return ok;
    };

    const cap = asName(targetCap);
    const reached = cap !== null && visitCap(cap);
    const ok = reached && !cyclic && missing.length === 0;
    if (ok) return { ok: true, order, missing: [] };
    // Say WHY. "I can't get there" is only half an answer — a caller deciding what to do next needs to know
    // whether the target is merely ungranted (someone could supply it) or structurally circular (nobody ever can).
    const reason = cap === null ? "unknown-capability" : cyclic ? "cycle" : "unreachable";
    return { ok: false, order: [], missing: uniqSorted(missing), reason };
  };

  // Forward closure: everything downstream of this skill's grants. This is the "was it worth it"
  // measure — a skill that unlocks nothing is a leaf, a skill that unlocks many is a keystone.
  const unlockedBy = (name) => {
    const start = skills.get(asName(name));
    if (!start) return [];
    const self = asName(name);
    const reached = new Set();
    let pending = [...start.grants];
    const seenCaps = new Set();

    while (pending.length) {
      const cap = pending.pop();
      if (seenCaps.has(cap)) continue;
      seenCaps.add(cap);
      for (const [other, s] of skills) {
        if (other === self || reached.has(other)) continue;
        if (!s.requires.includes(cap)) continue;
        reached.add(other);
        for (const g of s.grants) pending.push(g);
      }
    }
    return uniqSorted([...reached]);
  };

  return {
    providerOf,
    prereqSkills,
    frontier,
    planFor,
    unlockedBy,
    unsatisfiable,
    cycles,
    skillNames: () => [...skills.keys()].sort(),
    capabilities: () => [...providers.keys()].sort(),
  };
}

export default makeSkillGraph;
