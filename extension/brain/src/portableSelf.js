// portableSelf.js — the PORTABLE self (the north-star: a self that TRAVELS between apps and bodies). A user's companion
// is more than one app's save file. Its IDENTITY (the earned self-narrative + persona/values), its RELATIONSHIP (the
// running model of the user + the felt bond), and its KNOWLEDGE (durable facts) should follow the user from a browser
// companion to a robot to a different app. This exports that layer as a versioned, app-agnostic bundle and grafts it
// onto ANY brain instance — even one with a different SUBSTRATE (seed / sizes / body).
//
// It deliberately leaves the BODY behind: the spiking genome, the raw episode buffer (instance-specific chatter), and
// the momentary chemistry are NOT portable — they are local to a deployment. Facts are re-embedded by the TARGET brain
// on import, so knowledge transfers even when the two brains use different embedders. The self rides; the body is local.

const VERSION = 1;
const CHANNELS = ["dopamine", "norepinephrine", "serotonin", "acetylcholine"];

// A versioned, app-agnostic bundle of the identity + relationship + knowledge layer.
export function exportSelf(app, { onFault } = {}) {
  const inn = app._internals();
  const temperament = {};
  for (const c of CHANNELS) { try { temperament[c] = +inn.organism.chemSetpoint(c).toFixed(3); } catch (e) { if (onFault) onFault("portableSelf.export:" + c, e); } }
  const persona = app.getPersona ? app.getPersona() : {};
  return {
    version: VERSION,
    persona: { description: persona.description || "", overrides: persona.overrides || {}, greeting: persona.greeting || null },
    profile: app.getProfile ? app.getProfile() : {},
    self: inn.self && inn.self.serialize ? inn.self.serialize() : null,          // earned autobiographical identity
    relationship: inn.theoryOfMind && inn.theoryOfMind.serialize ? inn.theoryOfMind.serialize() : null, // per-turn read of the user
    bond: inn.relationship && inn.relationship.snapshot ? inn.relationship.snapshot() : null, // the STANDING bond (warmth/trust/familiarity) — travels with the self
    psyche: inn.psyche && inn.psyche.snapshot ? inn.psyche.snapshot() : null, // the charged moments (wounds/joys) under the bond — the affective history travels too
    endocrine: inn.endocrine && inn.endocrine.snapshot ? inn.endocrine.snapshot() : null, // the slow hormones (chronic stress + bonding chemistry) travel with the self
    beliefs: inn.beliefs && inn.beliefs.snapshot ? inn.beliefs.snapshot() : null, // the model of the user (their opinions + regard) travels too
    growth: inn.growth && inn.growth.snapshot ? inn.growth.snapshot() : null,     // the change-log — so a migrated self doesn't re-announce old growth
    innerVoice: inn.innerVoice && inn.innerVoice.snapshot ? inn.innerVoice.snapshot() : null, // recency/cooldown — keeps the inner voice from repeating after a move
    express: inn.express && inn.express.snapshot ? inn.express.snapshot() : null, // the disclosure cooldown
    drives: inn.drives && inn.drives.serialize ? inn.drives.serialize() : null,  // felt-need state
    proactivity: inn.proactivity && inn.proactivity.snapshot ? inn.proactivity.snapshot() : null,
    temperament,                                                                 // persona chemistry (tonic set-points)
    creed: app.getCreed ? app.getCreed() : [],                                   // inviolable imperatives — travel with the self, add-only
    // durable KNOWLEDGE only — the semantic layer, NOT raw episodes (which are instance chatter). Re-embedded on import.
    facts: inn.store.list({ type: "fact" }).map((f) => ({ text: f.text, tags: (f.tags || []).filter(Boolean), pinned: !!f.pinned, source: f.source || "user" })),
  };
}

// Graft a self bundle onto `app` (which may be a DIFFERENT brain/body). Non-destructive to the substrate; merges the
// identity, relationship, temperament, and knowledge. Returns a summary of what transferred.
export async function importSelf(app, bundle, { onFault } = {}) {
  if (!bundle || bundle.version == null) throw new Error("portableSelf: not a self bundle");
  const inn = app._internals();
  if (bundle.persona && bundle.persona.description && app.setPersona) await app.setPersona(bundle.persona.description, bundle.persona.overrides || {}, bundle.persona.greeting || undefined);
  if (bundle.profile && Object.keys(bundle.profile).length && app.setProfile) await app.setProfile(bundle.profile);
  if (bundle.self && inn.self && inn.self.restore) inn.self.restore(bundle.self);
  if (bundle.relationship && inn.theoryOfMind && inn.theoryOfMind.restore) inn.theoryOfMind.restore(bundle.relationship);
  if (bundle.bond && inn.relationship && inn.relationship.restore) inn.relationship.restore(bundle.bond); // the standing bond travels
  if (bundle.psyche && inn.psyche && inn.psyche.restore) inn.psyche.restore(bundle.psyche); // the affective history travels
  if (bundle.endocrine && inn.endocrine && inn.endocrine.restore) inn.endocrine.restore(bundle.endocrine); // the slow hormones travel
  if (bundle.beliefs && inn.beliefs && inn.beliefs.restore) inn.beliefs.restore(bundle.beliefs); // the user model travels
  if (bundle.growth && inn.growth && inn.growth.restore) inn.growth.restore(bundle.growth);
  if (bundle.innerVoice && inn.innerVoice && inn.innerVoice.restore) inn.innerVoice.restore(bundle.innerVoice);
  if (bundle.express && inn.express && inn.express.restore) inn.express.restore(bundle.express);
  if (bundle.drives && inn.drives && inn.drives.restore) inn.drives.restore(bundle.drives);
  if (bundle.proactivity && inn.proactivity && inn.proactivity.restore) inn.proactivity.restore(bundle.proactivity);
  if (bundle.temperament) { try { inn.organism.setTraits({ setpoints: bundle.temperament }); } catch (e) { if (onFault) onFault("portableSelf.import.temperament", e); } }
  if (bundle.creed && bundle.creed.length && app.commit) await app.commit(bundle.creed); // UNION — grafting adds imperatives, never drops
  let facts = 0;
  for (const f of bundle.facts || []) { try { await inn.store.addFact(f.text, { tags: f.tags, pinned: f.pinned, source: f.source }); facts++; } catch (e) { if (onFault) onFault("portableSelf.import.fact", e); } } // re-embedded by THIS brain
  if (app.buildThemes) { try { await app.buildThemes(); } catch (e) { if (onFault) onFault("portableSelf.import.themes", e); } } // regenerate the theme layer on the target body
  return { facts, persona: !!(bundle.persona && bundle.persona.description), self: !!bundle.self, relationship: !!bundle.relationship, bond: !!bundle.bond, temperament: Object.keys(bundle.temperament || {}).length, creed: (bundle.creed || []).length };
}
