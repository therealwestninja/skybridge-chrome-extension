import { clamp } from "./math.js";
import { DEFAULT_SETPOINTS } from "./neuromodulation.js";
// pharmacodynamics.js — the customizable "compound" layer for the behavioral-pharmacology sandbox. A compound is a
// MULTI-CHANNEL perturbation with kinetics; this converts (compound, dose) applied over time into the EFFECTIVE tonic
// neuromodulator SETPOINTS that the behavioral gate reads. It turns the two validated findings — the opponent gate
// (akinesia↔window↔dyskinesia over a channel's tonic level) and autoreceptor desensitization (the SSRI delay) — into a
// dose/time sandbox a user can point at their own compound + disease.
//
// Two per-channel mechanisms (round, a-priori parameters — a FUNCTIONAL cartoon, not PK/receptor biophysics):
//   • "tonic"    — directly shifts the channel's tonic setpoint by dose·gain, fast on/off (an L-DOPA-like agent).
//   • "reuptake" — raises SYNAPTIC drive at once; a somatodendritic AUTORECEPTOR clamps NET output and DESENSITIZES
//                  slowly under sustained excess. NET output IS the effective tonic drive → the therapeutic delay.
//
// Everything downstream (the opponent gate, the valence read-out) already reads a tonic setpoint, so this layer needs
// no changes there — it just supplies the setpoint trajectory. NOT validated against data; for expert adjudication.


// A regimen = a disease baseline + a compound at a dose, stepped over time. Returns the effective tonic setpoints.
// `compound.targets`: { <channel>: { mechanism:"tonic"|"reuptake", gain?, block?, autoreceptor?, desensitize?,
//                                     fbStrength?, desRate?, floor? } }
export function makeRegimen({ baselines = {}, compound = null, dose = 1, desRate = 0.045, fbStrength = 1.0, autoFloor = 0.15 } = {}) {
  const targets = (compound && compound.targets) || {};
  const autoGain = {};                                        // per reuptake-channel autoreceptor sensitivity (1 = full)
  for (const ch in targets) if (targets[ch].mechanism === "reuptake") autoGain[ch] = 1.0;

  function effective(onDrug) {
    const eff = { ...baselines };
    for (const ch in targets) {
      const t = targets[ch], base = baselines[ch] ?? 0.2;
      if (!onDrug) { eff[ch] = base; continue; }
      if (t.mechanism === "tonic") {
        eff[ch] = clamp(base + dose * (t.gain ?? 0.5), 0, 1);              // direct tonic shift (fast PK cartoon)
      } else if (t.mechanism === "reuptake") {
        const synaptic = clamp(base * (1 + dose * (t.block ?? 1.0)), 0, 1); // reuptake block raises synaptic immediately
        const excess = Math.max(0, synaptic - base);
        const fb = (t.autoreceptor === false) ? 0 : (t.fbStrength ?? fbStrength) * autoGain[ch] * excess; // autoreceptor clamp
        eff[ch] = clamp(synaptic - fb, 0, 1);                              // NET serotonergic output
      }
    }
    return eff;
  }

  return {
    // Advance one step (a "day") and return the effective tonic setpoints AFTER any receptor adaptation this step.
    step(onDrug = true) {
      const eff = effective(onDrug);
      if (onDrug) for (const ch in targets) {                              // slow autoreceptor desensitization
        const t = targets[ch];
        if (t.mechanism === "reuptake" && t.autoreceptor !== false && t.desensitize !== false) {
          const excess = Math.max(0, clamp((baselines[ch] ?? 0.2) * (1 + dose * (t.block ?? 1.0)), 0, 1) - (baselines[ch] ?? 0.2));
          autoGain[ch] = Math.max(t.floor ?? autoFloor, autoGain[ch] - (t.desRate ?? desRate) * excess);
        }
      }
      return eff;
    },
    // Steady state for a FAST (tonic) compound — the effective setpoints with no slow adaptation (dose-response use).
    steady(onDrug = true) { return effective(onDrug); },
    reset() { for (const ch in autoGain) autoGain[ch] = 1.0; },
    autoGain: (ch) => autoGain[ch],
  };
}

// Ready-made archetypes (a starting library; users define their own {name, targets}). Width is kept on the two axes
// the mechanism is VALIDATED on: the dopamine action-window (opponent gate, build A) and the serotonin delay
// (autoreceptor, build C). NE/ACh compounds (anxiolytics, pro-cognitives) are a deliberate omission until those
// behavioural read-outs are validated too — width gated on a proven method, not multiplied cartoons.
export const COMPOUNDS = {
  ldopa:        { name: "L-DOPA (dopamine precursor)",      targets: { dopamine: { mechanism: "tonic", gain: 0.60 } } },  // RAISES dopamine
  stimulant:    { name: "psychostimulant",                 targets: { dopamine: { mechanism: "tonic", gain: 0.45 } } },  // RAISES dopamine (weaker); overdose → dyskinesia/impulsivity
  antipsychotic:{ name: "D2 antagonist (antipsychotic)",   targets: { dopamine: { mechanism: "tonic", gain: -0.50 } } }, // LOWERS dopamine — the MIRROR of L-DOPA; overdose → drug-induced parkinsonism (akinesia)
  ssri:         { name: "SSRI (reuptake inhibitor)",        targets: { serotonin: { mechanism: "reuptake", block: 2.0, autoreceptor: true } } }, // RAISES net serotonin, with the autoreceptor delay
};

// Disease models = the healthy baseline with ONE channel perturbed. `healthy` IS the shared DEFAULT_SETPOINTS
// (DA 0.2 / NE 0.3 / 5-HT 0.5 / ACh 0.3), so a retune of the setpoints propagates here instead of leaving a stale
// copy — and each disease reads as exactly "healthy, but <channel> shifted."
export const DISEASES = {
  healthy:     { ...DEFAULT_SETPOINTS },
  parkinsons:  { ...DEFAULT_SETPOINTS, dopamine: 0.05 },  // tonic dopamine DEFICIT  → akinesia; L-DOPA/stimulant treat it
  psychosis:   { ...DEFAULT_SETPOINTS, dopamine: 0.60 },  // hyperdopaminergic EXCESS → dyskinesia/agitation; the antipsychotic treats it (overdose → parkinsonism)
  depression:  { ...DEFAULT_SETPOINTS, serotonin: 0.28 }, // low serotonergic tone   → low mood; the SSRI treats it (with the delay)
};
