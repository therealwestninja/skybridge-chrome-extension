// Structural salience: how information-dense a message is -- proper nouns, numbers, specificity,
// complexity -- NOT keyword lists (mined from Luminara, which "measures density, not keywords").
// Used to decide which memories are worth keeping. Higher = more worth keeping. Range ~0..10.
export function structuralSalience(text) {
  const raw = String(text);
  const words = raw.match(/[A-Za-z0-9']+/g) || [];
  if (!words.length) return 0;
  const propers = (raw.match(/\b[A-Z][a-z]{2,}/g) || []).length; // capitalized -> names / places
  const numbers = (raw.match(/\b\d+/g) || []).length;           // figures -> specifics / times / counts
  const questions = (raw.match(/\?/g) || []).length;
  const emphatic = (raw.match(/!/g) || []).length;
  const lengthScore = Math.min(1, words.length / 30);           // longer -> more content (capped)
  let score = 0;
  score += Math.min(4, propers * 1.2); // names/places are the strongest signal
  score += Math.min(2, numbers * 1.0);
  score += Math.min(1.5, questions * 0.75);
  score += Math.min(1, emphatic * 0.5);
  score += 1.5 * lengthScore;
  return Math.min(10, score);
}

// Common capitalized words that start sentences but aren't entities -- filtered so working memory
// holds real names/places/topics, not "What" or "Hello".
const ENTITY_STOP = new Set([
  "the", "what", "when", "where", "why", "how", "who", "which", "whose",
  "is", "are", "was", "were", "do", "does", "did", "can", "could", "would", "should", "will",
  "hello", "hi", "hey", "thanks", "thank", "yes", "no", "please", "let", "tell", "okay",
  "and", "but", "this", "that", "these", "those", "you", "your", "i've", "i'm",
]);

// Extract candidate entities from a message: capitalized words (names / places / topics), minus
// common sentence-starters, deduped case-insensitively, in first-appearance (document) order, capped. Feeds working
// memory -- the same proper-noun signal structuralSalience() uses, surfaced as discrete items.
export function entities(text, { limit = 5 } = {}) {
  const hits = String(text).match(/\b[A-Z][a-z]{2,}/g) || [];
  const seen = new Set();
  const out = [];
  for (const h of hits) {
    if (out.length >= limit) break;   // check the cap BEFORE pushing so limit:0 → [] (was off-by-one: emitted one then stopped)
    const key = h.toLowerCase();
    if (ENTITY_STOP.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}
