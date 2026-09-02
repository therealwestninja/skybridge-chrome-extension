import { clamp, clamp01 } from "./math.js";
// psyche.js — Phase 5: affective memory, rumination, and rupture/repair. The relationship (Phase 4) tracks the STANDING
// bond; the psyche tracks the CHARGED MOMENTS underneath it — the rough turn that stung, the warm one that mattered —
// and, crucially, lets a wound LINGER and RE-OPEN until something heals it. That is what turns "behaviour = f(prompt)"
// into "behaviour = f(everything that has passed between us)": the companion can be a little off later for a reason you
// have to go digging to find, and a warm repair can genuinely make peace.
//
// Adapted from browser-sweetie's town psyche, but for the 1:1 core: it does NOT own a neuromodulation field (the brain
// already has one) — it is a pure MEMORY organ. Re-living a wound (rumination) and the relief of repair route their
// chemistry through the brain's existing organism (app wires that). Persisted, so "the hard moment earlier" survives a
// reload and can still resurface next session.


// Self-relevance cues: a wound is more "canxian" (recurrence-prone) the more it touches identity, the bond, or
// competence — "you failed me" gnaws where "a generic bad mood" does not. Cheap keyword estimate when the caller
// doesn't supply a measured self-relevance (the app passes one from the standing bond).
const SELF_CUES = /\b(us|we|you|your|me|my|i|trust|care|caring|fail|failed|failure|hurt|wound|love|bond|apart|abandon|abandoned|ignore|ignored|reject|between us|who i am)\b/i;
const CORE_CUES = /\bbetween us|trust|abandon|reject|who i am|failed you|let you down\b/i;
function estimateSelfRelevance(note) {
  const s = String(note || ""); let r = 0.4;
  if (SELF_CUES.test(s)) r += 0.4;
  if (CORE_CUES.test(s)) r += 0.2;
  return r > 1 ? 1 : r;
}

