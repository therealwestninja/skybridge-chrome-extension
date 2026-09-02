// meshRelay.js — a multi-hop, RADIO-FREE MESH RELAY (Cluster J). The kinship beacon (kinship.js / manifest.js) is
// LINE-OF-SIGHT: brain A can only recognize brain B if B's chirp/blink/ping/glyph reaches A's own senses. This module
// propagates a message or beacon BEYOND that horizon, human-free and network-free: a relay-capable brain that hears a
// worthwhile packet re-emits it, so a call for help crosses a rubble field one bot-hop at a time.
//
// Three mechanisms make that safe and useful without any radio, registry, or clock:
//   • HOP-COUNT TTL   — every packet carries a ttl; each re-emit decrements it, so a message dies after N hops instead
//                       of flooding forever.
//   • PROVENANCE CHAIN — each hop appends its own id to packet.chain. A packet whose chain already holds MY id is a
//                       LOOP and is dropped (so echoes and rings die); the chain is also a tamper-evident record of the
//                       exact path a packet took, and its length is the observed hop-distance to the origin.
//   • ROUGH LOCALIZATION — when a bot RECEIVES a packet it notes the bearing/range it measured on the emitter it heard
//                       it from, plus how many hops away the origin is. positionGraph() assembles those per source into
//                       a coarse "the survivor's beacon came from ~that way, ~this far, N hops out" estimate.
//
// The caller wires receive() to whatever the body actually sensed (a decoded beacon, a relayed packet) and forwards the
// returned to-FORWARD packet through its own emitter — which may itself be gated by beacon-silence policy. This module
// does no I/O and holds no clock: `now` is passed in, and there is no Math.random / Date.now. Deterministic,
// dependency-free, self-contained (it deliberately imports nothing — a relay must run on the smallest body).

const nz = (v) => (typeof v === "number" && !Number.isNaN(v) ? v : null);

export function makeMeshRelay(opts = {}) {
  const { selfId, maxSeen = 200 } = opts;
  let counter = 0;                                  // deterministic per-brain packet-id sequence (no random/clock)
  const seenSet = new Set();                        // packet ids already handled (dedup) — bounded, FIFO-evicted
  const seenOrder = [];                             // insertion order for the seen-set eviction
  const sources = new Map();                        // sourceKey → localization record assembled from receptions

  // Bounded FIFO seen-set: remember a packet id, evicting the oldest once we exceed maxSeen.
  const remember = (id) => {
    if (seenSet.has(id)) return;
    seenSet.add(id); seenOrder.push(id);
    while (seenOrder.length > maxSeen) seenSet.delete(seenOrder.shift());
  };

  // A source is keyed by whatever identifies the ORIGIN of a packet: its chain[0] (the originator's id), falling back to
  // the packet id itself so a source-less packet still localizes as its own thing.
  const sourceKeyOf = (packet) => "src:" + ((packet.chain && packet.chain[0]) ?? packet.id);

  // Fold one reception into the localization estimate for its source: keep the SHORTEST chain seen (best hop-distance)
  // and the most-recent measured bearing/range (from the neighbour we actually heard it from).
  const localize = (packet, { fromId, bearing, range, now }) => {
    const key = sourceKeyOf(packet);
    const hops = Array.isArray(packet.chain) ? packet.chain.length : 0;
    const prev = sources.get(key);
    const rec = prev || { source: (packet.chain && packet.chain[0]) ?? packet.id, hops, lastBearing: null, estRange: null, lastFrom: null, lastSeen: now, count: 0 };
    rec.hops = prev ? Math.min(prev.hops, hops) : hops;
    if (nz(bearing) != null) rec.lastBearing = bearing;
    if (nz(range) != null) rec.estRange = range;
    rec.lastFrom = fromId ?? rec.lastFrom;
    rec.lastSeen = now;
    rec.count = (prev ? prev.count : 0) + 1;
    sources.set(key, rec);
    return rec;
  };

  return {
    self: () => selfId,

    // Mint a fresh packet stamped with ME as chain[0] — I am its origin and its first (zeroth) hop.
    originate(kind, payload, { ttl = 4 } = {}) {
      const id = String(selfId) + ":" + (counter++);
      return { id, kind, payload, ttl, chain: [selfId] };
    },

    // Perceive a packet the body sensed, relayed from neighbour `fromId` (with optional measured bearing/range).
    // Returns the packet to FORWARD (ttl-1, my id appended) if it should keep travelling, else null. Reasons a packet
    // is DROPPED (→ null, and NOT forwarded): malformed; already-seen id (dedup); dead ttl; or a LOOP (my id already in
    // the chain, or the immediate neighbour already relayed it). Every accepted packet is recorded + localized.
    receive(packet, ctx = {}) {
      if (!packet || packet.id == null) return null;
      const { fromId = null, bearing = null, range = null, now = 0 } = ctx;
      const chain = Array.isArray(packet.chain) ? packet.chain : [];
      const ttl = typeof packet.ttl === "number" ? packet.ttl : 0;

      if (seenSet.has(packet.id)) return null;                     // dedup — already handled this exact packet
      if (ttl <= 0) { remember(packet.id); return null; }          // ttl exhausted — record, but do not forward
      if (chain.includes(selfId)) { remember(packet.id); return null; } // LOOP: I'm already on this packet's path
      if (fromId != null && fromId === selfId) { remember(packet.id); return null; } // neighbour is me — self-echo

      // Accept: record it, fold it into localization, then decide whether to re-emit.
      remember(packet.id);
      localize({ ...packet, chain }, { fromId, bearing, range, now });

      const nextTtl = ttl - 1;
      if (nextTtl <= 0) return null;                               // this hop was the last — deliver, don't forward
      return { id: packet.id, kind: packet.kind, payload: packet.payload, ttl: nextTtl, chain: [...chain, selfId] };
    },

    // Rough position estimate per perceived source: min hop-distance seen + the last measured bearing/range.
    positionGraph() {
      const out = {};
      for (const rec of sources.values()) {
        out[rec.source] = { hops: rec.hops, lastBearing: rec.lastBearing, estRange: rec.estRange, lastFrom: rec.lastFrom, count: rec.count };
      }
      return out;
    },

    seen: (id) => seenSet.has(id),
    forget(id) {                                                   // drop a single seen id (e.g. to allow a re-relay)
      if (!seenSet.has(id)) return false;
      seenSet.delete(id);
      const i = seenOrder.indexOf(id); if (i >= 0) seenOrder.splice(i, 1);
      return true;
    },
    seenCount: () => seenSet.size,

    snapshot() {
      return {
        selfId, counter,
        seen: [...seenOrder],
        sources: [...sources.entries()].map(([k, v]) => [k, { ...v }]),
      };
    },
    restore(s) {
      if (!s) return;
      counter = typeof s.counter === "number" ? s.counter : counter;
      seenSet.clear(); seenOrder.length = 0;
      for (const id of s.seen || []) remember(id);
      sources.clear();
      for (const [k, v] of s.sources || []) sources.set(k, { ...v });
    },
  };
}
