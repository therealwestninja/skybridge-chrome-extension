// bodyProfile.js — Stage-4 [additive]: a BODY'S WHOLE SENSORY IDENTITY AS DATA. Morphology is data, not code — the same
// philosophy as the quickik JSON body-plan (arbitrary topology, limb loss = a missing part, no hard-coded anatomy). A
// "body profile" is a plain serializable object declaring three things, one per earlier stage:
//   • transducers — the body's named sense sources (Stage 1). Each is a DECLARATIVE SPEC, not a closure: a `kind` plus
//                   params the binder (bindBody.js) turns into makeTransducer / makeMotorSenseTransducer. The live
//                   `read`/`readMotorState` CLOSURE is NOT in the profile (unserializable); the binder injects it from
//                   `deps` keyed by the transducer name. So the profile stays pure JSON — a body is a file.
//   • routes     — the patchBay wiring (Stage 1/2): a list of { transducer, op, channel, opts? } edges (many-to-many).
//   • homunculus — the weight-map config (Stage 2): { channels?, rate?, decay?, floor?, ceil?, baseline?, init? }.
//                  `channels` defaults to the distinct channel set named by `routes`, so a profile needn't repeat them.
//
// A profile owns NO live state and NO wiring — it is inert data. bindBody() is what instantiates it into a running
// per-body sensory front-end; migrateBody() swaps one profile for another while the SELF carries what generalizes.
// PURE: no Date.now / Math.random; deep-copies on the way in and out so a profile can't be mutated by reference.

// A transducer spec is one of:
//   { name, kind:"basic", source?, meta? }
//       → makeTransducer({ name, read: deps.sources[source ?? name], meta }). `source` lets two transducers share a
//         live read or a name differ from its deps key; defaults to the transducer's own name.
//   { name, kind:"motor", source?, stallCurrent?, residualRef?, vibrationGain?, meta? }
//       → makeMotorSenseTransducer({ name, readMotorState: deps.sources[source ?? name], ...params, meta }).
// The binder fails loudly if a spec names a kind it doesn't know or a source `deps` doesn't provide.

const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));

// makeBodyProfile({ name, transducers, routes, homunculus }) -> a frozen-ish body profile object.
//   name        — stable id for the body (audit / migration logging).
//   transducers — array of transducer specs (see above). REQUIRED, non-empty.
//   routes      — array of { transducer, op, channel, opts? }. REQUIRED. Every `transducer` must name a declared spec.
//   homunculus  — optional weight-map config; `channels` defaults to the routes' distinct channel set.
export function makeBodyProfile({ name, transducers, routes, homunculus = {} } = {}) {
  if (typeof name !== "string" || !name) throw new Error("makeBodyProfile: name must be a non-empty string");
  if (!Array.isArray(transducers) || !transducers.length) throw new Error(`makeBodyProfile(${name}): transducers must be a non-empty array`);
  if (!Array.isArray(routes) || !routes.length) throw new Error(`makeBodyProfile(${name}): routes must be a non-empty array`);

  const tds = transducers.map((t, i) => {
    if (!t || typeof t.name !== "string" || !t.name) throw new Error(`makeBodyProfile(${name}): transducer[${i}] needs a name`);
    const kind = t.kind || "basic";
    // Stage-5 [additive]: real senses on the scaffold. "audio" = makeAudioTransducer (hearing); "battery"/"latency"/"load"
    // = cyber-interoception transducers. Existing profiles use only basic/motor, so this widens the allow-set, nothing else.
    const KNOWN = new Set(["basic", "motor", "audio", "battery", "latency", "load", "selfCardinality"]);
    if (!KNOWN.has(kind)) throw new Error(`makeBodyProfile(${name}): transducer "${t.name}" has unknown kind "${kind}"`);
    return clone(t);
  });
  const declared = new Set(tds.map((t) => t.name));

  const rts = routes.map((r, i) => {
    if (!r || typeof r.transducer !== "string") throw new Error(`makeBodyProfile(${name}): route[${i}] needs a transducer`);
    if (!declared.has(r.transducer)) throw new Error(`makeBodyProfile(${name}): route[${i}] names undeclared transducer "${r.transducer}"`);
    if (typeof r.op !== "string" || !r.op) throw new Error(`makeBodyProfile(${name}): route[${i}] needs an op`);
    if (typeof r.channel !== "string" || !r.channel) throw new Error(`makeBodyProfile(${name}): route[${i}] needs a channel`);
    return { transducer: r.transducer, op: r.op, channel: r.channel, opts: clone(r.opts) || {} };
  });

  // channels default to the distinct channel set the routes target (in first-seen order) — morphology implies them.
  const routeChannels = [];
  for (const r of rts) if (!routeChannels.includes(r.channel)) routeChannels.push(r.channel);
  const homCfg = { ...clone(homunculus) };
  if (!Array.isArray(homCfg.channels) || !homCfg.channels.length) homCfg.channels = routeChannels.slice();

  const profile = { name, transducers: tds, routes: rts, homunculus: homCfg };
  profile.toJSON = () => ({ v: 1, name, transducers: clone(tds), routes: clone(rts), homunculus: clone(homCfg) });
  // channels() — the distinct channel set this body senses (what a fused vector will carry). Handy for migration diffs.
  profile.channels = () => routeChannels.slice();
  return profile;
}

// bodyProfileFromJSON(json) — rehydrate a profile from a toJSON() blob (or any equivalent plain object). Re-runs the
// same validation so a hand-written / tampered body file fails loudly rather than binding a malformed front-end.
export function bodyProfileFromJSON(json) {
  if (!json || typeof json !== "object") throw new Error("bodyProfileFromJSON: expected an object");
  return makeBodyProfile({ name: json.name, transducers: json.transducers, routes: json.routes, homunculus: json.homunculus });
}
