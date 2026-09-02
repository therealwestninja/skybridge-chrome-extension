// chaperoneEnvelope.js — a WORLD-SPACE spatial safety boundary (back-port of OpenVR IVRChaperone; the OpenVR mine).
// The gap motorGate lacked: it only had command-grammar limits (out-of-envelope) — a per-command kinematic reject. This
// adds a GEOFENCE REGION: a convex boundary polygon (a quad/rect play-area) with (1) graded PROXIMITY FADE — warn +
// slow BEFORE the edge, not a binary veto at it; and (2) CALIBRATION HEALTH — the boundary itself can be stale/suspect
// (a base station moved), which a safety consumer must treat as untrustworthy. Registers into motorGate's subsume stack
// as one more layer (a firing "out-of-bounds" ≡ a blocking reflex). Go2 geofencing / a drone play-area / a car's track
// limits all use this. PURE: geometry only, no clock/IO.
//
// Bounds: a convex polygon [{x,z},…] (CCW), or a rect {minX,maxX,minZ,maxZ} (converted). Positions are {x,z} (ground
// plane) — pair with pose6 (pos.x/pos.z). calibration: "ok" | "warning" | "invalid" (OpenVR ChaperoneCalibrationState).

const rectToPoly = (r) => [{ x: r.minX, z: r.minZ }, { x: r.maxX, z: r.minZ }, { x: r.maxX, z: r.maxZ }, { x: r.minX, z: r.maxZ }];

// signed distance from p to the polygon: + = inside (distance to nearest edge), - = outside (−distance to nearest edge).
// Assumes a convex polygon; for a point inside, every edge's inward perpendicular distance is >=0 and we take the min.
function signedDistance(poly, p) {
  let minInside = Infinity, allInside = true, minOutside = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const ex = b.x - a.x, ez = b.z - a.z;                // edge vector
    const len = Math.hypot(ex, ez) || 1e-9;
    // inward normal for a CCW polygon is (−edge.z, edge.x)/len; signed perp distance of p from the edge line:
    const perp = ((p.x - a.x) * (-ez) + (p.z - a.z) * ex) / len;   // >=0 ⇒ inside of this edge
    if (perp < 0) allInside = false;
    minInside = Math.min(minInside, perp);
    // distance to the edge SEGMENT (for the outside case)
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * ex + (p.z - a.z) * ez) / (len * len)));
    const cx = a.x + t * ex, cz = a.z + t * ez;
    minOutside = Math.min(minOutside, Math.hypot(p.x - cx, p.z - cz));
  }
  return allInside ? minInside : -minOutside;
}

export function makeChaperone({ bounds, fadeM = 1.5, calibration = "ok" } = {}) {
  if (!bounds) throw new Error("makeChaperone: bounds (polygon or rect) required");
  let poly = Array.isArray(bounds) ? bounds.slice() : rectToPoly(bounds);
  let calib = calibration;
  const fade = Math.max(1e-3, fadeM);

  // check(pos) → the graded verdict. distanceM signed (+inside/−outside); nearEdge within the fade; slow 1(deep)→0(edge);
  // breach when outside; calibration surfaced so the caller can distrust a suspect boundary.
  function check(pos = {}) {
    const d = signedDistance(poly, { x: +pos.x || 0, z: +pos.z || 0 });
    const breach = d < 0;
    const nearEdge = d >= 0 && d < fade;
    const slow = d <= 0 ? 0 : d >= fade ? 1 : d / fade;   // warn-BEFORE-stop: linear slow-down through the fade band
    return { inside: d >= 0, distanceM: d, nearEdge, slow, breach, calibration: calib };
  }

  // FAIL-CLOSED gate for a safety consumer: HOLD on breach OR on an invalid/absent calibration (a suspect boundary is
  // not a safe boundary — you can't trust a geofence whose base stations moved). "warning" calibration still gates on
  // geometry but flags degraded. Returns { hold, reason, slow }.
  function verify(pos = {}, { requireCalibrated = true } = {}) {
    if (requireCalibrated && calib === "invalid") return { hold: true, reason: "boundary-uncalibrated", slow: 0 };
    const c = check(pos);
    if (c.breach) return { hold: true, reason: "out-of-bounds", slow: 0, distanceM: c.distanceM };
    return { hold: false, reason: c.nearEdge ? "near-edge" : "ok", slow: c.slow, distanceM: c.distanceM };
  }

  const setBounds = (b) => { poly = Array.isArray(b) ? b.slice() : rectToPoly(b); };
  const setCalibration = (s) => { calib = s; };
  return { check, verify, slowFactor: (pos) => check(pos).slow, bounds: () => poly.slice(), calibration: () => calib, setBounds, setCalibration };
}
