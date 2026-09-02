// lineage.js — bot IDENTITY + GENEALOGY via a signed birth-certificate hash-chain.
//
// WHY THIS EXISTS. manifest.js gives a bot a portable capability passport and a
// radio-free beacon, but the identity it carries is lossy: idCode = fnv(id)&0xFF is an
// 8-bit hint that collides constantly, and nothing stops a bot from CLAIMING any id,
// kind, or creed it likes. For a swarm to trust "you are who you say" and "we are kin",
// identity must be (a) stable + unique, (b) VERIFIABLE (catch imposters), and (c)
// RELATIONAL (measure shared ancestry). This module provides all three.
//
// THE MECHANISM — a birth certificate that is a link in a hash chain, signed by the
// parent with the shared TEAM SECRET (a SipHash-2-4 MAC from mac.js):
//   * Each cert commits to its PARENT's cert via parentCertHash = hashCert(parentCert).
//     Change any ancestor and every descendant's hash link breaks — tamper-evident lineage.
//   * Each cert is SIGNED by the parent under the team secret. Only a secret-holder can
//     mint a legitimate child, so you cannot forge your way into the family (imposter caught).
//   * `line` denormalizes the ancestor-id chain [progenitor, …, parent] so relatedness is
//     O(1) from the cert alone — no cert store needed to tell kin from stranger.
//
// The crib is the Bobiverse replicant family tree: Bob-1 (genesis, gen 0) → Riker (mint,
// gen 1) → Homer (gen 2) …. A grandchild can prove it descends from Bob-1 without trusting
// anyone in between, because the chain of hashes + signatures is self-authenticating.
//
// Deterministic, dependency-free (imports only ./mac.js), browser-safe. NO Math.random /
// Date.now — the caller supplies `at` as a logical clock. The module is stateless except
// for `self` (this bot's own identity); certs ARE the state.

import { mac, verify as macVerify } from "./mac.js";

// ---- canonical serialization -------------------------------------------------
// Stable JSON: object keys sorted recursively, arrays keep their order. Two certs with
// the same content always serialize to the same string, so hashes/sigs are reproducible.
function canon(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canon).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canon(value[k])).join(",") + "}";
}

// Strip the signature so we hash/sign only the cert BODY (the thing the sig attests to).
function certBody(cert) {
  const { sig, ...body } = cert || {};
  return body;
}

/**
 * makeLineage({ teamSecret, self }) — a lineage signer/verifier for one team.
 *   teamSecret : the shared MAC key. Two bots are "same team" iff both certs verify under it.
 *   self       : this bot's own identity { id, name, gen, cert } once known (null until minted).
 */
