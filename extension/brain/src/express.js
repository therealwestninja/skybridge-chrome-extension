import { num } from "./math.js";
// express.js — Expression II: the EXTERNALIZATION GOVERNOR (the heart of the user's ask). Phase 1 gave the brain a
// continuous INTERNAL voice over its own state; this decides what of that inner stream, if anything, reaches the user
// — and how much — "as it deems fit, as the situation calls for." Internal is rich and always-on; external is a
// gated, situational subset.
//
// Each turn it weighs a few candidate externalizations:
//   • share-feeling  — voice how it's doing (from the narrator). Pulled up when the user ASKED, when the bond is warm,
//                      or when the feeling is intense; pulled DOWN when the user seems to need the floor (don't centre
//                      yourself while they're hurting) and on a cooldown so it never becomes chatter.
//   • surface-doubt  — own epistemic uncertainty ("I'm not sure I have real grounding for this"). An honesty act.
//   • surface-problem— UNPROMPTED: flag an internal inconsistency it noticed ("I think I crossed some wires there").
// It returns the decision AND a legible reason either way ("stayed internal: you seem to need the floor"), so the
// internal-vs-external gate is auditable. The DECISION lives here; the WORDS come from the mouth (or a template).
// Registered as a faculty (cooldown persists); default surface is opt-in (app.express), so no turn behaviour changes.

const NEEDS_FLOOR = new Set(["comfort", "help", "support", "reassurance"]);

export function makeExpress({ threshold = 0.5, cooldownMs = 120e3, defaultBond = 0.35 } = {}) {
  let lastAt = null;

  // state: { narration, mood:{valence,arousal}, metacognition, otherMind, asked:bool, inconsistency:0..1, bond, now }
  function consider(state = {}) {
    const { narration = null, mood = {}, metacognition = null, otherMind = null, asked = false, inconsistency = 0, now = null } = state;
    const bond = num(state.bond, defaultBond);
    const onCooldown = now != null && lastAt != null && (now - lastAt) < cooldownMs;

    // does the user seem to need the floor right now? (then hold your own feelings unless they asked)
    const need = otherMind && otherMind.need;
    const userLow = otherMind && num(otherMind.valence, 0) < -0.2;
    const needsFloor = !asked && (NEEDS_FLOOR.has(need) || userLow);

    const intensity = Math.min(1, Math.abs(num(mood.valence, 0)) + Math.abs(num(mood.arousal, 0.4) - 0.4));
    const cands = [];

    // SHARE FEELING
    if (narration && narration.feeling) {
      let pull = 0.15 + (asked ? 0.6 : 0) + bond * 0.25 + intensity * 0.3;
      if (needsFloor) pull *= 0.35;           // their moment, not yours
      if (onCooldown) pull *= 0.25;           // just shared — don't chatter
      cands.push({ kind: "feeling", pull, seed: narration.line, feeling: narration.feeling, volume: (asked || bond > 0.6) ? "open" : "hint" });
    }
    // SURFACE DOUBT (honesty about grounding) — not gated by cooldown; it only fires on genuine uncertainty
    if (metacognition) {
      let pull = 0;
      if (metacognition.confused) pull = 0.7;
      else if (metacognition.known === false && num(metacognition.certainty, 1) < 0.4) pull = 0.55;
      if (pull > 0) cands.push({ kind: "doubt", pull, seed: (narration && narration.confidence) || "I'm not sure I have real grounding for this", volume: "open" });
    }
    // SURFACE PROBLEM (unprompted) — own an inconsistency it noticed
    if (inconsistency > 0.5) cands.push({ kind: "problem", pull: 0.55 + inconsistency * 0.3, seed: "I think I may have crossed some wires there", volume: "open" });
    // SURFACE DISTRESS (Part B) — when the brain's OWN vitals are critical (running on empty, overwhelmed, an internal
    // fault). Important, so it's not cooldown-gated; but if the user needs the floor, hold it lighter (don't centre your
    // own crisis over theirs). state.vitals: { band, concern, protect }.
    const vit = state.vitals;
    if (vit && vit.band === "critical" && vit.concern) {
      // Naming your own limit is a HEALTHY boundary — it surfaces even under pressure (only lightly deferred if the user
      // seems to need the floor), so the brain that's not okay can actually say so rather than silently degrade.
      let pull = 0.78; if (needsFloor) pull *= 0.85;
      cands.push({ kind: "distress", pull, seed: vit.concern, volume: "open", extra: { protect: vit.protect } });
    }

    cands.sort((a, b) => b.pull - a.pull || a.kind.localeCompare(b.kind));
    const top = cands[0];
    if (!top || top.pull < threshold) {
      const why = onCooldown ? "just spoke up (cooldown)" : needsFloor ? "you seem to need the floor" : "nothing pressing to share";
      return { external: false, reason: `stayed internal: ${why}`, considered: cands.map((c) => ({ kind: c.kind, pull: +c.pull.toFixed(3) })) };
    }
    const why = top.kind === "feeling" ? (asked ? "you asked" : bond > 0.5 ? "warm bond" : "a strong feeling") : top.kind === "doubt" ? "owning my uncertainty" : top.kind === "distress" ? "my own vitals are critical" : "flagging an inconsistency I noticed";
    return { external: true, kind: top.kind, volume: top.volume, seed: top.seed, feeling: top.feeling, extra: top.extra || null, pull: +top.pull.toFixed(3), reason: `${top.kind} (${why})` };
  }

  function noteExpressed(now) { if (now != null) lastAt = now; }

  // Offline template — the mouth phrases these far more naturally.
  function render(dec) {
    if (!dec || !dec.external) return "";
    if (dec.kind === "feeling") return dec.volume === "hint" ? `(honestly, ${dec.feeling} right now)` : dec.seed;
    if (dec.kind === "doubt") { const s = String(dec.seed).replace(/^(and|though)\s+/i, ""); return `I want to be honest — ${s}.`; }
    if (dec.kind === "problem") return `${dec.seed} — let me reconcile that.`;
    if (dec.kind === "distress") return `Honestly, I'm at my limit right now — ${dec.seed}${dec.extra && dec.extra.protect ? ` (I need to ${dec.extra.protect})` : ""}.`;
    return "";
  }

  return { consider, noteExpressed, render, lastAt: () => lastAt, snapshot: () => ({ lastAt }), restore: (s) => { if (s) lastAt = s.lastAt ?? null; } };
}
