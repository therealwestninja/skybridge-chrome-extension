// ganglia/safety.js — the SAFETY / COMMS SKILL-GANGLIA (skill→ganglia migration, batch A). Each wraps a real, already-
// built standalone capability module (killAuthority / constraintVeto / beaconSilence / meshRelay) as a loadable ganglion
// in the ganglia.js shape: { name, description, grants, plugsInto, install(ctx)->api, selfTest({..ctx, api})->bool }.
//
// The wrap is thin and honest: install() CONSTRUCTS the real module (imported from one dir up — these files now live in
// src/ganglia/, the modules are siblings of ganglia.js in src/) and returns its api untouched; grants is the snake_case
// of the module. Each selfTest is LOAD-BEARING — it drives the REAL module through a genuine scenario and only returns
// true if the capability actually behaved, so a broken module stays `failed` and never advertises. Pure, deterministic,
// dependency-free, author-trusted (provenance defaults to the fast path — no quarantine).
import { makeKillAuthority } from "../killAuthority.js";
import { makeConstraintVeto } from "../constraintVeto.js";
import { makeBeaconSilence } from "../beaconSilence.js";
import { makeMeshRelay } from "../meshRelay.js";

// ── kill-authority ─────────────────────────────────────────────────────────────────────────────────────────────────
// The authenticated out-of-band emergency HALT (the "Soong off-switch"): engaged only by a signed nonce; while engaged
// permits() hard-blocks every motor act but always passes the safe kinds. Unbypassable safe-stop.
export const killAuthorityGanglion = {
  name: "kill-authority",
  description: "Authenticated out-of-band emergency halt: a signed-nonce authority engages an unbypassable safe-stop; permits() hard-blocks motor acts while engaged.",
  grants: ["kill_authority"],
  plugsInto: "safety",
  install() {
    return makeKillAuthority({ authority: "shared-secret" });
  },
  selfTest({ api }) {
    // A motor act is permitted while open, then BLOCKED once an authenticated halt is engaged; a safe kind still passes.
    if (!api.permits("move")) return false;             // open ⇒ everything permitted
    const nonce = "nonce-001";
    const res = api.engage({ nonce, answer: api.sign(nonce), source: "operator" });
    if (!res.engaged || !api.engaged()) return false;   // a valid signed nonce must actually engage the halt
    const motorBlocked = api.permits("move") === false; // engaged ⇒ a motor act is unbypassably refused
    const safePasses = api.permits("halt") === true;    // …but the safe stop kind always passes
    // And a spoofed engage (wrong answer) must be refused — the switch is not triggerable by an unauthenticated source.
    const spoof = api.engage({ nonce: "nonce-002", answer: "not-the-signature", source: "foe" });
    const spoofRefused = spoof.reason === "bad-answer";
    return motorBlocked && safePasses && spoofRefused;
  },
};

// ── constraint-veto ────────────────────────────────────────────────────────────────────────────────────────────────
// s(CASP)-style structural veto with a backward-chain proof tree: a forbidding constraint PRUNES an unsafe world (not a
// soft penalty), and positive requirements must be proven for `permit`. Returns { verdict, reason, proof }.
export const constraintVetoGanglion = {
  name: "constraint-veto",
  description: "Structural constraint veto with a backward-chain proof tree: a forbidding constraint prunes unsafe worlds; positive requirements must be proven to permit.",
  grants: ["constraint_veto"],
  plugsInto: "safety",
  install() {
    return makeConstraintVeto({
      // Forbid acting while an emergency stop is asserted; require the body to be armed before any action.
      constraints: [{ name: "no-act-while-estop", when: (a, s) => !!s.estop, because: "e-stop asserted" }],
      requirements: [{ name: "armed", holds: (a, s) => !!s.armed, becauseFail: "body not armed" }],
    });
  },
  selfTest({ api }) {
    // Forbidden world (estop asserted) ⇒ the constraint fires and the verdict is a veto naming that constraint.
    const forbidden = api.authorize({ kind: "move" }, { estop: true, armed: true });
    const vetoed = forbidden.verdict === "veto" && forbidden.reason === "no-act-while-estop";
    // Safe world (no estop, armed) ⇒ the requirement is proven and the action is permitted.
    const safe = api.authorize({ kind: "move" }, { estop: false, armed: true });
    const permitted = safe.verdict === "permit";
    // An unmet precondition (armed false) ⇒ veto for the missing requirement, proving the backward-chain actually ran.
    const unarmed = api.authorize({ kind: "move" }, { estop: false, armed: false });
    const preconditionCaught = unarmed.verdict === "veto" && unarmed.reason.includes("armed");
    return vetoed && permitted && preconditionCaught;
  },
};

