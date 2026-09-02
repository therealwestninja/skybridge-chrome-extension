// director.js — a narrative PACING engine (mined from epic-dm's GM Director). Where the council picks an ACTION and the
// world.js models WHO/WHAT is around, the Director shapes the BEAT of an unfolding story: it tracks a TENSION curve and,
// each turn, chooses the next dramatic intent (escalate / reveal / complicate / reward / breathe) with guidance for the
// mouth. Its player-model (bold/curious/warm) overlaps the brain's theory-of-mind, so this belongs in a STORY layer
// (roleplay / scenario / mission modes), NOT the base companion loop — it assumes there is a plot to pace. Pure state.
import { clamp } from "./math.js";

const hits = (text, words) => { const t = " " + String(text).toLowerCase() + " "; let n = 0; for (const w of words) if (t.includes(w)) n++; return n; };

const BOLD = ["attack", "fight", "charge", "strike", "confront", "demand", "force", "break", "smash", "threaten", "draw my", "raise my"];
const TIMID = ["sneak", "hide", "avoid", "flee", "retreat", "careful", "quietly", "wait", "watch", "back away"];
const CURIOUS = ["examine", "search", "look", "inspect", "ask", "investigate", "read", "study", "explore", "open", "listen", "who ", "what ", "why ", "how "];
const KIND = ["help", "comfort", "save", "protect", "befriend", "thank", "gentle", "heal", "reassure", "forgive", "spare"];
const CRUEL = ["kill", "threaten", "hurt", "betray", "steal", "lie", "cruel", "torture", "abandon", "mock"];
const DANGER = ["blood", "blade", "fire", "scream", "attack", "death", "danger", "enemy", "fight", "fell", "dark", "threat", "pain", "wound", "roar", "chase", "trap", "betray", "shadow", "sword", "blow"];
const CALM = ["rest", "calm", "quiet", "safe", "laugh", "smile", "warm", "peace", "home", "sleep", "meal", "gentle", "relief", "still", "soft"];

const INTENT_GUIDANCE = {
  escalate: "raise the stakes — press toward a turning point",
  complicate: "introduce a complication or obstacle that reframes the scene",
  reveal: "reveal something — a truth, a clue, or a hidden tie to what came before",
  reward: "let a small victory or discovery land; reward how they've been playing",
  "reward-breath": "grant a hard-won breath — respite before the next storm",
  breathe: "ease the pace with a quieter character or world beat",
  "introduce-threat": "plant the first sign of a new danger on the horizon",
};

export function makeDirector() {
  let bold = 0, curious = 0, warm = 0, n = 0, tension = 0.3, lastIntent = null;

  function pickIntent() {
    const opts = tension > 0.66 ? ["escalate", "complicate", "reward-breath", "reveal"]
      : tension < 0.33 ? ["introduce-threat", "reveal", "complicate", "reward"]
        : ["escalate", "reveal", "complicate", "reward", "breathe"];
    const pick = opts.find((o) => o !== lastIntent) || opts[0];
    lastIntent = pick; return pick;
  }
  function playerSummary() {
    if (n < 2) return "still taking their measure";
    const out = [bold > 1 ? "bold and forceful" : bold < -1 ? "cautious, favours stealth" : "measured in action"];
    if (curious > 2) out.push("probes and questions everything");
    out.push(warm > 1 ? "warm toward others" : warm < -1 ? "ruthless" : "even-handed with others");
    return out.join(", ");
  }

  return {
    // Read the player's move (their intent/style) — call with the user's action each turn.
    observePlayer(action = "") {
      bold += hits(action, BOLD) - hits(action, TIMID);
      curious += hits(action, CURIOUS);
      warm += hits(action, KIND) - hits(action, CRUEL);
      n++;
    },
    // Read the scene's charge (drives the tension curve) — call with the last narration + the action.
    observeStory(gmText = "", action = "") {
      const both = gmText + " " + action;
      tension = clamp(tension * 0.78 + 0.08 + hits(both, DANGER) * 0.12 - hits(both, CALM) * 0.09, 0, 1);
    },
    // The next-beat brief for the mouth: the player read, the current tension, the chosen intent, and its guidance.
    brief() {
      const intent = pickIntent();
      const band = tension > 0.66 ? "Tension is HIGH" : tension < 0.33 ? "Tension is LOW" : "Tension is moderate";
      return { player: playerSummary(), tension: +tension.toFixed(2), intent, guidance: band + ". Aim this beat to " + (INTENT_GUIDANCE[intent] || "advance the scene") + "." };
    },
    view: () => (n ? { player: playerSummary(), tension: +tension.toFixed(2), intent: lastIntent || "—" } : null),
    tension: () => +tension.toFixed(2),
    serialize: () => ({ bold, curious, warm, n, tension, lastIntent }),
    restore(s) { if (!s) return; bold = s.bold || 0; curious = s.curious || 0; warm = s.warm || 0; n = s.n || 0; tension = s.tension ?? 0.3; lastIntent = s.lastIntent ?? null; },
  };
}
