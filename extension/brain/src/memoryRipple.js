// memoryRipple.js — advisory blast-radius over a memory's REAL derivation edges. Before a correction/retraction,
// answer "what other memories DERIVE FROM this?" so a fix doesn't silently orphan the conclusions that rest on it.
// This is RippleCheck's idea for beliefs — and, like RippleCheck, it uses REAL recorded edges, NEVER embedding
// similarity (a "relatedness" cosine is the belief version of a text match, not a real reference).
//
// EDGE MODEL: `child.basis = [parentId, ...]` means the child was DERIVED FROM those parents. A theme/summary node's
// `members = [sourceId, ...]` are treated the same way (the theme rests on its members). We build the REVERSE index
// parent -> Set(child) so "what depends on X" is O(1), then walk it transitively.
//
// ADVISORY, never blocking. An empty radius reports "no RECORDED dependents" — NOT "safe": a conclusion drawn in a
// human's head, or a fact reused without a recorded basis, is invisible (the belief analog of RippleCheck's
// dynamic-dispatch blind spot). PURE: records in, findings out; no store, no clock, no IO.

function parentsOf(rec) {
  const basis = Array.isArray(rec.basis) ? rec.basis : [];
  const members = Array.isArray(rec.members) ? rec.members : [];
  return [...basis, ...members];
}

export function buildIndex(records = []) {
  const byId = new Map();
  const dependents = new Map(); // parentId -> Set(childId): "who derives from parent"
  for (const r of records) {
    if (!r || r.id == null) continue;
    byId.set(r.id, r);
  }
  for (const r of records) {
    if (!r || r.id == null) continue;
    for (const parent of parentsOf(r)) {
      if (parent == null || parent === r.id) continue; // ignore self-edges
      if (!dependents.has(parent)) dependents.set(parent, new Set());
      dependents.get(parent).add(r.id);
    }
  }
  return { byId, dependents };
}

export function directDependents(index, id) {
  return [...(index.dependents.get(id) || [])];
}

// Transitive dependents (cycle-safe BFS), each tagged with the fewest hops from the target, ranked nearest-first then
// by the dependent's own weight (pinned, then salience) — the ones a change most endangers.
export function blastRadius(index, id, { max = 1000 } = {}) {
  const hopsOf = new Map(); // childId -> hops
  const queue = [[id, 0]];
  const origin = id;
  while (queue.length) {
    const [cur, hops] = queue.shift();
    for (const child of index.dependents.get(cur) || []) {
      if (child === origin) continue;            // a cycle back to the target: ignore
      if (hopsOf.has(child)) continue;           // already reached by a shorter/equal path
      hopsOf.set(child, hops + 1);
      if (hopsOf.size < max) queue.push([child, hops + 1]);
    }
  }
  const rows = [...hopsOf.entries()].map(([cid, hops]) => {
    const r = index.byId.get(cid) || {};
    return {
      id: cid,
      hops,
      pinned: !!r.pinned,
      salience: Number(r.salience) || 0,
      type: r.type || null,
      text: (r.text != null ? r.text : r.value != null ? r.value : "").toString(),
    };
  });
  rows.sort((a, b) => a.hops - b.hops || Number(b.pinned) - Number(a.pinned) || b.salience - a.salience);
  return rows;
}

// One honest advisory line (house voice). NEVER claims "safe".
export function describe(targetId, radius, index = null) {
  if (!radius || radius.length === 0) {
    return "No recorded memory derives from this — but that only covers edges I actually recorded; a conclusion drawn without a stored basis wouldn't show here.";
  }
  const label = (row) => {
    const t = (row.text || "").replace(/\s+/g, " ").trim().slice(0, 48);
    return t ? `"${t}"` : String(row.id);
  };
  const top = radius.slice(0, 3).map(label).join("; ");
  const more = radius.length > 3 ? ` (+${radius.length - 3} more)` : "";
  return `Changing this would leave ${radius.length} memory(ies) that rest on it — nearest: ${top}${more}. They won't auto-update; review them.`;
}
