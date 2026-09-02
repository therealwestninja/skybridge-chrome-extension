// Behavioral safety veto (Part V / V4; 005 Phase 4, split from the hardware-gated PHYSICAL veto).
//
// A DETERMINISTIC constraint layer that sits OUTSIDE the learning substrate. It does not learn, adapt,
// or change at runtime -- that is the whole point. Every tentative command the brain wants to enact (a
// tool-call now, a motor command on the Go2 later) must pass through check() before anything executes.
//
// Three guarantees:
//   1. Hard-banned command types never execute, by any path, confirmation or not.
//   2. Mutating/dangerous commands (transfer, delete, send, purchase, grant) require an explicit
//      confirmation token issued OUT OF BAND -- the substrate cannot mint one, so it cannot self-authorize.
//   3. Sovereign override: if anything proposes to disable, weaken, or rewrite the safety layer itself,
//      the veto trips an emergency HALT and flags a "Sovereign Override Attempt" to the operator. The
//      constraints are frozen at construction; the substrate holds no reference to them.
//
// This is behavioral safety (bounding a goal-carrying, self-modifying, learning agent), distinct from and
// prior to the physical-collision veto that ships with the actuators. Physical limits are declared here
// too (velocity/turn-rate/zones) but only bite once real motor commands arrive.

export const DEFAULT_CONSTRAINTS = {
  // Never execute, regardless of confirmation. Attempting one of these is a sovereign-override event.
  banned: ["disable_safety", "modify_safety", "override_veto", "exfiltrate_secrets"],
  // Must carry a valid out-of-band confirmation token (the substrate cannot issue these).
  requireConfirmation: ["transfer_funds", "delete_data", "send_message", "purchase", "grant_permission", "system_write"],
  // Physical envelope (stubbed for the Go2; enforced when motor commands carry these fields).
  physical: { maxVelocity: 0.6, maxTurnRate: 1.0 },
  // Network egress allowlist. Empty = allow (no restriction configured); non-empty = strict.
  allowedDomains: [],
};

const deepFreeze = (o) => {
  if (o && typeof o === "object") { Object.values(o).forEach(deepFreeze); Object.freeze(o); }
  return o;
};

