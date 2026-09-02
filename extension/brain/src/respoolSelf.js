// respoolSelf.js — the OPEN-QUESTIONS faculty: the first slice of "respooling the self" (the story-distillation idea,
// turned inward on the brain's own lived episodes). On rest it reads recent episodes and, in the Librarian's discipline
// (catalogue only what was actually said; NEVER invent an answer), notes the things the companion has NOTICED about the
// user but does not yet understand — a persisted, decaying list of grounded wonderings. These feed the inner voice's
// `wonder` frame ("I keep wondering why you went quiet last week"), turning lived-but-unexplained moments into occasional,
// honest curiosity instead of confabulation. It is the counterpart to the distiller: the distiller crystallises what IS
// known into facts; this keeps track of what ISN'T. Backend-driven, never erases on a bad/absent backend (like self.js).
import { norm } from "./text.js";

const asText = (out) => (typeof out === "string" ? out : (out && out.text) || "");

// Parse the backend's reply into short wondering-clauses. Tolerant: a JSON array of strings/objects, or plain lines.
// Each clause is normalised to complete "I keep wondering ___" cleanly — trailing "?" dropped, a leading interrogative
// lowercased ("Why they left" -> "why they left"), bullets/quotes stripped, and out-of-range lengths discarded.
export function parseQuestions(text) {
  const s = String(text || "").trim();
  const i = s.indexOf("["), j = s.lastIndexOf("]");
  if (i >= 0 && j > i) { try { const arr = JSON.parse(s.slice(i, j + 1)); if (Array.isArray(arr)) return clean(arr.map((x) => (typeof x === "string" ? x : (x && x.text) || ""))); } catch (e) { /* fall through to line parsing */ } }
  return clean(s.split("\n"));
}
const clean = (arr) => arr
  .map((l) => String(l).replace(/^\s*[-*\d.)\]\s]+/, "").replace(/^["“']+|["”']+$/g, "").trim())
  .map((l) => l.replace(/\s*\?+\s*$/, "").trim())
  .map((l) => (/^(Why|What|Whether|How|If|Who|Where|When|Whose)\b/.test(l) ? l.charAt(0).toLowerCase() + l.slice(1) : l))
  .filter((l) => l.length >= 6 && l.length <= 160);

export function makeRespoolSelf({ backend, onFault, maxQuestions = 12, maxEpisodes = 10, decay = 0.8, recentN = 4 } = {}) {
  let questions = []; // [{ text, key, turn, freshness, surfaced }]
  let recent = [];    // norm keys just surfaced — so the inner voice doesn't loop one wondering

  // Extract fresh open-questions from recent episodes and merge them into the standing list. Grounded ONLY in the
  // episodes; the model is told NOT to answer them. Existing wonderings fade each pass (a resolved one simply stops
  // being re-raised). Never erases on a bad/absent backend.
  async function update(episodes = [], { turn = 0 } = {}) {
    for (const q of questions) q.freshness *= decay; // age the standing list first, so even a no-op pass lets stale ones fade
    if (!backend || !episodes.length) { prune(); return { questions: list(), added: 0 }; }
    const salient = [...episodes].sort((a, b) => (b.salience || 0) - (a.salience || 0)).slice(0, maxEpisodes);
    const digest = salient.map((e) => `- ${e.message || e.text || ""}${e.reply ? " -> " + e.reply : ""}`).join("\n");
    const known = questions.slice(0, 8).map((q) => "- " + q.text).join("\n");
    let cand = [];
    try {
      const out = await backend.generate({
        system: "You track what an AI companion has NOTICED but does not yet understand about the user — genuine open questions raised by what the user said or did, then left unexplained. Grounded ONLY in the notes; do NOT invent, and do NOT answer them. Return 0-4 items, each a SHORT clause that naturally completes \"I keep wondering ___\" (e.g. \"why they went quiet after mentioning their brother\", \"whether they're still upset about the move\"). Skip anything already listed as known. Return a JSON array of strings, or an empty array if nothing genuine is unexplained.",
        messages: [{ role: "user", content: `Recent moments:\n${digest}\n\nAlready wondered (skip these):\n${known || "(none)"}` }],
      });
      cand = parseQuestions(asText(out));
    } catch (e) { if (onFault) onFault("respoolSelf.update", e); prune(); return { questions: list(), added: 0 }; }
    let added = 0;
    for (const text of cand) {
      const key = norm(text);
      if (!key || questions.some((q) => q.key === key)) continue;
      questions.push({ text, key, turn, freshness: 1, surfaced: 0 });
      added++;
    }
    prune();
    return { questions: list(), added };
  }

  // Keep the freshest, cap the list.
  function prune() { questions.sort((a, b) => b.freshness - a.freshness); if (questions.length > maxQuestions) questions = questions.slice(0, maxQuestions); }

  // The freshest wondering not just surfaced — for the inner voice's `wonder` frame. {text, freshness} | null.
  function freshest() {
    const c = questions.filter((q) => q.freshness > 0.15 && !recent.includes(q.key)).sort((a, b) => b.freshness - a.freshness);
    return c[0] ? { text: c[0].text, freshness: +c[0].freshness.toFixed(3) } : null;
  }
  function noteSurfaced(text) { const key = norm(text); const q = questions.find((x) => x.key === key); if (q) q.surfaced++; if (key) { recent.push(key); if (recent.length > recentN) recent.shift(); } }
  // A wondering is RESOLVED once the user explains it — the host (or a later pass) can drop it explicitly. Returns #removed.
  function resolve(text) { const key = norm(text); const before = questions.length; questions = questions.filter((q) => q.key !== key); return before - questions.length; }

  const list = () => questions.map((q) => ({ text: q.text, freshness: +q.freshness.toFixed(3), turn: q.turn }));
  return {
    update, freshest, noteSurfaced, resolve, list,
    count: () => questions.length,
    snapshot: () => ({ questions: questions.map((q) => ({ ...q })), recent: recent.slice() }),
    restore: (s) => { if (s) { questions = Array.isArray(s.questions) ? s.questions.map((q) => ({ ...q })) : []; recent = Array.isArray(s.recent) ? s.recent.slice() : []; } },
  };
}
