// supervisor.js — an authoritative override that sits between the decider and actuation, and is safe to run on
// EVERY tick without the agent noticing.
//
// THE CONTRACT, and the reason this works: a supervisor may only CLAMP MAGNITUDE ALONG THE EFFORT AXIS. It may
// make the body slower; it may never make it faster, and it may never redirect it. Steering is never touched.
// That single rule is what stops the supervisor and the agent fighting each other — the failure mode that makes
// naive shared control unusable.
//
// Three zones with a dead band:
//   free    speed <= cap*bandFraction   the agent is completely unconstrained
//   band    speed <= cap                throttle authority trimmed, no braking imposed
//   over    speed >  cap                throttle cut, brake raised PROPORTIONALLY to the violation
// Proportional (not bang-bang) means the intervention fades to nothing exactly as the agent complies.
//
// Handback is stateless: caps live in a keyed map, and DELETING THE KEY releases control. There is no state
// machine to unwind, so a handback can never get stuck half-done.
//
// Every threshold is a caller-overridable option — the source design came from a binary whose constants we could
// not read, so these defaults are ours to justify and tune, not measurements.

import { clamp01, num } from "./math.js";

export function makeSupervisor({
  bandFraction = 0.9,     // dead band ends at cap*bandFraction; below it the agent is untouched
  bandAccelMax = 0.5,     // ceiling on throttle inside the warning band
  brakeGain = 0.25,       // brake demand per unit of speed over the cap (proportional response)
} = {}) {
  const caps = new Map();

  return {
    // A cap must be a finite positive number. Anything else is ignored rather than applied, because a NaN cap
    // would otherwise brake the body permanently with no way to diagnose it.
    setCap(id, cap) {
      const c = num(cap, NaN);
      if (Number.isFinite(c) && c > 0) caps.set(String(id), c);
      return this;
    },
    clearCap(id) { caps.delete(String(id)); return this; },        // <- the entire handback mechanism
    hasCap: (id) => caps.has(String(id)),
    capFor: (id) => (caps.has(String(id)) ? caps.get(String(id)) : null),

    // Clamp an action for one body. Returns a NEW action plus which zone it landed in.
    supervise(id, action = {}, speed = 0) {
      const accel = clamp01(num(action.accel, 0));
      const brake = clamp01(num(action.brake, 0));
      const steer = num(action.steer, 0);            // read, echoed, NEVER modified
      const cap = caps.get(String(id));
      const v = num(speed, 0);

      if (!(cap > 0)) return { accel, brake, steer, zone: "free", capped: false };

      if (v > cap) {
        const demanded = clamp01((v - cap) * brakeGain);
        return { accel: 0, brake: Math.max(brake, demanded), steer, zone: "over", capped: true };
      }
      if (v > cap * bandFraction) {
        return { accel: Math.min(accel, bandAccelMax), brake, steer, zone: "band", capped: true };
      }
      return { accel, brake, steer, zone: "free", capped: false };
    },

    size: () => caps.size,
    reset() { caps.clear(); },
  };
}
