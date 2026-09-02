// DEPRECATED / LEGACY composition root — SUPERSEDED by organism.js, which is the production substrate root (adds
// codec/action-readout, activation signatures, spike accumulation, governance snapshot/restore). This is kept only
// for the legacy integration test; do NOT wire it into new code — use makeOrganism.
// Composition root: wires network + neuromodulation + gated STDP + governance
// into one tickable substrate. No domain logic of its own.
import { makeNetwork } from "./network.js";
import { makeNeuromodulation, CHEMICALS } from "./neuromodulation.js";
import { makeLedger, makeStdp } from "./plasticity.js";
import { makeGovernance } from "./governance.js";

export function makeBrain({ seed = 1, maxDelay = 20, noiseStd = 0, personality = {} } = {}) {
  const net = makeNetwork({ seed, maxDelay, noiseStd });
  const chem = makeNeuromodulation(personality);
  const ledger = makeLedger();
  const stdp = makeStdp({ synapses: net._synapses, incoming: net._incoming, outgoing: net._outgoing, ledger });
  const gov = makeGovernance({ synapses: net._synapses, ledger });
  let clock = 0;

  return {
    ledger,
    addNeuron: (type) => net.addNeuron(type),
    connect: (a, b, w, d) => net.connect(a, b, w, d),
    weightOf: (synIdx) => net._synapses[synIdx].weight,

    // Phasic event helpers.
    reward: (mag = 1) => chem.burst(CHEMICALS.DOPAMINE, mag),
    alarm: (mag = 1) => chem.burst(CHEMICALS.NOREPINEPHRINE, mag),

    // One simulation step.
    tick({ inputs = {}, tags = [] } = {}) {
      chem.tick();
      const spiked = net.tick(inputs);
      stdp.observeSpikes(spiked, {
        gate: chem.plasticityGate(),
        chemState: {
          dopamine: chem.level(CHEMICALS.DOPAMINE),
          norepinephrine: chem.level(CHEMICALS.NOREPINEPHRINE),
          serotonin: chem.level(CHEMICALS.SEROTONIN),
          acetylcholine: chem.level(CHEMICALS.ACETYLCHOLINE),
        },
        timestamp: clock++,
        tags,
      });
      return spiked;
    },

    mood: () => chem.readout(),

    // Governance passthrough.
    captureBaseline: () => gov.captureBaseline(),
    snapshot: (name) => ({ ...gov.snapshot(name), chem: chem.snapshot() }),
    restore: (snap) => { gov.restore(snap); if (snap.chem) chem.restore(snap.chem); },
    undoTag: (tag) => gov.undoTag(tag),
    factoryReset: () => gov.factoryReset(),
  };
}
