// Emotion regulation (Personhood P6): top-down control OVER the neuromodulators, which are otherwise
// purely reactive (they burst on reward/threat/surprise and only decay passively). This is the
// prefrontal-style controller that actively damps its own extremes -- self-calm when arousal spikes,
// self-soothe when valence sinks -- accelerating the return to a comfortable band rather than just
// waiting out homeostasis. It reads mood and applies corrective chemical nudges (organism.nudgeChem).
//
// WOUND-AWARE self-soothe (honest hurt): a genuine, unrepaired psyche wound (or elevated cortisol) means the
// low is EARNED — it should be allowed to sit rather than be instantly rescued back to neutral. So the soothe
// engages LATER (a lower effective floor) and lifts GENTLER/SLOWER when wounded. This is graduated and stays
// feed-forward (the wound/cortisol signal is passed IN as an argument — regulation never imports the psyche),
// and a HARD floor still bounds the effective floor so a low can never spiral: below it, soothe always engages.
import { clamp } from "./math.js";

export function makeRegulation({
  arousalHigh = 0.75, valenceFloor = -0.4, calmK = 0.5, sootheK = 0.4, maxStep = 1.0,
  // Wound-aware soothe: when fully wounded the soothe floor sinks to `woundedFloor` (hurt dwells lower before
  // the lift kicks in), but never past `hardFloor` (the anti-spiral guarantee). `sootheSlow` makes the lift
  // gentler in general (a real low takes several ticks to rise, not one), and `woundSootheDamp` softens it
  // further in proportion to how wounded the body is (let genuine hurt stay a while).
  woundedFloor = -0.55, hardFloor = -0.75, sootheSlow = 0.6, woundSootheDamp = 0.5,
  // Mood inertia: felt valence should not SNAP to neutral. `linger` is a slow-follow READOUT of the mood — an
  // EMA, feed-forward only, never nudged back into the chemistry (that would be a spiral loop). inertiaK is how
  // fast it catches up to the current mood; smaller = a low lingers longer as an afterstate.
  inertiaK = 0.35,
} = {}) {
  let linger = 0; // lingering felt-valence afterstate (slow-follow of the readout; never an input to chemistry)
  return {
    // Called after the turn's affect is set. `signal` carries the (bounded) feed-forward wound/cortisol read
    // from the caller (mind.js threads psyche + endocrine in); absent → behaves exactly as before (inert default).
    regulate(organism, signal = {}) {
      const m = organism.mood() || {};
      const a = m.arousal ?? 0, v = m.valence ?? 0;
      // How wounded the body is right now: the heavier of an open psyche wound and elevated cortisol (both 0..1,
      // 0 at the default persona's rest so the default behaviour is unchanged).
      const woundedness = clamp(Math.max(signal.wound ?? 0, signal.cortisol ?? 0), 0, 1);
      // Effective soothe floor: slides from valenceFloor (unwounded) down toward woundedFloor (fully wounded),
      // but is clamped so it never drops below the hard safety floor. Because soothe ALWAYS engages once v < this
      // floor, a lower floor lets hurt sink further yet still can't runaway.
      const effFloor = Math.max(hardFloor, valenceFloor + (woundedFloor - valenceFloor) * woundedness);
      let calmed = 0, soothed = 0;
      if (a > arousalHigh) {                                // over-aroused -> down-regulate NE
        calmed = Math.min(maxStep, calmK * (a - arousalHigh));
        organism.nudgeChem("norepinephrine", -calmed);
      }
      if (v < effFloor) {                                   // low mood -> gentle lift (dopamine + serotonin)
        // Gentler in general (sootheSlow) and gentler still when wounded (woundSootheDamp): a real low lifts over
        // several ticks, and genuine hurt is allowed to dwell rather than be wiped in one.
        const damp = sootheSlow * (1 - woundSootheDamp * woundedness);
        soothed = Math.min(maxStep, sootheK * damp * (effFloor - v));
        organism.nudgeChem("dopamine", 0.6 * soothed);
        organism.nudgeChem("serotonin", soothed);
      }
      // Mood inertia: slow-follow the felt valence so an afterstate lingers past the input. Pure readout — NOT an
      // input back into the chemistry (feed-forward firewall intact). Bounded because v is bounded (tanh readout).
      linger += inertiaK * (v - linger);
      return {
        calmed: +calmed.toFixed(3), soothed: +soothed.toFixed(3), applied: calmed > 0 || soothed > 0,
        effFloor: +effFloor.toFixed(3), wounded: +woundedness.toFixed(3), linger: +linger.toFixed(3),
      };
    },
    // The lingering felt-valence afterstate (for the trace / narrator). Read-only slow-follow.
    linger: () => +linger.toFixed(3),
  };
}
