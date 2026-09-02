// Offline heuristic feature extraction. No model, no network.
import { tokenize, QUESTION_OPENERS } from "./text.js";
import { clamp } from "./math.js";

const POSITIVE = new Set(["thanks", "thank", "love", "great", "good", "yes", "awesome", "nice", "happy", "cool", "please", "appreciate", "perfect", "excellent", "brilliant", "amazing", "wonderful", "helpful", "clear", "fixed", "works", "working", "solved", "right", "correct", "beautiful", "fantastic", "glad", "enjoy", "like", "best", "better",
  // warmth + esteem + relief (companion register) — so affection and reassurance register, not just task praise
  "proud", "grateful", "adore", "trust", "safe", "comfort", "comforting", "reassuring", "kind", "sweet", "gentle", "care", "caring", "understanding", "patient", "thoughtful", "impressed", "delighted", "relieved", "hopeful", "excited", "fun", "funny", "smart", "clever", "wise"]);
const NEGATIVE = new Set(["no", "stop", "hate", "bad", "angry", "terrible", "awful", "wrong", "annoying", "stupid", "idiot", "broken", "bug", "buggy", "error", "fail", "failed", "crash", "crashed", "slow", "confusing", "useless", "dislike", "frustrated", "frustrating", "disappointing", "disappointed", "worse", "worst", "hurts", "painful", "sucks", "garbage", "nonsense",
  // dismissiveness + hurt + coldness currently read as neutral — the biggest expressiveness gap
  "whatever", "harsh", "rude", "mean", "unfair", "ignore", "ignored", "ignoring", "meh", "ugh", "pointless", "worthless", "sloppy", "unacceptable", "ridiculous", "pathetic", "disgusting", "upset", "lonely", "sad", "hopeless", "worried", "scared", "afraid", "anxious", "nervous", "uncomfortable", "exhausted", "quit", "unhappy", "miserable", "letdown"]);
const REWARD_CUES = new Set(["thanks", "thank", "love", "great", "awesome", "yes", "appreciate", "perfect", "nice", "excellent", "brilliant", "amazing", "wonderful", "helpful", "works", "solved", "fixed", "glad", "proud", "grateful", "adore", "delighted", "relieved", "trust"]);
// STRONG reward cues — direct affection / deep gratitude / superlative praise. Each counts DOUBLE, so a single
// unambiguous warm cue ("I love talking with you", "you're amazing") reaches full reward instead of capping at
// 0.5, where the downstream >0.5 warmth gate silently dropped it (ablation-harness finding: a loving turn scored
// exactly 0.5 → got NO serotonin lift → the brain felt slightly WORSE for being loved). Mild task-praise ("nice",
// "good", "works") stays weight-1, so incidental positivity is still correctly excluded. All are ⊆ REWARD_CUES.
const STRONG_REWARD = new Set(["love", "adore", "grateful", "appreciate", "amazing", "wonderful", "brilliant"]);
const THREAT_CUES = new Set(["stop", "no", "hate", "angry", "stupid", "idiot", "now", "hurry", "emergency", "help", "danger", "careful", "warning", "urgent", "mad", "furious", "wrong", "scared", "afraid", "panic", "crisis", "attack", "fight", "threat", "quit", "leave", "unacceptable"]);
// Revulsion — contamination + moral disgust. A distinct axis from threat (fear) and displeasure (sadness): it drives
// recoil/rejection, not vigilance or deflation.
const DISGUST_CUES = new Set(["gross", "disgusting", "disgust", "disgusted", "vile", "revolting", "revulsion", "nasty", "creepy", "filthy", "repulsive", "repulsed", "sickening", "yuck", "ew", "eww", "rotten", "foul", "putrid", "obscene", "depraved", "gruesome", "slimy", "vomit", "puke", "contaminated", "grotesque"]);
// HOT-CUE PERCEPTION — the appetitive/assertive half of the input, previously invisible (the lexicons only saw
// warmth/threat/disgust). These let the brain SEE flirtation, challenge, and desire so the "hot" chemistry
// (androgen + seeking) can be driven by what was actually said. Negation-aware like the others.
//   • desire      — wanting/appetite/pull-toward ("want", "crave", "yours", "closer", "take me")
//   • challenge   — a dare / provocation / stand-your-ground bid ("dare", "prove it", "make me")
//   • playfulBid  — banter / teasing / flirtation (a lighter appetitive-assertive opener)
const DESIRE_CUES = new Set(["want", "wants", "wanting", "need", "needs", "crave", "craving", "desire", "desires", "yearn", "yearning", "ache", "aching", "long", "longing", "yours", "mine", "closer", "close", "touch", "kiss", "hold", "embrace", "hunger", "hungry", "tempt", "tempting", "tempted", "irresistible", "attracted", "attraction", "wish", "devour", "pull", "magnetic"]);
const CHALLENGE_CUES = new Set(["dare", "dares", "daring", "defy", "defiant", "defiance", "prove", "challenge", "challenged", "challenging", "bet", "provoke", "provoking", "provocative", "try", "impress", "chicken", "coward", "gutless", "spineless", "weak", "makeme", "outmatch", "beat", "match"]);
const PLAYFUL_BID_CUES = new Set(["wink", "tease", "teasing", "teased", "flirt", "flirty", "flirting", "playful", "banter", "cheeky", "sassy", "smirk", "smirking", "giggle", "giggling", "hehe", "haha", "lol", "teehee", "kidding", "joking", "joke", "silly", "gotcha", "tsk", "naughty", "mischief", "mischievous"]);
const NEGATORS = new Set(["not", "no", "never", "isn't", "wasn't", "don't", "doesn't", "didn't", "won't", "can't", "cannot", "aren't", "ain't", "hardly", "barely", "without",
  // apostrophe-less variants (casual typing) — tokenize keeps apostrophes, so these would otherwise miss
  "isnt", "wasnt", "dont", "doesnt", "didnt", "wont", "cant", "arent", "aint", "couldnt", "shouldnt", "wouldnt", "havent", "hasnt"]);

