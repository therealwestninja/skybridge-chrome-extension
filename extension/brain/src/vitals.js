// vitals.js — interoceptive HEALTH. The brain clamps every internal value (so nothing goes NaN) and each need gently
// biases behaviour — but it has had no unified sense of "how am I actually doing," no notion of a need becoming
// UNSUSTAINABLE, and no record of internal FAULTS (they were swallowed by silent catches). This is that missing layer:
// it reads the brain's own signals — energy, exhaustion (fatigue debt), chronic stress (cortisol), the most-starved
// felt need, pain, acute distress — into per-vital STRAIN readings (0 fine … 1 worst), a single overall band
// (ok / strained / critical), and it names the dominant concern. It also holds a FAULT FEED: internal errors that
// used to vanish now report here, so a burst of faults reads as a loss of INTEGRITY.
//
// Part A is the diagnosis: app.vitals() exposes the read. Part B ENACTS it — the `protect` verb below drives real behaviour:
// distress SURFACES in speech (express.js), a critical brain WITHDRAWS from proactive reach-outs and CONSERVES via load-shed
// (app.js feeds `overall` into loadShed's distress pressure), and coming through a critical patch is logged as RECOVERY
// (app.js mark). Pure read given the signals (testable); the fault feed is the only state (persisted small).
import { clamp01, num } from "./math.js";

// The self-protective response each concern calls for (Part B) — what the brain should DO when a vital is unsustainable.
const PROTECT = { energy: "rest", fatigue: "rest", stress: "withdraw and steady", pain: "guard and go gentle", need: "reach for what's missing", mood: "steady yourself", integrity: "flag the fault and slow down" };

export function makeVitals({ strainedAt = 0.45, criticalAt = 0.72, faultCap = 16, faultWindowMs = 5 * 60e3 } = {}) {
  let faults = []; // { where, message, at }
  let lastBand = "ok"; // for recovery detection (critical → ok = came through a rough patch)

  // Record an internal fault (a swallowed catch reports here instead of vanishing). Bounded ring.
  function note(where, err, now = null) {
    const message = (err && err.message) ? err.message : String(err == null ? "fault" : err);
    faults.push({ where: String(where || "?"), message: message.slice(0, 200), at: now });
    if (faults.length > faultCap) faults.shift();
  }

  const LABEL = { energy: "low energy", fatigue: "exhaustion", stress: "chronic stress", pain: "pain", need: "an unmet need", mood: "distress", integrity: "internal errors" };

  // Read the current vitals from the gathered signals. `sig`: { energy 0..1, fatigue 0..1, stress(cortisol) 0..1,
  // pain 0..1, need:{name,pressure}, mood:{valence,arousal}, now }. Returns per-vital strain + overall band + concern.
  function read(sig = {}) {
    const need = sig.need || null;
    const m = sig.mood || {};
    const now = sig.now;
    const recent = faults.filter((f) => now == null || f.at == null || (now - f.at) < faultWindowMs);

    const v = {
      energy: +clamp01(1 - num(sig.energy, 1)).toFixed(2),                                   // low energy = strain
      fatigue: +clamp01(num(sig.fatigue, 0)).toFixed(2),                                      // the exhaustion debt
      stress: +clamp01(num(sig.stress, 0)).toFixed(2),                                        // chronic cortisol
      pain: +clamp01(num(sig.pain, 0)).toFixed(2),
      need: +clamp01(need ? num(need.pressure, 0) * 2 : 0).toFixed(2),                         // the most-starved felt need
      mood: +clamp01(Math.max(0, -num(m.valence, 0)) * 0.7 + Math.max(0, num(m.arousal, 0.4) - 0.6) * 0.8).toFixed(2), // acute distress = low valence + high arousal
      integrity: +clamp01(recent.length / 5).toFixed(2),                                       // a burst of internal faults
    };
    // The WORST vital dominates — a single unsustainable need is a crisis even if everything else is fine.
    let concernKey = null, overall = 0;
    for (const k in v) if (v[k] > overall) { overall = v[k]; concernKey = k; }
    const band = overall >= criticalAt ? "critical" : overall >= strainedAt ? "strained" : "ok";
    const concern = overall > 0.15 ? (concernKey === "need" && need ? need.name : LABEL[concernKey] || concernKey) : null;
    const key = overall > 0.15 ? concernKey : null;
    // The protective response the brain should take (only when strained/critical — otherwise nothing to do).
    const protect = (band !== "ok" && key) ? (PROTECT[key] || "steady yourself") : null;
    return { band, overall: +overall.toFixed(2), concern, concernKey: key, protect, vitals: v, faults: recent.length };
  }

  // Record this turn's band once, and report whether the brain just came THROUGH a critical patch (critical → not-critical
  // = recovery). Call once per turn (read() is pure/idempotent; this is the stateful transition detector).
  function mark(band) {
    const recovered = lastBand === "critical" && band !== "critical";
    lastBand = band;
    return { recovered, from: recovered ? "critical" : null };
  }

  return {
    note, read, mark,
    faults: () => faults.slice(),
    snapshot: () => ({ faults: faults.slice(), lastBand }),
    restore: (s) => { if (s) { if (Array.isArray(s.faults)) faults = s.faults.slice(); lastBand = s.lastBand || "ok"; } },
  };
}
