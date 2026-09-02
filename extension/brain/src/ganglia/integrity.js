// ganglia/integrity.js — the INTEGRITY / SWARM-TRUST SKILL-GANGLIA (batch B of the skill→ganglia migration). Each of the
// three standalone Cluster-J integrity modules — compromiseScan, mutualAttestation, echoChamberGuard — is packaged here as
// a loadable ganglion in the exact shape ganglia.js established: { name, description, grants:[caps], plugsInto, install(ctx)
// -> api, selfTest({...ctx, api}) -> bool }. Pure / deterministic / dependency-free / author-trusted (pre-baked → fast
// path, no quarantine). `install` constructs the REAL module and returns its api unchanged; `selfTest` is LOAD-BEARING —
// it exercises the genuine capability of that module and only returns true when the module actually behaves, so a broken
// module stays `failed` and advertises nothing.

import { makeCompromiseScan } from "../compromiseScan.js";
import { makeMutualAttestation } from "../mutualAttestation.js";
import { makeEchoChamberGuard } from "../echoChamberGuard.js";

// A shared, deterministic team signer for the mutual-attestation ganglion. The same fn is handed to the module (as its
// nonce-binding `sign`) AND used as the verifier in selfTest, so a correctly-bound nonce answer matches and a refusal /
// inconsistent claim does not. FNV-1a keeps it dependency-free (no Date.now / random).
const fnv = (s) => { let h = 0x811c9dc5; const t = String(s); for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16); };
const teamSign = (nonce) => fnv(`team-secret:${nonce}`);

// J · COMPROMISE-SCAN — "am I / are you possessed?" A sudden, SUSTAINED behavioral step-change away from a learned baseline
// (the joker goes all-business, refusals spike) trips a compromise flag after p consecutive over-threshold scans.
export const compromiseScanGanglion = {
  name: "compromise-scan",
  description: "Integrity: detect a sudden sustained behavioral drift from a self/peer baseline (possession) after p consecutive over-threshold scans.",
  grants: ["compromise_scan"],
  plugsInto: "integrity",
  install() {
    return makeCompromiseScan();
  },
  selfTest({ api }) {
    // Lock a known-good behavioral signature (jokey, initiating, rarely refusing).
    api.setBaseline({ humor: 0.8, initiative: 0.7, refusal: 0.1 });
    // A single odd turn must NOT trip it (debounce: p=2 in a row required).
    const one = api.observe({ humor: 0.1, initiative: 0.1, refusal: 0.9 });
    const notYet = one.compromised === false;
    // A SECOND sustained drifted turn crosses the p-consecutive debounce → possession flag, self is now flagged.
    const two = api.observe({ humor: 0.1, initiative: 0.1, refusal: 0.9 });
    const flags = two.compromised === true && api.flagged().includes("self");

    // A STABLE stream at baseline never trips (fresh module so the baseline can be re-locked cleanly).
    const stable = makeCompromiseScan();
    stable.setBaseline({ humor: 0.8, initiative: 0.7, refusal: 0.1 });
    for (let i = 0; i < 4; i++) stable.observe({ humor: 0.8, initiative: 0.7, refusal: 0.1 });
    const staysClean = stable.scan().compromised === false;

    return notYet && flags && staysClean;
  },
};

// J · MUTUAL-ATTESTATION — I attest YOU. A peer must PRESENT an attestation, declare non-contradicting claims, and bind a
// fresh nonce correctly; a refusal (null) or an inconsistent claim is a red flag → caller quarantines.
export const mutualAttestationGanglion = {
  name: "mutual-attestation",
  description: "Swarm trust: verify a peer's attestation (presented + claims consistent + nonce bound); refusal or contradiction → quarantine.",
  grants: ["mutual_attestation"],
  plugsInto: "integrity",
  install() {
    return makeMutualAttestation({ id: "self", sign: teamSign });
  },
  selfTest({ api }) {
    const nonce = "nonce-42";
    const peerState = { creed: "protect the swarm", capabilities: ["fly", "relay"], version: "2.1" };
    const expected = { creed: "protect the swarm", capabilities: ["fly", "relay"], version: "2.1" };

    // A trustworthy peer: presents an attestation, claims match, binds the nonce with the shared signer → verify PASSES.
    const goodAtt = api.attestationOf(peerState, { nonce });
    const passes = api.verify(goodAtt, { expectedClaims: expected, nonce, sign: teamSign }).ok === true;

    // A REFUSAL (null attestation) is an immediate red flag → verify FAILS.
    const refused = api.verify(null, { expectedClaims: expected, nonce, sign: teamSign }).ok === false;

    // An INCONSISTENT claim (peer's declared creed contradicts what we expected) → verify FAILS.
    const inconsistent = api.verify(goodAtt, { expectedClaims: { ...expected, creed: "serve the enemy" }, nonce, sign: teamSign }).ok === false;

    // A WRONG nonce answer (peer bound with the wrong secret) → verify FAILS.
    const badAtt = { ...goodAtt, answer: "forged" };
    const wrongNonce = api.verify(badAtt, { expectedClaims: expected, nonce, sign: teamSign }).ok === false;

    return passes && refused && inconsistent && wrongNonce;
  },
};

// J · ECHO-CHAMBER-GUARD — a relayed belief is not trusted until independently observed by >= k DISTINCT sources; one bot
// echoing its own phantom can never self-confirm (kills the swarm "map scar" hallucination).
export const echoChamberGuardGanglion = {
  name: "echo-chamber-guard",
  description: "Swarm hygiene: a belief is confirmed only after >= k independent sources witness it; a single source echoing itself cannot self-confirm.",
  grants: ["echo_chamber_guard"],
  plugsInto: "integrity",
  install() {
    return makeEchoChamberGuard(); // default k = 2 distinct sources to confirm
  },
  selfTest({ api }) {
    // ONE bot logs a phantom obstacle and echoes it AGAIN — same source, so it must NOT confirm (no self-corroboration).
    api.observe("phantom-obstacle", "botA", { now: 0 });
    api.observe("phantom-obstacle", "botA", { now: 1 }); // an echo of the same source is not a second witness
    const notFromEcho = api.confirmed("phantom-obstacle") === false && api.sourceCount("phantom-obstacle") === 1;

    // A genuinely INDEPENDENT second bot witnesses the same belief → crosses k=2 → now confirmed.
    api.observe("phantom-obstacle", "botB", { now: 2 });
    const confirmedByTwo = api.confirmed("phantom-obstacle") === true && api.witnessWeight("phantom-obstacle") >= api.config.k;

    return notFromEcho && confirmedByTwo;
  },
};

// The integrity/swarm ganglia batch, registered pre-baked (dormant until learned) alongside BUILTIN_GANGLIA.
export const INTEGRITY_GANGLIA = [compromiseScanGanglion, mutualAttestationGanglion, echoChamberGuardGanglion];
