// Shared text helpers used across feature extraction, intent classification, embedding, and memory.
export const tokenize = (s) => (String(s).toLowerCase().match(/[a-z']+/g) || []);
export const words = (s) => (String(s).toLowerCase().match(/[a-z0-9']+/g) || []);

// Interrogative openers — used to detect a question structurally (a leading opener or a trailing '?').
export const QUESTION_OPENERS = ["who", "what", "when", "where", "why", "how", "is", "are", "do", "does", "can", "could", "would", "will"];

// Normalize a string for dedup/matching: trimmed, lowercased, whitespace collapsed.
export const norm = (t) => String(t || "").trim().toLowerCase().replace(/\s+/g, " ");

// Common function words that shouldn't be treated as content/topics/fingerprints. Shared by beliefs (topic pick) and
// primal (fear fingerprint). Includes evaluative words (wonderful/terrible/…) so a STANCE never becomes a topic.
export const STOP_WORDS = new Set(["the", "and", "you", "are", "was", "for", "this", "that", "with", "have", "from", "your", "were", "will", "been", "there", "here", "what", "when", "then", "them", "into", "just", "about", "like", "really", "very", "kind", "sort", "think", "feel", "believe", "know", "want", "need", "would", "could", "should", "thing", "things", "stuff", "much", "some", "they", "because", "which", "its", "but", "not", "all", "any", "can", "has", "had", "her", "his", "our", "out", "who", "how", "get", "let", "she", "him",
  "wonderful", "helpful", "great", "terrible", "awful", "amazing", "lovely", "perfect", "brilliant", "horrible", "good", "bad", "nice", "best", "worst", "beautiful", "stupid", "useless", "cruel", "sweet", "mean", "cool", "fine", "okay", "sure", "yeah", "absolutely", "totally", "honestly", "actually", "myself", "yourself", "thank", "thanks", "please", "sorry", "hello", "right", "wrong"]);
