// innerLife.js — a HEADLESS composite of the inner-life / affect / relational / interoceptive faculties.
//
// The "one core, many bodies" gap (cross-surface + brain-faculties audits): the rich cognition — affect, drives,
// relationship, beliefs, psyche, inner voice, growth, the interoceptive body — is instantiated ONLY in the browser
// `app.js` (~86 imports). The Moot SERVER node (`brainNode.js`) mounts a bare decider, and the PHONE runs a stale
// `brain-bundle.js`; both are affect/memory/self blind. This module extracts that stack into ONE mountable composite so
// the server and phone become as cognitively rich as the browser lab.
//
// What it does:
//   • instantiates the faculties — the ZERO-dependency ones always; the ones that need `organism`/`store`/`backend`
//     only when those deps are supplied (so it runs fully headless with none of them);
//   • gives them ONE unified `snapshot()`/`restore()` using the SAME registry shape `app.js` uses (same method names,
//     `typeof`-guarded), so the accumulated self serializes identically and is PORTABLE across bodies;
//   • exposes the faculty instances for the host's own loop to read/update.
//
// What it does NOT do: run the organism/mind per-turn tick. The host drives whatever loop it has; this is the STATE +
// faculties container + a portable persistence seam. PURE-ish: `now` injected, no DOM, no network (backend optional).

import { makeCalibratedAffect } from "./calibratedAffect.js";
import { makeResilience } from "./resilience.js";
import { makeDrives } from "./drives.js";
import { makeTheoryOfMind } from "./theoryOfMind.js";
import { makeWorld } from "./world.js";
import { makeEngagement } from "./engagement.js";
import { makeProactivity } from "./proactivity.js";
import { makeInnerVoice } from "./innerVoice.js";
import { makeExpress } from "./express.js";
import { makeGrowth } from "./growth.js";
import { makeRelationship } from "./relationship.js";
import { makePsyche } from "./psyche.js";
import { makePrimal } from "./primal.js";
import { makeViscera } from "./viscera.js";
import { makeTouch } from "./touch.js";
import { makeEndocrine } from "./endocrine.js";
import { makeBeliefs } from "./beliefs.js";
import { makeEventSegment } from "./eventSegment.js";
import { makeVitals } from "./vitals.js";
import { makeSocraticCritic } from "./socraticCritic.js";
import { makeImagination } from "./imagination.js";
import { makeConsolidation } from "./consolidation.js";
import { makeHierarchy } from "./hierarchy.js";
import { makeDistiller } from "./distiller.js";
import { makeRespoolSelf } from "./respoolSelf.js";
import { makeSelf } from "./self.js";
import { makeChronos } from "./chronos.js";

// The composable set. Each entry: [name, build(deps), snapMethod|null, requiredDeps[]].
// `snapMethod` is the serialize method used for persistence (matches app.js's faculty registry; null = not persisted).
// `requiredDeps` names the deps that must be present to build it (a faculty missing a dep is skipped — headless-safe).
// Order mirrors app.js's construction so a snapshot/restore round-trips identically to a full-app snapshot subset.
function SPEC(d) {
  return [
    // ── zero-dependency: affect, relational, interoceptive, self-report ──
    ["calibratedAffect", () => makeCalibratedAffect(), "snapshot", []],
    ["resilience", () => makeResilience(), "snapshot", []],
    ["drives", () => makeDrives(), "serialize", []],
    ["theoryOfMind", () => makeTheoryOfMind(), "serialize", []],
    ["world", () => makeWorld(), "serialize", []],
    ["engagement", () => makeEngagement(), "snapshot", []],
    ["proactivity", () => makeProactivity(), "snapshot", []],
    ["innerVoice", () => makeInnerVoice(), "snapshot", []],
    ["express", () => makeExpress(), "snapshot", []],
    ["growth", () => makeGrowth(), "snapshot", []],
    ["relationship", () => makeRelationship(), "snapshot", []],
    ["psyche", () => makePsyche(), "snapshot", []],
    ["primal", () => makePrimal(), "snapshot", []],
    ["viscera", () => makeViscera(), "snapshot", []],
    ["touch", () => makeTouch(), "snapshot", []],
    ["endocrine", () => makeEndocrine(), "snapshot", []],
    ["beliefs", () => makeBeliefs(), "snapshot", []],
    ["eventSegment", () => makeEventSegment(), "snapshot", []],
    ["vitals", () => makeVitals(), "snapshot", []],
    ["chronos", () => makeChronos({ now: d.now }), "serialize", []],   // the temporal self ("where am I in time") — needs only `now`, which the composite always has, so it runs on any body incl. the server (was phone-only)
    ["socraticCritic", () => makeSocraticCritic(), null, []],   // per-session instrument, not persisted
    // ── dep-gated: only built when the body supplies the substrate/store/mouth ──
    ["imagination", () => makeImagination({ organism: d.organism }), null, ["organism"]],
    ["consolidation", () => makeConsolidation({ organism: d.organism, store: d.store }), null, ["organism", "store"]],
    ["hierarchy", () => makeHierarchy({ store: d.store, backend: d.backend }), null, ["store", "backend"]],
    ["distiller", () => makeDistiller({ backend: d.backend, onFault: d.onFault }), null, ["backend"]],
    ["respoolSelf", () => makeRespoolSelf({ backend: d.backend, onFault: d.onFault }), "snapshot", ["backend"]],
    ["self", () => makeSelf({ backend: d.backend }), "serialize", ["backend"]],
  ];
}

