// motorSense.js — Stage-3 [additive]: EFFECTOR-AS-TRANSDUCER. A motor/stepper is not only an ACTUATOR; its own
// electrical signals ARE a sense. The residual between what we COMMANDED and what the shaft ACTUALLY did (read back
// as back-EMF / coil current) reports the load fighting the motor and the high-frequency jitter of that fight — i.e.
// CONTACT and VIBRATION, sensed through the same wire that drives motion. So: THE EFFECTOR IS THE TRANSDUCER; the body
// gains BONE CONDUCTION — it feels the world through its own limbs, with no extra sensor bolted on.
//
// There is no hardware here, so the back-EMF read is INJECTED: `readMotorState() -> { commanded, actual, current? }`.
//   commanded — the motion we asked for (step rate / velocity, normalized).
//   actual    — the motion that actually happened (encoder / observed). Under load, actual LAGS commanded.
//   current   — OPTIONAL measured coil current (the truest load proxy on real hardware). When present it is the
//               primary load signal; when absent we fall back to the commanded−actual residual (a back-EMF proxy).
// The returned reading is SHAPED like a real back-EMF sample — a fixed-length numeric vector — so a hardware read()
// (actual ADC/driver telemetry) can later drop straight into the same `readMotorState` seam with no downstream change.
//
// DERIVED PERCEPT (read() -> [vibration, loadGap]):
//   residual  = commanded − actual                         // the back-EMF proxy: the shaft fell behind the command
//   load      = current ? |current|/stallCurrent : |residual|/residualRef   (clamped [0,1]) — how hard the motor fights
//   vibration = |residual_t − residual_{t-1}| · vibrationGain (clamped [0,1]) — the AC/high-freq component (cogging,
//               chatter, a rough surface) = the CHANGE in the fight between samples, not its level. (First read ⇒ 0.)
//   loadGap   = 1 − load (clamped [0,1])                   // a DISTANCE-like value: high load ⇒ small gap ⇒ CONTACT,
//               so it rotates cleanly onto scaffoldOps.distanceBandEvents (the contact-onset "touch" scaffold).
//
// The ONE cross-read state is `prevResidual` (needed for the derivative that IS vibration); deterministic given the
// read sequence. No Date.now / Math.random. Reuses math.js; wraps the reading behind the standard Transducer contract
// so patchBay treats bone-conduction exactly like any other sense (and can fan it into several percepts at once).

import { makeTransducer } from "./transducer.js";
import { clamp01, num } from "./math.js";

// makeMotorSenseTransducer({ name?, readMotorState, stallCurrent?, residualRef?, vibrationGain?, meta? }) -> Transducer
//   stallCurrent  — current (A, same units as readMotorState.current) at which load saturates to 1. Default 1.
//   residualRef   — |commanded−actual| at which the residual-proxy load saturates to 1 (used when no current). Default 1.
//   vibrationGain — scales the residual derivative into the vibration magnitude before clamping. Default 1.
export function makeMotorSenseTransducer({
  name = "motor", readMotorState, stallCurrent = 1, residualRef = 1, vibrationGain = 1, meta = {},
} = {}) {
  if (typeof readMotorState !== "function") {
    throw new Error(`makeMotorSenseTransducer(${name}): readMotorState must be a function returning { commanded, actual, current? }`);
  }
  const stall = num(stallCurrent, 1) || 1;
  const rRef = num(residualRef, 1) || 1;
  const vGain = num(vibrationGain, 1);
  let prevResidual = null; // the only cross-read state — the derivative that IS vibration needs the previous sample

  const read = () => {
    const s = readMotorState() || {};
    const commanded = num(s.commanded);
    const actual = num(s.actual);
    const residual = commanded - actual;                       // back-EMF proxy: the shaft fell behind the command
    const load = s.current != null
      ? clamp01(Math.abs(num(s.current)) / stall)              // real current sensor = truest load
      : clamp01(Math.abs(residual) / rRef);                    // else derive load from the residual
    const dres = prevResidual == null ? 0 : residual - prevResidual;
    prevResidual = residual;
    const vibration = clamp01(Math.abs(dres) * vGain);         // AC/high-freq component = change in the fight
    const loadGap = clamp01(1 - load);                         // distance-like: high load ⇒ small gap ⇒ contact
    return [vibration, loadGap];
  };

  return makeTransducer({
    name, read,
    meta: { sense: "back-emf", units: "normalized", range: [0, 1], dim: 2, fields: ["vibration", "loadGap"], ...meta },
  });
}
