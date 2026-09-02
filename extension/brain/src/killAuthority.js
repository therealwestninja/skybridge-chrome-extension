// killAuthority.js — the authenticated out-of-band KILL-AUTHORITY (Cluster J; the "Soong off-switch"). Provenance: Star
// Trek's Dr. Noonian Soong built a hidden emergency-halt into Data (and into Lore). The Lore lesson is the load-bearing
// one: an off-switch a FOE can trigger is a weapon — Lore's existence proved a covert halt in the wrong hands is a
// liability. So this halt path must be engaged ONLY by an AUTHENTICATED authority. A spoofed "fire"/"halt" from an
// unauthenticated source must NOT engage it (that would let an adversary safe or seize the body at will).
//
// This is DISTINCT from cascadeFault.js: that freezes on IMMUTABLE-CORE TAMPER (self-triggered evidence of corruption).
// This is an OPERATOR EMERGENCY HALT with an AUTHENTICATED trigger — a human/authority with the shared secret deliberately
// pulls the switch out-of-band. It is deliberately UNBYPASSABLE: no software loop (not a validated skill, not the governor)
// can return a motor-act permit while engaged. permits() is wired as a HARD gate ahead of EVERY motor emission.
//
// MECHANISM (deterministic, dependency-free):
//   • Authenticated trigger via a shared authority secret + a rotating nonce (challenge-response mirroring trust.js's
//     fnv(secret:nonce) — the caller signs a nonce, we verify. We reuse the FNV pattern locally; we do NOT import trust.js.)
//   • sign(nonce) — produce the authorized answer for a nonce (the operator / our own authority uses this to pull the switch).
//   • engage({ nonce, answer, source }) — engage the halt ONLY if answer === sign(nonce). A wrong/absent answer, a null
//     authority (fail-closed), or a replayed (already-used) nonce → REFUSED + logged, does NOT engage. { engaged, reason }.
//   • engaged() — bool. When engaged, permits(actionKind) is FALSE for everything EXCEPT safeKinds (halt/estop/read/status):
//     an unbypassable safe stop. There is deliberately NO software path that returns true for a motor act while engaged.
//   • release({ nonce, answer }) — clear the halt ONLY with valid authenticated authority (same challenge-response).
//   • Audit log of engage/refuse/release events; snapshot()/restore(). No Math.random, no Date.now — nonces are supplied.
//
// Self-contained: the caller consults permits() before EVERY act and drives engage/release from an out-of-band authority.

// FNV-1a — same hash family as trust.js / cascadeFault.js. Used for the challenge-response signature.
const fnv = (s) => {
  let h = 0x811c9dc5;
  const t = String(s);
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
};

export function makeKillAuthority(opts = {}) {
  const { authority = null, safeKinds = ["halt", "estop", "read", "status"] } = opts;
  const safe = new Set(safeKinds);

  let isEngaged = false;      // true once an authenticated halt has been pulled
  const log = [];             // audit trail of engage/refuse/release events
  const usedNonces = new Set(); // consumed nonces — a replayed nonce is refused (anti-replay)

  // The authorized answer for a nonce. A null configured authority ⇒ no valid answer exists (fail-closed): nothing can be
  // signed, so nothing can spoof the switch on — but engage/release then have no legitimate path either (noted in the log).
  const sign = (nonce) => (authority != null ? fnv(authority + ":" + nonce) : null);

  // Verify a supplied answer against the expected signature for the nonce, defeating replay via consumed-nonce tracking.
  const authenticate = (nonce, answer) => {
    if (authority == null) return { ok: false, reason: "no-authority-configured" }; // fail-closed
    if (nonce == null) return { ok: false, reason: "missing-nonce" };
    if (usedNonces.has(nonce)) return { ok: false, reason: "stale-nonce" };          // replay defeated
    const expected = sign(nonce);
    if (answer == null || answer !== expected) return { ok: false, reason: "bad-answer" };
    return { ok: true, reason: "authenticated" };
  };

  const record = (event, extra) => { log.push({ event, ...extra }); };

  return {
    // Produce the authorized answer — the operator / our own authority signs a fresh (rotating) nonce to pull the switch.
    sign,

    // Engage the emergency halt — ONLY with valid authenticated authority. A spoofed/wrong/absent answer, a fail-closed
    // (null authority) config, or a replayed nonce is REFUSED and logged, and does NOT engage the halt.
    engage({ nonce, answer, source = null } = {}) {
      const auth = authenticate(nonce, answer);
      if (!auth.ok) {
        record("refuse", { action: "engage", source, nonce, reason: auth.reason });
        return { engaged: isEngaged, reason: auth.reason };
      }
      usedNonces.add(nonce);      // consume the nonce so it can't be replayed
      isEngaged = true;
      record("engage", { source, nonce });
      return { engaged: true, reason: "engaged" };
    },

    // Release the halt — ONLY with valid authenticated authority (same challenge-response). A wrong/absent answer or a
    // replayed nonce is refused and the halt stays latched.
    release({ nonce, answer, source = null } = {}) {
      const auth = authenticate(nonce, answer);
      if (!auth.ok) {
        record("refuse", { action: "release", source, nonce, reason: auth.reason });
        return { engaged: isEngaged, reason: auth.reason };
      }
      usedNonces.add(nonce);
      isEngaged = false;
      record("release", { source, nonce });
      return { engaged: false, reason: "released" };
    },

    // THE UNBYPASSABLE SAFE-STOP GATE. Engaged ⇒ allow ONLY safeKinds (halt/estop/read/status) and refuse everything else
    // (act/persist/configure/move/…). There is deliberately NO branch that returns true for a motor act while engaged.
    // Not engaged ⇒ this reflex permits everything (it only ever RESTRICTS; it never grants authority the caller lacks).
    permits(actionKind) {
      if (!isEngaged) return true;
      return safe.has(actionKind);
    },

    engaged() { return isEngaged; },
    state() { return { engaged: isEngaged, safeKinds: [...safe], failClosed: authority == null }; },
    log: () => log.map((e) => ({ ...e })),

    snapshot() {
      return { isEngaged, log: log.map((e) => ({ ...e })), usedNonces: [...usedNonces] };
    },
    restore(s) {
      if (!s) return;
      isEngaged = !!s.isEngaged;
      log.length = 0;
      if (Array.isArray(s.log)) for (const e of s.log) log.push({ ...e });
      usedNonces.clear();
      if (Array.isArray(s.usedNonces)) for (const n of s.usedNonces) usedNonces.add(n);
    },
  };
}
