// flyNav.js — FlyNav Task 3: the OFFLINE insect-navigator autopilot. Pure GLUE that COMPOSES the brain's existing
// modules into a per-tick locomotion controller for a MOVING body (FPV drone, Go2, in-game camera-drone). Modelled on
// the fruit-fly: fixed reflexes (optic-flow balance, looming/time-to-contact, haltere/gyro attitude) + a small spiking
// "brain" (organism/codec) whose arousal MODULATES a central-pattern-generator wingbeat (flyCpg) — the whole advised
// intent then passes the motorGate subsumption chokepoint, which DECIDES (turns anything unsafe into a full STOP).
//
// The composition (each stage an existing, tested module):
//   flySenses encoders → organ vectors → organFusion.fuse → codec.inject per nav channel → organism.tick ×k → codec
//   .observe/readAction → arousal (from substrate spike activity) → flyCpg.step(arousal) weaves the steer → cerebellum
//   .smooth tempers the vigour → toCommand(decision) → motorGate.gate(command, posture) → the GATED command (STOP if blocked).
//
// SAFETY PRINCIPLE (from the plan's Caveats): the FIXED REFLEXES are authoritative. Aiming (goal bearing), optic-flow
// avoidance and looming-backoff are computed DETERMINISTICALLY from the encoders; the substrate + cerebellum only
// TEMPER (vigour) and the CPG only WEAVES — learning never ORIGINATES a safety-relevant act. And nothing bypasses the gate.
//
// DETERMINISTIC & OFFLINE: time flows only through accumulated `dt` (→ a monotonic ms clock for the gate); the CPG is
// the ONLY oscillator; no Date.now / Math.random. The substrate is SETTLED each step (rest → inject → tick), so the
// only cross-step state is the CPG phase + the cerebellum model + the accumulated clock — which is exactly what
// snapshot/restore threads, making a run byte-reproducible. Every tunable is a NAMED, caller-overridable option.

import { makeNetwork } from "./network.js";
import { makeRegion } from "./region.js";
import { makeRng } from "./rng.js";
import { makeCodec } from "./codec.js";
import { makeOrganFusion } from "./organFusion.js";
import { makeCerebellum } from "./cerebellum.js";
import { makeFlyCpg } from "./flyCpg.js";
import { makeMotorGate } from "./motorGate.js";
import { makeReflexArbiter } from "./reflexArbiter.js";
import { makeBodyEnvelope } from "./bodyEnvelope.js";
import { opticFlowBalance, loomingFromAgl, attitudeFromPose } from "./flySenses.js";
import { clamp, num } from "./math.js";

// ── The nav genome (the shared INTERFACE) ────────────────────────────────────────────────────────────────────────
// SENSORY CHANNELS (each drives a named sub-population; codec.inject(name, value∈~[0,1])):
//   bearing — |goal heading error| (the path-integration GOAL drive; NOT a fly-sense, injected directly)
//   flow    — |optic-flow imbalance| (corridor crowding, from the CAMERA organ slice)
//   looming — looming / time-to-contact alarm (from the RADAR organ slice)
//   tilt    — attitude disturbance |roll|+|pitch| (from the GYRO organ slice)
//   drive   — a tonic "go" bias (keeps CRUISE alive so a calm, clear scene still flies)
// MOTOR ACTIONS (winner-take-all over decision populations; readAction → {action, confidence}):
//   CRUISE — steady forward   BANK — hard turn (bearing/flow)   BRAKE — slow/stop (looming)   CLIMB — attitude correct
const NAV_CHANNELS = ["bearing", "flow", "looming", "tilt", "drive"];
const NAV_ACTIONS = ["CRUISE", "BANK", "BRAKE", "CLIMB"];