export function makePsyche({ recordThreshold = 0.3, decay = 0.9985, cap = 48, pickHeal = 0.94,
  // Canxianization (2605.12543): rank recurrence by SelfRelevance×Value×Unresolvedness×ClosureResistance, and
  // split PRODUCTIVE recurrence (re-living moves the self-model) from PATHOLOGICAL rumination (recurs a lot,
  // changes nothing → decouple/damp it). Set canxian:false to fall back to the old raw-salience pick (ablation).
  canxian = true, pathoRpi = 3, pathoCui = 0.34, pathoDamp = 0.72,
  // Proportional repair: a warm turn PARTIALLY heals rather than wholesale-wiping every wound. Each warm turn
  // advances a per-wound `repair` meter by an increment scaled by warmth and INVERSELY by how deep/self-relevant
  // and hard-to-close the wound is; a wound only resolves once its meter crosses `repairThreshold`. So a shallow
  // wound makes peace in a turn or two, while a deep, self-relevant one needs repeated warmth (or acknowledgment).
  repairThreshold = 0.6, repairGain = 0.5, repairResistK = 0.6, repairFloor = 0.05 } = {}) {
  let marks = []; // { seq, valence, arousal, note, salience, salience0, at, resolved, selfRelevance, closureResistance, rpi, updates }
  let n = 0;
  let lastRuminated = null; // seq of the mark returned by the most recent ruminate() — for noteUpdate()/CUI

  function prune() {
    if (marks.length <= cap) return;
    marks.sort((a, b) => (a.resolved ? -1 : a.salience) - (b.resolved ? -1 : b.salience)); // most forgettable first
    marks.splice(0, marks.length - cap);
  }

  // Lay down a charged emotional moment (from a turn's read of the user). valence<0 = a rupture/wound, >0 = a joy.
  // Only charged-enough moments are remembered; the rest wash through. Returns the mark, or null if too faint.
  function record({ valence = 0, arousal = 0.4, note = "", at = 0, selfRelevance = null, closureResistance = null } = {}) {
    const charge = Math.abs(valence) * (0.5 + clamp(arousal, 0, 1));
    if (charge <= recordThreshold) return null;
    const m = {
      seq: ++n, valence: +valence.toFixed(3), arousal: +arousal.toFixed(3), note: String(note || ""),
      salience: +charge.toFixed(3), salience0: +charge.toFixed(3), at, resolved: false,
      // canxian terms: S self-relevance (measured or estimated), C closure-resistance (how hard it is to ACT to
      // close it — the app supplies this from volition/predictor; default moderately resistant), and the two
      // recurrence indices — rpi (how often it has resurfaced), updates (how often re-living it moved anything).
      selfRelevance: selfRelevance == null ? estimateSelfRelevance(note) : clamp(selfRelevance, 0, 1),
      closureResistance: closureResistance == null ? 0.6 : clamp(closureResistance, 0, 1),
      rpi: 0, updates: 0, repair: 0, // repair: per-wound cumulative healing meter (0..1); resolves at repairThreshold
    };
    marks.push(m); prune();
    return m;
  }

  const openWounds = () => marks.filter((m) => !m.resolved && m.valence < 0 && m.salience > 0.15).sort((a, b) => b.salience - a.salience);
  const joys = () => marks.filter((m) => m.valence > 0 && m.salience > 0.15).sort((a, b) => b.salience - a.salience);

  // The canxian score: what keeps returning is not the LOUDEST wound but the most SELF-RELEVANT, still-UNRESOLVED,
  // hard-to-CLOSE one. score = S × V × U × C. U (unresolvedness) is the fraction of the original charge still
  // unhealed, so picking/decay lowers a wound's pull over time.
  function canxianScore(m) {
    const V = Math.abs(m.valence);
    const U = clamp(m.salience / Math.max(m.salience0 || m.salience, 1e-6), 0, 1);
    const S = m.selfRelevance == null ? estimateSelfRelevance(m.note) : m.selfRelevance;
    const C = m.closureResistance == null ? 0.6 : m.closureResistance;
    return S * V * U * C;
  }

  // Dwell on the wound that most WANTS to return (canxian score), not merely the heaviest. Re-living increments its
  // Recurrent Priority Index (rpi); its Canxian Update Index (cui = updates/rpi) says whether returning has been
  // PRODUCTIVE. A wound that keeps returning but never moves anything (high rpi, low cui) is PATHOLOGICAL rumination
  // — we DECOUPLE it (damp harder, stop re-applying the full hurt) so it fades instead of gnawing forever; the
  // caller routes it to regulation rather than the inner voice. Picking still never mints a new mark.
  function ruminate() {
    const open = openWounds();
    if (!open.length) return null;
    let m = open[0], best = -1;
    if (canxian) { for (const w of open) { const s = canxianScore(w); if (s > best) { best = s; m = w; } } }
    else best = m.salience;
    m.rpi = (m.rpi || 0) + 1;
    lastRuminated = m.seq;
    const cui = m.rpi > 0 ? (m.updates || 0) / m.rpi : 0;
    const pathological = canxian && m.rpi >= pathoRpi && cui < pathoCui;
    const mode = pathological ? "pathological" : (m.updates > 0 ? "productive" : "fresh");
    m.salience = +(m.salience * (pathological ? pathoDamp : pickHeal)).toFixed(3); // decouple a stuck loop harder
    return { seq: m.seq, note: m.note, valence: m.valence, salience: m.salience, at: m.at, canxian: +Math.max(0, best).toFixed(3), rpi: m.rpi, cui: +cui.toFixed(3), mode };
  }

  // The caller reports back after a rumination: did re-living the wound actually MOVE anything (a shift in the
  // self-narrative, a belief, a goal)? A yes raises its Canxian Update Index → productive; a run of nos → pathological.
  function noteUpdate(didUpdate = true) {
    if (lastRuminated == null || !didUpdate) return;
    const m = marks.find((x) => x.seq === lastRuminated);
    if (m) m.updates = (m.updates || 0) + 1;
  }

  // A warm/repair moment makes peace — but PROPORTIONALLY, not all at once. Each warm turn advances every open
  // wound's `repair` meter by an increment scaled by `warmth` and reduced by how deep/self-relevant and hard-to-close
  // the wound is (deep wounds resist a single kind word), and eases its salience by that same increment. A wound only
  // fully resolves once its meter crosses repairThreshold — deep/self-relevant hurt needs REPEATED warmth (or an
  // explicit acknowledgment) to close. Returns every wound it touched (so the caller can apply the serotonin relief
  // and warm the bond); each entry flags whether it fully resolved or only partially healed this turn.
  function reconcile({ warmth = 1 } = {}) {
    const w = openWounds();
    const touched = [];
    for (const m of w) {
      // resistance: a blend of how hard the wound is to close and how much it touches identity/the bond — both make
      // a single warm turn heal LESS. inc is bounded to [repairFloor, repairGain]: even a resistant wound inches
      // toward peace (never fully stuck), but a shallow one heals fast.
      const resistance = clamp(0.5 * (m.closureResistance ?? 0.6) + 0.5 * (m.selfRelevance ?? 0.5), 0, 1);
      const inc = Math.max(repairFloor, clamp01(warmth) * repairGain * (1 - repairResistK * resistance));
      m.repair = clamp01((m.repair || 0) + inc);
      m.salience = +(m.salience * (1 - 0.5 * inc)).toFixed(3); // ease its pull now, in proportion to the repair landed
      const resolved = m.repair >= repairThreshold;
      if (resolved) m.resolved = true;
      touched.push({ note: m.note, salience: m.salience, repair: +m.repair.toFixed(3), resolved });
    }
    return touched;
  }

  // Slow fade — charged moments last, faint ones let go. Call per turn/idle tick.
  function fade() {
    let dropped = false;
    for (const m of marks) { m.salience = +(m.salience * decay).toFixed(4); if (m.salience < 0.02) dropped = true; }
    if (dropped) marks = marks.filter((m) => m.salience >= 0.02);
  }

  return {
    record, ruminate, reconcile, fade, openWounds, joys, noteUpdate,
    weather: () => ({ wounds: openWounds().length, joys: joys().length, heaviest: openWounds()[0] || null }),
    snapshot: () => ({ marks: marks.map((m) => ({ ...m })), n }),
    restore: (s) => { if (s) { marks = Array.isArray(s.marks) ? s.marks.map((m) => ({ ...m })) : []; n = s.n ?? marks.reduce((mx, m) => Math.max(mx, m.seq), 0); } },
  };
}
