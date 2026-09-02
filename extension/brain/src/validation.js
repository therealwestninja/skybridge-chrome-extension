// Deterministic, mock-driven ablation metrics for five objective claims.
import { makeOrganism } from "./organism.js";
import { makeReflex } from "./reflex.js";
import { makeMind } from "./mind.js";
import { makeDeclarativeStore } from "./declarativeStore.js";
import { makeMemoryStorage } from "./storage.js";
import { makeMockBackend } from "./backends/mock.js";
import { makeMockEmbedder } from "./embedder.js";
import { MIXED, AFFECT, MEMORY } from "../data/probes.js";

const SIZES = { sensory: 30, memory: 20, association: 60, salience: 30, decision: 30 };

function buildMind(ablation = {}) {
  const organism = makeOrganism({ seed: 1, sizes: SIZES, ablation });
  const reflex = makeReflex({ seed: 1 });
  const store = makeDeclarativeStore({ storage: makeMemoryStorage(), embedder: makeMockEmbedder(), now: () => 1 });
  const mind = makeMind({ organism, reflex, backend: makeMockBackend(), memory: store, personality: "p", ticksPerTurn: 12, ablation });
  return { organism, mind, store };
}

export async function localAnswerRate(ablation = {}) {
  const { mind } = buildMind(ablation);
  let local = 0;
  for (const msg of MIXED) {
    const r = await mind.respond(msg);
    if (r.source === "reflex" || r.source === "quiet") local++;
  }
  return local / MIXED.length;
}

export function learningDrift({ reward = true, ablation = {} } = {}) {
  const o = makeOrganism({ seed: 1, sizes: SIZES, ablation });
  const w0 = o._net._synapses.map((s) => s.weight);
  o.inject("sensory", 0.8);
  for (let t = 0; t < 120; t++) {
    if (reward && t % 5 === 0) o.inject("reward", 0.9);
    o.tick({ tags: ["x"] });
  }
  const w1 = o._net._synapses.map((s) => s.weight);
  return w0.reduce((sum, w, i) => sum + Math.abs(w1[i] - w), 0);
}

export function moodResponse(ablation = {}) {
  const rOrg = makeOrganism({ seed: 1, sizes: SIZES, ablation });
  const baseV = rOrg.mood().valence;
  for (const _ of AFFECT.reward) rOrg.inject("reward", 0.9);
  let maxV = baseV;
  for (let t = 0; t < 60; t++) { rOrg.tick(); maxV = Math.max(maxV, rOrg.mood().valence); }

  const tOrg = makeOrganism({ seed: 1, sizes: SIZES, ablation });
  const baseA = tOrg.mood().arousal;
  tOrg.inject("threat", 0.9);
  let maxA = baseA;
  for (let t = 0; t < 60; t++) { tOrg.tick(); maxA = Math.max(maxA, tOrg.mood().arousal); }

  return { valenceRise: +(maxV - baseV).toFixed(6), arousalRise: +(maxA - baseA).toFixed(6) };
}

async function buildStore() {
  const store = makeDeclarativeStore({ storage: makeMemoryStorage(), embedder: makeMockEmbedder(), now: () => 1 });
  for (const f of MEMORY.facts) await store.addFact(f.text);
  return store;
}

export async function recallPrecision(mode) {
  if (mode === "none") return 0;
  const store = await buildStore();
  let hits = 0;
  for (const { q, expect } of MEMORY.queries) {
    let top;
    if (mode === "recency") top = store.list().slice(-3).map((r) => r.text);
    else top = (await store.recall(q, 3)).map((r) => r.text);
    if (top.includes(expect)) hits++;
  }
  return hits / MEMORY.queries.length;
}

export function arcLatency() {
  const o = makeOrganism({ seed: 1, sizes: SIZES });
  const sal = o.regions.salience, asc = o.regions.association;
  o.inject("sensory", 0.9);
  let salience = Infinity, association = Infinity;
  for (let t = 0; t < 200; t++) {
    const spiked = o.tick();
    if (salience === Infinity && spiked.some((id) => sal.contains(id))) salience = t;
    if (association === Infinity && spiked.some((id) => asc.contains(id))) association = t;
  }
  return { salience, association };
}

export async function runValidation() {
  return {
    localAnswerRate: {
      brainOn: await localAnswerRate({}),
      noRouting: await localAnswerRate({ noRouting: true }),
    },
    learning: {
      rewarded: learningDrift({ reward: true }),
      unrewarded: learningDrift({ reward: false }),
      noLearning: learningDrift({ reward: true, ablation: { noLearning: true } }),
    },
    mood: { brainOn: moodResponse({}), noMood: moodResponse({ noMood: true }) },
    recall: {
      content: await recallPrecision("content"),
      recency: await recallPrecision("recency"),
      none: await recallPrecision("none"),
    },
    latency: arcLatency(),
  };
}