export function makeInnerLife(config = {}) {
  const {
    organism = null, store = null, backend = null,
    now = () => (typeof Date !== "undefined" ? Date.now() : 0),
    onFault = () => {},
    include = null,   // if set, ONLY these faculty names are built (a whitelist)
    exclude = [],     // faculty names to skip (a blacklist)
  } = config;
  const d = { organism, store, backend, now, onFault };
  const inc = include ? new Set(include) : null;
  const exc = new Set(exclude || []);
  const has = (dep) => d[dep] != null;

  const faculties = {};              // name → instance
  const registry = [];               // { name, snap } for the ones that persist
  const skipped = [];                // { name, why } (missing dep or filtered) — observability

  for (const [name, build, snap, need] of SPEC(d)) {
    if ((inc && !inc.has(name)) || exc.has(name)) { skipped.push({ name, why: "filtered" }); continue; }
    const missing = (need || []).filter((dep) => !has(dep));
    if (missing.length) { skipped.push({ name, why: "needs " + missing.join("+") }); continue; }
    try {
      const inst = build();
      if (!inst) { skipped.push({ name, why: "null" }); continue; }
      faculties[name] = inst;
      if (snap) registry.push({ name, snap });
    } catch (e) { skipped.push({ name, why: String((e && e.message) || e).slice(0, 80) }); try { onFault("innerLife:" + name, e); } catch (_) {} }
  }

  // Unified persistence — the SAME shape app.js's facultyMeta()/restoreFaculties() use (typeof-guarded, so a faculty
  // without the method is silently skipped, never a throw). This is what makes the self portable across bodies.
  function snapshot() {
    const m = {};
    for (const { name, snap } of registry) {
      const f = faculties[name];
      if (f && typeof f[snap] === "function") { try { m[name] = f[snap](); } catch (e) { try { onFault("innerLife.snapshot:" + name, e); } catch (_) {} } }
    }
    return m;
  }
  function restore(meta) {
    if (!meta) return 0;
    let n = 0;
    for (const { name } of registry) {
      const f = faculties[name];
      if (f && meta[name] != null && typeof f.restore === "function") { try { f.restore(meta[name]); n++; } catch (e) { try { onFault("innerLife.restore:" + name, e); } catch (_) {} } }
    }
    return n;   // how many faculties were rehydrated
  }

  return {
    get: (name) => faculties[name] || null,
    has: (name) => Object.prototype.hasOwnProperty.call(faculties, name),
    names: () => Object.keys(faculties),
    faculties,                          // the live instances, for the host's own loop to read/update
    count: () => Object.keys(faculties).length,
    skipped: () => skipped.slice(),     // what wasn't built + why (missing organism/store/backend, or filtered)
    persisted: () => registry.map((r) => r.name),
    snapshot, restore,
    serialize: snapshot,                // alias — matches the house `serialize()` convention
  };
}
