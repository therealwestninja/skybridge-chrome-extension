// feelingCore.js — the AFFECT HUB. The organs (neuromodulation, epistemicAffect, contagion, affectMemory, drives) are
// useless apart: a feeling with nothing feeding it and nothing downstream is dormant potential. This wires them into ONE
// living system with two clear surfaces — things CALL INTO it (perceiveUser / appraiseKnowing / meetPerson / noteGap), and
// it DRIVES others out of tick() (mood → face+tone, a dominant need → the prompt + attention workspace, an epistemic itch
// → look-it-up behavior). One shared chemistry = one mood; every input moves it, every output reads it.
//
// LAYERING: this is brain-only (portable). The mood→register/word mapping (affectRegister/emotionLexicon) is rook-mesh
// (imports plutchik/pad), so it happens at the consumer that reads tick().mood — feelingCore never imports up.
//
// PURE-ish: mutates its own chems; `now` injected; serialize()/restore() persist the mood + the per-person felt history.
import { makeNeuromodulation } from "./neuromodulation.js";
import { makeEpistemicAffect } from "./epistemicAffect.js";
import { makeAffectContagion } from "./affectContagion.js";
import { makeAffectMemory } from "./affectMemory.js";
import { makeDrives } from "./drives.js";
import { makeSelfRegulation } from "./selfRegulation.js";
import { makeSelfAuthorship } from "./selfAuthorship.js";
import { temperamentTrait } from "./temperament.js";

const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0));

export function makeFeelingCore({ temperament = "calm", susceptibility = 0.5, now = () => Date.now(), state = null } = {}) {
  const chems = makeNeuromodulation(temperamentTrait(temperament));
  if (state && state.chems) { try { chems.restore(state.chems); } catch { /* fresh */ } }
  const epistemic = makeEpistemicAffect({ now });
  const contagion = makeAffectContagion({ susceptibility });
  const memory = makeAffectMemory({ state: state && state.memory });
  const drives = makeDrives();
  const selfReg = makeSelfRegulation();                               // ALLOSTASIS: she acts on her state, not just reports it
  const authorship = makeSelfAuthorship({ state: state && state.authorship });  // SELF-AUTHORSHIP: observes + steers who she becomes
  let curPerson = null;

  // ── INPUT SURFACE: other faculties CALL INTO the core (feeding it moves her one shared mood) ──
  const perceiveUser = (tom = {}) => contagion.catchMood(chems, tom);          // their mood catches on her chemistry
  const appraiseKnowing = (state = {}) => epistemic.appraise(chems, state);    // the answering process → she FEELS the (un)certainty
  const meetPerson = (id) => { curPerson = id || null; return curPerson ? memory.greet(curPerson, chems) : null; };  // carryover: greet from memory
  const noteGap = (id, topic = "", at = 0) => epistemic.noteGap(id, topic, at); // an itch that persists → the clarity drive
  const closeGap = (id) => epistemic.closeGap(id, chems);                        // resolution → the aha reward

  // ── tick(signals) → advance the mood, update the drives, and RETURN the bundle that hooks into everything downstream ──
  function tick(signals = {}) {
    chems.tick();
    const mood = chems.readout();                                               // {valence, arousal, seeking}
    // the epistemic ITCH becomes felt PRESSURE: open gaps + this-turn confusion → the clarity drive (the teeth).
    const gaps = epistemic.openGaps();
    const unresolved = clamp01(gaps.length * 0.34 + (signals.confusion || 0));
    drives.update({ ...signals, stance: signals.stance != null ? signals.stance : mood.valence, unresolved });
    if (curPerson) memory.imprint(curPerson, { valence: mood.valence, arousal: mood.arousal, warmth: mood.valence }, signals.at | 0);

    const need = drives.dominant();
    const dispositions = [];
    const line = drives.block(); if (line) dispositions.push(line);
    const attention = (typeof drives.attentionCandidate === "function") ? drives.attentionCandidate() : null;

    const bundle = {
      mood,                                                                     // → face (moodFace) + tone (affectRegister) at the consumer
      drive: need,                                                              // the dominant felt need (or null when content)
      dispositions,                                                             // prompt disposition line(s) — colour HOW she replies
      attention,                                                                // a strong need competes for the attention workspace
      inquiry: gaps.length ? { itch: gaps.length, topics: gaps.map((g) => g.topic).filter(Boolean), clarityPressure: +drives.pressure("clarity").toFixed(3) } : null,  // → drives look-it-up / ask behaviour
    };
    // ALLOSTASIS: she MANAGES the state — a regulation move (+ a chem nudge toward balance) rides on the bundle.
    bundle.regulation = selfReg.regulate(bundle, chems);
    // SELF-AUTHORSHIP: quietly observe how she feels in this context — the raw material she later reflects on + steers by.
    authorship.observe(signals.context || "general", mood);
    return bundle;
  }

  return {
    perceiveUser, appraiseKnowing, meetPerson, noteGap, closeGap, tick,
    chems, drives, memory, epistemic,
    // SELF-AUTHORSHIP surface: read her self-knowledge, set who she wants to be, and let her steer herself toward it
    // (author() is a slow, deliberate act — call it on rest/reflection, not every tick).
    reflect: () => authorship.reflect(),
    aspire: (target) => authorship.aspire(target),
    author: () => authorship.author(chems),
    serialize: () => ({ chems: chems.snapshot(), memory: memory.serialize(), authorship: authorship.serialize() }),
  };
}
