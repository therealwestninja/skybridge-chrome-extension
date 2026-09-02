// Council — an action-SELECTION / arbitration faculty (a basal-ganglia-like gate). The rest of the brain is a
// monolith with one decision pipe (mind.js: features -> organism -> readAction). A council makes it a PARLIAMENT:
// several faculties (reflex / executive / volition / imagination / the organism itself) each PROPOSE a candidate
// action, and this resolves ONE winner from the competing proposals — recording the losers, the margin, and the
// dissent (a native explanation trace).
//
// The load-bearing idea: NEUROMODULATION re-weights the vote, so the SAME proposals resolve to DIFFERENT winners in
// different moods — dopamine favours approach/reward proposers, norepinephrine favours caution/threat, serotonin
// favours deliberate/patient ones, acetylcholine favours focus. That is exactly how the basal ganglia gate cortical
// action candidates under dopamine: high dopamine -> a candidate wins decisively; DEPLETED dopamine -> nothing wins
// strongly and the system freezes between options (the circuit signature of Parkinson's). So a council makes
// mood -> behaviour a MECHANISM (a vote tilt), not an ad-hoc coupling — and gives the brain the subcortical gate it
// was missing: the thing that turns parallel faculty activity into one chosen act.
//
// Two entry points: `resolve` is the pure parliamentary tally (explicit ballots — members voting on each other),
// extracted + cleaned from the Chloe/Rook "Seven Nations". `makeCouncil().deliberate` is the brain-native gate:
// each proposal carries a self-confidence + tags, the mood tilts them, and it's winner-take-most. Pure + testable.

import { clamp } from "./math.js";
import { DEFAULT_SETPOINTS } from "./neuromodulation.js";

// Which neuromodulator gates which KIND of proposal. Tags on a proposal say what sort of act it is; the channel's
// level scales that proposal's weight. Override via config.channelForTag.
const TAG_CHANNEL = {
  approach: "dopamine", reward: "dopamine", seek: "dopamine", play: "dopamine", curious: "dopamine",
  caution: "norepinephrine", threat: "norepinephrine", avoid: "norepinephrine", protect: "norepinephrine", safety: "norepinephrine",
  deliberate: "serotonin", patient: "serotonin", reflect: "serotonin", plan: "serotonin", steady: "serotonin",
  focus: "acetylcholine", attend: "acetylcholine", salient: "acetylcholine",
};

// INHIBITORY (indirect / NO-GO pathway) tags: the channel SUPPRESSES the proposal — the opposite sign to the tags
// above. This models the striatal indirect pathway, which dopamine INHIBITS (Frank 2005): high dopamine WEAKENS a
// "withhold" brake (making action easier to release, even inappropriately), low dopamine STRENGTHENS it (freezing
// action). With the excitatory (direct/GO) tags above, this completes a direct/indirect OPPONENT gate — the piece
// that lets a dopamine sweep reproduce the full therapeutic window (akinesia ↔ efficacy ↔ dyskinesia), not just
// the efficacy half. Off unless a proposal actually carries one of these tags, so all prior behaviour is unchanged.
const NOGO_CHANNEL = { withhold: "dopamine", nogo: "dopamine", brake: "dopamine" };

// Rough per-channel setpoints, so a level AT rest is a neutral (1.0) tilt and only departures from baseline bias the vote.
const REST = DEFAULT_SETPOINTS; // the single source of truth (was a hardcoded copy that would silently desync if setpoints were retuned)

// The mood tilt for one proposal: product over its tags of (1 ± gain*(level - rest_of_its_channel)) — `+` for
// excitatory (GO) tags, `−` for inhibitory (NO-GO) tags. A proposal with no recognised tags is untilted (1.0).
// `chem` is a map of channel -> current level (from neuromodulation.level()).
export function moodTilt(tags = [], chem = null, { gain = 1.1, channelForTag = TAG_CHANNEL, nogoForTag = NOGO_CHANNEL, rest = REST } = {}) {
  if (!chem || !tags || !tags.length) return 1;
  let m = 1;
  for (const tag of tags) {
    const exc = channelForTag[tag];
    if (exc && chem[exc] != null) { m *= clamp(1 + gain * (chem[exc] - (rest[exc] ?? 0.3)), 0.1, 3); continue; }
    const inh = nogoForTag[tag]; // indirect/NO-GO: dopamine (etc.) SUPPRESSES this proposal
    if (inh && chem[inh] != null) { m *= clamp(1 - gain * (chem[inh] - (rest[inh] ?? 0.3)), 0.1, 3); }
  }
  return m;
}

