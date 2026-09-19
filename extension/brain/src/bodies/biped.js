// biped.js — EXAMPLE BODY PROFILE (data, not code). A two-legged body: the SAME stereo vision / rangefinder / IMU
// front-end as the quadruped (these channels are SHARED, so migration carries their learned weights), but only TWO leg
// motors, plus an extra "audio" sense the quadruped lacks. PROVES: a different morphology (fewer limbs + one novel
// sense) is just a different object — migrating quadruped→biped DROPS the two missing legs' contribution to `touch`,
// KEEPS vision/proximity/attitude/touch weights, and starts `hearing` at baseline. No code changes anywhere.
export const bipedProfile = {
  name: "biped",
  transducers: [
    { name: "eyes", kind: "basic", meta: { sense: "optic-flow", dim: 2 } },
    { name: "range", kind: "basic", meta: { sense: "rangefinder" } },
    { name: "imu", kind: "basic", meta: { sense: "attitude", dim: 3 } },
    { name: "ears", kind: "basic", meta: { sense: "binaural", dim: 2 } },
    { name: "legL", kind: "motor", meta: { limb: "left" } },
    { name: "legR", kind: "motor", meta: { limb: "right" } },
  ],
  routes: [
    { transducer: "eyes", op: "balance", channel: "vision" },
    { transducer: "range", op: "distanceBandEvents", channel: "proximity", opts: { onset: 1.0 } },
    { transducer: "imu", op: "arrayReduce", channel: "attitude" },
    { transducer: "ears", op: "balance", channel: "hearing" },        // novel channel: biped-only
    { transducer: "legL", op: "distanceBandEvents", channel: "touch", opts: { pick: 1, onset: 0.5 } },
    { transducer: "legR", op: "distanceBandEvents", channel: "touch", opts: { pick: 1, onset: 0.5 } },
  ],
  homunculus: { rate: 0.2, decay: 0.05, floor: 0.1, ceil: 4 },
};
