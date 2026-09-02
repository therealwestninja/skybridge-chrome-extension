// Declarative consolidation (mined from Luminara's background distillation): turn raw episodes into
// compact, durable FACTS via the backend, and periodically RECONCILE the fact set (dedupe / resolve
// contradictions / keep the newest state). This is the declarative-memory counterpart to sleep
// consolidation's associative replay -- important content survives even after raw episodes are
// forgotten (salience-pruned). Backend-driven, with a tolerant JSON parser so a mock/real model and
// occasional bad output are both handled.
const FACT_TYPES = new Set(["identity", "preference", "event", "world", "other"]);

export function extractJsonArray(text, onFault) {
  const s = String(text);
  const i = s.indexOf("["), j = s.lastIndexOf("]");
  if (i < 0 || j <= i) return [];
  try { const arr = JSON.parse(s.slice(i, j + 1)); return Array.isArray(arr) ? arr : []; }
  catch (e) { if (onFault) onFault("distiller.parse", e); return []; } // a fault worth diagnosing: the backend returned unparseable JSON → distillation lost
}

const cleanFacts = (arr) => arr
  .filter((f) => f && typeof f.text === "string" && f.text.trim())
  .map((f) => ({ type: FACT_TYPES.has(f.type) ? f.type : "other", text: f.text.trim() }));

const asText = (out) => (typeof out === "string" ? out : (out && out.text) || "");

export function makeDistiller({ backend, onFault } = {}) {
  return {
    // Episodes -> durable {type,text} facts.
    async distill(episodes = []) {
      if (!backend || !episodes.length) return [];
      const snippets = episodes.map((e) => `- ${e.text}${e.reply ? " -> " + e.reply : ""}`).join("\n");
      const out = await backend.generate({
        system: 'Extract durable, reusable FACTS from these conversation snippets. Return ONLY a JSON array of {"type","text"}, type one of identity|preference|event|world|other. Keep only concrete lasting facts (names, preferences, commitments, world details) -- no chit-chat, no duplicates.',
        messages: [{ role: "user", content: snippets }],
      });
      return cleanFacts(extractJsonArray(asText(out), onFault));
    },

    // A fact set -> a deduped, contradiction-resolved fact set (keep the newest state). Never returns
    // empty on a bad parse -- falls back to the input so reconciliation can't erase memory.
    async reconcile(facts = []) {
      if (!backend || facts.length < 2) return cleanFacts(facts);
      const list = facts.map((f, i) => `${i + 1}. [${f.type || "other"}] ${f.text}`).join("\n");
      const out = await backend.generate({
        system: 'Here is a list of remembered facts. Dedupe them, resolve contradictions by KEEPING THE NEWEST state, and drop obsolete/transient ones. Return ONLY the cleaned JSON array of {"type","text"}.',
        messages: [{ role: "user", content: list }],
      });
      const cleaned = cleanFacts(extractJsonArray(asText(out), onFault));
      return cleaned.length ? cleaned : cleanFacts(facts);
    },
  };
}
