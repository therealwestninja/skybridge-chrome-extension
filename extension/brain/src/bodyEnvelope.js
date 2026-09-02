// bodyEnvelope.js — PROPRIOCEPTIVE GROUNDING against the "codec type-confusion" attack. The body-agnostic core (the
// same being can drive a Go2, a UAV, a sub, or a text box — see manifest.js) has one dangerous seam: the init handshake
// that tells it which body it is in. An attacker who spoofs that handshake can convince the core it is driving a virtual
// sim, then issue intents a REAL legged chassis physically cannot honour — `teleport_to(x)`, `skip_animation`, a velocity
// past the servos, a torque past the joints. On real hardware these dereference nothing / trip an emergency-fold / drop
// the robot. The mind, mis-handshaked, cannot tell; only the ONBOARD side knows the metal.
//
// FIX: the onboard side holds a "body hash" — a physics envelope declaring what THIS physical chassis can actually do
// (limits + the tools that are/aren't valid for this body). Every motor intent the core issues is passed through
// validate() as a HARD gate BEFORE execution. An intent that names a tool this body can't perform, or that exceeds a
// declared physical limit, is REJECTED as "invalid-for-body" / "exceeds-<limit>". Repeated envelope violations raise a
// compromise flag — a core issuing physically-impossible commands is, by inference, compromised or mis-handshaked.
//
// Provenance: anti-type-confusion / proprioceptive grounding. Design creed: "the body defines its own limits; the mind
// may not exceed them." Mirrors governor.js withinAuthority/veto (a HARD gate, not a smooth one — physics is binary) and
// the FNV-1a body hash of manifest.js. Deterministic, dependency-free — no Math.random, no Date.now.

// FNV-1a 32-bit — same construction as manifest.js/governor lineage, so the body hash is stable & portable.
const fnv = (s) => { let h = 0x811c9dc5; const t = String(s); for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; };
const hex = (n, width) => (n >>> 0).toString(16).padStart(width, "0").slice(-width);
const num = (x) => (Number.isFinite(x) ? Number(x) : null);

// The physical limits a chassis reports about itself. A null limit means "not constrained by this envelope" (e.g. a text
// brain has no torque). Tool lists are the coarse locomotion/manipulation grammar the body supports; a forbidden tool is
// a hard tell of type-confusion ("teleport" / "skip_animation" belong to a sim, never to legs).
export function makeBodyEnvelope(opts = {}) {
  const {
    maxVelocity = null,      // m/s the servos can actually track
    maxAccel = null,         // m/s^2 the drivetrain can actually produce
    maxTorque = null,        // N·m the joints can actually hold
    allowedTools = null,     // if a non-empty list, ONLY these tools are valid for this body (allow-list)
    forbiddenTools = [],     // tools that are always invalid for this body (deny-list; wins over allow-list)
  } = opts;

  const env = {
    maxVelocity: num(maxVelocity),
    maxAccel: num(maxAccel),
    maxTorque: num(maxTorque),
    allowedTools: Array.isArray(allowedTools) && allowedTools.length ? [...new Set(allowedTools.map(String))] : null,
    forbiddenTools: [...new Set((forbiddenTools || []).map(String))],
  };

  let flags = 0;         // count of rejected (envelope-violating) intents — the compromise signal
  let lastReason = null; // reason of the most recent rejection

  // The body hash: a deterministic digest of the envelope the onboard trusts. Two chassis with the same declared physics
  // hash identically; any change to a limit or tool grammar changes the hash. Serialized canonically (sorted) so tool
  // ordering doesn't perturb it.
  const canonical = () => JSON.stringify({
    v: env.maxVelocity, a: env.maxAccel, t: env.maxTorque,
    allow: env.allowedTools ? [...env.allowedTools].sort() : null,
    forbid: [...env.forbiddenTools].sort(),
  });
  const hash = () => hex(fnv(canonical()), 8);

  const overLimit = (val, limit) => limit != null && val != null && val > limit;

  return {
    // HARD gate. intent = { tool, args?, velocity?, accel?, torque? }. Returns { ok, reason }.
    // Rejects (and flags) a tool this body can't perform, or a kinematic quantity past a declared limit.
    validate(intent = {}) {
      const tool = intent.tool == null ? null : String(intent.tool);

      // Tool grammar first — a forbidden/unknown tool is the clearest type-confusion tell.
      if (tool != null) {
        if (env.forbiddenTools.includes(tool)) return this._reject("invalid-for-body");
        if (env.allowedTools && !env.allowedTools.includes(tool)) return this._reject("invalid-for-body");
      }

      // Kinematic limits — physics the mind may not exceed.
      const v = num(intent.velocity), a = num(intent.accel), tq = num(intent.torque);
      if (overLimit(v, env.maxVelocity)) return this._reject("exceeds-velocity");
      if (overLimit(a, env.maxAccel))    return this._reject("exceeds-accel");
      if (overLimit(tq, env.maxTorque))  return this._reject("exceeds-torque");

      return { ok: true, reason: "in-envelope" };
    },

    // internal: record a rejection and return it.
    _reject(reason) { flags += 1; lastReason = reason; return { ok: false, reason }; },

    hash,
    // Read the current declared limits (a copy — the envelope is immutable from outside).
    envelope() {
      return {
        maxVelocity: env.maxVelocity, maxAccel: env.maxAccel, maxTorque: env.maxTorque,
        allowedTools: env.allowedTools ? [...env.allowedTools] : null,
        forbiddenTools: [...env.forbiddenTools],
      };
    },
    // The compromise counter — how many physically-impossible commands the core has issued. High ⇒ likely
    // compromised / mis-handshaked, not merely a one-off out-of-range request.
    flagged() { return flags; },
    lastReason() { return lastReason; },
    // Was this body compromised past a tolerance? (advisory helper for the onboard interpreter.)
    compromised(threshold = 3) { return flags >= threshold; },

    snapshot() { return { flags, lastReason }; },
    restore(s) { if (!s) return; flags = Math.max(0, s.flags | 0); lastReason = s.lastReason ?? null; },
  };
}
