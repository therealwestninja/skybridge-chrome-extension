// stuckEscape.js — Tier-2 spike PB-15 [F7]: detect a STUCK attractor — near-zero PROGRESS despite an active drive to
// move/change — and emit a graduated perturbation to break out. Two embodiments, one mechanism:
//   • physical: commanded motion ≠ actual motion (a wheel spinning, a leg wedged) → superimpose a high-frequency dither
//     on the motor command to break stiction (the Samsung terrain-escape trick).
//   • cognitive: brain-state barely changes across ticks despite active drives (rumination) → inject an imagination /
//     temperature jitter to knock the mind out of the loop.
// Same detector (expected-vs-actual progress, which the honesty instrument already computes), same cure. Graduated and
// FELT (rising frustration), never a clamp. PURE: deterministic; the dither PHASE comes from a caller-supplied tick, not
// an RNG, so it's reproducible.

export function makeStuckEscape({ window = 4, progressAt = 0.05, driveAt = 0.3, maxDither = 0.4, growth = 0.1 } = {}) {
  const hist = [];   // recent progress magnitudes
  let stuckFor = 0;
  const c01 = (x) => Math.max(0, Math.min(1, Number(x) || 0));

  // one tick. progress = |actual change| this tick (0..1); drive = how much we WANT to move/change (0..1); tick = a
  // counter used only for the (deterministic) dither phase.
  function step({ progress = 0, drive = 0, tick = 0 } = {}) {
    hist.push(c01(progress)); if (hist.length > window) hist.shift();
    const avg = hist.reduce((a, b) => a + b, 0) / hist.length;
    const stuck = hist.length >= window && avg < progressAt && c01(drive) >= driveAt;   // wanting to move, but not moving
    stuckFor = stuck ? stuckFor + 1 : 0;
    const magnitude = stuck ? Math.min(maxDither, growth * stuckFor) : 0;               // grows the longer we stay stuck
    return {
      stuck, stuckFor,
      dither: +(magnitude * Math.sin(tick * 1.7)).toFixed(3),   // signed perturbation to add to the command / temperature
      magnitude: +magnitude.toFixed(3),
      frustration: +Math.min(1, 0.15 * stuckFor).toFixed(3),    // → feels it (drives disengagement), not a hard clamp
    };
  }
  return { step, reset: () => { hist.length = 0; stuckFor = 0; } };
}