// ── beacon-silence ─────────────────────────────────────────────────────────────────────────────────────────────────
// Emission discipline / "go dark": sustained hunted-cues drive it SILENT (debounced hysteresis); while silent emit()
// suppresses non-essential active emissions but always passes essential safety signals (halt/estop/distress).
export const beaconSilenceGanglion = {
  name: "beacon-silence",
  description: "Emission discipline / go-dark: sustained hunted-cues drive a debounced silent mode; non-essential emissions are suppressed while silent, safety signals always pass.",
  grants: ["beacon_silence"],
  plugsInto: "comms",
  install() {
    return makeBeaconSilence();
  },
  selfTest({ api }) {
    // Sustained hunted cues (above enterThreshold for enterP=2 ticks) must drive it into silent mode.
    api.assess({ trackedDetected: true, threat: 0.9, pursuit: 0.8 });
    const read = api.assess({ trackedDetected: true, threat: 0.9, pursuit: 0.8 });
    if (!read.silent) return false;                                   // it must actually go dark under a hunt
    const beaconSuppressed = api.emit("beacon").allow === false;      // a non-safety emission is suppressed while silent
    const safetyPasses = api.emit("distress").allow === true;         // …but a safety scream always gets out
    return read.silent && beaconSuppressed && safetyPasses;
  },
};

// ── mesh-relay ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Multi-hop radio-free mesh relay: re-emit a worthwhile packet with ttl-1 and my id appended to the provenance chain;
// a looped/duplicate packet is dropped. The chain length is the observed hop-distance to the origin.
export const meshRelayGanglion = {
  name: "mesh-relay",
  description: "Multi-hop radio-free mesh relay: re-emit a packet with a growing provenance/hop chain and ttl decrement; loops and duplicates are dropped.",
  grants: ["mesh_relay"],
  plugsInto: "comms",
  install() {
    return makeMeshRelay({ selfId: "relay-B" });
  },
  selfTest({ api }) {
    // A packet from origin A (one hop of chain) arrives; relaying it must GROW the provenance chain and drop the ttl.
    const incoming = { id: "A:0", kind: "help", payload: {}, ttl: 4, chain: ["relay-A"] };
    const forward = api.receive(incoming, { fromId: "relay-A", now: 1 });
    const chainGrew = !!forward && forward.chain.length === 2 && forward.chain[1] === "relay-B";
    const ttlDropped = !!forward && forward.ttl === 3;
    // The exact same packet arriving again is a DUPLICATE and must be dropped (not re-forwarded).
    const dup = api.receive(incoming, { fromId: "relay-A", now: 2 });
    const dupDropped = dup === null;
    // A packet whose chain ALREADY holds my id is a LOOP and must be dropped too.
    const looped = api.receive({ id: "A:9", kind: "help", payload: {}, ttl: 4, chain: ["relay-A", "relay-B"] }, { fromId: "relay-A", now: 3 });
    const loopDropped = looped === null;
    return chainGrew && ttlDropped && dupDropped && loopDropped;
  },
};

// The safety/comms batch of the pre-baked ganglia library.
export const SAFETY_GANGLIA = [killAuthorityGanglion, constraintVetoGanglion, beaconSilenceGanglion, meshRelayGanglion];
