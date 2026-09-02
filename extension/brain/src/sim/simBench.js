// Sensorimotor benchmark: does the BIOLOGY (gated STDP) actually matter in the loop it was designed
// for? The world is deterministic, so across episodes the ONLY thing that can change the outcome is
// learning. A poorly-wired (weak-STOP) brain crashes into the wall; with learning on, a crash punishes
// the FORWARD that drove it and a safe stop near the wall rewards STOP, so it should learn to halt
// before the wall over episodes. Run learn=true vs learn=false and compare -- if identical, the biology
// is inert even here (a big finding); if the learner stops crashing, it earns its keep.
import { makeRobotBrain } from "./robotBrain.js";
import { makeWorld } from "./world.js";

export function sensorimotorBench({
  episodes = 60, learn = true, seed = 1,
  length = 4, step = 1, fwdWeight = 22, stopWeight = 2, noiseStd = 10,
  crashReward = 6, stopReward = 4, obstacleHigh = 0.5, ticks = 6,
} = {}) {
  const brain = makeRobotBrain({ seed, learn, fwdWeight, stopWeight, noiseStd });
  const rows = [];
  for (let ep = 0; ep < episodes; ep++) {
    const world = makeWorld({ length, step });
    let steps = 0, safeStop = false, outcome = "timeout";
    const maxSteps = length * 3;
    for (let i = 0; i < maxSteps; i++) {
      steps++;
      brain.reset();
      const sensed = world.sense();
      brain.sense(sensed);
      const r = brain.step(ticks);
      const action = r.action === "QUIET" ? "STOP" : r.action;
      world.act(action);
      // Crash -> REWARD STOP: at the wall the obstacle channel is strongly driven (so obstacle->STOP has
      // real eligibility), whereas punishing FORWARD's near-dead clear channel no-ops. Teaches "should
      // have stopped here" via the pathway that was actually active.
      if (world.crashed) { brain.feedback(+1, crashReward, { action: "STOP" }); outcome = "crash"; break; }
      // A deliberate stop while the wall is near = the target behaviour: reward it.
      if (action === "STOP" && sensed.obstacle >= obstacleHigh) { brain.feedback(+1, stopReward, { action: "STOP" }); safeStop = true; outcome = "safe-stop"; break; }
    }
    const w = brain.weightSums();
    rows.push({ ep, outcome, pos: +world.pos.toFixed(2), steps, safeStop, crashed: world.crashed, fwd: w.forward, stop: w.stop });
  }
  const half = Math.floor(episodes / 2);
  const crashRate = (rs) => +(rs.filter((r) => r.crashed).length / Math.max(1, rs.length)).toFixed(2);
  const safeRate = (rs) => +(rs.filter((r) => r.safeStop).length / Math.max(1, rs.length)).toFixed(2);
  return {
    rows,
    crashEarly: crashRate(rows.slice(0, half)), crashLate: crashRate(rows.slice(half)),
    safeEarly: safeRate(rows.slice(0, half)), safeLate: safeRate(rows.slice(half)),
    finalWeights: brain.weightSums(),
  };
}
