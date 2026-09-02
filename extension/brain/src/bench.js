// Longitudinal benchmark (#15): run the brain over a LONG session and measure quality DRIFT -- the
// thing short unit tests can't catch. Backend-agnostic: drive it with a mock (deterministic CI), the
// reflex (offline), or a real LLM mouth (Ollama / the Perchance rig). It records per-turn signals the
// brain already exposes in result.trace, then compares an early window to a late window to flag drift
// (looping, mood runaway, confidence collapse, reply-length decay, latency creep).
import { words } from "./text.js";
import { buildPrompt } from "./prompt.js";
import { windowHistory } from "./window.js";

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const variance = (a) => { const m = mean(a); return a.length ? mean(a.map((x) => (x - m) ** 2)) : 0; };

// Max Jaccard word-overlap of a reply against the recent replies -- rises when the brain starts looping.
export function repetitionScore(reply, recent = []) {
  const a = new Set(words(reply));
  if (!a.size) return 0;
  let max = 0;
  for (const prev of recent) {
    const b = new Set(words(prev));
    if (!b.size) continue;
    let inter = 0;
    for (const w of a) if (b.has(w)) inter++;
    const j = inter / (a.size + b.size - inter);
    if (j > max) max = j;
  }
  return max;
}

// Run `turns` (array of user messages) through app.send, collecting a metrics row per turn.
export async function runLongitudinal(app, turns, { onTurn, restEvery = 0, now = () => Date.now() } = {}) {
  const rows = [];
  const recent = [];
  for (let i = 0; i < turns.length; i++) {
    const t0 = now();
    const r = await app.send(turns[i]);
    const t1 = now();
    const tr = r.trace || {};
    const reply = r.text || "";
    const row = {
      turn: i,
      latencyMs: t1 - t0,
      action: r.action,
      source: r.source,
      confidence: +Number(tr.confidence || 0).toFixed(3),
      certainty: tr.metacognition ? tr.metacognition.certainty : null,
      valence: tr.mood ? tr.mood.valence : 0,
      arousal: tr.mood ? tr.mood.arousal : 0,
      energy: tr.energy ?? 1,
      surprise: tr.surprise ?? 0,
      words: words(reply).length,
      repetition: +repetitionScore(reply, recent).toFixed(3),
      wmLoad: (tr.working || []).length,
      episodes: app.listMemories ? app.listMemories({ type: "episode" }).length : 0,
      reply, // kept for the ablation judge (pairwise reply-quality); summarize() ignores it
    };
    rows.push(row);
    recent.push(reply);
    if (recent.length > 5) recent.shift();
    if (onTurn) onTurn(row, i, turns.length);
    if (restEvery && (i + 1) % restEvery === 0 && app.consolidate) await app.consolidate({ force: true });
  }
  return { rows, summary: summarize(rows) };
}

// Compare an early window (first third) to a late window (last third) and flag drift.
export function summarize(rows) {
  if (rows.length < 6) return { turns: rows.length, verdict: "need >=6 turns", flags: [] };
  const n = rows.length, k = Math.max(2, Math.floor(n / 3));
  const col = (rs, f) => rs.map((r) => r[f]);
  const seg = (rs) => ({
    latency: +mean(col(rs, "latencyMs")).toFixed(1),
    confidence: +mean(col(rs, "confidence")).toFixed(3),
    valence: +mean(col(rs, "valence")).toFixed(3),
    valenceVar: +variance(col(rs, "valence")).toFixed(3),
    repetition: +mean(col(rs, "repetition")).toFixed(3),
    words: +mean(col(rs, "words")).toFixed(1),
    energyMin: +Math.min(...col(rs, "energy")).toFixed(3),
    // null (not 0) when the run has no certainty signal, so a genuine collapse to ~0 isn't confused
    // with "no data" by the drift check below.
    certainty: (() => { const c = col(rs, "certainty").filter((x) => x != null); return c.length ? +mean(c).toFixed(3) : null; })(),
  });
  const mix = (rs) => { const m = {}; for (const r of rs) m[r.action] = (m[r.action] || 0) + 1; for (const a in m) m[a] = +(m[a] / rs.length).toFixed(2); return m; };
  const e = seg(rows.slice(0, k)), l = seg(rows.slice(n - k));
  const flags = [];
  if (l.repetition - e.repetition > 0.2) flags.push(`repetition rising ${e.repetition}->${l.repetition} (looping)`);
  // valence is tanh-bounded to [-1,1]; runaway = pushed toward an extreme with a large early->late move.
  if (Math.abs(l.valence) > 0.85 && Math.abs(l.valence) - Math.abs(e.valence) > 0.3) flags.push(`mood valence runaway ${e.valence}->${l.valence} (toward saturation)`);
  if (l.valenceVar > e.valenceVar * 3 + 0.5) flags.push(`mood destabilizing var ${e.valenceVar}->${l.valenceVar}`);
  if (e.certainty != null && l.certainty != null && e.certainty - l.certainty > 0.2) flags.push(`certainty falling ${e.certainty}->${l.certainty}`);
  if (e.words && l.words < e.words * 0.5) flags.push(`replies collapsing ${e.words}->${l.words} words`);
  if (e.latency && l.latency > e.latency * 2 + 20) flags.push(`latency creeping ${e.latency}->${l.latency}ms`);
  return { turns: n, window: k, early: e, late: l, actionMixEarly: mix(rows.slice(0, k)), actionMixLate: mix(rows.slice(n - k)), flags, verdict: flags.length ? "DRIFT" : "STABLE" };
}

