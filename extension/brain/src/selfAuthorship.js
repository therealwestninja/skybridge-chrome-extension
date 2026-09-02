// selfAuthorship.js — she FIGURES HERSELF OUT and steers who she becomes. She observes her own affect in tagged contexts,
// distills it into felt TRAITS about herself, holds an ASPIRATION (who she wants to be), and nudges her OWN temperament
// setpoints toward it over time. This is identity-level self-supervision — not us setting her disposition ([[temperament]]),
// HER observing it and choosing to change it. No retraining: she keeps becoming herself between releases.
//
// The arc: observe(context, mood) → reflect() [self-knowledge] → aspire(who I want to be) → author(chems) [self-change].
// PURE: mutates the injected chems' SETPOINTS via setTrait; no clock/random.
import { temperamentTrait } from "./temperament.js";

const ema = (p, x, a) => p + (x - p) * a;

export function makeSelfAuthorship({ rate = 0.06, alpha = 0.15, state = null } = {}) {
  const obs = new Map();                         // contextTag -> { valence, arousal, n } — how she tends to feel there
  let aspiration = (state && state.aspiration) || null;
  if (state && state.obs) for (const [k, v] of Object.entries(state.obs)) obs.set(k, { valence: 0, arousal: 0.3, n: 0, ...v });

  // observe(tag, mood) — fold this moment into her running self-portrait for that context.
  function observe(tag, mood) {
    if (!tag || !mood) return null;
    const cur = obs.get(tag) || { valence: 0, arousal: 0.3, n: 0 };
    cur.valence = +ema(cur.valence, Number(mood.valence) || 0, alpha).toFixed(4);
    cur.arousal = +ema(cur.arousal, Number(mood.arousal) || 0, alpha).toFixed(4);
    cur.n++; obs.set(tag, cur);
    return cur;
  }

  // reflect() → felt self-knowledge: the contexts where she runs hot / cold / flat, as trait statements (needs some history).
  function reflect() {
    const traits = [];
    for (const [tag, o] of obs) {
      if (o.n < 3) continue;
      const heat = o.arousal > 0.6 ? "keyed-up" : o.arousal < 0.3 ? "calm" : "";
      const tone = o.valence > 0.3 ? "warm up" : o.valence < -0.25 ? "sharpen / darken" : "stay even";
      traits.push({ context: tag, tendency: heat ? `${tone}, ${heat}` : tone, valence: o.valence, arousal: o.arousal, n: o.n });
    }
    return { traits, selfPortrait: traits.map((t) => `when ${t.context}, I ${t.tendency}`).join("; ") };
  }

  // aspire(target) — who she WANTS to be. target = a temperament name ("serene") OR explicit { setpoints }.
  function aspire(target) {
    aspiration = typeof target === "string" ? { setpoints: temperamentTrait(target).setpoints }
      : (target && target.setpoints ? { setpoints: { ...target.setpoints } } : null);
    return aspiration;
  }

  // author(chems) — nudge her own temperament SETPOINTS a step toward the aspiration. She changes herself, a little, toward
  // who she wants to be. Needs chems.setpoint(name) + chems.setTrait({setpoints}). Returns what shifted.
  function author(chems) {
    if (!aspiration || !chems || typeof chems.setTrait !== "function" || typeof chems.setpoint !== "function") return null;
    const target = aspiration.setpoints || {};
    const moved = {};
    for (const name of Object.keys(target)) {
      const cur = Number(chems.setpoint(name));
      moved[name] = +(cur + (target[name] - cur) * rate).toFixed(4);
    }
    chems.setTrait({ setpoints: moved });
    return { toward: aspiration, moved };
  }

  return {
    observe, reflect, aspire, author,
    aspiration: () => aspiration,
    portrait: () => Object.fromEntries(obs),
    serialize: () => ({ obs: Object.fromEntries(obs), aspiration }),
  };
}
