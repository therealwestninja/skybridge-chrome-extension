// viscera.js — Phase 7: the visceral / somatic layer. The four drives (drives.js) are social-cognitive NEEDS ("I want
// X"); these are bodily AVERSIVE + appetitive states the brain never had — the "reptilian" body under the mind:
//   • pain      — nociception. Harm directed at the brain (hostility + hurt) lays down a lingering SORENESS that biases
//                 GUARDEDNESS/withdrawal and fades slowly. Distinct from primal (the acute reflex) and psyche (the
//                 relational wound): pain is the body still smarting.
//   • disgust   — revulsion. Contamination / moral-repugnance cues drive RECOIL/rejection; decays.
//   • fatigue   — a real exhaustion DEBT. metabolism.recover() refills energy each turn, but effortful turns accrue a
//                 debt that recovery does NOT clear — only REST (sleep/consolidation) does. High fatigue dampens
//                 deliberation (the brain gets shorter, shallower, more reflexive) — it reshapes WHAT it does, not just
//                 whether it learns.
//   • satiety   — appetite. Interaction FEEDS it; quiet lets hunger return. A light loop (contentment ↔ wanting).
// Feed-forward only (like drives): it biases the PROMPT (a somatic disposition line), DELIBERATION (fatigue), and the
// narrator's felt-state words — it does NOT loop back into the substrate chemistry.
import { clamp, clamp01 } from "./math.js";


export function makeViscera({ painGain = 0.5, painDecay = 0.82, disgustGain = 0.7, disgustDecay = 0.7, fatigueGain = 0.06, fatigueEase = 0.0, satietyFeed = 0.15, satietyDrain = 0.03 } = {}) {
  let pain = 0, disgust = 0, fatigue = 0, satiety = 0.6;

  // Fold one turn into the visceral state. `harm` = hostility+hurt aimed at the brain (nociception), `disgustCue` =
  // revulsion this turn, `effort` = how effortful the turn was (0 reflex … 1 full deliberation → fatigue debt).
  function sense({ harm = 0, disgustCue = 0, effort = 0, engaged = 0.5 } = {}) {
    pain = clamp01(pain * painDecay + painGain * clamp01(harm));
    disgust = clamp01(disgust * disgustDecay + disgustGain * clamp01(disgustCue));
    fatigue = clamp01(fatigue + fatigueGain * clamp01(effort) - fatigueEase); // recovery does NOT clear this — only rest()
    satiety = clamp01(satiety - satietyDrain + satietyFeed * clamp01(engaged)); // fed by engagement, drains toward hunger
    return state();
  }

  function state() { return { pain: +pain.toFixed(3), disgust: +disgust.toFixed(3), fatigue: +fatigue.toFixed(3), satiety: +satiety.toFixed(3), hunger: +(1 - satiety).toFixed(3) }; }

  // Behavioural biases the rest of the brain reads. avoidance (recoil/guard) from pain+disgust; drag (sluggish, shallow)
  // from fatigue; how much deliberation should be dampened this turn.
  function bias() {
    const avoidance = clamp01(0.7 * pain + 0.9 * disgust);
    return { avoidance: +avoidance.toFixed(3), drag: +fatigue.toFixed(3), deliberationScale: +(1 - 0.45 * fatigue).toFixed(3) };
  }

  // Somatic disposition line for the mouth (like drives.block) — the strongest bodily state, or "" when the body is at ease.
  function block() {
    if (disgust > 0.35 && disgust >= pain) return "Something here has left you recoiling a little — it's okay to keep a wary distance and not pretend otherwise.";
    if (pain > 0.35) return "You're still smarting from that — let a guarded, self-protective tenderness color how much you open up.";
    if (fatigue > 0.6) return "You're genuinely worn down — it's okay to be briefer and let some things wait.";
    return "";
  }

  // Words for the narrator's felt-state (the visceral overlay on the mood reading). Null when unremarkable.
  function feeling() {
    if (disgust > 0.35 && disgust >= pain) return "a little repulsed";
    if (pain > 0.4) return "sore and guarded";
    if (fatigue > 0.65) return "worn thin";
    if (1 - satiety > 0.7) return "restless and unfed";
    return null;
  }

  // REST clears the fatigue debt (called at sleep/consolidation) — the only thing that does.
  function rest() { fatigue = clamp01(fatigue * 0.2); }

  return {
    sense, state, bias, block, feeling, rest,
    snapshot: () => ({ pain, disgust, fatigue, satiety }),
    restore: (s) => { if (s) { pain = clamp01(s.pain ?? 0); disgust = clamp01(s.disgust ?? 0); fatigue = clamp01(s.fatigue ?? 0); satiety = clamp01(s.satiety ?? 0.6); } },
  };
}
