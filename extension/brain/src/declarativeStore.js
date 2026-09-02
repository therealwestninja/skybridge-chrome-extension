// The real declarative memory: episodes + user-authored facts, semantic recall with keyword
// fallback, full CRUD, export/import. (The lightweight in-memory seam is memory.js.)
import { cosine } from "./embedder.js";
import { tokenize } from "./text.js";
import { structuralSalience } from "./salience.js";
import { buildIndex, blastRadius, describe as describeRipple } from "./memoryRipple.js";
import { makeShrinkGuard } from "./shrinkGuard.js";

export function makeDeclarativeStore({ storage, embedder, now = () => 0, id, key = "memories", maxEpisodes = 200, modelSourceWeight = 0.5, mmrLambda = 0.7, shrinkRatio = 0.5, shrinkFloor = 8, onShrinkBlock = null }) {
  let counter = 0;
  const genId = id || (() => `m${counter++}`);
  let records = [];
  let episodesEver = 0; // monotonic count of episodes ever remembered (pruning never decrements it)
  // Per-record tokenized-text cache (id -> Set). recall() keyword-scores EVERY record each turn; without
  // this it re-tokenizes the whole (growing) store per turn = O(episodes) latency creep. Kept in memory
  // only (not persisted/serializable); lazily filled, invalidated on text change, cleaned on removal.
  const tokCache = new Map();
  const toksOf = (r) => { let s = tokCache.get(r.id); if (!s) { s = new Set(tokenize(r.text || "")); tokCache.set(r.id, s); } return s; };

  // Guard the DURABLE copy: never overwrite it with a suddenly-tiny set (a runtime bug that empties `records` would
  // otherwise silently wipe memory). A refused write keeps the last good copy, so the bad in-memory state self-heals on
  // the next load. clear()/import() pass {intentional} and are always allowed. Protects an in-session shrink from a
  // known-good baseline (lastGoodCount) — the real risk; a durable copy that is ALREADY truncated is out of scope.
  const shrinkGuard = makeShrinkGuard({ ratio: shrinkRatio, floor: shrinkFloor });
  let lastGoodCount = 0;
  const persist = async ({ intentional = false } = {}) => {
    const g = shrinkGuard.check(lastGoodCount, records.length, { intentional });
    if (!g.ok) { try { if (onShrinkBlock) onShrinkBlock({ ...g, prev: lastGoodCount, next: records.length }); } catch {} return; }
    await storage.set(key, records);
    lastGoodCount = records.length;
  };
  const safeEmbed = async (text) => {
    if (!embedder) return undefined;
    const v = await embedder.embed(text);
    return Array.isArray(v) ? v : undefined; // guard against a malformed/non-array embedding
  };
  const keywordScore = (queryToks, set) => {
    if (set.size === 0 || queryToks.length === 0) return 0;
    let hit = 0;
    for (const t of queryToks) if (set.has(t)) hit++;
    return hit / queryToks.length;
  };
  // Forgetting: cap the number of EPISODES; drop the LOWEST-VALUE unpinned ones beyond the cap, where
  // value = structural salience + a recency bonus. So a dense, specific old memory outlives boring
  // recent chatter. Facts (user-authored) and pinned records are never forgotten.
  function pruneEpisodes() {
    const eps = records.filter((r) => r.type === "episode");
    if (eps.length <= maxEpisodes) return;
    const maxTs = Math.max(1, ...eps.map((r) => r.timestamp || 0));
    // NM2b: value = structural salience + recency + SURPRISE. A high-surprise (novel/important) episode
    // resists eviction; routine low-surprise chatter fades first, so the store keeps what mattered.
    const value = (r) => (r.salience || 0) + 3 * ((r.timestamp || 0) / maxTs) + 1.5 * (r.surprise || 0);
    const droppable = eps.filter((r) => !r.pinned).sort((a, b) => value(a) - value(b)); // lowest value first
    const remove = new Set(droppable.slice(0, eps.length - maxEpisodes).map((r) => r.id));
    if (remove.size) { records = records.filter((r) => !remove.has(r.id)); for (const rid of remove) tokCache.delete(rid); }
  }

  // Provenance (8.1 echo-chamber guard): every record is user- or model-sourced. Episodes carry the
  // USER's message as .text -> user-sourced; only distilled/reconciled FACTS are model-generated. Recall
  // down-weights model-sourced records so a hallucinated self-echo can't outrank ground truth. Default
  // "user" keeps legacy records (no source field) and normal facts at full weight.
  const srcWeight = (r) => (r.source === "model" ? modelSourceWeight : 1);

  // Record-to-record similarity for the MMR diversity pass: cosine on vectors when both have them,
  // else token Jaccard. Used to stop near-duplicate records (e.g. multiple distilled copies of the same
  // fact) from crowding out distinct context in the top-K (002 §1.2 semantic crowding).
  const recSim = (a, b) => {
    // A theme (L2) node and one of its own member facts are redundant — MMR should never return both a summary and a
    // record it summarizes in the same top-K (collapsed-tree de-dup, hierarchical memory Phase 2).
    if ((a.type === "theme" && Array.isArray(a.members) && a.members.includes(b.id)) ||
        (b.type === "theme" && Array.isArray(b.members) && b.members.includes(a.id))) return 1;
    if (a.vector && b.vector) return Math.max(0, cosine(a.vector, b.vector));
    const sa = toksOf(a), sb = toksOf(b);
    if (sa.size === 0 || sb.size === 0) return 0;
    let inter = 0; for (const t of sa) if (sb.has(t)) inter++;
    return inter / (sa.size + sb.size - inter);
  };

  async function add(rec) {
    // Honor an explicit vector (the hierarchy layer writes L2 theme nodes with the cluster CENTROID, not the
    // summary text's embedding) — otherwise embed the text. Avoids a wasted embed on every theme-node write.
    const vector = (Array.isArray(rec.vector) && rec.vector.length) ? rec.vector : await safeEmbed(rec.text);
    // NM2a: stateRole tracks a fact's lifecycle -- "current" (live), "historical" (superseded, kept for
    // audit/forensics, filtered out of default recall), "transition". Absent == "current" (back-compat).
    const full = { id: genId(), tags: [], pinned: false, source: "user", stateRole: "current", timestamp: now(), vector, ...rec };
    if (full.type === "episode") episodesEver++;
    records.push(full);
    if (full.type === "episode") pruneEpisodes();
    await persist();
    return full;
  }

  return {
    add, // expose the low-level writer so the hierarchy layer can write L2 theme nodes (explicit centroid vector + members)
    async load() {
      const saved = await storage.get(key);
      records = Array.isArray(saved) ? saved : [];
      lastGoodCount = records.length;   // the loaded set is the baseline the shrink-guard protects
      episodesEver = records.filter((r) => r.type === "episode").length;
      tokCache.clear(); // rebuilt lazily by recall()
      return records;
    },
    episodesEver: () => episodesEver,
    async remember(episode) {
      const text = episode.message ?? "";
      // RM4: stamp the activation signature the episode was formed under (if the caller supplies one).
      const rec = { type: "episode", text, reply: episode.reply ?? "", tags: episode.tags || [], salience: structuralSalience(text) };
      if (Array.isArray(episode.sig) && episode.sig.length) rec.sig = episode.sig;
      if (episode.surprise != null) rec.surprise = +episode.surprise; // NM2b: bias eviction toward low-surprise chatter
      return add(rec);
    },
    async addFact(text, { tags = [], pinned = false, source = "user", sig = null, vector = null, basis = null } = {}) {
      const rec = { type: "fact", text, tags, pinned, source };
      if (Array.isArray(sig) && sig.length) rec.sig = sig;
      if (Array.isArray(vector) && vector.length) rec.vector = vector;   // caller already embedded this text (e.g. the write-path reconcile recall) — reuse it, don't re-embed
      if (Array.isArray(basis) && basis.length) rec.basis = basis;       // REAL derivation edge: the source ids this fact was derived from (memoryRipple)
      return add(rec);
    },
    // NM2a: supersede a fact instead of deleting it — the old record is kept but marked "historical" (with
    // a supersededBy link + timestamp), so default recall no longer serves the stale version alongside the
    // new one ("ghost memory"), while the history stays auditable + reversible. Returns the new record.
    async supersede(oldId, { text, tags = [], source = "user", sig = null } = {}) {
      // ADVISORY blast-radius over REAL edges, computed on the pre-change state — surfaces what rests on the memory
      // being superseded. It NEVER blocks the supersede (agency/honesty); the caller decides what to do with it.
      const radius = blastRadius(buildIndex(records), oldId);
      const ripple = { count: radius.length, radius, note: describeRipple(oldId, radius) };

      const rec = { type: "fact", text, tags, pinned: false, source };
      if (Array.isArray(sig) && sig.length) rec.sig = sig;
      const added = await add(rec);
      const old = records.find((r) => r.id === oldId);
      if (old) { old.stateRole = "historical"; old.supersededBy = added.id; old.supersededAt = now(); await persist(); }
      // Return a shallow copy carrying the advisory; the stored record in `records` stays clean.
      return { ...added, ripple };
    },
    get(id_) { return records.find((r) => r.id === id_) || null; },
    list({ type, tag } = {}) {
      return records.filter((r) => (!type || r.type === type) && (!tag || r.tags.includes(tag)));
    },
    async update(id_, patch) {
      const r = records.find((x) => x.id === id_);
      if (!r) return null;
      Object.assign(r, patch);
      if (patch.text !== undefined) { r.vector = await safeEmbed(r.text); tokCache.delete(id_); } // stale tokens
      await persist();
      return r;
    },
    async remove(id_) {
      const i = records.findIndex((x) => x.id === id_);
      if (i < 0) return false;
      tokCache.delete(id_);
      records.splice(i, 1);
      await persist();
      return true;
    },
    async clear() { records = []; episodesEver = 0; tokCache.clear(); await persist({ intentional: true }); },
    async recall(query, k = 3, { querySig = null, queryVec = null, sample = false, rng = null, temp = 1, state = "current", sharp = false, sharpMargin = 0.25, includeThemes = true } = {}) {
      if (records.length === 0) return [];
      // NM2a: only serve facts in the requested lifecycle state (default "current") -- so a superseded
      // ("historical") fact never co-retrieves with the value that replaced it. `state:"all"` = forensics.
      // Episodes have no stateRole (absent == "current"), so they pass the default filter unchanged.
      // RM7 (memory-as-distribution): a recall score is a point estimate; here it also carries an
      // UNCERTAINTY (_std) from disagreement between the semantic and lexical views. When the two views
      // agree the retrieval is confident (low std); when they diverge it's uncertain (high std). With no
      // embedder there's only one view -> std 0 (the deterministic special case). `sample` + a seeded rng
      // perturbs each score by N(0, temp*std) so low-confidence rankings explore while confident ones stay
      // put -- calibrated exploration with reproducibility (no rng -> deterministic, std ignored).
      const gauss = () => { if (!rng) return 0; const u1 = Math.max(1e-9, rng()), u2 = rng(); return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2); };
      const qvec = (queryVec && queryVec.length) ? queryVec : await safeEmbed(query);   // reuse a precomputed vector when the caller already embedded this text (embed-once-per-turn)
      const qToks = tokenize(query);
      const qSet = new Set(qToks);
      // RM4: activation-overlap channel. querySig = the neurons firing NOW; a record stamped with the
      // signature it was formed under scores higher when the substrate is in a similar state (Jaccard).
      const qSig = querySig && querySig.length ? new Set(querySig) : null;
      // includeThemes:false drops L2 theme nodes from the pool (the ablation.noHierarchy control — measures the theme
      // layer's contribution vs pure flat recall).
      const inState = state === "all" ? records : records.filter((r) => (r.stateRole || "current") === state);
      const candidates = includeThemes ? inState : inState.filter((r) => r.type !== "theme");
      if (candidates.length === 0) return [];
      const maxTs = Math.max(1, ...candidates.map((r) => r.timestamp || 0));
      const scored = candidates.map((r) => {
        // Hybrid score: semantic (cosine) + lexical (keyword) + metadata (tag match) + recency + pin.
        // Blending semantic AND lexical is more robust than either alone; the tag boost keeps
        // on-topic records (e.g. shared subject) from being drowned by semantic drift.
        // Provenance guard (epic-dm): only compute semantic sim when the query and record vectors share a dimension.
        // A store built under one embedder (MiniLM, 384) and queried under another (hash, 128) would otherwise cosine
        // over the first min(dims) components → confident garbage. On a dim mismatch, fall to lexical for that record.
        const sem = (qvec && r.vector && qvec.length === r.vector.length) ? cosine(qvec, r.vector) : 0;
        // A THEME (L2) node's text is a synthesis of its members, so it inherits their keywords — which would let it
        // impersonate a precise leaf on a SPECIFIC keyword query (esp. the offline extractive summary, which is the
        // member sentences verbatim). Discount its keyword channel so a theme wins on SEMANTIC breadth (broad queries),
        // never on keyword-matching its own summary; the exact leaf keeps specific queries.
        const kw = keywordScore(qToks, toksOf(r)) * (r.type === "theme" ? 0.25 : 1);
        const meta = r.tags && r.tags.length ? r.tags.filter((t) => qSet.has(t)).length / r.tags.length : 0;
        const recency = ((r.timestamp || 0) / maxTs) * 0.1;
        const pin = r.pinned ? 0.2 : 0;
        // Source weight scales the RELEVANCE (sem+kw+meta) and the mind's gate (_sim), but NOT recency/pin
        // (a pinned record stays pinned regardless of provenance). A user fact thus outranks an equally-
        // relevant model fact, while a much-more-relevant model fact still wins over an irrelevant user one.
        const sw = srcWeight(r);
        const sim = (qvec ? sem : kw) * sw; // raw relevance for the mind's gate (semantic when available, else lexical)
        // Activation overlap (RM4): Jaccard of the current firing signature vs the memory's stored one.
        // An additive channel — only bites when both signatures exist; text relevance still dominates.
        let act = 0;
        if (qSig && Array.isArray(r.sig) && r.sig.length) {
          let inter = 0; for (const id of r.sig) if (qSig.has(id)) inter++;
          const uni = qSig.size + r.sig.length - inter;
          act = uni ? inter / uni : 0;
        }
        const std = qvec ? +(Math.abs(sem - kw) * 0.5 * sw).toFixed(4) : 0; // uncertainty = sem/kw disagreement
        let score = (0.55 * sem + 0.3 * kw + 0.15 * meta) * sw + 0.2 * act + recency + pin;
        if (sample && rng && std > 0) score += gauss() * temp * std; // calibrated, reproducible exploration
        return { r, sim, std, score };
      });
      scored.sort((a, b) => b.score - a.score);
      // MMR diversity pass: greedily pick the record maximizing lambda*score - (1-lambda)*maxSimToPicked,
      // so near-duplicates don't dominate the top-K. Rank-1 is always the highest score (no redundancy
      // penalty yet), so pure-relevance behaviour is preserved; only ranks 2+ get de-duplicated.
      const picked = [];
      const pool = scored.slice();
      while (picked.length < k && pool.length) {
        let bestI = 0, bestVal = -Infinity;
        for (let i = 0; i < pool.length; i++) {
          let maxSim = 0;
          for (const p of picked) { const s = recSim(pool[i].r, p.r); if (s > maxSim) maxSim = s; }
          const val = mmrLambda * pool[i].score - (1 - mmrLambda) * maxSim;
          if (val > bestVal) { bestVal = val; bestI = i; }
        }
        const chosen = pool.splice(bestI, 1)[0];
        picked.push(chosen);
        // Collapsed-tree HARD exclusion (hierarchical memory Phase 2): a theme summary and any record it summarizes are
        // mutually redundant — once one is chosen, drop the other(s) from the pool entirely (the soft MMR penalty alone
        // can't guarantee this when a member is far more relevant than the alternatives).
        const cr = chosen.r;
        for (let i = pool.length - 1; i >= 0; i--) {
          const rr = pool[i].r;
          if ((cr.type === "theme" && cr.members && cr.members.includes(rr.id)) ||
              (rr.type === "theme" && rr.members && rr.members.includes(cr.id))) pool.splice(i, 1);
        }
      }
      // NM2b sharp read: when the top hit clearly dominates the runner-up, return it ALONE instead of
      // diluting the prompt with weak also-rans (decoupled-norm "sharp" retrieval). Opt-in; off by default.
      if (sharp && picked.length >= 2 && picked[0].score - picked[1].score > sharpMargin) picked.length = 1;
      // _score = full ranking score (sim + recency + pin boost); _sim = RAW similarity only. Callers
      // gating on genuine relevance should use _sim, so a pinned record's ranking boost doesn't read
      // as "relevant" to an unrelated query.
      return picked.map((s) => ({ ...s.r, _score: s.score, _sim: s.sim, _std: s.std }));
    },
    // RM5 (ReContext): recursive evidence replay. A single flat recall only surfaces what matches the
    // query directly. Here the first-pass hits become an ASSOCIATIVE CUE — we recall again against
    // query+evidence, then blend the two rankings — so a memory strongly linked to a top hit (but not to
    // the bare query) can surface, and a record confirmed by BOTH passes is boosted. Training-free; each
    // pass already applies hybrid scoring + MMR + provenance. `passes:1` degrades to plain recall (the
    // ablation knob for measuring the gain via the RM3 drift probe).
    async recallDeep(query, k = 3, { passes = 2, expandTop = 2, blend = 0.5, querySig = null, sample = false, rng = null, temp = 1, state = "current", includeThemes = true } = {}) {
      const wide = Math.max(k, 6);
      const pass = { querySig, sample, rng, temp, state, includeThemes };
      const first = await this.recall(query, wide, pass);
      // Reactivate ONLY from genuinely relevant hits (raw _sim > 0), never recency-only filler — otherwise
      // MMR's diversity pick could seed the cue with an unrelated record and pull the recursion off-topic.
      const seeds = first.filter((r) => (r._sim ?? 0) > 0).slice(0, expandTop);
      if (passes < 2 || seeds.length === 0) return first.slice(0, k);
      const cue = query + " " + seeds.map((r) => r.text || "").join(" ");
      const second = await this.recall(cue, wide, pass);
      const byId = new Map();
      for (const r of first) byId.set(r.id, { r, s: r._score });
      for (const r of second) { const e = byId.get(r.id); if (e) e.s += blend * r._score; else byId.set(r.id, { r, s: blend * r._score }); }
      return [...byId.values()].sort((a, b) => b.s - a.s).slice(0, k).map((x) => ({ ...x.r, _score: +x.s.toFixed(4) }));
    },
    export() { return JSON.parse(JSON.stringify(records)); },
    async import(recs) { records = JSON.parse(JSON.stringify(recs)); episodesEver = records.filter((r) => r.type === "episode").length; tokCache.clear(); await persist({ intentional: true }); },
  };
}
