// Prefrontal executive: always-on conversation ORIENTATION (origin/aim/heading/turns), which
// crystallizes into a PLAN (LLM-decomposed steps + phase/progress) for task-goals and dissolves
// when done. Brain holds the state; the LLM (via makeLlmPlanner) does the one-time decomposition.
//
// PB-3: the plan is a READY-TASK DAG, not a fixed serial list. A step may declare `deps` (other steps
// that must finish first); a step becomes runnable only once its prerequisites are done, so independent
// steps surface as ready together and a plan is no longer forced linear. planDAG validates + topo-orders
// every plan (a cycle or dangling dep is repaired to a safe linear chain and flagged for audit); the
// ready-set drives selection; runReady executes the plan as concurrent ready-waves for agentic callers.
// Plain string plans get an implicit linear dependency chain, so legacy behavior is byte-for-byte preserved.
import { planDAG, runReady } from "./scheduler.js";

const PHASES = ["orient", "work", "converge", "deliver"];
const PHASE_DIRECTIVE = {
  orient: "Get your bearings and clarify the aim.",
  work: "Make concrete progress on the next step.",
  converge: "Tie the threads together.",
  deliver: "Close it out clearly.",
};
const GOAL_MARKERS = /\b(help me|let's|lets|plan|figure out|build|write|organize|organise|walk me through|step by step|how do i)\b/;
const trim = (s, n = 90) => {
  const t = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 3) + "..." : t;
};

// A step may be a bare string, or { text, deps:[stepIndex,...] }. Normalize to parallel text[] + deps[][],
// defaulting to a LINEAR chain (step i depends on i-1) when no deps are given — that keeps legacy plans identical.
function normalizeSteps(steps) {
  const arr = (steps || []).slice(0, 6);
  const text = arr.map((s) => (s && typeof s === "object" ? trim(s.text, 120) : String(s)));
  const deps = arr.map((s, i) => {
    const d = s && typeof s === "object" && Array.isArray(s.deps) ? s.deps : null;
    if (d) return [...new Set(d.map(Number).filter((x) => Number.isInteger(x) && x >= 0 && x < arr.length && x !== i))];
    return i > 0 ? [i - 1] : [];   // implicit linear dependency — reproduces the old serial cursor exactly
  });
  return { text, deps };
}