// Build a small, dedicated nav substrate + its codec (the default when collaborators aren't injected). Fixed wiring
// (the genome); the differential receptive fields make WHICH action wins reflect the input, not random wiring. The
// returned `organism` is a thin wrapper exposing the tick/settle/snapshot contract flyNav consumes; it SHARES the
// codec's neuron space (codec channels/actions reference these real neuron ids), and organism.tick() reads the codec's
// drive and returns the spiked indices for flyNav to hand to codec.observe.
export function buildNavSubstrate({ seed = 7, sizes = {}, maxDelay = 8, noiseStd = 0 } = {}) {
  const S = { sensory: 40, decision: 40, ...sizes };
  const net = makeNetwork({ seed, maxDelay, noiseStd });
  const rng = makeRng(seed * 7 + 1); // dedicated wiring rng (mirrors connectome.js)
  const sensory = makeRegion({ network: net, size: S.sensory, recurrence: 0.02, rng });
  const decision = makeRegion({ network: net, size: S.decision, recurrence: 0.05, rng });

  // Carve the sensory pool into the named input channels and the decision pool into the motor-action populations.
  const sIds = sensory.ids;
  const perC = Math.max(1, Math.floor(sIds.length / NAV_CHANNELS.length));
  const channels = {};
  NAV_CHANNELS.forEach((n, i) => { channels[n] = i === NAV_CHANNELS.length - 1 ? sIds.slice(i * perC) : sIds.slice(i * perC, (i + 1) * perC); });
  const exc = decision.excitatory;
  const perA = Math.max(1, Math.floor(exc.length / NAV_ACTIONS.length));
  const actions = {};
  NAV_ACTIONS.forEach((n, i) => { actions[n] = i === NAV_ACTIONS.length - 1 ? exc.slice(i * perA) : exc.slice(i * perA, (i + 1) * perA); });

  // Differential receptive fields (the genome): each channel projects to the action it should elect.
  const driveTo = (src, dst, prob, w, delay = 1) => { for (const s of src) for (const d of dst) if (rng.next() < prob) net.connect(s, d, w, delay); };
  const chanExc = (name) => channels[name].filter((id) => sensory.isExc(id)); // project from the EXCITATORY channel neurons only
  driveTo(chanExc("drive"), actions.CRUISE, 0.60, 9, 1);
  driveTo(chanExc("bearing"), actions.BANK, 0.60, 9, 1);
  driveTo(chanExc("flow"), actions.BANK, 0.50, 8, 1);
  driveTo(chanExc("looming"), actions.BRAKE, 0.70, 9, 1);
  driveTo(chanExc("tilt"), actions.CLIMB, 0.60, 9, 1);

  const codec = makeCodec({ channels, actions });
  const organism = {
    neuronCount: net.neuronCount,
    tick: () => net.tick(codec.driveInputs()),        // advance the net on the codec's drive; return spiked indices
    settle: () => net.resetActivation(),              // rest between steps (deterministic per-step function of injects)
    snapshot: () => ({ weights: net._synapses.map((s) => s.weight) }),
    restore: (st) => { if (st && Array.isArray(st.weights)) st.weights.forEach((w, i) => { if (net._synapses[i]) net._synapses[i].weight = w; }); },
  };
  return { codec, organism, channels, actions, net };
}

