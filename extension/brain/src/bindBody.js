// bindBody.js — Stage-4 [additive]: the BINDER. Turns an inert body profile (bodyProfile.js, pure data) into a LIVE
// per-body sensory front-end by wiring Stages 1-3 together: instantiate the profile's transducers, build a registry +
// patchBay with the profile's routes, build a homunculus from its config, and hand back a `collectAndFuse` that runs the
// whole pipeline into weightedFuse. One call → a ready-to-run front-end; swapping profiles swaps the body.
//
//   transducer.read()  →  op(reading, opts)  →  { channel: vec }  →  homunculus.weightedFuse(fusion, vectors, live)
//
// The profile carries no closures (it is JSON); the LIVE read sources are injected via `deps.sources` keyed by
// transducer name (or the spec's `source`). This is the data/code seam: morphology = the profile; the body's actual
// wires = deps. PURE glue — no Date.now / Math.random; deterministic iff the injected sources + ops are.

import { makeTransducer, makeTransducerRegistry } from "./transducer.js";
import { makeMotorSenseTransducer } from "./motorSense.js";
import { makeAudioTransducer } from "./audioSense.js";
import { makeBatteryTransducer, makeLatencyTransducer, makeLoadTransducer } from "./interoception.js";
import { makeSelfCardinalityTransducer } from "./selfCardinality.js";
import { makePatchBay } from "./patchBay.js";
import { makeHomunculus } from "./homunculus.js";
import { l2 } from "./math.js";

// Build ONE transducer from a spec, pulling its live read source out of deps.sources.
function buildTransducer(spec, sources) {
  const srcKey = spec.source || spec.name;
  const src = sources[srcKey];
  if (typeof src !== "function") {
    throw new Error(`bindBody: no source function for transducer "${spec.name}" (looked up deps.sources["${srcKey}"])`);
  }
  const kind = spec.kind || "basic";
  if (kind === "motor") {
    return makeMotorSenseTransducer({
      name: spec.name, readMotorState: src,
      stallCurrent: spec.stallCurrent, residualRef: spec.residualRef, vibrationGain: spec.vibrationGain,
      meta: spec.meta || {},
    });
  }
  // Stage-5 [additive]: real senses. The live source is injected the same way — deps.sources[name] is the readFrame /
  // readCharge / readLatency / readLoad closure; a real mic or platform probe drops into the identical seam later.
  if (kind === "audio") {
    return makeAudioTransducer({
      name: spec.name, readFrame: src,
      bands: spec.bands, sampleRate: spec.sampleRate, fmin: spec.fmin, fmax: spec.fmax, meta: spec.meta || {},
    });
  }
  if (kind === "battery") return makeBatteryTransducer({ name: spec.name, readCharge: src, meta: spec.meta || {} });
  if (kind === "latency") return makeLatencyTransducer({ name: spec.name, readLatency: src, refMs: spec.refMs, meta: spec.meta || {} });
  if (kind === "load") return makeLoadTransducer({ name: spec.name, readLoad: src, meta: spec.meta || {} });
  // Stage-6 [additive]: SELF-CARDINALITY. The live source is the injected readPool() (a real queen/worker bridge later).
  if (kind === "selfCardinality") {
    return makeSelfCardinalityTransducer({
      name: spec.name, readPool: src,
      target: spec.target, countRef: spec.countRef, fluxGain: spec.fluxGain, meta: spec.meta || {},
    });
  }
  return makeTransducer({ name: spec.name, read: src, meta: spec.meta || {} });
}

// bindBody(profile, { ops, deps }) -> { profile, registry, patchBay, homunculus, collectAndFuse(fusion, live), reinforce }
//   ops  — the scaffold-op library (scaffoldOps.js or a superset) the routes' `op` names resolve against.
//   deps — { sources: { <transducerName|source>: read|readMotorState }, onError? }. `onError` is the patchBay fault sink.
export function bindBody(profile, { ops = {}, deps = {} } = {}) {
  if (!profile || !Array.isArray(profile.transducers)) throw new Error("bindBody: a body profile is required");
  const sources = deps.sources || {};

  const registry = makeTransducerRegistry();
  for (const spec of profile.transducers) registry.register(buildTransducer(spec, sources));

  const patchBay = makePatchBay({ registry, ops, onError: deps.onError });
  for (const r of profile.routes) patchBay.route(r.transducer, r.op, r.channel, r.opts);

  const homunculus = makeHomunculus(profile.homunculus || {});

  // collectAndFuse(fusion, live) — the per-tick front-end: sample every routed sense, shape it, and fuse it through the
  // homunculus gain. `fusion` is any makeOrganFusion() instance; `live` marks organs offline this tick (passed through).
  function collectAndFuse(fusion, live = {}) {
    return homunculus.weightedFuse(fusion, patchBay.collect(), live);
  }

  // reinforce(affect, live?) — convenience plasticity step: use each channel's collected slice L2-norm as its activity,
  // so a channel that fired this tick potentiates (gated by affect) and idle channels relax. Returns the homunculus delta.
  function reinforce(affect = 0, live = {}) {
    const vectors = patchBay.collect();
    const activity = {};
    for (const c of Object.keys(vectors)) activity[c] = l2(vectors[c]); // reuse math.l2 (no hand-rolled hypot)
    return homunculus.reinforce(activity, affect);
  }

  return { profile, registry, patchBay, homunculus, collectAndFuse, reinforce };
}

// migrateBody(current, nextProfile, { ops, deps }) -> nextBound — THE SELF MOVES BODIES. Bind the next profile, then
// reallocate the homunculus so learning that GENERALIZES survives the swap.
//
//   MIGRATION WEIGHT-CARRY POLICY (implemented below, and the limb-loss case falls out of it for free):
//     • SHARED  — a channel present in BOTH the old and new body INHERITS its learned weight from `current`. What the
//                 self learned to value about that sense travels with it.
//     • NEW     — a channel only the new body has starts at the new homunculus's resting weight (its `init`, the value a
//                 freshly-bound channel holds) — i.e. baseline, unlearned. The self has no prior about a brand-new sense.
//     • DROPPED — a channel the old body had but the new one lacks simply does not exist in the new homunculus, so it is
//                 gone. This IS limb loss / "limp mode": a body with fewer transducers is just a profile with fewer
//                 parts; migrating to it drops the lost channels and the homunculus reallocates over what remains. No
//                 hard-coupling to any morphology — nothing special-cases a "leg" or an "eye".
//   We copy learned weights by value (current.homunculus.snapshot()); `current` is left untouched (migration is additive).
export function migrateBody(current, nextProfile, { ops = {}, deps = {} } = {}) {
  const next = bindBody(nextProfile, { ops, deps });
  if (current && current.homunculus && typeof current.homunculus.snapshot === "function") {
    const learned = current.homunculus.snapshot(); // { channel: weight } from the body we are leaving
    for (const c of next.homunculus.channels()) {
      // SHARED ⇒ inherit the learned weight. set() CLAMPS into the NEW body's [floor,ceil], so a weight carried into a
      // body with a higher floor or lower ceil is pulled into the new window (never a raw bypass of the clamp).
      if (Object.prototype.hasOwnProperty.call(learned, c)) next.homunculus.set(c, learned[c]);
      // NEW channels keep the fresh weight bindBody already gave them (baseline); DROPPED channels are absent by construction.
    }
  }
  return next;
}