export function makeLineage({ teamSecret, self = null } = {}) {
  if (teamSecret == null) throw new Error("makeLineage: teamSecret required");
  let me = self;

  /** hashCert(cert) -> stable MAC over the canonical cert BODY (sig excluded). THE CHAIN LINK. */
  function hashCert(cert) {
    if (!cert) return null;
    return mac(teamSecret, canon(certBody(cert)));
  }

  // Sign a fully-populated body (no sig field) and return the complete cert.
  function sign(body) {
    return { ...body, sig: mac(teamSecret, canon(body)) };
  }

  /** genesis({id,name,body,at}) -> a gen-0 progenitor cert (no parent), team-signed. */
  function genesis({ id, name, body = "text-brain", at = 0 } = {}) {
    if (id == null) throw new Error("genesis: id required");
    return sign({
      id,
      name: name ?? String(id),
      gen: 0,
      parentId: null,
      parentCertHash: null,
      line: [],
      body,
      at,
    });
  }

  /** mint({id,name,body,at}) -> a birth cert for a CHILD of `self`, team-signed. */
  function mint({ id, name, body = undefined, at = 0 } = {}) {
    if (!me || !me.cert) throw new Error("mint: self unset — call setSelf() or construct with self first");
    if (id == null) throw new Error("mint: id required");
    return sign({
      id,
      name: name ?? String(id),
      gen: me.cert.gen + 1,
      parentId: me.cert.id,
      parentCertHash: hashCert(me.cert),
      line: [...me.cert.line, me.cert.id],
      body: body !== undefined ? body : me.cert.body,
      at,
    });
  }

  /**
   * verify(cert, { parentCert }) -> { ok, reason }.
   *   1. sig is a valid team MAC over the cert body.
   *   2. structural: gen-0 certs must have null parentId + parentCertHash + empty line;
   *      non-genesis must have both parent fields present and a non-empty line ending in parentId.
   *   3. if parentCert supplied, the chain link is intact:
   *      parentCertHash === hashCert(parentCert), parentId === parentCert.id, gen === parentCert.gen+1.
   */
  function verify(cert, { parentCert = null } = {}) {
    if (!cert || typeof cert !== "object") return { ok: false, reason: "no-cert" };
    if (typeof cert.sig !== "string") return { ok: false, reason: "no-sig" };
    if (!macVerify(teamSecret, canon(certBody(cert)), cert.sig)) return { ok: false, reason: "bad-sig" };

    const genesis = cert.gen === 0;
    if (genesis) {
      if (cert.parentId !== null || cert.parentCertHash !== null)
        return { ok: false, reason: "genesis-has-parent" };
      if (!Array.isArray(cert.line) || cert.line.length !== 0)
        return { ok: false, reason: "genesis-nonempty-line" };
    } else {
      if (typeof cert.gen !== "number" || cert.gen < 0)
        return { ok: false, reason: "bad-gen" };
      if (cert.parentId == null || cert.parentCertHash == null)
        return { ok: false, reason: "missing-parent" };
      if (!Array.isArray(cert.line) || cert.line.length === 0)
        return { ok: false, reason: "empty-line" };
      if (cert.line[cert.line.length - 1] !== cert.parentId)
        return { ok: false, reason: "line-parent-mismatch" };
      if (cert.line.length !== cert.gen)
        return { ok: false, reason: "line-length-mismatch" };
    }

    if (parentCert) {
      if (cert.parentId !== parentCert.id) return { ok: false, reason: "parent-id-mismatch" };
      if (cert.gen !== parentCert.gen + 1) return { ok: false, reason: "gen-mismatch" };
      if (cert.parentCertHash !== hashCert(parentCert)) return { ok: false, reason: "hash-link-broken" };
    }

    return { ok: true, reason: "ok" };
  }

  /**
   * verifyChain(certs) -> { ok, brokenAt }. certs ordered progenitor → … → leaf.
   * Each cert must verify against its predecessor as a parent; brokenAt = index of the
   * first cert that fails (−1 if the whole chain is intact).
   */
  function verifyChain(certs) {
    if (!Array.isArray(certs) || certs.length === 0) return { ok: false, brokenAt: 0 };
    for (let i = 0; i < certs.length; i++) {
      const parentCert = i === 0 ? null : certs[i - 1];
      const r = verify(certs[i], { parentCert });
      if (!r.ok) return { ok: false, brokenAt: i, reason: r.reason };
    }
    return { ok: true, brokenAt: -1 };
  }

  /**
   * relatedness(a, b) -> { relation, sharedAncestorId, sameTeam }.
   * relation ∈ self | parent | child | sibling | ancestor | descendant | cousin | stranger,
   * computed from ids + the `line` ancestor arrays. sameTeam = both certs verify under our team.
   */
  function relatedness(a, b) {
    const sameTeam = verify(a).ok && verify(b).ok;
    const aLine = Array.isArray(a?.line) ? a.line : [];
    const bLine = Array.isArray(b?.line) ? b.line : [];

    // Deepest (last-listed) common ancestor id, if any.
    const bSet = new Set(bLine);
    let sharedAncestorId = null;
    for (let i = aLine.length - 1; i >= 0; i--) {
      if (bSet.has(aLine[i])) { sharedAncestorId = aLine[i]; break; }
    }

    let relation;
    if (a?.id === b?.id) {
      relation = "self";
    } else if (b.parentId === a.id) {
      relation = "child";                       // a is b's parent
    } else if (a.parentId === b.id) {
      relation = "parent";                       // a is b's child (a's parent is b)
    } else if (aLine.includes(b.id)) {
      relation = "descendant";                   // b is an ancestor of a → a descends from b
    } else if (bLine.includes(a.id)) {
      relation = "ancestor";                     // a is an ancestor of b
    } else if (a.parentId != null && a.parentId === b.parentId) {
      relation = "sibling";
    } else if (sharedAncestorId != null) {
      relation = "cousin";                       // share ancestry deeper up, not parent/lineal
    } else {
      relation = "stranger";
    }

    return { relation, sharedAncestorId, sameTeam };
  }

  /** setSelf({id,name,gen,cert}) — update this bot's own identity after minting it. */
  function setSelf(next) {
    me = next;
    return me;
  }

  return {
    genesis,
    mint,
    hashCert,
    verify,
    verifyChain,
    relatedness,
    setSelf,
    get self() { return me; },
  };
}