export function makeExecutive() {
  const orientation = { origin: "", aim: "", heading: "", turns: 0 };
  let plan = null;
  let pending = false;

  const goalLike = (message, intent) => intent === "task" || GOAL_MARKERS.test(String(message).toLowerCase());
  // topo-ordered step indices that are runnable NOW: not yet done, and every dependency completed.
  const readyIdx = (pl) => pl.order.filter((i) => !pl.doneIds.includes(i) && pl.deps[i].every((d) => pl.doneIds.includes(d)));
  const clonePlan = (p) => (p ? { ...p, steps: [...p.steps], deps: p.deps.map((d) => [...d]), order: [...p.order], doneIds: [...p.doneIds] } : null);
  const snap = () => ({ orientation: { ...orientation }, plan: clonePlan(plan) });

  return {
    sense(message, { intent = "respond" } = {}) {
      orientation.turns += 1;
      if (!orientation.origin) orientation.origin = trim(message);
      orientation.heading = intent;
      orientation.aim = trim(message);
      if (!plan && goalLike(message, intent)) {
        plan = { goal: trim(message, 120), steps: [], deps: [], order: [], doneIds: [], dagRepaired: false, phase: "orient", cursor: 0, progress: 0, status: "active" };
        pending = true;
      }
      return snap();
    },
    needsPlan() { return pending; },
    setSteps(steps) {
      if (!plan) return;
      const { text, deps } = normalizeSteps(steps);
      let { order, ok } = planDAG(text.map((_, i) => ({ id: i, deps: deps[i] })));
      let repaired = false;
      if (!ok) {                                             // cycle or dangling dep → fall back to a safe linear chain
        for (let i = 0; i < deps.length; i++) deps[i] = i > 0 ? [i - 1] : [];
        order = text.map((_, i) => i);
        repaired = true;
      }
      plan.steps = text;
      plan.deps = deps;
      plan.order = order;
      plan.doneIds = [];
      plan.dagRepaired = repaired;
      plan.phase = "work";
      plan.cursor = 0;
      plan.progress = 0;
      pending = false;
    },
    // Mark one step complete (an explicit `step` index, else the first ready step) and recompute phase/progress.
    advance({ done = false, step = null } = {}) {
      if (!plan) return;
      const ready = readyIdx(plan);
      const pick = (typeof step === "number" && step >= 0 && step < plan.steps.length && !plan.doneIds.includes(step))
        ? step : (ready.length ? ready[0] : null);
      if (pick != null && !plan.doneIds.includes(pick)) plan.doneIds.push(pick);
      const n = Math.max(1, plan.steps.length);
      plan.cursor = plan.doneIds.length;
      plan.progress = Math.min(1, plan.cursor / n);
      plan.phase = PHASES[Math.min(3, Math.floor(plan.progress * 4))];
      if (done || plan.cursor >= n) { plan.status = "done"; plan = null; }
    },
    // Execute the plan as a ready-task DAG: runStep(text, depResults, index) runs concurrently per ready-wave;
    // a step that throws fails and only its dependents are skipped. Returns runReady's { done, failed, stuck }.
    async execute(runStep) {
      if (!plan || typeof runStep !== "function") return { done: {}, failed: [], stuck: [] };
      const nodes = plan.order.map((i) => ({ id: i, deps: plan.deps[i] }));
      const res = await runReady(nodes, (node, depResults) => runStep(plan.steps[node.id], depResults, node.id));
      for (const idStr of Object.keys(res.done)) { const i = Number(idStr); if (!plan.doneIds.includes(i)) plan.doneIds.push(i); }
      const n = Math.max(1, plan.steps.length);
      plan.cursor = plan.doneIds.length;
      plan.progress = Math.min(1, plan.cursor / n);
      plan.phase = PHASES[Math.min(3, Math.floor(plan.progress * 4))];
      if (plan.doneIds.length >= plan.steps.length) plan.status = "done";
      return res;
    },
    ready() { return plan ? readyIdx(plan).map((i) => plan.steps[i]) : []; },
    current() { return snap(); },
    block() {
      const o = orientation;
      let s = `Started with: ${o.origin || "(new)"}. About: ${o.aim || o.origin || "(chat)"}. (${o.turns} turn${o.turns === 1 ? "" : "s"} in.)`;
      if (plan) {
        const ready = new Set(readyIdx(plan));
        const doneS = new Set(plan.doneIds);
        const nextIdx = plan.order.find((i) => ready.has(i));
        const rows = plan.order.map((i) => {
          const mark = doneS.has(i) ? "x" : ready.has(i) ? ">" : " ";
          // annotate only non-linear prerequisites, so linear plans render exactly as before
          const nonLinear = plan.deps[i].filter((d) => d !== i - 1);
          const after = nonLinear.length ? ` (after: ${nonLinear.map((d) => d + 1).join(",")})` : "";
          return `${mark} ${plan.steps[i]}${after}`;
        }).join("\n");
        s += `\n\nGOAL: ${plan.goal}` +
          (plan.steps.length ? `\nPLAN:\n${rows}` : "") +
          `\nPHASE: ${plan.phase} - ${PHASE_DIRECTIVE[plan.phase]}` +
          `\nPROGRESS: ${plan.cursor}/${Math.max(1, plan.steps.length)}` +
          (nextIdx != null && plan.steps[nextIdx] ? `\nNEXT: ${plan.steps[nextIdx]}` : "");
      }
      return s;
    },
    snapshot() { return snap(); },
    restore(state) {
      if (!state) return;
      Object.assign(orientation, state.orientation || {});
      plan = clonePlan(state.plan);
      pending = false;
    },
  };
}

// One backend call that decomposes a goal into ordered steps. Injectable; degrades gracefully.
export function makeLlmPlanner(backend, onFault) {
  return async (goalText) => {
    const fallback = [`Work toward: ${goalText}`];
    if (!backend) return fallback;
    try {
      const out = await backend.generate({
        system: "You are a planner. Output only an ordered list of short steps, one per line, no numbering.",
        messages: [{ role: "user", content: `Break this goal into 3 to 6 short, ordered steps. Goal: ${goalText}` }],
      });
      const text = typeof out === "string" ? out : (out && out.text) || "";
      const steps = text.split("\n").map((l) => l.replace(/^\s*[-*\d.)\]]+\s*/, "").trim()).filter(Boolean).slice(0, 6);
      return steps.length ? steps : fallback;
    } catch (e) { if (onFault) onFault("executive.plan", e); return fallback; } // a real backend/parse fault — worth diagnosing; still degrades to the stub plan
  };
}
