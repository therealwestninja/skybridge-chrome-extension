import { INTENT_PATTERNS } from "../data/intentPatterns.js";
import { tokenize, QUESTION_OPENERS } from "./text.js";

export function classifyIntent(message, patterns = INTENT_PATTERNS) {
  const lower = String(message).toLowerCase().trim();
  const toks = tokenize(lower);
  if (lower.endsWith("?") || QUESTION_OPENERS.includes(toks[0]) || /\b(tell me|describe|explain)\b/.test(lower)) return "question";
  const set = new Set(toks);
  let best = "respond", bestScore = 0;
  for (const intent in patterns) {
    let score = 0;
    for (const w of patterns[intent]) if (set.has(w)) score++;
    if (score > bestScore) { bestScore = score; best = intent; }
  }
  return best;
}
