// bipedHearing.js — EXAMPLE BODY PROFILE (data, not code). The biped with REAL hearing: one `mic` audio transducer
// (makeAudioTransducer) replaces the synthetic binaural stub, and it FANS synesthetically into TWO channels with no new
// code — exactly the motorSense pattern of one sense → many percepts:
//   • mic → balance        ⇒ "hearing"  (binaural DIRECTION: which ear is louder = where the sound is — SAME op as eyes)
//   • mic → arrayReduce {from:2} ⇒ "pitch" (the TONOTOPIC band array: where on the cochlear place-code the energy sits)
// PROVES hearing is not a bespoke organ but a sample source rotated onto scaffolds we already had. Everything else is the
// plain biped; migration to/from it carries vision/proximity/attitude/touch, and starts hearing/pitch at baseline.
export const bipedHearingProfile = {
  name: "biped-hearing",
  transducers: [
    { name: "eyes", kind: "basic", meta: { sense: "optic-flow", dim: 2 } },
    { name: "range", kind: "basic", meta: { sense: "rangefinder" } },
    { name: "imu", kind: "basic", meta: { sense: "attitude", dim: 3 } },
    { name: "mic", kind: "audio", bands: 8, sampleRate: 16000, meta: { sense: "audio" } },
    { name: "legL", kind: "motor", meta: { limb: "left" } },
    { name: "legR", kind: "motor", meta: { limb: "right" } },
  ],
  routes: [
    { transducer: "eyes", op: "balance", channel: "vision" },
    { transducer: "range", op: "distanceBandEvents", channel: "proximity", opts: { onset: 1.0 } },
    { transducer: "imu", op: "arrayReduce", channel: "attitude" },
    // ONE audio transducer, TWO percepts (the synesthetic fan):
    { transducer: "mic", op: "balance", channel: "hearing" },                 // indices [0,1] = L/R energy → direction
    { transducer: "mic", op: "arrayReduce", channel: "pitch", opts: { from: 2 } }, // the band slice → tonotopic pitch
    { transducer: "legL", op: "distanceBandEvents", channel: "touch", opts: { pick: 1, onset: 0.5 } },
    { transducer: "legR", op: "distanceBandEvents", channel: "touch", opts: { pick: 1, onset: 0.5 } },
  ],
  homunculus: { rate: 0.2, decay: 0.05, floor: 0.1, ceil: 4 },
};
