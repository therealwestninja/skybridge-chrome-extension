import { makeNeuron } from "./neuron.js";
import { makeSynapse } from "./synapse.js";
import { makeDelayQueue } from "./delayQueue.js";
import { makeRng } from "./rng.js";

// Owns neurons, synapses, and the delay queue. tick() advances one ms.
export function makeNetwork({ seed = 1, maxDelay = 20, noiseStd = 0 } = {}) {
  const neurons = [];
  const synapses = [];
  const outgoing = []; // outgoing[i] = synapse indices FROM neuron i
  const incoming = []; // incoming[i] = synapse indices TO neuron i
  const delayQueue = makeDelayQueue(maxDelay);
  const rng = makeRng(seed);

  const net = {
    get neuronCount() { return neurons.length; },
    get synapseCount() { return synapses.length; },

    addNeuron(type) {
      neurons.push(makeNeuron(type));
      outgoing.push([]);
      incoming.push([]);
      return neurons.length - 1;
    },

    connect(source, target, weight, delay = 1) {
      const s = makeSynapse({ source, target, weight, delay });
      synapses.push(s);
      const idx = synapses.length - 1;
      outgoing[source].push(idx);
      incoming[target].push(idx);
      return idx;
    },

    // inputs: { neuronIndex: externalCurrent }. Returns indices that spiked this tick.
    // gain scales the net input current (volume-transmission neuromodulation, e.g. norepinephrine
    // arousal -> excitability); noiseScale scales the intrinsic noise (NE also adds jitter).
    tick(inputs = {}, { gain = 1, noiseScale = 1 } = {}) {
      const due = delayQueue.popDue(); // delivered synaptic current arriving now
      const I = new Array(neurons.length).fill(0);
      for (const { target, amount } of due) I[target] += amount;
      for (const k in inputs) I[+k] += inputs[k];
      if (gain !== 1) for (let i = 0; i < I.length; i++) I[i] *= gain;
      if (noiseStd > 0) for (let i = 0; i < I.length; i++) I[i] += rng.gaussian(0, noiseStd * noiseScale);

      const spiked = [];
      for (let i = 0; i < neurons.length; i++) {
        if (neurons[i].step(I[i], 1)) spiked.push(i);
      }
      // Relay this tick's spikes onto outgoing synapses (scheduled with delay).
      for (const i of spiked) {
        for (const sIdx of outgoing[i]) synapses[sIdx].transmit(delayQueue);
      }
      return spiked;
    },

    // Return neurons to rest and drop in-flight synaptic currents, WITHOUT touching weights.
    // Used to settle transient activation between conversational turns (prevents refractory
    // carry-over from suppressing the next turn).
    resetActivation() {
      for (const n of neurons) n.reset();
      delayQueue.clear();
    },

    // Accessors used by plasticity/governance later.
    _neurons: neurons,
    _synapses: synapses,
    _outgoing: outgoing,
    _incoming: incoming,
  };
  return net;
}
