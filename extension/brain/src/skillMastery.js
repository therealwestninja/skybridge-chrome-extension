// skillMastery.js — graded competence: how WELL a skill is known, not just whether it loaded.
//
// `src/skills.js` tracks `maturity` as five categorical states (pre-baked / quarantined / loaded /
// validated / failed) — a light switch. Mastery is the dial. It rises with successful use and clean
// trials, rises most when practice retires a *pending* capability, and DECAYS with disuse. The decay
// is deliberate, not decoration: it is the forgetting term required by any rich-get-richer
// reinforcement rule (see docs/specs/2026-07-29-fractalrabbit-mine.md, transfer T2) so a skill
// learned once and never used again does not stay "expert" forever.
//
// Determinism: no Date.now(), no Math.random(). Time advances ONLY via tick() from the caller.
// Every tuning number is a named, caller-overridable option.

export const MASTERY_TIERS = ["novice", "practised", "proficient", "expert"];

const isName = (n) => typeof n === "string" && n.length > 0;
const clamp01 = (v) => (Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0);

export function makeSkillMastery({
  useGain = 0.06,        // successful invocation
  trialGain = 0.04,      // clean sandboxed trial (dry run — worth less than real practice)
  practiceGain = 0.12,   // retired a PENDING capability — the strongest evidence
  failPenalty = 0.10,    // a failed use or trial
  decayPerTick = 0.01,   // subtracted each tick from any skill NOT exercised that tick
  tierCuts = [0.25, 0.55, 0.85],
} = {}) {
  const num = (v, dflt) => (Number.isFinite(v) ? v : dflt);
  const gains = {
    use: num(useGain, 0.06),
    trial: num(trialGain, 0.04),
    practice: num(practiceGain, 0.12),
    fail: num(failPenalty, 0.10),
    decay: num(decayPerTick, 0.01),
  };
  const cuts = (Array.isArray(tierCuts) && tierCuts.length === 3 && tierCuts.every(Number.isFinite))
    ? tierCuts.slice()
    : [0.25, 0.55, 0.85];

  /** @type {Map<string, { score: number, fresh: boolean }>} */
  const map = new Map();

  function entry(name) {
    let e = map.get(name);
    if (!e) { e = { score: 0, fresh: false }; map.set(name, e); }
    return e;
  }

  function bump(name, delta) {
    if (!isName(name) || !Number.isFinite(delta)) return;
    const e = entry(name);
    e.score = clamp01(e.score + delta);
    e.fresh = true;
  }

  function score(name) {
    if (!isName(name)) return 0;
    const e = map.get(name);
    return e ? e.score : 0;
  }

  function tier(name) {
    const s = score(name);
    if (s < cuts[0]) return MASTERY_TIERS[0];
    if (s < cuts[1]) return MASTERY_TIERS[1];
    if (s < cuts[2]) return MASTERY_TIERS[2];
    return MASTERY_TIERS[3];
  }

  return {
    recordUse(name, { ok } = {}) { bump(name, ok === true ? gains.use : -gains.fail); },
    recordTrial(name, { clean } = {}) { bump(name, clean === true ? gains.trial : -gains.fail); },
    recordPractice(name) { bump(name, gains.practice); },

    tick() {
      for (const e of map.values()) {
        if (!e.fresh) e.score = clamp01(e.score - gains.decay);
        e.fresh = false;
      }
    },

    score,
    tier,

    set(name, v) {
      if (!isName(name)) return;
      entry(name).score = clamp01(Number(v));
    },

    ranked() {
      return [...map.entries()]
        .map(([name, e]) => ({ name, score: e.score, tier: tier(name) }))
        .sort((a, b) => (b.score - a.score) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    },

    snapshot() {
      const skills = {};
      for (const [name, e] of map) skills[name] = { score: e.score, fresh: !!e.fresh };
      return { version: 1, skills };
    },

    restore(s) {
      if (!s || typeof s !== "object") return;
      const skills = s.skills;
      if (!skills || typeof skills !== "object") return;
      map.clear();
      for (const name of Object.keys(skills)) {
        if (!isName(name)) continue;
        const raw = skills[name];
        const v = raw && typeof raw === "object" ? Number(raw.score) : Number(raw);
        if (!Number.isFinite(v)) continue;
        map.set(name, { score: clamp01(v), fresh: !!(raw && raw.fresh) });
      }
    },
  };
}

export default makeSkillMastery;
