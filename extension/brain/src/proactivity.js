// proactivity.js — the urge to reach out FIRST. Every other path in this brain is reactive: the user speaks, the brain
// answers. This is the one place the brain acts on its OWN internal state. It reads the felt drives (chiefly the
// connection need built by `drives.js`) and how long it's been quiet, and decides whether to initiate contact — gated
// by a cooldown and a minimum silence so a felt need becomes a gentle reaching-out, never nagging. This is what makes
// the drives load-bearing all the way to autonomous behaviour: a brain that can WANT something can now ACT on it
// unprompted. (The DECISION lives here; the WORDS come from `mind.initiate` — brain governs, mouth speaks.)

export function makeProactivity({
  urgeThreshold = 0.5,          // reach out once the urge clears this
  cooldownMs = 6 * 3600e3,      // don't reach out again within 6h of the last unprompted line (no nagging)
  minSilenceMs = 20 * 60e3,     // only after a real lull — never interrupt an active conversation
  driveWeight = 1.4,            // how much the felt need drives the urge
  timeWeight = 0.5,             // how much sheer silence drives it
  pendingWeight = 0.8,          // how much a concrete pending follow-up (a stale-but-significant relationship / open thread) drives it
  timeFullMs = 24 * 3600e3,     // silence saturates its contribution at ~a day
} = {}) {
  let lastInitiateAt = null;

  // The urge to reach out = the dominant felt need's pressure + how long it's been quiet + any concrete PENDING follow-up
  // (a significant belief gone stale, or an open thread — from world.followups()). `drives` may be the drives faculty
  // (we call dominant()) or a plain {name, pressure} readout. `pending` is the top follow-up salience in [0,1]. Returns
  // the decision + a legible urge/reason, still gated by minSilence + cooldown so it never nags.
  function consider({ drives = null, silenceMs = 0, now = null, pending = 0 } = {}) {
    const felt = drives && typeof drives.dominant === "function" ? drives.dominant() : (drives || null);
    const drivePressure = felt && typeof felt.pressure === "number" ? felt.pressure : 0;
    const timePart = Math.min(1, Math.max(0, silenceMs) / timeFullMs);
    const pend = Math.min(1, Math.max(0, pending));
    const urge = driveWeight * drivePressure + timeWeight * timePart + pendingWeight * pend;
    const sinceInitiate = now != null && lastInitiateAt != null ? now - lastInitiateAt : Infinity;
    const initiate = urge >= urgeThreshold && silenceMs >= minSilenceMs && sinceInitiate >= cooldownMs;
    const reason = pend > drivePressure && pend > timePart ? "follow-up" : (felt ? felt.name : "time");
    return { initiate, urge: +urge.toFixed(3), drive: felt ? felt.name : null, reason };
  }

  function noteInitiated(now) { if (now != null) lastInitiateAt = now; }

  return {
    consider, noteInitiated,
    lastInitiate: () => lastInitiateAt,
    snapshot() { return { lastInitiateAt }; },
    restore(s) { if (s) lastInitiateAt = s.lastInitiateAt ?? null; },
  };
}
