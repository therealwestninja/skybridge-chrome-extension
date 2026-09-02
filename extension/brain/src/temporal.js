// Temporal cognition (Personhood P5): a sense of time passing between interactions. The brain has a
// tick clock and memory timestamps but never reasons about elapsed time -- it's timeless between
// turns. This measures the real gap since the last interaction and turns it into a human sense ("about
// three hours", "since yesterday"), so Rook can register "we just spoke" vs "it's been a while" the way
// a person would. Persisted, so the gap spans across sessions/reloads.
export function makeTemporal({ now = () => 0, gapFloorMs = 10 * 60 * 1000 } = {}) {
  let lastSeen = null;   // timestamp of the previous interaction
  let current = null;    // last computed sense

  function humanize(ms) {
    const min = ms / 60000, hr = min / 60, day = hr / 24;
    if (min < 2) return "just now";
    if (min < 45) return `about ${Math.round(min)} minutes`;
    if (hr < 2) return "about an hour";
    if (hr < 12) return `about ${Math.round(hr)} hours`;
    if (day < 2) return "since yesterday";
    return `about ${Math.round(day)} days`;
  }

  return {
    // Each turn: measure the gap since the last interaction, then mark "now" as the latest.
    observe() {
      const t = now();
      const fresh = lastSeen == null;                       // first turn ever -> no prior to compare
      const gapMs = fresh ? 0 : Math.max(0, t - lastSeen);
      current = { gapMs, phrase: fresh ? null : humanize(gapMs), fresh };
      lastSeen = t;
      return current;
    },
    // A prompt line -- only when the gap is meaningful (mid-conversation turns stay silent).
    block() {
      if (!current || current.fresh || current.gapMs < gapFloorMs) return "";
      return `Time sense: it's been ${current.phrase} since you two last talked.`;
    },
    sense: () => current,
    serialize: () => ({ lastSeen }),
    restore(s) { if (s) lastSeen = s.lastSeen ?? null; },
  };
}
