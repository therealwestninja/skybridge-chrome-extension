// flyCpg.js — the insect-flight CENTRAL PATTERN GENERATOR (CPG), the wingbeat rhythm of the FlyNav navigator.
// Anatomy: insect flight is CPG + descending modulation + reflexes. The thoracic CPG generates a self-sustaining
// oscillation (the wingbeat); the "brain" does NOT drive each beat — it only MODULATES the rhythm's rate and depth
// via a descending drive (here: `arousal`, the substrate's energy/arousal in 0..~1). This module is that oscillator.
//
// Why it must exist: a constant sensory input alone settles any recurrent readout to a fixed point (proven in the
// game prototype — a still readout = a dead stick). The CPG, not input-drift, is the correct fix: it guarantees a
// live, non-settling weave even under constant descending drive. Arousal sets BOTH the rhythm rate (faster wingbeat
// when aroused) AND its amplitude (deeper strokes), matching the biological modulation.
//
// Pure + deterministic: time flows ONLY through the accumulated `dt` handed to `step` — never Date.now/performance.now.
// No dependencies. Snapshot/restore round-trips the single piece of state, `phase`.

// All numbers are NAMED, documented, caller-overridable options. The defaults are plausible starting values carried
// from the game prototype's PILOT constants (`bc-mod/cardsim`) — tuned-by-feel, not measured, so they are defaults
// and NOT hard-coded anywhere below.
export function makeFlyCpg({
  baseRate = 1.7,  // rad/s — intrinsic wingbeat angular rate at zero arousal (the idling rhythm never fully stops).
  rateGain = 2.6,  // rad/s per unit arousal — how much descending drive speeds the rhythm.
  ampBase  = 0.22, // dimensionless — stroke amplitude floor (a weave persists even when calm).
  ampCap   = 0.45, // dimensionless — ceiling on the arousal-driven amplitude ADDITION (keeps strokes bounded).
  ampGain  = 1.1,  // amplitude gain per unit arousal, before the `ampCap` clamp.
} = {}) {
  let phase = 0; // accumulated oscillator phase (radians); the sole state.

  return {
    // Advance the rhythm by `dt` seconds under the current descending `arousal`, and read the wing signal.
    //   phase += dt·(baseRate + rateGain·arousal)   — arousal speeds the beat
    //   wing   = sin(phase)·(ampBase + min(ampCap, ampGain·arousal))  — arousal deepens the stroke (capped)
    // Returns { phase, wing }. `wing` is the signed wingbeat readout the navigator blends into steer/bank.
    step(arousal = 0, dt = 0) {
      phase += dt * (baseRate + rateGain * arousal);
      const amp = ampBase + Math.min(ampCap, ampGain * arousal);
      return { phase, wing: Math.sin(phase) * amp };
    },

    snapshot() { return { phase }; },
    restore(s) { if (s && typeof s.phase === "number") phase = s.phase; },
  };
}