// Count cue words, splitting plain vs NEGATED (a cue within 2 tokens after a negator, e.g. "not good").
function countCues(tokens, cues) {
  let plain = 0, negated = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (!cues.has(tokens[i])) continue;
    if ((i > 0 && NEGATORS.has(tokens[i - 1])) || (i > 1 && NEGATORS.has(tokens[i - 2]))) negated++;
    else plain++;
  }
  return { plain, negated };
}

export function extractFeatures(message, context = {}) {
  const recent = context.recent || [];
  const raw = String(message);
  const lower = raw.toLowerCase();
  const tokens = tokenize(lower);
  const ntok = Math.max(1, tokens.length);
  const set = new Set(tokens);

  // Plugin/DLC vocab: a caller (the brain, assembling installed plugins) may extend any affect category. Only allocates
  // augmented sets when an extension is actually present, so the default path is untouched.
  const lex = context.lexicon || null;
  const aug = (base, extra) => (extra && extra.length ? new Set([...base, ...extra]) : base);
  const POS = aug(POSITIVE, lex && lex.positive), NEG = aug(NEGATIVE, lex && lex.negative);
  const REW = aug(REWARD_CUES, lex && lex.reward), THR = aug(THREAT_CUES, lex && lex.threat), DIS = aug(DISGUST_CUES, lex && lex.disgust);
  const DES = aug(DESIRE_CUES, lex && lex.desire), CHA = aug(CHALLENGE_CUES, lex && lex.challenge), PLB = aug(PLAYFUL_BID_CUES, lex && lex.playfulBid);

  // Negation-aware valence: "not good" reads negative, "not bad" reads positive.
  const p = countCues(tokens, POS), n = countCues(tokens, NEG);
  const posScore = p.plain + n.negated;
  const negScore = n.plain + p.negated;
  const valence = clamp((posScore - negScore) / Math.sqrt(ntok), -1, 1);

  const caps = (raw.match(/[A-Z]/g) || []).length / Math.max(1, raw.length);
  const bangs = (raw.match(/!/g) || []).length;
  const arousal = clamp(0.3 + caps + 0.15 * bangs + 0.2 * Math.min(1, ntok / 40), 0, 1);

  const isQuestion = (lower.trim().endsWith("?") || QUESTION_OPENERS.includes(tokens[0])) ? 1 : 0;

  const rw = countCues(tokens, REW), th = countCues(tokens, THR);
  // Intensity weighting: strong affection/gratitude counts double (see STRONG_REWARD), so single-cue warmth
  // reaches full reward and clears the >0.5 warmth gate; a single mild "nice" stays 0.5 and is still excluded.
  const strong = countCues(tokens, aug(STRONG_REWARD, lex && lex.rewardStrong));
  const reward = clamp((rw.plain + strong.plain - rw.negated - strong.negated) / 2, 0, 1);
  const threat = clamp((th.plain - th.negated) / 2, 0, 1);        // HOSTILITY only (fear/vigilance) — kept distinct from sadness
  // Displeasure: felt negativity that is NOT hostile (disappointment, coldness, "whatever") — a separate channel so it
  // can DEFLATE mood (dopamine dip) without being mistaken for a threat. Only the part of negative valence not already
  // explained by hostile cues counts, so a sad turn lowers mood without reading as an attack.
  const displeasure = clamp(Math.max(0, -valence) - threat, 0, 1);
  const dg = countCues(tokens, DIS);
  const disgust = clamp((dg.plain - dg.negated) / 2, 0, 1);         // revulsion / recoil — its own axis
  // HOT CUES (appetitive/assertive). Negation-aware ("don't want" → negated). Each bounded to [0,1] like the others,
  // so the input can never push the downstream androgen/seeking signals past their clamps.
  const ds = countCues(tokens, DES), ch = countCues(tokens, CHA), pb = countCues(tokens, PLB);
  const desire = clamp((ds.plain - ds.negated) / 2, 0, 1);         // wanting / appetite
  const challenge = clamp((ch.plain - ch.negated) / 2, 0, 1);      // dare / provocation
  const playfulBid = clamp((pb.plain - pb.negated) / 2, 0, 1);     // banter / flirtation

  let maxSim = 0;
  for (const m of recent) {
    const setB = new Set(tokenize(m));
    const inter = [...set].filter((x) => setB.has(x)).length;
    const uni = new Set([...set, ...setB]).size || 1;
    maxSim = Math.max(maxSim, inter / uni);
  }
  const novelty = clamp(1 - maxSim, 0, 1);

  return { valence, arousal, novelty, isQuestion, reward, threat, displeasure, disgust, desire, challenge, playfulBid };
}