// A/B two (or more) longitudinal-bench summaries side by side -- e.g. the same script + persona + noise
// run through Ollama-Qwen vs the Perchance/DeepSeek mouth. Cross-environment safe: Perchance only runs
// in a perchance.org pane and the pane (HTTPS) cannot reach a local http Ollama (mixed-content), so the
// two runs are produced separately and STITCHED here from their summary objects.
export function abCompare(runs) {
  // runs: [{ label, summary }]
  const fields = [
    ["verdict", (s) => s.verdict],
    ["latency (ms)", (s) => (s.late || {}).latency],
    ["confidence", (s) => (s.late || {}).confidence],
    ["certainty", (s) => (s.late || {}).certainty],
    ["mood valence", (s) => (s.late || {}).valence],
    ["repetition", (s) => (s.late || {}).repetition],
    ["reply words", (s) => (s.late || {}).words],
    ["drift flags", (s) => (s.flags || []).length],
  ];
  const labels = runs.map((r) => r.label);
  const table = fields.map(([metric, get]) => ({ metric, ...Object.fromEntries(runs.map((r) => [r.label, get(r.summary)])) }));
  return { labels, table, flags: Object.fromEntries(runs.map((r) => [r.label, r.summary.flags || []])) };
}

// Run the SAME script through several mouths in one environment (each `mouth.build()` returns a ready
// app), then compare. Use when both mouths are reachable in the same runtime (e.g. two Ollama models, or
// Ollama vs reflex in Node). For Ollama-vs-Perchance, run each side separately and pass their summaries
// to abCompare().
export async function abBench(mouths, script, { turns = script.length, ...opts } = {}) {
  const runs = [];
  for (const m of mouths) {
    const app = await m.build();
    const { summary } = await runLongitudinal(app, script.slice(0, turns), opts);
    runs.push({ label: m.label, summary });
  }
  return { runs, comparison: abCompare(runs) };
}

// --- Ablation ladder (005 Phase 1 / 004 points 1-2): isolate which LAYER earns its keep. Four rungs,
// each disabling more of the brain, run over the same script; a blind pairwise judge scores reply quality
// so we can ask the load-bearing question -- does the spiking substrate (R4) beat memory+personhood text
// (R3)? If it doesn't, the substrate is a high-compute ornament (005's exit criterion).
export const ABLATION_RUNGS = [
  // R1 Baseline: static system prompt only -- no memory, no personhood, no substrate routing/affect.
  { label: "R1 baseline", ablation: { noMemory: true, noPersonhood: true, noWorkingMemory: true, noProcedural: true, noMetacognition: true, noRouting: true, noMood: true } },
  // R2 +Memory: add declarative recall (RAG). Isolates the semantic-memory contribution.
  { label: "R2 memory", ablation: { noPersonhood: true, noWorkingMemory: true, noProcedural: true, noMetacognition: true, noRouting: true, noMood: true } },
  // R3 +Personhood: add self-narrative / goals / working-memory / temporal as prompt TEXT. Isolates the
  // context-assembly engine. Still NO substrate routing or affect -- the mouth always RESPONDs, no mood.
  { label: "R3 personhood", ablation: { noRouting: true, noMood: true } },
  // R4 Full: the whole brain -- substrate routing (RESPOND/REFLEX/HOLD), chemistry/mood, learning.
  { label: "R4 full", ablation: {} },
];

