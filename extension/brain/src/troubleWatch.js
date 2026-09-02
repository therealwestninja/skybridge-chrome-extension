// troubleWatch.js — the failsafe layer: N independent watchdogs collapsed into ONE comparable danger scalar.
//
// Each watchdog is an integrator with an EVIDENCE-DRIVEN RESET: it accumulates dt while things look wrong and is
// zeroed the moment positive evidence arrives, so a momentary anomaly can never accumulate — you have to be
// continuously wrong. Each divides by its OWN patience, and the published danger is the MAX of those ratios, not the
// sum or the mean: "the worst thing wrong with me is how wrong I am". One bad axis must not be diluted by two
// healthy ones.
//
// `suppress(true)` zeroes every integrator, which is what makes the layer safe to run during its own recovery — the
// failsafe cannot re-fire on itself while the fix is in progress.
//
// Pure and deterministic: time is accumulated from the caller's dt, never read from a clock.
//
// EVERY threshold here is a caller-overridable option. The source material for this design came from a shipped
// binary whose constant pool we could not decode, so the defaults below are OUR plausible choices, not measured
// values. Tune them per body.

import { num } from "./math.js";

export function makeTroubleWatch({
  watchdogs = [],        // [{ name, limit (seconds), evidenceOk() -> bool }]
  armAt = 0.6,           // danger at/above which the layer ARMS (start slow preparation)
  disarmAt = 0.35,       // danger at/below which it DISARMS — strictly below armAt = a Schmitt trigger
  onFire = null,         // optional (name) => void, called once per crossing
} = {}) {
  if (!(armAt > disarmAt)) throw new Error("troubleWatch: armAt must be > disarmAt (Schmitt trigger)");

  const w = watchdogs.map((d) => ({
    name: String(d.name),
    limit: Math.max(1e-6, num(d.limit, 1)),
    evidenceOk: typeof d.evidenceOk === "function" ? d.evidenceOk : () => false,
    t: 0,
    fired: false,
  }));

  let suppressed = false;
  let armed = false;
  let danger = 0;
  let elapsed = 0;

  const zero = () => { for (const d of w) { d.t = 0; d.fired = false; } danger = 0; };

  return {
    // One tick. `dt` in seconds. Returns { danger, armed, fired[], suppressed }.
    tick(dt = 1 / 60) {
      const step = Math.max(0, num(dt, 0));
      elapsed += step;

      if (suppressed) { zero(); armed = false; return { danger: 0, armed: false, fired: [], suppressed: true }; }

      const fired = [];
      let worst = 0;
      for (const d of w) {
        let ok = false;
        try { ok = !!d.evidenceOk(); } catch { ok = false; }   // a throwing probe counts as no evidence
        if (ok) { d.t = 0; d.fired = false; }
        else d.t += step;

        const ratio = d.t / d.limit;
        if (ratio > worst) worst = ratio;
        if (d.t >= d.limit && !d.fired) {
          d.fired = true;
          fired.push(d.name);
          if (typeof onFire === "function") { try { onFire(d.name); } catch { /* never throw out of a tick */ } }
        }
      }
      danger = worst;

      if (!armed && danger >= armAt) armed = true;
      else if (armed && danger <= disarmAt) armed = false;

      return { danger, armed, fired, suppressed: false };
    },

    danger: () => danger,
    armed: () => armed,
    elapsed: () => elapsed,
    suppressed: () => suppressed,
    // Call with true whenever a recovery/teleport is in progress; false when it completes.
    suppress(on) { suppressed = !!on; if (suppressed) { zero(); armed = false; } },
    timers: () => w.map((d) => ({ name: d.name, t: d.t, limit: d.limit, ratio: d.t / d.limit })),
    reset() { zero(); armed = false; suppressed = false; elapsed = 0; },
  };
}

// A gate chain. Interventions are refused for many independent reasons (onboarding, a sanctioned stopped state,
// already recovering, session over). Keeping them in ONE ordered predicate — instead of scattered at call sites —
// means a refusal can always name itself, which is the difference between a diagnosable no-op and a mystery.
export function makeGate(gates = []) {
  return {
    check() {
      for (const g of gates) {
        let ok = false;
        try { ok = !!g.ok(); } catch { ok = false; }   // a gate that throws has not given permission
        if (!ok) return { ok: false, refusedBy: String(g.name) };
      }
      return { ok: true, refusedBy: null };
    },
    names: () => gates.map((g) => String(g.name)),
  };
}

// Cross-body escalation. One body recovering is normal; N bodies recovering inside a window means the ENVIRONMENT
// is the problem, and the response should escalate from per-body recovery to a system-wide conservative mode.
// Right now a single body failing repeatedly is invisible to the rest of the mind — this is the fix.
//
// `report(id)` is a liveness heartbeat: a body that stops reporting ages out of the roster rather than leaving a
// phantom armed (the dead-man's switch). Time accumulates from dt — no clock.
export function makeEscalation({
  count = 3,               // recoveries required inside the window
  windowSeconds = 60,      // sliding window width
  cooldownSeconds = 120,   // minimum gap between escalations, so it cannot oscillate
  staleSeconds = 10,       // a body silent for longer than this leaves the live roster
} = {}) {
  const events = [];       // [{ id, at }] — recovery events, pruned in place
  const seen = new Map();  // id -> last report time
  let elapsed = 0;
  let lastEscalatedAt = -Infinity;

  const prune = () => {
    while (events.length && elapsed - events[0].at > windowSeconds) events.shift();
    for (const [id, at] of seen) if (elapsed - at > staleSeconds) seen.delete(id);
  };

  return {
    tick(dt = 1 / 60) { elapsed += Math.max(0, num(dt, 0)); prune(); return { elapsed, fresh: events.length, live: seen.size }; },
    report(id) { seen.set(String(id), elapsed); },                       // liveness heartbeat
    recovery(id) { const k = String(id); events.push({ id: k, at: elapsed }); seen.set(k, elapsed); },

    // Ask to escalate. Returns { escalate, refusedBy, fresh }. ALWAYS names the refusing predicate.
    request(gate = null) {
      prune();
      if (events.length < count) return { escalate: false, refusedBy: "belowThreshold", fresh: events.length };
      if (elapsed - lastEscalatedAt < cooldownSeconds) return { escalate: false, refusedBy: "cooldown", fresh: events.length };
      if (gate) {
        const g = gate.check();
        if (!g.ok) return { escalate: false, refusedBy: g.refusedBy, fresh: events.length };
      }
      lastEscalatedAt = elapsed;
      return { escalate: true, refusedBy: null, fresh: events.length };
    },

    fresh: () => events.length,
    live: () => seen.size,
    elapsed: () => elapsed,
    reset() { events.length = 0; seen.clear(); elapsed = 0; lastEscalatedAt = -Infinity; },
  };
}
