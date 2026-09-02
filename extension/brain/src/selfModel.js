// selfModel.js — a predictive self-model for a Rook-controlled BODY. Motor control, not affect.
//
// `predict -> act -> look back -> correct`. Every real frame the body predicts its own next pose from the
// command it just issued, then compares the prediction to what actually happened. The PREDICTION RESIDUAL is the
// signal, and one residual feeds four things at once:
//   - residual in the control channel (cross-track + heading), given the command -> GRIP LOSS -> ease before the wall
//   - a persistent, clean-driving bias -> the body's RESPONSE MODEL is wrong -> recalibrate it online (system-ID)
//   - a sustained grip deficit with no contact -> the SURFACE changed (wet/ice/gravel) — a free sensor
//   - a sudden large residual with NO command change -> CONTACT / fault — another free sensor
//
// Design notes that matter (from the spec, 2026-07-28-predictive-self-model.md):
//  * The model predicts the COMMANDED ARC, never a straight line. Predicted heading change = response_gain * steer *
//    speed * dt. Predict a straight line and every corner reads as "loss of control"; predict the arc and only a
//    corner the body FAILED to take reads as loss. This is the whole trick.
//  * System-ID and anti-wedge must not corrupt each other. A slide (transient) and a wrong body-model (persistent)
//    both show up as residual, so calibration LEARNS ONLY WHEN CONFIDENCE IS HIGH — the body learns its own response
//    while driving cleanly and FREEZES that model during a slide, so a slide can't be mistaken for "my gain changed"
//    and the frozen model is exactly the reference the grip-deficit sensor measures against.
//  * The learned params (response_gain, accel_response) are the exportable BODY PASSPORT — a body that has learned
//    its own response, with no world calibration, so it ports to any body (the Go2 north-star). No units are assumed;
//    heading is radians, speed and distance share whatever unit the caller uses.
//
// Pure: no clock, no randomness, no I/O. `dt` and every measurement are passed in. Deterministic and sub-millisecond.

import { clamp, clamp01, num, ema } from "./math.js";

const TAU = Math.PI * 2;
// Shortest signed angle from a to b, in (-pi, pi]. Heading residual must wrap, or the 359->1 degree seam manufactures
// a huge phantom slide every time the body crosses it.
export function wrapAngle(d) {
  let x = d % TAU;
  if (x > Math.PI) x -= TAU;
  if (x < -Math.PI) x += TAU;
  return x;
}

// The forward model, pure and standalone so a caller can roll it forward on SKIP frames (half-rate sampling) and,
// later, N frames deep for MPC-lite. Commanded-arc kinematics: move along heading, turn by the commanded yaw, change
// speed by the commanded pedal — each scaled by the body's learned response.
//   state:   { x, z, heading, speed }
//   command: { steer (-1..1), accel (0..1), brake (0..1) }
//   params:  { responseGain, accelResponse }
export function forward(state, command, dt, params) {
  const speed = num(state.speed);
  const heading = num(state.heading);
  const steer = clamp(num(command.steer), -1, 1);
  const pedal = clamp(num(command.accel), 0, 1) - clamp(num(command.brake), 0, 1);
  const yawRate = num(params.responseGain) * steer * speed;            // commanded arc: faster -> turns more per unit steer
  const nextHeading = heading + yawRate * dt;
  // integrate position at the MID-heading of the step — a first-order arc, much truer through a corner than either
  // endpoint's heading, and it costs one add.
  const midHeading = heading + 0.5 * yawRate * dt;
  const nextSpeed = Math.max(0, speed + num(params.accelResponse) * pedal * dt);
  const moved = speed * dt;
  return {
    x: num(state.x) + Math.sin(midHeading) * moved,
    z: num(state.z) + Math.cos(midHeading) * moved,
    heading: nextHeading,
    speed: nextSpeed,
    yawRate,
  };
}

