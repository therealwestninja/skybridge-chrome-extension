// Working memory (Personhood P1): a small, capacity-limited, DECAYING buffer that persists across
// turns -- unlike neural activation, which settle() wipes at the start of every turn. It holds the
// "active" items of the current task (entities in play, the open question) so a train of thought
// carries forward instead of being rebuilt from scratch each turn.
//
// It is NOT the other three memory-ish things:
//   - declarativeStore = long-term, large, persistent.        WM is small, transient, active.
//   - the history window = the raw recent transcript.         WM is a distilled active set.
//   - neural activation = cleared by settle() each turn.      WM survives settle (it lives on mind).
//
// Transient by design: rebuilt from the conversation, not persisted across reload (a scratchpad, not
// a record). Miller's 7+-2 -> default capacity 7; the default decay gives an un-refreshed item a
// ~4-turn lifespan before it fades below threshold.
export function makeWorkingMemory({ capacity = 7, decay = 0.6, boost = 1.0, threshold = 0.15 } = {}) {
  let items = []; // [{ text, activation, turn }] -- kept sorted most-active first
  let turn = 0;

  const sortDesc = () => items.sort((a, b) => b.activation - a.activation);
  const trim = () => { if (items.length > capacity) items = items.slice(0, capacity); }; // drop least-active

  // Age every held item one step, then evict whatever faded below threshold or spilled past capacity.
  // Called once per turn (before note) so re-mentioned items get refreshed back up afterwards.
  function decayStep() {
    turn++;
    for (const it of items) it.activation *= decay;
    items = items.filter((it) => it.activation >= threshold);
    sortDesc();
    trim();
    return items;
  }

  // Add or refresh items. Each entry is a string, or { text, weight } (weight scales the refresh, so a
  // faint mention can be noted below full strength). Re-noting an existing item refreshes it toward the
  // target rather than stacking -- an item is either in focus or fading, never louder than boost.
  function note(list) {
    const arr = Array.isArray(list) ? list : [list];
    for (const raw of arr) {
      const isObj = raw && typeof raw === "object";
      const text = String(isObj ? raw.text ?? "" : raw ?? "").trim();
      if (!text) continue;
      const target = boost * (isObj && raw.weight != null ? raw.weight : 1);
      const existing = items.find((it) => it.text.toLowerCase() === text.toLowerCase());
      if (existing) { existing.activation = Math.max(existing.activation, target); existing.turn = turn; }
      else items.push({ text, activation: target, turn });
    }
    sortDesc();
    trim();
    return items;
  }

  return {
    note,
    decay: decayStep,
    items: () => items.map((it) => ({ ...it })),
    // A prompt segment naming what's currently in focus (most-active first). Working memory is meant to
    // carry a train of thought FORWARD from prior turns -- so `exclude` (the current message) drops items
    // that just echo what the user said this turn, which is redundant clutter (and hurt the judge in the
    // R2-vs-R3 ablation). Empty when nothing distinct is held.
    block: ({ exclude = "" } = {}) => {
      const ex = String(exclude).toLowerCase();
      const carried = items.filter((it) => { const t = it.text.replace(/\.\.\.$/, "").toLowerCase(); return t.length > 1 && !ex.includes(t); });
      return carried.length ? "Currently in focus: " + carried.map((it) => it.text).join("; ") + "." : "";
    },
    load: () => Math.min(1, items.length / capacity), // how "full" the mind is, in [0,1]
    clear: () => { items = []; },
  };
}
