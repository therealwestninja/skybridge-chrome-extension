// Izhikevich (2003) spiking neuron.
//   v' = 0.04 v^2 + 5 v + 140 - u + I
//   u' = a (b v - u)
//   on v >= 30: v <- c, u <- u + d, emit spike
// Parameters a,b,c,d select the firing type.
export const NEURON_TYPES = {
  RS: { a: 0.02, b: 0.2, c: -65, d: 8 },  // regular spiking (excitatory cortex)
  FS: { a: 0.1, b: 0.2, c: -65, d: 2 },   // fast spiking (inhibitory)
  IB: { a: 0.02, b: 0.2, c: -55, d: 4 },  // intrinsically bursting
  CH: { a: 0.02, b: 0.2, c: -50, d: 2 },  // chattering
};

// NM5: an optional APICAL-DENDRITE compartment (research; off by default). A small weight vector over a
// context vector implements leaky Widrow-Hoff (LMS) online learning IN THE DYNAMICS — the dendrite learns
// to predict the somatic feedforward drive from context and adds that prediction to the somatic current.
// Over repeated similar contexts it makes the neuron respond faster/stronger to the familiar — a SECOND,
// faster learning timescale alongside gated STDP, and (crucially) it forgets (leak), so it's local + fast,
// not a durable weight change. Deterministic, no RNG. Absent -> the neuron is byte-for-byte the old one.
function makeDendrite({ size = 0, lr = 0.05, leak = 0.01, gain = 0.5 } = {}) {
  const w = new Array(size).fill(0);
  return {
    w, lr, leak, gain,
    predict(x) { let s = 0; for (let i = 0; i < w.length; i++) s += w[i] * (x[i] || 0); return s; },
    // Leaky Widrow-Hoff: nudge w to reduce (target - prediction) error, then decay toward 0 (forgetting).
    adapt(x, target) { const err = target - this.predict(x); for (let i = 0; i < w.length; i++) w[i] = (1 - leak) * w[i] + lr * err * (x[i] || 0); },
    reset() { for (let i = 0; i < w.length; i++) w[i] = 0; },
  };
}

export function makeNeuron(type = NEURON_TYPES.RS, { dendrite = null } = {}) {
  const p = { ...type };
  const dend = dendrite ? makeDendrite(dendrite) : null;
  const neuron = {
    a: p.a, b: p.b, c: p.c, d: p.d,
    v: -65,
    u: p.b * -65,
    dendrite: dend, // null unless opted in
    // Advance by dt ms; returns true if a spike was emitted this step.
    // v is integrated in two half-steps for numerical stability (Izhikevich's recipe). Optional `context`
    // drives the apical dendrite: its prediction is added to the somatic current, then it learns (LMS)
    // to predict this step's feedforward drive from that context.
    step(I, dt = 1, { context = null } = {}) {
      let drive = I;
      if (dend && context) drive += dend.gain * dend.predict(context); // apical contribution to the soma
      const half = dt / 2;
      this.v += half * (0.04 * this.v * this.v + 5 * this.v + 140 - this.u + drive);
      this.v += half * (0.04 * this.v * this.v + 5 * this.v + 140 - this.u + drive);
      this.u += dt * (this.a * (this.b * this.v - this.u));
      if (dend && context) dend.adapt(context, I); // learn to predict the feedforward drive from context
      if (this.v >= 30) {
        this.v = this.c;
        this.u += this.d;
        return true;
      }
      return false;
    },
    reset() {
      this.v = -65;
      this.u = this.b * -65;
      // Note: reset() clears transient membrane state only; the dendrite's learned weights persist across
      // settle() (fast in-context memory). Use dendrite.reset() to wipe them.
    },
  };
  return neuron;
}
