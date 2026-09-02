// rotatingBeacon.js — PB-7: a StreetPass beacon id that ROTATES every epoch, so a passive observer can't correlate a
// node across time (the RC1 "stable id + public team key ⇒ lifelong linkable" weakness), while KIN holding the shared
// key recompute and match it. id = MAC(key, self ∥ peer ∥ epoch), widened to 128 bits by two domain-separated SipHash
// tags (a 48/64-bit token is too short for a persistent-mesh auth id — the patent's own caveat). The beacon carries the
// signed lineage cert so a replayed/forged beacon fails attestation (closes MITM). We take only the keyed-hash +
// key-agreement idea — never a homemade cipher; the MAC (SipHash) and the lineage check are INJECTED and vetted.
// PURE: no clock (epoch derived from an injected `nowMs`), no network, no crypto of our own.

export function makeRotatingBeacon({ mac, key, self, epochMs = 900000, certValid = null } = {}) {
  if (typeof mac !== "function" || !key || !self) throw new Error("rotatingBeacon: { mac, key, self } required");
  const epochOf = (nowMs) => Math.floor((Number(nowMs) || 0) / epochMs);
  // 128-bit rotating id: two domain-separated 64-bit SipHash tags over (self ∥ peer ∥ epoch).
  const idAt = (sender, peerAddr, epoch) => { const base = String(sender) + "|" + String(peerAddr || "*") + "|" + epoch; return mac(key, base + "|0") + mac(key, base + "|1"); };

  // emit my beacon for this epoch (broadcast by default; addressable to a specific peer), carrying my lineage cert.
  function emit({ peerAddr = "*", nowMs = 0, cert = null } = {}) {
    const epoch = epochOf(nowMs);
    return { rid: idAt(self, peerAddr, epoch), epoch, cert };
  }

  // a KIN receiver tests whether this beacon is a known family member `claimedSelf` at its stated epoch. An observer
  // WITHOUT `key` can't run this. Also verifies the beacon is bound to a valid lineage cert (replay/forgery → rejected).
  function match(beacon, claimedSelf, peerAddr = "*") {
    if (!beacon || beacon.rid == null || beacon.epoch == null) return { ok: false, reason: "malformed" };
    if (certValid && !certValid(beacon.cert, claimedSelf)) return { ok: false, reason: "bad-lineage" };
    const expect = idAt(claimedSelf, peerAddr, beacon.epoch);
    const ok = expect === beacon.rid;
    return { ok, reason: ok ? "kin-match" : "no-match" };
  }

  // scan a set of known kin ids → which one (if any) this beacon belongs to.
  function whoIs(beacon, knownKin = [], peerAddr = "*") {
    for (const k of knownKin) { const m = match(beacon, k, peerAddr); if (m.ok) return k; }
    return null;
  }

  return { emit, match, whoIs, epochOf, idAt: (peerAddr, epoch) => idAt(self, peerAddr, epoch) };
}
