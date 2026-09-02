// A shared, limited ENERGY budget for the brain (mined from the synthetic-cell paper: an active
// capability has a real, subtractive resource cost -- "the weaker cells lose more than the stronger
// gain"). Subsystems draw from one pool, so the brain can't do everything at once; scarcity becomes a
// control signal (adaptive load-shedding now; throttling / sharpening / fitness-pruning later).
export function makeMetabolism({ max = 100, regen = 35, start = max } = {}) {
  let energy = Math.max(0, Math.min(max, start));
  return {
    level: () => energy / max,               // fraction in [0,1]
    energy: () => energy,
    afford: (cost) => energy >= cost,
    spend: (cost) => { energy = Math.max(0, energy - cost); return energy; },
    recover: () => { energy = Math.min(max, energy + regen); return energy; },
    restore: () => { energy = max; return energy; }, // full refill (rest / sleep)
  };
}
