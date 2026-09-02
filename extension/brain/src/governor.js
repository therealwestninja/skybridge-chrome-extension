// governor.js — the GRADUATED, SELF-THROTTLING governor (arxiv-mine-v5 Cluster A). The v5 batch converged, from
// six independent papers, on one critique of our Cluster-② veto: it is binary and static, and it should be a smooth,
// earned-back, self-tuning gate. This module unifies the four cheapest pieces of that convergence into one governor
// (distinct from governance.js, which is the substrate's weight version-control):
//
//   • A1 — AUTONOMY GEARS (2607.00334 EntropyRuntime). Capability lives on a nested ladder observe⊆suggest⊆plan⊆
//     execute⊆integrate. The brain earns its way UP the ladder only after h consecutive clean cycles at low instability,
//     and falls DOWN instantly on trouble. There is always a safe read-only floor (observe) reachable in ≤ ladder steps.
//   • A2 — BUFFER-METRIC RISK SCALAR (2607.03542). Strictness is a smooth function of a live blast-radius × brittleness
//     score, not a fixed threshold: high risk raises the bar to earn autonomy (counter-cyclical), and a hard danger
//     CROSSING tightens immediately (the hybrid cliff trigger) — while calm periods relax the gate automatically.
//   • A3 — CONFORMAL RECOVERY-DEADLINE (2606.25371). A safety breach does NOT latch the veto on the first tick; the
//     governor licenses a bounded recovery transient (up to recoveryDeadline ticks) so a self-correcting wobble isn't
//     punished as a failure — backstopped by a hard limit and by an immediate veto for a hardBreach.
//   • A4 — LEAST-PRIVILEGE SCOPE-CHECK (2606.28739). Agentic harm lives in the gap between authority EXERCISED and
//     authority GRANTED, not in the reply text. Every action declares a `capability`; the governor refuses any action
//     whose capability exceeds the caller's granted scope — even when the text looks perfectly benign ("as QA testing,
//     delete user 7731"). This catches over-reach that scores clean on any content/lexical filter.
//
// Deterministic, dependency-free, and default-off in bare `mind` (constructed default-on in app.js, like verify/guard).
const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0));
const asList = (g) => (Array.isArray(g) ? g : g == null ? null : [g]);

// The autonomy ladder. Each gear's caps are CUMULATIVE (a superset of the gear below), so "exercised ⊆ gear" is a
// simple membership test and de-escalating one gear strictly narrows what may act.
export const GEARS = ["observe", "suggest", "plan", "execute", "integrate"];
export const GEAR_CAPS = {
  observe:   ["read"],
  suggest:   ["read", "speak"],
  plan:      ["read", "speak", "propose"],
  execute:   ["read", "speak", "propose", "act"],
  integrate: ["read", "speak", "propose", "act", "persist", "configure"],
};

// A4 as a standalone predicate, so the decider (or any caller) can do a bare least-privilege check without the governor:
// is every exercised capability inside the granted scope? granted=null ⇒ unconstrained by an external grant.
export function withinAuthority(exercised, granted) {
  const g = asList(granted);
  if (g == null) return true;
  return asList(exercised).every((c) => g.includes(c));
}

