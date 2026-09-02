// pose6.js — the 6-DOF rigid-body state schema (back-port of OpenVR TrackedDevicePose_t / DriverPose_t; the OpenVR mine).
// Replaces the flat 2D seam {x,z,heading,speed} with a full rigid body — the gap that blocks any drone/aircraft/VR body
// and the morph ground→air continuity. Carries, per OpenVR:
//   pos {x,y,z}, quat {x,y,z,w} (orientation), vel {x,y,z} (m/s), angVel {x,y,z} (rad/s),
//   valid (bPoseIsValid), tracking (ETrackingResult: ok|out-of-range|rotation-only|calibrating|uninitialized),
//   fidelity (EVRSkeletalTrackingLevel: full|partial|estimated — how directly the body senses its own state).
// BACKWARD-COMPATIBLE: 2D bridges (from/toGround2D) let the existing car/ground code keep speaking {x,z,heading,speed}
// while air bodies use the full pose — one schema, both worlds. Safety consumers use `verify()` (fail-CLOSED, mirrors
// depthCapability): a rotation-only / stale / invalid pose DENIES position-based decisions (Fallback_RotationOnly is a
// real degraded mode). PURE: no clock/IO; `now` injected for staleness.

// ── quaternion math (minimal) ──
const qMul = (a, b) => ({
  w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
  y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
  z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
});
const qNorm = (q) => { const m = Math.hypot(q.x, q.y, q.z, q.w) || 1; return { x: q.x / m, y: q.y / m, z: q.z / m, w: q.w / m }; };
export const quatIdentity = () => ({ x: 0, y: 0, z: 0, w: 1 });
export const quatFromAxisAngle = (ax, ay, az, rad) => { const m = Math.hypot(ax, ay, az); if (m < 1e-9) return quatIdentity(); const s = Math.sin(rad / 2) / m; return qNorm({ x: ax * s, y: ay * s, z: az * s, w: Math.cos(rad / 2) }); };
// yaw about +Y (the ground-plane heading axis). +Y-up world; heading measured so it matches the sim/car convention.
export const quatFromYaw = (yawRad) => quatFromAxisAngle(0, 1, 0, yawRad);
export const yawOf = (q) => Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
export const rotateVec = (q, v) => { // v' = q v q*
  const t = { x: 2 * (q.y * v.z - q.z * v.y), y: 2 * (q.z * v.x - q.x * v.z), z: 2 * (q.x * v.y - q.y * v.x) };
  return { x: v.x + q.w * t.x + (q.y * t.z - q.z * t.y), y: v.y + q.w * t.y + (q.z * t.x - q.x * t.z), z: v.z + q.w * t.z + (q.x * t.y - q.y * t.x) };
};
// integrate an orientation by an angular-velocity vector (rad/s) over dt: q' = normalize(q + 0.5·ω·q·dt).
export const integrateQuat = (q, w, dt) => { const wq = { x: w.x, y: w.y, z: w.z, w: 0 }; const d = qMul(wq, q); return qNorm({ x: q.x + 0.5 * d.x * dt, y: q.y + 0.5 * d.y * dt, z: q.z + 0.5 * d.z * dt, w: q.w + 0.5 * d.w * dt }); };

const V0 = () => ({ x: 0, y: 0, z: 0 });

// ── the schema ──
export function makePose6(init = {}) {
  return {
    pos: { ...V0(), ...(init.pos || {}) },
    quat: init.quat ? qNorm(init.quat) : quatIdentity(),
    vel: { ...V0(), ...(init.vel || {}) },
    angVel: { ...V0(), ...(init.angVel || {}) },
    valid: init.valid != null ? init.valid : true,
    tracking: init.tracking || "ok",
    fidelity: init.fidelity || "full",
    at: init.at,
  };
}
export const speedOf = (p) => Math.hypot(p.vel.x, p.vel.y, p.vel.z);

// ── 2D bridges: keep the existing {x,z,heading,speed} seam working (heading = yaw about +Y; ground plane is x,z, y=up).
export function fromGround2D(g = {}, { y = 0, fidelity = "full" } = {}) {
  const heading = +g.heading || 0, speed = +g.speed || 0;
  // ground nose convention (vehicleModel): fwd = (cos h, sin h) in the x,z plane.
  const vel = { x: Math.cos(heading) * speed, y: 0, z: Math.sin(heading) * speed };
  return makePose6({ pos: { x: +g.x || 0, y, z: +g.z || 0 }, quat: quatFromYaw(heading), vel, fidelity });
}
export function toGround2D(p) {
  return { x: p.pos.x, z: p.pos.z, heading: yawOf(p.quat), speed: Math.hypot(p.vel.x, p.vel.z) };
}

// ── kinematic 6DOF forward model: integrate pose from (accel, angAccel) OR directly-set (vel, angVel). Body dynamics
// (controls→accel/angAccel) are INJECTED via `derive` (a body adapter); absent, it's pure ballistic + drag.
export function makePose6Model({ derive = null, drag = 0.0 } = {}) {
  function step(pose, controls = {}, dt = 1 / 60) {
    const d = typeof derive === "function" ? (derive(pose, controls, dt) || {}) : {};
    const accel = d.accel || V0();
    const angAccel = d.angAccel || V0();
    // velocities: integrate accel, apply linear drag; angVel from angAccel (or a body override)
    const vel = d.vel || { x: pose.vel.x + accel.x * dt - drag * pose.vel.x * dt, y: pose.vel.y + accel.y * dt - drag * pose.vel.y * dt, z: pose.vel.z + accel.z * dt - drag * pose.vel.z * dt };
    const angVel = d.angVel || { x: pose.angVel.x + angAccel.x * dt, y: pose.angVel.y + angAccel.y * dt, z: pose.angVel.z + angAccel.z * dt };
    const pos = { x: pose.pos.x + vel.x * dt, y: pose.pos.y + vel.y * dt, z: pose.pos.z + vel.z * dt };
    const quat = integrateQuat(pose.quat, angVel, dt);
    return makePose6({ pos, quat, vel, angVel, valid: pose.valid, tracking: pose.tracking, fidelity: pose.fidelity, at: pose.at });
  }
  return { step };
}

// ── validity gate — FAIL-CLOSED for safety consumers. Deny position-based decisions on: invalid / stale / rotation-only
// (position lost) / uninitialized. Returns { ok, hold, reason, pose } — a safety consumer obeys `hold:true` as "stop".
export function verifyPose(pose, { now = () => 0, maxAgeMs = 250, requirePosition = true } = {}) {
  const deny = (reason) => ({ ok: false, hold: true, reason, pose });
  if (!pose || pose.valid === false) return deny("invalid");
  if (pose.tracking === "uninitialized" || pose.tracking === "calibrating") return deny("not-tracking");
  if (requirePosition && (pose.tracking === "rotation-only" || pose.tracking === "out-of-range")) return deny("position-lost");
  if (pose.at != null) { const age = now() - pose.at; if (!(age >= 0)) return deny("clock-skew"); if (age > maxAgeMs) return deny("stale"); }
  return { ok: true, hold: false, reason: "ok", pose };
}
