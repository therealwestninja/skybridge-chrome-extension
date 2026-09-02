import { makeRegion } from "./region.js";

// Builds the five functional regions and the fixed inter-region projections (the genome).
// Returns { regions, channels, actions }. All wiring uses the provided deterministic rng.
export function buildConnectome(network, rng, cfg = {}) {
  const sizes = { sensory: 60, memory: 40, association: 200, salience: 60, decision: 60, ...(cfg.sizes || {}) };

  const sensory     = makeRegion({ network, size: sizes.sensory,     recurrence: 0.02, rng });
  const memory      = makeRegion({ network, size: sizes.memory,      recurrence: 0.02, rng });
  const association = makeRegion({ network, size: sizes.association, recurrence: 0.08, rng });
  const salience    = makeRegion({ network, size: sizes.salience,    recurrence: 0.04, rng });
  const decision    = makeRegion({ network, size: sizes.decision,    recurrence: 0.05, rng });

  // Excitatory directed projection from a set of source neurons to a set of target neurons.
  const driveTo = (srcIds, dstIds, prob, weight, delay) => {
    for (const s of srcIds) for (const d of dstIds) {
      if (rng.next() < prob) network.connect(s, d, weight, delay);
    }
  };

  // reward/threat are salience sub-populations (approach vs avoid).
  const half = Math.floor(salience.excitatory.length / 2);
  const rewardPop = salience.excitatory.slice(0, half);
  const threatPop = salience.excitatory.slice(half);
  const channels = {
    sensory: sensory.ids,
    memory: memory.ids,
    reward: rewardPop,
    threat: threatPop,
  };

  // Input pathways. Generic input feeds the APPROACH (reward) half of salience (the fast arc). The
  // deliberative association loop is driven mainly by the MEMORY channel, which mind injects as a
  // "deliberation demand" (questions / novelty / recalled content) -- so a bare/social message runs
  // on the fast arc, while content-rich input lights up deliberation. The THREAT half is driven only
  // by the threat channel, keeping ESCALATE quiet unless something is actually threatening.
  driveTo(sensory.excitatory, rewardPop,        0.30, 9, 1); // fast approach arc (delay 1)
  driveTo(sensory.excitatory, association.ids,   0.06, 3, 2); // weak generic drive (bare input barely deliberates)
  driveTo(memory.excitatory,  association.ids,   0.35, 8, 1); // deliberation demand -> association (the slow loop)

  // Motor-action populations carved from the decision region's excitatory neurons. QUIET is NOT
  // a population -- it is the readAction verdict when decision activity is below the floor.
  const actionNames = ["RESPOND", "ESCALATE", "REFLEX_REPLY", "HOLD"];
  const exc = decision.excitatory;
  const per = Math.floor(exc.length / actionNames.length);
  const actions = {};
  actionNames.forEach((name, i) => {
    // Last population absorbs the remainder so no excitatory neuron is left unassigned (and thus
    // never counted in winner-take-all) when exc.length isn't divisible by the action count.
    actions[name] = i === actionNames.length - 1 ? exc.slice(i * per) : exc.slice(i * per, (i + 1) * per);
  });

  // Differential receptive fields (the genome): each action has a distinct driver, so which
  // action wins reflects the input rather than random wiring. These ARE the salience/association
  // -> decision links (they replace the old undifferentiated projections into all of decision).
  driveTo(rewardPop,              actions.REFLEX_REPLY, 0.55, 8, 1); // fast default: the snap reply on approach
  driveTo(association.excitatory,  actions.RESPOND,      0.62, 9, 2); // deliberation -> considered reply (backend)
  driveTo(threatPop,              actions.ESCALATE,     0.70, 9, 1); // alarm -> escalate (threat-gated)
  driveTo(salience.excitatory,    actions.HOLD,         0.08, 4, 1); // weak fallback only

  return { regions: { sensory, memory, association, salience, decision }, channels, actions };
}
