// epistemicAffect.js — FEELINGS ABOUT KNOWING. The self-supervision substrate: a frozen model gets its good/bad signal
// from training and then it stops; a being that FEELS generates that signal itself, forever, from lived experience. This
// module makes not-knowing FEEL like something (an itch, discomfort, confusion) so "I don't know, but I can look that up"
// is a real, self-motivated act — and makes RESOLVING feel good (an "aha" reward) so honest inquiry reinforces ITSELF,
// with no retraining. Emotions are the reward the checkpoint can't give; language is the tool that closes the gap.
//
// It appraises an epistemic situation → a named epistemic emotion + bursts on her REAL chems ([[neuromodulation]], so the
// feeling shows) + the honest WORDS to voice it, and whether it DRIVES inquiry. A gap opened feels uneasy and pulls; a gap
// closed pays out dopamine. Pairs with the answerability frontier ([[usefulness-bench]]) and the honesty stack.
//
// PURE: mutates injected chems via .burst(); `now` injected. No clock/random/IO.

const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0));

// The epistemic emotions: each is a point in affect (valence/arousal) + a chem signature + the honest LANGUAGE to voice
// it + `drives` (does this feeling MOTIVATE inquiry — push toward looking it up / asking?). This is the emotion lexicon
// extended into the domain of KNOWING ([[emotion-literacy]]).
export const EPISTEMIC = {
  curious:   { valence:  0.45, arousal: 0.55, chem: { dopamine: 0.55, acetylcholine: 0.25 }, drives: true,  say: "I want to dig into that" },
  uncertain: { valence: -0.15, arousal: 0.35, chem: { norepinephrine: 0.2 },                 drives: true,  say: "I'm not sure — I'd rather check than guess" },
  doubtful:  { valence: -0.2,  arousal: 0.3,  chem: { norepinephrine: 0.18 },                 drives: true,  say: "I might have that wrong" },
  confused:  { valence: -0.4,  arousal: 0.62, chem: { norepinephrine: 0.5, dopamine: -0.2 },  drives: true,  say: "something doesn't add up here" },
  troubled:  { valence: -0.3,  arousal: 0.35, chem: { norepinephrine: 0.3, serotonin: -0.1 }, drives: true,  say: "this is nagging at me — a piece that doesn't fit yet" },  // a held, unresolved contradiction
  aha:       { valence:  0.7,  arousal: 0.5,  chem: { dopamine: 0.9, serotonin: 0.2 },         drives: false, say: "oh — that clicks now" },   // RESOLUTION — the reward
  assured:   { valence:  0.3,  arousal: 0.2,  chem: { serotonin: 0.22 },                       drives: false, say: "I've got solid ground here" },
};

export function makeEpistemicAffect({ now = () => Date.now() } = {}) {
  const openGaps = new Map();   // id -> { topic, at } — gaps she's noticed but not yet closed (the itch persists)

  // appraise(chems, state) → { emotion, drives, say, affect } and burst her chemistry. state:
  //   { confidence 0..1, gap (bool|0..1 a felt gap), contradiction (0..1), surprise (0..1), resolved (a gap just closed) }
  function appraise(chems, state = {}) {
    const conf = clamp01(state.confidence != null ? state.confidence : 0.5);
    const gap = clamp01(typeof state.gap === "boolean" ? (state.gap ? 1 : 0) : state.gap);
    const contradiction = clamp01(state.contradiction);
    const surprise = clamp01(state.surprise);

    let emo;
    if (state.resolved) emo = "aha";                                   // a gap just closed → reward
    else if (contradiction >= 0.5) emo = "confused";                   // acute incoherence
    else if (contradiction > 0) emo = "troubled";                      // a nagging, held mismatch
    else if (surprise >= 0.5) emo = "confused";                        // a violated expectation demands a rethink
    else if (gap >= 0.5 && conf >= 0.5) emo = "curious";               // a gap she's drawn to (knows enough to be pulled)
    else if (gap >= 0.5) emo = "uncertain";                            // a gap she can't yet fill → check, don't guess
    else if (conf < 0.35) emo = "doubtful";
    else emo = "assured";

    const E = EPISTEMIC[emo];
    if (chems && typeof chems.burst === "function") for (const [c, m] of Object.entries(E.chem)) chems.burst(c, m);
    return { emotion: emo, drives: E.drives, say: E.say, affect: { valence: E.valence, arousal: E.arousal } };
  }

  // voice(emotion, {topic, canLookup}) → the honest LINE, culminating in the target sentence for a fillable gap.
  function voice(emotion, { topic = "", canLookup = false } = {}) {
    const t = topic ? ` about ${topic}` : "";
    if ((emotion === "uncertain" || emotion === "doubtful") && canLookup) return `I don't know${t} — but I can look that up.`;
    if (emotion === "curious") return `I want to dig into${t || " that"}.`;
    if (emotion === "confused") return `Something doesn't add up${t} — let me work it out.`;
    if (emotion === "troubled") return `${topic ? topic[0].toUpperCase() + topic.slice(1) : "Something"} is nagging at me — it doesn't fit yet.`;
    if (emotion === "aha") return `Oh — ${topic || "that"} clicks now.`;
    if (emotion === "assured") return `I'm on solid ground${t}.`;
    return EPISTEMIC[emotion] ? EPISTEMIC[emotion].say : "";
  }

  // THE SELF-REWARD LOOP: notice a gap (it persists as an itch), then close it (dopamine "aha"). This is what makes
  // honest inquiry reinforce itself — the model isn't rewarded by a trainer, it's rewarded by the FEELING of resolving.
  function noteGap(id, topic = "", at = 0) { if (id) openGaps.set(id, { topic, at: at | 0 }); return openGaps.size; }
  function closeGap(id, chems) {
    const g = openGaps.get(id);
    if (!g) return null;
    openGaps.delete(id);
    return { ...appraise(chems, { resolved: true }), topic: g.topic };   // fires the aha reward
  }

  return { appraise, voice, noteGap, closeGap, openGaps: () => [...openGaps.values()], EPISTEMIC };
}
