// patchBay.js — the SYNESTHESIA ROUTER. A runtime-mutable, MANY-TO-MANY routing table that connects transducers (raw
// normalized sources) → scaffold ops (percept-shaping computations) → named organ channels (the keys organFusion.fuse
// consumes). This is the seam that makes senses FUNGIBLE: the same transducer can be patched into two different channels
// through two different ops, and any channel can be fed by several transducers — exactly like a studio patch bay where a
// signal is split and re-coloured on the way to different buses.
//
// The end-to-end pipeline this sits in the middle of:
//   transducer.read()  →  op(reading, opts)  →  { channel: percept-vector }  →  organFusion.fuse(vectors, live)
//
// A ROUTE is a triple (transducerName → { op, channel }). The table maps each transducer to a LIST of such edges, so a
// single source fans out. `collect()` walks the table, reads each transducer once (memoized per collect, so a source
// routed twice is sampled once), runs each routed op, and assembles the vectors object. When several edges target the
// SAME channel, their vectors are concatenated in route order (the channel's organ slice = all its contributors).
//
// PURE GLUE: no wiring, no dependency — ops + registry are injected. Deterministic iff the injected transducers are.

// makePatchBay({ registry, ops, onError? })
//   onError(err, ctx) — OPTIONAL fault sink. collect() is FAULT-ISOLATING (see below); every swallowed fault is
//   reported here (ctx = { phase:"read"|"op", transducer, op?, channel? }) so a misbehaving source is observable
//   rather than silent. Defaults to a no-op (fail-open: a bad sense degrades the percept, it never crashes the tick).
export function makePatchBay({ registry, ops = {}, onError = () => {} } = {}) {
  if (!registry || typeof registry.get !== "function") throw new Error("makePatchBay: a transducer registry is required");
  // table: transducerName -> [{ opName, channel, opts }]  (insertion-ordered edges).
  const table = new Map();

  function edges(name) {
    if (!table.has(name)) table.set(name, []);
    return table.get(name);
  }

  return {
    // route(transducerName, opName, channel, opts?) — add ONE edge. The transducer must be registered and the op must
    // exist in `ops` (fail loudly on a typo). opts are passed to the op at collect time. Duplicate identical edges are
    // rejected so the table stays a clean set. Returns `this` for chaining.
    route(transducerName, opName, channel, opts = {}) {
      if (!registry.has(transducerName)) throw new Error(`patchBay.route: unknown transducer "${transducerName}"`);
      if (typeof ops[opName] !== "function") throw new Error(`patchBay.route: unknown op "${opName}"`);
      if (typeof channel !== "string" || !channel) throw new Error("patchBay.route: channel must be a non-empty string");
      const list = edges(transducerName);
      if (list.some((e) => e.opName === opName && e.channel === channel)) {
        throw new Error(`patchBay.route: duplicate route ${transducerName} -${opName}-> ${channel}`);
      }
      list.push({ opName, channel, opts });
      return this;
    },

    // unroute(transducerName, opName?, channel?) — remove edges. With only a transducer, drop ALL its edges; with an op
    // and/or channel, drop just the matching ones. Returns the number of edges removed.
    unroute(transducerName, opName, channel) {
      if (!table.has(transducerName)) return 0;
      if (opName == null && channel == null) {
        const n = table.get(transducerName).length;
        table.delete(transducerName);
        return n;
      }
      const list = table.get(transducerName);
      const kept = list.filter((e) => !((opName == null || e.opName === opName) && (channel == null || e.channel === channel)));
      const removed = list.length - kept.length;
      if (kept.length) table.set(transducerName, kept); else table.delete(transducerName);
      return removed;
    },

    // routes() — a flat, inspectable snapshot of the table (for audit/debug): [{ transducer, op, channel }, ...].
    routes() {
      const out = [];
      for (const [t, list] of table) for (const e of list) out.push({ transducer: t, op: e.opName, channel: e.channel });
      return out;
    },

    // collect() -> { channel: number[] } — the payload organFusion.fuse consumes. Reads each routed transducer ONCE
    // (memoized), runs each edge's op over that reading, and appends the resulting percept vector to its target channel
    // (concatenating when a channel has multiple contributors).
    //
    // FAULT ISOLATION POLICY (fail-open, per-fault scoped): a single misbehaving sense must not starve every other
    // organ of the tick. A transducer whose read() THROWS is skipped WHOLE — none of its edges contribute this collect
    // (we cannot trust a reading we never got). An op that THROWS drops only THAT edge — the transducer's other edges,
    // fed the same good reading, still contribute. Every fault is surfaced via onError (never swallowed silently).
    // NON-finite readings (NaN/Infinity/undefined) are NOT faults: the ops sanitize them through math.num(), so they
    // flow through as well-defined zeros rather than being dropped.
    collect() {
      const readingOf = new Map(); // transducerName -> cached reading this collect
      const failed = new Set();    // transducerName -> read() threw; skip all its edges
      const vectors = {};
      for (const [tName, list] of table) {
        if (!list.length || failed.has(tName)) continue;
        if (!readingOf.has(tName)) {
          try { readingOf.set(tName, registry.get(tName).read()); }
          catch (err) { failed.add(tName); onError(err, { phase: "read", transducer: tName }); continue; }
        }
        const reading = readingOf.get(tName);
        for (const e of list) {
          let vec;
          try { vec = ops[e.opName](reading, e.opts); }
          catch (err) { onError(err, { phase: "op", transducer: tName, op: e.opName, channel: e.channel }); continue; }
          const arr = Array.isArray(vec) ? vec : [vec];
          vectors[e.channel] = vectors[e.channel] ? vectors[e.channel].concat(arr) : arr.slice();
        }
      }
      return vectors;
    },
  };
}
