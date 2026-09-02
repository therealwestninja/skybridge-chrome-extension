// socraticCritic.js — the SOCRATIC REASONING-CRITIC (2606.26722, arxiv-mine-v5 Cluster B2). Our verifier checks the
// mouth's OUTPUT; this checks the REASONING upstream, before a belief is allowed to harden into a fact or an intent into
// an action. The paper's move: interrogate a hypothesis through a FIXED checklist so it becomes a testable, falsifiable
// structure instead of a fluent guess. We encode that as seven required slots — the "scientific state" of a claim:
//
//   claim         — the proposition itself
//   assumptions[] — what it rests on
//   competing[]   — the alternative hypotheses it must beat
//   predicted     — what it predicts / the expected observation
//   discriminator — the test that separates this claim from its competitors
//   uncertainty   — how confident, and what is still unknown
//   rejection     — the CHECKABLE condition under which the claim is FALSE
//
// The gate: a belief may not be promoted to a fact (nor an intent to an action) until every slot is non-empty AND the
// rejection condition is actually checkable (an observable clause or an executable predicate). An un-interrogated belief
// — one with no competitors, no discriminator, no way to be wrong — is exactly the "fluent guess" this refuses to
// promote. Deterministic, dependency-free. Plugs into the distiller (episode→fact), respoolSelf (open questions →
// falsifiable structures), and the council (intent→action).

export const SLOTS = ["claim", "assumptions", "competing", "predicted", "discriminator", "uncertainty", "rejection"];
const filled = (v) => (Array.isArray(v) ? v.some((x) => String(x ?? "").trim()) : typeof v === "function" ? true : String(v ?? "").trim().length > 0);

// A rejection condition is CHECKABLE if it is an executable predicate, or a clause naming an observable / comparator /
// quantity / conditional — i.e. something that could actually be measured against reality, not a vague "if I'm wrong".
const checkable = (rej) => {
  if (typeof rej === "function") return true;
  const t = String(rej || "").trim();
  if (t.length < 4) return false;
  return /(\bif\b|\bwhen\b|\bunless\b|\bexceeds?\b|\bbelow\b|\babove\b|\bmore than\b|\bless than\b|\bat least\b|[<>=]|\d|\bfails?\b|\bdiffers?\b|\bwould be (wrong|false|different)\b|\bobserv|\bmeasur|\bcount|\bno longer\b)/i.test(t);
};

export function makeSocraticCritic() {
  return {
    slots: () => [...SLOTS],

    // Interrogate a candidate reasoning-state. Returns { complete, missing, checkableRejection, promotable, reason }.
    interrogate(state = {}) {
      const missing = SLOTS.filter((s) => !filled(state[s]));
      const checkableRejection = filled(state.rejection) && checkable(state.rejection);
      const complete = missing.length === 0;
      const promotable = complete && checkableRejection;
      const reason = promotable ? "complete + falsifiable" : !complete ? "missing slots: " + missing.join(", ") : "rejection condition is not checkable";
      return { complete, missing, checkableRejection, promotable, reason };
    },

    // Deterministically SEED a partial structure from a raw belief string (detect stated reasons, alternatives, hedges).
    // It intentionally leaves competing/predicted/discriminator/rejection for the thinker to fill — so a bare, un-
    // interrogated belief scaffolds to a NON-promotable structure. That is the point: fluent ≠ falsified.
    scaffold(text = "") {
      const t = String(text || "");
      const assumptions = []; const because = t.match(/\b(?:because|since|as|given that)\b\s+(.+)/i); if (because) assumptions.push(because[1].trim());
      const competing = []; const alt = t.match(/\b(?:or maybe|or possibly|alternatively|unless|otherwise)\b\s+(.+)/i); if (alt) competing.push(alt[1].trim());
      const hedged = /\b(maybe|might|possibly|perhaps|i think|not sure|seems|probably|could be|guess)\b/i.test(t);
      return { claim: t.replace(/\b(maybe|i think|probably|perhaps|i guess)\b/gi, "").replace(/\s+/g, " ").trim(), assumptions, competing, predicted: "", discriminator: "", uncertainty: hedged ? "expressed tentatively — confidence not yet grounded" : "", rejection: "" };
    },

    // Actually TEST the claim: if its rejection is an executable predicate, run it against evidence. A fired rejection
    // means the claim is FALSIFIED (this is what makes the structure scientific rather than decorative).
    test(state = {}, evidence = {}) {
      const rej = state.rejection;
      if (typeof rej === "function") { let fired = false; try { fired = !!rej(evidence); } catch { fired = false; } return { falsified: fired, by: fired ? "rejection condition met by evidence" : null }; }
      return { falsified: false, by: null, note: "rejection is descriptive, not executable — cannot auto-test" };
    },
  };
}
