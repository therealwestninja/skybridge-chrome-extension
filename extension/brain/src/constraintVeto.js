// constraintVeto.js — s(CASP)-style CONSTRAINT VETO with a backward-chain PROOF TREE (2606.23866, arxiv-mine-v5 Cluster
// A9). Our verifier scores a reply and the decider logs pass/fail — but neither can SHOW its reasoning as a structured
// derivation. Goal-directed constraint solving does two things a scalar gate can't:
//
//   • It FORBIDS unsafe worlds structurally (a constraint PRUNES — it is not a soft penalty that a high enough utility
//     can outweigh). If a denial constraint fires, the action is impossible, full stop.
//   • It justifies the verdict with a BACKWARD-CHAIN PROOF TREE: to authorize an action we try to prove `safe`, which
//     decomposes into requirement sub-goals (each provable directly or via sub-requirements). The returned tree shows
//     exactly which constraint denied it, or which precondition sub-goal failed — a far richer audit than "rejected: not
//     armed". A supervisor can read the proof, not just the outcome.
//
// Deterministic, dependency-free. A constraint = { name, when(action,state)->bool, because }. A requirement =
// { name, holds?(action,state)->bool, via?:[subReqNames], because, becauseFail }. Reusable; the Go2 decider attaches a
// proof tree to its audit, and the governor can gate on a structural denial.
const tryBool = (fn) => { try { return !!fn(); } catch { return false; } };

export function makeConstraintVeto({ constraints = [], requirements = [] } = {}) {
  const byName = new Map(requirements.map((r) => [r.name, r]));
  const referenced = new Set(requirements.flatMap((r) => r.via || []));
  const roots = requirements.filter((r) => !referenced.has(r.name));   // top-level goals (not a sub-goal of another)

  // Backward-chain a requirement into a proof node { goal, held, because, children }.
  const prove = (req, a, s, seen) => {
    if (!req) return { goal: "?", held: false, because: "unknown requirement", children: [] };
    if (seen.has(req.name)) return { goal: req.name, held: false, because: "cyclic requirement", children: [] };
    seen.add(req.name);
    if (Array.isArray(req.via) && req.via.length) {
      const children = req.via.map((n) => prove(byName.get(n), a, s, seen));
      const held = children.every((c) => c.held);
      return { goal: req.name, held, because: held ? (req.because || "all sub-goals hold") : (req.becauseFail || "a sub-goal failed"), children };
    }
    const held = typeof req.holds === "function" ? tryBool(() => req.holds(a, s)) : false;
    return { goal: req.name, held, because: held ? (req.because || "holds") : (req.becauseFail || `${req.name} not satisfied`), children: [] };
  };

  return {
    // Try to prove `safe(action)`. Returns { verdict:"permit"|"veto", reason, proof }.
    authorize(action = {}, state = {}) {
      // (1) Forbidding constraints prune unsafe worlds — a fired constraint makes the action impossible.
      for (const c of constraints) {
        if (tryBool(() => c.when(action, state))) {
          return { verdict: "veto", reason: c.name, proof: { goal: "safe", verdict: "veto", denial: { constraint: c.name, because: c.because || `${c.name} forbids this` }, requirements: [] } };
        }
      }
      // (2) Backward-chain the positive requirements into a proof tree.
      const seen = new Set();
      const tree = roots.map((r) => prove(r, action, state, seen));
      const held = tree.every((t) => t.held);
      const failed = tree.filter((t) => !t.held).map((t) => t.goal);
      return { verdict: held ? "permit" : "veto", reason: held ? "safe" : "unmet-precondition:" + failed.join(","), proof: { goal: "safe", verdict: held ? "permit" : "veto", denial: null, requirements: tree } };
    },

    // Render a proof tree to a readable, indented audit string.
    explain(proof) {
      if (!proof) return "";
      const line = (n, d) => `${"  ".repeat(d)}${n.held ? "✓" : "✗"} ${n.goal} — ${n.because}` + (n.children || []).map((c) => "\n" + line(c, d + 1)).join("");
      if (proof.denial) return `✗ ${proof.goal}: DENIED by [${proof.denial.constraint}] — ${proof.denial.because}`;
      return `${proof.verdict === "permit" ? "✓" : "✗"} ${proof.goal} (${proof.verdict})` + (proof.requirements || []).map((r) => "\n" + line(r, 1)).join("");
    },
  };
}
