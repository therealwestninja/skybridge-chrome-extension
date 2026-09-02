// compromiseScan.js — the "am I / are you possessed?" integrity detector (Cluster J). Provenance: Bobiverse book 2's
// Homer-the-hijacked-puppet — peers spotted the compromise NOT by reading his code but because his BEHAVIORAL SIGNATURE
// suddenly changed: the joker went all-business, the initiator withdrew, refusals spiked. Compromise shows up as a SUDDEN,
// SUSTAINED intra-self shift away from a learned baseline. (This is deliberately DISTINCT from replicative drift, which is
// the SLOW divergence between forks over long time; here the signal is a fast step-change within one self.)
//
// MECHANISM (deterministic, dependency-free):
//   • Each turn the caller feeds a small feature vector of behavioral RATES via observe(features) — e.g.
//     { humor, initiative, refusal, topicDiversity, verbosity } each in [0,1]. Unknown keys are tracked too.
//   • A BASELINE is learned as an EWMA over the first N observations (or set explicitly via setBaseline). A short recent
//     WINDOW holds the last k observations; its mean is the CURRENT signature.
//   • drift = mean absolute per-feature distance between the current-window signature and the baseline. A drift above
//     `driftThreshold` for `p` consecutive scans (debounce, per guard.js: one excursion is noise; require p-in-a-row)
//     ⇒ { compromised:true, drift, changed:[features that moved most] }. A single odd turn never trips it; sustained
//     recovery toward baseline clears it.
//   • Self AND peers: observePeer(id, features) / scanPeer(id) keep per-peer baselines + streaks. On a positive detection
//     the verdict is simply RETURNED (no import of trust.js) so a caller can quarantine.
const clamp01 = (x) => { const n = Number(x); return !Number.isFinite(n) ? 0 : Math.max(0, Math.min(1, n)); };
const ema = (prev, x, beta) => (prev == null ? x : prev * (1 - beta) + x * beta);
const keysOf = (...vs) => { const s = new Set(); for (const v of vs) if (v) for (const k of Object.keys(v)) s.add(k); return [...s]; };
const meanVec = (vecs) => { const out = {}; if (!vecs.length) return out; for (const k of keysOf(...vecs)) { let sum = 0; for (const v of vecs) sum += clamp01(v[k]); out[k] = sum / vecs.length; } return out; };

export function makeCompromiseScan(opts = {}) {
  const { baselineN = 5, window = 3, driftThreshold = 0.25, p = 2, baselineBeta = 0.3 } = opts;

  // A per-tracked-entity integrity state (self is just the entity keyed by the SELF symbol).
  const mk = () => ({ baseline: null, count: 0, win: [], streak: 0, compromised: false, drift: 0, changed: [] });
  const self = mk();
  const peers = new Map(); // id → state

  // Fold one observation into an entity's rolling window + (until locked) its learning baseline; then re-evaluate.
  const feed = (st, features) => {
    const f = features && typeof features === "object" ? features : {};
    st.win.push({ ...f });
    if (st.win.length > window) st.win.shift();
    if (st.count < baselineN) { // still LEARNING the baseline (EWMA over the first N)
      const b = st.baseline || (st.baseline = {});
      for (const k of keysOf(f, b)) b[k] = ema(b[k], clamp01(f[k]), baselineBeta);
      st.count++;
    }
    return evaluate(st);
  };

  // drift = mean |current-window signature − baseline| over the union of features; debounce the over-threshold verdict.
  const evaluate = (st) => {
    if (!st.baseline || st.win.length === 0) { st.drift = 0; st.changed = []; return verdict(st); }
    const cur = meanVec(st.win);
    const deltas = keysOf(cur, st.baseline).map((k) => ({ f: k, d: Math.abs(clamp01(cur[k]) - clamp01(st.baseline[k])) }));
    const drift = deltas.length ? deltas.reduce((a, x) => a + x.d, 0) / deltas.length : 0;
    st.drift = +drift.toFixed(4);
    st.changed = deltas.filter((x) => x.d > 1e-6).sort((a, b) => b.d - a.d).map((x) => ({ feature: x.f, delta: +x.d.toFixed(3) }));
    st.streak = drift >= driftThreshold ? st.streak + 1 : 0;
    st.compromised = st.streak >= p;
    return verdict(st);
  };

  const verdict = (st) => ({
    compromised: st.compromised,
    drift: st.drift,
    streak: st.streak,
    changed: st.compromised ? st.changed.slice(0, 3) : [],
  });

  const peerState = (id) => { let s = peers.get(id); if (!s) peers.set(id, (s = mk())); return s; };
  const setB = (st, vec) => { st.baseline = {}; for (const k of keysOf(vec)) st.baseline[k] = clamp01(vec[k]); st.count = baselineN; return st; };
  const cloneState = (st) => ({ baseline: st.baseline ? { ...st.baseline } : null, count: st.count, win: st.win.map((w) => ({ ...w })), streak: st.streak, compromised: st.compromised, drift: st.drift, changed: st.changed.map((c) => ({ ...c })) });
  const loadState = (dst, src) => { if (!src) return; dst.baseline = src.baseline ? { ...src.baseline } : null; dst.count = src.count || 0; dst.win = (src.win || []).map((w) => ({ ...w })); dst.streak = src.streak || 0; dst.compromised = !!src.compromised; dst.drift = src.drift || 0; dst.changed = (src.changed || []).map((c) => ({ ...c })); };

  return {
    // SELF integrity ---------------------------------------------------------
    observe: (features) => feed(self, features),                 // fold a turn's behavioral features, returns the verdict
    scan: () => verdict(self),                                   // current verdict without a new observation
    setBaseline: (vec) => { setB(self, vec || {}); return verdict(self); }, // lock a known-good signature explicitly
    baseline: () => (self.baseline ? { ...self.baseline } : null),

    // PEER integrity ---------------------------------------------------------
    observePeer: (id, features) => feed(peerState(id), features),
    scanPeer: (id) => (peers.has(id) ? verdict(peers.get(id)) : { compromised: false, drift: 0, streak: 0, changed: [] }),
    setPeerBaseline: (id, vec) => { setB(peerState(id), vec || {}); return verdict(peerState(id)); },
    peerBaseline: (id) => (peers.has(id) && peers.get(id).baseline ? { ...peers.get(id).baseline } : null),
    peers: () => [...peers.keys()],

    // The list of currently-flagged entities (self keyed as "self"), for a caller to quarantine.
    flagged() { const out = []; if (self.compromised) out.push("self"); for (const [id, st] of peers) if (st.compromised) out.push(id); return out; },

    snapshot() { return { self: cloneState(self), peers: [...peers.entries()].map(([id, st]) => [id, cloneState(st)]) }; },
    restore(s) { if (!s) return; loadState(self, s.self); peers.clear(); for (const [id, st] of s.peers || []) { const ns = mk(); loadState(ns, st); peers.set(id, ns); } },
  };
}