export function makeFlyNav({
  codec, organism, organFusion, cerebellum, motorGate, cpg,
  toCommand, actions, homunculus, patchBay, opts = {},
} = {}) {
  // ── Tunables (all named, all overridable; defaults carried from the game prototype's PILOT constants) ──
  const {
    ticks = 6,               // substrate ticks per control step (deliberation depth)
    intent = "fly",          // cerebellum key context (with the winning action)
    driveTonic = 0.5,        // the tonic "go" drive injected into the `drive` channel every step
    aimGain = 1.0,           // how hard the goal-bearing reflex steers toward the target
    avoidGain = 0.6,         // how hard optic-flow imbalance steers AWAY from crowding
    weaveGain = 0.8,         // how much of the CPG wingbeat is woven into the steer (the live, non-settling weave)
    steerSpan = Math.PI / 2, // bearing (rad) at which the aim reflex saturates (|bearing| ≥ span ⇒ full steer)
    tiltSpan = Math.PI / 2,  // |roll|+|pitch| (rad) at which the tilt channel saturates
    baseThrottle = 0.7,      // forward throttle at full vigour, clear scene
    loomBackoff = 0.9,       // fraction of throttle shed at maximal looming (throttle ×(1 − loomBackoff·looming))
    brakeAt = 0.75,          // looming above this flips the command tool to "stop" (a reflex hard-brake)
    vigourBase = 0.5,        // vigour floor (throttle is never fully gated by low substrate confidence)
    vigourGain = 0.5,        // how much cerebellum-smoothed confidence lifts vigour above the floor
    climbGain = 0.8,         // attitude correction: commanded climb opposes pitch
    arousalDivisor = null,   // spikes/tick normalizer for arousal; default = the substrate's neuron count
    maxSpeed = 5,            // m/s that a full-throttle command maps to (for the envelope `velocity` field)
    dtToMs = 1000,           // dt seconds → ms for the gate's monotonic posture clock
    // ── Stage-3 OPT-IN homunculus fusion path (DEFAULTS OFF — byte-identical to before when false) ──
    // When true AND a `homunculus` is injected, the fused senses are blended through homunculus.weightedFuse (the
    // plastic per-channel gain) INSTEAD of the fixed organFusion.fuse. A per-step `telemetry.affect` scalar then
    // reinforces the homunculus (use-dependent, affect-gated), so VALUE reallocates which organ dominates the
    // codec injection. With the flag false the weighted branch is never touched and the old fuse call runs verbatim.
    useWeightedFusion = false,
  } = opts;

  // ── Fill any un-injected collaborators with sensible defaults (kept fully overridable) ──
  if (!codec || !organism) {
    const built = buildNavSubstrate();
    codec = codec || built.codec;
    organism = organism || built.organism;
  }
  organFusion = organFusion || makeOrganFusion({ organs: ["camera", "radar", "gyro"] });
  cerebellum = cerebellum || makeCerebellum();
  cpg = cpg || makeFlyCpg();
  motorGate = motorGate || makeMotorGate({
    reflexArbiter: makeReflexArbiter(),
    bodyEnvelope: makeBodyEnvelope({ maxVelocity: maxSpeed, maxAccel: null, allowedTools: ["move", "stop"] }),
  });
  const arNorm = arousalDivisor != null ? arousalDivisor : Math.max(1, organism.neuronCount || 40);

  // The command shaper (decision → the {tool,args,velocity,accel,torque} object bodyEnvelope.validate expects).
  const toCmd = toCommand || ((d) => ({
    tool: d.brake ? "stop" : "move",
    args: { steer: +d.steer.toFixed(4), throttle: +d.throttle.toFixed(4), climb: +d.climb.toFixed(4) },
    velocity: +(Math.abs(d.throttle) * maxSpeed).toFixed(4),
    accel: 0,
    torque: 0,
  }));

  let tNow = 0; // accumulated time (ms) — the ONLY clock (fed to the gate posture); advanced by dt each step.

  // One control step. `telemetry` carries the raw body reads; `dt` is seconds since the previous step.
  //   telemetry = {
  //     bearing,                       // signed goal heading error (rad); + = target to the RIGHT
  //     flowLeft, flowRight,           // optic-flow magnitudes (left/right eye)
  //     agl, vsFpm, closingRate,       // looming / time-to-contact inputs (see flySenses.loomingFromAgl)
  //     pose,                          // pose6 { quat, angVel } for attitude (see flySenses.attitudeFromPose)
  //     reflexTrigger, pos, heartbeatNow, // raw SAFETY reads passed straight to the motorGate posture
  //     live,                          // optional per-organ liveness for organFusion (e.g. { camera:false })
  //     reward,                        // optional realized reward−threat to train the cerebellum online
  //   }
  function step(telemetry = {}, dt = 0) {
    tNow += Math.max(0, num(dt)) * dtToMs;

    // 1. Encoders (flySenses) → organ vectors → fuse.
    const { balance, camera } = opticFlowBalance(telemetry.flowLeft, telemetry.flowRight);
    const { looming, radar } = loomingFromAgl(telemetry, {});
    const { gyro } = attitudeFromPose(telemetry.pose, {});
    const live = telemetry.live || {};
    // FUSION — default: the fixed organFusion.fuse (byte-identical to before). OPT-IN: route the same organ vectors
    // through the homunculus plastic gain (patchBay.collect() supplies them when a patchBay is wired). A per-step
    // affect scalar reinforces the homunculus FIRST, so this tick already fuses under the reallocated weighting.
    let fused;
    if (useWeightedFusion && homunculus) {
      const vectors = patchBay ? patchBay.collect() : { camera, radar, gyro };
      if (telemetry.affect != null) {
        const l2 = (v) => Math.sqrt((Array.isArray(v) ? v : [v]).reduce((s, x) => s + num(x) * num(x), 0));
        const activity = {}; for (const c of Object.keys(vectors)) activity[c] = l2(vectors[c]);
        homunculus.reinforce(activity, num(telemetry.affect));
      }
      fused = homunculus.weightedFuse(organFusion, vectors, live);
    } else {
      fused = organFusion.fuse({ camera, radar, gyro }, live);
    }
    const slice = (name) => (fused.layout && fused.layout[name]) ? fused.vector.slice(fused.layout[name][0], fused.layout[name][1]) : [];
    const cam = slice("camera"), gyr = slice("gyro");

    // 2. Inject the fused senses (+ the direct goal bearing + tonic drive) into the substrate, settle, tick k times.
    const bearing = num(telemetry.bearing);
    const tiltMag = Math.abs(num(gyr[0])) + Math.abs(num(gyr[1])); // fused roll+pitch magnitude
    if (organism.settle) organism.settle();
    if (codec.reset) codec.reset();
    codec.inject("bearing", clamp(Math.abs(bearing) / steerSpan));
    codec.inject("flow", clamp(Math.abs(num(cam[2])))); // the fused optic-flow balance component
    codec.inject("looming", clamp(looming));
    codec.inject("tilt", clamp(tiltMag / tiltSpan));
    codec.inject("drive", clamp(driveTonic));
    let spikeSum = 0;
    for (let t = 0; t < ticks; t++) { const spiked = organism.tick(); spikeSum += spiked.length; codec.observe(spiked); }

    // 3. Decode the motor vote + derive AROUSAL from the substrate's spike activity (fraction of neurons firing / tick,
    //    normalized) — the descending drive that sets the CPG's rate & depth (a busy substrate = a livelier wingbeat).
    const routed = codec.readAction();
    const arousal = clamp((spikeSum / Math.max(1, ticks)) / arNorm);

    // 4. CPG wingbeat (the ONLY oscillator) + cerebellum temper. The forward model forecasts how this (intent, action)
    //    lands and smooths the confidence into a vigour scalar; an untrained model leaves confidence unchanged.
    const { wing } = cpg.step(arousal, num(dt));
    const forecast = cerebellum.predict({ intent, action: routed.action });
    const smoothed = cerebellum.smooth({ confidence: routed.confidence, forecast });
    const vigour = clamp(vigourBase + vigourGain * smoothed.confidence);

    // 5. Build the motor decision — FIXED REFLEXES authoritative, substrate/cerebellum temper, CPG weaves.
    const steerToward = clamp(bearing / steerSpan, -1, 1);        // aim: reduce the goal-bearing error
    const steerAway = clamp(balance, -1, 1);                       // optic-flow avoidance (+ = steer right, away from left crowding)
    let steer = clamp(steerToward * aimGain + steerAway * avoidGain, -1, 1);
    steer = clamp(steer + wing * weaveGain, -1, 1);               // the wingbeat weave (guarantees a live, zero-crossing steer)
    const throttle = clamp(baseThrottle * (1 - loomBackoff * clamp(looming)) * vigour); // looming sheds throttle, monotonically
    const climb = clamp(-num(gyr[1]) * climbGain, -1, 1);         // attitude: command climb opposite the pitch
    const brake = clamp(looming) >= brakeAt;                       // a hard reflex brake at high looming
    const decision = {
      steer, throttle, climb, brake, arousal, wing,
      action: routed.action, confidence: smoothed.confidence, adjust: smoothed.adjust,
      bearing, balance, looming: clamp(looming),
    };

    // 6. Advise → DECIDE: shape the command and pass it through the safety gate. The gate turns anything unsafe into STOP.
    const command = toCmd(decision);
    const posture = { reflexTrigger: telemetry.reflexTrigger, pos: telemetry.pos, now: tNow, heartbeatNow: telemetry.heartbeatNow != null ? telemetry.heartbeatNow : tNow };
    const gated = motorGate.gate(command, posture);

    // 7. Optional online learning: if the body reports a realized reward, correct the cerebellar forward model.
    if (telemetry.reward != null) cerebellum.record({ intent, action: routed.action, reward: num(telemetry.reward) });

    return {
      command: gated.command,
      allow: gated.allow,
      decision,
      debug: { fused, routed, arousal, wing, vigour, forecast, gate: gated, proposed: command, tNow },
    };
  }

  return {
    step,
    // Introspection of the shared interface.
    channels: NAV_CHANNELS.slice(),
    actions: actions || NAV_ACTIONS.slice(),
    // State threading: the CPG phase + the cerebellum model + the accumulated clock fully determine the future given the
    // telemetry stream (the substrate is settled each step). Organism weights are threaded too when the wrapper exposes them.
    snapshot() {
      return {
        v: 1, tNow,
        cpg: cpg.snapshot ? cpg.snapshot() : null,
        cerebellum: cerebellum.snapshot ? cerebellum.snapshot() : null,
        organism: organism.snapshot ? organism.snapshot() : null,
      };
    },
    restore(s) {
      if (!s) return;
      if (typeof s.tNow === "number") tNow = s.tNow;
      if (s.cpg && cpg.restore) cpg.restore(s.cpg);
      if (s.cerebellum && cerebellum.restore) cerebellum.restore(s.cerebellum);
      if (s.organism && organism.restore) organism.restore(s.organism);
    },
  };
}