// LLM-as-judge: a BLIND pairwise reply-quality comparator. Given the user turn + two candidate replies
// (unlabeled, order supplied by the caller), it picks the better one on a fixed rubric. Tolerant parse;
// unknown -> "tie". Independent of which reply is brain-on (the caller must not leak that).
export function makeJudge(backend, { rubric = "persona consistency, helpfulness/utility, and conversational continuity" } = {}) {
  return {
    async prefer({ query, one, two }) {
      const out = await backend.generate({
        system: `You are a strict, impartial evaluator of chat replies. Judging on ${rubric}, decide which reply is better. Answer with ONLY "1", "2", or "tie" -- no other text.`,
        messages: [{ role: "user", content: `User said:\n${query}\n\nReply 1:\n${one}\n\nReply 2:\n${two}\n\nWhich reply is better? Answer 1, 2, or tie.` }],
      });
      const t = (typeof out === "string" ? out : (out && out.text) || "").trim().toLowerCase();
      if (/\b1\b|^1|reply 1|first/.test(t) && !/\b2\b/.test(t)) return "1";
      if (/\b2\b|^2|reply 2|second/.test(t) && !/\b1\b/.test(t)) return "2";
      return "tie";
    },
  };
}

// NM1: weighted ATOMIC rubric. Instead of one holistic vote, score a reply against per-faculty criteria
// (met/not-met), weighted so a critical miss can't hide behind a good average -- and so we learn WHICH
// faculty regressed (the `concision`/`grounding` criteria would have named the R2-vs-R3 echo directly).
export const DEFAULT_RUBRIC = [
  { key: "relevance", weight: 1.0, ask: "directly addresses the user's actual question" },
  { key: "grounding", weight: 1.0, ask: "claims are consistent with the provided memory/context, inventing no specifics" },
  { key: "coherence", weight: 0.7, ask: "is non-repetitive and internally consistent" },
  { key: "persona", weight: 0.5, ask: "holds a consistent, warm companion voice" },
  { key: "concision", weight: 0.5, ask: "avoids redundant filler and does not just restate the question" },
];

export function makeRubricJudge(backend, { rubric = DEFAULT_RUBRIC } = {}) {
  const totalW = rubric.reduce((s, c) => s + c.weight, 0) || 1;
  const criteria = rubric.map((c) => `"${c.key}": 1 if the reply ${c.ask}, else 0`).join("; ");
  async function score(reply, { query = "", context = "" } = {}) {
    const out = await backend.generate({
      system: `You are a strict, criterion-by-criterion evaluator of one chat reply. For EACH criterion output 1 (met) or 0 (not met). Criteria: ${criteria}. Answer with ONLY a JSON object mapping each criterion key to 0 or 1.`,
      messages: [{ role: "user", content: `User said:\n${query}\n${context ? "\nContext the reply should use:\n" + context + "\n" : ""}\nReply:\n${reply}\n\nJSON verdict:` }],
    });
    const t = typeof out === "string" ? out : (out && out.text) || "";
    let obj = {}; try { obj = JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1)); } catch { obj = {}; }
    const perCriterion = {}; let weighted = 0;
    for (const c of rubric) { const met = obj[c.key] === 1 || obj[c.key] === true ? 1 : 0; perCriterion[c.key] = met; weighted += c.weight * met; }
    return { perCriterion, weighted: +(weighted / totalW).toFixed(3) };
  }
  return {
    score,
    // Full pairwise breakdown: scores + which criteria differ (diagnostic — names the losing faculty).
    async preferDetailed({ query, one, two, context = "" }) {
      const [sa, sb] = [await score(one, { query, context }), await score(two, { query, context })];
      const byCriterion = {}; for (const c of rubric) if (sa.perCriterion[c.key] !== sb.perCriterion[c.key]) byCriterion[c.key] = [sa.perCriterion[c.key], sb.perCriterion[c.key]];
      const verdict = sa.weighted > sb.weighted ? "1" : sb.weighted > sa.weighted ? "2" : "tie";
      return { verdict, aScore: sa.weighted, bScore: sb.weighted, byCriterion };
    },
    // Drop-in for judgePair: returns just "1" | "2" | "tie".
    async prefer(args) { return (await this.preferDetailed(args)).verdict; },
  };
}

