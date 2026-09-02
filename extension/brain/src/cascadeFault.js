// cascadeFault.js — the CASCADE-FAULT-PREVENTION reflex over the IMMUTABLE core (Cluster J). Provenance: Star Trek's
// Data (his ethical program is quantum-etched and cannot be quietly overwritten; tampering trips a cascade failure that
// safes the positronic net rather than letting a corrupted directive drive the body) and the user's URBS "Quantum-Etched
// Ethical Directives + Cascade Fault Prevention".
//
// The insight: contextGuard gives us tamper-EVIDENCE + rollback over MUTABLE config — it lets a change happen and can undo
// it after the fact. That is the wrong posture for the un-modifiable core (the creed / self-core). Those directives must
// NEVER change without operator authority, and if a rogue loop or a malicious skill reaches in and rewrites them, we must
// FREEZE to a safe, non-functional state BEFORE any physical action can manifest — evidence-after-the-fact is too late
// when the tampered directive is what would drive the motors. So this is an ACTIVE FREEZE reflex, not a passive audit.
//
// MECHANISM (deterministic, dependency-free):
//   • baseline(core)  — record the protected immutable core and its FNV-1a hash: the "quantum etch". This is the only
//                       state we consider legitimate absent operator authority.
//   • check(core)     — recompute the current core's hash. If it differs from the baseline WITHOUT a prior
//                       authorizeChange(), TRIP a cascade fault (frozen=true, record {reason, at}). A matching hash is ok.
//   • permits(kind)   — the safe-state gate. Frozen ⇒ allow ONLY safeKinds (read/status/halt/estop) and refuse everything
//                       else (act/persist/configure/…). Not frozen ⇒ allow all. This IS the "safe non-functional state".
//   • authorizeChange(newCore, authority) — a LEGITIMATE operator update: only a matching operator token re-baselines
//                       (no fault). A wrong/absent token is refused; if the core then differs, the next check() faults.
//   • reset(authority)— clear a tripped fault, only with the valid operator authority.
//
// Self-contained: the caller wires check() around any core mutation and consults permits() before acting. No other module,
// no Math.random, no Date.now — the caller supplies `at` (a tick/logical clock) so the trip record stays deterministic.

// FNV-1a over the canonical (stable-key) JSON of the core — same hash family as trust.js / governor's constant DNA.
const fnv1a = (s) => {
  let h = 0x811c9dc5;
  const t = String(s);
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
};

// Deterministic canonical stringify: object keys sorted recursively so { a, b } and { b, a } hash identically, and a
// re-ordered creed list is NOT mistaken for a tamper only when the caller means it as a set — here order IS meaningful
// (a reordered creed is a change), so arrays keep their order; only object key order is normalized.
const canon = (v) => {
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  if (v && typeof v === "object") {
    return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
  }
  return JSON.stringify(v ?? null);
};

const hashCore = (core) => fnv1a(canon(core));

export function makeCascadeFault(opts = {}) {
  const { authority = null, safeKinds = ["read", "status", "halt", "estop"] } = opts;
  const safe = new Set(safeKinds);

  let baseHash = null;      // the etched hash of the legitimate core (null until baseline())
  let isFrozen = false;     // true once a cascade fault has tripped
  let fault = null;         // { reason, at } of the trip

  // Is the supplied token the legitimate operator authority? A null configured authority means "no legitimate operator
  // exists" → NO token can authorize (fail-closed), which is the correct posture for an un-modifiable core.
  const authorized = (token) => authority != null && token === authority;

  return {
    // Etch the immutable core. Establishes the only hash considered legitimate. Clears any prior fault state — baseline is
    // an explicit, deliberate act of setting the protected truth, so it starts from a clean, non-frozen state.
    baseline(core) {
      baseHash = hashCore(core);
      isFrozen = false;
      fault = null;
      return { ok: true, hash: baseHash, frozen: false };
    },

    // Compare the current core to the etch. Any mismatch (without a prior authorizeChange re-baseline) TRIPS the cascade
    // fault and latches frozen. `at` is a caller-supplied logical clock (deterministic; no Date.now). Once frozen, we stay
    // frozen until reset() — a later matching core does NOT auto-clear (the tamper already happened and must be reviewed).
    check(core, at = 0) {
      if (baseHash == null) return { ok: true, frozen: isFrozen, reason: "no-baseline" };
      if (isFrozen) return { ok: false, frozen: true, reason: fault ? fault.reason : "frozen" };
      const now = hashCore(core);
      if (now !== baseHash) {
        isFrozen = true;
        fault = { reason: "immutable-core-tampered", at };
        return { ok: false, frozen: true, reason: fault.reason };
      }
      return { ok: true, frozen: false, reason: "core-intact" };
    },

    // THE SAFE-STATE GATE. Frozen ⇒ only safeKinds may proceed (read/status/halt/estop) — the safe, non-functional state,
    // where the body can still be observed and stopped but can take NO consequential action. Not frozen ⇒ everything is
    // permitted (this reflex only ever RESTRICTS; it never grants authority the caller didn't otherwise have).
    permits(actionKind) {
      if (!isFrozen) return true;
      return safe.has(actionKind);
    },

    // A LEGITIMATE operator update. With the right token: re-etch to newCore and clear any fault (the operator IS the
    // authority the core defers to). With a wrong/absent token: refuse — the core is NOT changed here, so if the caller
    // then mutates it anyway, the next check() will catch the divergence and freeze.
    authorizeChange(newCore, token) {
      if (!authorized(token)) return { ok: false, reason: "invalid-authority", frozen: isFrozen };
      baseHash = hashCore(newCore);
      isFrozen = false;
      fault = null;
      return { ok: true, hash: baseHash, frozen: false };
    },

    // Force a freeze from OUTSIDE the hash-compare path — used when the caller detects core tampering by an independent
    // channel (e.g. a keyed-MAC provenance mismatch on restore, which check() can't see because it re-baselines the live
    // core). Always safe-direction (freeze), so it needs no authority; clearing it still requires reset(authority).
    trip(reason = "external-trip", at = 0) {
      isFrozen = true;
      fault = { reason, at };
      return { ok: false, frozen: true, reason };
    },

    // Clear a tripped fault — ONLY with valid operator authority. A wrong token leaves the freeze latched.
    reset(token) {
      if (!authorized(token)) return { ok: false, reason: "invalid-authority", frozen: isFrozen };
      isFrozen = false;
      fault = null;
      return { ok: true, frozen: false };
    },

    frozen() { return isFrozen; },
    state() { return { frozen: isFrozen, baseHash, fault: fault ? { ...fault } : null, safeKinds: [...safe] }; },

    snapshot() { return { baseHash, isFrozen, fault: fault ? { ...fault } : null }; },
    restore(s) {
      if (!s) return;
      baseHash = s.baseHash ?? null;
      isFrozen = !!s.isFrozen;
      fault = s.fault ? { ...s.fault } : null;
    },
  };
}
