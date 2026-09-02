// Wire the population GA to REAL brain configs: evolve a genome of persona chemical SETPOINTS (which
// drive neuron gain/excitability + mood) against a behavioural fitness measured on an organism built
// from those genes. This is the concrete application of evolution.js -- auto-tuning the brain's
// neuromodulation toward a behavioural target, the synthetic-cell selection loop over real traits.
import { makeOrganism } from "./organism.js";
import { makeEvolution } from "./evolution.js";

const SMALL = { sensory: 30, memory: 20, association: 60, salience: 30, decision: 30 };

// Genome = persona chemical setpoints (dopamine/norepinephrine/serotonin), the tunable "traits".
export const BRAIN_GENES = { dopamine: [0.05, 0.6], norepinephrine: [0.1, 0.9], serotonin: [0.1, 0.9] };

// Excitability = total spikes to a standard sensory input, at rest (a cheap behavioural readout that
// the setpoints genuinely move via the norepinephrine/serotonin -> gain wiring).
export function excitability(setpoints, { seed = 1, sizes = SMALL, input = 0.5, ticks = 30 } = {}) {
  const o = makeOrganism({ seed, sizes, personality: { setpoints } });
  o.inject("sensory", input);
  let spikes = 0;
  for (let t = 0; t < ticks; t++) spikes += o.tick({ tags: ["t"] }).length;
  return spikes;
}

// Evolve persona setpoints toward a TARGET excitability. Returns { best (genome), bestFit }.
export function evolveBrain({ rng, target = 60, generations = 6, popSize = 10, sizes } = {}) {
  const fitness = (g) => -Math.abs(excitability(g, { sizes }) - target);
  return makeEvolution({ genes: BRAIN_GENES, fitness, rng, popSize, elite: 2 }).run(generations);
}
