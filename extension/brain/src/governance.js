// Version control for the substrate: baseline (genome), snapshots, factory reset,
// and tag-based selective undo via delta inversion.
export function makeGovernance({ synapses, ledger }) {
  let baseline = null;

  const captureWeights = () => synapses.map(s => s.weight);
  // Guard the size: applying a shorter/foreign snapshot would write `undefined` into trailing synapses (NaN cascade).
  const applyWeights = (w) => { if (!Array.isArray(w) || w.length !== synapses.length) throw new Error(`governance: weight size mismatch (expected ${synapses.length}, got ${Array.isArray(w) ? w.length : typeof w})`); for (let i = 0; i < synapses.length; i++) synapses[i].weight = w[i]; };

  return {
    captureBaseline() {
      baseline = captureWeights();
    },
    snapshot(name = null) {
      // Boundary as a monotonic ledger ID, not array length: the ledger is a bounded FIFO, so length no
      // longer maps to a stable position once eviction has shifted the head.
      return { name, weights: captureWeights(), ledgerMark: ledger.mark ? ledger.mark() : ledger.all().length };
    },
    restore(snap) {
      applyWeights(snap.weights);
      // Drop the deltas appended after the snapshot (id-based; survives eviction). Fall back to the old
      // length-based truncation for snapshots taken before ledgerMark existed.
      if (ledger.truncateTo && snap.ledgerMark !== undefined) ledger.truncateTo(snap.ledgerMark);
      else ledger.all().length = snap.ledgerLength ?? ledger.all().length;
    },
    factoryReset() {
      if (!baseline) throw new Error("no baseline captured");
      applyWeights(baseline);
      ledger.all().length = 0;
    },
    undoTag(tag) {
      const toUndo = ledger.byTag(tag);
      // Invert deltas in reverse chronological order.
      for (let i = toUndo.length - 1; i >= 0; i--) {
        for (const d of toUndo[i].deltas) synapses[d.synapse].weight -= d.delta;
      }
      // Drop those events from the ledger, keeping the rest in order.
      const undoneIds = new Set(toUndo.map(e => e.id));
      const remaining = ledger.all().filter(e => !undoneIds.has(e.id));
      ledger.all().length = 0;
      for (const e of remaining) ledger.all().push(e);
    },
  };
}
