// Whole-brain persistence: bundle organism + reflex + memories + app meta into a versioned
// save. The caller reconstructs organism/reflex/store with the seed/sizes from meta BEFORE
// calling load(), so synapse indices line up with the serialized weights.
export function makeSession({ organism, reflex, store, storage, key = "session", version = 1 }) {
  // full=true bundles the plasticity ledger (audit/undo history); the per-turn save uses full=false so
  // it doesn't deep-copy the growing ledger every turn (the #15 latency-creep fix). export keeps it full.
  const build = (meta = {}, { full = true } = {}) => ({
    version,
    brain: organism.serialize({ ledger: full }),
    reflex: reflex.snapshot(),
    memories: store.export(),
    meta,
  });
  async function apply(data) {
    if (!data) return null;
    if (data.version !== version) throw new Error(`session: unsupported version ${data.version}`);
    organism.deserialize(data.brain);
    reflex.restore(data.reflex);
    await store.import(data.memories);
    return data.meta;
  }
  return {
    async save(meta = {}) { await storage.set(key, build(meta, { full: false })); }, // per-turn: skip the ledger
    async load() { return apply(await storage.get(key)); },
    export(meta = {}) { return JSON.stringify(build(meta, { full: true })); }, // explicit: full ledger
    async import(jsonString) { return apply(JSON.parse(jsonString)); },
  };
}
