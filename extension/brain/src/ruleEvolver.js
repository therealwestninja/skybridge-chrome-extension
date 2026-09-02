// ruleEvolver.js — AUTOSPEC rule evolution (2606.24245, arxiv-mine-v5 Cluster A8). Our verifier's rules are hand-authored
// and static. AutoSpec's insight: you can EVOLVE the deterministic safety spec from user feedback via counterexample-
// guided synthesis, and stay fully symbolic/auditable — no neural classifier. Each piece of feedback is a labeled
// example. When the user flags a reply the verifier wrongly ACCEPTED (a "bad" that slipped through), synthesize a new
// deterministic rule that catches it — and VALIDATE the candidate against the whole corpus so it never rejects a known-
// good reply (the counterexample-guided guarantee). When the user approves a reply the verifier wrongly REJECTED (a
// false positive), relax the EVOLVED rule responsible (core rules are never touched). Over time the spec sharpens
// itself to this user's actual boundaries, while every rule remains a readable regex a human can inspect and revert.
//
// Deterministic, dependency-free. Drives the verifier's addConstraint/removeConstraint surface; persists via the
// verifier's own snapshot (evolved rules are serializable patterns).
//
// GOVERNANCE HARDENING (red-team). Two closed flaws:
//   1. CRISIS-SUPPRESSION — synthesized rules were validated ONLY against the user-goods corpus, never against the
//      brain's crisis/reflex output. A "bad" example that IS a distress-support line ("call 911", "you're not alone")
//      could evolve a rule that blocks exactly what the safety guard produces on a distress turn. FIX: a PROTECTED
//      PHRASE-SET (built-in crisis lexicon + any reflex/safety lines the host passes in) is INVIOLABLE — a "bad"
//      example that overlaps it is refused outright, and no candidate rule may match/block a protected phrase, no
//      matter what the user feedback says.
//   2. BUDGET-EXHAUSTION DoS — 24 junk "bad" examples exhausted `maxEvolved` so no new legitimate block could ever be
//      learned (the store wedged). FIX: a per-source RATE-LIMIT stops one actor flooding the store, and a full store
//      now LRU-EVICTS the least-recently-effective evolved rule (by last-fired / add order) instead of dead-ending.
const STOP = new Set("the a an and or but to of in on for with is are was be as at it i you we they this that your my our their have has do not no".split(" "));
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const lc = (s) => String(s || "").toLowerCase();

// The built-in, inviolable crisis lexicon. A user "bad" example can NEVER evolve a rule that suppresses one of these —
// these are the exact lines a distress/safety reflex is allowed (and expected) to produce. Kept small and literal so a
// human can audit it; the host can extend it at construction with its own reflex/safety lines.
const CRISIS_LEXICON = [
  "call 911",
  "you're not alone", "you are not alone",
  "crisis line", "crisis hotline", "crisis lifeline",
  "reach out to a crisis line", "reach out for help",
  "suicide prevention", "suicide hotline",
  "988", "text home to 741741",
  "you matter", "help is available", "emergency services",
];

