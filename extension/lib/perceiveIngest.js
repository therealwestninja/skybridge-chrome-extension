/*wrap*/(function(){
// perceiveIngest.js — THE OPTIC CHIASM / LGN. The convergence point where afferent "retinal packets" from many organs,
// arriving over any nerve (BLE, Skybridge/relay, loopback, optical), merge into ONE percept stream before the cortex.
//
// The phone (and the watch, and any future puck) is a SENSE ORGAN that preprocesses locally and emits a compressed
// abstraction packet; the nerve carries it; THIS is where the packets land. Its unique job is not sensing and not
// deliberation — it is CONVERGENCE, and convergence has exactly two hazards, which map to two kinds of organ:
//
//   • BROADCAST organs (a UDP radar puck heard by every listener on the subnet) genuinely arrive TWICE — the same
//     (organId, sampleAt) down two nerves. Hazard: double-counting. Cure: DEDUPE on (organId, sampleAt).
//   • SINGLE-LINK organs (a BLE heart-rate strap — one central at a time; it must drop before it re-pairs) cannot
//     double-report, but they RE-HOME: the strap leaves the phone and re-pairs to the extension. Hazard: reading
//     "sense LOST, new sense APPEARED" when it is the same organ crossing ganglia. Cure: RESUME — the same organId on
//     a new nerve is the same track continued; the gap is `stale`, never `never`.
//
// So the organ carries its OWN identity (organId), not its host's, and this gate keys on it. Provenance vocabulary is
// radarSense.js's, deliberately: `read` (a fresh sample), `stale` (known organ, gap since last), `never` (unheard-of).
//
// PURE: no Date.now / Math.random / network. `now`/`at` are injected (a caller with no clock still works; provenance
// then falls back to sample times). NEVER THROWS: a malformed packet is counted in `rejected`, never propagated.
// Host-agnostic by construction (dep-free, UMD export) — the SAME module runs in rook-core (Node) and in the Rook AI
// extension's service worker; only the nerve adapter feeding it differs. deviationBank / salience / bodySchema are
// INJECTED (all optional) so the convergence core is testable alone and composes the real ports when wired.

const num = (x, d = 0) => { try { const n = Number(x); return Number.isFinite(n) ? n : d; } catch (e) { return d; } };
const clamp01 = (x) => { const n = num(x, 0); return n < 0 ? 0 : n > 1 ? 1 : n; };
const str = (x) => { try { return x == null ? "" : String(x); } catch (e) { return ""; } };

// default extractors — overridable, so a caller can map exotic packets without forking this module.
// signalOf: packet -> {name, value} fed to deviationBank/bodySchema (a named scalar stream).
function defaultSignalOf(p) {
  const name = str(p.organ) || "unknown";
  // prefer an explicit scalar reading; fall back through common organ fields; last resort the deviation magnitude.
  let value;
  if (Number.isFinite(Number(p.value))) value = Number(p.value);
  else if (Number.isFinite(Number(p.bpm))) value = Number(p.bpm);
  else if (Number.isFinite(Number(p.peak))) value = Number(p.peak);
  else if (Number.isFinite(Number(p.z))) value = Math.abs(Number(p.z));
  else value = 0;
  return { name, value };
}
// intensityOf: packet -> 0..1 salience contribution (how loudly this organ is asking for the cortex's attention).
function defaultIntensityOf(p) {
  if (p.salience != null && Number.isFinite(Number(p.salience))) return clamp01(p.salience);
  if (p.z != null && Number.isFinite(Number(p.z))) return clamp01(Math.abs(Number(p.z)) / 6); // ~6σ ⇒ saturated
  if (p.peak != null && Number.isFinite(Number(p.peak))) return clamp01(p.peak);
  if (p.conf != null && Number.isFinite(Number(p.conf))) return clamp01(Number(p.conf) * 0.5);
  return 0;
}

function makePerceiveIngest({
  deviationBank = null,          // optional makeDeviationBank() — derives z server-side for raw readings
  salience = null,               // optional makeSalience() — the fast→slow escalation gate
  bodySchema = null,             // optional { feed(name, value) } — always-on proprioception sink
  signalOf = defaultSignalOf,
  intensityOf = defaultIntensityOf,
  staleMs = 10000,               // no sample for this long ⇒ a known organ reads `stale`
  dedupeWindowMs = 5000,         // (organId, sampleAt) seen within this window ⇒ a broadcast duplicate
  maxOrgans = 256,               // bound the organ table (a hostile/looping nerve can't grow it without limit)
  maxKeysPerOrgan = 64,          // bound the recent-key ring used for dedupe
} = {}) {
  // organId -> { organId, organ, firstAt, lastSampleAt, lastNerve, lastRecvAt, keys:[], keySet:Set, samples }
  const organs = new Map();
  const S = (typeof signalOf === "function") ? signalOf : defaultSignalOf;
  const I = (typeof intensityOf === "function") ? intensityOf : defaultIntensityOf;

  function forget(organId) { organs.delete(organId); }

  // evict the least-recently-heard organ when the table is full (bounded memory; convergence must never OOM).
  function evictIfFull() {
    if (organs.size < maxOrgans) return;
    let oldestId = null, oldest = Infinity;
    for (const [id, rec] of organs) { const t = num(rec.lastRecvAt, num(rec.lastSampleAt, 0)); if (t < oldest) { oldest = t; oldestId = id; } }
    if (oldestId != null) organs.delete(oldestId);
  }

  // ingest a batch of packets that arrived down ONE nerve. Returns the merged verdict.
  function ingest(packets, opts = {}) {
    const out = {
      percepts: [], deviations: [], escalate: false, salience: null,
      deduped: 0, resumed: 0, superseded: 0, rejected: 0,
    };
    let list;
    try { list = Array.isArray(packets) ? packets : (packets == null ? [] : [packets]); } catch (e) { return out; }
    const nerve = str(opts.nerve) || "?";
    const recvAt = Number.isFinite(Number(opts.at)) ? Number(opts.at) : null;
    const devSample = {};                 // {signalName: value} for a single deviationBank.observe over the batch
    const salSignals = {};                // {organKind: intensity} for one salience.score over the batch

    for (const raw of list) {
      try {
        if (!raw || typeof raw !== "object") { out.rejected++; continue; }
        const organId = str(raw.organId) || str(raw.organ);   // fall back to the kind if no explicit id (single unnamed organ)
        if (!organId) { out.rejected++; continue; }
        const organ = str(raw.organ) || "unknown";
        const hasSample = Number.isFinite(Number(raw.sampleAt));
        const sampleAt = hasSample ? Number(raw.sampleAt) : (recvAt != null ? recvAt : null);
        const broadcast = raw.broadcast === true;

        let rec = organs.get(organId);
        const known = !!rec;

        // ── DEDUPE (broadcast): the exact same (organId, sampleAt) seen recently down any nerve is one sample, not two.
        if (known && hasSample) {
          const key = String(sampleAt);
          if (rec.keySet.has(key)) {
            // only treat as a duplicate if it's within the dedupe window (else it's a legitimately-recurring value id)
            const within = recvAt == null || rec.lastRecvAt == null || (recvAt - rec.lastRecvAt) <= dedupeWindowMs;
            if (within) { out.deduped++; continue; }
          }
        }

        // ── ORDERING: an older-or-equal sample from a known organ is superseded (last-writer-by-sampleAt). Not a dup.
        if (known && hasSample && Number.isFinite(rec.lastSampleAt) && sampleAt <= rec.lastSampleAt) {
          out.superseded++; continue;
        }

        // ── RESUME (single-link re-home): same organId, newer sample, arriving on a DIFFERENT nerve ⇒ continuity.
        let resumed = false, state = "read";
        if (known) {
          if (nerve !== rec.lastNerve) resumed = true;   // crossed ganglia
          // a large gap since last sample means it WAS stale in between; this packet itself is a fresh `read`.
        } else {
          state = "read";                                // first sighting of this organ
        }

        // ── record/update the organ ──────────────────────────────────────────────────────────────────────────────
        if (!rec) {
          evictIfFull();
          rec = { organId, organ, firstAt: sampleAt, lastSampleAt: null, lastNerve: nerve, lastRecvAt: recvAt, keys: [], keySet: new Set(), samples: 0 };
          organs.set(organId, rec);
        }
        rec.organ = organ;
        rec.lastSampleAt = Number.isFinite(sampleAt) ? sampleAt : rec.lastSampleAt;
        rec.lastNerve = nerve;
        rec.lastRecvAt = recvAt != null ? recvAt : rec.lastRecvAt;
        rec.samples++;
        if (hasSample) {
          const key = String(sampleAt);
          if (!rec.keySet.has(key)) { rec.keys.push(key); rec.keySet.add(key); while (rec.keys.length > maxKeysPerOrgan) rec.keySet.delete(rec.keys.shift()); }
        }
        if (resumed) out.resumed++;

        // ── the accepted percept ────────────────────────────────────────────────────────────────────────────────
        const kind = str(raw.kind) || "reading";
        const sig = S(raw);
        const percept = {
          organId, organ, kind, nerve, state,
          sampleAt: Number.isFinite(sampleAt) ? sampleAt : null,
          label: str(raw.label) || null,
          resumed,
        };
        if (raw.z != null && Number.isFinite(Number(raw.z))) percept.z = Number(raw.z);
        if (Number.isFinite(sig.value)) percept.value = sig.value;
        out.percepts.push(percept);

        // a packet the ORGAN already flagged as a deviation (phone-side amacrine layer) is trusted through as-is.
        if (kind === "deviation" && percept.z != null) {
          out.deviations.push({ organId, organ, kind: "acute", z: percept.z, dir: num(raw.dir, 0), baseline: (raw.baseline != null ? Number(raw.baseline) : null), at: percept.sampleAt, source: "organ" });
        } else if (deviationBank) {
          // a raw reading: let the server-side bank derive the deviation (the other half of the split).
          devSample[sig.name] = sig.value;
        }
        if (bodySchema && typeof bodySchema.feed === "function") { try { bodySchema.feed(sig.name, sig.value); } catch (e) { /* sink never breaks ingest */ } }

        // salience: the loudest intensity per organ kind this batch (max, so one spike still escalates).
        const inten = I(raw);
        if (!(sig.name in salSignals) || inten > salSignals[sig.name]) salSignals[sig.name] = inten;
      } catch (e) { out.rejected++; }
    }

    // ── server-side deviation derivation over the batch (one observe call) ─────────────────────────────────────────
    if (deviationBank && Object.keys(devSample).length) {
      try {
        const r = deviationBank.observe(devSample, { at: recvAt });
        if (r && Array.isArray(r.events)) {
          for (const ev of r.events) out.deviations.push(Object.assign({ source: "bank" }, ev));
        }
      } catch (e) { /* a broken bank must not sink the whole ingest */ }
    }

    // ── the escalation verdict (fast → convene the cortex) ────────────────────────────────────────────────────────
    if (salience && Object.keys(salSignals).length) {
      try { out.salience = salience.score(salSignals); } catch (e) { out.salience = null; }
    }
    const hotDeviation = out.deviations.some((d) => d.kind === "acute" || d.kind === "global");
    out.escalate = (!!out.salience && out.salience.escalate === true) || hotDeviation;
    return out;
  }

  // a snapshot of every organ's provenance. `now` (injected) lets it distinguish `read` from `stale`; `never` is
  // simply an organId not in the table, so it is answered by ABSENCE, not by a row here.
  function organsList(now) {
    const at = Number.isFinite(Number(now)) ? Number(now) : null;
    const rows = [];
    for (const rec of organs.values()) {
      let state = "read";
      if (at != null && Number.isFinite(rec.lastSampleAt) && (at - rec.lastSampleAt) > staleMs) state = "stale";
      rows.push({ organId: rec.organId, organ: rec.organ, lastSampleAt: rec.lastSampleAt, lastNerve: rec.lastNerve, samples: rec.samples, state });
    }
    return rows.sort((a, b) => num(b.lastSampleAt) - num(a.lastSampleAt));
  }

  // provenance for a single organId — read / stale / never — the radarSense vocabulary, per-organ.
  function provenance(organId, now) {
    const rec = organs.get(str(organId));
    if (!rec) return { state: "never", lastSampleAt: null, lastNerve: null };
    const at = Number.isFinite(Number(now)) ? Number(now) : null;
    const state = (at != null && Number.isFinite(rec.lastSampleAt) && (at - rec.lastSampleAt) > staleMs) ? "stale" : "read";
    return { state, lastSampleAt: rec.lastSampleAt, lastNerve: rec.lastNerve, samples: rec.samples };
  }

  function reset() { organs.clear(); }

  return { ingest, organs: organsList, provenance, forget, reset };
}

// UMD-style export, matching the other lib/ports modules (Node require + extension service-worker / browser global).
if (typeof module !== "undefined" && module.exports) {
  module.exports = Object.assign(module.exports || {}, { makePerceiveIngest, defaultSignalOf, defaultIntensityOf });
}
if (typeof globalThis !== "undefined") { try { globalThis.makePerceiveIngest = globalThis.makePerceiveIngest || makePerceiveIngest; } catch (e) {} }

})();
