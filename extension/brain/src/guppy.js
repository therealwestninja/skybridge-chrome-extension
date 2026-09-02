// guppy.js — the GUPPI organ (Bobiverse). A replicant "isn't any better at multitasking than when alive," so Bob's
// ship bolts on GUPPI: a fast, dumb, terse subordinate that OFFLOADS the routine — status, lookups, tallies — so the
// deliberative self is freed for the things that actually need it. Guppy speaks in curt [bracketed] lines, never
// deliberates, never touches the persona; it just answers from LOCAL STATE without waking the language cortex (the
// LLM). Route a turn through Guppy first: if it can answer, you spent zero backend tokens; if not, it defers to the
// full self. It also tracks its own offload rate, so you can see how much load it's carrying.

const pct = (x) => Math.round(Math.max(0, Math.min(1, x)) * 100);
const sign = (x) => (x >= 0 ? "+" : "") + x;
const moodWord = (m) => (m > 0.15 ? "up" : m < -0.15 ? "low" : "level");
const bondWord = (s) => (s > 0.2 ? "warm" : s < -0.2 ? "cool" : "neutral");

export function makeGuppy(app, { name = "Guppy" } = {}) {
  let handled = 0, deferred = 0;
  const inn = () => app._internals();

  // A terse snapshot of the self's live state — the stuff Guppy can read off the dials without thinking.
  function report() {
    const g = inn();
    const st = app.status ? app.status() : {};
    const rawMood = st.mood != null ? st.mood : (g.organism && g.organism.mood ? g.organism.mood() : 0); // organism.mood() => {valence,arousal}
    const mood = typeof rawMood === "number" ? rawMood : (rawMood && typeof rawMood.valence === "number" ? rawMood.valence : 0);
    const energy = typeof st.energy === "number" ? st.energy : 1;
    const facts = g.store ? g.store.list({ type: "fact" }).length : 0;
    const dr = g.drives && g.drives.serialize ? g.drives.serialize() : {};
    let topNeed = null, topV = -Infinity;
    for (const k in dr) if (typeof dr[k] === "number" && dr[k] > topV) { topV = dr[k]; topNeed = k; }
    const rel = g.theoryOfMind && g.theoryOfMind.snapshot ? g.theoryOfMind.snapshot() : {};
    const bond = typeof rel.stance === "number" ? rel.stance : 0;
    return { mood: +mood.toFixed(2), energy: +energy.toFixed(2), facts, topNeed, need: topNeed ? +topV.toFixed(2) : 0, bond: +bond.toFixed(2) };
  }

  function statusLine() {
    const r = report();
    return `[Mood ${moodWord(r.mood)} ${sign(r.mood)} | Energy ${pct(r.energy)}% | Facts ${r.facts} | Bond ${bondWord(r.bond)} ${sign(r.bond)}${r.topNeed ? ` | Need: ${r.topNeed}` : ""}]`;
  }

  async function lookup(subject) {
    const g = inn();
    const hits = g.store && g.store.recallDeep ? await g.store.recallDeep(subject, 3) : [];
    if (!hits || !hits.length) return { text: `[No record of "${subject}"]`, hits: [] };
    return { text: `[Known: ${hits.map((h) => h.text).join("; ")}]`, hits: hits.map((h) => h.text) };
  }

  // The offload gate. Returns { handled:true, ... } if Guppy fielded it from local state (no LLM), else
  // { handled:false } so the caller wakes the deliberative self.
  async function ask(query) {
    const low = String(query || "").trim().toLowerCase();
    if (!low) { deferred++; return { handled: false }; }

    if (/\b(status|sitrep|report|systems?\s+(check|status|report)|how are you|how're you|you ok(ay)?)\b/.test(low)) {
      handled++; return { handled: true, kind: "status", text: statusLine(), status: report() };
    }
    const cnt = low.match(/how many (facts|memories|goals|habits)\b/);
    if (cnt) {
      handled++; const g = inn(); const kind = cnt[1];
      const n = (kind === "facts" || kind === "memories") ? (g.store ? g.store.list({ type: "fact" }).length : 0)
        : kind === "goals" ? (g.volition ? g.volition.list().length : 0)
        : (g.procedural ? g.procedural.list().length : 0);
      return { handled: true, kind: "count", text: `[${n} ${kind}]`, n };
    }
    const m = low.match(/(?:what do you know|do you (?:know|remember|recall)|tell me what you know|look up|recall)\s+(?:about\s+|anything about\s+)?(.+)/);
    if (m && m[1]) {
      handled++; const subject = m[1].replace(/[?.!]+$/, "").trim();
      const r = await lookup(subject); return { handled: true, kind: "lookup", subject, ...r };
    }
    deferred++; return { handled: false };            // beyond routine — defer to the self
  }

  return {
    name, ask, report, statusLine,
    offload: () => ({ handled, deferred, rate: handled + deferred ? +(handled / (handled + deferred)).toFixed(3) : 0 }),
    reset: () => { handled = 0; deferred = 0; },
  };
}
