// world.js — a model of the USER'S WORLD (mined + companion-tuned from epic-dm's GM "world that remembers you").
// The brain's theory-of-mind models the ONE person you're talking to; this models everyone/everything AROUND them:
//   • CAST     — named people the user mentions (proper names AND relationship words: mom, boss, Sarah), each with the
//                felt WARMTH of that relationship (from how the user describes it) + a short memory of what happened.
//   • THREADS  — open loops the user raised that invite a follow-up: a plan, a worry, an upcoming event ("interview
//                tomorrow"). This is what gives proactivity something concrete to reach out ABOUT.
//   • EVENTS   — big life events the world remembers ("got the job", "we broke up").
// Feeds a prompt block (attend to their world; remember the people, don't reset them) + exposes open threads for
// proactivity. Pure incremental state, grounded (extractive — never invents a person or an event). Off by default.
import { clamp } from "./math.js";

// Common relationship/role nouns — a companion's "cast" is mostly these, not proper names (mined idea, new word-set).
const RELATION = ["mom", "mum", "mother", "dad", "father", "sister", "brother", "wife", "husband", "partner", "girlfriend",
  "boyfriend", "son", "daughter", "friend", "boss", "manager", "coworker", "colleague", "roommate", "neighbor", "neighbour",
  "doctor", "therapist", "teacher", "coach", "grandma", "grandpa", "aunt", "uncle", "cousin", "landlord", "ex"];
const RELATION_SET = new Set(RELATION);
const CAST_STOP = new Set(["the", "and", "but", "for", "her", "his", "him", "she", "they", "them", "you", "your", "our", "who",
  "what", "when", "where", "why", "how", "mr", "mrs", "ms", "dr", "sir", "yes", "yeah", "okay", "well", "then", "there", "here",
  "now", "soon", "later", "again", "still", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "june", "july", "august", "september", "october", "november", "december", "i", "im"]);

const WARM_W = ["help", "helped", "love", "loved", "hug", "thank", "proud", "support", "care", "cared", "laugh", "laughed",
  "enjoy", "enjoyed", "miss", "missed", "kind", "sweet", "fun", "happy", "grateful", "celebrate", "together", "close", "trust"];
const COLD_W = ["fought", "fight", "argued", "argue", "yelled", "hurt", "angry", "mad", "betrayed", "ignored", "upset",
  "hate", "hated", "annoyed", "cruel", "lied", "cold", "distant", "abandoned", "rejected", "jealous", "resent"];
const hits = (text, words) => { const t = " " + String(text).toLowerCase() + " "; let n = 0; for (const w of words) if (t.includes(" " + w)) n++; return n; };
const readWarmth = (text) => hits(text, WARM_W) - hits(text, COLD_W);

