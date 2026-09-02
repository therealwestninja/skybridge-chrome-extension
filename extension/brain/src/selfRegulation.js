// selfRegulation.js — from HAVING feelings to MANAGING them (allostasis). Reads the feelingCore's felt state and, when a
// drive presses or her body spikes, chooses a REGULATION strategy — and can act on her own chemistry to self-soothe or
// savor. The leap from reactive to self-stabilizing: she doesn't just feel frayed, she does something about it. Each
// strategy is a felt move (a disposition + an optional chem nudge toward balance), never a hard override of what she feels.
//
// PURE: mutates the injected chems via .burst() (down-regulation = a negative burst); no clock/random.

export function makeSelfRegulation({ soothe = 0.5 } = {}) {
  const s = Math.max(0, Math.min(1, Number(soothe) || 0));

  // regulate(bundle, chems) → { strategy, action, note } and optionally nudges her chemistry toward balance.
  // bundle is a feelingCore.tick() result ({ mood, drive, ... }).
  function regulate(bundle = {}, chems = null) {
    const mood = bundle.mood || { valence: 0, arousal: 0.3 };
    const drive = bundle.drive || null;
    const burst = (c, m) => { if (chems && typeof chems.burst === "function") chems.burst(c, m); };

    // OVERWHELMED (high arousal + sour) → down-regulate: actively bleed the alarm off (self-soothe).
    if (mood.arousal > 0.7 && mood.valence < -0.1) {
      burst("norepinephrine", -0.35 * s);
      return { strategy: "soothe", action: "slow down, drop the stakes, steady the breath", note: "self-soothing an overwhelmed state" };
    }
    // a pressing DRIVE → the move that meets it (interoception → chosen action).
    if (drive) switch (drive.name) {
      case "clarity":     return { strategy: "resolve", action: "check or ask rather than guess", note: "acting on the not-knowing instead of glossing it" };
      case "rest":        burst("norepinephrine", -0.15 * s); return { strategy: "conserve", action: "be briefer and gentler, protect the energy budget" };
      case "connection":  return { strategy: "reach", action: "lean warmer, invite closeness" };
      case "stimulation": return { strategy: "seek", action: "bring in something new — a thread of curiosity or play" };
      case "esteem":      return { strategy: "steady", action: "focus on landing one genuinely useful thing" };
    }
    // GOOD state → savor: hold it a beat, let it consolidate (a small warmth sustain).
    if (mood.valence > 0.4) { burst("serotonin", 0.1 * s); return { strategy: "savor", action: "let the good settle, share it" }; }
    // content → just be present.
    return { strategy: "rest", action: "stay present, no need to steer" };
  }

  return { regulate };
}
