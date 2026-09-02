// Four neuromodulators as slow scalar fields (volume transmission). Each tick:
//   level += phasic; level -= k*(level - setpoint)   (phasic events are reactivity-scaled on burst)
import { decayTowardSetpoint } from "./math.js";

export const CHEMICALS = {
  DOPAMINE: "dopamine",
  NOREPINEPHRINE: "norepinephrine",
  SEROTONIN: "serotonin",
  ACETYLCHOLINE: "acetylcholine",
};

// k = homeostatic decay rate toward setpoint. Dopamine's was too weak (0.05): frequent salience/
// curiosity bursts outran it, so the level climbed toward ~4 and PINNED valence positive (mood
// unusable, and it swamped the -0.5*NE term so harsh input never read negative). Raised to 0.18 so
// dopamine returns toward setpoint between bursts -> valence tracks the actual reward/affect signal.
const DEFAULTS = {
  dopamine:      { setpoint: 0.2, k: 0.18, reactivity: 1.0 },
  norepinephrine:{ setpoint: 0.3, k: 0.05, reactivity: 1.0 },
  serotonin:     { setpoint: 0.5, k: 0.02, reactivity: 1.0 },
  acetylcholine: { setpoint: 0.3, k: 0.05, reactivity: 1.0 },
};

// The reference setpoints -- the SINGLE source of truth for "the default persona". Exported so the gain
// references (organism), the persona baseline (persona.js), and the chem harness derive from ONE place
// instead of re-typing the same literals (which silently desync the "inert at default" invariants).
export const DEFAULT_SETPOINTS = {
  dopamine: DEFAULTS.dopamine.setpoint, norepinephrine: DEFAULTS.norepinephrine.setpoint,
  serotonin: DEFAULTS.serotonin.setpoint, acetylcholine: DEFAULTS.acetylcholine.setpoint,
};
// Valence center = the default persona's steady-state valence_raw, so the default reads ~0. Derived, not
// a frozen magic number, so it tracks the setpoints above if they ever change.
const VALENCE_CENTER = DEFAULT_SETPOINTS.dopamine + DEFAULT_SETPOINTS.serotonin - 0.5 * DEFAULT_SETPOINTS.norepinephrine;

// Seeking / wanting = incentive-salience, DISTINCT from valence (liking/having). It reads dopamine's PHASIC drive —
// the rate at which reward is being APPROACHED — not the absolute level. So wanting can be high (a strong appetitive
// pull, desire, pursuit) while valence is only neutral (you don't yet HAVE the thing). SEEK_RISE folds each tick's
// positive dopamine phasic into a slow EMA; SEEK_DECAY bleeds it off between bursts. Feed-forward only: `seek` is a
// READOUT derived from phasic — it is never written back into any chem field, so it cannot form a runaway loop.
const SEEK_RISE = 0.6, SEEK_DECAY = 0.25;

