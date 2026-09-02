// The continuous sensorimotor loop that replaces the turn-based chat loop: sense the world -> inject
// -> tick the brain -> read the motor action -> act on the world, repeated. Returns the trajectory.
// The brain settles between steps (same discipline as the chat settle) so each decision is clean.
export function pilot(world, brain, { steps = 20, ticks = 6 } = {}) {
  const trajectory = [];
  for (let i = 0; i < steps; i++) {
    brain.reset();
    brain.sense(world.sense());
    const r = brain.step(ticks);
    const action = r.action === "QUIET" ? "STOP" : r.action; // no clear motor decision -> hold (safe)
    world.act(action);
    trajectory.push({ pos: world.pos, action, confidence: r.confidence });
    if (world.crashed) break;
  }
  return trajectory;
}
