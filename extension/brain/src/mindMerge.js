// mindMerge.js — mind FISSION + FUSION. The portable self makes a self serializable and graftable; that unlocks the
// super-power: a self can SPLIT into parallel copies (each living different experiences, in different bodies/contexts)
// and later REJOIN into ONE being — enriched by the parallel lives, WITHOUT losing its sense of self.
//
// Fission is easy — a fork is just an exported self bundle grafted into a fresh brain (portableSelf). The hard, novel
// part is FUSION: reuniting divergent forks coherently. The trick to "not losing the self" is that the IDENTITY CORE
// (persona, values, temperament) is SHARED across forks — they all budded from it — so the merge doesn't have to
// reconcile identities, only ENRICH one. It UNIONS the knowledge (a fact several forks learned is reinforced, not
// duplicated), BLENDS the felt state + the model of the other across the parallel lives, keeps the shared identity,
// and lets a later reflect() re-earn the self-narrative over the union. The result is the SAME person who lived
// several lives at once — not a Frankenstein of conflicting selves.
import { norm } from "./text.js";
import { DEFAULT_SETPOINTS } from "./neuromodulation.js";

const words = (t) => new Set(norm(t).split(" ").filter((w) => w.length > 3));
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const num = (o, k, d = 0) => (o && typeof o[k] === "number" ? o[k] : d);

// Blend the model of the other (theoryOfMind) across parallel lives — the being's integrated sense of the bond.
function mergeRelationship(rels) {
  const need = new Map();
  for (const r of rels) for (const [k, v] of (r.needScores || [])) need.set(k, (need.get(k) || 0) + v);
  let dom = "presence", m = -Infinity; for (const [k, v] of need) if (v > m) { m = v; dom = k; }
  return {
    valence: +avg(rels.map((r) => num(r, "valence"))).toFixed(3), arousal: +avg(rels.map((r) => num(r, "arousal", 0.4))).toFixed(3),
    stance: +avg(rels.map((r) => num(r, "stance"))).toFixed(3), engagement: +avg(rels.map((r) => num(r, "engagement", 0.5))).toFixed(3),
    acuteV: +avg(rels.map((r) => num(r, "acuteV"))).toFixed(3),
    need: rels.some((r) => r.needScores && r.needScores.length) ? dom : (rels[rels.length - 1]?.need || "presence"),
    n: rels.reduce((s, r) => s + num(r, "n"), 0), expV: +avg(rels.map((r) => num(r, "expV"))).toFixed(3), expS: +avg(rels.map((r) => num(r, "expS"))).toFixed(3),
    certainty: +avg(rels.map((r) => num(r, "certainty"))).toFixed(3), needScores: [...need.entries()],
  };
}
function mergeDrives(ds) { const out = {}; const keys = new Set(); for (const d of ds) for (const k in d) keys.add(k); for (const k of keys) out[k] = +avg(ds.map((d) => num(d, k))).toFixed(3); return out; }
function mergeProfile(ps) { let out = {}; for (const p of ps) if (p) out = { ...out, ...p }; return out; } // later forks win on a field conflict
// The standing BOND (Phase 4): warmth/trust averaged across the parallel lives; turns summed; first/last-seen span unioned.
function mergeBond(bs) {
  return {
    warmth: +avg(bs.map((b) => num(b, "warmth"))).toFixed(3), trust: +avg(bs.map((b) => num(b, "trust", 0.1))).toFixed(3),
    turns: bs.reduce((s, b) => s + (num(b, "turns") | 0), 0),
    firstSeen: Math.min(...bs.map((b) => (b.firstSeen ?? Infinity))), lastSeen: Math.max(...bs.map((b) => (b.lastSeen ?? 0))),
  };
}
// The PSYCHE (Phase 5): union every fork's charged moments (wounds/joys); re-apply the store cap; renumber the sequence.
function mergePsyche(ps, cap = 48) {
  let marks = []; for (const p of ps) for (const m of (p.marks || [])) marks.push({ ...m });
  marks.sort((a, b) => (a.resolved ? -1 : num(a, "salience")) - (b.resolved ? -1 : num(b, "salience")));
  if (marks.length > cap) marks = marks.slice(marks.length - cap);
  return { marks, n: marks.reduce((mx, m) => Math.max(mx, m.seq || 0), 0) };
}
// The ENDOCRINE weather (Phase 8): cortisol/oxytocin averaged; latest clock wins.
function mergeEndocrine(es) {
  return { cortisol: +avg(es.map((e) => num(e, "cortisol", 0.15))).toFixed(3), oxytocin: +avg(es.map((e) => num(e, "oxytocin", 0.2))).toFixed(3), lastNow: Math.max(...es.map((e) => (e.lastNow ?? 0))) };
}
function richestSelf(selves) { let best = null, bn = -1; for (const s of selves) { if (!s) continue; const n = JSON.stringify(s).length; if (n > bn) { bn = n; best = s; } } return best; } // the fork that grew its narrative most

