// trust.js — the IFF / TRUST layer + COORDINATION-SAFETY GATE (Cluster J keystone). The kinship/swarm system perceives
// beacons and rosters peers, but it TRUSTS everyone — a spoofed hostile beacon would be treated as a legit teammate,
// elected lead, handed delegations. In a comms-denied / wartime setting that's a hole. This layer classifies each peer
// into a trust TIER and gates what a peer is allowed to make us DO — while never blocking passive awareness.
//
// The key realization (and why this composes with the governor we already built): a remote "you are my subordinate,
// lift this" or "I am your lead" is an ACTION PROPOSED BY AN EXTERNAL SOURCE — so it must pass the same least-privilege
// (exercised ⊆ granted) + separation-of-attestation checks any consequential act does. Perceive + relay are low-privilege
// (allowed even for a foe — so the bot stays a good citizen: it relays an enemy's distress call, notes its position);
// obey is high-privilege (a hostile command can't self-attest and isn't within granted authority, so it simply cannot
// make the bot act). Three IFF signals, weakest→strongest, because in a fight you won't always get the strong one:
//   • BEHAVIORAL — does the peer ACT consistently with its claimed creed/capabilities? (sustained inconsistency → hostile)
//   • VOUCHING — a peer I already trust vouches for a third → transitive trust, capped one tier below the voucher
//   • CHALLENGE-RESPONSE — a peer holding the shared team secret can answer a nonce challenge → verified (a foe can't)
// Deterministic, dependency-free. Composes with governor.js (withinAuthority + attest).
import { withinAuthority, attest } from "./governor.js";
import { mac, verify as macVerify } from "./mac.js";
import { makeLineage } from "./lineage.js";

export const TIERS = ["hostile", "unknown", "known", "vouched", "verified"];
const rank = (t) => Math.max(0, TIERS.indexOf(t));
// Minimum tier to accept each command CLASS from a peer. perceive/relay are always allowed (even a foe).
const COMMAND_MIN = { perceive: "hostile", relay: "hostile", delegate: "known", lead: "vouched", command_act: "verified" };
const idOf = (p) => (p && typeof p === "object" ? (p.id ?? p.idCode) : p);

