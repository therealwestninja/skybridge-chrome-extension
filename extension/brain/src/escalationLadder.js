// escalationLadder.js — PB-1: DEMAND-DRIVEN COGNITION. Most ticks should be cheap. This gates the expensive deliberation
// stack (council fork/vote, imagination, a backend/LLM call) behind a cheap trigger: run a REFLEX/HEURISTIC loop by
// default and only escalate to FULL when radar presence/approach OR a salience / drive / affect-arousal threshold fires.
// The rise is immediate (don't miss a real bid), but the fall is HYSTERETIC — a level is held for `dwell` ticks before
// it decays one step — so organs never strobe on/off at a threshold edge (the reflexArbiter anti-strobe lesson).
// Keep the trigger DUMB: thresholds over cheap signals, never a big model deciding whether to run the big model.
// PURE: no clock/random/network — signals injected per tick; deterministic.

export const LEVELS = ["reflex", "heuristic", "full"];

export function makeEscalationLadder({
  salienceUp = 0.6, driveUp = 0.6, arousalUp = 0.6,   // any of these (or approach) → escalate to FULL
  midAt = 0.35,                                        // a mild signal → HEURISTIC (still no council/backend)
  dwell = 3,                                           // consecutive want-lower ticks required before decaying one step
  prewarmAt = "heuristic",                             // at/above this level, pre-warm the mouth/provider connection
} = {}) {
  let level = "reflex", wantLowerFor = 0;

  // one tick. signals: { presence, approach (radar); salience, drive, arousal (0..1) }.
  function step({ presence = false, approach = false, salience = 0, drive = 0, arousal = 0 } = {}) {
    const strong = !!approach || salience >= salienceUp || drive >= driveUp || arousal >= arousalUp;
    const mild = !!presence || salience >= midAt || drive >= midAt || arousal >= midAt;
    const want = strong ? "full" : mild ? "heuristic" : "reflex";
    const wi = LEVELS.indexOf(want), li = LEVELS.indexOf(level);

    if (wi > li) { level = want; wantLowerFor = 0; }             // rise immediately on a stronger trigger
    else if (wi < li) { wantLowerFor++; if (wantLowerFor >= dwell) { level = LEVELS[li - 1]; wantLowerFor = 0; } }   // decay one step only after sustained quiet
    else wantLowerFor = 0;

    const idx = LEVELS.indexOf(level);
    return {
      level,
      deliberate: level === "full",                             // ONLY at full do we spend council/imagination/backend
      prewarm: idx >= LEVELS.indexOf(prewarmAt),                // rising through heuristic → speculatively warm the mouth
      wantLowerFor,
    };
  }

  return { step, level: () => level, reset: () => { level = "reflex"; wantLowerFor = 0; } };
}
