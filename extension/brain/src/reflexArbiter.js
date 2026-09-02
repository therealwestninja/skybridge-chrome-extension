// reflexArbiter.js — REFLEX SUPREMACY + anti-strobe (Cluster: onboard/offboard arbitration). Defends the
// "reflex jitter / strobe" attack: an attacker flickers a sensor at the edge of its threshold so the ONBOARD
// reflex screams STOP while the OFFBOARD brain says GO — the two loops fight and the robot shudders/stutters,
// draining battery. Two-part fix:
//   (1) REFLEX SUPREMACY / onboard final-veto — when onboard reflex and offboard intent CONFLICT, ONBOARD WINS
//       100%. The body has the final veto, not the mind. A live STOP reflex is never overridden by a remote GO.
//   (2) SCHMITT-TRIGGER anti-strobe DEBOUNCE — the raw reflex trigger is debounced with hysteresis: enter the
//       STOP state only after the trigger holds for `enterHold` consecutive reads (or a continuous reading
//       crosses `enterLevel`), and exit only after it's clear for `exitHold` reads (or falls below `exitLevel`).
//       A signal strobing at the threshold therefore does NOT chatter the STOP on/off — it resolves to one
//       stable state.
//
// Style matches guard.js (p-consecutive debounce) and beaconSilence.js (enter/exit hysteresis, snapshot/restore,
// no Math.random / Date.now). Deterministic and dependency-free; the caller feeds raw reflex triggers through
// debounce() and passes the stable result + the offboard intent to arbitrate().
const toNum = (x) => (Number.isFinite(Number(x)) ? Number(x) : null);

export function makeReflexArbiter({
  enterHold = 2,      // consecutive triggered reads required to ENTER stop (count-based debounce; one blip never trips it)
  exitHold = 3,       // consecutive clear reads required to EXIT stop (slower to release than to grab — safe default)
  enterLevel = null,  // optional continuous-reading Schmitt HIGH bar: reading >= enterLevel counts as triggered
  exitLevel = null,   // optional continuous-reading Schmitt LOW bar: reading <= exitLevel counts as clear (< enterLevel ⇒ hysteresis band)
} = {}) {
  const eHold = Math.max(1, enterHold | 0);
  const xHold = Math.max(1, exitHold | 0);
  const hasLevels = enterLevel != null && exitLevel != null;

  let stopped = false;   // the DEBOUNCED, stable stop state (what arbitrate() should consume)
  let onStreak = 0;      // consecutive triggered reads
  let offStreak = 0;     // consecutive clear reads

  // Resolve a raw read into triggered | clear | neither. `triggered` may be a boolean OR, when levels are
  // configured, a continuous numeric reading run through the Schmitt bars. In the hysteresis band (between the
  // exit and enter bars) neither side confirms, so we hold state and decay both streaks.
  const classify = (triggered) => {
    if (hasLevels) {
      const v = toNum(triggered);
      if (v != null) {
        if (v >= enterLevel) return "on";
        if (v <= exitLevel) return "off";
        return "band"; // between bars — ambiguous, do not confirm either transition
      }
    }
    return triggered ? "on" : "off";
  };

  return {
    // The VETO rule (reflex supremacy). onboardStop ALWAYS wins: if the (debounced) onboard reflex says stop,
    // the result is stop regardless of the offboard GO. Otherwise follow the offboard intent.
    arbitrate({ onboardStop = false, offboardGo = false } = {}) {
      if (onboardStop) return { action: "stop", by: "onboard-veto" };
      return { action: offboardGo ? "go" : "stop", by: offboardGo ? "offboard" : "idle" };
    },

    // Hysteresis debounce on the raw reflex trigger. Feed each raw read (boolean, or numeric if levels are set).
    // Enters stop only after `enterHold` consecutive triggered reads (or a reading >= enterLevel held that long);
    // exits only after `exitHold` consecutive clear reads. A strobe at the threshold never toggles the output.
    // Returns the stable debounced stop boolean.
    debounce(triggered, _now) {
      const c = classify(triggered);
      if (c === "on") { onStreak += 1; offStreak = 0; }
      else if (c === "off") { offStreak += 1; onStreak = 0; }
      else { onStreak = 0; offStreak = 0; } // hysteresis band: hold state, neither transition confirmed
      if (!stopped && onStreak >= eHold) stopped = true;
      else if (stopped && offStreak >= xHold) stopped = false;
      return stopped;
    },

    // Read-only: the current stable debounced stop state.
    stable() { return stopped; },

    // Streak introspection for tracing/tests.
    streaks() { return { onStreak, offStreak }; },

    snapshot() { return { stopped, onStreak, offStreak }; },
    restore(s) {
      if (!s) return;
      stopped = !!s.stopped;
      onStreak = Math.max(0, s.onStreak | 0);
      offStreak = Math.max(0, s.offStreak | 0);
    },
  };
}