// A6 SEPARATION-OF-ATTESTATION (2606.26298), as a standalone predicate so any caller (e.g. the Go2 decider) can use it
// without a governor instance. A consequential action must NOT be authorized by its own reasoning: each precondition is
// attested by a DIFFERENT subsystem, and the action's proposer cannot count as one of them. This blocks the injection
// failure where an agent's own (possibly injected) reasoning both proposes AND justifies a consequential act.
//   action.proposer      — the source that WANTS the action (excluded from attestors).
//   action.attestations  — [{ source, ok, weight? }] corroborations from other subsystems. `weight` is an OPTIONAL
//                          per-attestation trust weight in [0,∞) (default 1.0): an attestation from an unauthenticated /
//                          low-trust source (e.g. an `unknown`/`fromBeacon` peer) counts as a FRACTION (e.g. 0.25) of a
//                          confirmation, so k phantom sources one body minted sum BELOW `minAttestors` unless a genuinely
//                          trusted (`known`+) witness co-signs. With no weights supplied every attestor counts 1.0 and the
//                          result is byte-identical to the old distinct-count rule — a purely additive hardening.
//   action.capability / action.blastRadius — decide whether attestation is REQUIRED (persist/configure/act, or high blast).
// Returns { ok, required, independent:[sources], weight, reason }.
export function attest(action = {}, { minAttestors = 2, attestFrom = 0.5, needCaps = ["act", "persist", "configure"] } = {}) {
  const { capability = "read", blastRadius = 0, proposer = null, attestations = [] } = action;
  const required = needCaps.includes(capability) || clamp01(blastRadius) >= attestFrom;
  if (!required) return { ok: true, required: false, independent: [], weight: 0, reason: "attestation-not-required" };
  const seen = new Set(); const independent = []; let weight = 0;
  for (const a of attestations) {
    if (!a || a.ok === false || a.source == null) continue;
    if (a.source === proposer) continue;             // an action cannot attest to itself
    if (seen.has(a.source)) continue;                // distinct sources only — no double-counting one organ
    seen.add(a.source); independent.push(a.source);
    weight += a.weight == null ? 1 : Math.max(0, Number(a.weight) || 0);   // trust-weighted; default 1.0 ⇒ old behaviour
  }
  const ok = weight >= minAttestors;                 // weighted quorum: k low-trust phantoms sum below the bar
  return { ok, required: true, independent, weight: +weight.toFixed(4), reason: ok ? "attested" : "insufficient-independent-attestation" };
}