// Pure parliamentary tally. proposals: [{by, action?, text?, conf}]. ballots: [{voter, scores:{by:number}}].
// vetoes: [{by, against, reason}]. Returns the winner + a full, inspectable trace. Deterministic (no rng).
export function resolve(proposals = [], ballots = [], vetoes = [], config = {}) {
  const { allowSelfVote = false, vetoQuorum = 1, consensusMargin = 0 } = config;
  // dedupe proposers by id, drop malformed
  const seen = new Set();
  const props = proposals.filter((p) => p && p.by != null && !seen.has(p.by) && seen.add(p.by));

  // vetoes: a proposer with >= quorum vetoes against it is struck (unless that would leave nobody, then keep all)
  const vetoCount = {}, vetoWhy = {};
  for (const v of vetoes) if (v && v.against != null) { vetoCount[v.against] = (vetoCount[v.against] || 0) + 1; (vetoWhy[v.against] = vetoWhy[v.against] || []).push({ by: v.by, reason: v.reason || "" }); }
  const struck = (id) => (vetoCount[id] || 0) >= vetoQuorum;
  let live = props.filter((p) => !struck(p.by));
  let allVetoed = false;
  if (!live.length && props.length) { live = props.slice(); allVetoed = true; } // never deadlock

  // tally: sum each voter's score for each live proposer (skip self unless allowed). Also track each voter's TOP pick.
  const tally = {}; live.forEach((p) => (tally[p.by] = 0));
  const topOf = {};
  for (const b of ballots || []) {
    if (!b || !b.scores) continue;
    let best = null, bestS = -Infinity;
    for (const p of live) {
      if (!allowSelfVote && b.voter === p.by) continue;
      const s = Number(b.scores[p.by]);
      if (!isFinite(s)) continue;
      tally[p.by] += s;
      if (s > bestS) { bestS = s; best = p.by; }
    }
    if (best != null) topOf[b.voter] = best;
  }

  // rank: score, then self-confidence, then proposal order (stable)
  const order = new Map(live.map((p, i) => [p.by, i]));
  const conf = Object.fromEntries(live.map((p) => [p.by, Number(p.conf) || 0]));
  const ranked = live.slice().sort((a, b) => (tally[b.by] - tally[a.by]) || (conf[b.by] - conf[a.by]) || (order.get(a.by) - order.get(b.by)));
  const win = ranked[0] || null, second = ranked[1] || null;
  const margin = win ? tally[win.by] - (second ? tally[second.by] : 0) : 0;

  // consensus = every voter's top pick is the winner; dissent = voters who wanted someone else
  const voters = Object.keys(topOf).filter((v) => allowSelfVote || !win || v !== win.by);
  const consensus = !!win && voters.length > 0 && voters.every((v) => topOf[v] === win.by);
  const dissent = win ? voters.filter((v) => topOf[v] !== win.by) : [];
  const status = !win ? "no-proposals" : allVetoed ? "contested" : consensus ? "agreed" : margin <= consensusMargin ? "tie-resolved" : "carried";

  return {
    winner: win ? win.by : null,
    action: win ? (win.action ?? null) : null,
    text: win ? (win.text ?? null) : null,
    status, tally, margin: +margin.toFixed(4), consensus,
    dissent, vetoed: Object.keys(vetoCount).filter(struck), vetoReasons: vetoWhy,
  };
}

// The brain-native gate. proposals: [{by, action, text?, conf, tags?}]. Each proposal's weight = conf * moodTilt(tags,
// chem); vetoes strike proposals; winner-take-most. `chem` comes from a neuromodulation field (level()) — inject one,
// or pass mood per-call. Returns the resolve() trace PLUS the tilt weights applied (so the decision is fully legible).
export function makeCouncil({ neuromodulation = null, config = {}, onFault } = {}) {
  const chemFrom = () => {
    if (!neuromodulation || !neuromodulation.level) return null;
    const c = {}; for (const ch of Object.keys(REST)) { try { c[ch] = neuromodulation.level(ch); } catch (e) { if (onFault) onFault("council.chemLevel:" + ch, e); } }
    return c;
  };
  return {
    resolve,
    moodTilt,
    // One arbitration round: tilt each proposal by mood, then a single-ballot winner-take-most (each proposal "votes"
    // its own tilted weight). This is the basal-ganglia gate — parallel candidates in, one gated act out.
    deliberate(proposals = [], { chem = null, vetoes = [] } = {}) {
      const c = chem || chemFrom();
      const weights = {};
      const tilted = proposals.filter((p) => p && p.by != null).map((p) => {
        const w = moodTilt(p.tags || [], c, config);
        weights[p.by] = +w.toFixed(3);
        return { ...p, conf: (Number(p.conf) || 0) * w };
      });
      // a single self-ballot: every proposal scored by its tilted weight (a salience gate, not cross-voting)
      const ballot = { voter: "__gate__", scores: Object.fromEntries(tilted.map((p) => [p.by, p.conf])) };
      const out = resolve(tilted, [ballot], vetoes, { allowSelfVote: true, ...config });
      out.weights = weights; // the mood tilt applied to each proposer — the "why this won in this mood"
      return out;
    },
  };
}