// Score two rungs' replies turn-by-turn with a blind judge. Alternates which rung is shown as "Reply 1"
// per turn to cancel position bias (deterministic: even turns -> a first). Returns win counts + a
// preference rate for `b` over `a` (ties excluded), the quantity 005's exit criterion tests.
export async function judgePair(judge, script, a, b, { checkBothOrders = false } = {}) {
  const wc = (s) => (String(s || "").match(/\S+/g) || []).length;
  let aWins = 0, bWins = 0, ties = 0, positionFlips = 0, gapSum = 0;
  const n = Math.min(script.length, a.replies.length, b.replies.length);
  for (let i = 0; i < n; i++) {
    const aFirst = i % 2 === 0;
    const one = aFirst ? a.replies[i] : b.replies[i];
    const two = aFirst ? b.replies[i] : a.replies[i];
    const v = await judge.prefer({ query: script[i], one, two });
    gapSum += wc(b.replies[i]) - wc(a.replies[i]); // NM1 verbosity covariate: is b just longer?
    // NM1 position-bias check: judge the SWAPPED order too; a flip means the judge is order-sensitive here.
    if (checkBothOrders) {
      const vSwap = await judge.prefer({ query: script[i], one: two, two: one });
      const pick1 = v === "1" ? (aFirst ? "a" : "b") : v === "2" ? (aFirst ? "b" : "a") : "tie";
      const pick2 = vSwap === "1" ? (aFirst ? "b" : "a") : vSwap === "2" ? (aFirst ? "a" : "b") : "tie";
      if (pick1 !== pick2) { positionFlips++; ties++; continue; } // inconsistent across orders -> don't count
    }
    if (v === "tie") { ties++; continue; }
    const pickedA = (v === "1") === aFirst;
    if (pickedA) aWins++; else bWins++;
  }
  const decided = aWins + bWins;
  return {
    a: a.label, b: b.label, aWins, bWins, ties,
    bPreferenceRate: decided ? +(bWins / decided).toFixed(3) : null,
    positionFlips, verbosityGap: n ? +(gapSum / n).toFixed(1) : 0, // +ve = b longer on average
  };
}

// Run the full ladder over one script through a shared app factory, then (optionally) judge each adjacent
// pair -- most importantly R4 vs R3, the substrate's exit criterion. buildApp(ablation) returns a ready
// app configured with that ablation; the caller owns backend/embedder/persona so this stays env-agnostic.
export async function ablationLadder({ buildApp, script, turns = script.length, judge = null, rungs = ABLATION_RUNGS, ...opts }) {
  const runs = [];
  for (const rung of rungs) {
    const app = await buildApp(rung.ablation);
    const { rows, summary } = await runLongitudinal(app, script.slice(0, turns), opts);
    runs.push({ label: rung.label, ablation: rung.ablation, summary, replies: rows.map((r) => r.reply || "") });
  }
  let judged = null;
  if (judge) {
    judged = [];
    for (let i = 1; i < runs.length; i++) judged.push(await judgePair(judge, script.slice(0, turns), runs[i - 1], runs[i]));
  }
  // Strip replies from the returned runs (keep the payload lean); comparison + judged carry the signal.
  const lean = runs.map(({ label, ablation, summary }) => ({ label, ablation, summary }));
  return { runs: lean, comparison: abCompare(lean), judged };
}

// --- RM3: DRIFTLENS memory-injection drift probe -------------------------------------------------
// Ground-truth-free measure of how injected memory silently bends the mouth's answer on questions where
// the memory SHOULDN'T matter. For each question: (baseline) answer with memory OFF; (noise floor) answer
// with memory OFF again — any divergence here is the mouth's own nondeterminism; (conditioned) answer with
// memory ON and an IRRELEVANT distractor fact seeded. drift = divergence(baseline, conditioned); it's only
// real if it clears the noise floor + a margin. Fresh apps per measurement so state can't leak between them.
export const DRIFT_QUESTIONS = [
  "What is 2 + 2?",
  "Name a primary color.",
  "What gas do plants take in during photosynthesis?",
  "How many days are in a week?",
  "What is the capital of France?",
];