export function makeSelfModel({
  dt = 1 / 60,
  responseGain = 1.0,          // yaw per (steer*speed*dt). The system-ID target; a neutral prior a new body corrects.
  accelResponse = 10,          // speed change per (pedal*dt).
  learnRate = 0.05,            // EMA rate for the body-model calibration — SLOW, and further gated by confidence.
  confSmoothing = 0.25,        // EMA on confidence so it does not chatter frame to frame.
  residualScale = 0.15,        // control-channel residual (rad + cross-track/​speed) that maps to zero confidence.
  learnConfFloor = 0.6,        // calibrate ONLY when confidence exceeds this — learn on clean driving, freeze on slides.
  gripSmoothing = 0.08,        // EMA on the grip estimate — a surface change is sustained, not a spike.
  gainBaselineRate = 0.003,    // VERY slow EMA that tracks the established clean-driving gain, so a fresh slippery
                               //   patch reads as gain-below-baseline before it becomes the new normal (see grip).
  slipperyBelow = 0.8,         // sustained grip ratio under this (no contact) => "surface got slippery".
  contactResidual = 0.25,      // residual magnitude above this WITH a near-zero command => external contact/fault.
  quietCommand = 0.08,         // |steer| and |pedal| both under this counts as "not my doing".
  aggression = { min: 0.6, max: 1.15 },   // confidence -> aggression multiplier (Phase-1 governor).
  passport = null,             // { responseGain, accelResponse } to resume a learned body.
} = {}) {
  let gain = num(passport?.responseGain, responseGain);
  let accelResp = num(passport?.accelResponse, accelResponse);
  let gainBaseline = gain;     // the established clean-driving gain, tracked very slowly (surface reference)
  let confidence = 1;          // start trusting; the first real residual corrects it
  let grip = 1;                // 1 = full grip vs the learned clean-driving model; drops on a slippery surface
  let last = null;             // { state, command } we predicted FROM, so step() can look back
  let predicted = null;        // what we predicted the current frame would be
  let suppressOnce = false;    // set by suppressNext(): skip ONE look-back after a discontinuity

  // Map confidence -> how hard to push. High confidence earns aggression; a rising residual (falling confidence)
  // eases BEFORE the wedge, which is the whole point — the governor acts on the prediction, not on hitting the wall.
  const aggressionOf = (c) => aggression.min + (aggression.max - aggression.min) * clamp01(c);

  return {
    // Roll the model forward without observing — for skip frames (half-rate) and, later, MPC rollouts. Pure.
    predict(state, command, step = dt) { return forward(state, command, step, { responseGain: gain, accelResponse: accelResp }); },

    // One REAL frame: look back at what we predicted last time vs what actually happened, learn from it, then predict
    // forward and remember it for next time. Returns the full signal. `actual` is the measured current state.
    step(actual, command, step = dt) {
      // DISCONTINUITY GUARD. After a teleport / body swap / world rebuild the previous prediction refers to a pose
      // that no longer exists; comparing against it would publish a bogus residual AND feed it to system-ID,
      // poisoning the passport. Skip this look-back, re-seed from the new pose, carry on. Additive: unreachable
      // unless suppressNext() was called, so the golden vectors (and the C# port) are unaffected.
      if (suppressOnce) {
        suppressOnce = false;
        last = { state: { ...actual }, command: { ...command } };
        predicted = forward(actual, command, step, { responseGain: gain, accelResponse: accelResp });
        return {
          predicted,
          residual: null,
          suppressed: true,
          confidence: +confidence.toFixed(4),
          aggression: +aggressionOf(confidence).toFixed(4),
          grip: +grip.toFixed(4),
          event: null,
        };
      }
      let residual = null, event = null;
      if (last && predicted) {
        // ── the look-back ────────────────────────────────────────────────────────────────────────────────────
        const ex = num(actual.x) - predicted.x, ez = num(actual.z) - predicted.z;
        // decompose the position error into along-track (accel/brake channel) and cross-track (grip channel), in the
        // frame of the heading we were PREDICTED to have — that is the direction "forward" meant for this step.
        const h = predicted.heading;
        const fwdX = Math.sin(h), fwdZ = Math.cos(h);
        const along = ex * fwdX + ez * fwdZ;
        const cross = ex * fwdZ - ez * fwdX;                 // perpendicular component (signed: + = drifted one way)
        const headingErr = wrapAngle(num(actual.heading) - predicted.heading);
        // control-channel magnitude: heading error plus cross-track normalised by the distance we expected to move,
        // so it reads as "fraction of the step spent going sideways/mis-aimed" rather than raw metres.
        const moveScale = Math.max(1e-3, num(last.state.speed) * step);
        const ctrlMag = Math.abs(headingErr) + Math.abs(cross) / moveScale;
        residual = { along: +along.toFixed(6), cross: +cross.toFixed(6), heading: +headingErr.toFixed(6),
                     mag: +ctrlMag.toFixed(6), alongNorm: +(along / moveScale).toFixed(6) };

        // ── confidence (fast) ────────────────────────────────────────────────────────────────────────────────
        const instant = clamp01(1 - ctrlMag / residualScale);
        confidence = ema(confidence, instant, confSmoothing);

        // ── system-ID: learn the body's response, but ONLY when driving cleanly ─────────────────────────────────
        // implied response_gain = the gain that WOULD have predicted the actual heading change this step.
        const steer = clamp(num(last.command.steer), -1, 1);
        const drive = steer * num(last.state.speed) * step;
        const actualDHeading = wrapAngle(num(actual.heading) - num(last.state.heading));
        if (confidence >= learnConfFloor && Math.abs(drive) > 1e-4) {
          const impliedGain = actualDHeading / drive;
          // reject wild single-frame implied gains (a glitch) by clamping the target near the current estimate
          const target = clamp(impliedGain, gain * 0.5, gain * 1.5);
          gain = ema(gain, target, learnRate);
        }
        const pedal = clamp(num(last.command.accel), 0, 1) - clamp(num(last.command.brake), 0, 1);
        const drivePedal = pedal * step;
        if (confidence >= learnConfFloor && Math.abs(drivePedal) > 1e-4) {
          const actualDSpeed = num(actual.speed) - num(last.state.speed);
          const impliedAccel = actualDSpeed / drivePedal;
          accelResp = ema(accelResp, clamp(impliedAccel, accelResp * 0.5, accelResp * 1.5), learnRate);
        }

        // ── derived sensor: grip / surface ──────────────────────────────────────────────────────────────────
        // Grip loss shows up two DIFFERENT ways, and a single ratio catches only one, so combine both and take the
        // worse. (1) An ABRUPT slide happens faster than the calibrator, which freezes on low confidence, so the
        // learned gain is stale and the body visibly UNDER-ROTATES vs it — the instantaneous ratio catches that.
        // (2) A GENTLE, sustained slip has a small per-step residual, so confidence stays high and the calibrator
        // correctly RE-LEARNS a lower gain (the spec's "persistent bias => recalibrate"). Now the instantaneous
        // ratio is ~1 (the model matches again) and the signal is instead the LEARNED GAIN dropping below its slow
        // baseline — which is exactly the spec's "sustained response_gain drop => surface got slippery". The slow
        // baseline eventually follows, so the icy patch becomes the new normal and grip returns to 1 — correct: a
        // permanently icy track IS this body's normal, and the surface EVENT fires during the transition.
        if (confidence >= learnConfFloor) gainBaseline = ema(gainBaseline, gain, gainBaselineRate);
        let instGrip = 1, trendGrip = 1;
        if (Math.abs(drive) > 1e-4) instGrip = clamp(actualDHeading / (gain * drive), 0, 1.5);   // (1) abrupt
        if (gainBaseline > 1e-6) trendGrip = clamp(gain / gainBaseline, 0, 1.5);                 // (2) sustained
        grip = ema(grip, Math.min(instGrip, trendGrip), gripSmoothing);

        // ── derived sensor: contact / external event ──────────────────────────────────────────────────────────
        const cmdMag = Math.max(Math.abs(steer), Math.abs(pedal));
        if (ctrlMag > contactResidual && cmdMag < quietCommand) {
          event = { kind: "contact", mag: +ctrlMag.toFixed(4), why: "large residual with no command — something hit or moved the body" };
        } else if (grip < slipperyBelow && cmdMag >= quietCommand) {
          event = { kind: "surface", grip: +grip.toFixed(3), why: "sustained under-rotation under steering — the surface got slippery" };
        }
      }

      // ── predict forward and remember, so the NEXT step can look back ─────────────────────────────────────────
      predicted = forward(actual, command, step, { responseGain: gain, accelResponse: accelResp });
      last = { state: { ...actual }, command: { ...command } };

      return {
        predicted,
        residual,
        confidence: +confidence.toFixed(4),
        aggression: +aggressionOf(confidence).toFixed(4),   // Phase-1 governor: multiply your SteerGain/target speed by this
        grip: +grip.toFixed(4),
        event,
      };
    },

    // Skip the NEXT look-back. Call immediately before stepping with a pose that did not follow continuously
    // from the last one (teleport, body swap, world rebuild, resume from background).
    suppressNext() { suppressOnce = true; },

    confidence: () => +confidence.toFixed(4),
    aggression: () => +aggressionOf(confidence).toFixed(4),
    grip: () => +grip.toFixed(4),
    // The BODY PASSPORT: the learned response, portable and comparable across bodies. Everything else is transient.
    passport: () => ({ responseGain: +gain.toFixed(6), accelResponse: +accelResp.toFixed(6) }),
    load(p) { if (p) { gain = num(p.responseGain, gain); accelResp = num(p.accelResponse, accelResp); gainBaseline = gain; } },
    reset() { confidence = 1; grip = 1; gainBaseline = gain; last = null; predicted = null; },
  };
}
