// affectContagion.js — she CATCHES the room's mood. The other's inferred affect (theoryOfMind's {valence,arousal,stance})
// nudges HER OWN neurochemistry ([[neuromodulation]]) — a warm, glad person warms her; a cold or hostile one puts her on
// edge; shared excitement is catching. Feed-forward into the SAME chems that drive her face + tone, so the coupling is
// real, not cosmetic: talk to her warmly and she genuinely warms. `susceptibility` scales how porous she is (empathy dial).
//
// PURE: mutates the injected chems via .burst(); no clock/random. Bursts are SMALL — contagion is a pull, not a takeover;
// her own state + events still dominate the moment.

const clampSigned = (x) => Math.max(-1, Math.min(1, Number(x) || 0));
const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0));
const pos = (x) => Math.max(0, x);

export function makeAffectContagion({ susceptibility = 0.5 } = {}) {
  let k = clamp01(susceptibility);
  // catchMood(chems, tom) — fold the other's read into her chemistry. tom: {valence, arousal, stance?}.
  function catchMood(chems, tom = {}) {
    if (!chems || typeof chems.burst !== "function") return null;
    const v = clampSigned(tom.valence), s = clampSigned(tom.stance != null ? tom.stance : tom.valence), a = clampSigned(tom.arousal);
    // warmth CATCHES: their gladness/warmth toward her → her reward + warmth.
    if (v > 0 || s > 0) { chems.burst("dopamine", 0.22 * k * pos(v) + 0.12 * k * pos(s)); chems.burst("serotonin", 0.2 * k * pos(s)); }
    // coldness/hostility CATCHES: their sourness/cold stance → her alarm, a dip in warmth.
    if (v < 0 || s < 0) { chems.burst("norepinephrine", 0.25 * k * (pos(-v) + pos(-s))); chems.burst("serotonin", -0.12 * k * pos(-s)); }
    // shared AROUSAL: excitement/agitation is catching either way.
    if (a > 0) chems.burst("norepinephrine", 0.1 * k * a);
    return { caught: { valence: v, stance: s, arousal: a }, susceptibility: k };
  }
  return {
    catchMood,
    susceptibility: () => k,
    setSusceptibility: (x) => { k = clamp01(x); return k; },
  };
}