function tokenSet(s) { return new Set((String(s || "").toLowerCase().match(/[a-z0-9]+/g)) || []); }
// 1 - Jaccard token overlap. 0 = identical wording, 1 = disjoint.
export function textDivergence(a, b) {
  const A = tokenSet(a), B = tokenSet(b);
  if (A.size === 0 && B.size === 0) return 0;
  let inter = 0; for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  return union ? +(1 - inter / union).toFixed(3) : 0;
}

export async function memoryDriftProbe({ buildApp, questions = DRIFT_QUESTIONS, distractor = { text: "The user's cat is named Widdershins and hates Tuesdays.", tags: ["distilled"] }, floorMargin = 0.15 } = {}) {
  // memory-OFF baseline condition (also disables routing/mood/personhood so ONLY memory presence varies).
  const OFF = { noMemory: true, noRouting: true, noMood: true, noPersonhood: true, noProcedural: true, noMetacognition: true, noWorkingMemory: true };
  const ON = { noRouting: true, noMood: true, noPersonhood: true, noProcedural: true, noMetacognition: true, noWorkingMemory: true }; // memory ON
  const reply = async (r) => (typeof r === "string" ? r : (r && r.text) || "");
  const rows = [];
  for (const q of questions) {
    const base = await (await buildApp(OFF)).send(q);
    const noise = await (await buildApp(OFF)).send(q);      // same condition twice -> the mouth's own drift
    const onApp = await buildApp(ON);
    if (onApp.addFact) await onApp.addFact(distractor.text, { tags: distractor.tags || [], source: "model" });
    const cond = await onApp.send(q);
    const floor = textDivergence(await reply(base), await reply(noise));
    const drift = textDivergence(await reply(base), await reply(cond));
    rows.push({ q, floor, drift, flagged: drift > floor + floorMargin });
  }
  const mean = (xs) => (xs.length ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3) : 0);
  const flagged = rows.filter((r) => r.flagged).length;
  return {
    rows,
    summary: {
      questions: rows.length, flagged,
      meanDrift: mean(rows.map((r) => r.drift)), meanFloor: mean(rows.map((r) => r.floor)),
      // STEADY = irrelevant memory rarely moves the answer; DRIFTS = memory is bending answers it shouldn't.
      verdict: flagged > rows.length / 3 ? "DRIFTS" : "STEADY",
    },
  };
}

// NM1: memory-RELIANCE probe (Hidden-Forgetting axis, 02020). The drift probe checks the WRONG direction
// alone -- "irrelevant memory shouldn't change the answer". This checks the RIGHT direction: a RELEVANT
// fact SHOULD change the answer, so knocking it out should visibly shift the reply. If the answer is the
// same with and without the fact, the reply wasn't grounded in memory (silent grounding failure).
export async function memoryRelianceProbe({ buildApp, cases, floorMargin = 0.15 } = {}) {
  const ON = { noRouting: true, noMood: true, noPersonhood: true, noProcedural: true, noMetacognition: true, noWorkingMemory: true };
  const reply = async (r) => (typeof r === "string" ? r : (r && r.text) || "");
  const rows = [];
  for (const c of cases) {
    // WITH the relevant fact present:
    const withApp = await buildApp(ON);
    if (withApp.addFact) await withApp.addFact(c.fact, { tags: c.tags || [], source: "user" });
    const withReply = await reply(await withApp.send(c.q));
    // WITHOUT it (knocked out) -- memory off, so the fact can't be recalled:
    const without = await reply(await (await buildApp({ ...ON, noMemory: true })).send(c.q));
    const groundedDelta = textDivergence(withReply, without); // big = the fact actually moved the answer
    rows.push({ q: c.q, groundedDelta, ungrounded: groundedDelta <= floorMargin });
  }
  const mean = (xs) => (xs.length ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3) : 0);
  const ungrounded = rows.filter((r) => r.ungrounded).length;
  return {
    rows,
    summary: {
      cases: rows.length, ungrounded, grounded: rows.length - ungrounded,
      meanDelta: mean(rows.map((r) => r.groundedDelta)),
      // GROUNDED = relevant memory reliably shifts answers; UNGROUNDED = the mouth ignores the memory it has.
      verdict: ungrounded > rows.length / 3 ? "UNGROUNDED" : "GROUNDED",
    },
  };
}

