// affectMemory.js — how she FELT with each person, remembered across sessions. A running EMA of her affect during
// interactions with person X (valence/arousal + a `warmth` bond channel). On RE-ENCOUNTER, `greet()` nudges her chemistry
// toward the remembered feeling — a warm history greets warm, a hurtful one greets guarded. This is what makes a specific
// person MATTER to her over time: her feelings toward you have history instead of resetting every session.
//
// PURE (no clock/random — `at` passed in). serialize()/restore() round-trip the whole book for on-disk persistence next
// to the other learned tables ([[self-migration-completeness]]).

const clampSigned = (x) => Math.max(-1, Math.min(1, Number(x) || 0));
const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0));
const ema = (prev, x, a) => prev + (x - prev) * a;

export function makeAffectMemory({ alpha = 0.12, state = null } = {}) {
  const mem = new Map();   // id -> { valence, arousal, warmth, n, lastAt }
  const load = (s) => { mem.clear(); if (s && s.people) for (const [id, m] of Object.entries(s.people)) mem.set(id, { valence: 0, arousal: 0.3, warmth: 0, n: 0, lastAt: 0, ...m }); };
  load(state);

  // imprint(id, affect, at) — fold THIS interaction's felt affect into the running memory of person `id`.
  function imprint(id, affect = {}, at = 0) {
    if (!id) return null;
    const cur = mem.get(id) || { valence: 0, arousal: 0.3, warmth: 0, n: 0, lastAt: 0 };
    cur.valence = +ema(cur.valence, clampSigned(affect.valence), alpha).toFixed(4);
    cur.arousal = +ema(cur.arousal, clampSigned(affect.arousal), alpha).toFixed(4);
    cur.warmth = +ema(cur.warmth, clampSigned(affect.warmth != null ? affect.warmth : affect.valence), alpha).toFixed(4);
    cur.n++; cur.lastAt = at | 0;
    mem.set(id, cur);
    return { ...cur };
  }

  function recall(id) { const m = mem.get(id); return m ? { ...m } : null; }

  // greet(id, chems, {strength}) — on re-encounter, seed her chemistry toward how she remembers feeling with this person.
  // Needs a little history (n>=2) so a single odd turn doesn't define the relationship. Warm history → reward+warmth;
  // a hurtful history (negative warmth) → a guarded, wary greeting. Returns null if the person is effectively new.
  function greet(id, chems, { strength = 0.5 } = {}) {
    const m = mem.get(id);
    if (!m || m.n < 2 || !chems || typeof chems.burst !== "function") return null;
    const k = clamp01(strength);
    if (m.warmth > 0) { chems.burst("dopamine", 0.2 * k * m.warmth); chems.burst("serotonin", 0.28 * k * m.warmth); }
    else if (m.warmth < 0) { chems.burst("norepinephrine", 0.22 * k * (-m.warmth)); chems.burst("serotonin", -0.15 * k * (-m.warmth)); }
    return { remembered: { ...m }, applied: k };
  }

  return {
    imprint, recall, greet,
    size: () => mem.size,
    serialize: () => ({ v: 1, people: Object.fromEntries(mem) }),
    restore: (s) => { load(s); return mem; },
  };
}
