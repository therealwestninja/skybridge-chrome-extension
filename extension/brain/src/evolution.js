// Population/evolution over brain configs (the synthetic-cell selection mechanism: fitter variants
// spread through the population, PROVIDED the trait is causally coupled to fitness -- the T7Max
// lesson). A deterministic GA over a set of scalar genes; fitness(genome) scores a config (e.g. a
// validation metric or task battery over an organism built from those genes). Extends selection.js
// from "keep-the-fit single brain" to "evolve a population of brains".
export function makeEvolution({ genes, fitness, rng, popSize = 8, mutateRate = 0.3, mutateScale = 0.2, elite = 2 } = {}) {
  if (typeof fitness !== "function") throw new Error("evolution needs a fitness() function");
  const names = Object.keys(genes);
  const span = (n) => genes[n][1] - genes[n][0];
  const clampGene = (n, v) => Math.max(genes[n][0], Math.min(genes[n][1], v));
  const randGenome = () => Object.fromEntries(names.map((n) => [n, genes[n][0] + rng.next() * span(n)]));
  const mutate = (g) => Object.fromEntries(names.map((n) =>
    [n, rng.next() < mutateRate ? clampGene(n, g[n] + (rng.next() * 2 - 1) * mutateScale * span(n)) : g[n]]));

  let population = Array.from({ length: popSize }, randGenome);
  const evaluate = (pop) => pop.map((g) => ({ genome: g, fit: fitness(g) })).sort((a, b) => b.fit - a.fit);

  function step() {
    const ranked = evaluate(population);
    const next = ranked.slice(0, elite).map((r) => r.genome); // elitism: keep the best unchanged
    const parentPool = Math.max(1, Math.floor(popSize / 2));
    while (next.length < popSize) next.push(mutate(ranked[Math.floor(rng.next() * parentPool)].genome));
    population = next;
    return { best: ranked[0].genome, bestFit: ranked[0].fit };
  }

  return {
    step,
    run(generations = 10) { let last; for (let i = 0; i < generations; i++) last = step(); return last; },
    population: () => population.map((g) => ({ ...g })),
  };
}