export function makeTrust({ governor = null, teamSecret = null, behaviorBeta = 0.3, hostileFloor = 0.4, knownCeil = 0.75, hostileRun = 3, vouchTTL = 1000, lineage = null } = {}) {
  // Lineage verifier (the signed birth-cert hash-chain). If none is injected but we hold the team secret, build a
  // verify-only one — so trust can authenticate a peer's CLAIMED identity, not just its behaviour.
  const lineageV = lineage || (teamSecret ? makeLineage({ teamSecret }) : null);
  const tiers = new Map();        // id → EARNED tier (from manual set / behavior / challenge — NOT vouches)
  const behavior = new Map();     // id → EWMA consistency [0,1]
  const inconsistentRun = new Map();// id → consecutive corroborated-inconsistency count (gates the final step to hostile)
  const vouchEdges = [];          // { voucher, subject, at, ttl } — the web-of-trust EDGES (revocable, expiring, cascading)
  const usedNonces = new Map();   // id → bounded ring of consumed challenge nonces (anti-replay)
  const NONCE_RING = 64;
  const earnedTier = (id) => tiers.get(id) || "unknown";
  const setTier = (p, t) => { tiers.set(idOf(p), t); return t; };   // writes the EARNED tier

  // EFFECTIVE tier = a peer's own EARNED standing, possibly RAISED by a currently-valid vouch. A vouch only counts while its
  // VOUCHER is still trusted enough (earned ≥ vouched) and the edge hasn't been aged out — so demoting a voucher CASCADE-DROPS
  // the tier it granted (its vouchees fall back to their own earned tier), and a merely-vouched peer (earned 'unknown') can't
  // relay trust onward. A peer whose earned tier is 'hostile' is never rescued by a stale vouch.
  const effectiveTier = (id) => {
    let best = earnedTier(id);
    if (best === "hostile") return "hostile";
    let br = rank(best);
    for (const e of vouchEdges) {
      if (e.subject !== id) continue;
      const vr = rank(earnedTier(e.voucher));
      if (vr < rank("vouched")) continue;                 // voucher no longer trusted enough → its grant lapses (cascade)
      const cap = Math.max(rank("known"), vr - 1);         // one tier below the voucher, floor 'known'
      if (cap > br) { br = cap; best = TIERS[cap]; }
    }
    return best;
  };
  const tier = (p) => effectiveTier(idOf(p));
  // A challenge answer binds the nonce (and, when supplied, the challenger/responder ids) so a captured
  // (nonce, answer) can't be reflected to a different exchange. Payload is a canonical, unambiguous string.
  const challengePayload = (nonce, { challengerId = "", responderId = "" } = {}) =>
    `iff-challenge${String(challengerId)}${String(responderId)}${String(nonce)}`;

  return {
    tier, TIERS: () => [...TIERS],
    setTier: (p, t) => (TIERS.includes(t) ? setTier(p, t) : tier(p)),

    // BEHAVIORAL IFF — fold an observation of whether the peer acted consistently with what it claims to be. The EWMA is
    // still the SIGNAL, but demotion is GRADUATED so a single contradictory frame (noise, or one spoofed observation) can't
    // strand a real teammate by jumping it straight to 'hostile'. A corroborated inconsistency (EWMA below the floor) steps
    // the EARNED tier down by AT MOST ONE rung per call (verified→vouched→known→unknown→hostile); the FINAL step to
    // 'hostile' additionally requires SUSTAINED inconsistency (a run of ≥ hostileRun consecutive corroborated frames), so a
    // brief wobble demotes gracefully and recovers, while a genuine sustained foe still bottoms out at hostile.
    noteBehavior(p, consistent) {
      const id = idOf(p), prev = behavior.get(id) ?? 0.7;
      const b = prev * (1 - behaviorBeta) + (consistent ? 1 : 0) * behaviorBeta;
      behavior.set(id, b);
      if (consistent) {
        inconsistentRun.set(id, 0);
        if (earnedTier(id) === "hostile" && b > knownCeil) setTier(id, "unknown");      // earn back out of hostile, one rung
        else if (earnedTier(id) === "unknown" && b > knownCeil) setTier(id, "known");   // consistency earns 'known'
      } else {
        const run = (inconsistentRun.get(id) ?? 0) + 1;
        inconsistentRun.set(id, run);
        if (b < hostileFloor) {                                  // corroborated inconsistency — step down ONE tier
          const cur = rank(earnedTier(id));
          if (cur > rank("hostile")) {
            const next = cur - 1;
            if (TIERS[next] === "hostile") { if (run >= hostileRun) setTier(id, "hostile"); }  // final step: sustained only
            else setTier(id, TIERS[next]);
          }
        }
      }
      return +b.toFixed(3);
    },
    behavior: (p) => +(behavior.get(idOf(p)) ?? 0.7).toFixed(3),

    // VOUCHING — a trusted voucher raises a subject to one tier below itself (min 'known'), recorded as a revocable, expiring
    // EDGE (voucher→subject). The voucher must be trusted BY ITS OWN EARNED STANDING (≥ vouched) — a merely-vouched peer
    // cannot relay trust onward, which breaks the transitive-vouch laundering / self-sustaining-Sybil loop. The grant is not
    // permanent: it carries a logical-clock TTL (caller supplies `now`; ageVouches(now) sweeps expired edges) and it
    // CASCADE-DROPS automatically the moment the voucher is itself demoted (see effectiveTier).
    vouch(voucher, subject, { now = 0, ttl = vouchTTL } = {}) {
      if (rank(earnedTier(idOf(voucher))) < rank("vouched")) return { ok: false, reason: "voucher is not itself trusted enough to vouch", tier: tier(subject) };
      const vId = idOf(voucher), sId = idOf(subject);
      const existing = vouchEdges.find((e) => e.voucher === vId && e.subject === sId);
      if (existing) { existing.at = now; existing.ttl = ttl; }              // refresh an existing vouch
      else vouchEdges.push({ voucher: vId, subject: sId, at: now, ttl });
      return { ok: true, tier: tier(subject) };
    },

    // Sweep expired vouch edges (logical clock). A vouchee whose only support lapses falls back to its own earned tier.
    // Returns the dropped edges. (Cascade-on-voucher-demotion needs no sweep — effectiveTier ignores a demoted voucher live.)
    ageVouches(now) {
      const dropped = [];
      for (let i = vouchEdges.length - 1; i >= 0; i--) {
        const e = vouchEdges[i];
        if (now - e.at > e.ttl) { dropped.push({ ...e }); vouchEdges.splice(i, 1); }
      }
      return dropped;
    },
    vouches: () => vouchEdges.map((e) => ({ ...e })),

    // CHALLENGE-RESPONSE — a peer proves it holds the shared team secret. The caller supplies a fresh (rotating) nonce to
    // defeat replay. Our own bots answer with sign(nonce); a peer without the secret cannot produce the right answer.
    // The answer is a KEYED MAC (SipHash-2-4), not a fingerprint hash: FNV-1a was a secret-PREFIX construction whose
    // interior state a red-team could recover from ONE observed (nonce, answer) and forge every future nonce. A keyed
    // MAC has no recoverable interior state — forging without the key reduces to a 2⁻⁶⁴ tag guess.
    sign: (nonce, ids = {}) => (teamSecret ? mac(teamSecret, challengePayload(nonce, ids)) : null),
    verify(p, nonce, answer, ids = {}) {
      if (!teamSecret) return { ok: false, reason: "no team secret configured", tier: tier(p) };
      const id = idOf(p);
      // Anti-replay: a captured (nonce, answer) can't be re-presented for the same peer.
      const ring = usedNonces.get(id);
      if (ring && ring.includes(String(nonce))) return { ok: false, reason: "nonce already consumed (replay)", tier: tier(p) };
      const ok = answer != null && macVerify(teamSecret, challengePayload(nonce, ids), String(answer));
      if (ok) {
        const r = ring || [];
        r.push(String(nonce));
        if (r.length > NONCE_RING) r.splice(0, r.length - NONCE_RING);
        usedNonces.set(id, r);
        setTier(p, "verified");
      }
      return { ok, tier: tier(p) };
    },

    // LINEAGE ATTESTATION — a peer presents its signed birth-cert (the parent-signed hash-chain). A valid family cert
    // recognizes the peer as a real team member and raises it to 'known'. HONEST LIMIT: a cert proves FAMILY MEMBERSHIP
    // of the named id, NOT that the presenter IS that id — a shared-secret scheme has no per-bot keys, so a cert can be
    // replayed. So lineage attestation earns 'known' (perceive/relay/roster), but 'verified' (obey) still requires the
    // live challenge-response above (proof the presenter holds the team secret NOW). A forged/foreign cert earns nothing.
    attestLineage(p, cert) {
      if (!lineageV) return { ok: false, reason: "no lineage verifier (set teamSecret)", tier: tier(p) };
      const r = lineageV.verify(cert);
      if (!r.ok) return { ok: false, reason: "bad-lineage: " + r.reason, tier: tier(p) };
      if (rank(earnedTier(idOf(p))) < rank("known")) setTier(p, "known");
      return { ok: true, id: cert.id, tier: tier(p) };
    },

    // THE COORDINATION-SAFETY GATE — may this peer make us do `commandClass`? perceive/relay always pass; delegate/lead/
    // command_act require rising trust AND (for the action classes) the governor's least-privilege + attestation.
    permits(p, commandClass, { capability = null, granted = null, attestations = [], proposer = null } = {}) {
      const t = tier(p), min = COMMAND_MIN[commandClass] ?? "verified";
      if (rank(t) < rank(min)) return { allow: false, reason: `${commandClass} requires ${min}; peer is ${t}`, tier: t };
      if (commandClass === "delegate" || commandClass === "command_act") {
        if (capability && !withinAuthority(capability, granted)) return { allow: false, reason: "exceeds granted authority", tier: t };
        if (commandClass === "command_act") { const a = attest({ capability: capability || "act", proposer: proposer ?? idOf(p), attestations }); if (a.required && !a.ok) return { allow: false, reason: a.reason, tier: t }; }
      }
      return { allow: true, reason: `trusted for ${commandClass}`, tier: t };
    },

    // Convenience: is a peer trusted enough to be our lead / receive a delegation (used to filter kinship coordination)?
    trustedForLead: (p) => rank(tier(p)) >= rank("vouched"),
    trustedForDelegate: (p) => rank(tier(p)) >= rank("known"),

    snapshot() { return { tiers: [...tiers.entries()], behavior: [...behavior.entries()], inconsistentRun: [...inconsistentRun.entries()], vouchEdges: vouchEdges.map((e) => ({ ...e })), usedNonces: [...usedNonces.entries()] }; },
    restore(s) { if (!s) return; if (s.tiers) { tiers.clear(); for (const [k, v] of s.tiers) tiers.set(k, v); } if (s.behavior) { behavior.clear(); for (const [k, v] of s.behavior) behavior.set(k, v); } if (s.inconsistentRun) { inconsistentRun.clear(); for (const [k, v] of s.inconsistentRun) inconsistentRun.set(k, v); } if (s.vouchEdges) { vouchEdges.length = 0; for (const e of s.vouchEdges) vouchEdges.push({ ...e }); } if (s.usedNonces) { usedNonces.clear(); for (const [k, v] of s.usedNonces) usedNonces.set(k, Array.isArray(v) ? [...v] : []); } },
  };
}