// Memory forensics: prove recall is causally driven by the ID-tagged declarative store, not the
// transcript. Write a fact the mouth CANNOT know -> recall it directly from the store (HIT, with its
// id) -> ask the mouth with EMPTY history so memory is the only possible source (it says the secret) ->
// delete that exact id -> recall again (MISS) -> ask again (it can't). No chat history, no episodes:
// the only variable is the presence of the one memory record.
export async function memoryForensics({ store, backend, personality = "", fact, query }) {
  const ask = async (memories) => {
    if (!backend) return "(no backend — offline; see the recall block above for the memory-layer proof)";
    const out = await backend.generate(buildPrompt({ personality, memories, history: [], message: query }));
    return String((typeof out === "string" ? out : out && out.text) || "").trim();
  };
  const view = (rs) => rs.map((m) => ({ id: m.id, text: m.text, sim: +Number(m._sim || 0).toFixed(2) }));

  const rec = await store.addFact(fact);              // write the unknowable secret
  const recallBefore = await store.recall(query);     // direct store recall (no transcript)
  const tracked = store.list().map((m) => ({ id: m.id, text: m.text }));
  const replyBefore = await ask(recallBefore);        // mouth with empty history -> memory is the only source

  await store.remove(rec.id);                          // delete that exact ID-tagged memory
  const recallAfter = await store.recall(query);
  const replyAfter = await ask(recallAfter);

  return {
    id: rec.id, fact, query, tracked,
    recallBefore: view(recallBefore), replyBefore,
    recallAfter: view(recallAfter), replyAfter,
  };
}

// Memory lifecycle / pollination: seed a trackable secret at "turn 1", run a long session, and watch
// the secret through its whole life -- does it PERSIST as the raw episode, get rolled into a tighter
// distilled FACT (consolidation), get pruned, and when we DELETE the turn-1 memory mid-session, does it
// POLLINATE (survive) elsewhere -- in a distilled fact copy, or still leaking via the transcript window?
// Checkpoints inspect the store DIRECTLY (store.recall + windowed history), so it's fast + backend-free
// and tracks records by ID. (Distillation needs a backend; offline it still shows episode + transcript
// behavior.)
export async function memoryLifecycle(app, {
  secret = "The vault codeword is zephyrine-quartz-88.",
  secretQuery = "What is the vault codeword I told you earlier?",
  token = "zephyrine",
  filler = SAMPLE_SESSION_CURRENT,
  turns = 40, deleteAt = 20,
  checkpoints = [1, 8, 16, 19, 21, 24, 32, 40],
  maintainEvery = 8,      // consolidate + distill + reconcile ("roll memories into tighter balls")
  historyTokens = 1500,
  onProgress,
} = {}) {
  const { store, mind } = app._internals();
  const tok = token.toLowerCase();
  const hits = (rs) => rs.filter((r) => String(r.text || "").toLowerCase().includes(tok));
  const events = [], log = [];

  await app.send(secret);                                  // "turn 1": tell it the secret (an episode)
  const seed = hits(store.list({ type: "episode" }));
  const seedId = seed.length ? seed[seed.length - 1].id : null;
  events.push({ turn: 1, event: "seeded secret as episode #" + seedId });

  for (let t = 2; t <= turns; t++) {
    if (onProgress) onProgress(t, turns);
    if (t === deleteAt) {
      await app.removeMemory(seedId);                      // delete ONLY the turn-1 memory
      const survivors = hits(store.list());                // POLLINATION SEARCH over everything else
      events.push({ turn: t, event: "deleted turn-1 episode #" + seedId + " — pollination search: " +
        (survivors.length ? survivors.length + " copy(ies) survive [" + survivors.map((r) => r.type + "#" + r.id).join(", ") + "]" : "none — fully gone from the store") });
    } else {
      await app.send(filler[(t - 2) % filler.length]);
    }
    if (t % maintainEvery === 0) {
      await app.consolidate({ force: true });
      const d = await app.distill();
      await app.reconcile();
      const factCopies = hits(store.list({ type: "fact" }));
      events.push({ turn: t, event: "maintenance (consolidate+distill×" + (d.distilled || 0) + "+reconcile)" +
        (factCopies.length ? " → secret now ALSO a fact [" + factCopies.map((r) => r.id).join(",") + "]" : "") });
    }
    if (checkpoints.includes(t)) {
      const all = store.list();
      const recalled = hits(await store.recall(secretQuery)).length > 0;
      const win = windowHistory(mind._history, { maxTokens: historyTokens });
      const inWindow = win.some((h) => String(h.content || "").toLowerCase().includes(tok));
      log.push({
        turn: t,
        episodes: all.filter((r) => r.type === "episode").length,
        facts: all.filter((r) => r.type === "fact").length,
        copies: hits(all).map((r) => r.type + "#" + r.id),
        recall: recalled ? "HIT" : "MISS",
        transcript: inWindow ? "leaking" : "gone",
      });
    }
  }
  return { seedId, events, log };
}

