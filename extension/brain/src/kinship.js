// kinship.js — the SOCIAL-IDENTITY ganglia: "is it me? are they like me? are we the same or different?", plus the
// swarm coordination that answer enables. Where council is the basal-ganglia action gate and theoryOfMind reads a
// USER, kinship reads other AGENTS running (or not running) our brain, via the radio-free manifest/beacon protocol
// (manifest.js). It maintains a ROSTER of perceived peers and answers three things about any of them:
//
//   • is-it-me   — self-recognition: is this beacon my OWN signature echoed back (an obstacle mirror, a loop)? If so it
//                  is NOT a peer — ignore it, so a bot never recruits itself or double-counts its own echo.
//   • like-me    — kind similarity: same model/species? (kin)
//   • same/diff  — a capability DIFF: what we share, what only I have, what only they have (complementarity) → a
//                  similarity score and a relation (self | kin | ally | complement | stranger).
//
// On top of the roster it does the coordination the user asked for: elect a team-lead (a first-responder that finds the
// helpers and leads), delegate a NEEDED capability to whoever can actually do it, and report what the assembled team
// can collectively do + what it still lacks. Crucially this is body-AGNOSTIC and timescale-aware: delegating "reach the
// survivor above" to a flyer and "reach the survivor below" to a diver is the SAME call — only the capability token and
// the peer's reaction timescale differ. Deterministic, dependency-free.
import { decodeBeacon } from "./manifest.js";

const jaccard = (a, b) => { if (!a.size && !b.size) return 1; let inter = 0; for (const x of a) if (b.has(x)) inter++; return inter / (a.size + b.size - inter); };
// The same FNV used by manifest.js to derive an 8-bit idCode from a full id — so a cert's full id can be matched against
// a beacon-perceived peer's lossy idCode (does this cert actually BELONG to the thing I'm looking at?).
const fnv = (s) => { let h = 0x811c9dc5; const t = String(s); for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; };
const idCodeOf = (id) => fnv(id) & 0xFF;
// A cert BELONGS to a perceived peer when its full id equals the peer's full id, or (beacon-only) hashes to the peer's idCode.
const certBelongsTo = (cert, o) => cert && cert.id != null && (o.id != null ? cert.id === o.id : o.idCode != null && idCodeOf(cert.id) === o.idCode);

// Normalize any perceived input (a full manifest, a decoded descriptor, or a raw beacon string) into a peer record.
function toPeer(input) {
  let d = input;
  if (typeof input === "string") d = decodeBeacon(input);
  if (!d) return null;
  return {
    id: d.id ?? null, idCode: d.idCode ?? (d.id != null ? null : null),
    name: d.name ?? "", kind: d.kind ?? null, kindCode: d.kindCode ?? null,
    embodiment: d.embodiment ?? null, timescale: d.timescale ?? "textual",
    creedCode: d.creedCode ?? (d.creed ? undefined : 0),
    caps: new Set(d.capabilities || []), capacities: d.capacities || {},
    interaction: typeof d.interaction === "number" ? d.interaction : 0,   // PB-4: how much the user is engaging THAT node (from its beacon) → wake arbitration
    fromBeacon: !!d.fromBeacon,
  };
}
// Two peers are the SAME individual if their id (when both known) or their short idCode matches.
const sameId = (a, b) => (a.id != null && b.id != null ? a.id === b.id : a.idCode != null && b.idCode != null && a.idCode === b.idCode);

