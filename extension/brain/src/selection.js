// Fitness-gated learning ("selection over snapshots"): keep a learning episode only if it doesn't
// regress a fitness probe, else roll the organism back to the checkpoint (via governance snapshot/
// restore). Adapts the NEAT keep-the-fit/discard-the-unfit principle to a single brain; guards
// against degenerate learning (reward-hacking, catastrophic forgetting).
//
// fitness() returns a scalar (higher = better): validation metrics, a task/bench score, or a
// held-out probe battery. tolerance is how far fitness may dip before an episode is rejected.
export function makeSelection({ organism, fitness, tolerance = 0, historyCap = 512 }) {
  if (typeof fitness !== "function") throw new Error("selection needs a fitness() function");
  let snap = null, best = null;
  const history = []; // bounded: one record per review(); a lifelong brain would otherwise grow it without limit

  return {
    // Open an episode: checkpoint weights + chemistry, and record the fitness to beat.
    checkpoint() {
      snap = organism.snapshot("selection");
      best = fitness();
      return best;
    },

    // Close an episode: keep the learning iff fitness held within tolerance of the checkpoint;
    // otherwise restore the checkpoint so the episode leaves no trace.
    review({ tag = "selection" } = {}) {
      if (snap === null) throw new Error("review() called before checkpoint()");
      const before = best;
      const after = fitness();
      const kept = after >= before - tolerance;
      if (kept) {
        best = after;
        snap = organism.snapshot("selection"); // advance the checkpoint to the kept state
      } else {
        organism.restore(snap);                // discard the regression
      }
      const rec = { kept, before, after, tag };
      history.push(rec);
      if (history.length > historyCap) history.shift();
      return rec;
    },

    best: () => best,
    history: () => history.slice(),
  };
}
