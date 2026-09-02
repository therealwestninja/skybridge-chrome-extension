import { num } from "./math.js";
import { norm } from "./text.js";
// innerVoice.js — the brain's spontaneous inner MONOLOGUE, finally given a channel to the user. Every other output is
// a reply (the user spoke) or a rare reach-out (proactivity). This is the third voice: the OVERFLOW of an always-
// thinking mind — the tangent it can't help mentioning, the goal that resurfaces, the echo of an old turn, last
// night's dream, the scenario it just ran in its head — surfaced as an ASIDE, in the right conversational register.
//
// The raw cognition already exists elsewhere in the brain (associative recall, volition's standing goals,
// imagination's snapshot→simulate→restore counterfactuals, the distiller's dream-consolidation). This faculty does the
// one thing that was missing: it watches that material, decides WHEN a thought genuinely wants out and of what TYPE,
// and hands the mouth a seed + a frame. It is GATED like proactivity (a threshold + a cooldown, weighted by arousal)
// so an inner life becomes an occasional, welcome aside — never chatter. The DECISION lives here; the WORDS come from
// the mouth (or a plain template offline). Because imagination is snapshot/restore-safe and the clock can frame-jack
// when idle, these thoughts can be generated ASYNC between turns — the brain offering what it out-thought.

// Each thought TYPE carries its natural opener + a base salience (how readily that kind of thought interrupts).
const FRAMES = {
  remind:   { open: "That reminds me", weight: 1.00 }, // a tangential memory that floated up
  ponder:   { open: "I was thinking about", weight: 0.92 }, // a standing goal resurfacing (volition)
  echo:     { open: "Like the time", weight: 0.85 }, // an episodic callback tied to the topic
  dream:    { open: "I had a dream about", weight: 0.80 }, // a consolidation/distiller product
  scenario: { open: "I ran the scenario", weight: 0.92 }, // an imagination counterfactual
  wonder:   { open: "I keep wondering", weight: 0.90 }, // a grounded open question from respoolSelf — noticed, not yet understood
};

export function makeInnerVoice({ threshold = 0.52, cooldownMs = 90e3, gain = 1.0, recentDamp = 0.45, recentN = 4, frames = FRAMES } = {}) {
  let lastAt = null;
  let recent = []; // the last few surfaced seeds — so the monologue doesn't loop one thought; a just-said thing yields

  // Score the available material into candidate thoughts, gate the strongest, and (if it clears) return it to surface.
  // material: { remind?, echo? = {text, sim}, ponder? = {text, priority}, dream? = {text, freshness}, scenario? =
  // {text, action, mood}, mood?, silenceMs?, now? }. Returns {surface, type, seed, frame, pull, extra, considered}.
  function consider(material = {}) {
    const { mood = null, silenceMs = 0, now = null } = material;
    const arousal = mood && typeof mood.arousal === "number" ? mood.arousal : 0.4;
    const c = [];
    // A tangential memory pulls harder when a strongly-matching one floats up (sim) and when the brain is roused.
    if (material.remind && material.remind.text) c.push({ type: "remind", seed: material.remind.text, pull: (0.45 + 0.55 * num(material.remind.sim, 0.6)) * (0.85 + 0.3 * arousal) });
    // A standing goal resurfaces on its priority, and the longer it's been quiet the more it tugs.
    if (material.ponder && material.ponder.text) c.push({ type: "ponder", seed: material.ponder.text, pull: 0.55 + 0.3 * num(material.ponder.priority, 0.5) + 0.25 * Math.min(1, silenceMs / (30 * 60e3)) });
    // A topical episodic callback tracks how well it matches what's being discussed.
    if (material.echo && material.echo.text) c.push({ type: "echo", seed: material.echo.text, pull: 0.4 + 0.55 * num(material.echo.sim, 0.6) });
    // A fresh dream wants telling; it fades with freshness.
    if (material.dream && material.dream.text) c.push({ type: "dream", seed: material.dream.text, pull: 0.72 * num(material.dream.freshness, 1) });
    // A grounded open question the brain hasn't resolved keeps tugging — the fresher, the more it wants voicing.
    if (material.wonder && material.wonder.text) c.push({ type: "wonder", seed: material.wonder.text, pull: 0.5 + 0.4 * num(material.wonder.freshness, 1) });
    // A scenario it just ran is always offerable on a real topic; a roused mind offers it more readily.
    if (material.scenario && material.scenario.text) c.push({ type: "scenario", seed: material.scenario.text, pull: 0.6 + 0.3 * arousal, extra: material.scenario });
    if (!c.length) return { surface: false };
    // weight by type salience, then DAMP anything just said — a mind that already voiced a thought moves on to another.
    for (const x of c) { const said = recent.includes(norm(x.seed)); x.pull = +(x.pull * frames[x.type].weight * gain * (said ? recentDamp : 1)).toFixed(3); }
    c.sort((a, b) => b.pull - a.pull || a.type.localeCompare(b.type));
    const top = c[0];
    const sinceLast = now != null && lastAt != null ? now - lastAt : Infinity;
    const surface = top.pull >= threshold && sinceLast >= cooldownMs;
    return { surface, type: top.type, seed: top.seed, frame: frames[top.type].open, pull: top.pull, extra: top.extra || null, considered: c.map((x) => ({ type: x.type, pull: x.pull })) };
  }

  function noteSurfaced(now, seed = null) { if (now != null) lastAt = now; if (seed) { recent.push(norm(seed)); if (recent.length > recentN) recent.shift(); } }

  // Plain-template rendering for when there's no mouth (offline). The live mouth phrases it far more naturally.
  const ACT = { REFLEX_REPLY: "just answer", RESPOND: "respond", ESCALATE: "dig into it", HOLD: "hold back", QUIET: "stay quiet", WAIT: "wait", ACT: "go for it", REACH_OUT: "reach out" };
  function render(dec) {
    if (!dec || !dec.surface) return "";
    if (dec.type === "scenario" && dec.extra && dec.extra.action) { const a = ACT[dec.extra.action] || String(dec.extra.action).toLowerCase().replace(/_/g, " "); return `${dec.frame} where ${dec.seed} — I think I'd ${a}.`; }
    return `${dec.frame} ${dec.seed}.`;
  }

  return { consider, noteSurfaced, render, lastAt: () => lastAt, snapshot: () => ({ lastAt, recent: recent.slice() }), restore: (s) => { if (s) { lastAt = s.lastAt ?? null; recent = Array.isArray(s.recent) ? s.recent.slice() : []; } } };
}
