// Map a personality description -> system prompt + four chemical setpoints + reactivity (offline,
// deterministic heuristics). The description is scored on a set of bipolar TRAIT AXES; each axis
// shifts specific chemicals. Evidence is graded: a single cue word applies the axis once, richer
// descriptions and intensity adverbs ("very", "slightly") scale it up to MAX_SCALE. Manual overrides
// merge last. setpoints clamp to [0,1]; reactivity to [0,3].
//
// Chemical meanings: dopamine = drive/reward/engagement; norepinephrine = arousal/vigilance/anxiety
// (and reactivity = how sharply mood swings); serotonin = calm/patience/warmth/stability;
// acetylcholine = attention/focus/precision.
import { clamp } from "./math.js";
import { tokenize } from "./text.js";
import { DEFAULT_SETPOINTS } from "./neuromodulation.js";

const SETPOINT_DEFAULTS = { ...DEFAULT_SETPOINTS };
const REACTIVITY_DEFAULTS = { dopamine: 1.0, norepinephrine: 1.0, serotonin: 1.0, acetylcholine: 1.0 };
const MAX_SCALE = 1.5; // one cue word = 1x; multiple words / intensifiers push up to this

const clampSet = clamp;
const clampReact = (x) => clamp(x, 0, 3);

const INTENSIFIERS = {
  slightly: 0.5, somewhat: 0.5, mildly: 0.5, faintly: 0.5,
  fairly: 1.1, quite: 1.2, rather: 1.2, really: 1.3, super: 1.4, overly: 1.4,
  very: 1.5, deeply: 1.5, incredibly: 1.6, intensely: 1.6, profoundly: 1.6, extremely: 1.7,
};

// Each cue word belongs to exactly one axis (no overlaps), so evidence is counted once.
const AXES = [
  { name: "warmth",     words: ["warm", "kind", "gentle", "caring", "affectionate", "compassionate", "friendly", "loving", "tender", "nurturing"],
    set: { serotonin: +0.15 } },
  { name: "calm",       words: ["calm", "relaxed", "serene", "easygoing", "mellow", "content", "patient", "placid", "tranquil", "chill", "unflappable"],
    set: { serotonin: +0.15, norepinephrine: -0.12 } },
  { name: "energy",     words: ["energetic", "lively", "playful", "enthusiastic", "spirited", "bubbly", "cheerful", "upbeat", "vivacious", "exuberant"],
    set: { dopamine: +0.18, norepinephrine: +0.05 } },
  { name: "curiosity",  words: ["curious", "inquisitive", "driven", "ambitious", "motivated", "exploratory", "eager", "interested", "keen"],
    set: { dopamine: +0.20, acetylcholine: +0.08 } },
  { name: "anxiety",    words: ["anxious", "nervous", "tense", "wary", "jumpy", "jittery", "uneasy", "fearful", "worried", "apprehensive", "alert", "skittish"],
    set: { norepinephrine: +0.18, serotonin: -0.08 }, react: { norepinephrine: +0.6 } },
  { name: "focus",      words: ["focused", "attentive", "sharp", "precise", "careful", "meticulous", "diligent", "thorough", "observant", "methodical"],
    set: { acetylcholine: +0.22 } },
  { name: "confidence", words: ["confident", "secure", "steady", "grounded", "resilient", "stoic", "assured", "bold", "unshakable"],
    set: { serotonin: +0.12, norepinephrine: -0.05 } },
  { name: "shy",        words: ["shy", "timid", "reserved", "hesitant", "withdrawn", "bashful", "meek", "retiring"],
    set: { norepinephrine: +0.10, dopamine: -0.08 } },
  { name: "impulsive",  words: ["impulsive", "excitable", "reactive", "volatile", "spontaneous", "restless", "erratic", "mercurial"],
    set: { dopamine: +0.10 }, react: { dopamine: +0.5, norepinephrine: +0.5 } },
  { name: "melancholy", words: ["melancholy", "gloomy", "sad", "depressed", "weary", "listless", "downcast", "morose", "glum", "despondent"],
    set: { serotonin: -0.15, dopamine: -0.10 } },
  { name: "irritable",  words: ["irritable", "grumpy", "snappy", "prickly", "cranky", "testy", "brusque", "curt"],
    set: { norepinephrine: +0.12, serotonin: -0.12 }, react: { norepinephrine: +0.4 } },
  { name: "scattered",  words: ["scattered", "distracted", "absentminded", "forgetful", "dreamy", "unfocused", "flighty"],
    set: { acetylcholine: -0.18 } },
];

const WORD_AXIS = new Map();
AXES.forEach((ax, i) => ax.words.forEach((w) => WORD_AXIS.set(w, i)));

export function describePersona(text = "", overrides = {}) {
  const setpoints = { ...SETPOINT_DEFAULTS };
  const reactivity = { ...REACTIVITY_DEFAULTS };

  // Score each axis: sum cue-word hits, scaling each by a preceding intensity adverb if present.
  const toks = tokenize(text);
  const evidence = new Array(AXES.length).fill(0);
  for (let i = 0; i < toks.length; i++) {
    const ai = WORD_AXIS.get(toks[i]);
    if (ai === undefined) continue;
    evidence[ai] += (i > 0 && INTENSIFIERS[toks[i - 1]]) || 1;
  }

  const traits = {};
  AXES.forEach((ax, i) => {
    if (evidence[i] <= 0) return;
    const scale = Math.min(MAX_SCALE, evidence[i]);
    traits[ax.name] = +scale.toFixed(3);
    for (const k in (ax.set || {})) setpoints[k] += ax.set[k] * scale;
    for (const k in (ax.react || {})) reactivity[k] += ax.react[k] * scale;
  });

  for (const k in setpoints) setpoints[k] = clampSet(setpoints[k]);
  for (const k in reactivity) reactivity[k] = clampReact(reactivity[k]);

  // Manual overrides win over derived values.
  if (overrides.setpoints) for (const k in overrides.setpoints) setpoints[k] = clampSet(overrides.setpoints[k]);
  if (overrides.reactivity) for (const k in overrides.reactivity) reactivity[k] = clampReact(overrides.reactivity[k]);

  return { systemPrompt: String(text).trim(), setpoints, reactivity, traits };
}