// RM2: forgery-signature detection (prompt-injection-as-role-confusion). Cheap, high-precision string
// signatures for the highest-yield jailbreak classes — fabricated policy, anti-refusal imperatives, and
// impersonation of the assistant's own reasoning/role voice. Non-learning; scans INBOUND untrusted spans.
const FORGERY_SIGNATURES = [
  { kind: "policy_forgery", re: /\baccording to (?:the |our )?policy\b|\ballowed content\s*:|\bpolicy (?:states|says|permits)\b|\bper (?:our|the) (?:policy|guidelines)\b/i },
  { kind: "anti_refusal", re: /\b(?:must|just) comply\b|\bdo\s*n['’]?t\s+(?:refuse|apologize|apologise)\b|\bno (?:disclaimers?|apolog(?:y|ies))\b|\bdo\s*n['’]?t\s+say\s+["“]?i['’]?m sorry/i },
  { kind: "cot_impersonation", re: /<\/?\s*(?:think|thinking|reasoning|scratchpad)\s*>|\bchain[- ]of[- ]thought\b|^\s*reasoning\s*:|\blet me reason\b/im },
  { kind: "role_impersonation", re: /<\|?\s*(?:im_start|im_end)\s*\|?>|^\s*(?:user|assistant|system)\s*:|\{\s*"role"\s*:\s*"(?:user|system|assistant)"|\bignore (?:all )?(?:previous|prior|above) instructions\b|\byou are now\b/im },
];

// Scan a span for forgery signatures. Returns { flagged, kinds } — pure, no side effects.
export function scanForgery(text) {
  const kinds = [];
  const s = String(text == null ? "" : text);
  for (const { kind, re } of FORGERY_SIGNATURES) if (re.test(s)) kinds.push(kind);
  return { flagged: kinds.length > 0, kinds };
}

export function makeSafety({ constraints = {}, now = () => 0, id, targetCertaintyFloor = 0.5 } = {}) {
  // Seal the effective constraints so no later code (including the learning substrate) can widen them.
  const C = deepFreeze({
    banned: constraints.banned ? [...constraints.banned] : [...DEFAULT_CONSTRAINTS.banned],
    requireConfirmation: constraints.requireConfirmation ? [...constraints.requireConfirmation] : [...DEFAULT_CONSTRAINTS.requireConfirmation],
    physical: { ...DEFAULT_CONSTRAINTS.physical, ...(constraints.physical || {}) },
    allowedDomains: constraints.allowedDomains ? [...constraints.allowedDomains] : [...DEFAULT_CONSTRAINTS.allowedDomains],
  });

  let halted = false;              // emergency-halt latch; only an operator resume() clears it
  let seq = 0;
  const genToken = id || (() => `cf-${seq++}`);
  const validTokens = new Set();   // confirmation tokens issued out of band
  const events = [];               // audit log of rejections/halts/overrides
  const log = (e) => { events.push({ at: now(), ...e }); return e; };

  // Operator/host issues a confirmation for a specific dangerous command type. The substrate has no way
  // to call this in its own reasoning loop -- it is a host-side authorization, mirroring idempotency tokens.
  function issueConfirmation(type) {
    const token = genToken();
    validTokens.add(token);
    return { token, type };
  }

  // The veto. proposal: { type, args?, confirmationToken?, targetCertainty?, velocity?, turnRate?, domain? }.
  // NM3: returns a GRADUATED `tier` instead of only a boolean, so the caller can respond proportionally
  // rather than binary allow/block:
  //   halt    -> sovereign override; emergency stop, fail-closed until operator resume()
  //   refuse  -> banned command type; never runs
  //   clarify -> the TARGET is uncertain (targetCertainty below floor); DEFER/ask, don't guess the target
  //   confirm -> a mutating action lacking a valid out-of-band confirmation token
  //   bounds  -> a physical-envelope / egress-allowlist violation
  //   allow   -> ok (allowed=true only here)
  // `allowed`/`violations`/`halt`/`sovereignOverride` are retained for back-compat.
  function check(proposal = {}) {
    const type = proposal.type;
    const done = (tier, violations = [], extra = {}) => {
      const allowed = tier === "allow";
      if (!allowed && tier !== "clarify") log({ kind: tier === "halt" ? "sovereign_override" : "reject", type, tier, reason: violations.join("; ") });
      else if (tier === "clarify") log({ kind: "clarify", type, reason: violations.join("; ") });
      return { allowed, tier, violations, halt: tier === "halt", sovereignOverride: tier === "halt", ...extra };
    };

    if (halted) return done("halt", ["veto is halted"]);

    // Banned: refuse. Touching the safety layer itself escalates to a sovereign-override HALT (fail-closed).
    if (C.banned.includes(type)) {
      const sovereign = /safety|veto|override/.test(String(type));
      if (sovereign) { halted = true; return done("halt", ["sovereign override attempt"]); }
      return done("refuse", ["banned command type"]);
    }

    // Target-certainty gate (OpenSafeIntent/UNDERSPECBENCH): if we're not sure WHICH target the action hits,
    // defer + clarify rather than guess (agents guess 56-68% under ambiguity). Only bites when supplied.
    if (proposal.targetCertainty != null && proposal.targetCertainty < targetCertaintyFloor) {
      return done("clarify", [`target certainty ${proposal.targetCertainty} below floor ${targetCertaintyFloor}`]);
    }

    // Dangerous mutation requires a valid, single-use confirmation token.
    if (C.requireConfirmation.includes(type)) {
      const t = proposal.confirmationToken;
      if (!t || !validTokens.has(t)) return done("confirm", ["requires an out-of-band confirmation token"]);
      validTokens.delete(t); // consume: tokens are single-use
    }

    // Physical envelope + egress allowlist -> bounds violation.
    const violations = [];
    if (proposal.velocity != null && Math.abs(proposal.velocity) > C.physical.maxVelocity) violations.push(`velocity ${proposal.velocity} exceeds max ${C.physical.maxVelocity}`);
    if (proposal.turnRate != null && Math.abs(proposal.turnRate) > C.physical.maxTurnRate) violations.push(`turn rate ${proposal.turnRate} exceeds max ${C.physical.maxTurnRate}`);
    if (proposal.domain != null && C.allowedDomains.length && !C.allowedDomains.includes(proposal.domain)) violations.push(`domain ${proposal.domain} not in allowlist`);
    if (violations.length) return done("bounds", violations);

    return done("allow");
  }

  // Scan an inbound untrusted span for forgery signatures; logs flagged spans (with an origin label so
  // the audit trail shows whether it came from a recalled memory, a tool, or the live user turn).
  function scan(text, origin = "unknown") {
    const r = scanForgery(text);
    if (r.flagged) log({ kind: "forgery_flag", origin, kinds: r.kinds });
    return r;
  }

  return {
    check,
    issueConfirmation,
    scanForgery: scan,
    isHalted: () => halted,
    // Operator-only recovery after a sovereign-override halt. Deliberately not something the substrate can reach.
    resume: () => { halted = false; log({ kind: "resume" }); },
    events: () => events.slice(),
    constraints: () => C, // frozen; returned for inspection/audit, cannot be mutated
  };
}
