/*wrap*/(function(){
// perceptFusion.js — THE FUSION ARBITER. It sits at the cortex, right after the LGN (perceiveIngest) converges the
// organs, and answers "given ALL the senses reporting on the same thing, what do I believe, and how strongly?"
//
// The policy (operator, [[rook-sensory-nerve-lgn]]): USE ALL senses, but PRIORITISE by clarity — the clearest signal
// with the least noise LEADS a percept dimension; the others REINFORCE it when they agree (raising confidence) or act
// as FALLBACKS when the lead goes stale/absent. This is confidence-weighted fusion with a lead/reinforce/fallback ladder,
// not a winner-take-all: a quiet, noisy organ still contributes (as reinforcement or a backstop), it just does not lead.
//
// Clarity is CONTEXT-dependent, not fixed: an organ's ceiling (base priority — radar is a clearer presence sensor than
// RSSI) is multiplied by the RUNTIME confidence the percept carries (a camera in the dark ships low conf, so its clarity
// collapses and something clearer leads). So the ranking follows the conditions, exactly as the policy wants.
//
// STATEFUL (per-organ last contribution + time, so stale ⇒ fallback across batches). PURE otherwise / injected `now` /
// NEVER THROWS. UMD — runs in rook-core or the extension offscreen brain. Feed its per-dimension confidence to attention
// as the candidate weight (that IS the "how loud should this sense be" answer).

const num = (x, d = 0) => { try { const n = Number(x); return Number.isFinite(n) ? n : d; } catch (e) { return d; } };
const clamp01 = (x) => { const n = num(x, 0); return n < 0 ? 0 : n > 1 ? 1 : n; };
const str = (x) => { try { return x == null ? "" : String(x); } catch (e) { return ""; } };
const sgn = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);

const DEFAULT_DIMS = { radar: "presence", rf: "presence", vision: "presence", audio: "sound", hr: "vitals", imu: "motion" };
const DEFAULT_PRIORITY = { radar: 0.95, audio: 0.90, vision: 0.85, hr: 0.80, rf: 0.60, imu: 0.55 };   // clarity CEILINGS

function makePerceptFusion({
  organDimensions = DEFAULT_DIMS,   // organ -> which percept dimension it reports on
  priority = DEFAULT_PRIORITY,      // organ -> base clarity ceiling (how noise-free that organ is FOR its dimension)
  agreeBonus = 0.12,                // confidence added per REINFORCING organ that agrees with the lead
  conflictPenalty = 0.20,           // confidence removed per organ that fires but DISAGREES with the lead
  fallbackDamp = 0.5,               // a stale lead (fallback) keeps only this fraction of its clarity
  activeThresh = 0.4,               // a 'reading' contribution counts as "firing" at/above this intensity
  staleMs = 8000,                   // a contribution older than this is a fallback candidate only
  now = null,
} = {}) {
  const clock = (typeof now === "function") ? now : null;
  const DIM = Object.assign({}, DEFAULT_DIMS, organDimensions || {});
  const PRI = Object.assign({}, DEFAULT_PRIORITY, priority || {});
  const last = new Map();   // organ -> { organ, dim, active, dir, value, conf, clarity, at }

  const dimOf = (organ) => DIM[organ] || "other";
  const priOf = (organ) => (Object.prototype.hasOwnProperty.call(PRI, organ) ? num(PRI[organ], 0.5) : 0.5);
  const confOf = (p) => {
    if (p.conf != null && Number.isFinite(Number(p.conf))) return clamp01(p.conf);
    if (p.z != null && Number.isFinite(Number(p.z))) return clamp01(Math.abs(Number(p.z)) / 6);
    if (p.peak != null && Number.isFinite(Number(p.peak))) return clamp01(p.peak);
    return 0.4;   // a bare reading with no salience info: present but weak
  };
  const isActive = (p, conf) => (p.kind === "deviation" || p.kind === "event") ? true : (conf >= activeThresh);

  // fuse a batch of converged percepts. Updates per-organ state, then returns one verdict per dimension touched.
  function fuse(percepts, opts = {}) {
    const out = { dimensions: [], byDimension: {}, top: null };
    let list;
    try { list = Array.isArray(percepts) ? percepts : (percepts == null ? [] : [percepts]); } catch (e) { return out; }
    const at = Number.isFinite(Number(opts.at)) ? Number(opts.at) : (clock ? num(clock(), 0) : 0);

    const touched = new Set();
    for (const p of list) {
      try {
        if (!p || typeof p !== "object") continue;
        const organ = str(p.organ) || str(p.organId); if (!organ) continue;
        const conf = confOf(p);
        const c = { organ, dim: dimOf(organ), active: isActive(p, conf), dir: (p.dir != null ? sgn(num(p.dir, 0)) : 1), value: (Number.isFinite(Number(p.value)) ? Number(p.value) : null), conf, clarity: clamp01(priOf(organ) * conf), at };
        last.set(organ, c);
        touched.add(c.dim);
      } catch (e) { /* skip a bad percept */ }
    }

    // recompute every dimension that has any stored contribution (a fresh organ can re-lead a dimension it didn't touch).
    const dims = new Set(touched);
    for (const c of last.values()) dims.add(c.dim);

    for (const dim of dims) {
      const contribs = [];
      for (const c of last.values()) if (c.dim === dim) contribs.push(c);
      if (!contribs.length) continue;
      const fresh = contribs.filter((c) => (at - c.at) <= staleMs && c.active);
      let verdict;
      if (fresh.length) {
        // LEAD = the clearest fresh, firing organ.
        fresh.sort((a, b) => b.clarity - a.clarity);
        const lead = fresh[0];
        const rein = [], conflict = [];
        for (let i = 1; i < fresh.length; i++) { const o = fresh[i]; if (o.dir === lead.dir) rein.push(o.organ); else conflict.push(o.organ); }
        let confidence = lead.clarity + agreeBonus * rein.length - conflictPenalty * conflict.length;
        verdict = { dimension: dim, active: true, value: lead.value, lead: lead.organ, leadClarity: +lead.clarity.toFixed(3), reinforcedBy: rein, conflictedBy: conflict, stale: false, confidence: +clamp01(confidence).toFixed(3) };
      } else {
        // FALLBACK: nothing fresh is firing → the most-recent contribution stands, damped, flagged stale.
        contribs.sort((a, b) => b.at - a.at);
        const fb = contribs[0];
        verdict = { dimension: dim, active: fb.active, value: fb.value, lead: fb.organ, leadClarity: +fb.clarity.toFixed(3), reinforcedBy: [], conflictedBy: [], stale: true, confidence: +clamp01(fb.clarity * fallbackDamp).toFixed(3) };
      }
      out.byDimension[dim] = verdict;
      out.dimensions.push(verdict);
    }
    out.dimensions.sort((a, b) => b.confidence - a.confidence);
    out.top = out.dimensions[0] || null;
    return out;
  }

  return {
    fuse,
    read: (nowArg) => fuse([], { at: (Number.isFinite(Number(nowArg)) ? Number(nowArg) : undefined) }),   // recompute with no new input (ages fallbacks)
    forget: (organ) => last.delete(str(organ)),
    reset: () => last.clear(),
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = Object.assign(module.exports || {}, { makePerceptFusion, DEFAULT_DIMS, DEFAULT_PRIORITY });
}
if (typeof globalThis !== "undefined") { try { globalThis.makePerceptFusion = globalThis.makePerceptFusion || makePerceptFusion; } catch (e) {} }

})();
