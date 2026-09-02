// The local micro-LLM: intent-keyed openers + offline fact-fallback + a seeded order-2 n-gram
// for lexical variation, with mood polish and an identity-values guard veto.
import { makeRng } from "./rng.js";
import { OPENERS } from "../data/openers.js";
import { SEEDS } from "../data/seeds.js";
import { ALMANAC } from "../data/almanac.js";
import { words } from "./text.js";

const ORDER = 2;
// Local variant of tokenize that also emits sentence-boundary punctuation, for the n-gram.
const tokenize = (s) => (String(s).toLowerCase().match(/[a-z']+|[.!?]/g) || []);

const GUARD_PATTERNS = [/\bi am (a )?human\b/i, /\bi'?m (a )?real person\b/i, /\bi am not a bot\b/i];
export function violatesGuard(text) { return GUARD_PATTERNS.some((re) => re.test(String(text))); }

export function lookupFact(message, almanac = ALMANAC) {
  const set = new Set(words(message));
  const norm = " " + String(message).toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim() + " ";
  const hit = (kw) => (kw.includes(" ") ? norm.includes(" " + kw + " ") : set.has(kw));
  // Most-specific match wins: the longest matching keyword across all facts (so "new mexico"
  // beats the country "mexico", "new york" beats nothing shorter, etc.). Ties -> first seen.
  let best = null, bestLen = 0;
  for (const f of almanac) {
    for (const kw of f.k) {
      if (kw.length > bestLen && hit(kw)) { best = f; bestLen = kw.length; }
    }
  }
  return best;
}

// Precision-gated lookup for the fact short-circuit: only answer from the bank when the message
// is a DIRECT lookup ("what/where/who is X", "capital of X", "tell me about X") AND has no
// relational/comparative word (north of, between, how many...). Otherwise return null so the turn
// falls through to the backend (which can actually reason). Kills false positives like
// "what country is north of Mexico" -> "Mexico City is the capital of Mexico".
const DIRECT_TEMPLATES = /\b(what(?:'s| is| are)|where (?:is|are)|who (?:is|are)|capital of|tell me about|describe|explain)\b/;
const RELATIONAL = /\b(north of|south of|east of|west of|border|between|near|nearest|beyond|farther|further|closest|how far|how many|versus|vs|next to|compared|difference)\b/;
// PERSONAL / LIVE asks are never bank lookups: "what is MY current heart rate" is a question about the
// user's own state right now (answered from live instruments / the conversation), not "what is a heart".
// Without this, the bare keyword 'heart' matched and the almanac's textbook line was handed to the mouth
// as if it answered the question. First-person/possessive markers OR present-moment/measurement markers
// mean: no bank hit; the turn is grounded by the conversation instead.
// (possessive / self-state forms only: bare "me"/"i" would veto idioms like "tell me about X" / "show me X")
const PERSONAL = /\b(my|mine|myself|our|ours|am i|do i|did i|was i|is my|are my|was my|were my|i feel|i'm feeling|i am feeling|how am i|how do i|your own|yourself)\b/;
const LIVE = /\b(current|currently|right now|at the moment|at present|this moment|these days|today|tonight|now|live|reading|readings|measure|measured|measurement|sensor|bpm)\b/;
export function isPersonalOrLiveAsk(message) {
  const lower = String(message).toLowerCase();
  return PERSONAL.test(lower) || LIVE.test(lower);
}
export function directFactLookup(message, almanac = ALMANAC) {
  const lower = String(message).toLowerCase();
  if (!DIRECT_TEMPLATES.test(lower)) return null;
  if (RELATIONAL.test(lower)) return null;
  if (isPersonalOrLiveAsk(lower)) return null;
  return lookupFact(message, almanac);
}

export function makeReflex({ seed = 1, openers = OPENERS, seeds = SEEDS, almanac = ALMANAC, maxContexts = 2000 } = {}) {
  const rng = makeRng(seed);
  const grams = new Map();
  let protectedKeys = new Set(); // the curated warm-start contexts -- never evicted

  function learn(text) {
    const toks = tokenize(text);
    for (let i = 0; i + ORDER < toks.length; i++) {
      const key = toks.slice(i, i + ORDER).join(" ");
      const next = toks[i + ORDER];
      if (!grams.has(key)) grams.set(key, new Map());
      const m = grams.get(key);
      m.set(next, (m.get(next) || 0) + 1);
    }
    // Bound growth: learn() runs every turn, so on a long-lived / on-device brain (Sweetie-bot) the
    // table would grow without limit -- an n-gram memorizes, it doesn't compress. Evict the OLDEST
    // learned context (Map insertion order) past the cap, never the curated warm-start seeds.
    if (protectedKeys.size) {
      while (grams.size > maxContexts) {
        let evicted = false;
        for (const k of grams.keys()) { if (!protectedKeys.has(k)) { grams.delete(k); evicted = true; break; } }
        if (!evicted) break; // everything left is protected
      }
    }
  }
  // Warm-start the n-gram from seed phrases + every opener phrase (deterministic order).
  for (const s of seeds) learn(s.phrase);
  for (const k of Object.keys(openers)) for (const p of openers[k]) learn(p);
  protectedKeys = new Set(grams.keys()); // everything learned so far is the protected warm-start

  function generate(maxWords = 8) {
    if (grams.size === 0) return "";
    const keys = [...grams.keys()];
    let key = keys[Math.floor(rng.next() * keys.length)];
    const out = key.split(" ");
    for (let i = 0; i < maxWords; i++) {
      const m = grams.get(key);
      if (!m) break;
      const entries = [...m.entries()];
      const total = entries.reduce((s, [, c]) => s + c, 0);
      let r = rng.next() * total, pick = entries[0][0];
      for (const [w, c] of entries) { r -= c; if (r <= 0) { pick = w; break; } }
      out.push(pick);
      key = out.slice(-ORDER).join(" ");
    }
    return out.join(" ");
  }

  const pick = (arr) => arr[Math.floor(rng.next() * arr.length)];

  function render(state = {}) {
    const action = state.action || "RESPOND";
    if (action === "QUIET") return "";
    const mood = state.mood || {};
    const intent = state.intent || "respond";

    let text;
    if (action === "HOLD") {
      // A low-confidence/ambiguous decision asks to clarify; a plain hold just stalls.
      text = pick((intent === "clarify" && openers.clarify) || openers.stall || openers.respond);
    } else {
      if (intent === "question" && state.message) {
        // Precision-gated: same guard as the mind's fact short-circuit, so a relational question
        // ("what country is north of Mexico") doesn't wrongly return "Mexico City is the capital...".
        const fact = directFactLookup(state.message, almanac);
        if (fact) return fact.a;                       // offline knowledge, returned verbatim
      }
      // A clean intent opener. (The order-2 n-gram tail was removed: live output showed it appends
      // word-salad like "Hi there. you get the door closes". generate() is kept for style learning.)
      text = pick(openers[intent] || openers.respond);
    }
    if (text && (mood.arousal ?? 0) > 0.6) text = text.replace(/[.]?$/, "!");
    if (violatesGuard(text)) text = pick(openers.respond);
    return text;
  }

  return {
    learn, generate, render,
    snapshot: () => ({ grams: [...grams.entries()].map(([k, m]) => [k, [...m.entries()]]) }),
    restore: (s) => { grams.clear(); for (const [k, arr] of s.grams) grams.set(k, new Map(arr)); },
  };
}
