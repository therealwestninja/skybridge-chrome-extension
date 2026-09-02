// One directed connection. weight sign = type: + excitatory (EPSP), - inhibitory (IPSP).
export function makeSynapse({ source, target, weight, delay = 1 }) {
  return {
    source,
    target,
    weight,
    delay,
    // On a source spike, schedule `weight` of current to the target after `delay`.
    transmit(delayQueue) {
      delayQueue.schedule(this.target, this.delay, this.weight);
    },
  };
}
