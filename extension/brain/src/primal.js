import { clamp } from "./math.js";
import { STOP_WORDS as STOP } from "./text.js";
// primal.js — Phase 6: the "reptilian" fast-path — the amygdala this prefrontal brain was missing. Every other route
// here DELIBERATES (features → substrate → council → mouth); this is the subcortical arc that fires BEFORE the council
// when a threat signature crosses a line, committing an autonomic PROGRAM with a norepinephrine surge and skipping the
// slow, expensive loop entirely. Four programs by signature:
//   • freeze  — overwhelming threat: go still, hypervigilant (HOLD).
//   • fight   — high threat while roused: confront, hold the line (ESCALATE).
//   • flight  — high threat while not roused: pull back / disengage (HOLD).
//   • startle — a sudden, novel, intense stimulus: orient fast (a quick RESPOND).
// And it LEARNS fear: a context that proved threatening is remembered (a token fingerprint), so a WEAKER version of it
// trips the alarm faster next time (fear conditioning). Persisted, so a learned fear survives a reload.

const PROGRAM_ACTION = { freeze: "HOLD", flight: "HOLD", fight: "ESCALATE", startle: "RESPOND" };
// Shared stop set — common short words that would pollute a fear fingerprint (meaningful cues like dog/gun/war still count).
const contentTokens = (tokens) => (tokens || []).filter((t) => t && t.length >= 3 && !STOP.has(t));

export function makePrimal({ threshold = 0.55, freezeAt = 1.0, fightArousal = 0.6, startleNovelty = 0.72, learnStrength = 0.4, reinforce = 0.2, decayRate = 0.985, cap = 24 } = {}) {
  let fears = []; // { tokens: string[], strength }

  // How much a learned fear amplifies THIS context's threat (max overlap-weighted strength across remembered fears).
  function primedBoost(tokens) {
    if (!tokens || !tokens.length) return 0;
    const set = new Set(tokens); let best = 0;
    for (const f of fears) {
      const overlap = f.tokens.reduce((c, t) => c + (set.has(t) ? 1 : 0), 0);
      if (!overlap) continue;
      best = Math.max(best, f.strength * Math.min(1, overlap * 0.5)); // one shared cue → half strength, two+ → full
    }
    return +best.toFixed(3);
  }

  // Does this signature trip the alarm? Returns the chosen program (+ effective intensity, and whether a learned fear
  // contributed), or null if it stays sub-threshold. `tokens` are the context's content words (for conditioning).
  function assess({ threat = 0, arousal = 0.4, novelty = 0, tokens = [] } = {}) {
    const boost = primedBoost(tokens);
    const eff = threat + boost;
    if (eff < threshold) return null;
    let program;
    if (eff >= freezeAt) program = "freeze";
    else if (arousal >= fightArousal) program = "fight";
    else if (novelty >= startleNovelty) program = "startle";
    else program = "flight";
    return { program, action: PROGRAM_ACTION[program], intensity: +clamp(eff, 0, 1.5).toFixed(3), conditioned: boost > 0.05 };
  }

  // Fear conditioning: remember this context as threatening. Reinforces an overlapping fear or lays a new one.
  function condition(tokens) {
    const set = [...new Set(contentTokens(tokens))].slice(0, 8);
    if (!set.length) return;
    for (const f of fears) {
      const overlap = f.tokens.reduce((c, t) => c + (set.includes(t) ? 1 : 0), 0);
      if (overlap >= Math.min(2, f.tokens.length)) { f.strength = clamp(f.strength + reinforce, 0, 1); return; }
    }
    fears.push({ tokens: set, strength: learnStrength });
    if (fears.length > cap) fears.shift();
  }

  // Learned fears fade slowly if not reinforced (extinction).
  function decay() { for (const f of fears) f.strength = +(f.strength * decayRate).toFixed(4); fears = fears.filter((f) => f.strength >= 0.05); }

  return {
    assess, condition, decay, primedBoost,
    fears: () => fears.map((f) => ({ ...f, tokens: f.tokens.slice() })),
    snapshot: () => ({ fears: fears.map((f) => ({ tokens: f.tokens.slice(), strength: f.strength })) }),
    restore: (s) => { if (s && Array.isArray(s.fears)) fears = s.fears.map((f) => ({ tokens: (f.tokens || []).slice(), strength: f.strength || 0 })); },
  };
}
