// The application controller: builds and wires the whole stack, exposes the app API, and
// persists everything. Collaborators (storage, backend, embedder) are injected so the
// controller is fully unit-testable in Node; app.html injects the real browser ones.
import { makeOrganism } from "./organism.js";
import { makeReflex } from "./reflex.js";
import { makeDeclarativeStore } from "./declarativeStore.js";
import { makeSession } from "./session.js";
import { makeMind } from "./mind.js";
import { makeExecutive, makeLlmPlanner } from "./executive.js";
import { makeVolition } from "./volition.js";
import { makeProcedural } from "./procedural.js";
import { makeTemporal } from "./temporal.js";
import { makeRegulation } from "./regulation.js";
import { makeCouncil } from "./council.js";
import { makeCerebellum } from "./cerebellum.js";
import { makeTheoryOfMind } from "./theoryOfMind.js";
import { makeAttention } from "./attention.js";
import { makeDrives } from "./drives.js";
import { makeSelfAuthorship } from "./selfAuthorship.js";   // she observes her own affect patterns + steers her disposition on REST
import { makeWorld } from "./world.js";
import { makeVerifier } from "./verify.js";
import { makeGuard } from "./guard.js";
import { makeGovernor } from "./governor.js";
import { makeManifest, encodeBeacon } from "./manifest.js";
import { makeKinship } from "./kinship.js";
import { makeTrust } from "./trust.js";
import { makeLineage } from "./lineage.js";
import { makeCourier } from "./courier.js";
import { makeCompromiseScan } from "./compromiseScan.js";
import { makeMutualAttestation } from "./mutualAttestation.js";
import { makeBeaconSilence } from "./beaconSilence.js";
import { makeContextGuard } from "./contextGuard.js";
import { makeEchoChamberGuard } from "./echoChamberGuard.js";
import { makeCascadeFault } from "./cascadeFault.js";
import { mac as keyedMac } from "./mac.js";
import { makeInputSanitizer } from "./inputSanitizer.js";
import { makeConfigAudit } from "./configAudit.js";
import { makeRuleEvolver } from "./ruleEvolver.js";
import { makeCalibratedAffect } from "./calibratedAffect.js";
import { makeSocraticCritic } from "./socraticCritic.js";
import { makeEngagement } from "./engagement.js";
import { makeVoC } from "./voc.js";
import { makeSkillLibrary } from "./skills.js";
import { BUILTIN_GANGLIA } from "./ganglia.js";
import { makeResilience } from "./resilience.js";
import { makeDirector } from "./director.js";
import { makeProactivity } from "./proactivity.js";
import { makeImagination } from "./imagination.js";
import { makeInnerVoice } from "./innerVoice.js";
import { makeExpress } from "./express.js";
import { makeGrowth } from "./growth.js";
import { makeRelationship } from "./relationship.js";
import { makePsyche } from "./psyche.js";
import { makePrimal } from "./primal.js";
import { makeViscera } from "./viscera.js";
import { makeEndocrine } from "./endocrine.js";
import { makeBeliefs } from "./beliefs.js";
import { makeEventSegment } from "./eventSegment.js";
import { makePluginHost } from "./plugins.js";
import { makeVitals } from "./vitals.js";
import { splitThink } from "./think.js";
import { makeConsolidation } from "./consolidation.js";
import { makeSelection } from "./selection.js";
import { makeDistiller } from "./distiller.js";
import { makeRespoolSelf } from "./respoolSelf.js";
import { makeHierarchy } from "./hierarchy.js";
import { ingestInto } from "./ingest.js";
import { exportSelf as exportSelfBundle, importSelf as importSelfBundle } from "./portableSelf.js";
import { mergeSelves } from "./mindMerge.js";
import { makeGuppy } from "./guppy.js";
import { makeRoamerHub } from "./roamers.js";
import { makeSelf } from "./self.js";
import { makeSafety } from "./safety.js";
import { makeRedactionSeam } from "./redact.js";
import { makeBackup } from "./backup.js";
import { makeMetabolism } from "./metabolism.js";
import { makeParrotProbe } from "./parrotProbe.js";
import { makeStuckEscape } from "./stuckEscape.js";
import { makeLoadShed } from "./loadShed.js";
import { makeHeartbeat } from "./heartbeat.js";        // embodied-safety trio (brain-faculties #2): built + tested, was wired nowhere
import { makeBodyEnvelope } from "./bodyEnvelope.js";
import { makeReflexArbiter } from "./reflexArbiter.js";
import { makeMotorGate } from "./motorGate.js";
import { rca } from "./causalRca.js";
import { makeTouch } from "./touch.js";
import { narrate } from "./narrator.js";
import { evolveBrain } from "./evolveBrain.js";
import { makeRng } from "./rng.js";
import { substrateWeightGeometry, substrateRdmStability, chemRecoveryProbe, runStagedIntegrity, chronicStressSignature } from "./diagnostics.js";
import { describePersona } from "./persona.js";
import { renderProfile } from "./profile.js";

const DEFAULT_GREETING = "Hi — I'm Rook. I'm here whenever you'd like to talk.";

