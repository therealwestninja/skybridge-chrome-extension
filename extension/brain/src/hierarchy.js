// hierarchy.js — the theme layer (L2) over the declarative store. Clusters the current facts by embedding proximity
// and summarizes each cluster into a THEME node (a centroid vector + a grounded one-line summary + the member ids).
// This is the multi-resolution rung the flat store lacked (RAPTOR-style, "collapsed tree"): once written, theme nodes
// compete in the SAME hybrid recall as the leaves, so a broad "zoom-out" query pulls a synthesis node and a specific
// query still pulls a leaf (MMR de-dups a theme against its own members). Built at SLEEP (never per-turn), grounded
// (a summary asserts only member content), offline-safe (extractive fallback when there's no backend).
//
// Ladder:  L0 episodes → L1 facts (distiller) → L2 themes (here).  Phase 0 gate: docs/plans/2026-07-04-hierarchical-memory.md.
import { cosine } from "./embedder.js";

function centroid(vecs) {
  if (!vecs.length) return [];                 // defensive: never crash on an empty cluster (build() guarantees ≥minCluster)
  const d = vecs[0].length;
  const c = new Array(d).fill(0);
  for (const v of vecs) for (let i = 0; i < d; i++) c[i] += v[i];
  const n = Math.hypot(...c) || 1;
  return c.map((x) => x / n);
}

export function makeHierarchy({ store, backend = null, threshold = 0.6, minCluster = 3, maxThemes = 16 } = {}) {
  // Greedy, deterministic clustering on cosine proximity: seed with the first unclustered fact and absorb every fact
  // within `threshold` cosine of the seed. Deterministic (records order) so themes don't churn across sleeps for an
  // unchanged corpus. Simple by design — a theme node's job is coarse grouping, not perfect partitioning.
  function cluster(facts) {
    const used = new Set();
    const clusters = [];
    for (const seed of facts) {
      if (used.has(seed.id)) continue;
      used.add(seed.id);
      const members = [seed];
      for (const other of facts) {
        if (used.has(other.id)) continue;
        if (seed.vector.length === other.vector.length && cosine(seed.vector, other.vector) >= threshold) { members.push(other); used.add(other.id); } // provenance guard: never cluster across embedders (mismatched dims)
      }
      clusters.push(members);
    }
    return clusters.filter((c) => c.length >= minCluster).slice(0, maxThemes);
  }

  // Grounded summary of a cluster: one line asserting only what the members say. Backend when present (distiller
  // discipline — think-stripped, never invents), else an extractive fallback so it works fully offline.
  async function summarize(members) {
    const texts = members.map((m) => m.text).filter(Boolean);
    if (backend) {
      try {
        const out = await backend.generate({
          system: "Summarize the common THEME of these related notes in ONE short sentence. Assert only what the notes say; invent no specifics, add no new names or numbers. Return just the sentence.",
          messages: [{ role: "user", content: texts.map((t) => "- " + t).join("\n") }],
        });
        const s = (typeof out === "string" ? out : (out && out.text) || "").split("\n")[0].trim();
        if (s) return s.slice(0, 200);
      } catch { /* fall through to extractive */ }
    }
    return ("Theme — " + texts.slice(0, 4).join("; ")).slice(0, 200);
  }

  return {
    // Rebuild the theme layer from the store's current facts. v1 does a FULL rebuild (clear prior themes, re-cluster,
    // re-summarize) — simple and idempotent; Phase 3 will make it incremental. Returns {themes, clustered, facts}.
    async build() {
      for (const t of store.list({ type: "theme" })) await store.remove(t.id); // clear the old layer
      const facts = store.list({ type: "fact" }).filter((f) => Array.isArray(f.vector) && f.vector.length && (f.stateRole || "current") === "current");
      if (facts.length < minCluster) return { themes: 0, clustered: 0, facts: facts.length };
      const clusters = cluster(facts);
      let clustered = 0;
      for (const members of clusters) {
        const text = await summarize(members);
        await store.add({
          type: "theme", level: 2, text,
          vector: centroid(members.map((m) => m.vector)),
          members: members.map((m) => m.id),
          tags: ["level:2"], source: "theme", // provenance "theme" (not "model") → not down-weighted; it's a synthesis, meant to win broad queries
        });
        clustered += members.length;
      }
      return { themes: clusters.length, clustered, facts: facts.length };
    },

    // Inspection: current theme nodes with their member counts.
    themes: () => store.list({ type: "theme" }).map((t) => ({ id: t.id, text: t.text, members: (t.members || []).length })),
  };
}