export function makeKinship({ self, complementThreshold = 1 } = {}) {
  const me = toPeer(self);                       // my own manifest, normalized
  if (self && self.idCode != null) me.idCode = self.idCode;
  // encodeBeacon reads `.capabilities` (array); the peer stores `.caps` (Set). Mirror it via a getter so my own beacon
  // carries my real capabilities — and so it tracks live changes when tools bind/unbind caps (grounding I2).
  if (me) Object.defineProperty(me, "capabilities", { get() { return [...me.caps]; }, configurable: true });
  const roster = new Map();                       // key (id|idCode) → peer record

  // Compare a peer (any input form) against myself. Pure — does not touch the roster.
  const compare = (input) => {
    const o = toPeer(input);
    if (!o) return null;
    const isSelf = sameId(o, me);
    const shared = [...o.caps].filter((c) => me.caps.has(c));
    const mineOnly = [...me.caps].filter((c) => !o.caps.has(c));
    const theirsOnly = [...o.caps].filter((c) => !me.caps.has(c));
    const sameKind = o.kindCode != null && me.kindCode != null && o.kindCode === me.kindCode;
    const aligned = !!me.creedCode && o.creedCode != null && o.creedCode !== 0 && o.creedCode === me.creedCode;
    const similarity = +(0.7 * jaccard(me.caps, o.caps) + (sameKind ? 0.2 : 0) + (aligned ? 0.1 : 0)).toFixed(3);
    // Precedence: self > kin (my kind) > complement (they bring abilities I lack — the actionable coordination signal) >
    // ally (shared allegiance but nothing new to offer) > stranger. Complement outranks ally because a same-creed peer
    // that ALSO fills a capability gap is, for coordination, best read as the gap-filler.
    const relation = isSelf ? "self" : sameKind ? "kin" : theirsOnly.length >= complementThreshold ? "complement" : aligned ? "ally" : "stranger";
    return { isSelf, sameKind, aligned, similarity, shared, mineOnly, theirsOnly, complementarity: theirsOnly.length, relation, timescale: o.timescale };
  };

  return {
    self: () => me,
    // Update MY live capabilities (e.g. after a tool binds/unbinds abilities — grounding I2). My next beacon reflects it.
    setCapabilities(list) { me.caps = new Set((list || []).filter((c) => typeof c === "string")); return [...me.caps]; },
    // PB-4: set MY live interaction level (0..1 — how much the user is engaging this body right now) so electLead scores
    // the local node against its peers, and my next beacon publishes it.
    setInteraction(x) { me.interaction = Math.max(0, Math.min(1, Number(x) || 0)); return me.interaction; },
    // Perceive a beacon/manifest through the senses. A self-echo is recognized and DROPPED (not recruited). Any real
    // peer is upserted into the roster. Returns the comparison (with { ignored:true } for a self-echo / undecodable).
    // A peer carrying a full `id` is RESOLVED and flows exactly as before (recruited, eligible, updatable). A beacon that
    // carries ONLY an 8-bit idCode (256-value space, no id/attestation) is PROVISIONAL: it is rostered/relayed/visible but
    // is NOT trusted for delegate()/electLead() until a full id or an attestation resolves it (identity-spoofing fix 1). A
    // colliding idCode-only beacon can never OVERWRITE a resolved peer's caps/relation — it only ever creates or refreshes a
    // provisional SHADOW entry (idCode collision / roster-hijack fix 2).
    //
    // AUTO-ATTEST (beacon carries a cert -> auto-attest): a compact bitmask beacon can't hold a full birth-certificate, so a
    // cert travels ALONGSIDE the beacon. When BOTH `opts.cert` (a peer birthCert) and `opts.verifyCert` (a host-wired verifier
    // `cert -> { ok, relation?, sameTeam? }`, i.e. lineage.verify + relatedness) are supplied, identity is authenticated on
    // perception: a passing cert marks the entry `verified:true` (real family) and — if the cert's id matches this peer —
    // RESOLVES an otherwise-provisional beacon peer (a way to become non-provisional). A failing/foreign cert marks
    // `verified:false` and earns the claimant NOTHING (stays provisional/stranger). No cert+verifier => byte-identical to before.
    perceive(input, opts = {}) {
      const { now = 0, cert = null, verifyCert = null } = opts;
      const o = toPeer(input);
      if (!o) return { ignored: true, reason: "undecodable" };
      const cmp = compare(input);
      if (cmp.isSelf) return { ignored: true, reason: "self-echo", ...cmp };
      // Optional cert-carried attestation. certFields stays empty (=> byte-identical) unless BOTH cert and verifyCert are present.
      const certFields = {};
      if (cert && typeof verifyCert === "function") {
        const cv = verifyCert(cert) || {};
        certFields.verified = !!cv.ok;
        if (cv.ok) {
          if (cv.relation !== undefined) certFields.relation = cv.relation;   // genealogical relation (sibling/child/…)
          if (cv.sameTeam !== undefined) certFields.sameTeam = cv.sameTeam;
          // The cert must actually belong to THIS peer to lift a beacon-only claimant out of provisional (else a valid but
          // unrelated cert could launder a spoofed beacon into eligibility). On a match, adopt the cert's real id -> resolved.
          if (o.id == null && certBelongsTo(cert, o)) o.id = cert.id;
        }
      }
      const upsert = (key, provisional) => {
        const prev = roster.get(key);
        roster.set(key, { ...o, provisional, name: o.name || (prev && prev.name) || "", firstSeen: prev ? prev.firstSeen : now, lastSeen: now, relation: cmp.relation, similarity: cmp.similarity, ...certFields });
      };
      if (o.id != null) {
        // Fully-identified peer: resolved, keyed by id, updates its own entry as before.
        const key = "id:" + o.id;
        upsert(key, false);
        // A later full-id sighting of a peer we only had a provisional shadow for (same idCode) resolves it — drop the shadow.
        if (o.idCode != null) for (const sk of ["idc:" + o.idCode, "shadow:" + o.idCode]) { const s = roster.get(sk); if (s && s.provisional) roster.delete(sk); }
        return { ...cmp, recruited: true, key, provisional: false, ...certFields };
      }
      // idCode-ONLY beacon → provisional. If a RESOLVED peer already owns this idCode, this colliding beacon may only touch a
      // separate provisional shadow; it can never mutate the resolved peer's caps/relation.
      let resolvedOccupant = false;
      for (const p of roster.values()) if (p.provisional === false && p.idCode === o.idCode) { resolvedOccupant = true; break; }
      const key = resolvedOccupant ? "shadow:" + o.idCode : "idc:" + o.idCode;
      upsert(key, true);
      return { ...cmp, recruited: true, key, provisional: true, shadowed: resolvedOccupant, ...certFields };
    },
    // Upgrade a PROVISIONAL peer to resolved once an attestation (or the caller) vouches for it — clears the provisional
    // flag so it becomes eligible for delegate()/electLead(). Optionally binds a now-known full id.
    resolve(idCode, { id = null } = {}) {
      for (const [k, p] of roster.entries()) if (p.provisional && p.idCode === idCode) { const up = { ...p, provisional: false }; if (id != null) up.id = id; roster.set(k, up); return up; }
      return null;
    },
    compare,
    roster: () => [...roster.values()],
    peer: (id) => roster.get("id:" + id) || null,
    forget: (id) => roster.delete("id:" + id),

    // ── Swarm coordination (built on the roster + me) ───────────────────────────────────────────────────────────────
    // The whole team = me + everyone I've perceived.
    team: () => [me, ...roster.values()],
    // Everything the assembled team can collectively do.
    teamCapabilities() { const s = new Set(me.caps); for (const p of roster.values()) for (const c of p.caps) s.add(c); return [...s]; },
    // Capabilities a goal needs that NOBODY on the team currently has → go find (or recruit) a body that does.
    missingFor(goalCaps = []) { const have = new Set(this.teamCapabilities()); return goalCaps.filter((c) => !have.has(c)); },

    // Delegate a needed capability to the best team member that actually has it. Body-agnostic: "fly" picks the UAV,
    // "dive" picks the sub — same call. Tie-break by graded capacity (e.g. who can lift the most), then reaction speed
    // (faster first), then a stable id order. Returns { who, isSelf, timescale } or null if no one can.
    delegate(capability, { prefer = "capacity", eligible = null } = {}) {
      // `eligible(peer)` filters out untrusted peers (Cluster J) — I always trust myself.
      // Provisional (idCode-only, unattested) peers are excluded from delegation — identity-spoofing fix 1. I always trust myself.
      const cand = this.team().filter((p) => p.caps.has(capability) && (sameId(p, me) || (!p.provisional && (!eligible || eligible(p)))));
      if (!cand.length) return null;
      const tsRank = (t) => Math.max(0, ["reflexive", "fast", "deliberate", "textual"].indexOf(t));
      cand.sort((a, b) =>
        (prefer === "capacity" ? (b.capacities[capability] || 0) - (a.capacities[capability] || 0) : 0) ||
        tsRank(a.timescale) - tsRank(b.timescale) ||
        String(a.id ?? a.idCode).localeCompare(String(b.id ?? b.idCode)));
      const who = cand[0];
      return { who, isSelf: sameId(who, me), timescale: who.timescale, capability };
    },

    // Elect a team-lead — the "first-responder finds the helpers and leads." A brain flagged with the "lead" capability
    // wins; else the one covering the MOST of the team's capabilities (best generalist); ties broken by earliest-seen
    // then stable id. Deterministic, so every bot independently elects the SAME lead with no negotiation round-trip.
    electLead({ eligible = null, interaction = (p) => p.interaction || 0 } = {}) {
      // `eligible(peer)` restricts who can be lead to trusted peers (Cluster J) — I am always eligible for myself.
      // Provisional (idCode-only, unattested) peers cannot be lead — identity-spoofing fix 1. I am always eligible for myself.
      // PB-4 WAKE ARBITRATION: `interaction(peer)` (0..1) is how much the user is bodily engaging that node — radar
      // proximity, gyro "being held", heart-rate coupling, gaze — published in each node's beacon so the election is
      // deterministic across nodes with no round-trip. The node the user is oriented TOWARD wins among lead-capable
      // peers; a loser self-suppresses but stays warm (a graduated hand-off, not a hard mute). Quantized to steps so
      // tiny sensor jitter doesn't flip the lead every tick.
      const team = this.team().filter((p) => sameId(p, me) || (!p.provisional && (!eligible || eligible(p))));
      const coverage = (p) => p.caps.size;
      const canLead = (p) => (p.caps.has("lead") ? 1 : 0);
      const engage = (p) => Math.round(Math.max(0, Math.min(1, interaction(p))) * 10);   // 0..10 steps — stable under jitter
      team.sort((a, b) =>
        canLead(b) - canLead(a) ||
        engage(b) - engage(a) ||
        coverage(b) - coverage(a) ||
        ((a.firstSeen ?? -1) - (b.firstSeen ?? -1)) ||
        String(a.id ?? a.idCode).localeCompare(String(b.id ?? b.idCode)));
      const lead = team[0];
      const suppressed = team.slice(1).filter(canLead).map((p) => ({ id: p.id ?? p.idCode, state: "warm" }));   // losers stay warm for hand-off
      return { lead, isSelf: sameId(lead, me), interaction: engage(lead) / 10, suppressed };
    },

    snapshot() { return { roster: [...roster.entries()].map(([k, v]) => [k, { ...v, caps: [...v.caps] }]) }; }, // caps Set → array so JSON survives
    restore(s) { if (!s || !s.roster) return; roster.clear(); for (const [k, v] of s.roster) roster.set(k, { ...v, caps: new Set(v.caps) }); },
  };
}

// PB-4: a node's LOCAL interaction signal — how much the user is bodily engaging THIS device — to publish in its beacon
// for wake arbitration. Rook's cues (radar proximity, gyro "being held/moved", heart-rate coupling, gaze) beat the
// patent's screen-touch. Each input is 0..1; the result is a weighted blend in 0..1. PURE: signals injected; no I/O.
export function interactionScore({ proximity = 0, held = 0, hrCoupling = 0, gaze = 0 } = {}, weights = {}) {
  const W = { proximity: 0.35, held: 0.3, hrCoupling: 0.2, gaze: 0.15, ...weights };
  const c01 = (x) => Math.max(0, Math.min(1, Number(x) || 0));
  const sum = W.proximity + W.held + W.hrCoupling + W.gaze || 1;
  return +(((W.proximity * c01(proximity)) + (W.held * c01(held)) + (W.hrCoupling * c01(hrCoupling)) + (W.gaze * c01(gaze))) / sum).toFixed(3);
}
