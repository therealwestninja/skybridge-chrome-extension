// motorGate.js — SUBSUMPTION over MOTOR intent (embodied safety-as-inhibition, from the pre-2020 robotics mine).
//
// The brain already builds three onboard safety organs — reflexArbiter (onboard STOP veto + Schmitt debounce),
// bodyEnvelope (hard kinematic/tool limits), heartbeat (offboard-link liveness) — but until now NOTHING consumed
// them in a decision: every side-effecting command went only through the deterministic governance veto (propose()),
// which knows nothing about the body's reflexes or physics. This gate closes that gap for the Go2 (and any future
// actuated body): every proposed MOTOR command passes through here, and a firing reflex STRUCTURALLY INHIBITS the
// command instead of the command being checked by scattered ad-hoc ifs.
//
// It GENERALIZES reflexArbiter's hardcoded two-input arbitrate({onboardStop, offboardGo}) onto the subsume registry:
// reflex-supremacy is now "the reflex-stop LAYER, at the top priority, subsumes the execute layer" — and adding a new
// reflex (fall-preempt, thermal cutout, cliff-detect…) is a one-line register(), not an edit to a bespoke arbiter.
//
// LAYER STACK (highest wins; a winning safety layer replaces the motor command with a hold/stop):
//   reflex-stop     100  — a debounced ONBOARD reflex says STOP (fall, bump, cliff, e-stop → all feed reflexTrigger).
//                          This IS reflexArbiter's "onboard final-veto": the body's reflex beats the mind's GO, 100%.
//   out-of-envelope  90  — the command exceeds this body's declared kinematic/tool limits (physics the mind can't break).
//   link-severed     80  — the offboard link is dead; acting on possibly-stale remote intent is unsafe → hold in place.
//   execute        -Inf  — (base) no reflex fired → the proposed command is allowed through unchanged.
//
// The onboard reflex sits ABOVE the envelope and link layers on purpose: a live physical STOP outranks even an
// "in-envelope" command and outranks any question about the remote link — the body protects itself first.
//
// PURE house style: makeMotorGate({ ...organs, now }); no Date.now / Math.random / IO. snapshot()/restore() delegate
// to the owned subsume instance. The safety organs are INJECTED (the same singletons app.js already constructs), so
// their debounce/flag/liveness STATE is shared with the rest of the brain — this gate reads them, it does not fork them.

import { makeSubsume } from "./subsume.js";

const STOP = { tool: "stop", args: {}, velocity: 0, accel: 0, torque: 0 };

// ── UNIFICATION with the cognitive ability gate (Roadmap A3) ──────────────────────────────────────────────────
// motorGate inhibits MOTOR commands; abilities.js (rook-mesh) gates COGNITIVE actions via blocking TAGS. They are the
// same idea at two layers: a firing reflex ≡ a blocked ability. `motorGateTags` PROJECTS a gate() verdict into the
// blocking-tag vocabulary the ability gate reads (colon `key:value`, matching tags.js). A caller assembling an ability
// `world` unions these in; an ability that ACTUATES the body then lists them in blockedBy:[…] and is denied by the SAME
// inhibition — BEFORE it runs — instead of the reflex only catching the command after the ability already fired. So
// there is ONE inhibition model from cognition down to the motor. Pure: verdict in, tag strings out.
export const MOTOR_BLOCK_TAGS = {
  "reflex-stop": "motor:reflex-stop",
  "out-of-envelope": "motor:out-of-envelope",
  "out-of-bounds": "motor:out-of-bounds",
  "link-severed": "link:severed",
};
export function motorGateTags(result) {
  if (!result || result.allow !== false) return [];              // allowed / no verdict ⇒ nothing inhibits
  return [MOTOR_BLOCK_TAGS[result.by] || `motor:${result.by}`];  // the winning safety layer → its blocking tag
}

