import { clamp } from "./math.js";

// Append-only plasticity ledger: the audit log of every committed weight change. Bounded (FIFO) so a
// long-lived / on-device brain (Sweetie-bot) can't leak unbounded audit history; ids are MONOTONIC (not
// the array index) so eviction + undo never reuse an id.
export function makeLedger({ cap = 5000 } = {}) {
  const events = [];
  let nextId = 0;
  return {
    append({ tags = [], trigger = null, deltas = [], chemState = {}, timestamp = 0 }) {
      const id = nextId++;
      events.push({ id, tags: [...tags], trigger, deltas: deltas.map(d => ({ ...d })), chemState: { ...chemState }, timestamp });
      if (events.length > cap) events.shift(); // bound growth; deep undo beyond the cap is not retained
      return id;
    },
    all() { return events; },
    byTag(tag) { return events.filter(e => e.tags.includes(tag)); },
    byId(id) { return events.find(e => e.id === id) ?? null; },
    // Snapshot boundary as a monotonic ID (not array length -- eviction shifts positions but never ids).
    mark() { return nextId; },
    // Drop every event appended at/after `m` (governance restore). Id-based so it survives FIFO eviction.
    truncateTo(m) { for (let i = events.length - 1; i >= 0; i--) if (events[i].id >= m) events.splice(i, 1); },
    // Restore from a serialized event list, resuming the monotonic id counter past the highest id.
    load(evts = []) { events.length = 0; for (const e of evts) events.push(e); nextId = events.reduce((m, e) => Math.max(m, (e.id ?? -1) + 1), 0); },
  };
}

