// mesh.js — EXAMPLE BODY PROFILE (data, not code). A DISEMBODIED / mesh body: no limbs, no eyes — its senses are the
// health of its network presence. `latency`, `peers`, and `throughput` are read as ordinary transducers and rotated
// onto percept channels by the SAME scaffold ops. PROVES morphology=data at the extreme: a body needn't be physical at
// all; the identical bindBody pipeline + weightedFuse run over purely virtual senses with zero special-casing. Migrating
// a biped→mesh drops EVERY physical channel (vision/proximity/attitude/hearing/touch) and the self reallocates onto the
// network senses — the limb-loss policy taken to its limit.
export const meshProfile = {
  name: "mesh",
  transducers: [
    { name: "latency", kind: "basic", meta: { sense: "network-latency", units: "norm" } },
    { name: "peers", kind: "basic", meta: { sense: "peer-count", units: "norm" } },
    { name: "throughput", kind: "basic", meta: { sense: "throughput", units: "norm" } },
  ],
  routes: [
    // latency as a distance-like value → contact-onset scaffold: a latency "wall" reads like an obstacle closing in.
    { transducer: "latency", op: "distanceBandEvents", channel: "link", opts: { onset: 0.5 } },
    { transducer: "peers", op: "arrayReduce", channel: "swarm" },
    { transducer: "throughput", op: "arrayReduce", channel: "bandwidth" },
  ],
  homunculus: { rate: 0.2, decay: 0.05, floor: 0.1, ceil: 4 },
};
