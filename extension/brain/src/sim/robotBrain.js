// A minimal sensorimotor organism, built from the SAME substrate primitives as the chat brain
// (network / region / codec) but with a motor genome instead of a conversational one. This proves the
// substrate is body-agnostic. Genome: a clear path drives FORWARD, a near obstacle drives STOP -- the
// mirror of chat approach/avoid (reward->reply, threat->escalate).
//
// LEARNING (opt-in via `learn`): the same gated-STDP + one-shot modulate the chat brain uses, so we can
// actually TEST whether the biology matters in the sensorimotor loop -- crash -> punish the FORWARD that
// drove it; a safe stop near the wall -> reward STOP. Genome weights are parameterized so a poorly-wired
// (weak-STOP) brain that crashes can be pitted against a learner that fixes itself over episodes.
import { makeNetwork } from "../network.js";
import { makeRegion } from "../region.js";
import { makeCodec } from "../codec.js";
import { makeRng } from "../rng.js";
import { makeStdp, makeLedger } from "../plasticity.js";
import { makeEscalationLadder } from "../escalationLadder.js";

// `escalation` (opt-in): PB-1 demand-driven cognition in the BODY. The corridor gives real spatial signals —
// obstacle proximity (how near the wall) and its rise across ticks (approaching) — which are exactly the
// radar-like presence/approach the ladder was built for. When enabled, each step() runs the ladder over
// { presence, approach, salience } derived from those senses and GATES the expensive learning path (STDP
// eligibility accrual) behind it: a far, quiet tick stays "reflex" and skips eligibility; a near/approaching
// tick escalates to "full" and learns. The ladder LEVEL is returned in the step output. Default (no
// `escalation`) leaves behaviour byte-identical — nothing runs and nothing is gated.
export function makeRobotBrain({ seed = 1, sizes = {}, learn = false, fwdWeight = 9, stopWeight = 10, learningRate = 0.1, noiseStd = 0, escalation = null } = {}) {
  const s = { clear: 20, obstacle: 20, motor: 30, ...sizes };
  // Neuron noise makes population rates GRADED (a sigmoid of drive) instead of a hard threshold, so
  // synaptic weights -- and thus STDP learning -- actually translate into graded behavioral change.
  const net = makeNetwork({ seed, noiseStd });
  const rng = makeRng(seed * 7 + 1); // dedicated wiring rng (matches the chat connectome convention)

  const clearR = makeRegion({ network: net, size: s.clear, recurrence: 0.02, rng });
  const obstacleR = makeRegion({ network: net, size: s.obstacle, recurrence: 0.02, rng });
  const motor = makeRegion({ network: net, size: s.motor, recurrence: 0.05, rng });

  const driveTo = (src, dst, prob, weight, delay) => {
    for (const a of src) for (const b of dst) if (rng.next() < prob) net.connect(a, b, weight, delay);
  };

  const names = ["FORWARD", "STOP"];
  const exc = motor.excitatory;
  const per = Math.floor(exc.length / names.length);
  const actions = {};
  names.forEach((n, i) => { actions[n] = i === names.length - 1 ? exc.slice(i * per) : exc.slice(i * per, (i + 1) * per); });

  // Genome: clear -> FORWARD (advance when open), obstacle -> STOP (halt near the wall).
  driveTo(clearR.excitatory, actions.FORWARD, 0.5, fwdWeight, 1);
  driveTo(obstacleR.excitatory, actions.STOP, 0.6, stopWeight, 1);

  const codec = makeCodec({ channels: { clear: clearR.ids, obstacle: obstacleR.ids }, actions });

  const ledger = learn ? makeLedger() : null;
  const stdp = learn ? makeStdp({ synapses: net._synapses, incoming: net._incoming, outgoing: net._outgoing, ledger, learningRate }) : null;
  let clock = 0;
  let lastAction = "STOP";

  // Opt-in compute-tier gate (see header). Signal mapping thresholds live alongside the ladder config.
  const escCfg = escalation === true ? {} : (escalation || {});
  const ladder = escalation ? makeEscalationLadder(escCfg) : null;
  const presenceAt = escCfg.presenceAt ?? 0.35;   // obstacle proximity that counts as "something is there"
  const approachDelta = escCfg.approachDelta ?? 0.05; // obstacle rise across ticks that counts as "approaching"
  let curClear = 0, curObstacle = 0, lastObstacle = 0;

  return {
    sense({ clear = 0, obstacle = 0 } = {}) { curClear = clear; curObstacle = obstacle; codec.inject("clear", clear); codec.inject("obstacle", obstacle); },
    step(ticks = 6) {
      let esc = null;
      if (ladder) {
        esc = ladder.step({
          presence: curObstacle >= presenceAt,
          approach: (curObstacle - lastObstacle) >= approachDelta,
          salience: curObstacle,        // in this world, proximity IS the salient signal
          drive: 0, arousal: 0,         // the sim carries no affect — feed the real zeros, don't fabricate
        });
        lastObstacle = curObstacle;
      }
      // Gate the expensive path (STDP eligibility accrual): only at heuristic/full, or always when no ladder.
      const runExpensive = !ladder || esc.level !== "reflex";
      for (let t = 0; t < ticks; t++) {
        const spiked = net.tick(codec.driveInputs());
        codec.observe(spiked);
        if (stdp && runExpensive) stdp.observeSpikes(spiked, { gate: 0, timestamp: clock++, tags: ["sim"] }); // build eligibility (no auto-commit)
      }
      const r = codec.readAction();
      lastAction = r.action === "QUIET" ? "STOP" : r.action;
      if (esc) r.escalation = esc;
      return r;
    },
    // Reward/punish the just-taken action's incoming pathway (localized credit, like organism.feedback).
    feedback(sign, magnitude = 1, { action } = {}) {
      if (!stdp) return;
      const target = actions[action || lastAction];
      if (target) stdp.modulate(sign, magnitude, { targets: target, timestamp: clock, tags: ["sim", sign > 0 ? "reward" : "punish"] });
    },
    reset() { net.resetActivation(); codec.reset(); if (stdp) stdp.clearTraces(); if (ladder) { ladder.reset(); lastObstacle = 0; } }, // settle transient state + eligibility (+ cognition tier)
    // FORWARD-incoming vs STOP-incoming total weight -- so a benchmark can watch what learning does.
    weightSums() {
      const fwd = new Set(actions.FORWARD), stp = new Set(actions.STOP);
      let f = 0, p = 0;
      for (const syn of net._synapses) { if (fwd.has(syn.target)) f += syn.weight; else if (stp.has(syn.target)) p += syn.weight; }
      return { forward: +f.toFixed(1), stop: +p.toFixed(1) };
    },
    actions, _net: net,
  };
}