// Trace-based STDP, gated by a neuromodulatory third factor (dopamine).
// Indexed: only synapses incident to a spiking neuron are examined (its incoming +
// outgoing), processed in ascending synapse-index order so results are bit-identical
// to the original full-scan implementation. Eligibility from spike-timing is only
// COMMITTED to weight (and ledger) when `gate` > 0.
export function makeStdp({
  synapses, incoming, outgoing, ledger,
  aPlus = 1.0, aMinus = 1.0, tau = 20,
  learningRate = 0.1, gateEpsilon = 1e-3, commitEpsilon = 1e-6,
  maxWeight = 30, traceEpsilon = 1e-3,
  // HOMEOSTATIC PLASTICITY (opt-in; default OFF → behaviour stays bit-identical to the full-scan reference).
  // Ported (algorithm, not code — source is Python) from Cortex hypermnesia-mcp/core/homeostatic_plasticity.py:
  //   • BCM sliding threshold (Abraham & Bear 1996): a per-neuron modification threshold θ = EMA(activity²) that
  //     RISES as a neuron stays active, so further potentiation onto an already-hyperactive neuron is progressively
  //     damped — a principled brake on the runaway the note below admits is otherwise "prevented in practice".
  //   • Synaptic scaling (Turrigiano 2008): multiplicative rescale of a neuron's incoming weights toward a target
  //     activity, preserving relative structure while bounding total drive. Applied on demand via homeostaticScale().
  bcm = null,   // pass e.g. { thetaDecay: 0.95, gain: 1.0, ltpFloor: 0.2, target: 0.1, scaleRate: 0.1 } to enable
} = {}) {
  const decay = Math.exp(-1 / tau); // per-ms trace decay
  // Traces indexed by neuron id (grown lazily).
  const preTrace = [];
  const postTrace = [];
  const grow = (arr, i) => { while (arr.length <= i) arr.push(0); };

  // Homeostatic state (only touched when BCM is enabled): act[] = EMA rate estimate per neuron; theta[] = the BCM
  // sliding modification threshold = EMA(act²). Persist across turns (metaplasticity is slow) — clearTraces leaves them.
  const BCM = bcm ? { thetaDecay: 0.95, gain: 1.0, ltpFloor: 0.2, target: 0.1, scaleRate: 0.1, ...bcm } : null;
  const act = [];
  const theta = [];

  return {
    // Zero the eligibility traces. Called when settling between turns so a turn's spike-timing
    // eligibility does not leak into the next turn's STDP or feedback credit assignment.
    clearTraces() { preTrace.length = 0; postTrace.length = 0; },

    // Call once per tick with the indices that spiked this tick + context.
    observeSpikes(spikedIndices, { gate = 0, chemState = {}, timestamp = 0, tags = [] } = {}) {
      // Decay all existing traces one tick.
      for (let i = 0; i < preTrace.length; i++) preTrace[i] *= decay;
      for (let i = 0; i < postTrace.length; i++) postTrace[i] *= decay;

      const open = gate > gateEpsilon;
      const deltas = [];

      for (const idx of spikedIndices) {
        // Synapses touching this neuron, ascending, deduped (matches scan order).
        const seen = new Set();
        const incident = [];
        const out = outgoing[idx] || [];
        const inc = incoming[idx] || [];
        for (const s of out) if (!seen.has(s)) { seen.add(s); incident.push(s); }
        for (const s of inc) if (!seen.has(s)) { seen.add(s); incident.push(s); }
        incident.sort((a, b) => a - b);

        for (const s of incident) {
          const syn = synapses[s];
          let dw = 0;
          // Pre spike (this neuron is the synapse source): depress using target's post-trace.
          if (syn.source === idx) {
            grow(postTrace, syn.target);
            dw -= aMinus * postTrace[syn.target];
          }
          // Post spike (this neuron is the synapse target): potentiate using source's pre-trace.
          if (syn.target === idx) {
            grow(preTrace, syn.source);
            let ltp = aPlus * preTrace[syn.source];
            // BCM metaplasticity: the higher a neuron's sliding threshold θ (its recent activity²), the harder to
            // potentiate it further — a bounded brake in [ltpFloor, 1]. Disabled ⇒ ltp is untouched (bit-identical).
            if (BCM) ltp *= Math.max(BCM.ltpFloor, 1 / (1 + BCM.gain * (theta[idx] || 0)));
            dw += ltp;
          }
          if (dw !== 0 && open) {
            const applied = learningRate * gate * dw;
            // NOTE: STDP weight is intentionally NOT clamped here (unlike the feedback path's maxWeight
            // cap) -- it must stay bit-identical to the full-scan reference, and runaway is prevented in
            // practice by the small gated learning rate + fitness-gated selection + per-turn settle.
            if (Math.abs(applied) > commitEpsilon) {
              syn.weight += applied;
              deltas.push({ synapse: s, delta: applied });
            }
          }
        }
      }

      // Bump traces for neurons that spiked this tick (after computing dw).
      for (const idx of spikedIndices) {
        grow(preTrace, idx); preTrace[idx] += aPlus;
        grow(postTrace, idx); postTrace[idx] += aMinus;
      }

      // Update homeostatic state (activity-driven, NOT reward-gated — homeostasis runs whether or not the gate is
      // open). act = EMA of the per-tick spike indicator; θ = EMA(act²) = the BCM sliding threshold. Only when enabled.
      if (BCM) {
        const d = BCM.thetaDecay;
        for (let i = 0; i < act.length; i++) act[i] *= d;
        for (const idx of spikedIndices) { grow(act, idx); act[idx] += (1 - d); }
        while (theta.length < act.length) theta.push(0);
        for (let i = 0; i < act.length; i++) { const c = act[i] || 0; theta[i] = d * theta[i] + (1 - d) * c * c; }
      }

      if (deltas.length > 0) {
        ledger.append({ tags, trigger: chemState.trigger ?? null, deltas, chemState, timestamp });
      }
      return deltas;
    },

    // SYNAPTIC SCALING (Turrigiano) — multiplicatively rescale each neuron's INCOMING weights toward keeping its
    // activity near `target`: w *= 1 + rate·(target − act). Multiplicative ⇒ preserves each synapse's SIGN and the
    // relative structure the STDP learned, while bounding total drive so no cell runs away. Call at settle. Ledgered
    // (auditable/undoable), tagged "homeostatic". No-op unless BCM is enabled.
    homeostaticScale({ target = BCM && BCM.target, rate = BCM && BCM.scaleRate, tags = [], timestamp = 0 } = {}) {
      if (!BCM) return [];
      const tgt = Number.isFinite(+target) ? +target : 0.1;
      const r = Number.isFinite(+rate) ? +rate : 0.1;
      const deltas = [];
      for (let n = 0; n < act.length; n++) {
        const factor = 1 + r * (tgt - (act[n] || 0));
        if (factor === 1) continue;
        for (const s of (incoming[n] || [])) {
          const syn = synapses[s];
          const newW = syn.weight * factor;   // multiplicative → sign preserved
          const delta = newW - syn.weight;
          if (Math.abs(delta) > commitEpsilon) { syn.weight = newW; deltas.push({ synapse: s, delta }); }
        }
      }
      if (deltas.length > 0) ledger.append({ tags: [...tags, "homeostatic"], trigger: "homeostatic-scaling", deltas, chemState: {}, timestamp });
      return deltas;
    },

    // audit/inspection of the homeostatic state (copies; empty when BCM disabled).
    metaState() { return { enabled: !!BCM, act: act.slice(), theta: theta.slice() }; },

    // One-shot neuromodulated credit assignment from explicit feedback. Uses the LIVE eligibility
    // traces to find the synapses that drove the just-finished response: reward (sign +1) amplifies
    // them, punishment (sign -1) attenuates them. This is how the brain learns from criticism, not
    // just reward (the gated-STDP path above is dopamine/reward-only). Magnitude-only: a synapse's
    // SIGN is preserved (excitatory stays excitatory, never flips), and |weight| is bounded by
    // maxWeight. Deltas are ledgered with the given tags, so a feedback episode is undoable.
    modulate(sign, magnitude = 1, { tags = [], timestamp = 0, targets = null } = {}) {
      const restrict = targets ? new Set(targets) : null;
      const deltas = [];
      for (let s = 0; s < synapses.length; s++) {
        const syn = synapses[s];
        if (restrict && !restrict.has(syn.target)) continue; // localize credit to chosen action
        // Localized: credit the ACTIVE INPUTS to the chosen action (presynaptic trace only) so praise
        // can revive an action even if it didn't fire this time. Global: only pathways that were
        // genuinely co-active (pre x post coincidence).
        const elig = restrict
          ? (preTrace[syn.source] || 0)
          : (preTrace[syn.source] || 0) * (postTrace[syn.target] || 0);
        if (elig <= traceEpsilon) continue;
        const polarity = syn.weight < 0 ? -1 : 1; // keep the synapse's sign
        // Attenuation floors at zero (no sign flip); amplification is bounded by maxWeight.
        const mag = clamp(Math.abs(syn.weight) + sign * learningRate * magnitude * elig, 0, maxWeight);
        const newW = polarity * mag;
        const delta = newW - syn.weight;
        if (Math.abs(delta) > commitEpsilon) {
          syn.weight = newW;
          deltas.push({ synapse: s, delta });
        }
      }
      if (deltas.length > 0) ledger.append({ tags, trigger: "feedback", deltas, chemState: {}, timestamp });
      return deltas;
    },
  };
}
