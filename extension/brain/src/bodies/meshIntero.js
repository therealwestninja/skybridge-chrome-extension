// meshIntero.js — EXAMPLE BODY PROFILE (data, not code). The disembodied mesh body given CYBER-INTEROCEPTION: senses with
// no animal equivalent, which fit a software body's "disembodied" nature perfectly — it has no stomach to feel hunger in,
// yet it feels its battery draining; no joints, yet it feels the stiffness of a laggy peer. Additive over the mesh's
// network senses:
//   • battery (kind:battery) → "drive"  — charge as a HUNGER-like drive (low charge ⇒ high need), routed onto the
//     contact-onset scaffold so an emptying battery reads like a NEED LOOMING closer (distanceBandEvents on field 0).
//   • proprio (kind:latency) → "proprio" — inter-organ round-trip time as LIMB STIFFNESS (distributed-body proprioception).
// PROVES senses are just data at the extreme: a body with no physical form grows two senses no animal has, through the
// identical bindBody pipeline, by adding two specs + two routes. `latency` (the network-health sense) stays as-is.
export const meshInteroProfile = {
  name: "mesh-intero",
  transducers: [
    { name: "latency", kind: "basic", meta: { sense: "network-latency", units: "norm" } },
    { name: "peers", kind: "basic", meta: { sense: "peer-count", units: "norm" } },
    { name: "throughput", kind: "basic", meta: { sense: "throughput", units: "norm" } },
    { name: "battery", kind: "battery", meta: { sense: "battery" } },
    { name: "proprio", kind: "latency", refMs: 100, meta: { sense: "mesh-proprioception" } },
  ],
  routes: [
    { transducer: "latency", op: "distanceBandEvents", channel: "link", opts: { onset: 0.5 } },
    { transducer: "peers", op: "arrayReduce", channel: "swarm" },
    { transducer: "throughput", op: "arrayReduce", channel: "bandwidth" },
    // battery CHARGE (field 1) as a looming need: charge falling toward 0 reads like an obstacle CLOSING IN — small
    // "distance" (low charge) fires the contact-onset event and proximity climbs. Low battery felt as an approaching need.
    { transducer: "battery", op: "distanceBandEvents", channel: "drive", opts: { pick: 1, onset: 0.5 } },
    // latency → proprioception: the whole [stiffness, looseness] pair as an ordered organ slice.
    { transducer: "proprio", op: "arrayReduce", channel: "proprio" },
  ],
  homunculus: { rate: 0.2, decay: 0.05, floor: 0.1, ceil: 4 },
};