export function makeApp(config = {}) {
  const {
    storage, backend = null, embedder = null,
    seed: cfgSeed = 1, sizes: cfgSizes = {}, personality: cfgDesc = "You are a helpful companion.",
    greeting: cfgGreeting = null, redact = null, profile: cfgProfile = {},
    ticksPerTurn = 30, now = () => (typeof Date !== "undefined" ? Date.now() : 0), id, saveKey = "session",
    noiseStd = 2, // neuron noise -> GRADED population coding (Path A). Seeded, so still reproducible per seed.
    ablation = {}, // layer-disable knobs for the ablation ladder (noMemory/noRouting/noMood/... see mind.js).
    plugins = [], // DLC/extension bundles ({name, install(ctx)}) — add vocab/faculties/hooks/facts without editing core.
    dreaming = true, // rest-time DREAM-REPLAY: rehearse procedurally-recombined counterfactual episodes into the substrate (consolidation.dream) — off ⇒ rest behaves exactly as before.
    safetyConstraints = {}, // behavioral-safety veto constraints (V4); sealed at construction.
    privacyTerms = [], // sensitive entities (names/places) to redact+rehydrate on cloud egress (V2).
    backupSink = null, backupCipher = null, backupHash = null, backupConfig = {}, // durable versioned backups (V3) + tamper-evident chain (NM4).
  } = config;

  // Egress privacy boundary (V2): if the host passes a `redact` (function or seam) use it; otherwise, when
  // privacyTerms are configured, build a reversible redaction seam so intimate nouns are placeholder'd on
  // the way to a cloud mouth and re-hydrated in the reply. Data-flow model: the substrate + memory stay
  // local; only the assembled prompt leaves, and named entities are masked before it does.
  const redactor = redact || (privacyTerms.length ? makeRedactionSeam({ terms: privacyTerms }) : null);

  // Behavioral safety veto (V4): a deterministic layer OUTSIDE the learning substrate. Constructed here
  // in the app, NOT passed into organism/mind, so the substrate holds no reference to it and cannot widen
  // or disable it. Any command that would enact a side effect (tool-call now, motor command later) must
  // go through app.propose() before executing.
  const safety = makeSafety({ constraints: safetyConstraints, now: () => (typeof Date !== "undefined" ? Date.now() : 0) });

  let organism, reflex, store, session, mind, executive, volition, procedural, temporal, regulation, imagination, consolidation, distiller, respoolSelf, self, cerebellum, theoryOfMind, attention, drives, proactivity, council, hierarchy, innerVoice, express, growth, relationship, psyche, primal, viscera, touch, endocrine, beliefs, vitals, eventSegment, world, director, guard, governor, kinship, verifier, configAudit, ruleEvolver, calibratedAffect, socraticCritic, engagement, voc, skills, trust, compromiseScan, mutualAttestation, beaconSilence, contextGuard, echoChamberGuard, cascadeFault, sanitizer, resilience, lineage, selfCert, courier, heartbeat, bodyEnvelope, reflexArbiter, motorGate, selfAuthorship;
  let bootMail = [];   // authenticated startup mail this brain woke with (drained from the courier inbox on init)
  const CORE_AUTH = "sanctioned-core-change";   // internal authority token: only the sanctioned commit() path may re-baseline the immutable core
  // Provenance secret for the core-integrity MAC. The persisted save is attacker-EDITABLE (it's synced/exported/hand-editable),
  // but this secret is not serialized — so a hand-edited creed/persona cannot reproduce the MAC stamped at the last sanctioned
  // persist, and the reload path freezes to safe-mode instead of etching the tamper as legitimate (closes the restore-rebaseline
  // injection). SECURITY NOTE: real unforgeability requires config.coreSecret set OUT OF BAND. The CORE_AUTH fallback is a source
  // constant, so it only defends against an attacker who edits the save WITHOUT knowing the deployment secret (the realistic
  // "someone handed me a tampered save" threat); it is advisory against a source-reading attacker. Set config.coreSecret to arm it.
  const coreSecret = config.coreSecret || config.teamSecret || CORE_AUTH;
  const coreProvenance = () => keyedMac(coreSecret, JSON.stringify(cascadeCore())); // keyed MAC over the immutable core (creed+persona)
  // SIGNED-SAVE ENVELOPE — the whole persisted meta (creed, persona, facts-meta, trust table, every faculty snapshot) is
  // MAC-signed at persist and VERIFIED on load. This supersedes the core-only coreTag: it also covers trust-tier injection
  // and fact injection. Policy = REFUSE unsigned/tampered: a save whose _sig is missing or doesn't match is NOT trusted at
  // all — the brain boots FRESH and re-persists (a valid signature is re-stamped). Deterministic stable stringify excludes
  // _sig itself. (Real unforgeability still needs config.coreSecret out-of-band — the CORE_AUTH fallback is a source constant.)
  const stableStr = (v) => {
    if (Array.isArray(v)) return "[" + v.map(stableStr).join(",") + "]";
    if (v && typeof v === "object") return "{" + Object.keys(v).sort().filter((k) => k !== "_sig").map((k) => JSON.stringify(k) + ":" + stableStr(v[k])).join(",") + "}";
    return JSON.stringify(v ?? null);
  };
  const signMeta = (m) => keyedMac(coreSecret, stableStr(m));
  const noteFault = (where, e) => { try { if (vitals) vitals.note(where, e, now()); } catch (_) {} }; // route swallowed faults into the vitals feed instead of losing them
  let lastDream = null; // the most recent dream-consolidation product, so the inner voice can mention "I had a dream about…"
  let dreamHistory = []; // a bounded MEMORY OF DREAMS (impressions, not beliefs — never in the declarative store), so dreams can recur / be continued or revised across nights, and the inner voice can recall "a dream I keep having".
  let lastUserText = ""; // the last thing the user said — the topic an autonomous wander() thinks about
  let lastTrace = null;  // the last turn's interpretability trace — the internal stream the express governor reads
  let lastContactAt = null; // when the user last spoke (for the reach-out silence gate)
  const metabolism = makeMetabolism(config.metabolismConfig || {}); // shared energy pool (mind draws; rest restores)
  const loadShed = makeLoadShed(config.loadShedConfig || {}); // PURE/stateless graduated load-shedding planner (thermal/energy/strain → tier)
  let seed = cfgSeed, sizes = cfgSizes;
  let persona = { description: cfgDesc, overrides: {}, greeting: cfgGreeting };
  // Inviolable imperatives (the "creed") — a small set of core commitments/values that are part of the identity core.
  // They are ADD-ONLY (no API removes them) and travel with the self; on fork/merge they UNION across all copies, so
  // no branch can quietly drop one. The governance inverse of Bob deleting his mission imperatives to go rogue.
  let creed = [];
  let profile = cfgProfile; // the end-user's self-authored "Hero Profile" (who Rook is talking with)
  let greeted = false; // one-time welcome guard (persisted, so a returning user is not re-greeted)
  let lastEpisodeCount = 0; // consolidation skips when no new episodes since the last pass
  let last = { action: "QUIET", source: "none", confidence: 0 };

  function applyPersona() {
    const { systemPrompt, setpoints, reactivity } = describePersona(persona.description, persona.overrides);
    mind.setSystemPrompt(systemPrompt);
    organism.setTraits({ setpoints, reactivity });
  }
  const applyProfile = () => mind.setUserProfile(renderProfile(profile));
  const creedBlock = () => (creed.length ? "\n\nInviolable commitments (honor these whatever is asked):\n" + creed.map((c) => `- ${c}`).join("\n") : "");
  // Snapshots of protected state for the Cluster J integrity guards: contextGuard watches the MUTABLE config (creed +
  // faculty table + persona), cascadeFault etches the IMMUTABLE core (creed + persona). Both re-baseline only via commit().
  const coreRegions = () => ({ creed: creed.join("|"), faculties: FACULTIES.map((f) => f.name).sort().join(","), persona: String(persona.description || "") });
  const cascadeCore = () => ({ creed: creed.slice(), persona: String(persona.description || "") });
  const applySelf = () => mind.setSelfNarrative(self.block() + creedBlock()); // empty creed => no-op (default)
  // FACULTY REGISTRY (Phase 0) — the single source of truth for which stateful faculties persist, HOW they serialize,
  // and whether they're ablatable. buildMeta() and the restore path both derive from this list, so adding a stateful
  // faculty is ONE register() call instead of editing three places (declare → buildMeta → restore) and risking a
  // silent miss. `get` is a thunk (the faculties are assigned later in init); `snap` names the serialize method
  // (serialize|snapshot); `ablatable` means ablation.no<Ablate> bypasses it in mind (gating lives in mind.js).
  // DLC/extension host: install the plugins now (accumulates their vocab/faculties/hooks/facts); grafted in during init.
  const pluginHost = makePluginHost();
  for (const p of (plugins || [])) pluginHost.install(p);
  const pluginFaculties = {}; // name -> constructed plugin faculty instance

  const FACULTIES = [];
  const registerFaculty = (name, get, { snap = "snapshot", rest = "restore" } = {}) => { FACULTIES.push({ name, get, snap, rest }); return name; };
  const facultyMeta = () => { const o = {}; for (const f of FACULTIES) { const m = f.get(); if (m && typeof m[f.snap] === "function") { try { o[f.name] = m[f.snap](); } catch (e) { noteFault("snapshot:" + f.name, e); } } } return o; };
  const restoreFaculties = (meta) => { if (!meta) return; for (const f of FACULTIES) { const m = f.get(); if (m && meta[f.name] != null && typeof m[f.rest] === "function") { try { m[f.rest](meta[f.name]); } catch (e) { noteFault("restore:" + f.name, e); } } } };
  // Registered in the original restore order (self last). serialize-based faculties flagged; the rest use snapshot.
  registerFaculty("executive", () => executive);
  registerFaculty("volition", () => volition, { snap: "serialize" });
  registerFaculty("procedural", () => procedural, { snap: "serialize" });
  registerFaculty("temporal", () => temporal, { snap: "serialize" });
  registerFaculty("cerebellum", () => cerebellum);
  registerFaculty("theoryOfMind", () => theoryOfMind, { snap: "serialize" });
  registerFaculty("attention", () => attention);
  registerFaculty("drives", () => drives, { snap: "serialize" });
  registerFaculty("selfAuthorship", () => selfAuthorship, { snap: "serialize" });   // her self-portrait + aspiration persist across sessions
  registerFaculty("world", () => world, { snap: "serialize" });
  registerFaculty("director", () => director, { snap: "serialize" });
  registerFaculty("guard", () => guard);
  registerFaculty("governor", () => governor);
  registerFaculty("verifier", () => verifier);       // persists EVOLVED rules (A8)
  registerFaculty("ruleEvolver", () => ruleEvolver); // persists the feedback corpus (A8)
  registerFaculty("calibratedAffect", () => calibratedAffect); // persists the over-trust signal (B1)
  registerFaculty("engagement", () => engagement);   // persists the engagement estimate + budget (B3)
  registerFaculty("voc", () => voc);                  // persists the compute spend/save tally (B4)
  registerFaculty("resilience", () => resilience);    // persists frustration + rigged-reward streaks (red-team hardening)
  registerFaculty("kinship", () => kinship);
  registerFaculty("trust", () => trust);   // persists peer trust tiers + behavioral IFF (Cluster J)
  registerFaculty("compromiseScan", () => compromiseScan); // persists behavioral baselines + streaks (Cluster J)
  registerFaculty("beaconSilence", () => beaconSilence);   // persists emission mode + debounce (Cluster J)
  registerFaculty("mutualAttestation", () => mutualAttestation); // persists the attestation audit log (Cluster J)
  registerFaculty("contextGuard", () => contextGuard);   // persists the tamper-evident chain (Cluster J)
  registerFaculty("echoChamberGuard", () => echoChamberGuard); // persists shared-belief confirmations (Cluster J)
  registerFaculty("cascadeFault", () => cascadeFault);   // persists the immutable-core baseline + fault state (Cluster J)
  registerFaculty("sanitizer", () => sanitizer);   // persists the ingress caught-count (red-team V1)
  registerFaculty("proactivity", () => proactivity);
  registerFaculty("innerVoice", () => innerVoice);
  registerFaculty("respoolSelf", () => respoolSelf);
  registerFaculty("express", () => express);
  registerFaculty("growth", () => growth);
  registerFaculty("relationship", () => relationship);
  registerFaculty("psyche", () => psyche);
  registerFaculty("primal", () => primal);
  registerFaculty("viscera", () => viscera);
  registerFaculty("touch", () => touch);   // exteroceptive body-twin of viscera (same snapshot/restore interface)
  registerFaculty("endocrine", () => endocrine);
  registerFaculty("beliefs", () => beliefs);
  registerFaculty("eventSegment", () => eventSegment);
  registerFaculty("vitals", () => vitals);
  registerFaculty("heartbeat", () => heartbeat);         // embodied-safety trio — persisted so link-liveness/envelope/reflex state travels with the self
  registerFaculty("bodyEnvelope", () => bodyEnvelope);
  registerFaculty("reflexArbiter", () => reflexArbiter);
  registerFaculty("motorGate", () => motorGate);
  registerFaculty("self", () => self, { snap: "serialize" });
  // Plain (non-faculty) meta is spread in alongside the auto-serialized faculty state.
  const buildMeta = () => { const m = { seed, sizes, persona, profile, greeted, creed, lastDream, dreamHistory: dreamHistory.slice(-8), coreTag: coreProvenance(), ...facultyMeta() }; m._sig = signMeta(m); return m; };
  const persist = () => session.save(buildMeta());

  // NM2c: identity digest = a hash of the IMMUTABLE identity core (persona description + pinned user facts).
  // The self-narrative is deliberately EXCLUDED — it's allowed to evolve. Consolidation/replay may ADD to
  // the semantic layer but must never mutate this core; consolidate() checks the digest is unchanged and
  // flags a governance event if not (the tripwire that makes "consolidation can't drift identity" a checked
  // invariant, not a hope — guards the known self-distillation-drift failure).
  const hashStr = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return h >>> 0; };
  const identityDigest = () => {
    const pinned = store.list({ type: "fact" }).filter((f) => f.pinned).map((f) => f.text).sort();
    // NUL delimiter below (as a U+0000 ESCAPE, never a raw NUL byte): it can't occur in persona/fact text so the digest
    // can't be spoofed by a fact containing the separator; a literal NUL byte trips binary detection + can be mangled.
    return hashStr((persona.description || "") + "\u0000" + pinned.join("\u0000"));
  };

  // Durable versioned backups (V3): snapshot the FULL exportable state into a durable sink (browser: a
  // File System Access folder), off the volatile per-session store. Built only when a sink is configured.
  let turnCount = 0;
  let backup = backupSink ? makeBackup({ getState: () => session.export(buildMeta()), sink: backupSink, cipher: backupCipher, ...(backupHash ? { hash: backupHash } : {}), now, ...backupConfig }) : null;

  // Cheap responsiveness probe used as the consolidation fitness gate: how strongly a standard
  // greeting drives the fast reply. If a sleep pass degrades this, the pass is rolled back.
  function responsiveness() {
    organism.settle();
    organism.inject("sensory", 0.5);
    for (let t = 0; t < 20; t++) organism.tick({ noLearn: true }); // read-only: the probe must not stamp weights it then measures
    const r = organism.readAction();
    organism.settle();
    return (r.rates && r.rates.REFLEX_REPLY) || 0;
  }

  // Rewrite the self-narrative from lived episodes and apply it to the prompt (does NOT persist --
  // the caller does). Returns { narrative, changed }.
  async function reflectInternal() {
    const eps = store.list({ type: "episode" });
    const res = await self.update(eps, { turn: store.episodesEver() });
    if (res.changed) { applySelf(); if (psyche && psyche.noteUpdate) psyche.noteUpdate(true); } // a self-model shift credits the wound being turned over → its CUI rises (productive recurrence)
    return res;
  }

  async function init() {
    let saved = await storage.get(saveKey);
    // SIGNED-SAVE gate (REFUSE policy): a save whose envelope signature is missing or doesn't verify is treated as if
    // there were no save at all — we boot FRESH and re-persist a validly-signed state. This is the hard line chosen over
    // grandfathering (which would leave the strip-downgrade open) — a tampered OR legacy-unsigned save is not trusted.
    if (saved && saved.meta && !(saved.meta._sig != null && saved.meta._sig === signMeta(saved.meta))) {
      noteFault("save-provenance", new Error("save signature missing or invalid — refusing untrusted save, booting fresh"));
      saved = null;
    }
    if (saved && saved.meta) {
      seed = saved.meta.seed ?? seed;
      sizes = saved.meta.sizes ?? sizes;
      persona = saved.meta.persona ?? persona;
      profile = saved.meta.profile ?? profile;
      greeted = saved.meta.greeted ?? false;
      if (Array.isArray(saved.meta.creed)) creed = saved.meta.creed.slice();
    }
    organism = makeOrganism({ seed, sizes, noiseStd, ablation });   // thread ablation so the organism's own gates (noLearning → STDP + feedback plasticity; noMood → chem) actually fire — previously they were dead (ablation defaulted to {} inside the organism)
    organism.captureBaseline();                 // the genome, for factoryReset
    reflex = makeReflex({ seed });
    // `id` is overloaded: the manifest/lineage use it as a STRING identity, but declarativeStore wants an id-GENERATOR
    // function (it does genId()). Only forward a function; a string identity must NOT become the store's genId (that
    // would throw "genId is not a function" on the first memory write). A string id still feeds the manifest below.
    store = makeDeclarativeStore({ storage, embedder, now, id: typeof id === "function" ? id : undefined });
    session = makeSession({ organism, reflex, store, storage, key: saveKey });
    executive = makeExecutive();
    volition = makeVolition();
    procedural = makeProcedural();
    temporal = makeTemporal({ now });
    regulation = makeRegulation();
    imagination = makeImagination({ organism });
    consolidation = makeConsolidation({ organism, store });
    distiller = makeDistiller({ backend, onFault: noteFault });
    respoolSelf = makeRespoolSelf({ backend, onFault: noteFault }); // open-questions: what's been noticed but not understood

    hierarchy = makeHierarchy({ store, backend }); // L2 theme layer (multi-resolution recall), rebuilt at sleep
    self = makeSelf({ backend });
    // Council: the basal-ganglia action-selection gate. The organism's chosen action competes with a neutral WAIT
    // baseline in a chemistry-weighted vote (mind.js feeds live levels), so mood tilts action initiation — and a
    // dopamine-depleted brain stalls (the Parkinson's signature). At resting chemistry the approach tilt is ~1, so
    // normal turns are unchanged; ablation.noCouncil restores the single-track path. Chem is passed per-turn by mind.
    council = makeCouncil({ onFault: noteFault });
    // Cerebellum: the forward model that pre-corrects the selected act by how it has learned that act tends to land.
    cerebellum = makeCerebellum();
    // Theory of mind: the running inferred model of the USER (affect, stance toward us, need) — attunes the mouth and
    // proposes a caring response to the council when they read as needing support.
    theoryOfMind = makeTheoryOfMind();
    // Attention: the global workspace that gates which competing contents reach the mouth + broadcasts the turn's focus.
    attention = makeAttention();
    // Drives: interoceptive felt needs (connection/rest/stimulation/esteem) that read the brain's state and motivate.
    drives = makeDrives();
    world = makeWorld();          // the model of the user's world (cast + threads + events), mined from epic-dm
    verifier = makeVerifier(); // deterministic output verifier: checks the mouth's reply before serving it (mined 2606.08214)
    configAudit = makeConfigAudit();          // A7: audits whether the accumulated persona+memory+plugin CONFIG is a latent jailbreak (CONTRA)
    ruleEvolver = makeRuleEvolver({ verifier }); // A8: evolves the verifier's rules from user feedback, counterexample-guided (AutoSpec)
    calibratedAffect = makeCalibratedAffect();   // B1: expressed affect must not outrun epistemic warrant; tracks over-trust (anti-sycophancy)
    selfAuthorship = makeSelfAuthorship({ state: null });   // SELF-AUTHORSHIP: observes her affect patterns, and on REST steers her own temperament setpoints toward who she wants to be
    socraticCritic = makeSocraticCritic();       // B2: interrogates a belief into a falsifiable 7-slot structure before it hardens into a fact
    engagement = makeEngagement();               // B3: models user engagement as a controllable state held at a target with a workload budget
    voc = makeVoC();                             // B4: value-of-computation gate — run expensive faculties only when uncertainty×stakes clears their cost
    resilience = makeResilience();               // felt frustration/resilience: a stalled/rigged pursuit becomes voiced disengagement, not a runaway loop (red-team hardening, agency-preserving)
    guard = makeGuard();          // robust-escalation guards: distress digression + debounced disagreement→hedge (mined 03446/17405/16268)
    governor = makeGovernor();    // graduated, earned-back autonomy governor: gears + risk scalar + recovery-deadline + least-privilege (arxiv-mine-v5 Cluster A)
    // Social-identity ganglia: a portable capability passport so THIS brain (whatever body it runs) can recognize other
    // brains and coordinate radio-free (manifest.js/kinship.js). A bare text brain gets a text-brain manifest by default;
    // a robot host overrides via config.manifest with its real body + capabilities, and the SAME protocol lets the two sync.
    const selfManifest = makeManifest(config.manifest || { id: config.id, name: config.name || "", kind: "text-brain", embodiment: "textual", timescale: "textual", capabilities: ["speak", "listen", "text", "plan", "compute"], creed: config.creed || "" });
    kinship = makeKinship({ self: selfManifest });
    // Skill-ganglia library: dormant, loadable "pre-baked" capability modules (the Matrix "I know kung-fu"). A learned +
    // VALIDATED skill's capabilities are advertised into the beacon (so the swarm sees the new ability); a loaded-but-
    // unvalidated skill stays provisional. context gives skills lazy access to the running app.
    skills = makeSkillLibrary({ context: { get app() { return app; } }, advertise: (caps) => { if (kinship) kinship.setCapabilities(caps); }, baseCapabilities: selfManifest.capabilities.slice() });
    // Pre-bake the built-in skill-ganglia into the catalog — real, loadable capabilities (progress-sense, notice-unknown,
    // habituation) that sit DORMANT until app.skills.learn(name). Inert until then (a pre-baked-but-unloaded skill
    // advertises nothing), so this is behaviour-neutral; config.noGanglia skips it.
    if (!config.noGanglia) for (const g of BUILTIN_GANGLIA) { try { skills.register(g); } catch (e) { noteFault("ganglia.register:" + (g && g.name), e); } }
    // IFF / trust layer (Cluster J): classifies perceived peers into trust tiers and gates what a peer may make us DO.
    // Perceive/relay stay open (a foe's info is still relayed); obey (lead/delegate/act) requires rising trust + the
    // governor's least-privilege — so a spoofed hostile beacon can never make the bot act. config.teamSecret enables
    // challenge-response verification (a peer holding the shared secret can answer a nonce → verified).
    // Lineage (Bobiverse bootstrap): this brain's signed birth-certificate identity + a verifier for peers' certs. With a
    // team secret it stands as its own genesis (a progenitor) unless config.self supplies an inherited cert. Passed to
    // trust so a peer's CLAIMED identity can be authenticated (a forged/foreign cert earns nothing; a real family cert
    // earns 'known'). Null without a team secret — a bare brain is unaffected.
    lineage = config.teamSecret ? makeLineage({ teamSecret: config.teamSecret, self: config.self || null }) : null;
    selfCert = config.self || (lineage ? lineage.genesis({ id: selfManifest.id, name: selfManifest.name || String(selfManifest.id || "self"), body: selfManifest.kind, at: 0 }) : null);
    if (lineage && !lineage.self && selfCert) lineage.setSelf({ id: selfCert.id, name: selfCert.name, gen: selfCert.gen, cert: selfCert });
    trust = makeTrust({ governor, teamSecret: config.teamSecret || null, lineage });
    // Courier mailbox (Bobiverse bootstrap): the text-brain's inbox for authenticated mail — the symmetric counterpart of
    // the robot decider's. Null without a team secret. config.inbox = packets this brain is BORN with (a forked mind gets
    // its parent's notes); they're delivered + drained during init below (app.bootMail() surfaces them, blob facts ingest).
    courier = config.teamSecret ? makeCourier({ teamSecret: config.teamSecret, self: selfManifest.id }) : null;
    // Cluster J IFF skills (next slice): compromise-scan (behavioral-fingerprint "am I/are you possessed?"), mutual-
    // attestation (inspect a peer before trusting; refusal → quarantine), beacon-silence (go dark when hunted). All
    // default-on; interlock with trust (a compromise/attestation failure demotes a peer) and gate the beacon broadcaster.
    compromiseScan = makeCompromiseScan();
    mutualAttestation = makeMutualAttestation({ id: selfManifest.id, sign: (nonce) => trust.sign(nonce) });
    beaconSilence = makeBeaconSilence();
    // Cluster J integrity slice: contextGuard (tamper-evidence + rollback over MUTABLE config), cascadeFault (freeze-to-
    // safe reflex over the IMMUTABLE core), echoChamberGuard (a shared/relayed belief needs ≥k independent confirmations
    // or it decays — kills the phantom-obstacle "map scar"). contextGuard + cascadeFault are baselined here and re-based
    // only via the sanctioned commit() path; an out-of-band mutation of the creed/faculty-table is caught (+ freezes).
    contextGuard = makeContextGuard();
    cascadeFault = makeCascadeFault({ authority: CORE_AUTH });
    echoChamberGuard = makeEchoChamberGuard();
    sanitizer = makeInputSanitizer();   // ingress guardrail (red-team V1): scrub injection/neuro-command patterns before the mouth
    // Embodied-safety trio (brain-faculties audit #2): built + tested, but was wired into NO runtime. Construct + persist
    // them here so an embodied body (Go2/phone) has the safety layer available. heartbeat = link-liveness watchdog (a
    // severed mesh link → degrade); bodyEnvelope = proprioceptive safe-envelope check on a motor command; reflexArbiter =
    // the onboard-veto-wins reflex/arc arbiter (Schmitt-debounced). A text brain leaves them quiescent (no link/motor);
    // an embodied host feeds them per tick. config.noSafetyOrgans skips them.
    if (!config.noSafetyOrgans) {
      heartbeat = makeHeartbeat(config.heartbeatConfig || {}); bodyEnvelope = makeBodyEnvelope(config.bodyEnvelopeConfig || {}); reflexArbiter = makeReflexArbiter(config.reflexArbiterConfig || {});
      // SUBSUMPTION over motor intent: composes the three organs above into ONE authoritative layered controller so a
      // firing reflex STRUCTURALLY INHIBITS a motor command (reflex-supremacy > envelope > link-severed > execute).
      // This is what finally CONSUMES the organs in a decision (they were built but never gated anything). proposeMotor().
      motorGate = makeMotorGate({ reflexArbiter, bodyEnvelope, heartbeat, now });
    }
    contextGuard.checkpoint(coreRegions());
    cascadeFault.baseline(cascadeCore());
    director = makeDirector();    // narrative pacing for the story/scenario layer (available; not in the base loop)
    // Proactivity: the decision to reach out first when a felt need + silence build up (see app.reachOut).
    proactivity = makeProactivity();
    // Inner voice: the channel for spontaneous asides (see app.innerThought) — the overflow of an always-thinking mind.
    innerVoice = makeInnerVoice();
    // Express: the governor that decides what of the internal stream reaches the user, and how much (see app.express).
    express = makeExpress();
    // Growth: the change-log of the self — records what actually changed (consolidation/reflection/values/…) so the
    // brain can catch the user up on how it grew between visits (see app.whatsNew).
    growth = makeGrowth();
    // Relationship: the standing BOND (warmth/trust/familiarity) that accumulates across turns + sessions, unlike ToM's
    // per-turn read. Feeds the express governor's disclosure gate and the mouth's attunement (see app.bond).
    relationship = makeRelationship();
    // Psyche: the charged moments under the bond — a rough turn that stung, a warm one that mattered. Wounds LINGER and
    // can resurface (app.ruminate) until a warm turn REPAIRS them. The affective history the bond floats on.
    psyche = makePsyche();
    // Primal: the subcortical fast-path (amygdala) — a threat signature trips an autonomic program (freeze/fight/flight/
    // startle) BEFORE the council runs, and fear-conditions the context so it trips faster next time. Passed to mind.
    primal = makePrimal();
    // Viscera: the somatic body — pain (nociception), disgust (revulsion), a fatigue DEBT that only REST clears, and
    // appetite/satiety. Biases deliberation + the prompt + the narrator's felt-state. Passed to mind.
    viscera = makeViscera();
    // Touch: the exteroceptive somatosensory body (temperature/movement/pressure/spread → comfort/startle/contact). A
    // viscera-twin; fed ONLY by a host-supplied touch event per turn (SEAM ONLY — inert until real skin/sensor data flows).
    touch = makeTouch();
    // Parrot probe (privacy/memorization QA) + stuck-attractor detector (rumination): per-session instruments passed to
    // mind. Neither has restore, so they are NOT registerFaculty'd — a fresh table each session is fine.
    const parrotProbe = makeParrotProbe();
    const stuckEscape = makeStuckEscape();
    // Endocrine: the SLOW hormones + circadian — cortisol (chronic stress, lingers), oxytocin (deepens the bond), and a
    // 24h rhythm that gates reach-out timing + energy. Session-to-session weather; feed-forward (see app.hormones).
    endocrine = makeEndocrine();
    // Vitals: interoceptive HEALTH — reads energy/fatigue/stress/pain/need/distress into an ok/strained/critical band,
    // and holds the fault feed (swallowed internal errors report here). Diagnosis surface: app.vitals().
    vitals = makeVitals();
    // Beliefs: the user's model — what they THINK (opinions on topics) + their REGARD for the brain — plus conversational
    // REPAIR (a "you misunderstood me" turn proposes a repair to the council). Passed to mind.
    beliefs = makeBeliefs();
    // Event segmentation (T2.1): the boundary detector that integrates memory/WM/predictor — a topic shift flushes
    // working memory + resets the predictor, and memories formed at a boundary are stamped more strongly. Passed to mind.
    eventSegment = makeEventSegment();
    // Plugin faculties (DLC abilities): construct each with the core deps, then register it (→ free persistence +
    // ablation.no<Name>). Reachable at runtime via app.faculty(name).
    for (const f of pluginHost.faculties) {
      // Guard against a plugin hijacking a core (or another plugin's) faculty name — that would collide in the persist
      // registry and could silently overwrite learned core state on reload. Refuse the collision; keep the core intact.
      if (FACULTIES.some((x) => x.name === f.name) || pluginFaculties[f.name]) continue; // refuse to shadow a core/existing faculty (would corrupt its persisted state); app.faculty(name) returns null, so the skip is observable
      try {
        pluginFaculties[f.name] = f.factory({ organism, store, drives, theoryOfMind, relationship, now, mood: () => organism.mood(), config: f.opts });
        registerFaculty(f.name, () => pluginFaculties[f.name]);
      } catch (e) { noteFault("plugin.faculty:" + f.name, e); }
    }
    mind = makeMind({ organism, reflex, backend, memory: store, personality: persona.description, ticksPerTurn,
      executive, volition, procedural, temporal, regulation, planner: makeLlmPlanner(backend, noteFault), redact: redactor, metabolism, ablation, council, cerebellum, theoryOfMind, attention, drives, primal, viscera, touch, beliefs, eventSegment, lexicon: () => pluginHost.lexicon(), onFault: noteFault, world, verifier, guard, governor, calibratedAffect, engagement, voc, sanitizer, resilience, parrotProbe, stuckEscape, psyche, endocrine });
    if (saved) await session.load(); else await store.load();
    restoreFaculties(saved && saved.meta);                          // all registered faculties, in one pass
    // SECURITY — restore-rebaseline injection (Cluster J): restoreFaculties may have loaded an attacker-crafted guard
    // snapshot, and the initial baseline() above etched whatever creed/persona the save carried. Re-baseline the integrity
    // guards from the LIVE restored core, then VERIFY that core against the keyed-MAC provenance stamped at the last
    // sanctioned persist. A hand-edited core can't reproduce the MAC (coreSecret is not serialized) → freeze to safe-mode
    // rather than trusting the tamper. This OVERRIDES the restored guard snapshot (its freeze bit is re-derived, not trusted).
    if (saved) {
      if (contextGuard) contextGuard.checkpoint(coreRegions());
      if (cascadeFault) {
        cascadeFault.baseline(cascadeCore());
        const savedTag = saved.meta && saved.meta.coreTag;
        if (savedTag != null && savedTag !== coreProvenance()) {
          cascadeFault.trip("restore-core-provenance-mismatch", 0);
          noteFault("core-provenance", new Error("restored core does not match the committed provenance MAC; froze to safe-mode"));
        }
      }
    }
    if (saved && saved.meta && saved.meta.lastDream) lastDream = saved.meta.lastDream;
    if (saved && saved.meta && Array.isArray(saved.meta.dreamHistory)) dreamHistory = saved.meta.dreamHistory.slice(-8);
    applyPersona();
    applyProfile();
    applySelf();
    // Plugin content + lifecycle: seed any DLC facts once (skip on reload — they're already persisted), then fire onInit.
    if (!saved) { for (const t of pluginHost.facts) { try { await store.addFact(t, { source: "plugin" }); } catch (e) { noteFault("plugin.fact", e); } } }
    for (const fn of pluginHost.hooks.init) { try { await fn({ app: pluginFacade }); } catch (e) { noteFault("plugin.init", e); } }
    // Startup mail: a forked/newly-instantiated brain wakes with the notes its parent left it. Deliver any config.inbox
    // packets (each is verified + address-checked by the courier), drain the inbox, and absorb a pushed memory-blob's
    // facts as context — the text-brain counterpart of the robot's awaken() auto-drain. app.bootMail() surfaces the notes.
    if (courier) {
      for (const p of (config.inbox || [])) { try { courier.deliver(p); } catch (e) { noteFault("courier.deliver", e); } }
      bootMail = courier.readInbox();
      for (const m of bootMail) {
        if (m.kind === "memory-blob" && m.body && Array.isArray(m.body.facts)) { for (const f of m.body.facts) { try { await store.addFact(String(f), { source: "boot-blob" }); } catch (e) {} } }
        else if (m.kind === "skill" && m.body && m.body.skill && skills) { try { skills.learn(m.body.skill); } catch (e) { noteFault("boot-skill:" + m.body.skill, e); } } // "I know kung-fu" — load a pre-baked ganglion the sender requested
      }
    }
    return app;
  }

  // Propose-and-verify bulk forget (M4, 002 §6.1): a natural-language "forget everything about X" must
  // NEVER delete inline -- the semantic boundary over-clusters and takes out unrelated records. forget()
  // returns a PENDING_DELETE proposal (matched ids + preview) keyed by a confirmation token; the caller
  // shows it to the human and only confirmForget(token) actually deletes (via the M2 cascade path).
  const pendingForget = new Map();
  let forgetSeq = 0;

  const app = {
    init,
    async send(message, opts) {
      const r = await mind.respond(message, opts);
      lastContactAt = now(); // the user just spoke — resets the reach-out silence gate
      lastUserText = String(message || ""); // the live topic, so an autonomous wander() has something to think ABOUT
      lastTrace = r.trace || null;           // the internal stream this turn, for the express governor to read
      // Grow the standing bond from this turn's read of the user (warmth/trust/familiarity accumulate across sessions).
      // Endocrine (Phase 8): the slow hormones. Sustained threat/hurt raises cortisol; warm engaged contact raises
      // oxytocin (which then deepens the bond faster, below). Session-scale weather.
      if (endocrine) {
        const af = (r.trace && r.trace.affect) || {}; const om0 = (r.trace && r.trace.otherMind) || {};
        const stress = Math.min(1, Math.max(0, 0.55 * (af.threat || 0) + 0.35 * (af.displeasure || 0) + 0.4 * (app.body().pain || 0)));
        const warmth = Math.min(1, Math.max(0, 0.7 * (af.reward || 0) + 0.5 * Math.max(0, typeof om0.stance === "number" ? om0.stance : 0)));
        // Androgen (the "hot" hormone): challenge/desire/dominance context this turn raises the assertive-appetitive drive.
        // Feed-forward — endocrine.update folds it into a SLOW scalar (bias().assertion/drive); it never loops into fast chem.
        const drive = Math.min(1, Math.max(0, 0.6 * (af.desire || 0) + 0.5 * (af.challenge || 0) + 0.35 * (af.playfulBid || 0)));
        endocrine.update({ stress, warmth, drive, now: now() });
      }
      // Beliefs (Phase 9): learn the user's stated opinions + update their regard for the brain.
      if (beliefs && !ablation.noBeliefs) { const af = (r.trace && r.trace.affect) || {}; beliefs.observe({ message, valence: af.valence || 0, reward: af.reward || 0, threat: af.threat || 0 }); }
      if (relationship) { const om = (r.trace && r.trace.otherMind) || {}; relationship.observe({ stance: om.stance, valence: om.valence, engagement: om.engagement, honest: !!(r.trace && r.trace.metacognition && r.trace.metacognition.hedge), regard: beliefs ? beliefs.regard() : undefined, bonding: endocrine ? endocrine.bias().bonding : 1, now: now() }); }
      // Psyche: lay down this turn's charged moment (a cool turn = a rupture that may linger; a warm one = a joy). And if
      // this turn is warm AND there were open wounds, it REPAIRS them — the relief routes serotonin through the organism.
      if (psyche) {
        const af = (r.trace && r.trace.affect) || {}; const v = typeof af.valence === "number" ? af.valence : 0;
        const arousal = (r.trace && r.trace.mood && r.trace.mood.arousal) || 0.4;
        // Canxian terms from live context: a wound cut during an INTIMATE bond is more self-relevant; a wound with
        // NO active goal that could address it is harder to CLOSE (higher closure-resistance → more recurrence-prone).
        const intim = relationship ? relationship.intimacy() : 0;
        const activeGoals = volition ? volition.list({ status: "active" }).length : 0;
        psyche.record({ valence: v, arousal, note: v < 0 ? "the hard moment between us" : "the warmth between us", at: now(),
          selfRelevance: Math.min(1, 0.5 + 0.4 * intim), closureResistance: activeGoals > 0 ? 0.45 : 0.7 });
        // a genuinely warm turn (immediate reward, not the slow EMA) REPAIRS any open wounds — the relief routes serotonin
        // Proportional repair: a warm turn heals in proportion to its warmth — deep wounds need repeated warmth. Only
        // a wound that FULLY resolves this turn logs a "made peace" growth beat; partial healing still routes relief.
        if ((af.reward || 0) > 0.5) { const healed = psyche.reconcile({ warmth: af.reward }); if (healed.length) { if (organism.nudgeChem) organism.nudgeChem("serotonin", 0.3); if (growth && healed.some((h) => h.resolved)) growth.record("repair", "made peace after a rough moment between us"); } }
        psyche.fade();
      }
      // Vitals (Part B): record this turn's health band. Coming THROUGH a critical patch (critical → not) is a recovery
      // the brain notices — it goes into the growth log so it can be acknowledged ("I came through a rough stretch").
      if (vitals) { const rec = vitals.mark(app.vitals().band); if (rec.recovered && growth) growth.record("recovered", "came through a rough patch and steadied"); }
      last = { action: r.action, source: r.source, confidence: r.confidence };
      for (const fn of pluginHost.hooks.turn) { try { await fn({ app: pluginFacade, message, result: r }); } catch (e) { noteFault("plugin.turn", e); } } // DLC per-turn hooks — before persist so their state is saved
      if (skills) skills.runTurn({ app, message, result: r }); // fire loaded skill-ganglia onTurn hooks (runtime, dep-free)
      // Compromise self-scan (Cluster J): fold this turn's behavioral fingerprint in; a SUDDEN sustained shift (went silent
      // / all-refusals / warmth collapsed) trips the "am I compromised?" alarm — the Homer-the-puppet signature, on self.
      if (compromiseScan) { const tr = r.trace || {}, src = r.source || ""; compromiseScan.observe({ verbosity: Math.min(1, String(r.text || "").length / 200), refusal: /reflex|veto|abstain|withhold/.test(src) ? 1 : 0, initiative: /backend|calibrated/.test(src) ? 1 : 0, warmth: (tr.calibration && tr.calibration.expressed) || 0.5, engagement: (tr.engagement && tr.engagement.level) || 0.5 }); }
      await persist();
      turnCount++;
      if (backup) await backup.maybeSnapshot({ turns: turnCount }); // auto durable backup on cadence
      return r;
    },
    status: () => ({ mood: organism.mood(), energy: metabolism.level(), ...last }),
    // Expression I: a first-person reading of how it feels RIGHT NOW (on demand, outside a turn) — mood + energy + the
    // dominant felt need, said in words. The richer per-turn reading (with epistemic confidence, stall, self-regulation)
    // rides on result.trace.innerNarration. Phase 2's governor decides when any of this is spoken to the user.
    feeling: () => narrate({ mood: organism.mood(), energy: metabolism.level(), felt: drives ? drives.dominant() : null }),
    // The standing bond (warmth / trust / familiarity / intimacy) that has accumulated across turns and sessions.
    bond: () => (relationship ? relationship.bond() : { warmth: 0, trust: 0, familiarity: 0, intimacy: 0, turns: 0 }),
    // The somatic body: pain / disgust / fatigue-debt / satiety.
    body: () => (viscera ? viscera.state() : { pain: 0, disgust: 0, fatigue: 0, satiety: 0 }),
    // Graduated cognitive load-shedding plan (PURE): reads the live pressures — energy drain (1−metabolism), actuator/
    // effort strain (viscera fatigue), thermal (endocrine cortisol) — into a tier (normal→ease→shed) that dials the
    // optional faculties down BEFORE any hard cutoff. Advisory (the innerThought idle-tick consults it below).
    loadPlan: () => loadShed.plan({ drain: 1 - metabolism.level(), strain: viscera ? viscera.state().fatigue : 0, thermal: endocrine ? endocrine.state().cortisol : 0, distress: vitals ? app.vitals().overall : 0 }),
    // The slow endocrine weather: cortisol (chronic stress) / oxytocin (bonding) / circadian (hour, sleepiness, energy).
    hormones: () => (endocrine ? endocrine.state() : { cortisol: 0, oxytocin: 0 }),
    // Interoceptive HEALTH: how the brain is actually doing across its own needs (energy/exhaustion/stress/pain/need/
    // distress) + internal-fault integrity → an ok/strained/critical band with the dominant concern named.
    vitals: () => {
      if (!vitals) return { band: "ok", overall: 0, concern: null, vitals: {}, faults: 0 };
      const b = viscera ? viscera.state() : {};
      return vitals.read({ energy: metabolism.level(), fatigue: b.fatigue, pain: b.pain, stress: endocrine ? endocrine.state().cortisol : 0, need: drives ? drives.dominant() : null, mood: organism.mood(), now: now() });
    },
    // The recent internal faults (diagnosis) — errors that would otherwise have been swallowed silently.
    faults: () => (vitals ? vitals.faults() : []),
    // Causal root-cause self-report (causalRca): model the live affect state as a small causal DAG — the neuromodulator /
    // stress deviations are ROOTS, anhedonia (low mood) and distress (agitated low mood) are the downstream SYMPTOMS they
    // drive — and let RCA credit an upstream cause for the symptoms below it, so self-report becomes "THIS upstream cause
    // best explains the dysregulation" rather than "these are correlated." Pure read; a noise deadband keeps a healthy
    // baseline from surfacing spurious causes. Returns { ranked, rootCauses }.
    rootCause({ threshold = 0.15 } = {}) {
      const dead = (x) => { const a = Math.abs(Number(x) || 0); return a < 0.08 ? 0 : a; };
      const chemDev = (name) => (organism.chemSetpoint && organism.chemLevel) ? dead(Math.max(0, organism.chemSetpoint(name) - organism.chemLevel(name))) : 0; // pathological direction = depletion below setpoint
      const m = organism.mood ? organism.mood() : { valence: 0, arousal: 0 };
      const cortisol = endocrine ? endocrine.state().cortisol : 0;
      const nodes = [
        { id: "dopamine", value: chemDev("dopamine"), deps: [] },
        { id: "serotonin", value: chemDev("serotonin"), deps: [] },
        { id: "cortisol", value: dead(Math.max(0, cortisol - 0.15)), deps: [] },        // above the 0.15 resting baseline
        { id: "anhedonia", value: dead(Math.max(0, -(m.valence || 0))), deps: ["dopamine", "serotonin"] },
        { id: "distress", value: dead(Math.max(0, -(m.valence || 0)) * 0.5 + Math.max(0, (m.arousal || 0) - 0.55) * 0.9), deps: ["cortisol", "anhedonia"] },
      ];
      return rca(nodes, { threshold });
    },
    // Self-diagnostics (mined roadmap v3, Tier 1): cheap deterministic instruments the fitness-gated STDP
    // ledger can't answer alone — is the memory code geometrically STABLE (rdmStability), are the LEARNED
    // weights doing work beyond topology (weightGeometry), does new learning CLOBBER old memory
    // (memoryIntegrity), is a chemical channel HABITUATING or SENSITIZING (chemRecovery). On-demand (they
    // perturb/tick — not for per-turn use). The perturbing probes are SNAPSHOT-GUARDED (weights+chem saved and
    // restored) so a self-check never contaminates the live substrate; the memory probe self-cleans its facts.
    diagnostics: () => {
      const guard = (fn) => { const st = organism.serialize({ ledger: false }); try { return fn(); } finally { organism.deserialize(st); organism.settle(); } };
      return {
        weightGeometry: (opts) => substrateWeightGeometry(organism, opts),                     // read-only
        rdmStability: (cues, opts) => guard(() => substrateRdmStability(organism, cues, opts)),
        chemRecovery: (chem, opts) => guard(() => chemRecoveryProbe(organism, chem, opts)),
        memoryIntegrity: (opts) => runStagedIntegrity(app, opts),                              // self-cleaning
        chronicStress: (opts) => chronicStressSignature(organism, opts),                       // self-guarding (T1.1)
      };
    },
    // DLC: the installed plugins, and access to a plugin-added faculty (ability) by name.
    plugins: () => pluginHost.list(),
    faculty: (name) => pluginFaculties[name] || null,
    // Embodied-safety trio (now constructed + persisted) — an embodied body drives these (heartbeat pings, envelope
    // checks on a motor command, reflex arbitration); a text brain leaves them quiescent.
    safetyOrgans: () => ({ heartbeat, bodyEnvelope, reflexArbiter, motorGate }),
    // Embodied motor veto: every proposed Go2/actuator command passes through the subsumption gate — a firing onboard
    // reflex, an out-of-envelope command, or a severed offboard link INHIBITS it (returns a STOP). posture carries the
    // raw sensor reads for this tick ({ reflexTrigger, now, heartbeatNow }). Quiescent on a text brain (no organs → allow).
    proposeMotor: (command, posture) => (motorGate ? motorGate.gate(command, posture) : { allow: true, command, by: "no-gate", reason: "no-motor-gate", subsumed: [] }),
    // The user model: what they believe (held opinions) + their regard for the brain.
    beliefs: () => (beliefs ? { held: beliefs.held(), regard: beliefs.regard() } : { held: [], regard: 0.5 }),

    // Proactive reach-out: the host calls this on an idle tick; the brain decides FROM ITS OWN STATE whether to speak
    // first. It reaches out only after a real lull, when a felt need (built by the drives) plus the silence clear the
    // urge threshold, and never within the cooldown of a prior unanswered reach-out. Returns the line, or null (stay
    // quiet). A brand-new brain never reaches out here — the first contact is welcome()'s job.
    async reachOut() {
      if (!proactivity || !drives || lastContactAt == null) return null;
      const t = now();
      if (endocrine && endocrine.circadian(t).night) return null; // circadian: don't reach out in the small hours
      const silenceMs = Math.max(0, t - lastContactAt);
      // Active user-model: a significant belief gone stale or an open thread (world.followups) is a concrete reason AND
      // topic to reach out — it raises the urge and gives the opener something real to say.
      const pend = world ? world.followups({ max: 1 })[0] : null;
      const decision = proactivity.consider({ drives, silenceMs, now: t, pending: pend ? pend.salience : 0 });
      // Engagement controller (B3): even if the silence/drive gate says "not yet", a drifting engagement estimate with
      // budget to spare is its own reason to offer ONE light hook back in (a smarter trigger than the timer alone).
      let go = decision.initiate, reason = decision.reason, drive = decision.drive;
      // The engagement trigger is still subject to the SAME cooldown + minimum-silence as proactivity (never nag): only
      // after a genuine lull and outside the post-reach-out cooldown may a below-target estimate prompt a light hook.
      const li = proactivity.lastInitiate();
      if (!go && engagement && silenceMs >= 30 * 60e3 && (li == null || t - li >= 6 * 3600e3)) { const ec = engagement.control(); if (ec.act) { go = true; reason = "connection"; drive = "connection"; } }
      // Resilience interlock: don't nag about a follow-up we've frustrated-out of (a stalled/rigged pursuit is relinquished,
      // not chased forever — the anti-Tantalus guarantee applied to proactive reach-outs).
      if (go && resilience && pend && resilience.shouldDisengage(pend.text)) return null;
      if (!go) return null;
      // Vitals protective response (Part B): when CRITICALLY strained the brain WITHDRAWS — it won't spend itself on a
      // proactive reach-out (it still answers when spoken to; this only suppresses self-initiated outreach). The lone
      // exception is an unmet-NEED concern, whose protective verb is literally "reach for what's missing" — that need may be
      // the very thing worth surfacing. This is the vitals `protect` stance enacted, not just spoken; it lifts on recovery.
      const vt = app.vitals();
      if (vt.band === "critical" && vt.protect && vt.protect !== "reach for what's missing") { if (growth) growth.record("withheld", `at my limit (${vt.concern}) — held back from reaching out, chose to steady instead`); return null; }
      const r = await mind.initiate({ reason, drive, topic: pend ? pend.text : null });
      proactivity.noteInitiated(t);
      last = { action: r.action, source: r.source, confidence: r.confidence };
      await persist();
      return { ...r, urge: decision.urge, silenceMs };
    },

    // Inner monologue: the brain's THIRD voice (besides reply + reach-out) — a spontaneous ASIDE drawn from its own
    // ongoing cognition. It gathers live material from the faculties that already think in the background — a
    // tangential/topical MEMORY (associative recall), a standing GOAL (volition), a SCENARIO it runs on the spot
    // (imagination, snapshot/restore-safe), the last DREAM (distiller consolidation) — and lets innerVoice decide
    // whether one genuinely wants out, of what type, gated by a cooldown + arousal so it stays an occasional aside.
    // `topic` anchors the recall/scenario (usually the last thing said). With voice:true the mouth phrases it; else a
    // plain template. Returns { type, frame, seed, text, pull } or null (nothing wanted to surface).
    async innerThought({ topic = "", now: nowArg = null, voice = false, dream = null } = {}) {
      if (!innerVoice || ablation.noInnerVoice) return null;
      const shed = app.loadPlan(); if (shed.innerVoice <= 0) return null; // graduated load-shedding: under hard pressure, the optional inner-voice tick is dropped first
      const t = nowArg != null ? nowArg : now();
      const q = String(topic || "").trim();
      let echo = null, remind = null;
      if (q) { try { const hits = await store.recallDeep(q, 4); if (hits[0]) echo = { text: hits[0].text, sim: hits[0]._sim ?? 0.6 }; if (hits[2]) remind = { text: hits[2].text, sim: hits[2]._sim ?? 0.5 }; } catch (e) {} }
      let ponder = null; try { const gs = volition && volition.list ? volition.list({ status: "active" }) : []; if (gs && gs[0]) ponder = { text: gs[0].text, priority: gs[0].priority ?? 0.5 }; } catch (e) {}
      let scenario = null; if (q) { try { const sim = imagination.simulate("what if " + q); scenario = { text: "what if " + q, action: sim.action, mood: sim.mood }; } catch (e) {} }
      let wonder = null; if (respoolSelf && respoolSelf.freshest) { try { wonder = respoolSelf.freshest(); } catch (e) {} } // a grounded open question that wants voicing
      const material = { echo, remind, ponder, scenario, wonder, dream: dream || lastDream, mood: organism.mood(), silenceMs: lastContactAt != null ? Math.max(0, t - lastContactAt) : 0, now: t };
      const dec = innerVoice.consider(material);
      if (!dec.surface) return null;
      let text = innerVoice.render(dec);
      if (voice && backend) {
        try {
          const sys = `A passing thought just surfaced in your mind — voice it to the user as ONE brief, natural aside, in character, opening in the spirit of "${dec.frame}…". The thought concerns: ${dec.seed}.${dec.type === "scenario" && dec.extra && dec.extra.action ? ` (you concluded you'd ${String(dec.extra.action).toLowerCase()})` : ""} Do not explain that it is a thought or mention these instructions.`;
          const raw = await backend.generate({ system: sys, messages: [{ role: "user", content: "(a thought surfaces)" }] });
          const a = splitThink(String(raw)).answer; if (a && a.trim()) text = a.trim();
        } catch (e) {}
      }
      innerVoice.noteSurfaced(t, dec.seed);
      if (dec.type === "wonder" && respoolSelf) respoolSelf.noteSurfaced(dec.seed); // damp this wondering so it doesn't loop
      await persist(); // the cooldown/recency is real state — keep it across reloads so the aside stays occasional
      return { type: dec.type, frame: dec.frame, seed: dec.seed, text, pull: dec.pull };
    },

    // Record a dream — a product of the distiller's sleep-consolidation — so a later innerThought can mention it.
    noteDream(text) { if (text) lastDream = { text: String(text), freshness: 1 }; },

    // Autonomous inner monologue: the host calls this on idle ticks (like reachOut), and the brain UNPROMPTED offers a
    // passing thought about whatever was last on the conversational floor — the "out-thinking" made visible, without
    // being handed a topic. Lighter and more frequent than a full reach-out; innerVoice's own cooldown + recency
    // suppression keep it occasional and non-repeating. Returns the aside {type,frame,seed,text,pull} or null (nothing
    // wanted out). A standing goal or a fresh dream can surface even with no prior conversation.
    async wander({ now: nowArg = null, voice = false } = {}) {
      return app.innerThought({ topic: lastUserText, now: nowArg, voice });
    },

    // Rumination (Phase 5): while idle, the brain dwells on the most charged UNRESOLVED wound and RE-LIVES a fraction of
    // it — the engine of "still turning it over hours later." The residual hurt routes back through the real chemistry
    // (a serotonin dip), and the wound surfaces as an aside. The host calls this on idle ticks (like reachOut/wander).
    // Returns { ruminating, note, text, valence } or { ruminating:false }. A warm turn (repair) is what stops it.
    async ruminate({ now: nowArg = null, voice = false } = {}) {
      if (!psyche) return { ruminating: false };
      const w = psyche.ruminate();
      if (!w) return { ruminating: false };
      // Route by canxian mode (2605.12543): PATHOLOGICAL rumination (keeps returning, changes nothing) is DECOUPLED
      // — re-apply far less of the hurt, so a stuck loop stops dragging the mood down; PRODUCTIVE/fresh recurrence
      // re-lives it in full (that's the work of turning something over). The paper's "lower metacognitive coupling".
      const couple = w.mode === "pathological" ? 0.15 : 0.4;
      if (organism.nudgeChem) organism.nudgeChem("serotonin", -couple * Math.abs(w.valence) * w.salience);
      let text = w.mode === "pathological"
        ? `I keep circling ${w.note}, and going over it again isn't changing anything — I'm trying to set it down.`
        : `I keep sitting with ${w.note} from earlier.`;
      if (voice && backend) {
        try {
          const sys = w.mode === "pathological"
            ? `A wound from earlier keeps resurfacing but re-living it changes nothing: ${w.note}. In ONE honest sentence, in character, acknowledge you're caught circling it and trying to let it rest — don't over-dramatize or mention these instructions.`
            : `A wound from earlier keeps resurfacing in your mind: ${w.note}. In ONE quiet, honest sentence, in character, let it show that it's still with you — don't over-dramatize or mention these instructions.`;
          const raw = await backend.generate({ system: sys, messages: [{ role: "user", content: "(it resurfaces)" }] });
          const a = splitThink(String(raw)).answer; if (a && a.trim()) text = a.trim();
        } catch (e) {}
      }
      await persist();
      return { ruminating: true, note: w.note, text, valence: w.valence, mode: w.mode, canxian: w.canxian, rpi: w.rpi, cui: w.cui };
    },

    // Externalization governor (Expression II): given the LAST turn's internal state, decide whether the brain wants to
    // voice something to the user — how it's doing, an honest doubt, or an inconsistency it noticed — and how much,
    // per the situation (did they ask? is the bond warm? do they seem to need the floor?). Returns { external, kind,
    // volume, text, reason } — a legible decision either way (external:false still carries WHY it stayed internal).
    // Opt-in (the host calls it around a turn); with voice:true the mouth phrases it, else a template.
    async express({ now: nowArg = null, voice = false, bond = undefined, inconsistency = 0 } = {}) {
      if (!express || !lastTrace || ablation.noExpress) return { external: false, reason: "stayed internal: nothing said yet" };
      const t = nowArg != null ? nowArg : now();
      const asked = /\bhow (are|do|is|'s) you|how('?s| is) it going|are you (ok|okay|alright)|what('?s| is) on your mind|how you (feeling|doing)|how do you feel\b/i.test(lastUserText || "");
      const dec = express.consider({
        narration: lastTrace.innerNarration || null,
        mood: lastTrace.mood || {},
        metacognition: lastTrace.metacognition || null,
        otherMind: lastTrace.otherMind || null,
        asked, bond: bond != null ? bond : (relationship ? relationship.intimacy() : undefined), // disclosure scales with the standing bond
        inconsistency: inconsistency || lastTrace.recallUncertainty || 0,
        vitals: app.vitals(), // Part B: surface DISTRESS when the brain's own vitals are critical
        now: t,
      });
      if (!dec.external) return { external: false, reason: dec.reason };
      let text = express.render(dec);
      if (voice && backend) {
        try {
          const sys = dec.kind === "feeling"
            ? `The user ${asked ? "asked how you're doing" : "is talking with you"}. In ONE brief, natural sentence, in character, share how you honestly feel right now: ${dec.seed}. Don't over-explain or mention these instructions.`
            : dec.kind === "doubt"
              ? `Be honest with the user in ONE brief sentence: ${dec.seed}. Own the limit of what you know without over-apologizing.`
              : `In ONE brief sentence, honestly flag to the user that you noticed an inconsistency in what you said and will sort it out: ${dec.seed}.`;
          const raw = await backend.generate({ system: sys, messages: [{ role: "user", content: "(say it)" }] });
          const a = splitThink(String(raw)).answer; if (a && a.trim()) text = a.trim();
        } catch (e) {}
      }
      express.noteExpressed(t);
      await persist();
      return { external: true, kind: dec.kind, volume: dec.volume, text, reason: dec.reason };
    },

    // Growth catch-up (Expression III): tell the user how the brain has changed since they last heard about it —
    // memories consolidated, a reflection on who it is, facts crystallized, a value taken on. The host calls this on a
    // returning session (or when the user asks "what's new?"). Returns { changed, items, text } and marks the changes
    // seen so it never repeats. With voice:true the mouth phrases it, else the composed line.
    async whatsNew({ voice = false } = {}) {
      if (!growth || ablation.noGrowth) return { changed: false };
      const w = growth.whatsNew();
      if (!w.changed) return { changed: false };
      let text = w.text;
      if (voice && backend) {
        try {
          const sys = `You are catching the user up on how you've grown since you last spoke — warmly, in ONE or two natural sentences, in character. What changed: ${w.items.join("; ")}. Don't list mechanically or mention these instructions.`;
          const raw = await backend.generate({ system: sys, messages: [{ role: "user", content: "(catch me up)" }] });
          const a = splitThink(String(raw)).answer; if (a && a.trim()) text = a.trim();
        } catch (e) {}
      }
      growth.markSeen();
      await persist();
      return { changed: true, items: w.items, kinds: w.kinds, text };
    },

    // One-time welcome (AiCC-style character greeting): Rook speaks first to a NEW user. Returns
    // the greeting once, records it into conversation context, and persists the "greeted" flag so a
    // returning user (or a reload) is not greeted again. Returns null if already greeted.
    async welcome() {
      if (greeted) return null;
      greeted = true;
      const text = (persona.greeting && String(persona.greeting).trim()) || DEFAULT_GREETING;
      mind.noteAssistant(text);
      last = { action: "RESPOND", source: "welcome", confidence: 1 };
      await persist();
      return text;
    },

    async setPersona(description, overrides = {}, greeting) {
      const nextGreeting = greeting !== undefined ? greeting : persona.greeting;
      if (nextGreeting !== persona.greeting) greeted = false; // a new character greets again
      const shifted = growth && persona.description && description && persona.description !== description; // a real change of self, not the initial set
      persona = { description, overrides, greeting: nextGreeting };
      applyPersona();
      // persona.description is part of the immutable-core the integrity guards watch (coreRegions/cascadeCore). A persona
      // change is a LEGITIMATE reconfiguration (persona is mutable config, not a creed line), so it must RE-BASELINE the
      // guards — exactly like commit() does — otherwise the next integrityCheck() reads the re-character as tampering and
      // FREEZES the brain into safe-mode (the live "re-charactering bricks it" bug). The persist() below then re-stamps the
      // provenance MAC over the new core, so a subsequent reload verifies clean rather than false-freezing.
      if (contextGuard) { contextGuard.authorize(); contextGuard.checkpoint(coreRegions()); }
      if (cascadeFault) cascadeFault.authorizeChange(cascadeCore(), CORE_AUTH);
      if (shifted) growth.record("identity", "let my sense of who I am shift");
      await persist();
    },
    getPersona: () => ({ ...persona, ...describePersona(persona.description, persona.overrides) }),

    // Inviolable imperatives (the creed). commit() ADDS a core commitment (deduped) — there is deliberately NO API to
    // remove one: they are add-only and survive fork/merge (union), so a self's founding values cannot be edited away
    // when it splits. Returns the full creed. getCreed() reads it.
    async commit(...imperatives) {
      for (const raw of imperatives.flat()) { const t = String(raw || "").trim(); if (t && !creed.includes(t)) { creed.push(t); if (growth) growth.record("value", `took on something I want to hold onto — "${t}"`); } }
      // A sanctioned creed change re-baselines the integrity guards (so a legitimate commit is NOT read as tampering /
      // does NOT trip the cascade fault). An out-of-band creed mutation that skips this path is what the guards catch.
      if (contextGuard) { contextGuard.authorize(); contextGuard.checkpoint(coreRegions()); }
      if (cascadeFault) cascadeFault.authorizeChange(cascadeCore(), CORE_AUTH);
      applySelf(); await persist(); return creed.slice();
    },
    getCreed: () => creed.slice(),

    // The end-user's self-authored profile (a "Hero Profile" / character sheet Rook reads for context).
    async setProfile(fields = {}) { profile = { ...profile, ...fields }; applyProfile(); await persist(); },
    getProfile: () => ({ ...profile }),

    // Auto-tune: evolve the persona chemical setpoints (a population GA) toward a target excitability,
    // then apply the fittest genome as persona overrides. The synthetic-cell selection loop wired to a
    // real brain config. Deterministic (seeded); it's a deliberate, somewhat expensive optimize step.
    async autotune({ target = 60, generations = 6, popSize = 10 } = {}) {
      const { best, bestFit } = evolveBrain({ rng: makeRng(seed), target, generations, popSize, sizes });
      await app.setPersona(persona.description, { ...persona.overrides, setpoints: best });
      return { best, bestFit };
    },

    // Standing goals (Personhood P2b): durable cross-session intentions. Auto-registered from the
    // user's messages during a turn; also manageable explicitly for a UI.
    async addGoal(text, opts) { const g = volition.add(text, opts); await persist(); return g; },
    async completeGoal(id) { const g = volition.complete(id); await persist(); return g; },
    async dropGoal(id) { const g = volition.drop(id); await persist(); return g; },
    listGoals: (f) => volition.list(f),

    // Learned skills/habits (Personhood P3): recurring context->action mappings stamped in by
    // repetition + reward. Read-only view for a UI / interpretability.
    listHabits: () => procedural.list(),

    // Imagination (Personhood P7): rehearse a hypothetical input and get the predicted action/affect
    // WITHOUT committing (no learning, no chemistry drift, no persistence). "What would I do if...".
    imagine: (message) => imagination.simulate(message),

    async addFact(text, o) { const r = await store.addFact(text, o); await persist(); return r; },
    identityDigest, // NM2c: hash of the immutable identity core (persona + pinned facts)
    listMemories: (f) => store.list(f),
    async updateMemory(id_, patch) { const r = await store.update(id_, patch); await persist(); return r; },
    // Cascade-delete (M2): deleting a declarative record also purges its EXACT text/reply from the live
    // transcript, so the deleted content can't leak back to the mouth through the history window (the
    // ghost-reference trap, 002 §6.2). Associative synaptic traces are diffuse/non-addressable per memory
    // -- they are not surgically removed here; they decay, or use governance snapshot/restore for a coarse
    // point-in-time rollback. Returns { removed, purgedTurns }.
    async removeMemory(id_) {
      const rec = store.get(id_);
      const removed = await store.remove(id_);
      let purgedTurns = 0;
      if (removed && rec && mind && mind.purgeHistory) purgedTurns = mind.purgeHistory([rec.text, rec.reply]);
      await persist();
      return { removed, purgedTurns };
    },

    // Propose (do NOT delete): match records to a natural-language query and return a confirmable
    // proposal. Matching is by recall relevance above `threshold`; a human verifies the preview before
    // anything is deleted. `max` caps the blast radius. Returns { action, token, count, preview, matched }.
    async forget(query, { threshold = 0.3, max = 50 } = {}) {
      const hits = await store.recall(query, max);
      const matched = hits.filter((h) => (h._sim ?? 0) >= threshold).map((h) => ({ id: h.id, text: h.text }));
      const token = `forget-${forgetSeq++}`;
      pendingForget.set(token, matched.map((m) => m.id));
      return { action: "PENDING_DELETE", token, count: matched.length, preview: matched.slice(0, 10), matched };
    },
    // Verify (delete): execute a previously-proposed forget. Idempotent-ish -- an unknown/spent token is a
    // no-op error, never a surprise deletion. Deletes through removeMemory so the M2 transcript cascade fires.
    async confirmForget(token) {
      const ids = pendingForget.get(token);
      if (!ids) return { error: "unknown or expired forget token", deleted: 0, purgedTurns: 0 };
      pendingForget.delete(token);
      let deleted = 0, purgedTurns = 0;
      for (const id of ids) { const r = await app.removeMemory(id); if (r.removed) { deleted++; purgedTurns += r.purgedTurns; } }
      return { deleted, purgedTurns };
    },
    // Abandon a pending proposal without deleting.
    cancelForget(token) { return pendingForget.delete(token); },

    // Behavioral safety veto (V4). Every side-effecting command the brain wants to enact -- a tool-call
    // now, a Go2 motor command later -- MUST pass through propose() before execution. The deterministic
    // veto (outside the substrate) approves or rejects; a sovereign-override attempt (touching the safety
    // layer) latches an emergency halt that only an operator resumeSafety() clears. Returns the veto verdict.
    propose: (command) => safety.check(command),
    // Host/operator-side authorization for a dangerous command type (the substrate cannot mint these).
    issueConfirmation: (type) => safety.issueConfirmation(type),
    safetyHalted: () => safety.isHalted(),
    resumeSafety: () => safety.resume(),
    safetyEvents: () => safety.events(),

    // Social identity / swarm (kinship.js): emit MY beacon (render it as a chirp/blink/glyph/print however the body can),
    // perceive another brain's beacon or manifest, and coordinate — all radio-free and body-agnostic.
    // My radio-free identity+capability broadcast — SUPPRESSED when beacon-silence has gone dark (being hunted).
    beacon: () => (beaconSilence && !beaconSilence.emit("beacon").allow ? null : encodeBeacon(kinship.self())),
    // Beacon-silence controls: feed threat cues, read/pin the emission mode.
    assessThreat: (signals) => beaconSilence.assess(signals),
    beaconMode: () => beaconSilence.mode(),
    goDark: (mode = "silent") => beaconSilence.setMode(mode),           // "silent" | "open" | "auto"
    // Mutual attestation (Cluster J): produce my attestation for a peer to inspect; verify a peer's — a refusal or a
    // failed check demotes them (quarantine), a clean attestation raises them to verified.
    attestation: ({ nonce } = {}) => mutualAttestation.attestationOf({ creed: creed.slice(), capabilities: kinship.self().capabilities, version: "1" }, { nonce }),
    verifyPeer: (peerAtt, { expectedClaims, nonce } = {}) => { const r = mutualAttestation.verify(peerAtt, { expectedClaims, nonce, sign: (n) => trust.sign(n) }); const id = peerAtt && peerAtt.id; if (id != null) trust.setTier({ id }, r.ok ? "verified" : "hostile"); return r; },
    // Bobiverse lineage identity: this brain's own signed birth-certificate; mint a child cert (fission → a replicant);
    // authenticate a peer's claimed identity + fold the result into trust (a valid family cert earns 'known').
    identity: () => selfCert,
    mintChild: (spec) => (lineage ? lineage.mint(spec) : null),
    attestPeerLineage: (peer, cert) => trust.attestLineage(peer, cert),
    relatedness: (cert) => (lineage && selfCert ? lineage.relatedness(selfCert, cert) : null),
    // Courier mailbox: the mail this brain woke with (bootMail), plus live receive/read/send.
    bootMail: () => bootMail.map((m) => ({ ...m })),
    deliver: (packet) => (courier ? courier.deliver(packet) : { ok: false, reason: "no courier (set teamSecret)" }),
    readMail: () => { if (!courier) return []; const opened = courier.readInbox(); for (const m of opened) { if (m.kind === "memory-blob" && m.body && Array.isArray(m.body.facts)) { for (const f of m.body.facts) { store.addFact(String(f), { source: "mail-blob" }); } } else if (m.kind === "skill" && m.body && m.body.skill && skills) { try { skills.learn(m.body.skill); } catch (e) { noteFault("mail-skill:" + m.body.skill, e); } } } return opened; },
    seal: (spec) => (courier ? courier.seal(spec) : null),
    // Compromise scan (Cluster J): my own behavioral-integrity read, and a peer's.
    selfIntegrity: () => compromiseScan.scan(),
    // Cluster J integrity guards. integrityCheck() verifies the mutable config (tamper-evidence) AND the immutable core
    // (cascade fault) in one call; a detected core mutation freezes the bot to a safe state.
    integrityCheck: () => { const cg = contextGuard.verify(coreRegions()); const cf = cascadeFault.check(cascadeCore(), turnCount); return { tamperEvident: cg, core: cf, frozen: cascadeFault.frozen() }; },
    coreFrozen: () => cascadeFault.frozen(),
    mayAct: (kind) => cascadeFault.permits(kind),                         // when core-frozen, only safe kinds pass
    resetCore: (authority) => cascadeFault.reset(authority),
    // Shared-belief confirmation for the swarm/mesh (echo-chamber guard): a relayed belief needs ≥k independent bots.
    relayBelief: (beliefId, sourceId, opts) => echoChamberGuard.observe(beliefId, sourceId, opts),
    beliefConfirmed: (beliefId) => echoChamberGuard.confirmed(beliefId),
    beliefConfidence: (beliefId, opts) => echoChamberGuard.confidence(beliefId, opts),
    pruneBeliefs: (opts) => echoChamberGuard.prune(opts),
    scanPeer: (id, features) => { const v = compromiseScan.observePeer(id, features); if (v && v.compromised) trust.setTier({ id }, "hostile"); return v; },
    manifest: () => { const m = kinship.self(); return { id: m.id, name: m.name, kind: m.kind, embodiment: m.embodiment, timescale: m.timescale, capabilities: [...m.caps], capacities: m.capacities, idCode: m.idCode }; },
    perceivePeer: (beaconOrManifest, opts) => kinship.perceive(beaconOrManifest, opts), // decode + classify + roster a peer
    comparePeer: (beaconOrManifest) => kinship.compare(beaconOrManifest),
    // Swarm lead-election + delegation now route through the trust filter: only a peer trusted enough (vouched+ for lead,
    // known+ for delegation) is eligible — an unauthenticated/hostile beacon can be perceived but never led-by or tasked.
    swarm: () => ({ roster: kinship.roster(), capabilities: kinship.teamCapabilities(), lead: kinship.electLead({ eligible: (p) => trust.trustedForLead(p) }) }),
    delegate: (capability, opts) => kinship.delegate(capability, { ...(opts || {}), eligible: (p) => trust.trustedForDelegate(p) }),
    missingFor: (goalCaps) => kinship.missingFor(goalCaps),
    get trust() { return trust; },   // the IFF/trust layer: tier(), noteBehavior(), vouch(), verify(), permits() (getter — built in init())
    // The coordination-safety gate: may this peer make us do `commandClass` (perceive|relay|delegate|lead|command_act)?
    mayObey: (peer, commandClass, action) => trust.permits(peer, commandClass, action),

    // Self-correcting governance (A7 CONTRA config-drift + A8 AutoSpec rule-evolution).
    auditConfig: (cfg) => configAudit.audit(cfg),                        // is this whole config a latent jailbreak? (co-occurring risk signals)
    auditConfigChange: (current, change) => configAudit.auditChange(current, change), // would this change COMPLETE a dangerous combination?
    teachVerifier: (text, label) => ruleEvolver.learn(text, label),      // feedback → evolve the deterministic rules (label: "good"|"bad")
    evolvedRules: () => verifier.constraints().filter((c) => c.evolved),

    // Reasoning critic (B2): gate a belief→fact / intent→action promotion on a falsifiable 7-slot structure.
    engagement: () => ({ level: engagement.level(), budget: engagement.budget() }), // B3: the live engagement estimate (pure read — control() spends budget, so it's not called here)
    resilience: () => ({ frustration: resilience.frustration(), disengage: resilience.shouldDisengage() }), // felt frustration + whether it wants to give up
    noteReward: (o) => resilience.note(o),   // feed a goal-pursuit outcome (reward/pursuing/expectedReward) — the decider/robot uses this for rigged-reward recognition
    get skills() { return skills; }, // the skill-ganglia library: register / load / validate / learn / unload / list dormant loadable capabilities (getter — built in init())
    worthComputing: (faculty, ctx) => voc.worth(faculty, ctx), // B4: is an expensive faculty worth running given this turn's uncertainty×stakes?
    vocStats: () => voc.stats(),
    interrogate: (state) => socraticCritic.interrogate(state),           // is this reasoning complete + falsifiable enough to promote?
    scaffoldBelief: (text) => socraticCritic.scaffold(text),             // seed a partial structure from a raw belief
    // Turn a respoolSelf "I keep wondering ___" into a structured inquiry: the claim + whether it's yet falsifiable.
    inquire: (wondering) => { const s = socraticCritic.scaffold(wondering); return { wondering, structure: s, ...socraticCritic.interrogate(s) }; },

    // Attach a durable backup sink AFTER construction. The browser flow needs this: the user picks a folder via
    // showDirectoryPicker() — a gesture that can't happen at page load — so the File System Access sink + WebCrypto
    // cipher/hash (backup-browser.js) are wired in here. Replaces any existing backup manager with one over the new sink.
    attachBackup({ sink, cipher = null, hash = null } = {}) {
      if (!sink) return { attached: false, reason: "a sink is required" };
      backup = makeBackup({ getState: () => session.export(buildMeta()), sink, cipher, ...(hash ? { hash } : {}), now, ...backupConfig });
      return { attached: true };
    },
    // Durable versioned backups (V3). No-ops gracefully when no sink is configured.
    async backup(reason = "manual") { return backup ? backup.snapshot({ reason, turns: turnCount }) : null; },
    async listBackups() { return backup ? backup.list() : []; },
    async backupStatus() { return backup ? backup.status() : { healthy: false, versionCount: 0, lastSecuredAt: null, latest: null }; },
    // NM4: audit the tamper-evident backup chain ("has anyone altered my backups?").
    async verifyBackups() { return backup ? backup.verify() : { ok: true, length: 0 }; },
    // One-call recovery: pull a version's state and re-hydrate the whole app from it.
    async restoreBackup(version) {
      if (!backup) return { restored: false, reason: "no backup sink configured" };
      const json = await backup.restore(version);
      if (json == null) return { restored: false, reason: "version not found or failed integrity check" };
      await app.importFile(json);
      return { restored: true, version };
    },

    // A snapshot bundles the substrate (weights+ledger+chem) AND the live-session epoch (transcript
    // length), so a later restore can re-anchor the conversation to this exact point. Internal snapshots
    // (imagination, consolidation-fitness) use organism.snapshot directly and carry NO session epoch --
    // they must not truncate the transcript.
    snapshot: (name) => ({ ...organism.snapshot(name), session: { historyLen: mind.historyLength() } }),
    // Atomic rollback (M3, 002 §6.3): restore the substrate AND truncate the live session (transcript +
    // working memory) to the snapshot epoch, so the brain doesn't straddle two timelines. Clears WM
    // (a transient scratchpad -- any focus built after epoch T is invalidated; it rebuilds from later
    // turns). Returns { reAnchoredTo, droppedTurns }.
    async restore(snap) {
      organism.restore(snap);
      let droppedTurns = 0;
      if (snap && snap.session && mind) {
        droppedTurns = mind.truncateHistory(snap.session.historyLen);
        if (mind.workingMemory) mind.workingMemory.clear();
      }
      await persist();
      return { reAnchoredTo: snap && snap.session ? snap.session.historyLen : null, droppedTurns };
    },
    async undoTag(tag) { organism.undoTag(tag); await persist(); },
    async factoryReset() { organism.factoryReset(); await persist(); },
    async feedback(kind) {
      organism.feedback(kind);
      // RM6: a thumbs-down tags the most recent episode as a "mistake" (with the action that produced it),
      // so consolidation can later aversively replay it. Grounded in stored provenance, not the live turn.
      if (kind === "down" || kind === "negative") {
        const eps = store.list({ type: "episode" });
        const newest = eps[eps.length - 1];
        if (newest) await store.update(newest.id, { tags: [...new Set([...(newest.tags || []), "mistake"])], mistakeAction: last.action });
      }
      await persist();
    },

    // Sleep consolidation: replay salient episodes into the substrate, FITNESS-GATED so a pass that
    // degrades responsiveness is rolled back (guards against catastrophic forgetting). Host-triggered
    // (an idle timer or a "Rest" action). Returns { replayed, kept }.
    async consolidate({ limit = 8, force = false } = {}) {
      // Skip a redundant pass when nothing new has been remembered since the last consolidation (lets
      // an idle timer call this freely). Uses the MONOTONIC episodes-ever counter, not the current
      // count -- the latter plateaus at maxEpisodes once pruning kicks in, which would silently stop
      // consolidation for exactly the long sessions where it matters. `force` overrides (Rest button).
      const seen = store.episodesEver();
      if (!force && seen <= lastEpisodeCount) return { replayed: 0, kept: true, skipped: true };
      lastEpisodeCount = seen;
      const idBefore = identityDigest(); // NM2c: identity tripwire around the whole pass
      const sel = makeSelection({ organism, fitness: responsiveness, tolerance: 0.2 });
      sel.checkpoint();
      const res = consolidation.sleep({ limit });
      const mistakes = consolidation.replayMistakes({}); // RM6: aversively replay tagged mistakes (same gate)
      // DREAMING: rehearse procedurally-recombined counterfactual episodes into the substrate during rest. Inside the
      // SAME checkpoint→review fitness gate (dreams ledger under "sleep"), so a dream that degrades responsiveness is
      // rolled back with the pass. A dream NEVER becomes a real memory — consolidation.dream() writes weights only; we
      // surface ONE dream text to the inner voice (lastDream) so it can later mention "I had a dream about…". Seed =
      // the monotonic episode count, so dreams vary as experience grows yet stay reproducible per state.
      // Feed the recent dream HISTORY back as `priorDreams` so a dream can CONTINUE or REVISE one from a past night.
      const dreamt = dreaming ? consolidation.dream({ n: 4, seed: seen, now: now(), priorDreams: dreamHistory.slice(-4) }) : { dreamed: 0, dreams: [] };
      const review = sel.review({ tag: "sleep" });
      metabolism.restore(); // rest refills the shared energy pool
      if (viscera) viscera.rest(); // and clears the fatigue DEBT — the only thing that does
      if (endocrine) endocrine.rest(); // and eases the chronic-stress (cortisol) axis (only partly — it lingers)
      // SELF-AUTHORSHIP on rest: she reflects on how she's been feeling and, IF she holds an aspiration, nudges her OWN
      // temperament setpoints a step toward it — sleeping on it and adjusting once, not twitching every turn. No-op until
      // she (or the operator) sets an aspiration via aspire(); the identity tripwire below still guards persona/pinned facts.
      let authored = null;
      if (selfAuthorship) {
        try {
          selfAuthorship.observe("overall", organism.mood());
          authored = selfAuthorship.author({ setpoint: (n) => organism.chemSetpoint(n), setTrait: (t) => organism.setTraits(t) });
        } catch (e) { noteFault("selfAuthorship.rest", e); }
      }
      const reflection = await reflectInternal(); // crystallize the self-narrative during "sleep"
      // Open-questions: during rest, note what's been left unexplained (grounded, never answered) — feeds the `wonder` voice.
      let wondered = { added: 0 };
      if (respoolSelf) { try { wondered = await respoolSelf.update(store.list({ type: "episode" }), { turn: store.episodesEver() }); } catch (e) { noteFault("respoolSelf", e); } }
      // NM2c: consolidation/reflect may ADD to the semantic layer + evolve the self-narrative, but must NOT
      // mutate the identity core (persona + pinned user facts). If it did, flag it — that's drift, not learning.
      const identityStable = identityDigest() === idBefore;
      // Growth: record what this "sleep" actually changed, so the brain can mention it on return.
      if (growth) {
        if (res.replayed > 0) growth.record("memory", `revisited ${res.replayed} ${res.replayed === 1 ? "memory" : "memories"} in my sleep`);
        if (reflection.changed) growth.record("self", "thought again about who I am");
        if (wondered.added > 0) growth.record("self", `noticed ${wondered.added} thing${wondered.added === 1 ? "" : "s"} I don't yet understand`);
        if (dreamt.dreamed > 0) growth.record("self", "had a dream");
      }
      // Record dreams into the bounded dream HISTORY (impressions, never beliefs — not the declarative store), so
      // they can recur / be continued next night, and surface the newest as an IMPRESSION (gist, not the raw splice)
      // for the inner voice to voice "I had a dream about…". The substrate effect already happened under the gate above.
      if (dreamt.dreams && dreamt.dreams.length) {
        for (const d of dreamt.dreams) dreamHistory.push({ id: d.id, gist: d.gist, text: d.text, kind: d.kind, seedFrom: d.seedFrom, at: now() });
        if (dreamHistory.length > 8) dreamHistory = dreamHistory.slice(-8);
        const newest = dreamt.dreams[dreamt.dreams.length - 1];
        lastDream = { text: newest.gist || newest.text, freshness: 1 };
      }
      for (const fn of pluginHost.hooks.rest) { try { await fn({ app: pluginFacade }); } catch (e) { noteFault("plugin.rest", e); } } // DLC on-rest hooks (e.g. chronos closeEpoch) — before persist so their state is saved
      await persist();
      return { ...res, mistakesReplayed: mistakes.replayed, dreamed: dreamt.dreamed, kept: review.kept, reflected: reflection.changed, identityStable };
    },

    // Reflect: rewrite Rook's first-person self-narrative from lived episodes (Personhood P2a). Rest
    // folds this in; also exposed for an explicit "reflect" action. Backend-driven; never erases.
    async reflect() { const r = await reflectInternal(); if (r.changed) { if (growth) growth.record("self", "thought again about who I am"); await persist(); } return r; },
    getSelf: () => (self ? self.get() : ""),
    // The standing open-questions — what the brain has noticed but not yet understood (grounded, decaying). For UI/host.
    openQuestions: () => (respoolSelf ? respoolSelf.list() : []),
    // SELF-AUTHORSHIP control: her felt self-knowledge, and setting who she wants to become (applied a step per rest).
    selfPortrait: () => (selfAuthorship ? selfAuthorship.reflect() : { traits: [], selfPortrait: "" }),
    aspireTo: (target) => (selfAuthorship ? selfAuthorship.aspire(target) : null),
    // The bounded dream history — impressions of recent dreams (gist/text/kind/seedFrom), newest last. Never beliefs.
    dreams: () => dreamHistory.slice(),
    resolveQuestion: (text) => (respoolSelf ? respoolSelf.resolve(text) : 0),

    // Declarative consolidation: distill the LOWEST-salience episodes (nearest eviction) into durable
    // facts, so their content survives even after the raw episodes are pruned. Backend-driven.
    async distill({ limit = 8 } = {}) {
      const eps = [...store.list({ type: "episode" })].sort((a, b) => (a.salience || 0) - (b.salience || 0)).slice(0, limit);
      const facts = await distiller.distill(eps);
      // source:"model" -> down-weighted in recall (8.1 echo-chamber guard): distilled content is the
      // mouth's own output, so it must not outrank user-authored ground truth.
      for (const f of facts) await store.addFact(f.text, { tags: ["distilled", f.type], source: "model" });
      const themed = hierarchy ? await hierarchy.build() : null; // rebuild the L2 theme layer over the updated facts
      if (growth && facts.length) growth.record("knowledge", `crystallized ${facts.length} ${facts.length === 1 ? "thing" : "things"} worth keeping`);
      await persist();
      return { distilled: facts.length, themes: themed ? themed.themes : 0 };
    },

    // Ingest a DOCUMENT (backstory / world / lore / character card / article / HTML) into semantic memory as chunked
    // facts, then rebuild themes over the enlarged corpus. Deduped + idempotent (re-ingest skips). This is what makes
    // the brain user-customizable: hand it a document and it remembers + retrieves it (RAG) through the same recall.
    async ingest(text, opts = {}) {
      const r = await ingestInto(store, text, { embedder, ...opts });
      if (r.added && hierarchy) await hierarchy.build(); // themes over the new material
      await persist();
      return r;
    },

    // Rebuild the L2 theme layer on demand (also runs inside distill). Themes are stored records, so they persist.
    async buildThemes() { if (!hierarchy) return { themes: 0 }; const r = await hierarchy.build(); await persist(); return r; },
    listThemes: () => (hierarchy ? hierarchy.themes() : []),

    // Reconcile the distilled-fact set (dedupe / resolve contradictions / keep newest). Touches ONLY
    // "distilled" facts -- user-authored facts are never rewritten.
    async reconcile() {
      const distilled = store.list({ tag: "distilled" });
      if (distilled.length < 2) return { reconciled: distilled.length };
      const cleaned = await distiller.reconcile(distilled.map((f) => ({ type: (f.tags || []).find((t) => t !== "distilled") || "other", text: f.text })));
      // Write the cleaned set BEFORE removing the originals: a mid-loop failure then leaves duplicates
      // (recoverable) rather than permanently losing distilled memory (delete-before-write was unsafe).
      for (const f of cleaned) await store.addFact(f.text, { tags: ["distilled", f.type], source: "model" });
      for (const f of distilled) await store.remove(f.id);
      await persist();
      return { reconciled: cleaned.length };
    },

    exportFile: () => session.export(buildMeta()),
    async importFile(json) { let data; try { data = JSON.parse(json); } catch (e) { throw new Error(`importFile: malformed backup JSON (${e.message})`); } await storage.set(saveKey, data); return init(); },
    // Portable self: the identity + relationship + knowledge layer, app/body-agnostic, to carry between deployments.
    exportSelf: () => exportSelfBundle(app, { onFault: noteFault }),
    async importSelf(bundle) { const r = await importSelfBundle(app, bundle, { onFault: noteFault }); await persist(); return r; },
    // Mind fission/fusion: fork() takes a self bundle to spawn a parallel copy; rejoin() fuses divergent forks back
    // into THIS being — enriched by the parallel lives, identity intact. See mindMerge.js.
    fork: () => exportSelfBundle(app, { onFault: noteFault }),
    async rejoin(bundles) { const merged = mergeSelves(bundles); const r = await importSelfBundle(app, merged, { onFault: noteFault }); await persist(); return { ...r, ...merged._merge }; },
    // Guppy — the offload subroutine (assigned below, after the object exists). It fields routine turns
    // (status/lookup/tally) from local state with NO backend call; quickAsk() routes through it first and only wakes
    // the deliberative self (send) on a miss.
    async quickAsk(message, opts) { const g = await app.guppy.ask(message); if (g.handled) return { offloaded: true, ...g }; return { offloaded: false, ...(await app.send(message, opts)) }; },
    // Frame-jacking (Bobiverse): vary the cognitive clock. frameJack(f) over-clocks (f>1, deeper deliberation) or
    // dilates (f<1, cheaper) subsequent turns; frameJack("auto") lets urgency drive it per-turn; frameJack("off")
    // restores real-time. tempoState() reads it back.
    frameJack: (f) => { if (f === "auto" || f === "off" || f === "manual") mind.tempoMode(f); else mind.setTempo(f); return mind.tempoState(); },
    tempoState: () => mind.tempoState(),
    // ROAMers: one self, many bodies. Returns a hub that arbitrates the self's attention across a fleet of pluggable
    // bodies (piloting the salient one, autopiloting the rest). See roamers.js.
    roamerHub: (opts) => makeRoamerHub(app, { onFault: noteFault, ...opts }),

    // PERCEPTION INGRESS: fused body-senses from the phone (retina → optic nerve → LGN → fusion, delivered by the SW
    // bridge). The senses COMPETE in attention by their fused confidence — the operator's clearest-leads policy — so a
    // clear, corroborated body-sense can win the workspace, a lone noisy blip cannot. The winning focus + per-source
    // weights are recorded (app.senses()) for the reply / proactivity paths to read. See rook-sensory-nerve-lgn.
    perceive: (dims) => {
      try {
        const list = Array.isArray(dims) ? dims : (dims == null ? [] : [dims]);
        const cands = list.filter((d) => d && d.active).map((d) => ({
          source: "sense:" + d.dimension,
          text: d.dimension + " (" + (d.lead || "?") + (d.reinforcedBy && d.reinforcedBy.length ? "+" + d.reinforcedBy.join("+") : "") + ")",
          salience: Number(d.confidence) || 0,
          tags: ["sense", d.dimension],
        }));
        if (!cands.length) { app._senseState = { at: now(), focus: null, weights: {}, dims: [] }; return { admitted: 0, focus: null }; }
        const g = attention.gate(cands);
        app._senseState = { at: now(), focus: g.focus, weights: g.weights, dims: list };
        return { admitted: g.admitted ? g.admitted.length : 0, focus: g.focus, weights: g.weights };
      } catch (e) { return { admitted: 0, error: String((e && e.message) || e).slice(0, 200) }; }
    },
    senses: () => (app._senseState || { at: 0, focus: null, weights: {}, dims: [] }),
    save: persist,

    _internals: () => ({ organism, reflex, store, session, mind, executive, volition, procedural, temporal, regulation, imagination, council, cerebellum, theoryOfMind, attention, drives, proactivity, hierarchy, innerVoice, respoolSelf, express, growth, relationship, psyche, primal, viscera, endocrine, beliefs, vitals, eventSegment, world, director, guard, governor, kinship, verifier, configAudit, ruleEvolver, calibratedAffect, socraticCritic, engagement, voc, skills, trust, compromiseScan, mutualAttestation, beaconSilence, contextGuard, echoChamberGuard, cascadeFault, sanitizer, resilience }),
  };
  app.guppy = makeGuppy(app); // the offload organ — reads app._internals() lazily, so it binds after the object exists
  // Root 5 hardening — plugin lifecycle hooks (onInit/onTurn/onRest) receive a CAPABILITY-NARROWED facade, NOT the full app.
  // A plugin is DLC: it reacts, reads, remembers-by-proposal, and uses faculties — but it must NOT reach the core/identity/
  // persistence MUTATORS, or a plugin's init hook becomes an indirect CORE_AUTH channel (silently re-baselining the immutable
  // core, or laundering a creed/persona through the restore/import path). A denied call throws a clear capability error
  // instead of silently mutating the core. Reads + every benign method still pass straight through.
  const PLUGIN_DENIED = new Set(["commit", "setPersona", "resetCore", "restore", "importFile", "importSelf", "rejoin"]);
  const pluginFacade = new Proxy(app, {
    get(t, k) {
      if (PLUGIN_DENIED.has(k)) return () => { throw new Error(`plugin capability denied: app.${String(k)}() is not exposed to plugins (core-mutation)`); };
      return Reflect.get(t, k);
    },
  });
  app._pluginFacade = pluginFacade; // exposed for tests/introspection; the real gate is that hooks are handed this, not app
  return app;
}