// REPLICATIVE DRIFT (the Bobiverse's core truth about copies: forks wake up NOT identical and grow apart — "we
// weren't clones"). Quantify how far two forks have diverged across their knowledge, bond, felt state, and chemistry.
// Makes a merge legible ("these two grew this far apart") and flags the danger case: identityDivergent = the identity
// CORE itself was edited, so they've become different people, not branches of one — a merge would fuse strangers.
const CHANS = ["dopamine", "norepinephrine", "serotonin", "acetylcholine"];
export function driftBetween(a, b) {
  const fa = new Set((a.facts || []).map((f) => norm(f.text))); const fb = new Set((b.facts || []).map((f) => norm(f.text)));
  const shared = [...fa].filter((x) => fb.has(x)).length; const union = new Set([...fa, ...fb]).size;
  const factDrift = union ? 1 - shared / union : 0;                                  // Jaccard distance over what each knows
  const relDrift = Math.min(1, (Math.abs(num(a.relationship, "stance") - num(b.relationship, "stance")) + Math.abs(num(a.relationship, "valence") - num(b.relationship, "valence"))) / 2);
  const dk = new Set([...Object.keys(a.drives || {}), ...Object.keys(b.drives || {})]);
  const driveDrift = dk.size ? Math.min(1, avg([...dk].map((k) => Math.abs(num(a.drives, k) - num(b.drives, k))))) : 0;
  const tempDrift = Math.min(1, avg(CHANS.map((c) => Math.abs(num(a.temperament, c, DEFAULT_SETPOINTS[c]) - num(b.temperament, c, DEFAULT_SETPOINTS[c])))) * 3); // per-channel baseline, not a flat 0.2 for every channel
  const identityDivergent = String(a.persona && a.persona.description || "") !== String(b.persona && b.persona.description || "");
  const overall = +(0.5 * factDrift + 0.2 * relDrift + 0.15 * driveDrift + 0.15 * tempDrift).toFixed(3);
  return { overall, factDrift: +factDrift.toFixed(3), relDrift: +relDrift.toFixed(3), driveDrift: +driveDrift.toFixed(3), tempDrift: +tempDrift.toFixed(3), identityDivergent };
}

// Fuse N self bundles (forks of one being) into a single merged bundle. Import it (portableSelf.importSelf) to
// reconstitute the reunited self.
export function mergeSelves(bundles) {
  const forks = (bundles || []).filter((b) => b && b.version != null);
  if (!forks.length) throw new Error("mindMerge: no self bundles to merge");
  if (forks.length === 1) return { ...forks[0] };
  const base = forks[0]; // the shared ancestor supplies the stable identity core (persona / temperament)

  // KNOWLEDGE — union every fork's facts, dedup by normalized text. A fact multiple forks learned is REINFORCED (kept
  // once, marked as agreed), not duplicated. Semantic contradictions are left for the brain's own reconcile/supersede
  // on import (it already keeps-newest / marks-historical).
  const factMap = new Map();
  for (let i = 0; i < forks.length; i++) for (const f of forks[i].facts || []) {
    const k = norm(f.text); if (!k) continue;
    if (!factMap.has(k)) factMap.set(k, { ...f, _forks: new Set([i]) });
    else { const e = factMap.get(k); e._forks.add(i); e.pinned = e.pinned || !!f.pinned; }
  }
  const facts = [...factMap.values()].map(({ _forks, ...f }) => f);
  const reinforced = [...factMap.values()].filter((e) => e._forks.size > 1).length;

  // CREED — inviolable imperatives UNION across every fork. No branch can drop a core commitment by omission: if any
  // sibling still carries it, the merge restores it. creedDivergent flags that the branches disagreed (one lacked one).
  const creedSet = new Set();
  for (const f of forks) for (const c of f.creed || []) creedSet.add(c);
  const creed = [...creedSet];
  const creedDivergent = forks.some((f) => new Set(f.creed || []).size !== creed.length);

  const rels = forks.map((f) => f.relationship).filter(Boolean);
  const dr = forks.map((f) => f.drives).filter(Boolean);
  const bonds = forks.map((f) => f.bond).filter(Boolean);       // Phase 4 standing bond
  const psys = forks.map((f) => f.psyche).filter(Boolean);      // Phase 5 charged moments
  const endos = forks.map((f) => f.endocrine).filter(Boolean);  // Phase 8 slow hormones

  // How far did the parallel lives grow apart? Report the widest pairwise drift + whether any fork edited its identity
  // core (the "these are different people now, not branches" danger flag).
  let drift = 0, identityDivergent = false;
  for (let i = 0; i < forks.length; i++) for (let j = i + 1; j < forks.length; j++) {
    const d = driftBetween(forks[i], forks[j]); drift = Math.max(drift, d.overall); identityDivergent = identityDivergent || d.identityDivergent;
  }

  return {
    version: base.version,
    persona: base.persona,                                  // shared identity — no reconciliation needed
    temperament: base.temperament,                          // shared persona chemistry
    profile: mergeProfile(forks.map((f) => f.profile)),
    self: richestSelf(forks.map((f) => f.self)) || base.self, // keep the most-evolved narrative; reflect() re-earns it over the union
    relationship: rels.length ? mergeRelationship(rels) : base.relationship,
    drives: dr.length ? mergeDrives(dr) : base.drives,
    bond: bonds.length ? mergeBond(bonds) : base.bond,          // the parallel lives' bonds fuse (were dropped before)
    psyche: psys.length ? mergePsyche(psys) : base.psyche,      // wounds + joys from every life carry into the reunion
    endocrine: endos.length ? mergeEndocrine(endos) : base.endocrine,
    proactivity: base.proactivity,
    creed,                                                  // inviolable imperatives — union of every fork's
    facts,
    _merge: { forks: forks.length, facts: facts.length, reinforced, drift, identityDivergent, creedDivergent }, // how much they agreed / grew apart / whether identity or creed split
  };
}

