// loadShed.js — Tier-2 spike PB-16 [G1]: GRADUATED cognitive load-shedding under thermal / energy / strain pressure. As a
// node nears its limits, progressively dial down the expensive-but-optional faculties — imagination cadence, inner-voice,
// deliberation depth — and prefer OFFLOADING to a peer/server, all BEFORE any hard cutoff. Graduated-and-FELT (the
// pressure feeds vitals as strain, so she experiences it) rather than a clamp that would reintroduce the reflex-FSM DoS.
//
// PART B — protective response: the three raw pressures below (thermal/drain/strain) only see cortisol, energy and effort.
// `distress` is the UNIFIED vitals strain, so the SAME conserving behaviour also fires for the concerns the raw pressures
// are blind to — pain, acute distress, an unsustainable unmet need, a burst of internal faults. That's the vitals `protect`
// verb ("rest" / "withdraw" / "go gentle" / "slow down") finally ENACTED — the brain conserves, not just says it's at its
// limit. PURE: reads scalar pressures (0..1); deterministic; no clock/IO.

export function makeLoadShed({ warm = 0.6, hot = 0.85 } = {}) {
  const c01 = (x) => Math.max(0, Math.min(1, Number(x) || 0));

  // pressures 0..1: thermal, drain (1 = battery empty), strain (actuator/effort), distress (unified vitals overall).
  // The WORST pressure governs the tier; `cause` names which one won, so telemetry shows WHY it shed.
  function plan({ thermal = 0, drain = 0, strain = 0, distress = 0 } = {}) {
    const P = { thermal: c01(thermal), drain: c01(drain), strain: c01(strain), distress: c01(distress) };
    let cause = null, pressure = 0;
    for (const k in P) if (P[k] > pressure) { pressure = P[k]; cause = k; }
    const tier = pressure >= hot ? "shed" : pressure >= warm ? "ease" : "normal";
    const scale = tier === "shed" ? { imagination: 0, innerVoice: 0, deliberationDepth: 0.3 }
      : tier === "ease" ? { imagination: 0.5, innerVoice: 0.4, deliberationDepth: 0.6 }
        : { imagination: 1, innerVoice: 1, deliberationDepth: 1 };
    return { tier, pressure: +pressure.toFixed(3), cause, ...scale, offload: pressure >= warm, feltStrain: +pressure.toFixed(3), distress: +P.distress.toFixed(3) };
  }
  return { plan };
}
