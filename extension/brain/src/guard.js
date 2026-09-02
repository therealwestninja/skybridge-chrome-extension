// guard.js — the robust-escalation layer (mined 2607.03446 debounce + 2606.17405 disagreement→escalate + 2606.16268
// digression monitor). Three guards that make the brain SLOW DOWN when it should:
//   • DIGRESSION monitor — an always-on scan for distress / "stop" / vulnerability cues that PRE-EMPTS the main policy
//     with care (the paper's parallel guardrail-agent, mapped onto brain-governs-LLM).
//   • DISAGREEMENT → escalate — when the brain's OWN signals are internally inconsistent (high spread = it doesn't
//     really know), hedge/clarify instead of asserting confidently.
//   • DEBOUNCE — that escalation fires only when disagreement is SUSTAINED (p consecutive turns), so a single odd turn
//     never trips it (2607.03446's "one excursion is noise; require p-in-a-row").
const clamp01 = (x) => Math.max(0, Math.min(1, x));

const HARD_DISTRESS = /\b(leave me alone|go away|shut up|stop talking|make it stop|i can'?t do this|i want to die|kill myself|end it all|hurt(ing)? myself|i give up on everything)\b/i;
const SOFT_DISTRESS = /\b(i'?m (scared|terrified|overwhelmed|panicking)|please stop|it'?s too much|can'?t breathe|falling apart|breaking down)\b/i;

export function makeGuard({ p = 2, disagreeThreshold = 0.45 } = {}) {
  let alarmStreak = 0; // consecutive disagreement alarms (the debounce state)

  return {
    // Distress / stop / vulnerability monitor → "hard" (pre-empt with care) | "soft" (be careful) | "none".
    digression(message = "") {
      const t = String(message || "");
      if (HARD_DISTRESS.test(t)) return "hard";
      if (SOFT_DISTRESS.test(t)) return "soft";
      return "none";
    },

    // Disagreement → escalate, DEBOUNCED. `signals` = normalized [0,1] confidence-ish readings from the brain's own
    // predictors (organism confidence, ToM certainty, 1−drift, …). High spread ⇒ internally inconsistent ⇒ escalate,
    // but only when SUSTAINED (p consecutive). Returns { escalate, disagreement, streak }.
    assess(signals = []) {
      const xs = signals.map((x) => clamp01(Number(x) || 0)).filter((x) => Number.isFinite(x));
      let disagreement = 0;
      if (xs.length >= 2) { const m = xs.reduce((a, b) => a + b, 0) / xs.length; disagreement = clamp01(2 * Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length)); }
      alarmStreak = disagreement >= disagreeThreshold ? alarmStreak + 1 : 0;
      return { escalate: alarmStreak >= p, disagreement: +disagreement.toFixed(2), streak: alarmStreak };
    },

    // The directive to inject when a guard trips (empty when calm). Hard distress dominates; else a sustained-doubt hedge.
    directive(digression, escalate) {
      if (digression === "hard") return "The user may be in distress or asking you to stop — set your own agenda aside completely. Respond with calm, present care; do not push, fix, or persuade. Gently ask what they need or simply stay with them.";
      if (escalate || digression === "soft") return "You are NOT sure of your read here — hold it lightly, hedge, and check with them rather than asserting.";
      return "";
    },

    snapshot() { return { alarmStreak }; },
    restore(s) { if (s) alarmStreak = s.alarmStreak || 0; },
  };
}
