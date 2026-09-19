// flySenses.js — FlyNav Task 2: PURE telemetry→organ-vector encoders (the "fly-sense" front end).
// Turns raw body telemetry into the organ vectors that `organFusion.fuse({camera, radar, gyro})` blends into one
// state vector. Modelled on three fixed fly reflexes: optic-flow balance (image-motion L vs R → CAMERA), looming /
// time-to-contact (ground closing → RADAR), and haltere/gyro attitude (IMU/pose6 → GYRO). Each encoder is pure,
// deterministic, and fully caller-overridable — EVERY threshold/gain is a NAMED, documented option (no magic numbers).
// The tuned defaults are plausible starting points (from the game prototype), not measured constants. No dependency
// beyond pose6 helpers + math.js.

import { clamp, clamp01, num } from "./math.js";
import { yawOf } from "./pose6.js";

// ── 1. Optic-flow balance ──────────────────────────────────────────────────────────────────────────────────────
// A fly centres itself in a corridor by equalizing the image motion (optic flow) on its left and right eyes: when one
// side's flow is larger, that side is closer/crowded, so it steers AWAY (toward the emptier side). We report a signed
// `balance` steer term and a `camera` organ vector.
//
// SIGN CONVENTION: +balance = steer RIGHT (turn away from crowding on the LEFT). More flow on the left → positive.
//   Symmetric flow (L == R) → 0 (fly straight). Normalized by total flow so the term is scale-free (a contrast ratio).
export function opticFlowBalance(flowLeft, flowRight, opts = {}) {
  const {
    gain = 1.0,        // scales the normalized L/R contrast into the steer term (1 = raw contrast in [-1,1])
    eps = 1e-6,        // guards the divide-by-zero when both eyes see no motion (stationary / dark)
    cameraScale = 1.0, // scales the raw per-eye flow magnitudes packed into the camera organ vector
  } = opts;
  const L = num(flowLeft), R = num(flowRight);
  const total = Math.abs(L) + Math.abs(R) + eps;
  // contrast in [-1,1]: +1 = all flow on the left → steer hard right; -1 = all on the right → steer hard left.
  const contrast = (L - R) / total;
  const balance = clamp(gain * contrast, -1, 1);
  // camera organ vector: [leftFlow, rightFlow, balance] — per-eye magnitudes kept inspectable, plus the derived steer.
  const camera = [L * cameraScale, R * cameraScale, balance];
  return { balance, camera };
}

// ── 2. Looming / time-to-contact ───────────────────────────────────────────────────────────────────────────────
// A fly triggers an escape/backoff when an object's retinal image EXPANDS fast (small time-to-contact). For a drone
// over ground this is the GPWS "low + sinking" proxy `droneSalience` computes: close to the surface AND closing fast.
// `looming` ∈ [0,1] rises as time-to-contact (agl / closingRate) shrinks — MONOTONIC in closingRate, bounded.
//
// Inputs (any subset): agl = height above ground (m); vsFpm = vertical speed (ft/min, negative = sinking); closingRate
// = direct closing speed toward the hazard (m/s, positive = approaching) — overrides the vsFpm-derived descent if given.
export function loomingFromAgl(tel = {}, opts = {}) {
  const {
    aglFloor = 0.5,      // m — added to agl so ttc stays finite at touchdown (a body has non-zero extent)
    fpmToMps = 1 / 196.85, // ft/min → m/s (descent-rate unit bridge); 1 m/s ≈ 196.85 ft/min
    ttcScale = 2.0,      // s — the time-to-contact at which looming ≈ 0.5 (the reflex's half-alarm horizon)
    minClosing = 0.0,    // m/s — closing rates at/below this contribute no looming (receding/level = safe)
    radarScale = 1.0,    // scales the raw agl/closing terms packed into the radar organ vector
  } = opts;
  const agl = num(tel.agl, Infinity);
  // closing rate: explicit closingRate wins; else derive a descent speed from vsFpm (sinking = positive closing).
  const closing = tel.closingRate != null
    ? num(tel.closingRate)
    : Math.max(0, -num(tel.vsFpm) * fpmToMps);
  const closingEff = Math.max(minClosing, closing);
  // time-to-contact = distance / speed; guard the divide with aglFloor and a zero-closing (never contacts) case.
  const ttc = closingEff <= 0 ? Infinity : (agl + aglFloor) / closingEff;
  // looming rises smoothly as ttc → 0: a saturating map ttcScale/(ttc+ttcScale) ∈ (0,1], monotonic in closingRate
  // (larger closing → smaller ttc → larger looming) and in proximity (smaller agl → larger looming).
  const looming = clamp01(isFinite(ttc) ? ttcScale / (ttc + ttcScale) : 0);
  // radar organ vector: [looming, proximity, closing] — the alarm plus its two inspectable drivers.
  const proximity = isFinite(agl) ? clamp01(1 / (agl + aglFloor)) : 0;
  const radar = [looming, proximity * radarScale, closingEff * radarScale];
  return { looming, radar };
}

// ── 3. Attitude (haltere / gyro) ───────────────────────────────────────────────────────────────────────────────
// Halteres give a fly its rate-gyro sense; here we read roll/pitch/yaw (and their rates) from a pose6 rigid body.
// yaw comes from the pose6 `yawOf` helper (about +Y, the ground-plane heading axis) so it round-trips the sim/car
// convention exactly; roll/pitch are derived from the same quaternion; rates come from pose.angVel (rad/s).
export function attitudeFromPose(pose6, opts = {}) {
  const {
    angleScale = 1.0, // scales the roll/pitch/yaw angles (rad) in the gyro vector
    rateScale = 1.0,  // scales the roll/pitch/yaw rates (rad/s) in the gyro vector
  } = opts;
  const q = (pose6 && pose6.quat) || { x: 0, y: 0, z: 0, w: 1 };
  const w = (pose6 && pose6.angVel) || { x: 0, y: 0, z: 0 };
  const yaw = yawOf(q);
  // pitch about the body-lateral axis (asin form, clamped to avoid NaN at gimbal); roll about the forward axis.
  const pitch = Math.asin(clamp(2 * (q.w * q.x - q.y * q.z), -1, 1));
  const roll = Math.atan2(2 * (q.w * q.z + q.x * q.y), 1 - 2 * (q.x * q.x + q.z * q.z));
  // gyro organ vector: [roll, pitch, yaw, rollRate, pitchRate, yawRate]. Rate axes follow pose6 angVel (x,y,z).
  const gyro = [
    roll * angleScale, pitch * angleScale, yaw * angleScale,
    num(w.z) * rateScale, num(w.x) * rateScale, num(w.y) * rateScale,
  ];
  return { gyro };
}
