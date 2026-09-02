// heartbeat.js — the HEARTBEAT WATCHDOG for the offboard/onboard split (Cluster J). Defends the "phantom-limb
// lag switch" / resonance-catastrophe attack: an attacker who can DELAY the brain↔body return packet doesn't need to
// forge anything — a stale-but-valid command is enough. The cerebellar forward-model on the onboard side keeps
// correcting errors from an old world-state; by the time the correction lands the world has moved, so the next
// correction overshoots the other way and the body oscillates itself into a fall (a resonance catastrophe).
//
// The insight (mirrors cascadeFault's "freeze BEFORE the tampered directive drives the motors"): the onboard side must
// NEVER TRUST A STALE BRAIN. Freshness is a safety property, not a QoS nicety. If the last offboard response is older
// than a critical age — whether because a response measured too old a round-trip, or because NO response has arrived at
// all within the window — we SEVER the link and drop to a local safe-mode reflex controller. Better a dumb-but-current
// onboard reflex than a smart-but-late remote brain fighting a world that no longer exists.
//
// MECHANISM (deterministic, dependency-free; the caller supplies a monotonic `now` clock in ms — NEVER Date.now):
//   • stamp(now)            — the onboard side records that it dispatched a request to the offboard brain; returns a
//                             token carrying { id, sentAt } so the eventual response can be matched to its send time.
//   • received(sentAt, now) — a response came back. Round-trip ageMs = now - sentAt. Update lastResponseAt / lastAge and
//                             fold ageMs into the latency EWMA. A FRESH response (ageMs ≤ tCritical) re-links.
//   • check(now)            — the watchdog tick, wired every control cycle. SEVER (severed=true, mode="safe-mode") if
//                             now - lastResponseAt > tCritical (silence) OR the last measured ageMs > tCritical (a
//                             response arrived but was already too old). Returns { severed, mode, ageMs, sinceResponse }.
//   • reconnect(now)        — an explicit re-link on a fresh valid response (mode back to "linked").
//   • mode()/severed()      — read the current posture: "linked" | "safe-mode".
//
// Style matches beaconSilence.js (mode/snapshot shapes) and cascadeFault.js (permits-style gate, caller-supplied clock,
// no Math.random / no Date.now). Small helpers only (clamp, ema).
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, Number(x) || 0));

// Exponential moving average — the running latency stat for telemetry. First sample seeds it exactly.
const ema = (prev, sample, alpha) => (prev == null ? sample : prev + alpha * (sample - prev));

export function makeHeartbeat(opts = {}) {
  const {
    tCritical = 100,   // ms: a link is stale (and must be severed) once the freshest response is older than this
    alpha = 0.2,       // EWMA smoothing for the latency telemetry stat
  } = opts;

  const tCrit = Math.max(0, Number(tCritical) || 0);
  const a = clamp(alpha, 0, 1);

  let seq = 0;               // monotonic token id counter (deterministic; no randomness)
  let linked = true;         // effective posture: true ⇒ "linked", false ⇒ "safe-mode" (severed)
  let lastResponseAt = null; // `now` at which the most recent response was RECEIVED
  let lastAge = null;        // round-trip ageMs of the most recent response
  let latencyEwma = null;    // smoothed round-trip latency for telemetry

  const modeOf = () => (linked ? "linked" : "safe-mode");

  return {
    // The onboard side is about to dispatch a request to the offboard brain — record the send time so the eventual
    // response can be aged against it. Returns a token; pass token.sentAt (or the raw sentAt) back to received().
    stamp(now = 0) {
      const id = ++seq;
      const sentAt = Number(now) || 0;
      return { id, sentAt };
    },

    // A response from the offboard brain came back. `sentAt` is the time the matching request was dispatched (from the
    // stamp() token); ageMs is the round-trip. Updates freshness + latency telemetry. A fresh response (ageMs ≤ tCritical)
    // re-links a severed body; a stale one is recorded but does NOT re-link — check() will (re)sever on it.
    received(sentAt = 0, now = 0) {
      const t = Number(now) || 0;
      const ageMs = Math.max(0, t - (Number(sentAt) || 0));
      lastResponseAt = t;
      lastAge = ageMs;
      latencyEwma = ema(latencyEwma, ageMs, a);
      if (ageMs <= tCrit) linked = true;   // fresh return closes the loop
      return { ageMs, fresh: ageMs <= tCrit, latency: +(latencyEwma).toFixed(3) };
    },

    // THE WATCHDOG TICK — wire this every control cycle. Two independent staleness conditions each force safe-mode:
    //   (1) SILENCE: no response has landed within tCritical of `now` (now - lastResponseAt > tCritical), and
    //   (2) LATE RETURN: the most recent response, when it did land, was already older than tCritical (lastAge > tCritical).
    // Either ⇒ SEVER (drop to the local reflex controller). When neither holds, the link is (re)affirmed as linked.
    // Never-heard-from-yet (no response ever) counts as silence once `now` exceeds tCritical.
    check(now = 0) {
      const t = Number(now) || 0;
      const sinceResponse = lastResponseAt == null ? Infinity : Math.max(0, t - lastResponseAt);
      const silent = sinceResponse > tCrit;
      const late = lastAge != null && lastAge > tCrit;
      if (silent || late) linked = false;
      else linked = true;
      return {
        severed: !linked,
        mode: modeOf(),
        ageMs: lastAge,
        sinceResponse: sinceResponse === Infinity ? null : sinceResponse,
      };
    },

    // Explicit re-link on a fresh valid response — folds it in like received() and forces linked. Use when the caller
    // has an authenticated fresh packet in hand and wants to close the loop immediately rather than wait for check().
    reconnect(sentAt = 0, now = 0) {
      const t = Number(now) || 0;
      const ageMs = Math.max(0, t - (Number(sentAt) || 0));
      lastResponseAt = t;
      lastAge = ageMs;
      latencyEwma = ema(latencyEwma, ageMs, a);
      linked = ageMs <= tCrit;   // only a genuinely fresh packet re-links
      return { severed: !linked, mode: modeOf(), ageMs };
    },

    // Read-only posture.
    mode() { return modeOf(); },
    severed() { return !linked; },
    latency() { return latencyEwma == null ? null : +(latencyEwma).toFixed(3); },
    lastAge() { return lastAge; },

    snapshot() {
      return { seq, linked, lastResponseAt, lastAge, latencyEwma };
    },
    restore(s) {
      if (!s) return;
      seq = Math.max(0, s.seq | 0);
      linked = s.linked !== false;
      lastResponseAt = s.lastResponseAt == null ? null : (Number(s.lastResponseAt) || 0);
      lastAge = s.lastAge == null ? null : Math.max(0, Number(s.lastAge) || 0);
      latencyEwma = s.latencyEwma == null ? null : (Number(s.latencyEwma) || 0);
    },
  };
}
