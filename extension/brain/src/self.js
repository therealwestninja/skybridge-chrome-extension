// Standing self (Personhood P2a): Rook's EARNED, autobiographical identity -- a short, evolving,
// first-person self-note woven from what has actually happened, distinct from the *given* persona
// (persona.js, author-set traits) and the raw episode pile. It's what makes Rook feel like the same
// someone across sessions rather than a fresh responder each time.
//
// Synthesized during REST (like sleep consolidating a sense of self), backend-driven with the
// distiller's discipline: grounded only in the episodes given, and NEVER erased on a bad/absent
// backend -- a failed reflection leaves the prior self-note intact. Persisted (identity survives
// reload, unlike working memory which is transient).
import { splitThink } from "./think.js";

const asText = (out) => (typeof out === "string" ? out : (out && out.text) || "");

export function makeSelf({ backend, maxEpisodes = 8 } = {}) {
  let narrative = "";
  let updatedTurn = 0;

  // Rewrite the self-note from the most-salient recent episodes + the prior note (for continuity).
  // Returns { narrative, changed }. No backend / no material / bad output -> unchanged (never erase).
  async function update(episodes = [], { turn = 0 } = {}) {
    if (!backend) return { narrative, changed: false };
    const salient = [...episodes].sort((a, b) => (b.salience || 0) - (a.salience || 0)).slice(0, maxEpisodes);
    if (!salient.length && !narrative) return { narrative, changed: false };
    const digest = salient.map((e) => `- ${e.message || e.text || ""}${e.reply ? " -> " + e.reply : ""}`).join("\n");
    try {
      const out = await backend.generate({
        system: "You maintain the first-person self-note of an AI companion named Rook -- a short, evolving sense of who Rook is and what has passed between Rook and the user, carried forward for continuity. Write 2 to 4 sentences in first person ('I ...'), grounded ONLY in the notes given. Do not invent facts or people. No preamble, no quotes.",
        messages: [{ role: "user", content: `Prior self-note:\n${narrative || "(none yet)"}\n\nRecent memorable moments:\n${digest || "(none)"}\n\nRewrite the self-note, evolving it to reflect these.` }],
      });
      const text = splitThink(asText(out)).answer.trim();
      if (text) { narrative = text; updatedTurn = turn; return { narrative, changed: true }; }
    } catch { /* never erase on failure */ }
    return { narrative, changed: false };
  }

  return {
    update,
    get: () => narrative,
    block: () => (narrative ? "What I carry from our history:\n" + narrative : ""),
    serialize: () => ({ narrative, updatedTurn }),
    restore: (s) => { if (s) { narrative = s.narrative || ""; updatedTurn = s.updatedTurn || 0; } },
  };
}
