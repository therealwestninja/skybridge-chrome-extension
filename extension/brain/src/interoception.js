// interoception.js — Stage-5 [additive]: CYBER-INTEROCEPTION. Senses with NO animal equivalent, available ONLY because
// Rook is software running on a machine that reports its own inner state. A body with an animal morphology cannot feel
// its battery charge or the round-trip latency to its own distributed limbs; a software body feels these as plainly as
// an animal feels hunger or a stiff joint. Each is an ordinary Transducer (transducer.js) behind the SAME read()
// contract, so patchBay routes cyber-interoception exactly like optic-flow or touch — proving, once more, that a sense
// is just a normalized reading, not an organ.
//
// Every reader is INJECTED (the motorSense.js pattern): the platform source (navigator.getBattery, a mesh ping probe, a
// thermal sensor) drops into the same seam later. When a reader is absent or throws, each transducer falls back to a
// SAFE STUB and still returns a FINITE reading — a missing sense degrades to a neutral percept, it never crashes a tick.
// All outputs are normalized to ~[0,1] via math clamp01/num and are finite under NaN/Infinity/missing reader.
//
// Reuses math.js; no Date.now / Math.random; deterministic iff the injected reader is.

import { makeTransducer } from "./transducer.js";
import { clamp01, num } from "./math.js";

// makeBatteryTransducer({ name?, readCharge?, meta? }) -> Transducer
//   CHARGE → a HUNGER-like drive. readCharge() -> charge fraction in [0,1] (1 = full, 0 = empty). The DRIVE is the
//   inverse: drive = 1 − charge, so a LOW battery is felt as a HIGH need. This rotates onto the affect/looming scaffold
//   — low charge is an APPROACHING need, the same shape as an obstacle closing in (distanceBandEvents): the self can be
//   wired to feel "I must recharge" as a looming contact event, not just read a number. Missing/NaN reader ⇒ the stub
//   reports FULL charge (drive 0): the safe default is "not hungry", never a phantom emergency.
//   read() -> [drive, charge] (both [0,1]).
export function makeBatteryTransducer({ name = "battery", readCharge, meta = {} } = {}) {
  const reader = typeof readCharge === "function" ? readCharge : () => 1; // stub: assume full charge (drive 0)
  const read = () => {
    let charge;
    try { charge = clamp01(num(reader(), 1)); } catch { charge = 1; }     // reader throws ⇒ safe "full" default
    const drive = clamp01(1 - charge);                                    // inverse: low charge ⇒ high hunger-drive
    return [drive, charge];
  };
  return makeTransducer({
    name, read,
    meta: { sense: "battery", kind: "interoception", units: "normalized", range: [0, 1], dim: 2, fields: ["drive", "charge"], rotatesOnto: "affect/looming", ...meta },
  });
}

// makeLatencyTransducer({ name?, readLatency?, refMs?, meta? }) -> Transducer
//   LATENCY → DISTRIBUTED-BODY PROPRIOCEPTION. A software body's "limbs" are other organs/peers across a mesh; the
//   round-trip time to them is how FAR and how STIFF that limb feels. readLatency() -> round-trip ms. Normalized to a
//   "limb stiffness" scalar via a soft saturating map stiffness = rtt/(rtt+refMs) ∈ [0,1): refMs is the latency at
//   which a limb feels HALF-stiff. Low latency ⇒ a loose, responsive limb (stiffness→0); high latency ⇒ a stiff,
//   laggy limb (stiffness→1). Rotates onto PROPRIOCEPTION — the felt position/tension of the body's own parts — so a
//   laggy peer reads like a stiff joint. Missing/NaN reader ⇒ stub reports 0 ms (stiffness 0): a sense we don't have
//   is a limb we don't feel, not a seized one.
//   read() -> [stiffness, looseness] (both [0,1]); looseness = 1 − stiffness (a proprioceptive A/B pair).
export function makeLatencyTransducer({ name = "latency", readLatency, refMs = 100, meta = {} } = {}) {
  const reader = typeof readLatency === "function" ? readLatency : () => 0; // stub: zero latency (loose limb)
  const ref = num(refMs, 100) || 100;                                       // half-stiffness latency; >0 guaranteed
  const read = () => {
    let rtt;
    try { rtt = Math.max(0, num(reader(), 0)); } catch { rtt = 0; }         // reader throws ⇒ 0 ms
    const stiffness = clamp01(rtt / (rtt + ref));                           // soft saturating, never divides by 0
    return [stiffness, clamp01(1 - stiffness)];
  };
  return makeTransducer({
    name, read,
    meta: { sense: "latency", kind: "interoception", units: "normalized", range: [0, 1], dim: 2, fields: ["stiffness", "looseness"], rotatesOnto: "proprioception", ...meta },
  });
}

// makeLoadTransducer({ name?, readLoad?, meta? }) -> Transducer   (OPTIONAL — thermal/compute load → FATIGUE)
//   LOAD → a FATIGUE scalar. readLoad() -> a load fraction (CPU/thermal, 0 idle … 1 saturated). fatigue = clamp01(load)
//   directly — a hot, maxed machine is a tired body. Rotates onto the affect/arousal scaffold (fatigue damps drive).
//   Missing/NaN reader ⇒ 0 (rested). read() -> [fatigue] (length-1 vector).
export function makeLoadTransducer({ name = "load", readLoad, meta = {} } = {}) {
  const reader = typeof readLoad === "function" ? readLoad : () => 0;       // stub: idle (no fatigue)
  const read = () => {
    let load;
    try { load = clamp01(num(reader(), 0)); } catch { load = 0; }
    return [load];
  };
  return makeTransducer({
    name, read,
    meta: { sense: "load", kind: "interoception", units: "normalized", range: [0, 1], dim: 1, fields: ["fatigue"], rotatesOnto: "affect/arousal", ...meta },
  });
}
