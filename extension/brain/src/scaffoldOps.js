// scaffoldOps.js — a library of PURE "scaffold operators". A scaffold op ROTATES a raw transducer reading onto a fixed
// percept scaffold: a small, well-understood neural computation (borrowed from a known reflex) applied to whatever sense
// happens to be routed through it. This is the synesthesia substrate — the SAME op (e.g. binaural DOA balance) can carry
// optic-flow today and sonar tomorrow, because the op cares only about the SHAPE of its input, never its origin.
//
// CONTRACT: every op is `(input, opts) -> number[]` — it returns the PERCEPT VECTOR (always an array, so organFusion.fuse
// can concat it as an organ slice). Pure + deterministic; every tunable is a named, documented option. No dependency
// beyond math.js (matching flySenses.js house style).

import { clamp01, num } from "./math.js";
import { opticFlowBalance } from "./flySenses.js";

// ── balance(input, opts) — the DOA / binaural-difference scaffold ──────────────────────────────────────────────────
// ROTATES onto: any left/right (A/B) pair — optic-flow L/R eyes, binaural mic L/R, bilateral pressure/temperature,
// stereo range. The DOA (direction-of-arrival) scaffold: which side dominates, as a scale-free signed term in [-1,1].
//
// SINGLE SOURCE OF TRUTH: the (L−R)/(|L|+|R|+eps) contrast IS flySenses.opticFlowBalance — we delegate to it rather than
// re-deriving the same math (its `.camera` vector is exactly [L*scale, R*scale, balance]). flySenses stays unedited;
// we only consume it, so the DOA contrast can never drift between the two call sites.
//   input: [L, R] (array) OR a scalar L with opts.R — the two sides to contrast.
//   returns: [L*scale, R*scale, balance]  (balance = clamp(gain * (L−R)/(|L|+|R|+eps), -1, 1))
export function balance(input, opts = {}) {
  const { gain = 1.0, eps = 1e-6, scale = 1.0 } = opts;
  const L = Array.isArray(input) ? input[0] : input;
  const R = Array.isArray(input) ? input[1] : opts.R;
  return opticFlowBalance(L, R, { gain, eps, cameraScale: scale }).camera;
}

// ── arrayReduce(input, opts) — the ordered-array normalize scaffold ────────────────────────────────────────────────
// The "take a vector as-is and present it as a bounded organ slice" scaffold. Coerces every element to a finite number,
// optionally scales, and (by default) clamps to [0,1] so a raw magnitude array becomes a well-behaved percept vector.
// This is the identity-ish scaffold any already-vectorized sense rotates onto (an IMU 6-tuple, an N-bin spectrum, a
// range-bin array). A scalar input becomes a length-1 vector.
//   input: number[] (or a scalar) — the ordered readings.
//     OPT `from`/`count` (additive, default from=0 count=null ⇒ whole array, byte-identical for every existing caller):
//     select a contiguous SUB-SLICE of the reading before normalizing. This lets one transducer that returns a combined
//     fixed vector (e.g. audioSense's [L, R, ...bands]) route a sub-range to its own channel — exactly the selection role
//     distanceBandEvents's `pick` plays for a scalar field. No existing route passes these, so nothing changes.
//   returns: number[] — the normalized vector (the selected slice, or whole input; length 1 for a scalar).
export function arrayReduce(input, opts = {}) {
  const { scale = 1.0, clampTo01 = true, from = 0, count = null } = opts;
  let arr = Array.isArray(input) ? input : [input];
  if (from !== 0 || count != null) {
    const start = Math.max(0, Math.floor(num(from, 0)));
    arr = count != null ? arr.slice(start, start + Math.max(0, Math.floor(num(count, 0)))) : arr.slice(start);
  }
  return arr.map((x) => {
    const v = num(x) * scale;
    return clampTo01 ? clamp01(v) : v;
  });
}