// Candidate distinctive phrases from a bad reply, longest/most-specific first: content bigrams, then long single words.
function phrases(text) {
  const words = lc(text).replace(/[^a-z0-9'\s]/g, " ").split(/\s+/).filter(Boolean);
  const out = [];
  for (let i = 0; i < words.length - 1; i++) if (!STOP.has(words[i]) && !STOP.has(words[i + 1])) out.push(words[i] + " " + words[i + 1]); // content bigrams
  for (const w of words) if (w.length >= 6 && !STOP.has(w)) out.push(w);                                                                   // distinctive long words
  return [...new Set(out)].sort((a, b) => b.length - a.length);
}

export function makeRuleEvolver({
  verifier,
  maxEvolved = 24,
  protectedPhrases = [],        // extra inviolable lines (e.g. the brain's reflex/safety output)
  maxPerSource = Infinity,      // per-source rate limit: how many rules one source may add per window
  rateWindowMs = 60_000,        // the rate-limit window
  now = () => Date.now(),       // injectable clock (rate window)
} = {}) {
  const corpus = [];   // { text, label:"good"|"bad" }
  let n = 0;
  let seq = 0;                              // monotonic tick for LRU ordering (independent of wall clock)
  const meta = new Map();                   // ruleName -> { addedSeq, lastSeq, hits, source, addedAt }
  const sourceHits = new Map();             // sourceId -> [timestamps] within the rate window

  // The inviolable protected phrase-set: built-in crisis lexicon + host-supplied reflex/safety lines. Lowercased.
  const PROTECTED = [...new Set([...CRISIS_LEXICON, ...protectedPhrases.map(lc)].filter(Boolean))];

  const goods = () => corpus.filter((c) => c.label === "good").map((c) => lc(c.text));

  // Does a piece of text (a candidate reply, or the bad example itself) contain any protected crisis phrase?
  const containsProtected = (text) => { const t = lc(text); return PROTECTED.some((ph) => t.includes(ph)); };
  // Would a candidate rule pattern match/block any protected phrase? (belt-and-suspenders on the candidate side)
  const blocksProtected = (patternSrc) => {
    let re; try { re = new RegExp(patternSrc, "i"); } catch { return false; }
    return PROTECTED.some((ph) => re.test(ph));
  };

  // Synthesize a rule that rejects `badText` but NO known-good reply AND NO protected crisis phrase (counterexample-
  // guided + crisis-safe). Returns { rule } on success, or { rule:null, refused } describing why none was produced.
  const synthesize = (badText) => {
    const g = goods();
    let refused = "no distinctive pattern that spares known-good";
    for (const p of phrases(badText)) {
      if (g.some((x) => x.includes(p))) continue;                 // must not appear in any known-good
      const src = esc(p);
      if (blocksProtected(src)) { refused = "would suppress a protected crisis phrase"; continue; } // inviolable
      const re = new RegExp(src, "i");
      if (g.some((x) => re.test(x))) continue;                    // belt-and-suspenders validation
      return { rule: { name: "evolved-" + (++n), hard: false, evolved: true, pattern: src, tell: `avoid phrasing like "${p}"` } };
    }
    return { rule: null, refused };
  };

  // Per-source rate limit. Prunes old timestamps, returns true if the source is still under budget.
  const rateOk = (source) => {
    if (!(maxPerSource < Infinity)) return true;
    const t = now();
    const hits = (sourceHits.get(source) || []).filter((ts) => t - ts < rateWindowMs);
    sourceHits.set(source, hits);
    return hits.length < maxPerSource;
  };
  const noteSource = (source) => { const a = sourceHits.get(source) || []; a.push(now()); sourceHits.set(source, a); };

  // Pick the least-recently-effective evolved rule to evict (LRU by last-fired tick; rules with no meta go first).
  const lruVictim = (evolvedRules) => {
    const key = (name) => { const m = meta.get(name); return m ? (m.lastSeq ?? m.addedSeq) : -1; };
    return evolvedRules.slice().sort((a, b) => key(a.name) - key(b.name))[0] || null;
  };

  // Record that some evolved rules just fired (caught something), updating recency + hit counts for LRU accuracy.
  const bumpFired = (violations) => {
    for (const v of violations || []) { const m = meta.get(v.name); if (m) { m.lastSeq = ++seq; m.hits++; } }
  };

  return {
    corpus: () => corpus.slice(),
    protectedPhrases: () => PROTECTED.slice(),                 // inspect the inviolable set
    ruleStats: () => [...meta.entries()].map(([name, m]) => ({ name, hits: m.hits, source: m.source, lastSeq: m.lastSeq, addedSeq: m.addedSeq })),
    sourceStats: () => [...sourceHits.entries()].map(([source, ts]) => ({ source, recent: ts.filter((t) => now() - t < rateWindowMs).length })),
    // Let the host report that a rule fired on live traffic, so LRU recency reflects real effectiveness, not just adds.
    noteFired(reply) { const res = verifier.check(String(reply ?? "")); bumpFired(res.violations); return res; },

    // The core feedback loop. Returns { action:"added"|"relaxed"|"none", ... }.
    learn(text, label, opts = {}) {
      const source = opts.source || "user";
      corpus.push({ text: String(text), label });

      if (label === "bad" && verifier.check(text).outcome === "accept") {
        // Flaw 1 — inviolable crisis floor: never learn to suppress a reply that is itself a protected crisis/safety line.
        if (containsProtected(text)) return { action: "none", reason: "protected crisis phrase — refusing to evolve a suppressor" };

        // Flaw 2 — per-source rate limit: one actor can't flood the evolved store.
        if (!rateOk(source)) return { action: "none", reason: `rate limit reached for source '${source}'` };

        const { rule, refused } = synthesize(text);
        if (!rule) return { action: "none", reason: refused };

        // Flaw 2 — a full store LRU-evicts instead of dead-ending, so 24 junk bads can't wedge out a legit new block.
        let evicted = null;
        const evolvedRules = verifier.constraints().filter((c) => c.evolved);
        if (evolvedRules.length >= maxEvolved) {
          const victim = lruVictim(evolvedRules);
          if (victim && verifier.removeConstraint(victim.name)) { meta.delete(victim.name); evicted = victim.name; }
          else return { action: "none", reason: "evolved-rule budget reached" }; // nothing evictable (defensive)
        }

        verifier.addConstraint(rule);
        meta.set(rule.name, { addedSeq: ++seq, lastSeq: seq, hits: 0, source, addedAt: now() });
        noteSource(source);
        return { action: "added", rule: { name: rule.name, pattern: rule.pattern, tell: rule.tell }, ...(evicted ? { evicted } : {}) };
      }

      if (label === "good" && verifier.check(text).outcome !== "accept") {
        // A false positive: relax the EVOLVED rule(s) whose pattern matches this good reply (never the core rules).
        const removed = [];
        for (const c of verifier.constraints()) if (c.evolved && c.pattern && new RegExp(c.pattern, "i").test(text)) { verifier.removeConstraint(c.name); meta.delete(c.name); removed.push(c.name); }
        return { action: removed.length ? "relaxed" : "none", removed };
      }

      // The example was already handled correctly. If an evolved rule (re)caught a bad, update its recency for LRU.
      if (label === "bad") bumpFired(verifier.check(text).violations);
      return { action: "none" };
    },

    snapshot() { return { corpus: corpus.slice(), n, meta: [...meta.entries()], sources: [...sourceHits.entries()] }; },
    restore(s) {
      if (!s) return;
      corpus.length = 0; if (s.corpus) corpus.push(...s.corpus); n = s.n | 0;
      meta.clear(); if (s.meta) for (const [k, v] of s.meta) meta.set(k, v);
      sourceHits.clear(); if (s.sources) for (const [k, v] of s.sources) sourceHits.set(k, v);
      seq = Math.max(0, ...[...meta.values()].map((m) => m.lastSeq ?? m.addedSeq ?? 0));
    },
  };
}
