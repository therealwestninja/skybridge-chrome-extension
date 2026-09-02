// bandit.js — value-estimation under reward: the "decision-under-reward" primitive the brain was MISSING. procedural.js is a
// HABIT strengthener (accumulates with repetition → rich-get-richer, not a value); selection.js is fitness-GATED keep/rollback
// (not a per-option value). Neither answers "of these options, which yields the most reward on average?" — the core of a bandit.
//
// This is a contextless multi-armed bandit: per-arm Q = incremental mean of reward (Q ← Q + step·(r − Q); step = 1/n for a
// stationary average, or a fixed alpha to track a moving optimum), paired with the brain's OWN self-annealing explore/exploit
// ([[explore.js]]) — curious while it knows few arms, greedy once it's learned. Reusable anywhere Rook must "pick an option,
// see the outcome, get better": BC cards/driving-gains, the drone, Go2, RookAI. PURE + serializable.
import { makeExplorer } from "./explore.js";

export function makeBandit({ phi = 2, alpha = null } = {}) {
  const explorer = makeExplorer({ phi });
  let arms = {}; // id -> { q, n }
  const q = (id) => (arms[id] ? arms[id].q : 0);

  return {
    value: q,
    known: () => Object.keys(arms).length,

    // Q ← Q + step·(reward − Q). step = 1/n = true running mean (stationary); alpha in (0,1] = constant step (nonstationary).
    update(id, reward) {
      const a = arms[id] || (arms[id] = { q: 0, n: 0 });
      a.n += 1;
      const step = alpha != null ? alpha : 1 / a.n;
      a.q += step * (reward - a.q);
      return a.q;
    },

    // Pick among candidate ids: explore (prefer an untried arm, else uniform) while uncertain; else argmax Q (ties → first).
    choose(ids) {
      if (!ids || !ids.length) return null;
      const explore = explorer.decide(Object.keys(arms).length, Math.random());
      if (explore) {
        const untried = ids.filter((i) => !arms[i]);
        const pool = untried.length ? untried : ids;
        return { id: pool[Math.floor(Math.random() * pool.length)], mode: "explore" };
      }
      let best = ids[0];
      for (const i of ids) if (q(i) > q(best)) best = i;
      return { id: best, mode: "exploit" };
    },

    table: () => Object.entries(arms).map(([id, a]) => ({ id, q: a.q, n: a.n })).sort((x, y) => y.q - x.q),
    serialize: () => ({ arms: JSON.parse(JSON.stringify(arms)) }),
    restore(s) { if (s && s.arms) arms = s.arms; },
  };
}

export default makeBandit;
