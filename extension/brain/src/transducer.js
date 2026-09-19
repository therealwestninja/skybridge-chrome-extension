// transducer.js — a UNIFORM abstraction over "a source of a normalized sensory value/vector". This generalizes exactly
// what the flySenses encoders do: each is a pure function from raw body telemetry to a normalized number (a scalar
// reflex term) or number[] (an organ vector). A Transducer wraps one such source behind a single `read()` contract so
// the router (patchBay) can treat optic-flow, looming, attitude, contact — any sense — interchangeably.
//
// DESIGN: a Transducer owns NO routing and NO wiring; it is purely "ask it, it reports its current value". The value is
// produced by the caller-supplied `read` closure (which typically calls a flySenses encoder / scaffold op over whatever
// live telemetry the closure has captured). `meta` is opaque descriptive data (units, range, which sense) for audit.
// No dependency; plain JS; deterministic iff the injected `read` is.

// makeTransducer({ name, read, meta }) -> { name, meta, read() }
//   name : string    — stable id the registry/patchBay key on.
//   read : () => number | number[]  — REQUIRED; the current normalized reading. Pure relative to its captured source.
//   meta : object    — OPTIONAL descriptive metadata (e.g. { sense:"optic-flow", range:[-1,1], dim:3 }). Copied shallow.
export function makeTransducer({ name, read, meta = {} } = {}) {
  if (typeof name !== "string" || !name) throw new Error("makeTransducer: name must be a non-empty string");
  if (typeof read !== "function") throw new Error(`makeTransducer(${name}): read must be a function`);
  return {
    name,
    meta: { ...meta },
    // Return the current reading. We do NOT coerce/clamp here — a Transducer reports its source faithfully; the
    // scaffold ops downstream (scaffoldOps.js) own the normalization into a percept vector.
    read() { return read(); },
  };
}

// makeTransducerRegistry() -> { register, get, list, has, remove }
//   A tiny keyed store of transducers. register() rejects duplicate names (additive, no silent clobber); get() throws
//   on a missing name so a mis-wired route fails loudly rather than silently reading undefined.
export function makeTransducerRegistry() {
  const byName = new Map();
  return {
    // register(transducer) or register({ name, read, meta }) — constructs one if given a plain spec. Returns it.
    register(t) {
      const td = (t && typeof t.read === "function" && typeof t.name === "string") ? t : makeTransducer(t);
      if (byName.has(td.name)) throw new Error(`transducer already registered: ${td.name}`);
      byName.set(td.name, td);
      return td;
    },
    get(name) {
      const td = byName.get(name);
      if (!td) throw new Error(`unknown transducer: ${name}`);
      return td;
    },
    has(name) { return byName.has(name); },
    remove(name) { return byName.delete(name); },
    list() { return [...byName.keys()]; },
  };
}
