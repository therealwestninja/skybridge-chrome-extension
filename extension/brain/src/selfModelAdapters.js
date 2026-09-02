// selfModelAdapters.js — the body-specific half of the actuation seam: three adapters that map a body's telemetry
// into the self-model's vocabulary ({x,z,heading,speed} / {steer,accel,brake}) and its governor back onto the body.
//
// Each is a pure factory: you hand it the body's read/drive closures, it returns the adapter contract the seam wants
// (readState, readCommand, applyGovern). Nothing here reads a sensor or moves a motor itself — the closures do, so
// these are testable with mock bodies and carry no runtime dependency on BC, the Go2 stack, or the phone.
//
// Why three shapes, not one: the forward model is car-like (heading += gain·steer·speed·dt), and the three bodies
// speak different dialects of "command". A car steers; a legged robot commands a yaw RATE; a carried phone issues no
// drive command at all and only measures its own rotation. Each adapter reconciles its body to the one model, and the
// model's `response_gain` then learns to ≈1 when the body executes the command faithfully — which is the whole point:
// one organ, many bodies, each learning its own passport.

import { clamp, num } from "./math.js";

const DEG = Math.PI / 180;

// ── CAR (Backseat Champions, and any steer/accel/brake body) ─────────────────────────────────────────────────
// The native shape: the command IS steer/accel/brake, the state IS pose+speed. Almost a passthrough — the adapter's
// only jobs are unit conversion (degrees→radians if the harness reports heading in degrees) and routing the governor
// onto the body's aggression knob (SteerGain / target corner speed). This is the BC `SetCarInputs` seam.
export function carAdapter({ read, drive, headingInDegrees = false } = {}) {
  if (typeof read !== "function") throw new Error("carAdapter: needs read() -> {x,z,heading,speed,steer,accel,brake}");
  const H = headingInDegrees ? DEG : 1;
  return {
    readState() { const c = read() || {}; return { x: num(c.x), z: num(c.z), heading: num(c.heading) * H, speed: num(c.speed) }; },
    readCommand() { const c = read() || {}; return { steer: num(c.steer), accel: num(c.accel), brake: num(c.brake) }; },
    // gov in ~[min,max] from confidence: >1 push, <1 ease. The body decides what to scale (SteerGain, target speed);
    // we just hand it the factor and the full signal so it can also react to grip/events.
    applyGovern(gov, out) { if (typeof drive === "function") drive(gov, out); },
  };
}

// ── GROUND ROBOT (Go2 quadruped, and any velocity+yaw-rate body) ─────────────────────────────────────────────
// The robot reports pose {x,y,yaw} and is commanded a body velocity {vx forward, omega yaw-rate}. To fit the
// commanded-arc model, express the yaw command as an equivalent "steer": heading += gain·steer·speed·dt must equal
// gain·omega·dt, so steer = omega / speed. Then response_gain learns to ≈1 when the legs execute the commanded turn,
// and DROPS when they slip — which on a quadruped is literally foot-slip on a smooth floor, a genuinely useful free
// sensor. Forward effort maps to accel; a commanded slow-down maps to brake. `z := y` (the robot's ground plane).
export function groundRobotAdapter({ read, drive, yawScale = 1 } = {}) {
  if (typeof read !== "function") throw new Error("groundRobotAdapter: needs read() -> {pose:{x,y,yaw}, vx, omega, accelCmd?}");
  return {
    readState() {
      const f = read() || {}; const p = f.pose || {};
      return { x: num(p.x), z: num(p.y), heading: num(p.yaw), speed: num(f.speed, Math.abs(num(f.vx))) };
    },
    readCommand() {
      const f = read() || {};
      const speed = num(f.speed, Math.abs(num(f.vx)));
      // steer = omega/speed, clamped: at a standstill a yaw command is a pivot, not an arc — cap it so a divide-by-
      // near-zero speed does not explode the "steer" the model sees (the model handles a stopped body as no-arc).
      const steer = speed > 0.05 ? clamp((num(f.omega) * yawScale) / speed, -1, 1) : 0;
      const accelCmd = num(f.accelCmd, 0);
      return { steer, accel: accelCmd > 0 ? clamp(accelCmd, 0, 1) : 0, brake: accelCmd < 0 ? clamp(-accelCmd, 0, 1) : 0 };
    },
    applyGovern(gov, out) { if (typeof drive === "function") drive(gov, out); },
  };
}

// ── PHONE (carried body: measures its own rotation, issues no drive command) ─────────────────────────────────
// A phone-as-body does not locomote under its own power, so there is no steer/accel to command. What it HAS is a
// gyroscope (a measured yaw-rate) and a compass (an absolute heading). Feed the gyro rate in as the "command" and the
// compass in as the "actual": the model then predicts heading from the gyro and corrects it against the compass, and
// the RESIDUAL is the disturbance — a magnetic anomaly, or the phone being physically turned by something other than
// the motion the gyro reported. response_gain learns the gyro→heading scale (≈1 for a good IMU). This is 1-D
// orientation dead-reckoning: the honest, reduced use of the self-model on a body that is carried, not driven — and
// it is exactly the latency-hiding primitive (predict heading between sparse absolute fixes) in one axis.
// Speed is pinned to 1 so the arc term is `gain·(gyroRate)·dt` — a unit "speed" makes steer carry the whole yaw.
export function orientationAdapter({ read } = {}) {
  if (typeof read !== "function") throw new Error("orientationAdapter: needs read() -> {headingRad, yawRate} (rad, rad/s)");
  return {
    readState() { const o = read() || {}; return { x: 0, z: 0, heading: num(o.headingRad), speed: 1 }; },
    // steer = yawRate·dt-equivalent: with speed pinned to 1, heading += gain·yawRate·dt matches the measured rotation.
    readCommand() { const o = read() || {}; return { steer: num(o.yawRate), accel: 0, brake: 0 }; },
    // no motor to govern; the phone consumes confidence/grip as a "how much do I trust my heading right now" scalar,
    // which the caller reads from the seam output rather than through applyGovern.
  };
}
