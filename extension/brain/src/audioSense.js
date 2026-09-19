// audioSense.js — Stage-5 [additive]: HEARING via ROTATION, and the synesthetic FAN made literal. A microphone is not a
// bespoke "ear organ"; it is a sample source that rotates onto TWO scaffolds we already have, producing TWO percepts from
// ONE transducer — exactly the motorSense.js pattern (one back-EMF reading → vibration AND contact):
//   • samples → filterbank (scaffoldOps.filterbank)  ⇒ the TONOTOPIC / PITCH percept (where on the cochlear array the
//     energy sits). Pitch is place along an ordered array, reusing the ordered-array scaffold.
//   • left/right channel energies → balance (scaffoldOps.balance, the binaural DOA scaffold, SAME op the eyes use)
//     ⇒ the BINAURAL DIRECTION percept (which side is louder = where the sound is). Direction is reused L/R contrast.
// Two ears, two computations, but ONE sense wired through the patch bay into two channels — pitch and direction are the
// same signal seen through two scaffolds. This is the synesthesia claim discharged on a REAL (non-fly) sense.
//
// HARDWARE-AGNOSTIC SEAM: the frame is INJECTED via readFrame() (the motorSense.js injected-reader pattern). A real mic
// (Web Audio AnalyserNode, an I²S buffer, a WAV chunk) drops into the same seam with no downstream change. readFrame():
//   { samples: number[] }            — MONO: one buffer. L=R energy ⇒ balance reads 0 (centered); pitch from the buffer.
//   { left: number[], right: number[] } — STEREO: per-ear buffers. pitch from the (L+R)/2 mix; direction from L vs R.
// read() ALWAYS returns a FIXED-LENGTH vector [leftEnergy, rightEnergy, ...bands] (length 2 + bands), so the routes are
// stable regardless of mono/stereo/missing frame:
//   route → balance        on indices [0,1]            ⇒ binaural direction channel.
//   route → arrayReduce {from:2} (the bands slice)     ⇒ tonotopic pitch channel.
// Missing/throwing readFrame ⇒ SILENCE ([0,0,...zeros]) — a dead mic is quiet, it never crashes the tick. Finite under
// NaN/Infinity (every sample passes through filterbank's num() and energy's num()). Reuses math.js + scaffoldOps.

import { makeTransducer } from "./transducer.js";
import { clamp01, num } from "./math.js";
import { filterbank } from "./scaffoldOps.js";

// energy(buf) — mean-square (RMS²) energy of a buffer, clamped to [0,1]. For samples in [-1,1] this is a well-behaved
// loudness proxy; it is the L/R term the binaural balance scaffold contrasts. NaN/Infinity samples coerced to 0.
function energy(buf) {
  if (!Array.isArray(buf) || !buf.length) return 0;
  let s = 0;
  for (let i = 0; i < buf.length; i++) { const x = num(buf[i]); s += x * x; }
  return clamp01(s / buf.length);
}

// makeAudioTransducer({ name?, readFrame, bands?, sampleRate?, fmin?, fmax?, meta? }) -> Transducer
//   readFrame : () => { samples } | { left, right }  — REQUIRED injected mic read (stub-safe if it throws/returns junk).
//   bands     : tonotopic band count (default 8).  sampleRate/fmin/fmax : passed straight to filterbank.
export function makeAudioTransducer({ name = "audio", readFrame, bands = 8, sampleRate = 16000, fmin, fmax, meta = {} } = {}) {
  if (typeof readFrame !== "function") {
    throw new Error(`makeAudioTransducer(${name}): readFrame must be a function returning { samples } or { left, right }`);
  }
  const B = Math.max(1, Math.floor(num(bands, 8)));
  const fbOpts = { bands: B, sampleRate, fmin, fmax };

  const read = () => {
    let frame;
    try { frame = readFrame() || {}; } catch { frame = {}; }              // dead mic ⇒ silence, never throws
    let left, right, mix;
    if (Array.isArray(frame.left) || Array.isArray(frame.right)) {         // STEREO
      const L = Array.isArray(frame.left) ? frame.left : [];
      const R = Array.isArray(frame.right) ? frame.right : [];
      left = energy(L); right = energy(R);
      const n = Math.max(L.length, R.length);
      mix = new Array(n);
      for (let i = 0; i < n; i++) mix[i] = (num(L[i]) + num(R[i])) / 2;     // (L+R)/2 mono mix for the pitch scaffold
    } else {                                                               // MONO (or empty)
      const s = Array.isArray(frame.samples) ? frame.samples : [];
      const e = energy(s);
      left = e; right = e;                                                 // equal ears ⇒ balance reads centered (0)
      mix = s;
    }
    const bins = filterbank(mix, fbOpts);                                  // samples → tonotopic band energies
    return [left, right, ...bins];                                         // FIXED length 2 + B, mono/stereo alike
  };

  return makeTransducer({
    name, read,
    meta: {
      sense: "audio", kind: "hearing", units: "normalized", range: [0, 1], dim: 2 + B,
      fields: ["leftEnergy", "rightEnergy", ...Array.from({ length: B }, (_, i) => `band${i}`)],
      rotatesOnto: ["tonotopic/pitch", "binaural/direction"], bands: B, ...meta,
    },
  });
}
