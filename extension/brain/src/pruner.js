// Fitness-coupled pruning (the synthetic-cell "T7Max" rule: a trait spreads only if it is causally
// coupled to fitness). Given toggleable subsystems, each with a budget cost, leave-one-out ablate to
// measure each one's fitness CONTRIBUTION, and keep it enabled only if the contribution justifies its
// cost. Freeloaders (spend budget without earning fitness) get pruned. Reuses the ablation+fitness
// pattern; a companion to selection.js (which gates learning) -- this gates whole subsystems.
export function makePruner({ fitness, costWeight = 0 } = {}) {
  if (typeof fitness !== "function") throw new Error("pruner needs a fitness() function");
  return {
    // subsystems: [{ name, cost, enable(on) }]. Returns per-subsystem verdicts and applies them.
    review(subsystems = []) {
      const baseline = fitness();
      const verdicts = subsystems.map((s) => {
        s.enable(false);
        const without = fitness();
        s.enable(true); // restore so each contribution is measured independently against baseline
        const contribution = baseline - without;
        return { name: s.name, contribution, cost: s.cost || 0, kept: contribution >= (s.cost || 0) * costWeight };
      });
      subsystems.forEach((s, i) => s.enable(verdicts[i].kept)); // prune the freeloaders
      return verdicts;
    },
  };
}