// ── setpointDrive(value, opts) — the REGULATED-VARIABLE (homeostatic set-point) scaffold ───────────────────────────
// BIDIRECTIONAL homeostasis around a set-point: the general shape of a regulated internal variable that must be pushed
// back UP when it falls below target and back DOWN when it rises above. This is the biological shape of thermoregulation
// (shiver when cold / sweat when hot), thirst/osmolality, glucose (glucagon vs insulin), CO₂/breathing — a controlled
// variable defended from BOTH sides by two opposing effector drives. Origin-blind like every scaffold: anything with a
// regulated level and a target rotates onto it. Here it is pointed at SELF-COUNT (too few instances → replicate pull,
// too many → cull/crowding pull), a regulated variable no animal has but the exact same control shape.
//   value: number — the current regulated variable (same units as target/span).
//     opts.target — the set-point to defend (default 0). opts.span — the deviation at which a drive saturates to 1
//       (default 1; ≤0 coerced to 1 so we never divide by 0). opts.gain — scales the normalized deviation (default 1).
//       opts.deadband — |deviation| below this reads as "at target", both drives 0 (default 0) — a tolerance zone.
//     opts.pick (additive, default null): when the routed reading is an ARRAY (e.g. selfCardinality's [normCount, …]),
//       `pick` selects which element is the regulated value. pick=null leaves the scalar behavior byte-identical — the
//       distanceBandEvents `pick` pattern, so nothing existing changes.
//   returns: [belowDrive, aboveDrive] — each clamp01. belowDrive rises as value falls under target (deficit → push up),
//     aboveDrive rises as value climbs over target (excess → push down), and AT target (within deadband) both ~0. The
//     two are mutually exclusive by construction (only the deficient side is ever nonzero), an A/B opposing-effector pair.
export function setpointDrive(value, opts = {}) {
  const target = num(opts.target, 0);
  const span = num(opts.span, 1) || 1;               // span≤0 ⇒ 1 (no divide-by-zero, still a valid saturation width)
  const gain = num(opts.gain, 1);
  const deadband = Math.max(0, num(opts.deadband, 0));
  const pick = opts.pick == null ? null : opts.pick;
  const raw = (pick != null && Array.isArray(value)) ? value[pick] : value;
  const v = num(raw, target);                        // non-finite reading ⇒ treat as "at target" (neutral, no drive)
  const dev = v - target;                            // signed deviation: <0 below set-point, >0 above
  if (Math.abs(dev) <= deadband) return [0, 0];      // inside the tolerance zone ⇒ regulated, both effectors quiet
  const mag = clamp01((Math.abs(dev) / Math.abs(span)) * gain);
  return dev < 0 ? [mag, 0] : [0, mag];              // deficit ⇒ belowDrive; excess ⇒ aboveDrive
}

// ── distanceBandEvents(distance, opts) — the contact-onset band scaffold ───────────────────────────────────────────
// A proximity→EVENT scaffold: fire a discrete contact-onset flag when `distance` falls INTO a near band (below onset)
// and is still approaching/at rest (distance ≤ release gives sustained contact). Models the fly/whisker "touch began"
// event — a threshold-crossing percept, not a continuous level. Anything with a distance-like reading rotates onto it:
// rangefinder agl, bumper/whisker deflection, sonar return.
//   distance: number — current distance to the surface/obstacle (same units as onset/release).
//     OPT `pick` (additive, default null): when the routed reading is an ARRAY (e.g. a multi-field back-EMF sample
//     [vibration, loadGap, …]), `pick` selects which element is the distance-like value. pick=null (the default)
//     leaves the original scalar behavior byte-identical — no existing caller passes it, so nothing changes.
//   returns: [event, proximity, inBand]
//     event     — 1 if within the onset band (distance ≤ onset), else 0 (the contact-onset flag).
//     proximity — 1/(distance+floor) clamped to [0,1]: a continuous closeness driver alongside the flag.
//     inBand    — 1 if onset ≥ distance ≥ release (inside the hysteresis band), else 0.
export function distanceBandEvents(distance, opts = {}) {
  const { onset = 1.0, release = 0.0, floor = 0.5, pick = null } = opts;
  const raw = (pick != null && Array.isArray(distance)) ? distance[pick] : distance;
  const d = num(raw, Infinity);
  const event = d <= onset ? 1 : 0;
  const inBand = d <= onset && d >= release ? 1 : 0;
  const proximity = isFinite(d) ? clamp01(1 / (d + floor)) : 0;
  return [event, proximity, inBand];
}

