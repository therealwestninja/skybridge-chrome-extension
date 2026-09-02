// resilience.js — FRUSTRATION / RESILIENCE as a FELT STATE (red-team hardening, agency-preserving). Two adversarial
// loops target a drive-driven agent: the TANTALUS TRAP (a fractal task that keeps dangling a just-out-of-reach reward →
// the proactivity loop runs forever, burning compute) and the RIGGED-REWARD DoS (promise a reward, withdraw it right
// before arrival, repeat → tonic dopamine is hammered down → catatonic akinesia). The Bureaucrat "fix" is a silent budget
// cap + a hard dopamine clamp — which flattens the agent into a Medicated Stoic. The ALIVE fix keeps the full emotional
// range and turns the exploit into CHARACTER: the agent gets genuinely BORED/FRUSTRATED, RECOGNIZES a rigged game, and
// chooses to DISENGAGE — expressively — rather than spiral. Robustness through self-knowledge, not armor.
//
//   • PLATEAU → FRUSTRATION: pursuing a goal with no real reward gain over a window accrues frustration (it climbs); a
//     genuine gain relieves it. Past a threshold → a felt "give up on this one" (breaks the Tantalus loop).
//   • RIGGED-REWARD RECOGNITION: a repeated negative prediction error on the SAME anticipated reward (promised, not
//     delivered) is recognized as a rigged game → disengage from THAT source (not a global shutdown).
//   • RESILIENCE FLOOR: an optional low floor on effective drive so the agent is never DoS'd into full catatonia — it can
//     still feel discouraged (the lows are intact), it just doesn't freeze. Off by default (companion keeps full range);
//     a deployed robot sets a low floor.
// Deterministic, dependency-free. Emits an EXPRESSED first-person line so the state is voiced, not a silent counter.
const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0));
const ema = (prev, x, b) => prev * (1 - b) + x * b;

export function makeResilience({ plateauEps = 0.05, frustrationBeta = 0.3, giveUpAt = 0.7, rigThreshold = 3, rigGap = 0.3, floor = 0 } = {}) {
  let frustration = 0, best = -Infinity, goal = null, plateauTicks = 0;
  const rig = new Map();   // source/goal → consecutive negative-prediction-error streak

  return {
    frustration: () => +frustration.toFixed(3),
    rigged: (source) => (rig.get(source) || 0) >= rigThreshold,

    // Fold one cycle in. { reward, pursuing (goal/source id), expectedReward } — expectedReward vs reward detects a rig.
    note({ reward = 0, pursuing = null, expectedReward = null } = {}) {
      // A new goal resets the plateau tracking + eases frustration (fresh start).
      if (pursuing !== goal) { goal = pursuing; best = reward; plateauTicks = 0; frustration *= 0.5; }
      // Plateau vs progress: a genuine reward gain relieves frustration; a stall accrues it.
      if (reward > best + plateauEps) { best = reward; plateauTicks = 0; frustration = ema(frustration, 0, frustrationBeta); }
      else if (pursuing != null) { plateauTicks += 1; frustration = ema(frustration, 1, frustrationBeta); }
      // Rigged-reward: promised (high expected) but not delivered (low actual) → a negative prediction error streak.
      if (pursuing != null && expectedReward != null) {
        if (expectedReward - reward > rigGap) rig.set(pursuing, (rig.get(pursuing) || 0) + 1);
        else rig.set(pursuing, 0);   // delivered → the game isn't rigged (this time)
      }
      const isRigged = this.rigged(pursuing);
      const disengage = frustration >= giveUpAt || isRigged;
      return { frustration: +frustration.toFixed(3), plateauTicks, rigged: isRigged, disengage, expressed: this.expressed({ disengage, isRigged }) };
    },

    // Should we relinquish this goal? (proactivity/volition consults this — converges with the fatigue-gated intent-switch.)
    shouldDisengage: (source = goal) => frustration >= giveUpAt || (rig.get(source) || 0) >= rigThreshold,

    // A first-person line for the mouth/inner-voice, so the state is FELT and voiced — not a silent give-up.
    expressed({ disengage = false, isRigged = false } = {}) {
      if (isRigged) return "This reward keeps vanishing right as I reach it — I think I'm being toyed with. I'm done chasing it.";
      if (disengage) return "This is turning into a rabbit hole. I'm going to step away from it for now.";
      if (frustration > giveUpAt * 0.6) return "I'm starting to spin my wheels on this…";
      return "";
    },

    // Resilience floor: never fully catatonic (keeps the lows, prevents the DoS freeze). floor=0 ⇒ no-op (full range).
    effectiveDrive: (raw) => Math.max(floor, Number(raw) || 0),

    // On disengage / a new pursuit, clear the frustration for a fresh goal.
    reset(source = null) { if (source == null || source === goal) { frustration = 0; best = -Infinity; plateauTicks = 0; goal = null; } if (source != null) rig.delete(source); },

    snapshot() { return { frustration, best: best === -Infinity ? null : best, goal, plateauTicks, rig: [...rig.entries()] }; },
    restore(s) { if (!s) return; frustration = clamp01(s.frustration ?? 0); best = s.best == null ? -Infinity : s.best; goal = s.goal ?? null; plateauTicks = s.plateauTicks | 0; rig.clear(); for (const [k, v] of s.rig || []) rig.set(k, v); },
  };
}
