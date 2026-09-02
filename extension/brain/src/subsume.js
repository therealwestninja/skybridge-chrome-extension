// subsume.js — a Brooks-style SUBSUMPTION controller: the clean GENERAL form of the ad-hoc arc-preemption
// that reflexArbiter.js already does by hand. Rather than hard-coding "onboard reflex vetoes offboard intent",
// this is a REGISTRY of layered behaviors. Each layer has a `guard(context)` and a `priority`. On decide(),
// the HIGHEST-priority layer whose guard fires SUBSUMES (suppresses) every lower layer's output — exactly the
// Brooks subsumption/suppression node, where an upper layer replaces a lower layer's signal on the wire.
//
// HOW THIS GENERALIZES reflexArbiter: reflexArbiter's "REFLEX SUPREMACY" (onboard STOP beats offboard GO) and the
// project's arc preemptions (CARE preempts, FALL preempts) are all just "a higher layer that, when its guard is
// true, wins over the ordinary behavior". Express them here as high-priority safety/care layers over an ordinary
// base layer. The safety layer subsuming the ordinary layer IS the arc preemption — proven in the test.
//
// SUPPRESSION HOLD (design choice, echoes reflexArbiter's Schmitt anti-strobe): when a layer PREEMPTS (takes
// control from a different layer than last frame), it is granted a bounded suppression window `holdMs`. Within
// that window a preempting layer keeps control even if a *lower* layer's guard flickers on/off — so control does
// not chatter frame-to-frame at a threshold. The hold NEVER lets a lower layer suppress a higher one, and it
// NEVER blocks an EQUAL-or-HIGHER priority layer from taking over (safety can always still preempt) — so the hold
// is stabilization of ordinary behavior, not a clamp that could trap a live safety response. holdMs=0 disables it.
// GUARDRAIL: the base "ordinary" layer always exists (priority -Infinity, guard always true) so decide() can
// never return a dead no-behavior state; safety/care layers sit strictly ABOVE it; preemption is graduated + held,
// never a hard oscillating clamp.

const toNum = (x) => (Number.isFinite(Number(x)) ? Number(x) : null);

export function makeSubsume({ now = 0, holdMs = 0, base = null } = {}) {
  const hold = Math.max(0, toNum(holdMs) || 0);

  // The always-present base/ordinary layer. Lowest possible priority, guard always true → never a dead state.
  const baseLayer = {
    name: (base && base.name) || "ordinary",
    priority: -Infinity,
    guard: (base && typeof base.guard === "function") ? base.guard : () => true,
    action: base ? base.action : null,
    safety: false,
  };

  const layers = [baseLayer];        // registry; baseLayer stays at index 0 conceptually (kept sorted on decide)
  let winner = null;                 // name of the layer that currently holds control
  let heldUntil = -Infinity;         // suppression-hold expiry (injected-now ms); control of `winner` is held until here
  let lastNow = toNum(now) || 0;

  const byName = (name) => layers.find((l) => l.name === name) || null;

  function register(layer) {
    if (!layer || typeof layer.name !== "string" || !layer.name) {
      throw new Error("subsume.register: layer needs a string name");
    }
    if (layer.name === baseLayer.name && layer !== baseLayer) {
      throw new Error(`subsume.register: name "${layer.name}" is reserved for the base layer`);
    }
    if (typeof layer.guard !== "function") {
      throw new Error("subsume.register: layer needs a guard(context) function");
    }
    if (byName(layer.name) && byName(layer.name) !== baseLayer) {
      throw new Error(`subsume.register: duplicate layer name "${layer.name}"`);
    }
    layers.push({
      name: layer.name,
      priority: toNum(layer.priority) ?? 0,
      guard: layer.guard,
      action: ("action" in layer) ? layer.action : null,
      safety: !!layer.safety,
    });
    return api;
  }

  // Highest-priority-first ordering. Ties broken by registration order (stable), which keeps decide deterministic.
  function ordered() {
    return layers
      .map((l, i) => ({ l, i }))
      .sort((a, b) => (b.l.priority - a.l.priority) || (a.i - b.i))
      .map((x) => x.l);
  }

  // The core subsumption decision. Returns the winning layer + the lower layers that ALSO wanted to fire
  // (i.e. were subsumed/suppressed by the winner).
  function decide(context = {}, opts = {}) {
    const n = toNum(opts.now);
    const t = n != null ? n : lastNow;
    lastNow = t;

    const ord = ordered();

    // Which layers' guards fire on this context? (base always does.)
    const firing = ord.filter((l) => {
      try { return !!l.guard(context); } catch { return false; }
    });

    // The natural (un-held) winner: highest-priority firing layer. base guarantees firing is non-empty.
    const natural = firing[0];

    let win = natural;

    // SUPPRESSION HOLD: if we still hold control for the previous winner, and that winner's guard is STILL firing,
    // it keeps control against LOWER-priority challengers — but an EQUAL-or-HIGHER priority firing layer always
    // preempts it (safety is never trapped below by a hold). holdMs=0 disables this entirely.
    if (hold > 0 && winner && t < heldUntil) {
      const held = byName(winner);
      const heldFiring = held && firing.includes(held);
      if (held && heldFiring && natural.priority < held.priority) {
        win = held; // the natural winner is strictly lower → the held layer suppresses it, no flap
      }
    }

    // Did control change hands to a DIFFERENT layer than we held? That is a preemption → (re)arm the hold window.
    if (win.name !== winner) {
      winner = win.name;
      heldUntil = hold > 0 ? t + hold : -Infinity;
    } else if (hold > 0 && win.priority > (natural.priority)) {
      // still the held layer winning over a lower challenger — keep the existing window (do not extend forever)
    }

    // Subsumed = every OTHER firing layer strictly below the winner (they wanted to fire but were suppressed).
    const subsumed = firing
      .filter((l) => l.name !== win.name && l.priority < win.priority)
      .map((l) => l.name);

    return {
      layer: win.name,
      action: win.action,
      priority: win.priority,
      safety: win.safety,
      subsumed,
      held: win.name !== natural.name,   // true when the suppression hold overrode the natural winner
      now: t,
    };
  }

  // Introspection: the registry ordered highest-first (names only), for tracing/tests.
  function stack() { return ordered().map((l) => l.name); }

  function serialize() {
    return {
      v: 1,
      winner,
      heldUntil: (heldUntil === -Infinity) ? null : heldUntil,
      lastNow,
      holdMs: hold,
    };
  }

  function restore(s) {
    if (!s) return api;
    winner = (typeof s.winner === "string") ? s.winner : null;
    heldUntil = (s.heldUntil == null) ? -Infinity : (toNum(s.heldUntil) ?? -Infinity);
    lastNow = toNum(s.lastNow) || 0;
    return api;
  }

  const api = { register, decide, stack, serialize, restore,
    // read-only peeks
    holdMs: hold,
    current() { return winner; },
  };
  return api;
}
