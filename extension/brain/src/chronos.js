// chronos.js — THE TEMPORAL SELF (slice 1: the spine). A sliding timeline that locates "now" between a
// compressed past and (later slices) a fan of projected futures — a real "where am I in time, what was, what
// will be." Mined from the user's two narrative engines (HNE = arc-position, smart-story = log + living
// chronicle); design at brain/docs/plans/2026-07-08-temporal-self.md.
//
// This slice integrates two organs the brain already has but never joined along a time axis:
//   • eventSegment boundaries → close the current EPOCH and turn the timeline's page (the caller passes the
//     boundary signal; chronos does not import it, so it stays standalone + testable).
//   • distiller-style gisting → each closed epoch gets a compact GIST (an injectable `gist(texts)`; a cheap
//     deterministic extractive default runs with no backend, so tests are stable and offline).
//
// DISCIPLINE (matches the brain): logical clock IN (`now()`), no Date.now / Math.random, dependency-free,
// deterministic. Everything is derivable and inspectable.

// ── cheap deterministic gist (the offline default; inject the real distiller for prose) ─────────────────────
const STOP = new Set("the a an and or but of to in on at for with as is are was were be been it its this that these those i you we they he she him her them my your our their me us so then now just very really into over under from by".split(" "));
const sentences = (texts) => texts.join(" ").replace(/\s+/g, " ").split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 3);
function defaultGist(texts, salientTexts = []) {
  const src = [...salientTexts, ...texts];                              // salient-marked events lead
  const sents = sentences(src);
  if (!sents.length) return "";
  // Score each sentence by rare-content-word density; keep the top 2, in first-seen order, capped.
  const seen = new Set(), picked = [];
  const scored = sents.map((s, i) => {
    const words = s.toLowerCase().match(/[a-z']+/g) || [];
    const content = words.filter((w) => w.length > 3 && !STOP.has(w));
    return { s, i, score: content.length / (words.length || 1) + content.length * 0.05 };
  }).sort((a, b) => b.score - a.score);
  for (const { s, i } of scored) { if (picked.length >= 2) break; const k = s.slice(0, 40).toLowerCase(); if (seen.has(k)) continue; seen.add(k); picked.push({ s, i }); }
  return picked.sort((a, b) => a.i - b.i).map((p) => p.s).join(" ").slice(0, 220);
}

export function makeChronos({ now, gist = null, minEpochEvents = 2, maxEpochs = 200, minSnapWords = 4, minSnapGap = 2 } = {}) {
  if (typeof now !== "function") throw new Error("chronos: now() logical clock required");
  const doGist = typeof gist === "function" ? gist : defaultGist;
  const wordsOf = (s) => (String(s).match(/\S+/g) || []).length;

  const epochs = [];                 // closed epochs, oldest → newest
  let cur = null;                    // the open epoch (the "now" bucket)
  let seq = 0;                       // deterministic epoch id sequence
  let evSeq = 0;                     // deterministic global event id sequence
  let snapSeq = 0;                   // deterministic snapshot id sequence
  let arc = null;                    // optional planned-arc position from a mission contract
  const habits = new Map();          // "sigA→sigB" → count: learned WHAT-USUALLY-FOLLOWS between epoch signatures
  let lastDivergent = false;         // did reality just leave the projection? (slice 2)
  // slice 6 — NESTED epochs: a slow "topic/goal" boundary closes a CHAPTER (a group of epochs), giving chapters
  // within chapters (a day inside a week). Additive: unused unless a caller passes observe({ topic:true }).
  const chapters = [];
  let chapSeq = 0, chapterFrom = 0;  // chapterFrom = index into `epochs` where the current chapter began
  let chronicleDoc = "";             // slice 4b — the living ground-truth doc (consolidateChronicle rewrites it)

  // An epoch's SIGNATURE — its most frequent content word — is the unit habits are learned over. Deterministic;
  // ties break alphabetically so the same history always yields the same habit table.
  const sigOf = (text) => {
    const counts = new Map();
    for (const w of (String(text).toLowerCase().match(/[a-z']+/g) || [])) { if (w.length > 3 && !STOP.has(w)) counts.set(w, (counts.get(w) || 0) + 1); }
    let best = null;
    for (const [w, n] of counts) if (!best || n > best.n || (n === best.n && w < best.w)) best = { w, n };
    return best ? best.w : null;
  };

  const openEpoch = (t) => { cur = { id: "e" + (seq++), t0: t, t1: t, events: [], snapshots: [], keys: [], evSinceSnap: 999 }; };

  // SNAPSHOT (slice 3) — the salience marker (smart-story's stack): a faculty PROPOSES "this moment matters",
  // and a veto disposes: a SUBSTANCE filter (the focus moment must carry enough content, not filler) and a
  // REFRACTORY window (not right after another snapshot) — or everything becomes a "special moment". A kept
  // snapshot carries a NARROW LOCAL TIME-SLICE (the focus moment + up to 3 just before it), so a chapter can be
  // re-expanded later WITHOUT retaining the whole log. `force` bypasses the veto (an explicit, deliberate mark).
  function snapshot(reason = "noted", { force = false } = {}) {
    if (!cur || !cur.events.length) return { vetoed: true, why: "no moment yet" };
    const focus = cur.events[cur.events.length - 1];
    if (!force) {
      if (wordsOf(focus.text) < minSnapWords) return { vetoed: true, why: "too slight" };
      if (cur.evSinceSnap < minSnapGap) return { vetoed: true, why: "too soon after the last" };
    }
    const snap = { id: "s" + (snapSeq++), reason: String(reason || "noted").slice(0, 60), focusId: focus.id, focus: focus.text, context: cur.events.slice(-4, -1).map((e) => e.text), at: focus.t, factIds: [] };
    cur.snapshots.push(snap); cur.evSinceSnap = 0;
    return snap;
  }
  // slice 6 dig↔recall — link a snapshot to the declarative facts distilled from it, so archaeology and semantic
  // recall reinforce each other (dig a moment → its facts; recall a fact → the moment it came from). Searches
  // the open epoch and closed epochs.
  function linkFacts(snapId, factIds = []) {
    const pools = [cur ? cur.snapshots : [], ...epochs.map((e) => e.snapshots || [])];
    for (const pool of pools) { const s = pool.find((x) => x && x.id === snapId); if (s) { s.factIds = [...new Set([...(s.factIds || []), ...factIds])]; return s; } }
    return null;
  }

  function closeEpoch() {
    if (!cur || !cur.events.length) return null;
    const texts = cur.events.map((e) => e.text);
    const salientTexts = cur.events.filter((e) => e.salient).map((e) => e.text);
    const closed = {
      id: cur.id, t0: cur.t0, t1: cur.t1, eventCount: cur.events.length,
      gist: doGist(texts, salientTexts) || texts[texts.length - 1].slice(0, 120),
      snapshots: cur.snapshots.slice(),    // the moments that MATTERED, each with its local slice → dig() re-expands from these
      salience: cur.snapshots.map((s) => s.id),
      keys: cur.keys.slice(),              // event ids (references; the reconstructable content lives in snapshots)
      label: null,
    };
    closed.sig = sigOf(closed.gist);
    const prev = epochs[epochs.length - 1];
    if (prev && prev.sig && closed.sig) { const k = prev.sig + "→" + closed.sig; habits.set(k, (habits.get(k) || 0) + 1); }   // learn the transition
    epochs.push(closed);
    while (epochs.length > maxEpochs) epochs.shift();
    cur = null;
    return closed;
  }

  // slice 6 — close the current CHAPTER: group every epoch since the last chapter into one, gisted from their gists.
  function closeChapter() {
    const span = epochs.slice(chapterFrom);
    if (!span.length) return null;
    const chap = { id: "c" + (chapSeq++), epochIds: span.map((e) => e.id), t0: span[0].t0, t1: span[span.length - 1].t1, eventCount: span.reduce((a, e) => a + e.eventCount, 0), gist: doGist(span.map((e) => e.gist)) || span[span.length - 1].gist };
    chapters.push(chap); chapterFrom = epochs.length;
    return chap;
  }

  const api = {
    // Record one moment. `boundary` (from eventSegment) turns the page AFTER folding this event into the
    // closing epoch, so the surprising turn that ENDED an event still belongs to it. `salient` marks a moment
    // worth snapshotting (veto-gated). `topic` is the SLOW (topic/goal) boundary → also closes a chapter.
    observe({ text = "", boundary = false, salient = false, topic = false, t = now() } = {}) {
      const clean = String(text).replace(/\s+/g, " ").trim();
      if (!cur) openEpoch(t);
      if (clean) {
        const id = "v" + (evSeq++);
        cur.events.push({ id, text: clean, salient: !!salient, t });
        cur.keys.push(id); cur.evSinceSnap++;
        cur.t1 = t;
        if (salient) snapshot("felt salient");    // salient PROPOSES a snapshot — the veto (substance/refractory) still applies
      }
      if (boundary || topic) {                    // a topic-boundary is also an ordinary page-turn
        const closed = closeEpoch(); openEpoch(t);
        if (topic) closeChapter();                // slice 6: the slow boundary groups the epochs since the last one into a chapter
        return closed;
      }
      return null;
    },

    snapshot,   // slice 3: any faculty can propose "this moment matters" (veto-gated; force to bypass)

    // Install / update the planned-arc position (from the mission contract; whereAmI folds it in). null clears.
    setArc(a) { arc = a && typeof a === "object" ? { phase: a.phase ?? null, stepK: a.stepK ?? null, ofN: a.ofN ?? null, elapsed: a.elapsed ?? null, expected: a.expected ?? null } : null; },

    // WHERE AM I — the position sentence: which epoch, how far into the planned arc, and the recent gist.
    whereAmI() {
      const nEp = epochs.length;
      const inEpoch = cur ? cur.events.length : 0;
      const recent = nEp ? epochs[nEp - 1].gist : (cur && cur.events.length ? doGist(cur.events.map((e) => e.text)) : "");
      let s = nEp === 0 ? "Just beginning — no closed chapters yet" : `Chapter ${nEp + 1}, ${inEpoch} moment${inEpoch === 1 ? "" : "s"} in`;
      if (chapters.length) s = `Part ${chapters.length + 1} — ` + s;   // slice 6: name the containing chapter when there is one
      if (arc && arc.stepK != null && arc.ofN != null) {
        s += `; ${arc.phase ? arc.phase + " phase, " : ""}step ${arc.stepK} of ${arc.ofN}`;
        if (arc.elapsed != null && arc.expected != null) s += ` (${Math.round(arc.elapsed)} of ~${Math.round(arc.expected)})`;
      }
      if (recent) s += `. Lately: ${recent}`;
      return { text: s, epochIndex: nEp, sinceBoundary: inEpoch, arc };
    },

    // WAS — walk the past at the right resolution. depth 0 = verbatim recent moments (this epoch); depth ≥1 =
    // epoch gists, newest first, up to `depth` chapters back. A query filters gists by keyword (slice 1 recall).
    was(depth = 1, query = null) {
      if (depth <= 0) return { level: "verbatim", items: (cur ? cur.events : []).slice(-6).map((e) => e.text) };
      let items = epochs.slice(-depth).reverse().map((e) => ({ id: e.id, gist: e.gist, t0: e.t0, t1: e.t1 }));
      if (query) { const q = String(query).toLowerCase(); items = epochs.filter((e) => e.gist.toLowerCase().includes(q)).reverse().map((e) => ({ id: e.id, gist: e.gist, t0: e.t0, t1: e.t1 })); }
      return { level: "gist", items };
    },

    // WILL BE (slice 2) — the FUTURES FAN, not a single prediction. Three bases, each honestly labeled:
    //   plan        — the next step of the installed arc (a mission contract): the strongest claim we can make.
    //   habit       — what USUALLY follows the current epoch's signature, learned from our own history;
    //                 likelihood = observed frequency, capped (habits are tendencies, not fate).
    //   imagination — one caller-simulated bold candidate (wire imagination.simulate through `imagine`).
    // Uncertainty SPREADS with horizon: every step further out decays likelihood and widens spread — the fan
    // is honest by construction (estimates that say they're estimates).
    willBe({ horizon = 1, imagine = null } = {}) {
      const decay = 1 / (1 + 0.35 * Math.max(0, horizon - 1));
      const spread = Math.min(1, 0.15 + 0.2 * (horizon - 1));
      const fan = [];
      if (arc && arc.stepK != null && arc.ofN != null && arc.stepK < arc.ofN) {
        fan.push({ label: `the plan continues: step ${arc.stepK + 1} of ${arc.ofN}${arc.phase ? " (" + arc.phase + ")" : ""}`, basis: "plan", likelihood: +(0.85 * decay).toFixed(2), horizon, spread });   // a STATED intention outranks a mere tendency
      }
      const curSig = cur && cur.events.length ? sigOf(cur.events.map((e) => e.text).join(" ")) : (epochs.length ? epochs[epochs.length - 1].sig : null);
      if (curSig) {
        const outs = [...habits.entries()].filter(([k]) => k.startsWith(curSig + "→")).map(([k, n]) => ({ to: k.split("→")[1], n }));
        const total = outs.reduce((a, b) => a + b.n, 0);
        outs.sort((a, b) => b.n - a.n || (a.to < b.to ? -1 : 1));
        for (const o of outs.slice(0, 2)) fan.push({ label: `${o.to} usually follows ${curSig}`, basis: "habit", likelihood: +(Math.min(0.7, o.n / total) * decay).toFixed(2), horizon, spread });   // a tendency, capped BELOW a stated plan
      }
      if (typeof imagine === "function") {
        try { const sim = imagine({ sig: curSig, gist: epochs.length ? epochs[epochs.length - 1].gist : "" }); if (sim && sim.label) fan.push({ label: sim.label, basis: "imagination", likelihood: +(0.25 * decay).toFixed(2), horizon, spread, ...(sim.detail ? { detail: sim.detail } : {}) }); } catch {}
      }
      return fan.sort((a, b) => b.likelihood - a.likelihood);
    },

    // ESTIMATE (slice 2) — approximation from our OWN history: how long does this kind of chapter usually run?
    // Median duration of matching epochs + a spread; n=0 is an honest "I don't know yet", never a guess.
    estimate(query) {
      const q = String(query || "").toLowerCase().trim();
      const matched = q ? epochs.filter((e) => e.gist.toLowerCase().includes(q) || e.sig === q) : epochs.slice();
      const durs = matched.map((e) => e.t1 - e.t0).filter((d) => d >= 0).sort((a, b) => a - b);
      if (!durs.length) return { n: 0 };
      const mid = durs[Math.floor(durs.length / 2)];
      const spreadMs = durs.length > 1 ? Math.round((durs[durs.length - 1] - durs[0]) / 2) : Math.round(mid * 0.5);
      return { n: durs.length, expectedMs: mid, spreadMs };
    },

    // DIVERGENCE (slice 2) — reality left the projection. Feed the predictor's surprise here; a high value
    // marks the moment as "not how I thought this would go" (a felt temporal event the mind can voice) and
    // flags that the fan should be re-drawn. The BOUNDARY decision stays with eventSegment — this only notes.
    noteDivergence(surprise = 0) {
      lastDivergent = surprise >= 0.6;
      return lastDivergent ? { divergent: true, note: "this isn't how I thought this would go", refan: true } : { divergent: false };
    },
    divergent: () => lastDivergent,

    // DIG (slice 3) — ARCHAEOLOGY: re-expand a compressed chapter. Returns its gist PLUS the snapshots (the
    // moments that mattered, each with its local slice) — the inverse of consolidation, and the honest answer
    // to "wait, what exactly happened then?". A chapter with no snapshots returns just its gist (kept the
    // summary, saved no vivid moments) rather than fabricating detail. Accepts an epoch id or a back-index (0 = newest).
    dig(ref) {
      let e = null;
      if (typeof ref === "number") e = epochs[epochs.length - 1 - ref];
      else e = epochs.find((x) => x.id === ref);
      if (!e) return null;
      return {
        id: e.id, t0: e.t0, t1: e.t1, gist: e.gist, eventCount: e.eventCount, sig: e.sig,
        snapshots: (e.snapshots || []).map((s) => ({ reason: s.reason, focus: s.focus, context: s.context.slice(), at: s.at, factIds: (s.factIds || []).slice() })),
        recovered: (e.snapshots || []).length > 0,
      };
    },
    linkFacts,   // slice 6 dig↔recall

    // VOICE (slice 4a) — candidate TEMPORAL inner-voice frames the mind's inner voice can pick + gate. Each is
    // {kind, text, weight}; the caller decides which (if any) to surface, like the rest of the inner voice.
    // The frames are the temporal self made FELT: position (now), anticipation (soon), the sense that something
    // is running long (estimate), memory of a marked moment (remember), and surprise at a swerve (divergent).
    voice({ elapsed = null } = {}) {
      const frames = [];
      if (lastDivergent) frames.push({ kind: "divergent", text: "huh — this isn't going how I thought it would.", weight: 0.9 });
      const fan = api.willBe();
      if (fan.length && fan[0].likelihood >= 0.5) frames.push({ kind: "soon", text: `feels like ${fan[0].label}.`, weight: 0.5 + fan[0].likelihood * 0.3 });
      if (elapsed != null && epochs.length) {
        const est = api.estimate(epochs[epochs.length - 1].sig || "");
        if (est.n >= 2 && elapsed > est.expectedMs + est.spreadMs) frames.push({ kind: "estimate", text: "this is taking longer than it usually does.", weight: 0.6 });
      }
      // a remembered moment: the newest closed chapter that saved a vivid snapshot
      for (let i = epochs.length - 1; i >= 0 && i >= epochs.length - 4; i--) {
        const snaps = epochs[i].snapshots || [];
        if (snaps.length) { frames.push({ kind: "remember", text: `I remember — ${snaps[snaps.length - 1].focus}`, weight: 0.4 }); break; }
      }
      if (epochs.length >= 2) frames.push({ kind: "now", text: api.whereAmI().text, weight: 0.3 });
      return frames.sort((a, b) => b.weight - a.weight);
    },

    // CHRONICLE (slice 4b) — a compact GROUND-TRUTH block for the mouth/LLM to read each turn (smart-story's
    // "treat this as ground truth" pattern): the position sentence + the most recent chapter gists, bounded.
    // If a living-doc has been consolidated (below), that is the ground truth instead of a gist concatenation.
    chronicle({ maxChars = 600, recent = 4 } = {}) {
      if (chronicleDoc) return chronicleDoc.slice(0, maxChars);
      const head = api.whereAmI().text;
      const past = epochs.slice(-recent).map((e) => "· " + e.gist).join("\n");
      return (head + (past ? "\n" + past : "")).slice(0, maxChars);
    },
    // CONSOLIDATE the chronicle into a living document (smart-story F2: rewrite-not-append, preserve-unchanged,
    // tighten-stale). `rewrite(prevDoc, recentGists) -> newDoc` is caller-supplied (a backend/LLM); if it throws
    // or returns nothing, the previous doc is kept (never corrupted). This is the richer form of the gist.
    consolidateChronicle(rewrite) {
      if (typeof rewrite !== "function") return chronicleDoc;
      try { const next = rewrite(chronicleDoc, epochs.slice(-8).map((e) => e.gist)); if (typeof next === "string" && next.trim()) chronicleDoc = next.trim().slice(0, 2000); } catch {}
      return chronicleDoc;
    },
    chronicleDoc: () => chronicleDoc,

    closeChapter,                                                  // slice 6: force a chapter close (e.g. a day boundary)
    chapters: () => chapters.slice(),
    closeEpoch,                                                    // force a page-turn (e.g. on sleep/rest)
    epochs: () => epochs.slice(),
    habits: () => Object.fromEntries(habits),
    present: () => ({ epochId: cur ? cur.id : null, sinceBoundary: cur ? cur.events.length : 0, epochCount: epochs.length, chapterCount: chapters.length, arc }),
    serialize: () => ({ epochs: epochs.slice(), chapters: chapters.slice(), seq, evSeq, snapSeq, chapSeq, chapterFrom, habits: Object.fromEntries(habits), chronicleDoc }),

    // RESTORE (slice 5c) — rehydrate a serialized timeline so the temporal self is CONTINUOUS across restarts
    // (not per-session). Only closed epochs/chapters persist — the open "now" bucket starts fresh, which is
    // correct: a restart IS a boundary. Tolerant of partial/legacy blobs.
    restore(blob) {
      if (!blob || typeof blob !== "object") return false;
      epochs.length = 0; chapters.length = 0; habits.clear();
      for (const e of blob.epochs || []) if (e && e.id) epochs.push(e);
      for (const c of blob.chapters || []) if (c && c.id) chapters.push(c);
      for (const [k, n] of Object.entries(blob.habits || {})) habits.set(k, n);
      seq = blob.seq || epochs.length; evSeq = blob.evSeq || 0; snapSeq = blob.snapSeq || 0;
      chapSeq = blob.chapSeq || chapters.length; chapterFrom = Math.min(blob.chapterFrom ?? epochs.length, epochs.length);
      chronicleDoc = typeof blob.chronicleDoc === "string" ? blob.chronicleDoc : "";
      cur = null;
      return true;
    },
  };
  return api;
}

// ── slice 5a — INTEGRATION as a PLUGIN (additive; does NOT edit core mind/app) ───────────────────────────────
// Drop into makeApp({ plugins: [makeChronosPlugin()] }) and the temporal self runs live off the real loop:
//   • each turn → observe({ text, boundary/topic from eventSegment, salient from surprise }) + noteDivergence(surprise)
//   • rest/sleep → closeEpoch() (consolidation turns the page)
// The plugin keeps a monotonic TURN counter as chronos's logical clock (deterministic — no Date.now). It exposes
// the live `chronos` on the returned object so the caller can whereAmI()/willBe()/voice()/chronicle()/dig() it,
// and (slice 5b) accepts a real distiller-backed `gist` to replace the extractive default. serialize()/restore()
// (slice 5c) let the caller persist the timeline across sessions so the temporal self is CONTINUOUS.
export function makeChronosPlugin({ salientSurprise = 0.5, gist = null } = {}) {
  let turn = 0;
  const chronos = makeChronos({ now: () => turn, gist });
  return {
    name: "chronos", version: "0.1", chronos,
    install(ctx) {
      ctx.onTurn(({ message, result }) => {
        turn++;
        const seg = result && result.eventSegment;
        const boundary = !!(seg && seg.boundary && seg.level !== "topic");
        const topic = !!(seg && seg.boundary && seg.level === "topic");
        const surprise = (result && typeof result.surprise === "number") ? result.surprise : (seg && typeof seg.surprise === "number" ? seg.surprise : 0);
        chronos.observe({ text: String(message || ""), boundary, topic, salient: surprise >= salientSurprise, t: turn });
        chronos.noteDivergence(surprise);
      });
      ctx.onRest(() => { chronos.closeEpoch(); });   // consolidation/sleep = a page-turn
    },
  };
}