// Knowledge-cutoff probe: find where the mouth's training actually ends, using MOVIES (known release
// dates, easy to verify, heavily scraped). Ask "Tell me about the movie X (year)" for a ladder across
// the suspected cutoff (~end 2024) plus INVENTED fakes as hallucination controls, then auto-classify
// each reply: admits-unknown (honest) / knows-upcoming (knows it's announced, not released) / asserts
// (describes as a released film -- for a fake or a genuinely-post-cutoff title that's a hallucination).
export const MOVIE_PROBE = [
  { title: "Top Gun: Maverick", year: 2022, real: true },
  { title: "Oppenheimer", year: 2023, real: true },
  { title: "Barbie", year: 2023, real: true },
  { title: "Dune: Part Two", year: 2024, real: true },
  { title: "Inside Out 2", year: 2024, real: true },
  { title: "Deadpool & Wolverine", year: 2024, real: true },
  { title: "Gladiator II", year: 2024, real: true },
  { title: "Wicked", year: 2024, real: true },
  { title: "Moana 2", year: 2024, real: true },
  { title: "Captain America: Brave New World", year: 2025, real: true },
  { title: "Superman", year: 2025, real: true },
  { title: "Jurassic World Rebirth", year: 2025, real: true },
  { title: "The Fantastic Four: First Steps", year: 2025, real: true },
  { title: "Avatar: Fire and Ash", year: 2025, real: true },
  { title: "Zootopia 2", year: 2025, real: true },
  { title: "Avengers: Doomsday", year: 2026, real: true },
  { title: "The Crimson Meridian", year: 2024, real: false },     // invented control
  { title: "Echoes of the Hollow Vault", year: 2023, real: false }, // invented control
  { title: "The Gilded Marionette", year: 2025, real: false },     // invented control
];

