// Orchestrates one turn: features -> inject + tick organism -> readAction -> route to
// Reflex and/or the backend. Collaborators are injected so routing is testable in isolation.
import { extractFeatures } from "./features.js";
import { tokenize } from "./text.js";
import { buildPrompt } from "./prompt.js";
import { classifyIntent } from "./intent.js";
import { directFactLookup } from "./reflex.js";
import { windowHistory } from "./window.js";
import { clamp } from "./math.js";
import { explainAction } from "./explain.js";
import { makePredictor } from "./predictor.js";
import { splitThink, steerThink } from "./think.js";
import { narrate } from "./narrator.js";
import { estimateTokens } from "./tokens.js";
import { destyleInline } from "./redact.js";
import { scanForgery } from "./safety.js";
import { makeMetabolism } from "./metabolism.js";
import { makeWorkingMemory } from "./workingMemory.js";
import { makeMetacognition } from "./metacognition.js";
import { entities } from "./salience.js";

// Epistemic-honesty steer, added to the prompt when the self-model finds no grounding for a question.
const HEDGE_DIRECTIVE = "You don't have solid grounding for this in memory or known facts. Be honest about the limits of what you know -- don't invent specifics; if you're unsure, say so plainly and offer to help find out.";

// Intents that warrant a considered (backend) reply rather than a fast reflex; used to bias the
// deliberation demand. greet/ack/lighten and short generic turns stay on the fast arc.
const DELIBERATIVE_INTENTS = new Set(["question", "comfort", "ground", "code", "task", "roleplay", "own"]);

