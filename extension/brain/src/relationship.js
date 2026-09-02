import { clamp, num, ema, relaxToward } from "./math.js";
// relationship.js — Phase 4: the persistent BOND. theoryOfMind reads the user's affect turn-by-turn, but the
// relationship itself resets each session — every visit meets a stranger. This is the standing bond that ACCUMULATES
// across turns and sessions along three distinct axes:
//   • warmth      — how warm the felt connection is (a slow EMA of the user's stance/valence toward the brain).
//   • trust       — earned reliability: built slowly by sustained positive, honest, non-hostile interaction; it does
//                   not swing on a single turn (trust is slow to gain).
//   • familiarity — how well they know each other: grows monotonically with turns and time known, never resets.
// From these it derives INTIMACY — how much closeness there is — which the express governor uses to gate disclosure
// (you tell a close friend more than a stranger). Persisted (faculty registry) and portable (the bond travels with the
// self), so the companion deepens over time instead of restarting cold.


export function makeRelationship({ warmthAlpha = 0.06, trustRate = 0.03, famScale = 40 } = {}) {
  let warmth = 0;        // -1..1  felt warmth of the connection
  let trust = 0.1;       //  0..1  earned reliability (starts low; earned slowly)
  let turns = 0;         //  count of exchanges
  let firstSeen = null, lastSeen = null;

  const familiarity = () => clamp(turns / (turns + famScale), 0, 1); // saturating: ~0.5 at `famScale` turns, never drops

  // Integrate ONE turn's read of the user into the standing bond. `read` is theoryOfMind's per-turn output
  // (stance/valence/engagement) plus optional signals: threat (hostility this turn) and honest (the brain owned its
  // uncertainty rather than bluffing — an honesty act builds trust).
  function observe(read = {}) {
    const stance = num(read.stance, num(read.valence, 0));         // warmth toward the brain, fall back to felt valence
    const engagement = num(read.engagement, 0.5);
    const threat = num(read.threat, 0);
    const now = read.now;
    if (firstSeen == null) firstSeen = now ?? 0;
    lastSeen = now ?? lastSeen;
    turns += 1;

    // Oxytocin (Phase 8) amplifies bonding: while the bonding hormone is up, warm contact deepens the bond faster —
    // closeness begets closeness. Default 1 (no endocrine layer) keeps the behaviour identical.
    const bonding = typeof read.bonding === "number" ? read.bonding : 1;
    warmth = clamp(ema(warmth, stance, warmthAlpha * bonding), -1, 1);
    // trust rises toward a target set by how positive + engaged + non-hostile (and honest) the interaction is — slowly,
    // so it is genuinely earned; a hostile turn pulls the target down but one turn can't tank it.
    const regard = typeof read.regard === "number" ? read.regard : 0.5; // their apparent regard for the brain (Phase 9) feeds trust
    const target = clamp(0.5 + 0.4 * stance + 0.2 * (engagement - 0.5) - 0.6 * threat + (read.honest ? 0.15 : 0) + 0.2 * (regard - 0.5), 0, 1);
    trust = clamp(relaxToward(trust, target, trustRate * bonding), 0, 1);
    return bond();
  }

  // The composite closeness the express governor reads. Warmth counts only when positive (coldness isn't intimacy).
  const intimacy = () => clamp(0.4 * Math.max(0, warmth) + 0.35 * trust + 0.25 * familiarity(), 0, 1);
  function bond() { return { warmth: +warmth.toFixed(3), trust: +trust.toFixed(3), familiarity: +familiarity().toFixed(3), intimacy: +intimacy().toFixed(3), turns }; }
  const sinceLastSeen = (now) => (lastSeen == null || now == null ? null : Math.max(0, now - lastSeen));

  // A legible read of the bond, for the mouth's attunement (never stated back mechanically).
  function block() {
    const b = bond();
    if (b.turns < 3) return "";
    const w = b.warmth > 0.35 ? "real warmth" : b.warmth < -0.2 ? "some coolness" : "an even, settling rapport";
    const t = b.trust > 0.6 ? "and hard-earned trust" : b.trust > 0.35 ? "and growing trust" : "";
    const f = b.familiarity > 0.5 ? "You know each other well by now" : "You're still getting to know each other";
    return `The bond you've built: ${w}${t ? " " + t : ""}. ${f}. Let it color how close you let yourself be — don't narrate it.`;
  }

  return {
    observe, bond, intimacy, sinceLastSeen, block,
    snapshot: () => ({ warmth, trust, turns, firstSeen, lastSeen }),
    restore: (s) => { if (s) { warmth = num(s.warmth); trust = num(s.trust, 0.1); turns = num(s.turns) | 0; firstSeen = s.firstSeen ?? null; lastSeen = s.lastSeen ?? null; } },
  };
}
