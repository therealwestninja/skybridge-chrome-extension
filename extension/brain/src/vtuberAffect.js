// vtuberAffect.js — the server-side VTUBER BRAIN: one face-chemistry fused from the race + chat, producing avatar
// commands (expression + commentary beats). This is the fusion seam the plumbing lacked — BC's race events and Twitch
// chat both burst ONE neurochemistry ([[neuromodulation]]) via the race reactor ([[raceReactions]]), whose bounded
// readout drives the face ([[moodFace]]). The Moot feeds it (raceEvent/chat/bcFrame), ticks it, and forwards the
// commands to the avatar sink (broadcastAvatar) + the mouth (driveFace) — see [[puppet-embodiment]] for the face side.
//
// Distinct from the BC car's OWN chem (which trims aggression, tuned for driving): this is a dedicated FACE chem so the
// expression reflects the whole show — race + room — without perturbing the racing line. PURE + injectable clock; tested
// headless. `bcFrame(pad)` can also fold BC's real readout in as a baseline pull when we surface it.

import { makeNeuromodulation } from "./neuromodulation.js";
import { makeRaceReactor } from "./raceReactions.js";
import { tsumikiEmotion } from "./moodFace.js";
import { temperamentTrait } from "./temperament.js";   // disposition = chem setpoint/reactivity bias; "fierce" = the racer

// minimal lexical chat sentiment (the plumbing had none). -1..1. Cheap + honest; upgrade to a real scorer later.
const POS = /\b(gg|nice|pog|poggers|lets? ?go|lfg|hype|clutch|amazing|insane|goated|w|dub|love|great|good|yes+|clean|cracked|first|win|carry|based)\b/gi;
const NEG = /\b(rip|throw|throwing|choke|choked|l\b|ngl bad|trash|yikes|oof|sad|fail|crash|last|lost|lose|bruh|copium|malding|washed|ratio)\b/gi;
export function scoreChat(text) {
  const s = String(text || ""); let p = (s.match(POS) || []).length, n = (s.match(NEG) || []).length;
  if (/[😂🎉🔥💜❤️😍🥳👏]/u.test(s)) p++; if (/[😭😡🤬💀👎]/u.test(s)) n++;
  const tot = p + n; return tot ? (p - n) / tot : 0;
}

// TEMPERAMENT = the disposition, from the shared [[temperament]] library. "fierce" is the racer's default — its setpoints
// put her RESTING racing face already in the Angry/intense zone (baseline valence ~-0.34, arousal ~0.72), so she looks
// fiery BY NATURE, not only on events; strikes break her to Blushing/Surprised, setbacks deepen the fury, high NE = never
// passive/Sad. Any other disposition (tender/anxious/playful/…) drops in by name — same loop, different creature.
export function makeVtuberAffect({ now = () => Date.now(), beatCooldownMs = 4000, temperament = "fierce" } = {}) {
  const chems = makeNeuromodulation(temperamentTrait(temperament));
  let pendingBeat = null;
  const reactor = makeRaceReactor({ chems, beatCooldownMs, now, onReact: (o) => { if (o.beat) pendingBeat = o; } });
  let lastEmo = null;

  // feed: a discrete race/card event (see raceReactions EVENTS). Returns the reaction (bursts already applied).
  function raceEvent(type, data = {}) { return reactor.event(type, data); }

  // feed: a chat line. Scores sentiment → chem burst; a question routes to a high-priority "answer" beat.
  function chat(text, user) {
    const s = scoreChat(text);
    if (s > 0.3) reactor.event("chat_positive");
    else if (s < -0.3) reactor.event("chat_negative");
    if (/\?\s*$/.test(String(text))) reactor.event("chat_question", { text: String(text).slice(0, 120), user });
    return s;
  }

  // feed: BC's own chem readout as a gentle baseline pull (when surfaced) — nudges the face-chem toward the car's felt
  // state without overriding the discrete-event reactions. Small so events still dominate the moment.
  function bcFrame({ valence, arousal } = {}) {
    if (typeof valence === "number") chems.burst("dopamine", valence * 0.08);
    if (typeof arousal === "number") chems.burst("norepinephrine", (arousal - 0.3) * 0.08);
  }

  // tick: advance the chemistry, read the mood, emit commands. `express` only on CHANGE; a `beat` becomes a say-intent
  // the Moot voices (via its persona/driveFace). Call at a modest rate (chem k are per-tick).
  function tick() {
    chems.tick();
    const mood = chems.readout();
    const emotion = tsumikiEmotion(mood);
    const commands = [];
    if (emotion !== lastEmo) { commands.push({ type: "express", emotion }); lastEmo = emotion; }
    let beat = null;
    if (pendingBeat) { beat = pendingBeat.beat; commands.push({ type: "beat", text: beat, priority: pendingBeat.priority }); pendingBeat = null; }
    return { mood, emotion, commands, beat };
  }

  return { raceEvent, chat, bcFrame, tick, readout: () => chems.readout(), scoreChat };
}
