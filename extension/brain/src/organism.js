// Composition root: builds a wired brain (network + connectome) with the neuromodulation
// field, indexed gated STDP, governance, and the codec. Exposes inject / readAction / tick /
// mood and governance passthrough. Supersedes brain.js as the top-level object.
import { makeNetwork } from "./network.js";
import { makeNeuromodulation, CHEMICALS, DEFAULT_SETPOINTS } from "./neuromodulation.js";
import { makeLedger, makeStdp } from "./plasticity.js";
import { makeGovernance } from "./governance.js";
import { buildConnectome } from "./connectome.js";
import { makeCodec } from "./codec.js";
import { makeRng } from "./rng.js";
import { clamp } from "./math.js";

// Per-spike salience→neuromodulator burst magnitude (see the reward/threat bursts in tick()). Named so the two lines
// share one source and the "was 0.2, now 0.12" history has a single home.
const SALIENCE_BURST = 0.12;

export function makeOrganism({
  seed = 1, maxDelay = 8, noiseStd = 0, personality = {}, sizes = {}, ablation = {},
  feedbackPunishScale = 0.5,
  // Context-gated credit: criticism of an action whose justifying context is genuinely active is
  // discounted, so a contextually-correct response (e.g. ESCALATE during a real threat) is not
  // trained away by user annoyance. Map of action -> the chemical that justifies it.
  contextGate = { ESCALATE: "norepinephrine" }, contextGateScale = 1.0,
  // Tonic-setpoint neuromodulation of behaviour (driven from setpoints, not phasic level, to avoid
  // feedback runaway). Norepinephrine -> neuron gain + noise (arousal raises excitability + jitter).
  // Acetylcholine -> attention/SNR (raises gain on signal, LOWERS noise -> a "focused" persona is
  // sharper). Serotonin -> behavioural inhibition via NEGATIVE gain (a "calm/patient" persona is less
  // excitable, so weak input doesn't trigger a reaction; "irritable" is more reactive). All default
  // to no-op at the reference setpoints, so a default persona behaves exactly as before.
  // Gain leverage bumped (chemistry harness finding): the tonic-setpoint gain effect was too weak to
  // tip routing at production noise. These are INERT at the reference setpoints (gain = 1 for the
  // default persona), so raising them amplifies persona deviations WITHOUT changing default behaviour.
  // Gain references default to the shared DEFAULT_SETPOINTS so the "inert at the default persona"
  // guarantee (gain = 1) can't silently break if a default setpoint is retuned in one place.
  gainK = 0.7, gainRef = DEFAULT_SETPOINTS.norepinephrine, gainMin = 0.6, gainMax = 1.8, noiseK = 0.6,
  achGainK = 0.55, achNoiseK = 0.5, achRef = DEFAULT_SETPOINTS.acetylcholine, seroGainK = 0.8, seroRef = DEFAULT_SETPOINTS.serotonin,
} = {}) {
  const net = makeNetwork({ seed, maxDelay, noiseStd });
  const conn = buildConnectome(net, makeRng(seed * 7 + 1), { sizes }); // dedicated wiring rng
  const chem = makeNeuromodulation(personality);
  const ledger = makeLedger();
  const stdp = makeStdp({ synapses: net._synapses, incoming: net._incoming, outgoing: net._outgoing, ledger });
  const gov = makeGovernance({ synapses: net._synapses, ledger });
  const codec = makeCodec({ channels: conn.channels, actions: conn.actions });

  const rewardSet = new Set(conn.channels.reward);
  const threatSet = new Set(conn.channels.threat);
  let clock = 0;
  let lastAction = "QUIET"; // the most recently read action -> feedback credits its pathway
  // RM4: per-turn spike accumulator -> an activation SIGNATURE (which neurons fired, how concentrated).
  // A second, substrate-native recall key: a memory stamped with the signature it was formed under can be
  // retrieved by how similarly the brain is firing NOW, not just by text similarity. Reset on settle().
  const spikeAccum = new Map(); // neuronId -> spike count since last settle
  // Excitatory / inhibitory neuron partition (union over the region genome) — for the chronic-stress E/I lesion
  // and E/I-balance diagnostics. Built once; every neuron belongs to exactly one base region.
  const EXC = new Set(), INH = new Set();
  for (const r of Object.values(conn.regions)) { for (const id of r.excitatory) EXC.add(id); for (const id of r.inhibitory) INH.add(id); }

  return {
    ledger,
    regions: conn.regions,
    channels: conn.channels,
    actions: conn.actions,

    inject: (name, value) => codec.inject(name, value),
    readAction: () => { const r = codec.readAction(); lastAction = r.action; return r; },
    // Let the host correct which action feedback credits (mind may remap the routed action to HOLD/
    // clarify, or short-circuit to a fact) so a thumbs-up/down attenuates the pathway that actually
    // produced the reply, not the raw winner-take-all winner.
    setLastAction: (a) => { lastAction = a; },
    // Settle transient activation between turns: neurons back to rest, in-flight currents + action
    // rates cleared, and STDP eligibility traces zeroed so a turn's spike timing doesn't leak into
    // the next turn's learning/feedback. Weights, chemistry (mood), ledger and clock are preserved.
    // Fixes the every-other-turn refractory collapse observed on the persistent (live) organism.
    settle: () => { net.resetActivation(); codec.reset(); stdp.clearTraces(); spikeAccum.clear(); },
    // RM4: the current turn's activation signature — the most-active neurons (a sparse fingerprint) plus a
    // `focus` concentration score (high = a few neurons carry the firing; low = diffuse). Reset by settle().
    activationSignature: ({ top = 24 } = {}) => {
      const entries = [...spikeAccum.entries()].sort((a, b) => b[1] - a[1]);
      const total = entries.reduce((s, [, c]) => s + c, 0);
      const topEntries = entries.slice(0, top);
      const topMass = topEntries.reduce((s, [, c]) => s + c, 0);
      return { ids: topEntries.map(([id]) => id), focus: total ? +(topMass / total).toFixed(3) : 0, active: entries.length };
    },
    // Dense per-neuron activation vector (spike counts since the last settle) — the FULL population response a
    // representational-similarity probe needs (activationSignature is the sparse top-k view of the same data).
    populationVector: () => { const v = new Array(net.neuronCount).fill(0); for (const [id, c] of spikeAccum) v[id] = c; return v; },
    // The substrate as a weighted directed graph (source→target, signed weight) — for weight-geometry diagnostics.
    weightGraph: () => ({ n: net.neuronCount, edges: net._synapses.map((s) => [s.source, s.target, s.weight]) }),
    // The excitatory / inhibitory neuron partition (for E/I-balance diagnostics).
    neuronClasses: () => ({ excitatory: [...EXC], inhibitory: [...INH] }),
    // Chronic-stress E/I lesion (2606.27529): scale inhibitory→excitatory synapses by (1+delta). An inhibitory
    // source (negative weight) onto an EXCITATORY target — strengthening it (delta>0) deepens inhibitory
    // dominance + excitatory hypofunction, the chronic-stress circuit signature. Structural, NOT chemical (so
    // it's a distinct disorders-lab channel from the neuromodulator lesions); reversible via snapshot/restore or
    // by re-applying the inverse. Returns {affected, meanBefore, meanAfter}.
    lesionIE: (delta = 0) => {
      let affected = 0, sumB = 0, sumA = 0;
      for (const s of net._synapses) {
        if (s.weight < 0 && EXC.has(s.target)) { sumB += s.weight; s.weight *= (1 + delta); sumA += s.weight; affected++; }
      }
      return { affected, meanBefore: affected ? +(sumB / affected).toFixed(4) : 0, meanAfter: affected ? +(sumA / affected).toFixed(4) : 0 };
    },
    mood: () => chem.readout(),
    // Top-down regulation hook (Personhood P6): apply a corrective delta to a chemical's phasic level
    // and fold it in immediately, so a prefrontal-style controller can actively damp its own affect
    // (self-calm / self-soothe) rather than only waiting for passive homeostatic decay.
    nudgeChem: (name, delta) => { if (!ablation.noMood) { chem.burst(name, delta); chem.tick(); } },
    chemLevel: (name) => chem.level(name),
    chemSetpoint: (name) => chem.setpoint(name),
    setTraits: (traits) => chem.setTrait(traits),
    // Intrinsic curiosity: novelty is mildly rewarding -> a small dopamine burst (applied on the next
    // tick) that opens the plasticity gate (learn more from novel input) and lifts valence.
    curiosity: (mag = 1) => { if (!ablation.noMood) chem.burst(CHEMICALS.DOPAMINE, mag); },
    // Predictive-coding surprise: an unexpected turn opens the plasticity gate (dopamine -> learn more
    // from prediction errors) AND rouses arousal (norepinephrine -> attend). Applied before the turn's
    // ticks so learning is elevated during them.
    surprise: (mag = 1) => {
      if (ablation.noMood) return;
      chem.burst(CHEMICALS.DOPAMINE, 0.6 * mag);
      chem.burst(CHEMICALS.NOREPINEPHRINE, 0.3 * mag);
    },
    // Feedback as a real chemical event AND a learning signal. Credit is LOCALIZED to the action
    // that was actually chosen (its decision-layer population), so criticising one response
    // REDIRECTS the brain to another action rather than collapsing general responsiveness into
    // silence (the "death-vs-taxes" trap). The economy is ASYMMETRIC -- punishment is scaled down
    // by feedbackPunishScale so praise can recover a pathway faster than criticism suppresses it.
    // Praise -> dopamine burst + amplify the chosen pathway; criticism -> norepinephrine burst +
    // dopamine dip + attenuate it. Pass { action } to credit a specific action; defaults to the
    // last one read. The chemistry sets mood; stdp.modulate does the trace-based credit assignment.
    feedback: (kind, mag = 1, { action } = {}) => {
      const target = action || lastAction;
      const targets = conn.actions[target] || null; // localize to the chosen action's neurons
      // No valid target population (e.g. the action was QUIET) -> apply the mood event but skip
      // learning. Crediting "saying nothing" to a pathway has no meaning, and a global fallback
      // would nuke the shared upstream and collapse all responsiveness.
      if (kind === "up" || kind === "positive") {
        chem.burst(CHEMICALS.DOPAMINE, mag);
        if (targets && !ablation.noLearning) stdp.modulate(+1, mag, { tags: ["feedback", "up"], timestamp: clock, targets });   // noLearning gates the FEEDBACK-credit path too (not just the dopamine-STDP gate) so ablating learning stops all weight change + ledger growth — the chem/mood burst above still fires
      } else if (kind === "down" || kind === "negative") {
        // Context-gated penalty: discount criticism of an action whose justifying context is active
        // (e.g. ESCALATE while norepinephrine/threat is elevated) so a contextually-correct response
        // is not unlearned. Read chem BEFORE the bursts below (burst only sets phasic; level updates
        // on tick), so justification reflects the just-finished turn, not this feedback event.
        let scale = feedbackPunishScale;
        const justChem = contextGate[target];
        if (justChem && targets) {
          const j = clamp((chem.level(justChem) - chem.setpoint(justChem)) / contextGateScale);
          scale *= (1 - j);
        }
        chem.burst(CHEMICALS.NOREPINEPHRINE, mag);
        chem.burst(CHEMICALS.DOPAMINE, -0.5 * mag); // aversion: a dopamine dip accompanies the alarm
        if (targets && !ablation.noLearning) stdp.modulate(-1, mag * scale, { tags: ["feedback", "down"], timestamp: clock, targets });   // noLearning also gates the criticism-credit path
      }
      chem.tick();
    },

    // noLearn forces the plasticity gate shut for this tick -- for READ-ONLY probes (fitness measurement,
    // imagination rehearsal, the chem harness) that must not stamp weight changes into the network.
    tick({ tags = [], noLearn = false } = {}) {
      if (!ablation.noMood) chem.tick();
      // TONIC neuromodulation of gain + noise (from setpoints = personality traits, not phasic level:
      // shifts baseline behaviour without a firing->chem->gain runaway; default setpoints -> no-op).
      // Norepinephrine raises gain + noise (arousal); acetylcholine raises gain but LOWERS noise (a
      // focused brain is more excitable AND sharper). Disabled under noMood for a clean control.
      let gain = 1, noiseScale = 1;
      if (!ablation.noMood) {
        const ne = chem.setpoint(CHEMICALS.NOREPINEPHRINE) - gainRef;
        const ach = chem.setpoint(CHEMICALS.ACETYLCHOLINE) - achRef;
        const sero = chem.setpoint(CHEMICALS.SEROTONIN) - seroRef;
        gain = Math.max(gainMin, Math.min(gainMax, 1 + gainK * ne + achGainK * ach - seroGainK * sero));
        noiseScale = Math.max(0, 1 + noiseK * ne - achNoiseK * ach);
      }
      const spiked = net.tick(codec.driveInputs(), { gain, noiseScale });
      codec.observe(spiked);
      for (const id of spiked) spikeAccum.set(id, (spikeAccum.get(id) || 0) + 1); // RM4 activation signature

      // Salience drives chemistry: reward sub-pop -> dopamine, threat sub-pop -> norepinephrine.
      if (!ablation.noMood) {
        let rewardFire = 0, threatFire = 0;
        for (const id of spiked) {
          if (rewardSet.has(id)) rewardFire++;
          if (threatSet.has(id)) threatFire++;
        }
        // per-spike salience→neuromodulator burst. Was 0.2 — reward bursts ratcheted dopamine into tanh saturation
        // (valence pinned +1, deaf to later criticism); the gentler 0.12 climb keeps valence in a resolvable range.
        // One constant so the reward/threat gains can't drift apart across the two lines.
        if (rewardFire > 0) chem.burst(CHEMICALS.DOPAMINE, rewardFire * SALIENCE_BURST);
        if (threatFire > 0) chem.burst(CHEMICALS.NOREPINEPHRINE, threatFire * SALIENCE_BURST);
      }

      stdp.observeSpikes(spiked, {
        gate: (ablation.noLearning || noLearn) ? 0 : chem.plasticityGate(),
        chemState: {
          dopamine: chem.level(CHEMICALS.DOPAMINE),
          norepinephrine: chem.level(CHEMICALS.NOREPINEPHRINE),
          serotonin: chem.level(CHEMICALS.SEROTONIN),
          acetylcholine: chem.level(CHEMICALS.ACETYLCHOLINE),
        },
        timestamp: clock++,
        tags,
      });
      return spiked;
    },

    captureBaseline: () => gov.captureBaseline(),
    snapshot: (name) => ({ ...gov.snapshot(name), chem: chem.snapshot() }),
    restore: (snap) => { gov.restore(snap); if (snap.chem) chem.restore(snap.chem); },
    undoTag: (tag) => gov.undoTag(tag),
    factoryReset: () => gov.factoryReset(),

    // Complete state for persistence: only the LEARNED parts (topology is reproduced from
    // seed+sizes at construction, so it is not serialized). `ledger:false` omits the audit log -- the
    // per-turn save uses this (the ledger is in-memory governance state, not continuity state, and
    // deep-copying the growing log every turn was the dominant persist cost); export keeps it full.
    serialize: ({ ledger: includeLedger = true } = {}) => {
      // When the ledger is omitted (the per-turn hot save), leave the KEY OUT rather than writing [] --
      // so deserialize can tell "ledger intentionally not saved" (leave the in-memory ledger alone) from
      // "restore an empty ledger". This keeps a reload/imagination-revert from wiping live undo history.
      const state = { weights: net._synapses.map((s) => s.weight), chem: chem.snapshot(), clock };
      if (includeLedger) state.ledger = JSON.parse(JSON.stringify(ledger.all()));
      return state;
    },
    deserialize: (state) => {
      state.weights.forEach((w, i) => { if (net._synapses[i]) net._synapses[i].weight = w; });
      if (state.ledger) ledger.load(state.ledger); // absent -> leave the in-memory ledger untouched
      if (state.chem) chem.restore(state.chem);
      clock = state.clock || 0;
    },

    _net: net,
  };
}