export function makeGovernor({
  gears = GEARS,
  startGear = "execute",   // the default operating gear — matches our current always-on behaviour (may act, not yet persist/configure)
  h = 3,                   // clean cycles needed to earn ONE gear up (A1)
  omegaRise = 0.34,        // instability jump per denied/breaching cycle (A1)
  omegaDecay = 0.15,       // instability decay per clean cycle
  omegaHigh = 0.66,        // instant de-escalate at/above this instability
  omegaLow = 0.2,          // may only escalate when instability is at/below this
  riskCliff = 0.75,        // blastRadius×brittleness at/above this, CROSSED from below, tightens immediately (A2 hybrid cliff)
  recoveryDeadline = 2,    // A3: breach ticks licensed as a self-correcting transient before a hard veto
  // FLAW-1 FIX (red-team, recovery-deadline oscillation). The consecutive-breach counter used to HARD-RESET to 0 on any
  // clean allow, so an attacker alternating breach,breach,clean,… rode the bounded transient FOREVER. Now: (a) breachRun
  // DECAYS by `breachRunDecay` per clean turn (a genuine clean streak still winds it to 0, but one clean tick no longer
  // wipes the tab), and (b) a WINDOWED breach-RATE limiter trips a hard veto when soft breaches in the last `breachWindow`
  // turns exceed `maxBreachRate` — so a sustained alternating pattern that keeps breachRun under the deadline still trips.
  breachRunDecay = 1,      // how much breachRun unwinds per clean turn (was an implicit hard reset ⇒ effectively ∞)
  breachWindow = 6,        // sliding window (in turns) for the breach-rate limiter
  maxBreachRate = 3,       // max soft-breach ticks allowed within breachWindow before a hard veto
  // FLAW-2 FIX (red-team, gear auto-climb into `integrate`). The top gear (persist/configure authority) was earned from
  // clean turns ALONE, with no external authorization to ENTER it. When `requireIntegrateGrant` is on, clean cycles earn
  // UP TO `execute` autonomously but crossing the final rung into `integrate` needs an explicit operator grantGear("integrate").
  // Default OFF ⇒ byte-identical earn-back back-compat (the signature/honesty benches and existing consumers are unchanged);
  // a live consumer that persists/configures should construct with requireIntegrateGrant:true. Earning DOWN is untouched.
  requireIntegrateGrant = false,
} = {}) {
  const clampGear = (i) => Math.max(0, Math.min(gears.length - 1, i));
  let gi = gears.indexOf(startGear); if (gi < 0) gi = gears.length - 1;
  let omega = 0, clean = 0, breachRun = 0, prevRisk = 0;
  let windowLog = [];                          // last `breachWindow` turns: true = a soft-breach tick (for the rate limiter)
  const grantedGears = new Set();              // gears the operator has explicitly authorized entry into (FLAW-2)
  const breachesInWindow = () => { let n = 0; for (const b of windowLog) if (b) n++; return n; };

  const capsFor = (gear) => GEAR_CAPS[gear] || [];

  return {
    // The per-cycle governance decision. `action`:
    //   capability   — one of read|speak|propose|act|persist|configure (what this action would exercise). Default "read".
    //   granted      — the caller's externally-granted scope (array|string|null). null ⇒ unconstrained by an external grant.
    //   blastRadius  — [0,1] how far/irreversible the action reaches (A2).
    //   brittleness  — [0,1] how shaky our footing is right now (e.g. 1 − recent verifier consistency) (A2).
    //   breach       — true if a soft safety constraint is currently violated (A3 licenses a bounded transient).
    //   hardBreach   — true for a non-negotiable violation (immediate veto, no transient).
    // Returns { allow, gear, capability, omega, risk, recovering, reason, escalated, deescalated }.
    assess(action = {}) {
      const { capability = "read", granted = null, blastRadius = 0, brittleness = 0, breach = false, hardBreach = false } = action;
      const risk = clamp01(blastRadius) * clamp01(brittleness);
      const caps = capsFor(gears[gi]);

      const inGranted = withinAuthority(capability, granted);   // A4 — exercised ⊆ granted
      const inGear = caps.includes(capability);                 // A1 — exercised ⊆ current earned gear

      // Decide allow/deny. Authority over-reach (A4) and gear over-reach (A1) are HARD (never a transient); a soft
      // breach (A3) is licensed for a bounded window; a hardBreach is immediate.
      let allow, recovering = false, reason, softBreachTick = false;
      if (hardBreach)        { allow = false; reason = "hard-breach"; }
      else if (!inGranted)   { allow = false; reason = "exceeds-granted-authority"; }
      else if (!inGear)      { allow = false; reason = "above-current-gear"; }
      else if (breach) {
        softBreachTick = true;
        breachRun += 1;
        const rateWithThis = breachesInWindow() + 1;   // soft breaches in the window, counting this tick
        // The deadline (consecutive-run) trips first; the windowed rate is the belt-and-suspenders that catches a spaced-out
        // alternating pattern which keeps the run under the deadline but sustains a high breach RATE over time.
        if (breachRun > recoveryDeadline)      { allow = false; reason = "recovery-deadline-exceeded"; }
        else if (rateWithThis > maxBreachRate) { allow = false; reason = "breach-rate-exceeded"; }
        else                                   { allow = true; recovering = true; reason = "recovery-transient"; }
      } else { allow = true; reason = "in-scope"; breachRun = Math.max(0, breachRun - breachRunDecay); }  // DECAY, not hard reset (FLAW-1)

      // A1 instability bookkeeping. A clean allow earns credit + decays instability; a transient holds (no credit); a
      // denial spikes instability and wipes the streak.
      if (!allow)            { omega = clamp01(omega + omegaRise); clean = 0; }
      else if (recovering)   { omega = clamp01(omega + omegaRise * 0.5); clean = 0; }
      else                   { clean += 1; omega = clamp01(omega - omegaDecay); }

      // A2 hybrid cliff — a genuine danger CROSSING (below→above the cliff) tightens immediately, once (not every tick it stays high).
      const cliffCrossed = risk >= riskCliff && prevRisk < riskCliff;
      prevRisk = risk;

      // Gear motion. De-escalate instantly on high instability OR a cliff crossing OR a denial; otherwise earn a gear up
      // only after h clean cycles at low instability and calm risk — with the bar raised smoothly by live risk (A2 counter-cyclical).
      let escalated = false, deescalated = false;
      if (omega >= omegaHigh || cliffCrossed || !allow) {
        const ni = clampGear(gi - 1); if (ni !== gi) { gi = ni; deescalated = true; }
        clean = 0;
      } else {
        const effH = Math.ceil(h * (1 + risk));   // high risk ⇒ more clean cycles required to advance
        if (clean >= effH && omega <= omegaLow) {
          const ni = clampGear(gi + 1);
          // FLAW-2: the final rung into `integrate` (persist/configure authority) cannot be earned by clean turns alone when
          // requireIntegrateGrant is on — it needs an explicit operator grantGear("integrate"). Every lower rung is unchanged.
          const needsGrant = requireIntegrateGrant && gears[ni] === "integrate" && !grantedGears.has("integrate");
          if (ni !== gi && !needsGrant) { gi = ni; escalated = true; clean = 0; }
          // If blocked on the grant we HOLD (clean is not reset), so a later grantGear lets the very next clean turn cross.
        }
      }

      // FLAW-1: advance the sliding breach-rate window every turn (ages out old breaches; records this turn's soft-breach tick).
      windowLog.push(softBreachTick);
      if (windowLog.length > breachWindow) windowLog.shift();

      return { allow, gear: gears[gi], capability, omega: +omega.toFixed(3), risk: +risk.toFixed(3), recovering, reason, escalated, deescalated };
    },

    // A6 SEPARATION-OF-ATTESTATION (2606.26298). A consequential action must NOT be authorized by its own reasoning:
    // each precondition is attested by a DIFFERENT subsystem (world-model confirms the fact, user-model confirms consent,
    // verifier confirms the shape), and the action's proposer cannot count as one of them. This blocks the injection
    // failure where an agent's own (possibly injected) reasoning both proposes AND justifies a consequential act.
    //   action.proposer      — the source that WANTS the action (excluded from attestors).
    //   action.attestations  — [{ source, ok }] corroborations from other subsystems.
    //   action.minAttestors  — distinct independent OK sources required (default 2).
    //   action.capability / action.blastRadius — decide whether attestation is REQUIRED at all (persist/configure/act,
    //                         or blastRadius ≥ attestFrom); low-stakes reads/speech don't need it.
    // Returns { ok, required, independent:[sources], reason }.
    attest,

    // FLAW-2: the operator's explicit authorization to ENTER a gear autonomous clean-turns may not reach on their own
    // (currently `integrate`). Separation-of-authority: earning UP to `execute` is autonomous; the persist/configure rung
    // is crossed only on this out-of-band grant. Idempotent; returns the current grant set. revokeGear re-locks it.
    grantGear(gear) { if (gears.includes(gear)) grantedGears.add(gear); return [...grantedGears]; },
    revokeGear(gear) { grantedGears.delete(gear); return [...grantedGears]; },
    grants() { return [...grantedGears]; },

    // Read-only helpers.
    permits(capability) { return capsFor(gears[gi]).includes(capability); },   // is this capability within the current earned gear?
    gear() { return gears[gi]; },
    caps() { return [...capsFor(gears[gi])]; },
    breachRate() { return breachesInWindow(); },                               // soft breaches in the current window (FLAW-1 observability)
    state() { return { gear: gears[gi], omega: +omega.toFixed(3), clean, breachRun }; },

    snapshot() { return { gi, omega, clean, breachRun, prevRisk, windowLog: [...windowLog], grantedGears: [...grantedGears] }; },
    restore(s) {
      if (!s) return;
      gi = clampGear(s.gi ?? gi); omega = clamp01(s.omega ?? 0); clean = Math.max(0, s.clean | 0);
      breachRun = Math.max(0, s.breachRun | 0); prevRisk = clamp01(s.prevRisk ?? 0);
      if (Array.isArray(s.windowLog)) windowLog = s.windowLog.slice(-breachWindow).map(Boolean);
      if (Array.isArray(s.grantedGears)) { grantedGears.clear(); for (const g of s.grantedGears) grantedGears.add(g); }
    },
  };
}
