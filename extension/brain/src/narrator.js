import { num } from "./math.js";
// narrator.js — Expression I (the inner-life roadmap). The brain computes mood, energy, metacognition, action-stall,
// self-regulation, and felt drives on EVERY turn — and voices none of it: it has numbers, not words. This turns those
// mute signals into first-person INTERNAL language, the self-talk an always-thinking mind keeps over its own state:
// "I feel warm and a little tired," "I'm not sure I have real grounding for this," "caught between acting and holding
// back," "steadying myself." It is the VOCABULARY the externalization governor (Phase 2) will draw from to decide
// what — if anything — reaches the user. Pure + deterministic; it adds a trace field and changes no behavior.
//
// Design: feeling comes from the valence×arousal QUADRANT (not a single label), overlaid with energy; then at most two
// further clauses (stall, epistemic confidence, self-regulation, a felt need) are added by salience, so the result is
// a sentence, not a checklist.

const band = (x, hi, lo) => (x > hi ? "hi" : x < lo ? "lo" : "mid");

// Feeling word per affect quadrant. Rows = valence sign, cols = arousal level.
const FEEL = {
  pos: { hi: "bright and eager", mid: "warm and open", lo: "warm and at ease" },
  neu: { hi: "alert, a little restless", mid: "steady and present", lo: "quiet and even" },
  neg: { hi: "tense and on edge", mid: "unsettled", lo: "low and heavy" },
};
function feelingOf(valence, arousal, energy) {
  const vb = valence > 0.25 ? "pos" : valence < -0.25 ? "neg" : "neu";
  let base = FEEL[vb][band(arousal, 0.6, 0.4)];
  if (energy != null && energy < 0.32) base += ", and a little tired";
  else if (energy != null && energy > 0.8 && vb !== "neg") base += ", and full of energy";
  return base;
}

// Epistemic self-report from metacognition — only voiced at the extremes (mid certainty stays quiet).
function confidenceOf(meta) {
  if (!meta) return null;
  if (meta.confused) return "and honestly a bit confused by this";
  if (meta.known && num(meta.certainty, 0) >= 0.6) return "and sure of what I'm saying";
  if (!meta.known && num(meta.certainty, 1) < 0.4) return "though I'm not sure I have real grounding for this";
  return null;
}

const NEED = { connection: "with a pull to reach for you", rest: "and wanting to rest", stimulation: "and restless for something new", esteem: "and wanting to get this right" };
function needOf(felt) { if (!felt || num(felt.pressure, 0) < 0.5) return null; return NEED[felt.name] || null; }

function regulatingOf(reg) {
  if (!reg || !reg.applied) return null;
  if (reg.calmed > 0 && reg.soothed > 0) return "steadying myself";
  if (reg.calmed > 0) return "talking myself down a little";
  if (reg.soothed > 0) return "lifting my own mood";
  return "steadying myself";
}

// Turn the turn's signals into an inner-state reading. state: { mood:{valence,arousal}, energy, metacognition,
// regulation, council:{stalled}, felt:{name,pressure} }. Returns the structured reading + a composed first-person line.
export function narrate(state = {}) {
  const mood = state.mood || {};
  const feeling = feelingOf(num(mood.valence, 0), num(mood.arousal, 0.4), state.energy);
  const confidence = confidenceOf(state.metacognition);
  const need = needOf(state.felt || (state.drives && state.drives.felt));
  const regulating = regulatingOf(state.regulation);
  const stalled = !!(state.council && state.council.stalled);

  // feeling always; then up to two more clauses, by salience. A strong SOMATIC state (sore/repulsed/worn) speaks loudly,
  // so it leads the extras.
  const extras = [];
  if (state.soma) extras.push(state.soma);
  if (stalled) extras.push("caught between acting and holding back");
  if (confidence) extras.push(confidence);
  if (regulating) extras.push(regulating);
  if (need) extras.push(need);
  const chosen = extras.slice(0, 2);

  let line = `I feel ${feeling}`;
  for (const e of chosen) line += /^(and|though|with)\b/.test(e) ? ` ${e}` : `, ${e}`;
  line += ".";

  return { feeling, confidence, need, regulating, stalled, line };
}
