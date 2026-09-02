// Procedural memory / habits (Personhood P3): an explicit, inspectable store of "in context X, the
// successful action is Y", strengthened by repetition + reward until it becomes AUTOMATIC. This is the
// procedural counterpart to the CLS split -- declarativeStore is the explicit store paralleling the
// distributed associative weights; this parallels how STDP slowly tunes routing, but as a legible
// habit cache (a basal-ganglia analog). It lets Rook get better at *doing* a kind of turn, not just
// at *knowing* facts. Long-term + persisted.
export function makeProcedural({ threshold = 3, decay = 0.98, repBase = 0.34, gain = 1, punish = 1.5 } = {}) {
  let habits = {}; // key -> { key, action, strength, count, lastTurn }
  let turn = 0;

  return {
    threshold,

    // Per-turn forgetting: unused skills fade, and near-zero ones are dropped.
    decay() {
      turn += 1;
      for (const k of Object.keys(habits)) {
        habits[k].strength *= decay;
        if (habits[k].strength < 0.05) delete habits[k];
      }
    },

    // Reinforce (reward >= 0) or weaken (reward < 0) the context->action mapping for the DELIVERED
    // action. Repetition alone builds a weak habit (repBase); reward accelerates it. A different
    // dominant action for a context resets its habit toward the new one. QUIET has no motor act to
    // habituate.
    reinforce(context, action, reward = 0) {
      if (!action || action === "QUIET") return null;
      const key = String(context);
      let h = habits[key];
      if (!h || h.action !== action) h = habits[key] = { key, action, strength: 0, count: 0, lastTurn: turn };
      h.count += 1;
      h.lastTurn = turn;
      h.strength += reward >= 0 ? repBase + gain * reward : -punish * -reward;
      if (h.strength < 0) h.strength = 0;
      return { ...h };
    },

    // The habitual action for a context once it's stamped in (strength >= threshold), with an
    // automaticity in [0,1] (saturating at 2x threshold); else null.
    suggest(context) {
      const h = habits[String(context)];
      if (!h || h.strength < threshold) return null;
      return { action: h.action, strength: h.strength, automaticity: Math.min(1, h.strength / (threshold * 2)) };
    },

    list: () => Object.values(habits).map((h) => ({ ...h })).sort((a, b) => b.strength - a.strength),
    serialize: () => ({ habits: JSON.parse(JSON.stringify(habits)), turn }),
    restore(s) { if (s) { habits = s.habits || {}; turn = s.turn || 0; } },
  };
}
