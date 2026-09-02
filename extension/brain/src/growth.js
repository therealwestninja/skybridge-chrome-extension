// growth.js — Expression III (the inner-life roadmap). The brain consolidates memories, reflects on who it is,
// distills lasting facts, takes on values, evolves its self-narrative — and the user sees NOTHING. A companion can
// grow profoundly between visits and return a stranger; there is no changelog, no "what's new," no session-diff. This
// records those real changes to the SELF as they happen and offers a human-readable catch-up ("since we last spoke I
// did some thinking and crystallized a few things," "I took on something I want to hold onto"), surfaced at the
// brain's discretion. It tracks EVENTS (what actually changed), not just counts, and marks them seen once shared so
// it never repeats itself. Registered as a faculty (the log persists), so growth survives across sessions.
import { norm } from "./text.js";

// Natural-language join: ["a","b","c"] -> "a, b, and c".
function naturalJoin(xs) {
  if (xs.length === 0) return "";
  if (xs.length === 1) return xs[0];
  if (xs.length === 2) return `${xs[0]} and ${xs[1]}`;
  return `${xs.slice(0, -1).join(", ")}, and ${xs[xs.length - 1]}`;
}

export function makeGrowth({ cap = 50, lead = "Since we last spoke, I" } = {}) {
  let events = []; // { seq, kind, note } — note is a verb phrase ("revisited 3 memories in my sleep")
  let n = 0, seen = 0;

  // Record a real change to the self. Deduped against the most recent pending note so a repeated pass doesn't stack.
  function record(kind, note) {
    const clean = String(note || "").trim(); if (!clean) return;
    if (events.some((e) => e.seq > seen && norm(e.note) === norm(clean))) return; // already pending — don't duplicate
    events.push({ seq: ++n, kind, note: clean });
    if (events.length > cap) events.shift();
  }
  const pending = () => events.filter((e) => e.seq > seen);

  // A human-readable catch-up over everything that changed since the user last heard about it.
  function whatsNew() {
    const p = pending();
    if (!p.length) return { changed: false, items: [], kinds: [], text: "" }; // symmetric shape — kinds always present
    const notes = p.map((e) => e.note);
    return { changed: true, items: notes.slice(), kinds: [...new Set(p.map((e) => e.kind))], text: `${lead} ${naturalJoin(notes)}.` };
  }
  function markSeen() { seen = n; }

  return {
    record, pending, whatsNew, markSeen,
    log: () => events.slice(),
    snapshot: () => ({ events: events.slice(), n, seen }),
    restore: (s) => { if (s) { events = Array.isArray(s.events) ? s.events.slice() : []; n = s.n ?? events.reduce((m, e) => Math.max(m, e.seq), 0); seen = s.seen ?? 0; } },
  };
}