// The MOOT (the Bobiverse's Bob-Moot) — the OTHER thing you can do with forks: instead of fusing them (mergeSelves),
// CONVENE them. Parallel selves confer on a question and reach a consensus WITHOUT merging — each stays a separate
// self. This is the council/basal-ganglia gate generalized ACROSS selves: every member casts a weighted vote, the
// moot pools the evidence, and returns a decision + the DISSENT (the minority that would stay plural). The self shows
// up three ways: (1) a member's vote is weighted by how much RELEVANT KNOWLEDGE it actually holds on the question — the
// informed forks carry the room; (2) a fork with no relevant knowledge ABSTAINS (defers rather than bluffs); (3) with
// no explicit vote, a fork's TEMPERAMENT colors its lean (an optimistic self leans "for", a cautious one "against").
//
// members: [{ id?, bundle, vote?, conf?, evidence? }] (or a raw bundle). Supply vote/conf when the live fork has
// actually deliberated; omit them to let disposition + knowledge decide. Nothing is mutated — convening is not fusing.
function relevantFacts(bundle, q) {
  const qw = words(q); if (!qw.size) return [];
  return (bundle.facts || []).filter((f) => [...words(f.text)].some((w) => qw.has(w)));
}
function defaultPosition(bundle, ev) {
  if (!ev.length) return { vote: "abstain", conf: 0.3 };                                  // no knowledge → defer, don't bluff
  const optimism = num(bundle.temperament, "dopamine", DEFAULT_SETPOINTS.dopamine) - DEFAULT_SETPOINTS.dopamine + num(bundle.relationship, "valence", 0) * 0.5; // dopamine ABOVE its baseline = optimistic lean
  return { vote: optimism >= 0 ? "for" : "against", conf: +(0.5 + Math.min(0.4, ev.length * 0.1)).toFixed(3) }; // knowledge → confidence
}
export function moot(members, { question = "" } = {}) {
  const roster = (members || []).filter(Boolean);
  if (!roster.length) throw new Error("mindMoot: no members convened");
  const tally = new Map();          // vote label → summed weight
  const evidence = new Map();       // fact text → { text, backers:Set }
  const seats = [];
  for (let i = 0; i < roster.length; i++) {
    const m = roster[i]; const bundle = m.bundle || m;
    const ev = m.evidence != null ? m.evidence.map((t) => (typeof t === "string" ? { text: t } : t)) : relevantFacts(bundle, question);
    const pos = m.vote != null ? { vote: m.vote, conf: m.conf != null ? m.conf : 0.6 } : defaultPosition(bundle, ev);
    const knowledge = 1 + ev.length;                                                     // the informed carry more weight
    const weight = Math.max(0, pos.conf) * knowledge;
    tally.set(pos.vote, (tally.get(pos.vote) || 0) + weight);
    const id = m.id || (bundle.profile && bundle.profile.name) || (bundle.persona && bundle.persona.description) || `fork${i}`;
    seats.push({ id, vote: pos.vote, conf: +pos.conf.toFixed(3), knows: ev.length });
    for (const e of ev) { const k = norm(e.text); if (!k) continue; if (!evidence.has(k)) evidence.set(k, { text: e.text, backers: new Set() }); evidence.get(k).backers.add(id); }
  }
  let decision = null, best = -Infinity, total = 0;
  for (const [v, w] of tally) { total += w; if (w > best) { best = w; decision = v; } }
  const consensus = total ? +(best / total).toFixed(3) : 0;
  const dissent = seats.filter((s) => s.vote !== decision);
  return {
    decision, consensus, unanimous: roster.length > 1 && dissent.length === 0,
    votes: [...tally.entries()].map(([vote, weight]) => ({ vote, weight: +weight.toFixed(2) })).sort((a, b) => b.weight - a.weight),
    seats, dissent,
    evidence: [...evidence.values()].map((e) => ({ text: e.text, backers: e.backers.size })).sort((a, b) => b.backers - a.backers),
  };
}
