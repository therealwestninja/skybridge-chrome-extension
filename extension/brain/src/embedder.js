// Semantic vectors with graceful degradation. embed(text) -> number[] | null.
import { tokenize } from "./text.js";

export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function makeMockEmbedder({ dim = 16 } = {}) {
  return {
    name: "mock",
    async embed(text) {
      const v = new Array(dim).fill(0);
      for (const t of tokenize(text)) {
        let h = 0;
        for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
        v[h % dim] += 1;
      }
      return v;
    },
  };
}

// Zero-dependency deterministic hash embedding: FNV bag-of-words + fuzzy prefix buckets, unit-
// normalized. Not a transformer, but far better than raw keyword overlap and needs NO model or
// network -- a real OFFLINE semantic layer for memory recall (mined from Luminara's fallback
// embedder). Sits in the chain below Ollama/transformers, above the keyword fallback.
export function makeHashEmbedder({ dim = 128 } = {}) {
  const fnv = (str) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return h >>> 0;
  };
  return {
    name: "hash",
    async embed(text) {
      const v = new Array(dim).fill(0);
      for (const t of tokenize(text)) {
        v[fnv(t) % dim] += 1;
        if (t.length > 4) v[fnv(t.slice(0, 4)) % dim] += 0.5; // fuzzy prefix bucket (partial matches)
      }
      let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
      return v.map((x) => x / n);
    },
  };
}

export function makeOllamaEmbedder({ url = "http://localhost:11434", model = "nomic-embed-text", fetchImpl } = {}) {
  const doFetch = fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
  return {
    name: "ollama",
    async embed(text) {
      if (!doFetch) throw new Error("ollama-embed: no fetch");
      const res = await doFetch(`${url}/api/embeddings`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, prompt: String(text) }),
      });
      if (!res.ok) throw new Error(`ollama-embed: HTTP ${res.status}`);
      const data = await res.json();
      return data.embedding;
    },
  };
}

// Lazy in-browser MiniLM (mined + hardened from epic-dm's shipped WebGPU embedder). Real 384-dim semantic vectors,
// zero server. `load` is injectable so Node tests never pull the library. Two epic-dm lessons are baked in:
//   1. transformers.js v3 CDN + an explicit WebGPU→wasm fallback. v3's default device:"auto" silently RE-tries WebGPU
//      (and re-throws the same adapter error) when navigator.gpu exists, so ONLY an explicit device:"wasm" truly falls
//      back — a bug that otherwise loses the CPU path entirely on flaky-GPU machines.
//   2. `id`/`dim` are exposed as an embedder FINGERPRINT for the provenance guard (recall skips semantic on a dim
//      mismatch), so a store built with MiniLM (384) and reopened under hash (128) can't cross-query garbage.
export function makeTransformersEmbedder({ load, model = "Xenova/all-MiniLM-L6-v2", dim = 384 } = {}) {
  let pipe = null, device = "wasm";
  const loader = load || (async () => {
    const mod = await import("https://cdn.jsdelivr.net/npm/@huggingface/transformers@3");
    const pipeline = mod.pipeline || (mod.default && mod.default.pipeline);
    if (!pipeline) throw new Error("transformers: no pipeline export");
    try { const p = await pipeline("feature-extraction", model, { device: "webgpu", dtype: "fp32" }); device = "webgpu"; return p; }
    catch { return pipeline("feature-extraction", model, { device: "wasm" }); } // explicit wasm — v3 gotcha above
  });
  const ready = async () => (pipe || (pipe = await loader()));
  // Batch → rows of number[] (mean-pooled + L2-normalized). Batching is what makes ingesting a whole document cheap.
  async function embedBatch(texts) {
    if (!texts.length) return [];
    const p = await ready();
    const out = await p(texts.map(String), { pooling: "mean", normalize: true });
    const d = out.dims ? out.dims[out.dims.length - 1] : dim, rows = [];
    for (let i = 0; i < texts.length; i++) rows.push(Array.from(out.data.slice(i * d, i * d + d)));
    return rows;
  }
  return {
    name: "transformers", id: "minilm", dim,
    get device() { return device; },
    async embed(text) { return (await embedBatch([text]))[0]; },
    embedBatch,
  };
}

export function makeEmbedderChain(embedders = []) {
  return {
    name: "embedder-chain",
    async embed(text) {
      for (const e of embedders) {
        try { const v = await e.embed(text); if (v && v.length) return v; } catch { /* next */ }
      }
      return null;
    },
    // Batch path (for document ingest): use the first embedder that both succeeds AND exposes embedBatch, else map the
    // per-text embed over the batch. Keeps the whole batch on ONE embedder so vectors share a dimension (provenance).
    async embedBatch(texts) {
      if (!texts.length) return [];
      for (const e of embedders) {
        try {
          if (e.embedBatch) { const rows = await e.embedBatch(texts); if (rows && rows.length) return rows; }
          else { const first = await e.embed(texts[0]); if (first && first.length) { const rest = await Promise.all(texts.slice(1).map((t) => e.embed(t))); return [first, ...rest]; } }
        } catch { /* next embedder */ }
      }
      return texts.map(() => null);
    },
  };
}