// The people mentioned this turn: relationship nouns (lowercase, whole-word) + proper names (Capitalised mid-sentence,
// recurring — the epic-dm proper-noun signal), possessive-stripped, contraction-guarded.
function mentioned(text) {
  const out = new Set(), t = String(text || "");
  for (const r of RELATION) if (new RegExp("\\b" + r + "\\b", "i").test(t)) out.add(r);
  const re = /[a-z,;:’')\-”"]\s+([A-Z][a-zA-Z’'-]{2,})\b/g; let m;
  while ((m = re.exec(t))) { const w = m[1].replace(/[’']s?$/, ""); const lw = w.toLowerCase().replace(/’/g, "'"); if (w.length < 3 || CAST_STOP.has(lw) || /'(m|ve|d|ll|re|s|t)$/.test(lw)) continue; out.add(w); }
  return [...out];
}

// Open loops worth following up on: an upcoming/planned thing, a worry, an intention. Grounded — a lightly-cleaned
// clause of what the user actually said, never invented.
function detectThreads(text) {
  const out = [];
  for (const s of String(text).split(/(?<=[.!?])\s+|\n+/)) {
    const q = s.trim(); if (q.length < 8 || q.length > 140) continue;
    if (/\b(tomorrow|next week|next month|this weekend|later today|on (mon|tues|wednes|thurs|fri|satur|sun)day|upcoming|coming up)\b/i.test(q)
      || /\b(i(?:'m| am) (?:worried|nervous|anxious|scared|hoping|excited|planning)|i(?:'ve| have) (?:a|an|got)|i need to|i have to|i(?:'m| am) going to|i want to|thinking about|i might)\b/i.test(q))
      out.push(q.replace(/\s+/g, " "));
  }
  return out.slice(0, 2);
}
const BIG_EVENT = /\b(got (?:the|a) (?:job|offer|promotion)|quit|got fired|laid off|moved (?:in|out|to)|broke up|got (?:engaged|married|divorced)|had (?:a|the) baby|graduated|got into|passed (?:the|my)|failed (?:the|my)|diagnosed|passed away|started (?:a|my|the) (?:new )?job)\b/i;

export function makeWorld({ maxCast = 40, warmGain = 0.6, threadTtl = 25, beliefHalfLife = 40, staleFloor = 0.5, minImpact = 0.35 } = {}) {
  let cast = {}, threads = [], events = [], threadSeq = 0, tick = 0;

  function present(text) { return mentioned(text).map((n) => cast[nameKey(n)]).filter(Boolean).filter((c) => c.mem.length || Math.abs(c.warmth) > 0.4); }
  const nameKey = (n) => (RELATION_SET.has(n.toLowerCase()) ? n.toLowerCase() : n);
  const dispositionWord = (c) => (c.warmth > 1.2 ? "a warm, close relationship" : c.warmth < -1.2 ? "a strained relationship" : "a relationship still finding its footing");
  // Decaying belief confidence (mined 2606.28384): a belief the user hasn't touched in a long time is STALE, not stale-
  // but-certain. Confidence halves every ~beliefHalfLife turns without a re-mention, floored so it never fully vanishes.
  const _conf = (c) => clamp(Math.pow(2, -Math.max(0, tick - (c.lastTick || 0) - 1) / beliefHalfLife), 0.05, 1); // -1: a just-mentioned person (tick advances at end of observe) is fully fresh, then decays
  // Significance: how much this person matters (emotional charge + how often they come up) — what to bother re-checking.
  const _impact = (c) => clamp(Math.abs(c.warmth) / 3 * 0.6 + Math.min(1, (c.mentions || 0) / 5) * 0.4);

  return {
    // Fold one turn (the user's message; the reply is optional context) into the world model.
    observe(message = "", reply = "") {
      const names = mentioned(message);
      const warmth = readWarmth(message);
      for (const raw of names) {
        const name = nameKey(raw);
        const existed = !!cast[name];
        const c = cast[name] || (cast[name] = { name: raw, warmth: 0, mentions: 0, mem: [], lastTick: 0, priorTick: 0 });
        if (existed) c.priorTick = c.lastTick; // capture the gap since the LAST mention, so the block can flag a re-raise after a long absence
        c.mentions++; c.lastTick = tick;
        c.warmth = clamp(c.warmth + warmth * warmGain, -3, 3);
        const snip = String(message).trim().replace(/\s+/g, " ").slice(0, 90);
        if (snip && c.mem[c.mem.length - 1] !== snip) { c.mem.push(snip); if (c.mem.length > 3) c.mem.shift(); }
      }
      // cap the cast (drop the least-mentioned, oldest)
      const keys = Object.keys(cast);
      if (keys.length > maxCast) keys.sort((a, b) => (cast[a].mentions - cast[b].mentions) || (cast[a].lastTick - cast[b].lastTick)).slice(0, keys.length - maxCast).forEach((k) => delete cast[k]);
      for (const th of detectThreads(message)) if (!threads.some((t) => t.text === th)) threads.push({ id: ++threadSeq, text: th, status: "open", tick });
      // Threads are short-lived FOLLOW-UP items, not permanent (bench-longitudinal meter F): an "interview tomorrow"
      // raised 30 turns ago is stale, not still-open. Age them out so the companion follows up on RECENT things and the
      // open set doesn't pile up to the cap forever.
      threads = threads.filter((t) => tick - t.tick <= threadTtl);
      if (threads.length > 12) threads = threads.slice(-12);
      const ev = BIG_EVENT.test(message) ? String(message).trim().replace(/\s+/g, " ").slice(0, 120) : null;
      if (ev && !events.includes(ev)) { events.push(ev); if (events.length > 10) events.shift(); }
      tick++;
      return { names, threads: threads.filter((t) => t.status === "open").length };
    },

    // The prompt block: who's in play (with the companion's memory of them), what to follow up on, what the user has been through.
    block(message = "") {
      const parts = [], inPlay = present(message);
      // Provenance/staleness-aware presentation (mined 2605.19838 + build #1 decaying confidence): these are things the
      // user TOLD you (stated, high-trust), but a relationship that hasn't come up in a long while may be out of date —
      // present a re-raised stale belief as held-loosely, not asserted as current, so the mouth invites an update.
      if (inPlay.length) parts.push("People in their life who are in play — these are things they've TOLD you; remember them, don't reset them:\n" + inPlay.slice(0, 4).map((c) => {
        const stale = c.mentions > 1 && (tick - 1 - (c.priorTick ?? c.lastTick)) > beliefHalfLife;
        return "- " + c.name + ": " + dispositionWord(c) + (c.mem.length ? ". Recently: " + c.mem.slice(-1)[0] : "") + (stale ? " (it's been a while since they came up — what you remember may be out of date; hold it loosely and let them update you)" : "");
      }).join("\n"));
      const open = threads.filter((t) => t.status === "open");
      if (open.length) parts.push("Open threads to gently follow up on when it fits:\n" + open.slice(-3).map((t) => "- " + t.text).join("\n"));
      if (events.length) parts.push("Big things they've been through (hold these with care):\n" + events.slice(-3).map((e) => "- " + e).join("\n"));
      return parts.join("\n\n");
    },

    // Active user-model (mined 2606.28384): the things worth PROACTIVELY raising — SIGNIFICANT people whose belief has
    // gone stale (they matter AND haven't come up lately), plus open threads. Ranked by salience so proactivity gets one
    // concrete, grounded reason+topic to reach out. This is what decaying confidence buys: knowing what to re-check.
    followups({ max = 3 } = {}) {
      const out = [];
      for (const c of Object.values(cast)) {
        const conf = _conf(c), imp = _impact(c);
        if (imp >= minImpact && conf < staleFloor) out.push({ kind: "person", name: c.name, text: `check in about ${c.name} — they matter to them and haven't come up in a while`, salience: +(imp * (1 - conf)).toFixed(3) });
      }
      for (const t of threads.filter((t) => t.status === "open")) out.push({ kind: "thread", text: t.text, salience: +clamp(0.35 + 0.35 * (t.tick / (tick || 1))).toFixed(3) });
      return out.sort((a, b) => b.salience - a.salience).slice(0, max);
    },
    confidence(name) { const c = cast[nameKey(name)]; return c ? +_conf(c).toFixed(2) : 0; },
    openThreads: () => threads.filter((t) => t.status === "open").map((t) => ({ ...t })),
    resolveThread(id) { const t = threads.find((x) => x.id === id); if (t) t.status = "resolved"; return !!t; },
    cast: () => Object.values(cast).map((c) => ({ name: c.name, warmth: +c.warmth.toFixed(2), mentions: c.mentions })),
    serialize: () => ({ cast, threads, events, threadSeq, tick }),
    restore(s) { if (!s) return; cast = s.cast || {}; threads = s.threads || []; events = s.events || []; threadSeq = s.threadSeq || 0; tick = s.tick || 0; },
  };
}
