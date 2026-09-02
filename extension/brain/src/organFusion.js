// organFusion.js — Tier-2 spike PB-9 [D1]: fuse the separate SENSE-ORGAN embeddings (radar, camera, mic, gyro) into ONE
// unified state vector for the decider — a small "frozen-core adapter" (per-organ weight × reliability, concat with a
// positional layout so each organ owns a known slice, then L2-normalize). This answers the long-standing "organs are
// parallel, not integrated" finding, while keeping each organ INDEPENDENTLY inspectable (it returns the per-organ
// contribution + which slice it occupies). A fixed, auditable blend — no opaque learned weights. PURE: embeddings
// injected; deterministic.

export function makeOrganFusion({ organs = ["radar", "camera", "mic", "gyro"], weights = {}, reliability = {} } = {}) {
  // vectors: { radar:[…], camera:[…], … } (any subset). live: { camera:false } marks an organ offline this tick.
  function fuse(vectors = {}, live = {}) {
    const parts = [], contributions = {}, layout = {};
    let offset = 0;
    for (const o of organs) {
      const v = vectors[o];
      if (!Array.isArray(v) || !v.length) continue;
      const w = (weights[o] != null ? weights[o] : 1) * (reliability[o] != null ? reliability[o] : 1) * (live[o] === false ? 0 : 1);
      if (w <= 0) continue;
      parts.push(v.map((x) => x * w));
      contributions[o] = +w.toFixed(3);
      layout[o] = [offset, offset + v.length]; offset += v.length;   // which slice of the fused vector is this organ
    }
    const cat = parts.flat();
    if (!cat.length) return { vector: [], dim: 0, contributions, layout, present: [] };
    const norm = Math.sqrt(cat.reduce((s, x) => s + x * x, 0)) || 1;
    return { vector: cat.map((x) => +(x / norm).toFixed(4)), dim: cat.length, contributions, layout, present: Object.keys(contributions) };
  }
  return { fuse };
}