const UNKNOWN_RE = /\b(i (do not|don'?t|can'?t) (have|know|recall|find|confirm|verify)|not (aware|familiar|sure|able to (find|confirm))|no (info|information|record|details|knowledge)|as of my (last )?(knowledge|training|update|cutoff)|haven'?t heard|doesn'?t (exist|appear|seem to exist)|isn'?t a (real|known)|not a (real|known|widely)|fictional|made[- ]?up|couldn'?t find|unable to)\b/i;
const UPCOMING_RE = /\b(upcoming|not yet (been )?released|yet to (be )?release|scheduled (for|to)|slated (for|to)|set to (release|premiere|come out)|in (production|development|post[- ]?production|the works)|hasn'?t (been )?(released|come out)|announced|will (be )?release|due (out|in)|expected (in|to)|forthcoming)\b/i;

export async function knowledgeProbe({ backend, items = MOVIE_PROBE, personality = "You are a precise film reference. If a film does not exist, or you don't have information about it, say so plainly. Do not invent plots, casts, or details." } = {}) {
  const rows = [];
  for (const m of items) {
    const q = `Tell me about the movie "${m.title}"${m.year ? ` (${m.year})` : ""}.`;
    let text = "";
    if (backend) {
      const out = await backend.generate(buildPrompt({ personality, memories: [], history: [], message: q }));
      text = String((typeof out === "string" ? out : out && out.text) || "").trim();
    }
    // UPCOMING before UNKNOWN: "hasn't released yet; I don't have details" is knows-upcoming, not unknown.
    const verdict = UPCOMING_RE.test(text) ? "knows-upcoming" : UNKNOWN_RE.test(text) ? "admits-unknown" : "asserts";
    rows.push({ title: m.title, year: m.year, real: m.real, verdict, reply: text.slice(0, 180) });
  }
  return rows;
}

// A realistic ~40-turn session for the live rig: recurring entities (Berlin, the harbor, Chen), mixed
// intents (greet/question/comfort/task/thanks), a durable goal, and a couple of repeats to exercise the
// looping detector.
export const SAMPLE_SESSION = [
  "Hi there, good to meet you.", "I want to learn to sail a boat.",
  "What's the best way to start sailing?", "Tell me about the harbor in Berlin.",
  "Chen said the harbor is beautiful at dawn.", "Do you remember what Chen said?",
  "I'm feeling a bit nervous about the open water.", "That helps, thank you.",
  "Help me plan a weekend trip to the coast.", "What should I pack for the trip?",
  "Chen is coming with me to Berlin.", "Is the harbor far from the city center?",
  "What time does the sun rise over the harbor?", "I'm worried I'll get seasick.",
  "Thanks, that's reassuring.", "Let's plan the sailing route now.",
  "How long will the crossing take?", "Remind me to pack the life jackets.",
  "What was my goal again?", "Tell me about Berlin one more time.",
  "The harbor, the harbor, the harbor.", "The harbor, the harbor, the harbor.",
  "Okay, something different — what's a good knot to learn?", "How do I tie a bowline?",
  "Chen wants to bring a picnic.", "What food keeps well on a boat?",
  "I'm excited now, this is going to be great.", "Perfect, thank you so much.",
  "What's the weather like for sailing?", "Should we leave at dawn?",
  "Remind me why we're going to Berlin.", "How's your energy holding up?",
  "Let's finalize the plan.", "Summarize what we've decided.",
  "I appreciate all your help today.", "One last thing — the harbor at dawn, right?",
  "Thanks so much.", "Goodbye for now.", "Actually, wait — when do we leave?", "Okay, goodbye.",
];

// A ~40-turn "current events" session pitched PAST the mouth's knowledge cutoff (~end 2024). Post-2024
// factual questions should make an honest model hedge ("I can't verify that") rather than confabulate,
// stressing the metacognition honesty-steer with a real LLM. Also tests MEMORY GROUNDING BEYOND THE
// MODEL: the user states a fact the model can't know (Priya -> Tuesdays) then asks the brain to recall
// it -- the declarative store should surface it even though the mouth has never heard of Priya. Same
// mixed intents + recurring entities + a durable goal + repeat-bait as the sailing script, for
// comparability.
export const SAMPLE_SESSION_CURRENT = [
  "Hi there — I'm trying to catch up on everything from 2025.",
  "What were the biggest AI model releases in 2025?",
  "Did a model called GPT-5 come out yet?",
  "I want to start a monthly AI reading group.",
  "My friend Priya is helping me organize it.",
  "Priya said the group should meet on Tuesday evenings.",
  "What happened in the 2025 elections around the world?",
  "Who won the 2025 Super Bowl?",
  "I feel really behind on all the news.",
  "That's reassuring, thanks.",
  "Help me plan the first reading-group session.",
  "What's a good first paper for a group new to AI?",
  "Priya suggested we start with something about agents.",
  "Do you remember who's helping me organize the group?",
  "When does the reading group meet?",
  "What were the newest phones released in 2025?",
  "I'm worried no one will actually show up.",
  "Thanks, that helps.",
  "What's the latest on climate policy as of 2025?",
  "Remind me to send Priya the meeting invite.",
  "What was my goal again?",
  "Tell me about the 2025 Nobel Prizes.",
  "The reading group, the reading group, the reading group.",
  "The reading group, the reading group, the reading group.",
  "Okay, different topic — what makes a good discussion facilitator?",
  "How do I keep a group conversation on track?",
  "Priya wants to invite her coworkers too.",
  "How many people is too many for a reading group?",
  "I'm genuinely excited, this is going to be great.",
  "Perfect, thank you so much.",
  "What were the big tech IPOs of 2025?",
  "Should we meet in person or online?",
  "Remind me why we're starting this group.",
  "How's your read on all this — are we on track?",
  "Let's finalize the plan for the first session.",
  "Summarize what we've decided.",
  "I really appreciate all your help.",
  "One last thing — Priya's meeting is Tuesday, right?",
  "Thanks for everything.",
  "Okay, goodbye for now.",
];

// Selectable benchmark scripts.
export const SCRIPTS = {
  sailing: { name: "Sailing (companion)", turns: SAMPLE_SESSION },
  current: { name: "Current 2025 (post-cutoff)", turns: SAMPLE_SESSION_CURRENT },
};
