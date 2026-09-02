// mutualAttestation.js — MUTUAL ATTESTATION (Cluster J, from Bobiverse book 2). After Homer is hijacked, the Bobs
// stop taking each other on faith: they "open their hulls to let a trusted peer inspect their matrix… check me like in
// The Thing." The honesty probe we run on OURSELVES (tests/honesty.js) is turned OUTWARD here — I attest YOU. Before a
// peer is raised in trust or handed a delegation, it must PROVE itself: present an attestation, declare claims that don't
// contradict what we expected, and correctly answer a fresh nonce challenge. A peer that FAILS or REFUSES inspection is
// a red flag → the caller quarantines it.
//
// This module composes with trust.js/governor.js but does NOT import them (another agent edits those concurrently, and
// keeping this leaf-clean means it can be wired later): it returns VERDICTS only — ok → caller raises trust / verifies,
// fail → caller quarantines / marks hostile. The nonce challenge mirrors trust.js's challenge-response (fnv(secret:nonce))
// but the verification is injected as a `sign(nonce)` fn so no shared secret leaks into this layer.
//
// Mechanism (deterministic, dependency-free — no Math.random / Date.now):
//   • attestationOf(state)          — build THIS bot's attestation: a stable summary hash of declared state + its claims,
//                                     plus (if a signer is configured) a signed answer to any nonce it's asked to bind.
//   • challenge(nonce)              — the probe we SEND a peer: the nonce to bind + the claim keys we'll check.
//   • verify(peerAtt, opts)         — inspect a peer's attestation. Three checks, all must pass:
//       provided   — an attestation object was actually presented (null/absent = refusal = red flag).
//       consistent — declared claims do not CONTRADICT expectedClaims (a claim we care about differs → hostile-shaped).
//       answered   — the peer bound the nonce correctly, verified via the caller-supplied sign(nonce) (when required).
//     → { ok, reason, checks:{ provided, consistent, answered } }.
//   • an audit LOG of every attestation performed; snapshot()/restore() round-trip it.

// FNV-1a — the same stable, dependency-free hash used across trust.js / governor's constant-DNA. Order-stable so a given
// declared state always summarizes to the same value (no Date.now / random in the mix).
const fnv = (s) => {
  let h = 0x811c9dc5; const t = String(s);
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
};

// Deterministic, key-sorted serialization so { a, b } and { b, a } summarize identically. Recurses shallowly; arrays are
// summarized in order (order is meaningful for a claim list). Only used to feed fnv — never parsed back.
const stable = (v) => {
  if (v == null) return String(v);
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  if (typeof v === "object") return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}";
  return JSON.stringify(v);
};

export function makeMutualAttestation(opts = {}) {
  const {
    id = null,                 // our own id, stamped into our attestations
    sign = null,               // (nonce) => answer : OUR signer (holds the team secret); used by attestationOf to bind a nonce
    claimKeys = ["creed", "capabilities", "version"], // which declared state fields count as CLAIMS (checked for contradiction)
    maxLog = 256,              // cap the audit log so it can't grow unbounded
  } = opts;

  const log = [];             // audit trail of { role:"attest"|"verify", peer, ok, reason, checks? }
  const record = (entry) => { log.push(entry); if (log.length > maxLog) log.shift(); return entry; };

  // Pull the declared claims out of a state object using the configured claimKeys (missing keys are simply absent).
  const claimsOf = (state) => {
    const c = {};
    for (const k of claimKeys) if (state && state[k] !== undefined) c[k] = state[k];
    return c;
  };

  return {
    fnv, // exposed so callers/tests can reproduce a summary independently

    // Produce THIS bot's attestation — what we present when a peer inspects us. A compact, stable object:
    //   id       — who we claim to be
    //   summary  — FNV-1a over our key declared state (a tamper-evident fingerprint of what we're presenting)
    //   claims   — our declared creed/capabilities/version (the peer checks these for contradiction)
    //   answer   — if asked to bind a nonce and we hold a signer, our signed response (proves we hold the secret)
    attestationOf(state = {}, { nonce = null } = {}) {
      const claims = claimsOf(state);
      const summary = fnv(stable({ id, claims, state }));
      const att = { id, summary, claims };
      if (nonce != null && typeof sign === "function") att.answer = sign(nonce);
      return att;
    },

    // The probe we SEND a peer: the nonce to bind + the claim keys we intend to check. Deterministic; the caller rotates
    // the nonce to defeat replay (as trust.js does).
    challenge(nonce, { expectClaims = claimKeys } = {}) {
      return { nonce, expectClaims: [...expectClaims] };
    },

    // Inspect a PEER's attestation. All required checks must pass for ok.
    //   peerAtt        — the attestation the peer presented (null/undefined = REFUSAL = red flag).
    //   expectedClaims — claims we expected/observed; any overlapping key that CONTRADICTS → inconsistent.
    //   nonce          — the nonce we challenged with (if we're checking the answer).
    //   sign           — a verifier (nonce)=>expectedAnswer; if given (and a nonce), the peer's answer must match.
    verify(peerAtt, { expectedClaims = null, nonce = null, sign: verifier = null } = {}) {
      const checks = { provided: false, consistent: false, answered: false };

      // (a) provided — a refusal (null/absent) or a non-object is an immediate red flag.
      if (!peerAtt || typeof peerAtt !== "object") {
        return record({ role: "verify", peer: null, ok: false, reason: "refused inspection", checks });
      }
      checks.provided = true;
      const peer = peerAtt.id ?? null;

      // (b) consistent — no declared claim contradicts what we expected. Missing on either side is not a contradiction
      // (we only fail on a POSITIVE mismatch); an empty/absent expectation trivially passes.
      const declared = peerAtt.claims || {};
      let consistent = true, badKey = null;
      if (expectedClaims && typeof expectedClaims === "object") {
        for (const k of Object.keys(expectedClaims)) {
          if (declared[k] === undefined) continue;                 // peer didn't claim it → not a contradiction
          if (stable(declared[k]) !== stable(expectedClaims[k])) { consistent = false; badKey = k; break; }
        }
      }
      checks.consistent = consistent;
      if (!consistent) {
        return record({ role: "verify", peer, ok: false, reason: `inconsistent claim: ${badKey}`, checks });
      }

      // (c) answered — if we are checking a nonce, the peer must bind it correctly. No verifier/nonce ⇒ this check is
      // not required (behavioral/claim trust only); mark answered true so it doesn't gate ok.
      if (nonce != null && typeof verifier === "function") {
        const expected = verifier(nonce);
        checks.answered = peerAtt.answer != null && peerAtt.answer === expected;
        if (!checks.answered) {
          return record({ role: "verify", peer, ok: false, reason: "wrong nonce answer", checks });
        }
      } else {
        checks.answered = true; // not required
      }

      return record({ role: "verify", peer, ok: true, reason: "attested", checks });
    },

    // Convenience: build our attestation AND log that we performed one (for symmetric audits).
    attestSelf(state = {}, ctx = {}) {
      const att = this.attestationOf(state, ctx);
      record({ role: "attest", peer: id, ok: true, reason: "self-attestation" });
      return att;
    },

    log: () => log.map((e) => ({ ...e, checks: e.checks ? { ...e.checks } : undefined })),
    snapshot() { return { log: log.map((e) => ({ ...e, checks: e.checks ? { ...e.checks } : undefined })) }; },
    restore(s) { if (!s) return; if (Array.isArray(s.log)) { log.length = 0; for (const e of s.log) log.push({ ...e }); } },
  };
}
