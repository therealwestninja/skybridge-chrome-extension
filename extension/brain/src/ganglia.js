// ganglia.js — the BUILT-IN SKILL-GANGLIA library: real, loadable capability packages that ship pre-baked in the catalog
// (dormant) and prove the skills.js pipeline on genuine capabilities — load → provisional → self-test → validated (its
// capability advertised into the beacon). Each is a north-star find from the skill-ganglia mine, packaged as a skill:
//   • progress-sense  (F1 ProgressSense)      — metacognition: "am I making progress?"  → grants "progress_sense"
//   • notice-unknown  (B2 Notice-the-Unknown) — active perception / curiosity          → grants "notice_unknown"
//   • habituation     (F3 dynamical habituation) — no-memory novelty detector           → grants "habituation"
//
// All are pure/deterministic/dependency-free, self-contained (install returns an api; no core reach), and carry a
// LOAD-BEARING selfTest that actually exercises the capability — so a broken one stays `failed` and never advertises.
// They are author-trusted (provenance defaults to "pre-baked" → the fast path, no quarantine). Registered pre-baked by
// app.js but INERT until `app.skills.learn(name)` is called (a pre-baked-but-unloaded skill advertises nothing).

// F1 · PROGRESS-SENSE — "am I making progress?" by the RANK correlation of a series of error/distance readings vs time.
// Rank (Spearman) not linear so it's robust to scale + non-linear improvement. Negative rho (error falling over time) =
// progressing; near-zero = stalled; positive = getting worse. Feeds a stall-detector / fatigue-gated intent switch.
export const progressSense = {
  name: "progress-sense",
  description: "Metacognition: rank-correlation of error/distance-to-goal readings vs time → progressing | stalled | regressing.",
  grants: ["progress_sense"],
  plugsInto: "metacognition",
  install() {
    const series = [];
    // Average-rank (ties share the mean rank → zero variance for a flat series → rho 0 = stalled, not a false signal).
    const rank = (arr) => {
      const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
      const r = new Array(arr.length);
      let i = 0;
      while (i < idx.length) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; const avg = (i + j) / 2; for (let k = i; k <= j; k++) r[idx[k][1]] = avg; i = j + 1; }
      return r;
    };
    const rho = (xs) => {
      const n = xs.length; if (n < 3) return 0;
      const rt = rank(xs.map((_, i) => i)), rx = rank(xs);
      const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
      const mt = mean(rt), mx = mean(rx);
      let num = 0, dt = 0, dx = 0;
      for (let i = 0; i < n; i++) { const a = rt[i] - mt, b = rx[i] - mx; num += a * b; dt += a * a; dx += b * b; }
      return (dt && dx) ? +(num / Math.sqrt(dt * dx)).toFixed(3) : 0;
    };
    return {
      observe(value) { series.push(+value); if (series.length > 50) series.shift(); return series.length; },
      progressing({ eps = 0.25 } = {}) {
        const r = rho(series);
        const verdict = r <= -eps ? "progressing" : r >= eps ? "regressing" : "stalled";
        return { rho: r, verdict, progressing: verdict === "progressing", n: series.length };
      },
      reset() { series.length = 0; },
    };
  },
  selfTest({ api }) {
    api.reset();
    for (const v of [10, 9, 8, 7, 6, 5, 4]) api.observe(v);   // error falling monotonically → should read progressing
    const good = api.progressing().verdict === "progressing";
    api.reset();
    for (const v of [5, 5, 5, 5, 5, 5]) api.observe(v);       // flat → should read stalled (NOT a false positive)
    const stalled = api.progressing().verdict === "stalled";
    api.reset();
    return good && stalled;
  },
};

