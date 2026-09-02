// roamers.js — ROAMers (Bobiverse: Remote Observation And Manipulation devices). One self, MANY bodies. Bob drives a
// fleet of remote units at once through their feeds, but a single mind can only truly ATTEND to one thing at a time —
// so the others run on autopilot until something on their feed is salient enough to seize the spotlight. That's
// exactly the brain's attention faculty (thalamus / global workspace): here it arbitrates across BODIES instead of
// across internal contents. Each cycle every roamer reports what it perceives and how badly it needs attention; the
// gate picks the FOCUS (NE-urgency lets a threatened body interrupt; ACh sharpens; attention HOLDS to avoid
// thrashing); the focused body is piloted by the full deliberative self, the rest keep running on cheap reflex.
//
// A roamer is any pluggable body/organ: { sense() -> {salience, percept, tags?}, act?(decision), autopilot?(percept) }.
// sense/act/autopilot may be sync or async. This is the robotSelf bridge generalized from one body to a fleet.
import { makeAttention } from "./attention.js";

const asNum = (x, d = 0) => (typeof x === "number" && isFinite(x) ? x : d);

export function makeRoamerHub(app = null, { attention = null, capacity = 8, pilot = null, onFault = null } = {}) {
  const roamers = new Map();
  const gate = attention || (app && app._internals && app._internals().attention) || makeAttention({ capacity });
  const defaultPilot = pilot || (app && app.quickAsk ? (percept) => app.quickAsk(percept) : () => null);

  // The self's baseline arousal/focus disposition feeds the gate (an anxious self's bodies interrupt more readily).
  function chemNow() {
    try { const o = app && app._internals && app._internals().organism; if (!o || !o.chemSetpoint) return null;
      return { acetylcholine: o.chemSetpoint("acetylcholine"), norepinephrine: o.chemSetpoint("norepinephrine") }; }
    catch (e) { if (onFault) onFault("roamers.chem", e); return null; } // degrades to default gate disposition; still worth diagnosing
  }
  async function safeSense(r) {
    try { const s = await r.sense(); return { salience: asNum(s && s.salience), percept: (s && s.percept) || "", tags: (s && s.tags) || [] }; }
    catch (e) { return { salience: 0, percept: "", tags: [] }; }
  }

  return {
    attach(id, roamer) { if (!id || !roamer || typeof roamer.sense !== "function") throw new Error("roamers: attach needs an id and a roamer with sense()"); roamers.set(id, roamer); return this; },
    detach(id) { return roamers.delete(id); },
    list: () => [...roamers.keys()],
    count: () => roamers.size,
    focus: () => gate.focus(),

    // Drive one fleet cycle: sense all bodies, gate for the focus, pilot the focused body with the full self, autopilot
    // the rest. Returns legible telemetry (who won the spotlight, the per-body weights, what was piloted vs autopiloted).
    async cycle({ pilot: pilotOverride } = {}) {
      const ids = [...roamers.keys()];
      if (!ids.length) return { focus: null, weights: {}, piloted: null, autopiloted: [] };
      const senses = [];
      for (const id of ids) senses.push({ id, s: await safeSense(roamers.get(id)) });

      const candidates = senses.map(({ id, s }) => ({ source: id, text: s.percept || `[${id}]`, salience: s.salience, tags: s.tags }));
      const gated = gate.gate(candidates, { chem: chemNow() });
      const focusId = gated.focus ? gated.focus.source : ids[0];

      const p = pilotOverride || defaultPilot;
      const focusSense = senses.find((x) => x.id === focusId).s;
      const decision = await p(focusSense.percept, focusId);
      const rf = roamers.get(focusId);
      let acted = null; if (rf.act) { try { acted = await rf.act(decision); } catch (e) { acted = null; } }

      const autopiloted = [];
      for (const { id, s } of senses) {
        if (id === focusId) continue;
        const r = roamers.get(id);
        let out = null; if (r.autopilot) { try { out = await r.autopilot(s.percept); } catch (e) { out = null; } }
        autopiloted.push({ id, out });
      }
      return { focus: focusId, weights: gated.weights, piloted: { id: focusId, decision, acted }, autopiloted };
    },
  };
}
