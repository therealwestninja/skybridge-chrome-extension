// quadruped.js — EXAMPLE BODY PROFILE (data, not code). A four-legged body: bilateral stereo vision, a forward
// rangefinder, an IMU, and FOUR leg motors sensed as bone conduction (motorSense). PROVES: arbitrary limb count — four
// `motor` transducers all fan onto a shared `touch` channel (many-to-one), plus a distinct per-sense channel set. The
// same bindBody pipeline runs this unchanged vs. the biped / mesh bodies. A body is just this object.
export const quadrupedProfile = {
  name: "quadruped",
  transducers: [
    { name: "eyes", kind: "basic", meta: { sense: "optic-flow", dim: 2 } },
    { name: "range", kind: "basic", meta: { sense: "rangefinder" } },
    { name: "imu", kind: "basic", meta: { sense: "attitude", dim: 3 } },
    { name: "legFL", kind: "motor", meta: { limb: "front-left" } },
    { name: "legFR", kind: "motor", meta: { limb: "front-right" } },
    { name: "legRL", kind: "motor", meta: { limb: "rear-left" } },
    { name: "legRR", kind: "motor", meta: { limb: "rear-right" } },
  ],
  routes: [
    { transducer: "eyes", op: "balance", channel: "vision" },
    { transducer: "range", op: "distanceBandEvents", channel: "proximity", opts: { onset: 1.0 } },
    { transducer: "imu", op: "arrayReduce", channel: "attitude" },
    // all four legs fan into ONE "touch" channel — the body feels contact through whichever limb loads up.
    { transducer: "legFL", op: "distanceBandEvents", channel: "touch", opts: { pick: 1, onset: 0.5 } },
    { transducer: "legFR", op: "distanceBandEvents", channel: "touch", opts: { pick: 1, onset: 0.5 } },
    { transducer: "legRL", op: "distanceBandEvents", channel: "touch", opts: { pick: 1, onset: 0.5 } },
    { transducer: "legRR", op: "distanceBandEvents", channel: "touch", opts: { pick: 1, onset: 0.5 } },
  ],
  homunculus: { rate: 0.2, decay: 0.05, floor: 0.1, ceil: 4 },
};
