// Volition / standing goals (Personhood P2b): durable goals and intentions that PERSIST across turns
// and sessions -- the strategic layer above the executive. The executive (executive.js) holds ONE
// tactical plan for the CURRENT conversation that dissolves when done; volition is the lasting backlog
// of what the user is working toward ("I want to learn to weld", "remind me to water the plants"),
// carried forward indefinitely until completed or dropped.
//
// v1 scope (per plan): goals come from EXPLICIT durable statements the user makes (detected below);
// self-generated goals + proactive raising are deferred. Goals only inform the prompt -- Rook doesn't
// bring them up unprompted yet (that ties to the deferred idle-initiate item #5c). Persisted.

// Pull a durable personal intention out of a message, or null. Conservative on purpose: matches
// intent phrasings ("remind me to", "my goal is to", "I want to <durable-verb> ...") and takes the
// first clause, so transient asks ("I want to know the time") mostly don't register.
const GOAL_PATTERNS = [
  /\bremind me to (.+)/i,
  /\bmy goal is to (.+)/i,
  /\bi'?m working on (.+)/i,
  /\bi'?m (?:trying|working|hoping|planning) to (.+)/i,
  /\bi(?:'d| would)? (?:want|like|hope|plan) to ((?:learn|get better at|start|build|finish|improve|master|practice|write|make|create|quit|stop|read|save|travel|exercise)\b.+)/i,
];

export function detectStandingGoal(message) {
  const m = String(message);
  for (const p of GOAL_PATTERNS) {
    const hit = p.exec(m);
    if (!hit || !hit[1]) continue;
    const g = hit[1].split(/[.!?]/)[0].replace(/\s+/g, " ").trim(); // first clause only
    if (g.length >= 3 && g.length <= 80) return g;
  }
  return null;
}

export function makeVolition({ maxGoals = 12 } = {}) {
  let goals = []; // { id, text, priority, status, turn }  status: active | done | dropped
  let seq = 0;
  let turn = 0;

  const active = () => goals.filter((g) => g.status === "active");
  const byPriority = (a, b) => b.priority - a.priority || a.turn - b.turn; // priority desc, then oldest
  const find = (id) => goals.find((g) => g.id === id);

  // Register a goal (or refresh an existing active one). Over the cap, the lowest-priority/oldest
  // active goals are dropped so the standing set stays bounded.
  function add(text, { priority = 1 } = {}) {
    const t = String(text || "").trim();
    if (!t) return null;
    const existing = goals.find((g) => g.status === "active" && g.text.toLowerCase() === t.toLowerCase());
    if (existing) { existing.priority = Math.max(existing.priority, priority); return existing; }
    const g = { id: `g${++seq}`, text: t, priority, status: "active", turn };
    goals.push(g);
    const act = active().sort(byPriority);
    if (act.length > maxGoals) act.slice(maxGoals).forEach((x) => { x.status = "dropped"; });
    return g;
  }

  return {
    add,
    // Per-turn: detect a durable intention in the message and register it. Returns the goal or null.
    sense(message) { turn += 1; const g = detectStandingGoal(message); return g ? add(g) : null; },
    complete(id) { const g = find(id); if (g) g.status = "done"; return g; },
    drop(id) { const g = find(id); if (g) g.status = "dropped"; return g; },
    list({ status = "active" } = {}) {
      const set = status === "all" ? goals : goals.filter((g) => g.status === status);
      return set.map((g) => ({ ...g }));
    },
    block() {
      const act = active().sort(byPriority);
      return act.length ? "Standing intentions (the user's ongoing goals):\n" + act.map((g) => `- ${g.text}`).join("\n") : "";
    },
    serialize: () => ({ goals: goals.map((g) => ({ ...g })), seq, turn }),
    restore(s) { if (s) { goals = (s.goals || []).map((g) => ({ ...g })); seq = s.seq || 0; turn = s.turn || 0; } },
  };
}
