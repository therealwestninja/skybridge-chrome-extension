/*wrap*/(function(){
// opticNerve.js — THE OPTIC NERVE. Carries compressed retinal packets from a sense organ inward to whatever cortex is
// listening. It is bandwidth-limited BY DESIGN — that constraint is the whole reason the retina compresses — and this
// module makes the constraint honest: when the nerve narrows, only the HIGHEST-SALIENCE packets survive (fidelity
// scales with the fiber; attention decides what is worth carrying). It is transport-agnostic: it holds a set of FIBERS
// (wi-fi/loopback, Skybridge/relay, direct BLE, optical), each an injected `send(frame)`, picks the best healthy one,
// frames the batch, delivers, and FAILS OVER to the next fiber when one drops. The cortex end is trivial — parseFrame()
// then hand the packets to perceiveIngest — so the send side is where the logic lives.
//
// PURE / deterministic given injected transports + injected `now`. NEVER THROWS: a throwing transport is a failed send
// (fiber marked down, failover), never an exception out of here. Host-agnostic (dep-free, UMD): the same nerve brain
// runs on the phone (send side) and could run anywhere; only the concrete fibers differ per host. `salienceOf` reuses
// perceiveIngest's intensity notion so the nerve and the LGN agree on how loud a packet is.

let _defaultIntensityOf;
try { _defaultIntensityOf = require("./perceiveIngest").defaultIntensityOf; } catch (e) { _defaultIntensityOf = null; }
const intensityFallback = (p) => {
  try {
    if (!p || typeof p !== "object") return 0;
    if (p.salience != null && Number.isFinite(Number(p.salience))) { const n = Number(p.salience); return n < 0 ? 0 : n > 1 ? 1 : n; }
    if (p.z != null && Number.isFinite(Number(p.z))) { const n = Math.abs(Number(p.z)) / 6; return n > 1 ? 1 : n; }
    if (p.peak != null && Number.isFinite(Number(p.peak))) { const n = Number(p.peak); return n < 0 ? 0 : n > 1 ? 1 : n; }
    if (p.conf != null && Number.isFinite(Number(p.conf))) { const n = Number(p.conf) * 0.5; return n > 1 ? 1 : n; }
    return 0;
  } catch (e) { return 0; }
};
const num = (x, d = 0) => { try { const n = Number(x); return Number.isFinite(n) ? n : d; } catch (e) { return d; } };
const str = (x) => { try { return x == null ? "" : String(x); } catch (e) { return ""; } };

function makeOpticNerve({
  fibers = [],                 // [{ name, priority=0, oneWay=false, send(frame) -> bool|Promise<bool> }] — throw/false = failed
  capacity = 256,              // max packets held before salience-drop (a thin nerve keeps only the loudest)
  cooldownMs = 3000,           // a failed fiber is skipped for this long before it is retried
  salienceOf = null,           // packet -> 0..1 (drop priority); defaults to perceiveIngest's intensity notion
  now = null,                  // injected clock (ms). Absent ⇒ cooldown/health degrade gracefully (always-eligible).
  version = 1,
} = {}) {
  const SAL = (typeof salienceOf === "function") ? salienceOf : (_defaultIntensityOf || intensityFallback);
  const clock = (typeof now === "function") ? now : null;
  const tNow = () => (clock ? num(clock(), 0) : null);

  // fiber registry: name -> { name, priority, oneWay, send, downUntil, lastOkAt, sends, fails }
  const F = new Map();
  const addFiber = (f) => {
    if (!f || typeof f !== "object" || typeof f.send !== "function") return false;
    const name = str(f.name) || ("fiber" + (F.size + 1));
    F.set(name, { name, priority: num(f.priority, 0), oneWay: f.oneWay === true, send: f.send, downUntil: 0, lastOkAt: null, sends: 0, fails: 0 });
    return true;
  };
  try { for (const f of (Array.isArray(fibers) ? fibers : [])) addFiber(f); } catch (e) { /* ignore bad fiber list */ }

  let queue = [];   // packets awaiting a nerve

  // ── bounded, salience-aware enqueue: when full, drop the LOWEST-salience packets (ties → oldest) ────────────────
  function enqueue(packets) {
    let list;
    try { list = Array.isArray(packets) ? packets : (packets == null ? [] : [packets]); } catch (e) { return { queued: 0, dropped: 0 }; }
    const before = queue.length;
    for (const p of list) { if (p && typeof p === "object") queue.push({ p, sal: SAL(p), seq: queue.length }); }
    let dropped = 0;
    if (queue.length > capacity) {
      // keep the highest-salience `capacity` packets. Sort a copy by (salience desc, seq asc = older first kept), slice.
      const keep = queue.slice().sort((a, b) => (b.sal - a.sal) || (a.seq - b.seq)).slice(0, capacity);
      const keepSet = new Set(keep.map((e) => e.seq));
      dropped = queue.length - keep.length;
      queue = queue.filter((e) => keepSet.has(e.seq));
    }
    return { queued: queue.length - before + dropped >= 0 ? list.filter((p) => p && typeof p === "object").length : 0, dropped, pending: queue.length };
  }

  // ── the wire envelope ──────────────────────────────────────────────────────────────────────────────────────────
  function frame(packets, meta = {}) {
    const arr = Array.isArray(packets) ? packets.filter((p) => p && typeof p === "object") : [];
    return { v: num(version, 1), nerve: str(meta.nerve) || null, sentAt: Number.isFinite(Number(meta.sentAt)) ? Number(meta.sentAt) : tNow(), n: arr.length, packets: arr };
  }
  // safe parse at the CORTEX end: bad/garbage wire ⇒ null, never a throw. Accepts an object or a JSON string.
  function parseFrame(raw) {
    try {
      let o = raw;
      if (typeof raw === "string") { try { o = JSON.parse(raw); } catch (e) { return null; } }
      if (!o || typeof o !== "object") return null;
      if (!Array.isArray(o.packets)) return null;
      return { v: num(o.v, 1), nerve: (o.nerve == null ? null : str(o.nerve)), sentAt: (Number.isFinite(Number(o.sentAt)) ? Number(o.sentAt) : null), packets: o.packets.filter((p) => p && typeof p === "object") };
    } catch (e) { return null; }
  }

  // eligible fibers = not in cooldown, ordered by priority desc (stable). Cooldown is skipped when there is no clock.
  function eligible() {
    const t = tNow();
    const rows = [];
    for (const f of F.values()) { if (t == null || t >= num(f.downUntil, 0)) rows.push(f); }
    return rows.sort((a, b) => b.priority - a.priority);
  }

  // ── send: coalesce the queue (+ any explicit packets) into ONE frame, deliver over the best healthy fiber, failover.
  async function send(opts = {}) {
    try {
      if (opts && opts.packets) enqueue(opts.packets);
      const batch = queue.map((e) => e.p);
      if (!batch.length) return { ok: true, fiber: null, sent: 0, tried: [], pending: 0 };

      const cands = eligible();
      const tried = [];
      if (!cands.length) return { ok: false, fiber: null, sent: 0, tried, reason: "no-eligible-fiber", pending: queue.length };

      for (const f of cands) {
        const fr = frame(batch, { nerve: f.name, sentAt: tNow() });
        let okSend = false;
        try { okSend = await f.send(fr) !== false; } catch (e) { okSend = false; }
        tried.push(f.name);
        f.sends++;
        if (okSend) {
          f.lastOkAt = tNow(); f.downUntil = 0;
          queue = [];   // delivered — clear (the frame carried the whole batch)
          return { ok: true, fiber: f.name, sent: batch.length, tried, pending: 0 };
        }
        // failed: cool this fiber down, try the next.
        f.fails++;
        const t = tNow(); f.downUntil = (t == null ? 0 : t + cooldownMs);
      }
      // every fiber failed — the batch stays queued for the next attempt (nothing is silently lost).
      return { ok: false, fiber: null, sent: 0, tried, reason: "all-fibers-failed", pending: queue.length };
    } catch (e) { return { ok: false, fiber: null, sent: 0, tried: [], reason: "threw", pending: queue.length }; }
  }

  function status(nowArg) {
    const t = Number.isFinite(Number(nowArg)) ? Number(nowArg) : tNow();
    const rows = [];
    for (const f of F.values()) rows.push({ name: f.name, priority: f.priority, oneWay: f.oneWay, up: (t == null ? true : t >= num(f.downUntil, 0)), downUntil: f.downUntil, lastOkAt: f.lastOkAt, sends: f.sends, fails: f.fails });
    return rows.sort((a, b) => b.priority - a.priority);
  }
  function markDown(name, ms) { const f = F.get(str(name)); if (!f) return false; const t = tNow(); f.downUntil = (t == null ? 0 : t + num(ms, cooldownMs)); return true; }
  function markUp(name) { const f = F.get(str(name)); if (!f) return false; f.downUntil = 0; return true; }

  return {
    enqueue, send, frame, parseFrame, status, markDown, markUp,
    addFiber,
    pending: () => queue.length,
    reset: () => { queue = []; for (const f of F.values()) { f.downUntil = 0; f.lastOkAt = null; f.sends = 0; f.fails = 0; } },
  };
}

// UMD-style export (Node require + extension service-worker / phone browser global).
if (typeof module !== "undefined" && module.exports) {
  module.exports = Object.assign(module.exports || {}, { makeOpticNerve });
}
if (typeof globalThis !== "undefined") { try { globalThis.makeOpticNerve = globalThis.makeOpticNerve || makeOpticNerve; } catch (e) {} }

})();