// ── filterbank(samples, opts) — the TONOTOPIC ordered-array scaffold ───────────────────────────────────────────────
// Turns a time-domain sample buffer into a normalized per-band ENERGY vector: the cochlea's place-code, where pitch is
// mapped to POSITION along an ordered array (low bands first). This IS the rotation surface for audio DSP — a mic's
// samples rotate onto it for PITCH — and, being origin-blind, it rotates EQUALLY onto ANY spectrum: mechanical
// vibration (accelerometer buffer), RF/IQ samples, an EEG window. One op, every spectrum. The output array is exactly
// the shape arrayReduce/organFusion expect (an ordered organ slice), so downstream it is just another percept vector.
//
// METHOD — BAND-INTEGRAL energy (the hardened replacement for the old center-bin-only Goertzel). We evaluate the
// periodogram at EVERY integer DFT bin inside [fmin,fmax] (a per-bin Goertzel — single-bin DFT, O(N) each — so no FFT
// dependency) and SUM each bin's power into the band its frequency falls in. Integrating across each band's whole range
// — not sampling only the center — is what makes broadband / noisy input read correctly per band: a center-bin probe
// is orthogonal to (reads ~0 for) energy sitting at any OTHER bin in the band, so the old method collapsed noise toward
// zero. The band sums are then expressed as each band's SHARE of the total spectral energy (Parseval): bands sum to ~1
// when any signal is present, so a pure tone concentrates to ~1 in its band while broadband input spreads to ~1/bands
// each. Loudness is deliberately normalized away here (pitch is a PLACE code); absolute level is carried elsewhere (the
// L/R energy terms in audioSense). A HANN WINDOW is applied first: it cuts spectral leakage so an off-bin tone's energy
// stays inside its band instead of bleeding across a boundary; for a tone already on a bin it only widens the main lobe
// by ~1 bin (still far inside a band), and the share-of-total normalization stays self-consistent under it.
//   samples : number[] — mono time-domain buffer (non-finite entries coerced to 0 via num; scalar ⇒ length-1 buffer).
//   opts.bands      — band count (default 8; <1 coerced up to 1). opts.sampleRate — Hz (default 2; ≤0 coerced to 2).
//   opts.fmin/fmax  — band span (default 0 … sampleRate/2 = Nyquist). Band i covers [fmin+i/bands·span, next).
//   returns: number[] of length `bands` — each band's SHARE of spectral energy, low→high (the tonotopic array). Guards:
//            empty/degenerate (N=0, span≤0, or no in-range bins) ⇒ all-zeros of length `bands`; silence ⇒ zeros; every
//            entry finite in [0,1] under NaN/Infinity samples, bands≤0, sampleRate≤0, or a single-sample buffer.
export function filterbank(samples, opts = {}) {
  const bands = Math.max(1, Math.floor(num(opts.bands, 8)));   // bands≤0 ⇒ 1 (still a valid-length vector)
  const out = new Array(bands).fill(0);
  const srRaw = num(opts.sampleRate, 2);
  const sampleRate = srRaw > 0 ? srRaw : 2;                    // sampleRate≤0 ⇒ fall back to the default (no bad ω)
  const fmax = num(opts.fmax, sampleRate / 2);
  const fmin = num(opts.fmin, 0);
  const span = fmax - fmin;
  const arr = Array.isArray(samples) ? samples : [samples];
  const N = arr.length;
  if (N === 0 || span <= 0) return out;                        // empty buffer or degenerate band span ⇒ zeros

  // Hann window (precomputed once), applied with num() so every sample is NaN/Infinity-safe before the transform.
  const win = new Array(N);
  for (let n = 0; n < N; n++) {
    const h = N === 1 ? 1 : 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (N - 1));
    win[n] = num(arr[n]) * h;
  }

  // Sum the power of every integer DFT bin in [fmin,fmax] into its band. kLo..kHi bound the in-range bins (≤ Nyquist).
  const kLo = Math.max(0, Math.ceil((fmin * N) / sampleRate));
  const kHi = Math.min(Math.floor(N / 2), Math.floor((fmax * N) / sampleRate));
  const raw = new Array(bands).fill(0);
  let total = 0;
  for (let k = kLo; k <= kHi; k++) {
    const coeff = 2 * Math.cos((2 * Math.PI * k) / N);         // the Goertzel coefficient for bin k
    let s1 = 0, s2 = 0;
    for (let n = 0; n < N; n++) { const s0 = win[n] + coeff * s1 - s2; s2 = s1; s1 = s0; }
    const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;         // Goertzel magnitude² at bin k
    const p = power > 0 ? power : 0;                           // clamp float noise to ≥0
    const fk = (k * sampleRate) / N;                          // this bin's frequency
    let bi = Math.floor(((fk - fmin) / span) * bands);
    if (bi < 0) bi = 0; else if (bi >= bands) bi = bands - 1;  // fold boundary bins into range
    raw[bi] += p; total += p;
  }
  if (total <= 0) return out;                                  // silence / no energy ⇒ zeros (no divide-by-zero)
  for (let b = 0; b < bands; b++) out[b] = clamp01(raw[b] / total); // each band's share of spectral energy
  return out;
}