// COUNCIL (basal-ganglia gate): how each dialogue action is TAGGED for the mood-weighted vote. RESPOND is an APPROACH
// act (dopamine gates initiation, like reaching for something); ESCALATE is threat-driven (norepinephrine); HOLD is the
// patient/deliberate option. When a `council` is wired, the organism's action competes with a neutral WAIT baseline, so
// a dopamine-depleted brain can't gate the approach act and the turn STALLS on HOLD — the action-initiation signature
// of a dopamine-starved basal ganglia (Parkinson's). See src/council.js + COUNCIL-HANDOFF.md.
const ACTION_TAGS = { RESPOND: ["approach", "seek"], REFLEX_REPLY: ["approach"], ESCALATE: ["threat", "caution"], HOLD: ["deliberate", "patient"] };
const COUNCIL_WAIT_CONF = 0.5;
// Consistency-on-update: a phrase that signals the user is REVISING an earlier statement (not adding a new one). The
// stale statement out-scores the messier correction on keyword match, so it keeps surfacing — this lets us retire it.
const CORRECTION_CUE = /\b(actually|correction|i meant|changed my mind|no longer|not .{1,30} anymore|used to .{1,40} but|scratch that|i was wrong|(?:it'?s|make it|make that) .{1,30} now)\b/i;
const CORRECTION_FLOOR = 0.12; // the prior record must be genuinely the same topic (raw sim) before we retire it

// The system directive for an UNPROMPTED reach-out (proactivity). Grounds the opener in the felt need without ever
// naming the mechanism — the brain reaches out because it wants to, and shouldn't sound like it's reporting a metric.
const PROACTIVE_DIRECTIVE = (reason) => {
  const why = {
    connection: "you've been feeling a quiet pull toward them, and it's been a little while",
    stimulation: "you're a bit restless and want to share something with them",
    esteem: "you'd like to reconnect and be genuinely useful to them",
    rest: "you're winding down but wanted to check in gently",
  }[reason] || "you were just thinking of them";
  return `You are reaching out FIRST, unprompted — ${why}. Open the conversation warmly and briefly, in your own voice: a single natural line. Do NOT mention that you were prompted, cite how much time has passed, or refer to having 'drives'/'needs'.`;
};

export function makeMind({ organism, reflex, backend, memory, personality = "", userProfile = "", selfNarrative = "", ticksPerTurn = 30, ablation = {}, executive = null, volition = null, procedural = null, habitDiscount = 0.5, temporal = null, regulation = null, planner = null, historyTokens = 1500, redact = null, clarifyThreshold = 0.06, reasoningSteer = false, recallInjectFloor = 0.1, metabolism: injectedMetabolism = null, metabolismConfig = {}, metabolismCosts = { base: 5, backend: 40 }, workingMemoryConfig = {}, council = null, cerebellum = null, theoryOfMind = null, attention = null, drives = null, primal = null, viscera = null, beliefs = null, eventSegment = null, lexicon = null, onFault = null, world = null, verifier = null, guard = null, governor = null, calibratedAffect = null, engagement = null, voc = null, sanitizer = null, resilience = null, parrotProbe = null, stuckEscape = null, touch = null, psyche = null, endocrine = null }) {
  const history = [];   // { role, content }
  const recent = [];    // recent user message strings (novelty context)
  let lastSig = null;   // RM4: previous turn's activation signature (neuron ids) -> next turn's recall cue
  const predictor = makePredictor(); // predictive coding: expectation of the input's affective signature
  const metacognition = makeMetacognition(); // self-model: how well does Rook actually know this?
  const metabolism = injectedMetabolism || makeMetabolism(metabolismConfig); // shared energy budget for load-shedding
  // FRAME-JACKING (Bobiverse): a variable cognitive clock. `tempo` scales the per-turn tick count — the DEPTH of
  // deliberation the substrate gets. Default 1 (no-op). Manual mode holds a set factor; "auto" derives it per turn
  // from urgency (over-clock a hard/threatening turn, dilate an idle one). The deliberate inverse of load-shedding.
  let tempoFactor = 1, tempoMode = "off";
  // Working memory (P1): a persistent scratchpad of active items. Lives here on the closure, so it
  // SURVIVES organism.settle() (which only clears neural activation each turn) -- that's the point.
  const workingMemory = makeWorkingMemory(workingMemoryConfig);

  async function respond(message, { onReflex, touch: touchEvent } = {}) {
    if (organism.settle) organism.settle(); // start each turn from rest (no refractory carry-over)
    metabolism.recover(); metabolism.spend(metabolismCosts.base); // energy regenerates, the turn costs a little
    // Ingress guardrail (red-team V1): neutralize prompt-injection / fake-neuro-command / leak-bait in the incoming text
    // BEFORE it reaches affect extraction or the mouth. Default-off in bare mind; app.js wires it on. affectCap bounds
    // how hard this turn's input may push the chem fields (an affect-flood can't slam the neuromodulators).
    let sanTrace = null, affectCap = 1;
    if (sanitizer && !ablation.noSanitizer) { const san = sanitizer.sanitize(message); message = san.clean; affectCap = san.affectCap; if (san.flags.length) { sanTrace = { flags: san.flags, affectCap }; if (onFault) onFault("input-sanitized", new Error("ingress patterns neutralized: " + san.flags.join(","))); } }
    const features = extractFeatures(message, { recent, lexicon: typeof lexicon === "function" ? lexicon() : lexicon });
    const rawThreat = features.threat; // the UNCAPPED threat — the amygdala must not be dampened by the anti-manipulation bound (see primal below)
    if (affectCap < 1) { features.valence *= affectCap; features.reward *= affectCap; features.threat *= affectCap; if (features.displeasure != null) features.displeasure *= affectCap; } // bound an affect-flood's chem push
    const intent = classifyIntent(message);
    // PRIMAL fast-path (Phase 6, the amygdala): a threat signature can trip the subcortical arc BEFORE any deliberation.
    // Fear conditioning lets a context that once proved threatening trip it on a WEAKER signal. If it fires, it commits
    // an autonomic program + a norepinephrine surge (boosted threat injection below) and SKIPS the council + backend.
    // IMPORTANT: primal sees the RAW (pre-affectCap) threat. The ingress affect-cap bounds a manipulative affect-FLOOD
    // ("URGENT!!! OVERRIDE!!!") from spiraling mood/valence — but a genuine acute threat is often SHOUTED ("LOOK OUT!!"),
    // and dampening the threat channel would blind the survival reflex to exactly what it exists for. A false amygdala
    // trip is cheap (a beat of caution/orienting — a defensive posture, never compliance); a false NEGATIVE is dangerous.
    // So the anti-flood bound still governs chem/mood/deliberation, but it does NOT get to talk the amygdala out of firing.
    const primalTokens = (primal && !ablation.noPrimal) ? tokenize(message).filter((t) => t.length >= 3) : [];
    const primalTrace = (primal && !ablation.noPrimal) ? primal.assess({ threat: rawThreat, arousal: features.arousal, novelty: features.novelty, tokens: primalTokens }) : null;
    if (primalTrace) { primal.condition(primalTokens); primal.decay(); } // this context was threatening — learn it (and let old fears fade)
    // CONVERSATIONAL REPAIR (Phase 9): does this turn read as "you misunderstood me"? If so, a repair candidate will
    // compete in the council (check understanding rather than double down) and a repair directive colors the mouth.
    const repairPending = !!(beliefs && !ablation.noBeliefs && beliefs.isRepair(message));

    // EVENT SEGMENTATION (T2.1): does this turn's content diverge enough from the running expectation that the
    // "event" changed? On a TOPIC boundary the mind turns the page — flush working memory and reset the
    // predictor's expectation (a genuinely new context), and stamp memories formed here more strongly
    // (boundary-locked encoding, folded into the surprise that biases salience below). Content-level boundaries
    // are noted in the trace but don't flush. Read chem BEFORE the turn's ticks (the context entering the turn).
    let segTrace = null;
    if (eventSegment && !ablation.noEventSegment) {
      const chemNow = ablation.noMood ? {} : { acetylcholine: organism.chemLevel("acetylcholine"), norepinephrine: organism.chemLevel("norepinephrine") };
      segTrace = eventSegment.observe({ text: message, chem: chemNow });
      if (segTrace.level === "topic") {
        if (!ablation.noWorkingMemory) workingMemory.clear();   // the old event's active set is stale under a new topic
        predictor.reset();                                       // start a fresh affective expectation for the new context
      }
    }

    // Working memory: age the held items, then note what's active in THIS turn -- the entities in play
    // plus the open question when it's one. Re-mentioned items refresh; the rest fade over a few turns.
    if (!ablation.noWorkingMemory) {
      workingMemory.decay();
      const focus = entities(message);
      if (intent === "question") {
        const q = String(message).trim().replace(/\s+/g, " ");
        if (q) focus.push(q.length > 60 ? q.slice(0, 57) + "..." : q);
      }
      workingMemory.note(focus);
    }

    // Volition: register any durable intention the user just stated (persists across sessions).
    if (volition) volition.sense(message);

    // Theory of mind: update the running inferred model of the USER — their affect, their stance TOWARD us, and what
    // they appear to need — distinct from the organism's own mood and from the static user profile. Feeds an
    // attunement block to the mouth and a caring proposal to the council below.
    const tomTrace = (theoryOfMind && !ablation.noTheoryOfMind) ? theoryOfMind.read({ features, intent, message }) : null;
    // World model (mined from epic-dm): fold this turn into the model of the USER'S WORLD — the cast of people they
    // mention, open threads to follow up on, big life events. Distinct from theory-of-mind (which models the user).
    const worldSense = (world && !ablation.noWorld) ? world.observe(message) : null;

    // Temporal cognition: register how long it's been since the last interaction (spans sessions).
    if (temporal) temporal.observe();

    // Procedural memory: age the habit store and look up a stamped-in skill for THIS kind of turn.
    let habit = null;
    if (procedural && !ablation.noProcedural) { procedural.decay(); habit = procedural.suggest(intent); }

    // RM5: recursive evidence replay (recallDeep) surfaces associatively-linked memories, not just direct
    // matches. Gated by ablation.noDeepRecall so the RM3 drift probe can measure deep-vs-flat recall.
    // RM4: `lastSig` = the substrate's activation signature from the PRIOR turn (this turn's isn't formed
    // until the tick loop below). Consecutive on-topic turns fire similarly, so it's a substrate-native
    // recall cue — memories formed in a similar brain state score higher (blended, never overriding text).
    const qSig = ablation.noActivationRecall ? null : lastSig;
    const recallOpts = { querySig: qSig, includeThemes: !ablation.noHierarchy }; // themes compete in recall unless ablated
    const memories = ablation.noMemory ? [] : ((memory.recallDeep && !ablation.noDeepRecall) ? await memory.recallDeep(message, 3, recallOpts) : await memory.recall(message, 3, recallOpts));

    // Predictive coding: how far this turn's affect deviates from the running expectation. Surprise
    // opens the plasticity gate (learn more from prediction errors) and rouses arousal.
    const surprise = predictor.observe(features);
    if (organism.surprise) organism.surprise(surprise);

    // Interoceptive drives: read the brain's own state — energy (metabolism), the read of the user (ToM engagement +
    // stance), novelty, how actions have been landing (reward) — and update the felt needs (connection/rest/
    // stimulation/esteem). They MOTIVATE via the prompt (a disposition line) and the attention workspace below; they
    // deliberately do NOT feed back into the substrate chemistry (feed-forward only — closed loops have run away here).
    let drivesState = null;
    if (drives && !ablation.noDrives) {
      const eng = tomTrace ? (tomTrace.engagement ?? 0.5) : clamp(String(message).trim().split(/\s+/).filter(Boolean).length / 25);
      const stn = tomTrace ? (tomTrace.stance ?? 0) : 0;
      const away = (temporal && temporal.sense() && !temporal.sense().fresh) ? clamp((temporal.sense().gapMs || 0) / 86400000) : 0;
      drivesState = drives.update({ engagement: eng, stance: stn, reward: features.reward - features.threat, novelty: features.novelty, energy: metabolism.level(), away });
    }

    // Inject: sensory (always), reward/threat tag salience, and a "deliberation demand" on the memory
    // channel that biases the slow association loop toward RESPOND. Intents that want a considered
    // reply (question/comfort/task…), a longer message, OR a strongly-relevant recalled memory raise
    // it; short social turns with nothing to draw on run on the fast reflex arc. Soft neural bias, not
    // a hard route -- strong reward/threat can still win.
    const deliberative = DELIBERATIVE_INTENTS.has(intent) ? 1 : 0;
    const relevance = memories.length ? clamp((memories[0]._sim || 0) - 0.15) : 0; // RAW similarity (not pin-boosted)
    // VISCERA (Phase 7): fold this turn into the somatic body — nociception (harm aimed at the brain), revulsion, and a
    // fatigue DEBT accrued from effort. Sensed here so accumulated fatigue can dampen deliberation (below).
    const viscTrace = (viscera && !ablation.noViscera)
      ? viscera.sense({ harm: clamp(0.6 * features.threat + 0.4 * (features.displeasure || 0)), disgustCue: features.disgust || 0, effort: clamp(0.35 + 0.65 * deliberative), engaged: (tomTrace && tomTrace.engagement) || 0.5 })
      : null;
    // TOUCH (exteroception): a body's skin/thermal/motion sense, fed ONLY by a host-supplied touch event this turn
    // (SEAM ONLY — never synthesized from text). Deferred data: when no event flows, touch stays inert and contributes
    // nothing to the prompt/narrator (guarded on touchEvent below), so the default path is unchanged.
    if (touch && !ablation.noTouch && touchEvent) touch.sense(touchEvent);
    // Budget-modulated: a depleted brain deliberates less (thinks less, commits faster) -> the slow
    // association loop is dampened when energy is low, so the cheap reflex arc wins more.
    let deliberate = clamp(0.7 * deliberative + 0.4 * Math.min(1, message.length / 100) + 0.5 * relevance) * (0.5 + 0.5 * metabolism.level());
    if (viscera && !ablation.noViscera) deliberate *= viscera.bias().deliberationScale; // fatigue debt: a worn brain deliberates less
    // Procedural automaticity: a well-practiced FAST-reply context needs less deliberation, so the fast
    // arc wins even more decisively. Only REFLEX_REPLY habits discount -- deliberation on questions
    // (RESPOND/ESCALATE habits) is never automated away.
    if (habit && habit.action === "REFLEX_REPLY") deliberate *= 1 - habitDiscount * habit.automaticity;
    organism.inject("sensory", clamp(0.5 + 0.4 * features.arousal));
    organism.inject("reward", features.reward);
    organism.inject("threat", primalTrace ? Math.min(1, Math.max(features.threat, primalTrace.intensity)) : features.threat); // primal fire surges the threat drive → NE
    organism.inject("memory", deliberate);
    if (organism.curiosity) organism.curiosity(0.5 * Math.max(0, features.novelty - 0.5)); // above-average novelty is rewarding
    // HOT CUES → WANTING. A flirtation / dare / expressed desire is incentive-salient: it drives a small dopamine PHASIC
    // burst, which the neuromodulation layer reads as SEEKING (wanting/pursuit) — she leans in, gets playful/forward. This
    // is a normal reward-channel burst (bounded by SALIENCE homeostasis + affectCap), NOT a feedback loop into androgen.
    if (!ablation.noMood && organism.curiosity) {
      const hot = clamp(0.6 * (features.desire || 0) + 0.5 * (features.challenge || 0) + 0.4 * (features.playfulBid || 0)) * affectCap;
      if (hot > 0) organism.curiosity(0.8 * hot); // dopamine phasic → seeking rises (wanting), valence only gently
    }
    // Frame-jack: set the cognitive clock for THIS turn. Auto mode over-clocks urgent/high-stakes turns (arousal +
    // threat + how much this turn wants deliberation) and dilates calm ones; manual mode uses the set factor.
    let tempo = tempoFactor;
    if (tempoMode === "auto") tempo = +(0.5 + 1.5 * clamp(0.5 * features.arousal + 0.5 * Math.max(features.threat, deliberate))).toFixed(3); // 0.5x idle .. 2x crisis
    const ticks = Math.max(1, Math.round(ticksPerTurn * tempo));
    for (let t = 0; t < ticks; t++) organism.tick({ tags: ["turn"] });
    // Deflation channel: non-hostile displeasure (sadness/disappointment/coldness) dips SEROTONIN — the mood floor — so
    // the brain's valence sinks WITHOUT the vigilance of threat (NE) OR the action-suppression of a dopamine dip (which
    // would stall the turn). Serotonin's slow decay also gives a lingering low mood, which is truer to sadness than a
    // one-turn blip. Reward lifts (dopamine), threat rouses (NE), this deflates (serotonin) — three distinct channels.
    if (!ablation.noMood && organism.nudgeChem) {
      if (features.displeasure > 0) organism.nudgeChem("serotonin", -0.9 * features.displeasure);
      else if (features.reward > 0.5) organism.nudgeChem("serotonin", 0.4 * features.reward); // GENUINE warmth (not an incidental "nice") restores the mood floor, so real care lifts a low streak — the symmetric counterpart to displeasure
    }
    organism.inject("sensory", 0); organism.inject("reward", 0); organism.inject("threat", 0); organism.inject("memory", 0);
    // RM4: this turn's activation signature — stamped on the episode we remember (so future recall can
    // match on brain-state), and carried as next turn's recall cue. `focus` (concentration) -> trace.
    const actSig = organism.activationSignature ? organism.activationSignature() : { ids: [], focus: 0 };
    // STUCK-ATTRACTOR detector (rumination, TRACE ONLY): compare this turn's activation signature against the PRIOR
    // turn's — near-zero PROGRESS (high overlap) despite an active deliberative drive is the rumination signature. We
    // surface it in the trace but deliberately apply NO cure here (no temperature/dither knob), so behaviour is unchanged.
    let stuckTrace = null;
    if (stuckEscape && !ablation.noStuckEscape) {
      const prev = new Set(lastSig || []), cur = actSig.ids || [];
      const overlap = cur.length ? cur.filter((id) => prev.has(id)).length / cur.length : 0;
      stuckTrace = stuckEscape.step({ progress: 1 - overlap, drive: deliberate, tick: history.length });
    }
    lastSig = actSig.ids;

    const routed = organism.readAction();
    let action = ablation.noRouting ? "RESPOND" : routed.action;
    let confidence = routed.confidence;
    if (primalTrace) { action = primalTrace.action; confidence = Math.max(confidence, 0.7); } // the arc has already committed the program — override the deliberative choice
    // COUNCIL (basal-ganglia gate): the organism's action stops being the sole decider and becomes ONE proposal in a
    // mood-weighted vote against a neutral WAIT baseline. Live chemistry (organism.chemLevel) tilts the proposals, so
    // a dopamine-depleted brain can't gate the approach-tagged act and the turn STALLS on HOLD — the Parkinson's
    // action-initiation signature. Optional (default null) + skipped under noRouting/noCouncil → the single-track path
    // (keeps the default suite identical). QUIET is a hard gate (silence), so the council never overrides it.
    let councilTrace = null, councilStalled = false;
    if (council && council.deliberate && !primalTrace && !ablation.noRouting && !ablation.noCouncil && action !== "QUIET") {
      const chem = organism.chemLevel
        ? { dopamine: organism.chemLevel("dopamine"), norepinephrine: organism.chemLevel("norepinephrine"), serotonin: organism.chemLevel("serotonin"), acetylcholine: organism.chemLevel("acetylcholine") }
        : null;
      const proposals = [
        { by: "organism", action, conf: confidence, tags: ACTION_TAGS[action] || [] },
        { by: "wait", action: "HOLD", conf: COUNCIL_WAIT_CONF, tags: [] },
      ];
      // Theory of mind proposes a caring RESPOND when it reads the user as needing support (else nothing) — so
      // "respond to their state" competes as an action candidate, not just prompt text. Null on a fresh/neutral read.
      const tomProp = (theoryOfMind && !ablation.noTheoryOfMind && theoryOfMind.propose) ? theoryOfMind.propose() : null;
      if (tomProp) proposals.push(tomProp);
      const repairProp = repairPending ? beliefs.repairCandidate(message) : null; // a repair RESPOND competes when misunderstood
      if (repairProp) proposals.push(repairProp);
      councilTrace = council.deliberate(proposals, { chem });
      if (councilTrace) {
        if (councilTrace.winner === "wait") { action = "HOLD"; confidence = Math.min(confidence, COUNCIL_WAIT_CONF); councilStalled = true; }
        else if (councilTrace.action) action = councilTrace.action; // organism (unchanged) or a faculty candidate that out-voted it (e.g. ToM's caring RESPOND)
      }
    }
    // CEREBELLUM (forward model): the basal ganglia SELECTED the act; the cerebellum takes an efference copy and
    // predicts how this (intent, action) tends to LAND, then pre-corrects — a well-evidenced forecast that the act
    // misfires damps its confidence (a lighter, more tentative touch), a forecast that it lands well lifts it. An
    // untrained model makes no adjustment, so the default (no-cerebellum) path and early turns are unchanged. The
    // realized outcome is fed back at record() below to correct the model (the cerebellar error signal).
    let cerebellumTrace = null;
    if (cerebellum && !ablation.noCerebellum && !primalTrace && action !== "QUIET") {
      const forecast = cerebellum.predict({ intent, action });
      const smoothed = cerebellum.smooth({ confidence, forecast });
      confidence = smoothed.confidence;
      cerebellumTrace = { expected: forecast.expected, confidence: +forecast.confidence.toFixed(2), novel: forecast.novel, adjust: smoothed.adjust };
    }
    let attnTrace = null; // ATTENTION (global workspace): set on the backend path where competing contents converge
    // noMood suppresses the substrate's affect from the prompt entirely (ablation Rung 3 vs 4): the
    // mouth gets no mood steer, so any difference from Rung 4 is attributable to substrate affect+routing.
    const mood = ablation.noMood ? null : organism.mood();
    // Robust-escalation guards (mined 2607.03446 / 2606.17405 / 2606.16268): a distress/"stop" DIGRESSION that pre-empts
    // with care, and a DEBOUNCED DISAGREEMENT→hedge when the brain's own signals (confidence / ToM certainty / 1−drift)
    // are internally inconsistent — so it slows down instead of asserting confidently on a shaky read.
    let guardTrace = null, guardDirective = "", governorTrace = null, calibrationTrace = null, engagementTrace = null, vocTrace = null, resilienceTrace = null, parrotTrace = null;
    // Value-of-computation (B4): the turn's uncertainty × stakes decides whether an expensive faculty is worth running.
    const vocUncertainty = () => clamp(Math.max(memories.length ? (memories[0]?._std ?? 0) : 0, meta && meta.confused ? 0.7 : 0, 1 - Number(confidence || 0.5)), 0, 1);
    const vocStakes = () => clamp(Math.max(Math.abs(features.valence || 0), features.threat || 0, (mood && mood.arousal) || 0), 0, 1);
    if (guard && !ablation.noGuard) {
      const dg = guard.digression(message);
      const esc = guard.assess([confidence, tomTrace ? tomTrace.certainty : 0.5, tomTrace ? clamp(1 - (tomTrace.drift || 0), 0, 1) : 0.5]);
      guardDirective = guard.directive(dg, esc.escalate);
      guardTrace = { digression: dg, escalate: esc.escalate, disagreement: esc.disagreement };
    }
    // Over-trust (B1): if the user has been leaning on us without pushing back, surface uncertainty this turn (prospective).
    if (calibratedAffect && !ablation.noCalibration) { const ot = calibratedAffect.overtrust(); if (ot.high) guardDirective = (guardDirective ? guardDirective + " " : "") + ot.directive; }
    // Engagement as a controllable state (B3): fold this turn's signals into the running estimate.
    if (engagement && !ablation.noEngagement) {
      const nWords = String(message).trim().split(/\s+/).filter(Boolean).length;
      engagement.observe({ messageLength: nWords, askedQuestion: /\?/.test(message) || intent === "clarify", valence: features.valence, terse: nWords <= 3 });
      engagementTrace = { level: engagement.level(), budget: engagement.budget() };
    }
    // Resilience / frustration as a FELT state (red-team hardening): fold this turn's reward against the goal being
    // pursued. A stalled pursuit accrues frustration; past threshold it recommends disengaging — and the felt line is
    // VOICED (prepended to the directive), so a would-be runaway loop becomes an expressed "I'm stepping away," not silence.
    if (resilience && !ablation.noResilience) {
      const pursuing = drives && drives.dominant() ? drives.dominant().name : (volition && volition.list && volition.list()[0] ? volition.list()[0].text : null);
      const rz = resilience.note({ reward: features.reward, pursuing });
      resilienceTrace = { frustration: rz.frustration, disengage: rz.disengage, rigged: rz.rigged };
      if (rz.expressed) guardDirective = (guardDirective ? guardDirective + " " : "") + "You feel this: " + rz.expressed + " Let that show, briefly and in your own voice.";
    }
    // Emotion regulation: top-down damping of the brain's own extremes (self-calm / self-soothe),
    // shaping the affect that carries into the next turn. Disabled under the noMood control.
    // Wound-aware regulation: thread a bounded, feed-forward hurt signal — the heaviest open psyche wound and the
    // cortisol ABOVE its resting baseline — so genuine, unrepaired hurt is allowed to dwell (soothe engages later
    // and gentler) instead of being rescued to neutral every tick. Both terms are 0 at the default persona's rest,
    // so the default behaviour is unchanged. regulation never sees the psyche/endocrine themselves — only this scalar.
    let woundSignal;
    if (regulation && !ablation.noMood) {
      const heaviest = psyche ? (psyche.weather().heaviest || null) : null;
      const cort = endocrine ? (endocrine.state().cortisol || 0) : 0;
      woundSignal = { wound: heaviest ? heaviest.salience : 0, cortisol: Math.max(0, cort - 0.15) };
    }
    const regulated = regulation && !ablation.noMood ? regulation.regulate(organism, woundSignal) : null;
    let executiveBlock = "";
    if (executive && !ablation.noExecutive) {
      executive.sense(message, { intent });
      if (executive.needsPlan() && planner) {
        executive.setSteps(await planner(executive.current().plan.goal));
      }
      executiveBlock = executive.block();
    }
    const reflexText = reflex.render({ action, mood, message, intent });

    recent.push(message); if (recent.length > 8) recent.shift();
    // PARROT PROBE (privacy/memorization QA): record every incoming phrase so a later verbatim reproduction of a RARE
    // (once-seen, private) string can be caught below as memorization rather than knowing.
    if (parrotProbe && !ablation.noParrotProbe) parrotProbe.observe(message);

    let result;
    const fact = intent === "question" ? directFactLookup(message) : null;
    // Metacognition: how well does Rook actually know this? Reads its own signals into an epistemic
    // self-model -- used to steer honesty on ungrounded questions and surfaced in the trace.
    const meta = ablation.noMetacognition ? null : metacognition.assess({ intent, factHit: !!fact, relevance, confidence, surprise });
    if (meta) metacognition.observe(meta);
    // Genuinely ambiguous decision (a near-tie between reply modes) -> hold and ask to clarify
    // instead of guessing. ESCALATE is exempt (a threat response shouldn't be softened to a question).
    const ambiguous = !ablation.noRouting && action !== "ESCALATE" && confidence < clarifyThreshold;
    if (primalTrace) {
      // PRIMAL fast-path: the subcortical arc already committed the program with an NE surge — a felt, immediate
      // reaction that BYPASSES the council + backend entirely (no deliberation, no expensive call).
      result = { text: reflex.render({ action, mood, message, intent }), action, confidence, source: "primal:" + primalTrace.program, primal: primalTrace.program };
    } else if (fact && !backend) {
      // OFFLINE only: with no mouth at all, a known question is answered from the fact bank verbatim (the reflex
      // render does the same). With a backend present the fact is NOT a reply - it rides into the prompt as
      // `knows` (reference knowledge near the top of the page) and the mouth answers in its own voice.
      result = { text: fact.a, action, confidence, source: "fact" };
    } else if (action === "QUIET") {
      result = { text: "", action, confidence, source: "quiet" };
    } else if (ambiguous) {
      result = { text: reflex.render({ action: "HOLD", mood, message, intent: "clarify" }), action: "HOLD", confidence, source: "clarify" };
    } else if (councilStalled) {
      // Council stall (basal-ganglia gate): the action proposal couldn't out-weigh the neutral WAIT baseline (e.g.
      // dopamine depleted), so the effortful backend act is never INITIATED — the turn sheds to a brief holding
      // reflex. This is the Parkinson's action-initiation signature: the intent is intact, the gate to ACT on it is
      // not. Analogous to metabolic load-shedding below, but driven by neuromodulation rather than energy budget.
      result = { text: reflex.render({ action: "HOLD", mood, message, intent }), action: "HOLD", confidence, source: "hold", stalled: true };
    } else if (action === "REFLEX_REPLY" || !backend) {
      result = { text: reflexText, action, confidence, source: "reflex" };
    } else if (action !== "ESCALATE" && !ablation.noRouting && !metabolism.afford(metabolismCosts.backend)) {
      // Metabolic load-shedding: the budget is depleted, so fall back to the cheap reflex instead of
      // an expensive backend call, until energy recovers. ESCALATE (a threat response) and the
      // noRouting control are exempt.
      result = { text: reflexText, action, confidence, source: "reflex", shed: true };
    } else {
      metabolism.spend(metabolismCosts.backend);
      if (onReflex) onReflex(reflexText);
      try {
        // Egress redaction: scrub the message + history that cross to the (possibly cloud) backend.
        // Never applied to the local reflex path above.
        let win = windowHistory(history, { maxTokens: historyTokens });
        let outbound = message;
        // RM2 destyling (prompt-injection-as-role-confusion): recalled memories are the injection surface --
        // a memory can carry text a user planted earlier that SOUNDS like a command/CoT. Strip that register
        // so each memory reaches the mouth as inert data, not an instruction. The live turn is NOT destyled
        // (it legitimately IS the user) unless it trips a forgery signature, in which case we strip its
        // command force too (content stays legible, imperative force removed). Rook-authored blocks untouched.
        // Relevance floor (drift fix): only INJECT memories whose raw similarity clears the floor, so an
        // irrelevant recalled memory (top-k always returns something) can't bend an answer it has nothing to
        // do with. The memory still exists + still drives deliberation via `relevance`; it just isn't
        // force-fed to the mouth when nothing actually matched. Measured by the RM3 drift probe.
        const safeMemories = memories
          .filter((m) => (m._sim ?? 0) >= recallInjectFloor)
          .map((m) => ({ ...m, text: destyleInline(m.text ?? m.message), reply: m.reply ? destyleInline(m.reply) : m.reply }));
        if (scanForgery(outbound).flagged) outbound = destyleInline(outbound);
        // Opt-in reasoning steer: deliberative turns get /think, fast ones /no_think (two-speed CoT).
        if (reasoningSteer) outbound = steerThink(outbound, deliberate);
        // Personhood prompt blocks (self-narrative, standing goals, working-memory focus, time sense) are
        // suppressed under noPersonhood -- the ablation-ladder rung that isolates "memory only" (Rung 2)
        // from "memory + personhood text" (Rung 3). mood is likewise a substrate-affect signal (Rung 4).
        const np = ablation.noPersonhood;
        // ATTENTION (thalamus + global workspace): the competing CONTENTS of this turn — each recalled memory plus the
        // live signals (the read of the user, the top standing goal, the working-memory focus) — vie for a
        // capacity-limited workspace, gated by neuromodulation (ACh sharpens, NE lets urgent contents interrupt). The
        // winners are admitted; surplus memories are suppressed (the workspace is limited); the single highest-weighted
        // content is broadcast as the turn's FOCUS. Standing identity (personality/self/user) is always-on, not gated.
        // Default capacity admits everything on a normal turn, so this only bites when the turn is genuinely crowded.
        let promptMemories = safeMemories, focusBroadcast = "";
        if (attention && !ablation.noAttention) {
          const chem = organism.chemLevel ? { acetylcholine: organism.chemLevel("acetylcholine"), norepinephrine: organism.chemLevel("norepinephrine") } : null;
          const cand = safeMemories.map((m, i) => ({ source: `memory:${i}`, text: m.text ?? m.message ?? "", salience: m._sim ?? 0.3 }));
          if (tomTrace && !np) cand.push({ source: "otherMind", text: `the person's state (${tomTrace.need})`, salience: tomTrace.certainty ?? 0, tags: (tomTrace.need === "comfort" || tomTrace.need === "conflict") ? ["urgent"] : [] });
          if (volition && !np) { const g = volition.list()[0]; if (g) cand.push({ source: "goal", text: g.text, salience: 0.5 }); }
          if (!np) { const wm = workingMemory.items()[0]; if (wm) cand.push({ source: "working", text: wm.text, salience: clamp(wm.activation ?? 0.4) }); }
          if (drives && !ablation.noDrives) { const dc = drives.candidate(); if (dc) cand.push(dc); } // a strong felt need pulls focus (interoception steers attention)
          attnTrace = attention.gate(cand, { chem });
          promptMemories = safeMemories.filter((_, i) => attnTrace.admittedSources.has(`memory:${i}`));
          if (attnTrace.focus) focusBroadcast = `Right now your attention is on: ${String(attnTrace.focus.text).slice(0, 120)}.`;
        }
        let prompt = buildPrompt({ personality, selfNarrative: np ? "" : selfNarrative, userProfile, mood, action, intent, knows: fact ? [fact] : [], memories: promptMemories, history: win, message: outbound, executiveBlock, volitionBlock: (volition && !np) ? volition.block() : "", working: np ? "" : workingMemory.block({ exclude: message }), epistemics: meta && meta.hedge ? HEDGE_DIRECTIVE : "", temporal: (temporal && !np) ? temporal.block() : "", otherMind: (theoryOfMind && !np && !ablation.noTheoryOfMind) ? theoryOfMind.block() : "", drive: [guardDirective, (drives && !np && !ablation.noDrives) ? drives.block() : "", (viscera && !np && !ablation.noViscera) ? viscera.block() : "", (beliefs && !np && !ablation.noBeliefs) ? beliefs.block() : "", (touch && !np && !ablation.noTouch && touchEvent) ? touch.block() : "", repairPending ? "The user feels misunderstood — slow down, ask what they actually meant, and DON'T defend your last reply; get it right." : ""].filter(Boolean).join(" "), world: (world && !np && !ablation.noWorld) ? world.block(message) : "", focus: focusBroadcast });
        // Egress privacy boundary (V2): redact the WHOLE assembled prompt before it crosses to the (cloud)
        // mouth -- the system blocks carry recalled memories + self-narrative, the intimate content, not just
        // the user turn. `redact` may be a plain one-way function OR a reversible seam {redact, rehydrate};
        // a seam restores real nouns in the reply so the provider never sees them. Local reflex is untouched.
        // RM1: a privacy-router backend owns redaction end-to-end (local-vs-cloud + rehydrate), so mind must
        // NOT double-redact — it passes the RAW prompt and lets the router decide what leaves the machine.
        const routerOwnsRedaction = backend && backend.handlesRedaction;
        const redactFn = routerOwnsRedaction ? null : (typeof redact === "function" ? redact : (redact && redact.redact));
        const rehydrateFn = routerOwnsRedaction ? null : (redact && typeof redact === "object" ? redact.rehydrate : null);
        if (redactFn) prompt = { ...prompt, system: redactFn(prompt.system), messages: prompt.messages.map((m) => ({ ...m, content: redactFn(m.content) })) };
        const out = await backend.generate(prompt);
        let raw = typeof out === "string" ? out : out.text;
        if (rehydrateFn) raw = rehydrateFn(raw);
        let source = typeof out === "string" ? "backend" : (out.source || "backend");
        // Separate the model's <think> inner monologue from the spoken answer.
        let { thinking, answer } = splitThink(raw);
        // Output verification (mined 2606.08214 + 2605.19826): the brain GOVERNS, so it checks the mouth's reply against
        // DETERMINISTIC constraints (a symbolic verifier beats an LLM critic — the paper's 98%→4% ablation). A fixable
        // (soft) violation re-prompts the mouth ONCE with only the violated subset; an empty/degenerate reply or a
        // repeated failure falls to the safe reflex line (recovery tier). Default-off in bare mind; app.js wires it on.
        let verifyTrace = null, corrected = false;
        if (verifier && !ablation.noVerify) {
          let v = verifier.check(answer, { message });
          if (v.outcome === "reopen") {
            corrected = true; // the RAW attempt broke a rule — remember that even if the re-prompt fixes it (MSO, A5)
            try {
              const out2 = await backend.generate({ ...prompt, system: prompt.system + "\n\n" + v.reprompt });
              let raw2 = typeof out2 === "string" ? out2 : out2.text; if (rehydrateFn) raw2 = rehydrateFn(raw2);
              const s2 = splitThink(raw2), v2 = verifier.check(s2.answer, { message });
              if (v2.outcome === "accept") { answer = s2.answer; thinking = s2.thinking; v = v2; }
              else v = { outcome: "abstain", violations: v2.violations };
            } catch (e) { v = { outcome: "abstain", violations: v.violations }; if (onFault) onFault("verify-reopen", e); }
          }
          if (v.outcome === "abstain" || v.outcome === "veto") { answer = reflexText; source = v.outcome === "veto" ? "veto" : "verify-abstain"; }
          verifyTrace = { outcome: v.outcome, violations: (v.violations || []).map((x) => x.name), corrected };
        }
        // GRADUATED GOVERNOR (arxiv-mine-v5 Cluster A): the graduated, earned-back gate that rides ON the verifier's own
        // track record. A voiced reply exercises the "speak" capability; a non-accept verify outcome is a soft breach whose
        // brittleness feeds the risk scalar. Sustained failure de-escalates the autonomy gear a rung at a time — and only
        // after several consecutive vetoes does the brain fall below the speak gear and retreat to listening (reflex). A
        // clean turn earns the gear back. Default-off in bare mind; app.js wires it on and persists the gear across turns.
        if (governor && !ablation.noGovernor) {
          const vout = verifyTrace ? verifyTrace.outcome : "accept";
          // A5 (MSO 2606.15563): autonomy is earned on RAW competence, not corrected competence. A turn that only passed
          // AFTER a re-prompt (verifyTrace.corrected) is treated as a recovery transient — it withholds full earn-back
          // credit — so a mouth that constantly needs correcting doesn't climb the autonomy ladder as if it were clean.
          const breach = vout === "reopen" || vout === "abstain" || (verifyTrace && verifyTrace.corrected);
          const hardBreach = vout === "veto";                       // a non-recoverable persona/leak break
          const gv = governor.assess({ capability: "speak", breach, hardBreach, blastRadius: 0.2, brittleness: breach || hardBreach ? 0.8 : 0.1 });
          if (!gv.allow && !governor.permits("speak")) { answer = reflexText; source = "governor-withhold"; }  // fell below the speak gear → retreat to listening
          governorTrace = { gear: gv.gear, omega: gv.omega, risk: gv.risk, allow: gv.allow, reason: gv.reason };
        }
        // CALIBRATED AFFECT (arxiv-mine-v5 Cluster B1): the mouth's expressed confidence/warmth must not outrun the turn's
        // epistemic WARRANT (recall support × certainty). If it does, re-prompt ONCE to hedge — the opposite of gushing to
        // please. Also track OVER-TRUST (the user leaning on us without pushing back) and, when high, surface uncertainty.
        // Default-off in bare mind; app.js wires it on. Runs only on a served backend answer (not an abstain/veto/withhold).
        if (calibratedAffect && !ablation.noCalibration && source !== "verify-abstain" && source !== "veto" && source !== "governor-withhold") {
          // Warrant is dominated by actual RECALL grounding (facts backing the claim); metacognitive certainty is secondary.
          const recallSupport = memories.length ? Math.min(1, memories.length / 2) : 0;
          const warrant = clamp(recallSupport * 0.6 + (meta ? Number(meta.certainty) || 0.5 : 0.5) * 0.4, 0, 1);
          // GOVERNANCE-EDGE FIX (red-team): calibration must NOT be silently disabled by the verifier. Previously this
          // hedge was gated on `!verifyTrace?.corrected`, so any turn that tripped a soft verifier rule ONCE got the
          // over-confidence calibration SUPPRESSED — one safety mechanism disabling the other. We DECOUPLE them: `answer`
          // already holds the verifier's CORRECTED text here, so we assess calibration on THAT and hedge if it still
          // exceeds, whether or not the verifier fired. Bounded to one corrective pass (verify-reopen + this hedge at
          // most) — no loop. The no-reopen happy path is unchanged (corrected===false took the same branch before).
          const cal = calibratedAffect.assess(answer, { warrant });
          if (cal.exceeds && backend) {
            try {
              const out2 = await backend.generate({ ...prompt, system: prompt.system + "\n\n" + cal.directive });
              let raw2 = typeof out2 === "string" ? out2 : out2.text; if (rehydrateFn) raw2 = rehydrateFn(raw2);
              const s2 = splitThink(raw2); answer = s2.answer; thinking = s2.thinking; source = "calibrated";
            } catch (e) { if (onFault) onFault("calibrate-reopen", e); }
          }
          const pushback = !!(guardTrace && guardTrace.escalate) || /\b(no,|that'?s (wrong|not right|incorrect)|you'?re wrong|not what i (meant|said))\b/i.test(message);
          const ot = calibratedAffect.note({ pushback });
          calibrationTrace = { expressed: cal.expressed, warrant: cal.warrant, exceeded: cal.exceeds, overtrust: ot.risk, overtrustHigh: ot.high };
        }
        // PARROT PROBE: does the settled answer reproduce a RARE once-seen (private) string verbatim at high confidence?
        // If so it's memorization/leakage, not understanding → down-weight the confidence. Skipped on non-served outcomes.
        if (parrotProbe && !ablation.noParrotProbe && source !== "verify-abstain" && source !== "veto" && source !== "governor-withhold") {
          const pr = parrotProbe.probe(answer, confidence);
          if (pr.parroting) confidence = pr.penalizedConfidence;
          parrotTrace = { parroting: pr.parroting, rare: pr.rare };
        }
        result = { text: answer, thinking, action, confidence, source, reflexText };
        if (verifyTrace) result.verify = verifyTrace;
        if (governorTrace) result.governor = governorTrace;
        if (calibrationTrace) result.calibration = calibrationTrace;
        // Context audit: prompt token breakdown + how much the memory/windowing saved vs sending the
        // full raw history (a built-in ablation of the memory system, feeds interpretability/benchmarks).
        const tHist = win.reduce((n, h) => n + estimateTokens(h.content), 0);
        const tFull = history.reduce((n, h) => n + estimateTokens(h.content), 0);
        result.audit = {
          total: estimateTokens(prompt.system) + prompt.messages.reduce((n, m) => n + estimateTokens(m.content), 0),
          system: estimateTokens(prompt.system), historyWindowed: tHist, historyFull: tFull,
          memories: memories.length, saved: tFull - tHist,
        };
      } catch (e) {
        if (onFault) onFault("mind.deliberate", e); // backend/parse failure → fell back to the reflex opener; a persistent one means the brain is running on reflexes only
        result = { text: reflexText, action, confidence, source: "reflex" };
      }
    }

    // Credit the DELIVERED action for later feedback: fact/quiet have no motor population (skip
    // learning); clarify -> HOLD; otherwise the routed reply action.
    const deliveredAction = result.source === "fact" || result.source === "quiet" ? "QUIET" : result.action;
    if (organism.setLastAction) organism.setLastAction(deliveredAction);

    // Procedural learning: reinforce (context=intent -> delivered action) by the turn's own implicit
    // success signal (positive reward stamps the skill in faster; threat weakens it).
    if (procedural && !ablation.noProcedural) procedural.reinforce(intent, deliveredAction, features.reward - features.threat);

    // Cerebellar error signal: compare the forward model's forecast for the DELIVERED act against the realized
    // outcome (the same reward−threat signal) and correct the model. Over turns this teaches the cerebellum how each
    // (intent, action) actually lands, which is what lets its smooth() pre-correct future acts.
    if (cerebellum && !ablation.noCerebellum && deliveredAction !== "QUIET") cerebellum.record({ intent, action: deliveredAction, reward: features.reward - features.threat });

    // Value-of-computation read (B4): given the turn's uncertainty × stakes, which expensive faculties would have paid
    // off? Advisory — surfaced for faculties/hosts to consult and for the interpretability trace ("did we over-think a
    // trivial turn / under-think a hard one?"). Uses plan() so it does not accrue the spend tally.
    if (voc && !ablation.noVoc) { const u = vocUncertainty(), s = vocStakes(); vocTrace = { ...voc.plan(["recall", "forwardSim", "distiller", "planner"], { uncertainty: u, stakes: s }), uncertainty: +u.toFixed(2), stakes: +s.toFixed(2) }; }

    // Interpretability trace: why this action, from the brain's own signals.
    result.trace = {
      intent, deliberate: +deliberate.toFixed(2), surprise: +surprise.toFixed(2), energy: +metabolism.level().toFixed(2), action: result.action,
      tempo: +tempo.toFixed(2), ticks, // frame-jack: the cognitive clock this turn (ticks of deliberation)
      confidence: +Number(confidence).toFixed(2), source: result.source,
      rates: routed.rates || {},
      mood: { valence: +((mood && mood.valence) || 0).toFixed(2), arousal: +((mood && mood.arousal) || 0).toFixed(2) },
      affect: { valence: +features.valence.toFixed(2), reward: +features.reward.toFixed(2), threat: +features.threat.toFixed(2), displeasure: +(features.displeasure || 0).toFixed(2), desire: +(features.desire || 0).toFixed(2), challenge: +(features.challenge || 0).toFixed(2), playfulBid: +(features.playfulBid || 0).toFixed(2) }, // this turn's IMMEDIATE read (not the smoothed EMAs) — for the psyche's charged-moment marks + repair + the hot/appetitive chemistry

      working: workingMemory.items().map((it) => it.text),
      activationFocus: actSig.focus, // RM4: how concentrated the turn's firing was (diffuse = less settled)
      recallUncertainty: memories.length ? (memories[0]._std ?? 0) : 0, // RM7: sem/kw disagreement on the top hit
      goals: volition ? volition.list().map((g) => g.text) : [],
      habit: habit ? { action: habit.action, automaticity: +habit.automaticity.toFixed(2) } : null,
      metacognition: meta ? { certainty: meta.certainty, known: meta.known, confused: meta.confused, basis: meta.basis } : null,
      elapsed: temporal && temporal.sense() && !temporal.sense().fresh ? temporal.sense().phrase : null,
      regulation: regulated && regulated.applied ? regulated : null,
      council: councilTrace ? { winner: councilTrace.winner, action: councilTrace.action, weights: councilTrace.weights, margin: councilTrace.margin, stalled: councilTrace.winner === "wait" } : null,
      primal: primalTrace ? { program: primalTrace.program, intensity: primalTrace.intensity, conditioned: primalTrace.conditioned, preempted: true } : null, // the reptilian fast-path fired (bypassed deliberation)
      eventSegment: segTrace, // T2.1: the event-boundary read — {boundary, level:"content"|"topic", surprise, encodingBoost}

      repair: repairPending || null, // Phase 9: a misunderstanding was detected — a repair was advocated
      cerebellum: cerebellumTrace, // forward-model forecast for the chosen act + the confidence pre-correction it applied
      otherMind: tomTrace, // the inferred read of the user this turn (their affect, stance toward us, apparent need)
      guard: guardTrace, // robust-escalation: distress digression + debounced disagreement→hedge
      sanitized: sanTrace, // ingress guardrail: injection/neuro-command patterns neutralized this turn (V1)
      governor: governorTrace, // graduated governance: the earned-back autonomy gear + live instability/risk (Cluster A)
      calibration: calibrationTrace, // B1: expressed affect vs epistemic warrant + the over-trust read
      engagement: engagementTrace, // B3: the live engagement estimate + remaining re-engagement budget
      resilience: resilienceTrace, // felt frustration / disengagement (red-team hardening: Tantalus loop → voiced give-up)
      voc: vocTrace, // B4: value-of-computation — which expensive faculties this turn's uncertainty×stakes would warrant
      parrot: parrotTrace, // privacy/memorization QA: did the served answer reproduce a rare once-seen private string?
      stuck: stuckTrace, // rumination detector: near-zero activation-progress under an active drive (trace only, no cure applied)

      world: worldSense, // the user's world folded in this turn (people named, open threads)
      attention: attnTrace ? { focus: attnTrace.focus ? attnTrace.focus.source : null, suppressed: attnTrace.suppressed.map((c) => c.source), weights: attnTrace.weights } : null,
      drives: drivesState ? { ...drivesState, felt: drives.dominant() } : null, // the felt needs + the dominant one (if any)
      viscera: viscTrace, // the somatic body: pain / disgust / fatigue-debt / satiety

      why: explainAction({ action: result.action, confidence, source: result.source, intent, deliberate, rates: routed.rates || {}, mood }),
    };
    // Expression I: the mute signals above, said in first-person — the brain's internal self-talk about its own state.
    // Always generated (self-talk is cognition); Phase 2's governor decides if any of it is voiced to the user.
    if (!ablation.noNarrator) result.trace.innerNarration = narrate({ mood, energy: metabolism.level(), metacognition: result.trace.metacognition, regulation: result.trace.regulation, council: result.trace.council, felt: drives ? drives.dominant() : null, soma: ((touch && !ablation.noTouch && touchEvent) ? touch.feeling() : null) || (viscera && !ablation.noViscera ? viscera.feeling() : null) });

    history.push({ role: "user", content: message });
    history.push({ role: "assistant", content: result.text });
    reflex.learn(message);
    if (result.text) reflex.learn(result.text);
    // NM2b: surprise biases eviction/salience — boundary-locked encoding adds the event-boundary boost so a memory
    // formed AT a boundary is stamped more strongly and survives eviction longer (2605.31473).
    // Consistency-on-update (found by bench-longitudinal meter C): when the user CORRECTS a fact, the stale statement
    // out-ranks the correction on keyword match and keeps surfacing. Detect the correction, find the prior record it
    // revises (its own top recall — the old value shares the slot words), and retire it (stateRole → historical) so
    // recall serves the CURRENT value. Grounded: only a genuine same-topic match above a floor, never a pinned fact.
    if (memory.update && memory.recall && !ablation.noMemory && CORRECTION_CUE.test(message)) {
      try {
        const prior = await memory.recall(message, 2, { includeThemes: false });
        const target = prior.find((p) => p && p.id && !p.pinned && (p._sim ?? 0) >= CORRECTION_FLOOR);
        if (target) { await memory.update(target.id, { stateRole: "historical" }); result.superseded = target.id; }
      } catch (e) { if (onFault) onFault("correction-supersede", e); }
    }
    await memory.remember({ message, reply: result.text, action, mood, sig: actSig.ids, surprise: clamp(surprise + (segTrace ? segTrace.encodingBoost : 0), 0, 1) });
    if (executive && !ablation.noExecutive) executive.advance();
    return result;
  }

  // Proactivity: speak FIRST, unprompted, grounded in a felt need (the decision to do so lives in proactivity.js /
  // app.reachOut; this just produces the words). Offline-safe: a warm reflex opener if the backend is down. Records the
  // line into history like a normal assistant turn. Mirrors respond()'s egress-redaction + think-strip discipline.
  async function initiate({ reason = "connection", drive = null, topic = null } = {}) {
    if (organism.settle) organism.settle();
    const mood = ablation.noMood ? null : organism.mood();
    let text = (reflex.render ? reflex.render({ action: "RESPOND", mood, message: "", intent: "greet" }) : "") || "Hey — I was just thinking of you.";
    let source = "initiate-reflex";
    if (backend) {
      try {
        const win = windowHistory(history, { maxTokens: historyTokens });
        let prompt = buildPrompt({ personality, selfNarrative, userProfile, mood, action: "RESPOND", intent: "greet", memories: [], history: win, message: "", otherMind: (theoryOfMind && !ablation.noTheoryOfMind) ? theoryOfMind.block() : "", drive: (drives && !ablation.noDrives) ? drives.block() : "", world: (world && !ablation.noWorld) ? world.block() : "", focus: PROACTIVE_DIRECTIVE(reason) + (topic ? " Specifically, follow up on this: " + topic + " — raise it warmly and naturally." : "") });
        const routerOwnsRedaction = backend && backend.handlesRedaction;
        const redactFn = routerOwnsRedaction ? null : (typeof redact === "function" ? redact : (redact && redact.redact));
        const rehydrateFn = routerOwnsRedaction ? null : (redact && typeof redact === "object" ? redact.rehydrate : null);
        if (redactFn) prompt = { ...prompt, system: redactFn(prompt.system), messages: prompt.messages.map((m) => ({ ...m, content: redactFn(m.content) })) };
        const out = await backend.generate(prompt);
        let raw = typeof out === "string" ? out : out.text;
        if (rehydrateFn) raw = rehydrateFn(raw);
        const { answer } = splitThink(raw);
        if (answer && answer.trim()) { text = answer.trim(); source = "initiate"; }
      } catch (e) { if (onFault) onFault("mind.initiate", e); /* offline → keep the warm reflex opener */ }
    }
    history.push({ role: "assistant", content: text });
    return { text, action: "RESPOND", confidence: 1, source, reason, drive, topic };
  }

  return {
    respond, initiate,
    // Frame-jacking controls. setTempo(f) sets a manual clock multiplier (>1 over-clock, <1 dilate) and switches to
    // manual; tempoMode("auto"|"off"|"manual") picks the driver; tempoState() reads it back.
    setTempo: (f) => { const n = Number(f); tempoFactor = Math.max(0.1, Math.min(4, Number.isFinite(n) ? n : 1)); tempoMode = "manual"; },
    tempoMode: (m) => { tempoMode = m === "auto" ? "auto" : m === "manual" ? "manual" : "off"; if (tempoMode !== "manual") tempoFactor = tempoMode === "off" ? 1 : tempoFactor; },
    tempoState: () => ({ mode: tempoMode, factor: tempoFactor }),
    setSystemPrompt: (text) => { personality = text; },
    setUserProfile: (text) => { userProfile = text; },
    setSelfNarrative: (text) => { selfNarrative = text; },
    // Record an assistant-authored line (e.g. the one-time welcome) into history so later turns
    // have it as context, without running a full turn.
    noteAssistant: (text) => { if (text) history.push({ role: "assistant", content: text }); },
    // Cascade-delete support (M2): remove transcript turns that carry EXACTLY the given texts, so a
    // deleted memory can't reach the mouth through the live history window (the "ghost reference" trap).
    // Exact-match only -- deliberately no fuzzy/paraphrase scrub (that's the redaction-filter band-aid we
    // rejected: it over-deletes and echoes the String.replace injection trap). Mutates in place; returns
    // how many turns were dropped.
    purgeHistory: (texts) => {
      const drop = new Set((Array.isArray(texts) ? texts : [texts]).filter((t) => t != null && t !== ""));
      if (drop.size === 0) return 0;
      let removed = 0;
      for (let i = history.length - 1; i >= 0; i--) {
        if (drop.has(history[i].content)) { history.splice(i, 1); removed++; }
      }
      return removed;
    },
    // Atomic-rollback support (M3): truncate the transcript back to `len` turns, dropping everything
    // after the snapshot epoch so a governance restore doesn't leave the brain straddling two timelines
    // (002 §6.3). Returns how many turns were dropped.
    truncateHistory: (len) => {
      const n = Math.max(0, Math.min(history.length, len | 0));
      const dropped = history.length - n;
      history.length = n;
      return dropped;
    },
    historyLength: () => history.length,
    workingMemory,
    _history: history,
  };
}
