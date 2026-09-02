import { NEURON_TYPES } from "./neuron.js";

// A region is a pool of E/I neurons added to a network, with sparse intra-region
// recurrence. Excitatory = RS (positive outgoing weights); inhibitory = FS (negative).
export function makeRegion({
  network, size, excitatoryRatio = 0.8, recurrence = 0.1, rng,
  excWeight = 8, inhWeight = 12, delay = 1,
}) {
  const start = network.neuronCount;
  const nExc = Math.round(size * excitatoryRatio);
  const ids = [];
  for (let i = 0; i < size; i++) {
    ids.push(network.addNeuron(i < nExc ? NEURON_TYPES.RS : NEURON_TYPES.FS));
  }
  const isExc = (id) => (id - start) < nExc;

  // Sparse recurrent wiring; sign follows the SOURCE neuron's type.
  for (const src of ids) {
    for (const dst of ids) {
      if (src === dst) continue;
      if (rng.next() < recurrence) {
        network.connect(src, dst, isExc(src) ? excWeight : -inhWeight, delay);
      }
    }
  }

  return {
    start, size, ids,
    excitatory: ids.filter(isExc),
    inhibitory: ids.filter((id) => !isExc(id)),
    isExc,
    contains: (id) => id >= start && id < start + size,
  };
}