export function makeNeuromodulation({ setpoints = {}, reactivity = {} } = {}) {
  const chem = {};
  let seek = 0; // wanting accumulator (>=0), squashed to (0,1) at readout — bounded, feed-forward, never loops back
  for (const name of Object.keys(DEFAULTS)) {
    const d = DEFAULTS[name];
    chem[name] = {
      setpoint: setpoints[name] ?? d.setpoint,
      k: d.k,
      reactivity: reactivity[name] ?? d.reactivity,
      level: setpoints[name] ?? d.setpoint, // start at rest
      phasic: 0,
    };
  }

  return {
    setpoint(name) { return chem[name].setpoint; },
    level(name) { return chem[name].level; },

    // Inject a phasic event (e.g. reward -> dopamine, threat -> norepinephrine). Red-team V5: a poisoned NaN/Infinity
    // magnitude is dropped rather than allowed to propagate into the field (which would pin valence at NaN forever).
    burst(name, magnitude) {
      if (!chem[name]) return;
      const d = magnitude * chem[name].reactivity;
      if (Number.isFinite(d)) chem[name].phasic += d;
    },

    // Advance the field one tick: apply phasic input, then homeostatic decay. Red-team V5 hardening: after the update a
    // non-finite level is reset to its setpoint (a fault, not a crash) and every level is clamped to a generous finite
    // range — normal operation stays well inside it, so behaviour is unchanged, but a runaway can't reach Infinity/NaN.
    tick() {
      for (const name of Object.keys(chem)) {
        const c = chem[name];
        if (name === "dopamine") {
          // Incentive-salience: only the POSITIVE (approach) part of dopamine's phasic feeds wanting. EMA + hard clamp
          // keep it bounded; it reads phasic BEFORE it is zeroed, and writes nowhere but `seek`, so it stays feed-forward.
          const approach = Math.max(0, c.phasic);
          seek += SEEK_RISE * approach - SEEK_DECAY * seek;
          if (!Number.isFinite(seek)) seek = 0;
          else seek = Math.max(0, Math.min(8, seek));
        }
        c.level += c.phasic;
        c.phasic = 0;
        c.level = decayTowardSetpoint(c.level, c.setpoint, c.k);
        if (!Number.isFinite(c.level)) c.level = c.setpoint;
        else c.level = Math.max(-16, Math.min(16, c.level));
      }
    },

    // Live trait update (personality edits): change setpoint/reactivity, keep current level.
    setTrait({ setpoints = {}, reactivity = {} } = {}) {
      for (const name in setpoints) if (chem[name]) chem[name].setpoint = setpoints[name];
      for (const name in reactivity) if (chem[name]) chem[name].reactivity = reactivity[name];
    },

    // Plasticity gate (three-factor): how far dopamine is above its setpoint, >= 0.
    plasticityGate() {
      const c = chem.dopamine;
      return Math.max(0, c.level - c.setpoint);
    },

    // Human-facing gauge derived from the chemistry, BOUNDED to a usable range. The raw chem levels are
    // unbounded (bursts outpace the weak homeostatic decay -> dopamine climbs toward ~4 under sustained
    // reward), so the raw sums saturate; tanh squashes them to valence in (-1,1) and arousal in (0,1) --
    // near-linear near rest, saturating at the extremes -- so mood is an ACTUAL usable control signal
    // (before this, valence sat pinned at ~2-4 and describeMood's v>0.3 test read "positive" every turn).
    // Only the readout is bounded; level()/plasticityGate()/gain read raw levels, so learning is untouched.
    readout() {
      // Valence = dopamine (engagement) + serotonin (warmth) - 0.5*NE (arousal/anxiety), centered on a
      // FIXED constant (0.55) so the DEFAULT persona reads ~0. Using a fixed center (not serotonin's own
      // setpoint) is deliberate: subtracting the setpoint cancelled serotonin's steady-state effect
      // entirely (harness finding), leaving warmth inert -- now the serotonin setpoint sets a real
      // baseline mood. tanh bounds the (unbounded) raw sums to a usable range.
      // Dopamine's contribution to FELT valence SATURATES: more reward feels good, but 5× reward is not 5× happier.
      // Compress the above-setpoint part so a ratcheted dopamine (bursts outrun decay under sustained reward) can't PEG
      // valence at +1 and drown out serotonin (warmth/deflation) and NE — which left mood deaf to later criticism. Only
      // the READOUT compresses; raw level()/plasticityGate()/gain read the true level, so learning is untouched. At rest
      // (level == setpoint) daFelt == setpoint, so the default still reads ~0.
      const d = chem.dopamine, sp = d.setpoint, DA_SAT = 0.6;
      const daFelt = d.level <= sp ? d.level : sp + Math.tanh((d.level - sp) / DA_SAT) * DA_SAT;
      const vRaw = daFelt + chem.serotonin.level - 0.5 * chem.norepinephrine.level - VALENCE_CENTER;
      const aRaw = chem.norepinephrine.level + 0.5 * chem.acetylcholine.level;
      // seeking = wanting/pursuit (0..1), from dopamine's phasic drive; tanh bounds the (>=0) EMA. Distinct from valence:
      // a fresh appetitive burst spikes seeking immediately while valence (saturated level minus center) stays modest.
      return { valence: Math.tanh(vRaw), arousal: Math.tanh(aRaw), seeking: Math.tanh(seek) };
    },

    snapshot() { return { ...JSON.parse(JSON.stringify(chem)), __seek: seek }; },
    restore(state) {
      const s = JSON.parse(JSON.stringify(state));
      seek = Number.isFinite(s.__seek) ? s.__seek : 0; // back-compat: pre-seeking snapshots restore to no wanting
      delete s.__seek;
      Object.assign(chem, s);
    },
  };
}