// B2 · NOTICE-THE-UNKNOWN — scan percepts and surface the UNLABELED / low-confidence / never-before-seen ones as OPEN
// QUESTIONS, instead of silently dropping what the labeller can't name. Turns a perception gap into curiosity.
export const noticeUnknown = {
  name: "notice-unknown",
  description: "Active perception / curiosity: flag unlabeled, low-confidence, or novel percepts as open questions (what is this?).",
  grants: ["notice_unknown"],
  plugsInto: "perception",
  install() {
    const known = new Set();
    return {
      seen(label) { if (label) known.add(String(label).toLowerCase()); },
      scan(percepts = [], { minConf = 0.5 } = {}) {
        const out = [];
        for (const p of percepts) {
          const label = p && p.label != null ? String(p.label).toLowerCase() : null;
          const conf = p && typeof p.confidence === "number" ? p.confidence : 1;
          if (!label) out.push({ ...p, reason: "unlabeled", question: "what is this?" });
          else if (conf < minConf) out.push({ ...p, reason: "low-confidence", question: `is that really a ${label}?` });
          else if (!known.has(label)) out.push({ ...p, reason: "novel", question: `what is a ${label}?` });
        }
        return out;
      },
      forget() { known.clear(); },
    };
  },
  selfTest({ api }) {
    api.forget(); api.seen("chair");
    const uns = api.scan([{ label: "chair", confidence: 0.9 }, { label: null }, { label: "gizmo", confidence: 0.9 }]);
    const reasons = uns.map((u) => u.reason).sort();
    // the KNOWN chair is not flagged; the unlabeled blob AND the never-seen "gizmo" are
    return uns.length === 2 && reasons.includes("novel") && reasons.includes("unlabeled");
  },
};

// F3 · HABITUATION — a leaky-integrator novelty detector with NO episodic memory: a repeated stimulus decays the response
// (habituates); a CHANGE re-spikes it (dishabituates). Cheap attention-gating "is this new?" that costs no memory.
export const habituation = {
  name: "habituation",
  description: "Dynamical habituation: leaky-integrator novelty response — repeats decay, a change dishabituates. No memory.",
  grants: ["habituation"],
  plugsInto: "attention",
  install() {
    let adapt = 0, last = null;
    const rate = 0.5;
    return {
      sense(stimulus) {
        const s = +stimulus;
        const changed = last == null ? 1 : Math.min(1, Math.abs(s - last));
        if (changed > 0.2) adapt *= (1 - changed);            // a change drops accumulated adaptation → dishabituation
        const response = +Math.max(0, 1 - adapt).toFixed(3);  // high = novel, low = habituated
        adapt = Math.min(1, adapt + rate * (1 - adapt));      // then habituate toward the current stimulus
        last = s;
        return response;
      },
      reset() { adapt = 0; last = null; },
    };
  },
  selfTest({ api }) {
    api.reset();
    const r1 = api.sense(1), r2 = api.sense(1), r3 = api.sense(1); // repeated → response decays
    const decays = r1 > r2 && r2 > r3;
    const novel = api.sense(6);                                   // a big change → dishabituates (jumps back up)
    api.reset();
    return decays && novel > r3;
  },
};

// Batches — capabilities packaged as loadable ganglia. safety/integrity WRAP existing hardened modules (skill→ganglia
// migration); embodied are fresh north-star capabilities.
import { SAFETY_GANGLIA } from "./ganglia/safety.js";        // kill-authority, constraint-veto, beacon-silence, mesh-relay
import { INTEGRITY_GANGLIA } from "./ganglia/integrity.js";  // compromise-scan, mutual-attestation, echo-chamber-guard
import { EMBODIED_GANGLIA } from "./ganglia/embodied.js";    // body-adapter, see2act, frame-fill, fatigue-gate

// The pre-baked library app.js registers into the skill catalog (all dormant until learned).
export const BUILTIN_GANGLIA = [
  progressSense, noticeUnknown, habituation,
  ...SAFETY_GANGLIA, ...INTEGRITY_GANGLIA, ...EMBODIED_GANGLIA,
];