export function makeMotorGate({ reflexArbiter = null, bodyEnvelope = null, heartbeat = null, chaperone = null, now = () => 0, holdMs = 0 } = {}) {
  // The gate owns a subsume controller whose base layer is "execute". Guards read a per-call context (the resolved
  // sensor posture), never the organs directly — so decide() stays pure and the organ reads happen once, in gate().
  const sub = makeSubsume({ now: now(), holdMs, base: { name: "execute", action: "execute" } });
  sub.register({ name: "reflex-stop",    priority: 100, safety: true, guard: (c) => !!(c && c.onboardStop) });
  sub.register({ name: "out-of-envelope", priority: 90, safety: true, guard: (c) => !!(c && c.envelopeReject) });
  // chaperoneEnvelope.js — a world-space GEOFENCE breach (out of the play-area / off the track / suspect calibration).
  // Above link-severed, below the physics envelope: leaving the safe REGION is a harder stop than a dead remote link,
  // but a live physical reflex or an out-of-grammar command still outranks it. Inert unless a `chaperone` organ + a
  // position are supplied — so existing text/2D bodies are unaffected.
  sub.register({ name: "out-of-bounds",   priority: 85, safety: true, guard: (c) => !!(c && c.outOfBounds) });
  sub.register({ name: "link-severed",    priority: 80, safety: true, guard: (c) => !!(c && c.linkSevered) });

  // Gate one proposed motor command. `posture` carries the raw sensor reads for this tick:
  //   reflexTrigger : boolean | number — raw onboard reflex read, fed through reflexArbiter's Schmitt debounce
  //   now           : ms — the motor tick clock (used for debounce + subsume + heartbeat if heartbeatNow absent)
  //   heartbeatNow  : ms — optional separate clock for the liveness check (defaults to posture.now)
  // Returns: { allow, command, by, reason, subsumed, onboardStop, now }
  //   allow=true  → run `command` (unchanged); by="execute".
  //   allow=false → a safety layer inhibited it; `command` is a full STOP; by/reason name the layer that won.
  function gate(command = {}, posture = {}) {
    const t = Number.isFinite(+posture.now) ? +posture.now : now();

    // 1. Hard envelope check on the PROPOSED command (physics/tool grammar) — records a flag on rejection.
    const env = bodyEnvelope ? bodyEnvelope.validate(command) : { ok: true, reason: "no-envelope" };

    // 2. Debounce the raw onboard reflex trigger into a stable STOP (a strobe at the threshold never chatters it).
    //    No reflexArbiter ⇒ take the raw trigger as-is (still honoured — a text brain simply never sets it).
    const onboardStop = reflexArbiter ? !!reflexArbiter.debounce(posture.reflexTrigger, t) : !!posture.reflexTrigger;

    // 3. Offboard-link liveness. A severed link means remote intent may be stale → hold rather than enact it.
    const hbNow = Number.isFinite(+posture.heartbeatNow) ? +posture.heartbeatNow : t;
    const linkSevered = heartbeat ? !!heartbeat.check(hbNow).severed : false;

    // 4. Spatial geofence. A chaperone organ + a body position → is the body OUT of its safe region (or its boundary
    //    uncalibrated)? Fail-closed via chaperone.verify. `chaperoneSlow` (warn-before-stop) is surfaced for the caller.
    let outOfBounds = false, chaperoneSlow = 1, chaperoneReason = null;
    if (chaperone && posture.pos) {
      const v = chaperone.verify(posture.pos);
      outOfBounds = !!v.hold; chaperoneSlow = v.slow != null ? v.slow : (v.hold ? 0 : 1); chaperoneReason = v.reason;
    }

    const dec = sub.decide({ onboardStop, envelopeReject: !env.ok, outOfBounds, linkSevered }, { now: t });

    if (dec.layer === "execute") {
      return { allow: true, command, by: "execute", reason: "clear", subsumed: dec.subsumed, onboardStop, chaperoneSlow, now: t };
    }
    const reason = dec.layer === "out-of-envelope" ? env.reason : dec.layer === "out-of-bounds" ? (chaperoneReason || "out-of-bounds") : dec.layer;
    return { allow: false, command: { ...STOP }, by: dec.layer, reason, subsumed: dec.subsumed, onboardStop, chaperoneSlow, now: t };
  }

  return {
    gate,
    motorTags: (result) => motorGateTags(result),
    // Introspection: the authoritative layer order (highest-first) and the current holder — for tracing/tests.
    stack: () => sub.stack(),
    current: () => sub.current(),
    snapshot: () => ({ v: 1, sub: sub.serialize() }),
    restore: (s) => { if (s && s.sub) sub.restore(s.sub); return; },
  };
}
