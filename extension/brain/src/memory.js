// Minimal in-memory recall/remember seam (used as a lightweight test double). The full persisted
// store with the same interface is declarativeStore.js.
//
// Retrieval is a COMPOSED relevance score (house pattern mirrors rook-mesh/src/cubeRecall.js): relevance LEADS,
// recency + salience are light MODIFIERS that only break ties. It is PURE — no clock/random/network/IO; `now` is
// injected per call if needed. It degrades gracefully: with no query text it returns pure recency order (the old
// behaviour); with a query it scores each episode by keyword/semantic relevance.
//
// SEMANTIC axis: if an `embed(text)->vector` fn is injected (or an episode carries `.embedding`), we blend cosine
// similarity. ABSENT, we fall back to an IDF-WEIGHTED-COSINE keyword scorer — NOT raw keyword overlap. IDF
// down-weights common words and the unmatched distinctive (rare, high-idf) query word inflates the query norm, so a
// lone shared common word ("favorite dinosaur" ↔ "favorite coffee") scores near zero instead of 0.5.

const STOP = new Set(("a an the i you your my me of is are was were do did to in on at for it s t as now then " +
  "what where who when why how and or but not with about this that these those be been being have has had").split(" "));
const words = (s) => (String(s == null ? "" : s).toLowerCase().match(/[a-z0-9]+/g) || []);
const contentWords = (s) => [...new Set(words(s).filter((w) => !STOP.has(w) && w.length > 1))];
const cosine = (a, b) => {
  if (!Array.isArray(a) || !Array.isArray(b)) return 0;
  let dot = 0, na = 0, nb = 0, n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return (na && nb) ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
};

// Pull query text out of whatever the caller passes: a string message, or a features object (e.g. {message,text}).
// Empty / bare-features ({}) → "" → pure recency (no-arg callers keep the old behaviour).
function queryTextOf(q) {
  if (q == null) return "";
  if (typeof q === "string") return q;
  if (typeof q === "object") return String(q.text || q.message || q.query || q.cue || "");
  return String(q);
}
// The searchable text of a stored episode.
const episodeText = (e) => `${e && e.message != null ? e.message : ""} ${e && e.reply != null ? e.reply : ""}`;

export function makeMemory({ embed = null, weights = {} } = {}) {
  const episodes = [];
  // Relevance LEADS; recency + salience only modify. (Empty query → relevance 0 for all → recency/salience decide,
  // and we short-circuit to slice(-limit) to preserve the exact legacy order.)
  const W = { relevance: 1.0, recency: 0.15, salience: 0.15, ...weights };

  // IDF over the current episode set, recomputed per recall (the store is small; this stays cheap and pure).
  function idfIndex() {
    const df = new Map();
    for (const e of episodes) { for (const w of contentWords(episodeText(e))) df.set(w, (df.get(w) || 0) + 1); }
    const N = episodes.length;
    return (w) => Math.max(0.01, Math.log((N + 1) / ((df.get(w) || 0) + 1)));
  }
  // idf-weighted cosine over content-word sets (cubeRecall's idfCosine): a lone common-word overlap scores ~0.
  function idfCosine(qWords, dWords, idfOf) {
    if (!qWords.length || !dWords.length) return 0;
    const dSet = new Set(dWords);
    let dot = 0, nq = 0, nd = 0;
    for (const w of qWords) { const v = idfOf(w); nq += v * v; if (dSet.has(w)) dot += v * v; }
    for (const w of dWords) { const v = idfOf(w); nd += v * v; }
    return (nq && nd) ? dot / (Math.sqrt(nq) * Math.sqrt(nd)) : 0;
  }

  function score(qText, qVec, qWords, idfOf, e, recency) {
    let relevance;
    if (qVec && Array.isArray(e.embedding) && e.embedding.length) relevance = Math.max(0, cosine(qVec, e.embedding));
    else relevance = idfCosine(qWords, contentWords(episodeText(e)), idfOf);
    const salience = Math.max(0, Math.min(1, Number(e.surprise ?? e.importance ?? e.salience ?? 0) || 0));
    return W.relevance * relevance + W.recency * recency + W.salience * salience;
  }

  return {
    remember(episode) { episodes.push({ ...episode }); },
    // recall(query, limit, opts) — query may be a string, a features object, or omitted.
    //   No query text → most-recent `limit` in chronological order (legacy behaviour, unchanged).
    //   With query text → COMPOSED relevance score (idf-keyword, or embedding cosine when available), returned
    //   best-first. relevance leads; recency + salience break ties so a relevant-but-older memory outranks a
    //   recent-but-irrelevant one. Return shape (array of episode objects) is preserved.
    recall(query, limit = 3, _opts = {}) {
      const qText = queryTextOf(query);
      if (!qText.trim() || episodes.length === 0) return episodes.slice(-limit);

      const qWords = contentWords(qText);
      const idfOf = idfIndex();
      const qVec = embed ? embed(qText) : null;
      const n = episodes.length;
      const scored = episodes.map((e, i) => ({
        e,
        // recency ∈ (0,1], newest = 1; a light tie-breaker, not the lead signal.
        s: score(qText, qVec, qWords, idfOf, e, n <= 1 ? 1 : (i + 1) / n),
        i,
      }));
      scored.sort((a, b) => (b.s - a.s) || (b.i - a.i));
      return scored.slice(0, limit).map((x) => x.e);
    },
    all() { return episodes; },
  };
}
