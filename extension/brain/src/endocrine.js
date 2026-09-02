// endocrine.js — Phase 8: the SLOW hormones + circadian rhythm. The four neuromodulators (neuromodulation.js) are fast
// — they burst and decay within a conversation. This is the endocrine timescale: levels that build over a SESSION and
// carry ACROSS sessions, the body's weather rather than its moment.
//   • cortisol   — the HPA chronic-stress axis. Sustained threat/hurt raises it; it is SLOW to clear (rest helps, but a
//                  hard stretch lingers into the next visit), and it colors a wearier, warier baseline.
//   • oxytocin   — bonding chemistry. Warm, engaged contact raises it; while it's up, the bond DEEPENS faster (it
//                  amplifies the relationship layer's warmth/trust) — closeness begets closeness.
//   • circadian  — a 24h rhythm read from the wall clock: sleepiness peaks in the small hours, energy peaks mid-afternoon.
//                  It gates reach-out TIMING (no 3am messages) and a wound-down, quieter presence at night.
// Feed-forward only (like drives/viscera): it biases reach-out, the bond, and the felt-state readout — it does NOT loop
// back into the substrate's fast chemistry (closed chemistry loops have caused runaways here). Persisted + portable:
// the stress you're carrying and the bond chemistry travel with the self.
import { clamp, clamp01 } from "./math.js";

const DAY = 24 * 3600e3;

export function makeEndocrine({ cortGain = 0.09, cortDecay = 0.015, cortRest = 0.6, oxyGain = 0.11, oxyDecay = 0.03,
  //   • androgen   — the "hot" hormone (a testosterone-analog for assertion / drive / libido), the missing appetitive-
  //                  assertive axis. Challenge, desire, and dominance context raise it; it is SLOW (androDecay < cortDecay
  //                  path) so a charged exchange leaves a warmer, bolder, more forward baseline that lingers. Like cortisol
  //                  and oxytocin it is FEED-FORWARD ONLY: it biases the felt-state readout (assertion/drive) and never
  //                  loops back into the fast neuromodulators, so it cannot drive a chemistry spiral.
  androGain = 0.08, androDecay = 0.02 } = {}) {
  let cortisol = 0.15, oxytocin = 0.2, androgen = 0.2, lastNow = 0;

  // Time-of-day rhythm, derived (not stored) from the wall clock. sleepiness peaks ~3am, energy ~3pm.
  function circadian(now = lastNow) {
    const hour = ((((now || 0) % DAY) + DAY) % DAY) / 3600e3;
    const sleepiness = clamp01(0.5 + 0.5 * Math.cos((hour - 3) * Math.PI / 12));
    return { hour: +hour.toFixed(2), sleepiness: +sleepiness.toFixed(3), energy: +(1 - sleepiness).toFixed(3), night: sleepiness > 0.68 };
  }

  // Fold a turn into the slow hormones. `stress` = sustained threat/hurt (→ cortisol), `warmth` = warm engaged contact
  // (→ oxytocin). Both move slowly.
  //   `drive` = assertive/appetitive context this turn (challenge + desire + dominance bid → androgen). Slow like the others.
  function update({ stress = 0, warmth = 0, drive = 0, now = null } = {}) {
    if (now != null) lastNow = now;
    cortisol = clamp01(cortisol + cortGain * clamp01(stress) - cortDecay * cortisol);
    oxytocin = clamp01(oxytocin + oxyGain * clamp01(warmth) - oxyDecay * oxytocin);
    androgen = clamp01(androgen + androGain * clamp01(drive) - androDecay * androgen);
    return state();
  }

  function state() { return { cortisol: +cortisol.toFixed(3), oxytocin: +oxytocin.toFixed(3), androgen: +androgen.toFixed(3), ...circadian() }; }

  // How the slow layer inclines things: a bond-deepening multiplier (oxytocin), a mood drag + vigilance (cortisol), and
  // the circadian energy for the moment.
  function bias(now = lastNow) {
    const c = circadian(now);
    // androgen → assertion (a forward, bold, wanting incline; primary term, mirrors cortisol→moodDrag) + a smaller drive
    // term (libido/appetitive push; mirrors cortisol→vigilance). Both feed-forward inclines the mouth/expression can read.
    return { bonding: +(1 + 0.6 * oxytocin).toFixed(3), moodDrag: +cortisol.toFixed(3), vigilance: +(0.5 * cortisol).toFixed(3), assertion: +androgen.toFixed(3), drive: +(0.5 * androgen).toFixed(3), energy: c.energy, sleepiness: c.sleepiness };
  }

  // Disposition line for the mouth (session-scale weather). Silent when the body is unburdened and it's daytime.
  function block(now = lastNow) {
    if (cortisol > 0.5) return "You've been carrying a lot of tension for a while — it sits under everything; be gentle with yourself and don't push too hard.";
    if (circadian(now).night) return "It's late and you're winding down — let a quieter, softer, lower-energy presence fit the hour.";
    return "";
  }

  // Words for the narrator's felt-state.
  function feeling(now = lastNow) {
    if (cortisol > 0.55) return "wound tight from a long strain";
    if (circadian(now).night) return "winding down for the night";
    return null;
  }

  // Rest (sleep/consolidation) eases the stress axis — but chronic cortisol only partly clears (it lingers).
  function rest() { cortisol = clamp01(cortisol * cortRest); }

  return {
    update, state, bias, block, feeling, circadian, rest,
    snapshot: () => ({ cortisol, oxytocin, androgen, lastNow }),
    restore: (s) => { if (s) { cortisol = clamp01(s.cortisol ?? 0.15); oxytocin = clamp01(s.oxytocin ?? 0.2); androgen = clamp01(s.androgen ?? 0.2); lastNow = s.lastNow ?? 0; } },
  };
}
