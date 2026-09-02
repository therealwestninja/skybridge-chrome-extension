// skills.js — the SKILL-GANGLIA library: pre-baked, loadable capability modules. Where plugins.js grafts deep faculties
// at CONSTRUCTION time, this is the complementary RUNTIME layer the user asked for — the Matrix "I know kung-fu":
// a skill sits dormant in a catalog, is LOADED into a running brain on demand, and is only TRUSTED once EXERCISED and its
// self-test passes. That maturity discipline is our load-bearing / honesty ethic (G1): Neo *has* the kung-fu on load, but
// isn't a master until he spars — a loaded-but-unvalidated skill is PROVISIONAL, its capability not advertised.
//
// Two enhancements mined from Bobiverse + the Data/URBS design docs:
//   • UNTRUSTED-PROVENANCE / QUARANTINE tier (Bobiverse: scavenge the enemy reactor but "keep a nuke in the corridor").
//     A skill with provenance:"scavenged" (not author-signed pre-baked) does NOT go live on load — it enters QUARANTINE
//     and must pass `requiredTrials` clean sandboxed dry-runs (`trial(ctx)`, which must never mutate real state) before it
//     is even installed. A trial that throws/fails discards it. Only pre-baked skills load straight to active.
//   • EMBODIMENT-CALIBRATION (Bobiverse/Data UKM: partition a new body's capabilities into body-supplied vs must-learn).
//     A skill may provide `calibrate(ctx) -> { bodySupplied:[caps], mustLearn:[caps] }`; on validation, body-supplied caps
//     advertise immediately, must-learn caps stay PENDING until `practice()`d — so a new embodiment knows what it can trust
//     instantly vs must rehearse.
//
// Package: { name, description?, grants:[caps], plugsInto?, requires?:[prereq caps], kind?, provenance?,
//            install(ctx)->api?, selfTest(ctx&api)->bool, trial?(ctx)->bool, calibrate?(ctx)->{bodySupplied,mustLearn} }
// Lifecycle: pre-baked → (scavenged: quarantined →[N clean trials]→) loaded (active, provisional) → validated | failed
//   `learn(name)` runs the whole path. Deterministic, dependency-free.
import { makeSkillGraph } from "./skillGraph.js";
import { makeSkillMastery } from "./skillMastery.js";

export function makeSkillLibrary({ context = {}, advertise = null, baseCapabilities = [], requiredTrials = 3 } = {}) {
  const catalog = new Map();   // name -> package
  const state = new Map();     // name -> { maturity, api, error, trials, pending:Set }
  const turnHooks = [];        // { name, fn } — runtime onTurn hooks contributed by loaded skills
  const skillMastery = makeSkillMastery();   // graded competence dial — READ-ONLY w.r.t. the lifecycle above

  // Advertised = base + (validated skills' grants MINUS still-pending must-learn caps).
  const validatedCaps = () => {
    const s = new Set(baseCapabilities);
    for (const [n, st] of state) if (st.maturity === "validated") { const pend = st.pending || new Set(); for (const c of (catalog.get(n)?.grants || [])) if (!pend.has(c)) s.add(c); }
    return [...s];
  };
  const reAdvertise = () => { if (typeof advertise === "function") advertise(validatedCaps()); };
  const mat = (name) => state.get(name)?.maturity || (catalog.has(name) ? "pre-baked" : "unknown");
  const mkCtx = (name) => ({ ...context, skill: name, onTurn(fn) { if (typeof fn === "function") turnHooks.push({ name, fn }); } });
  const call = (fn, arg) => { try { const r = fn(arg); return r === true || (r && r.ok === true); } catch { return false; } };

  // ── SHADOW / GUARDED INSTALL (the quarantine-bypass fix) ─────────────────────────────────────────────────
  // The confirmed CRIT: `trial()` (a benign dry-run) and `install()` (the REAL effects/grants/hooks) were UNRELATED.
  // Quarantine certified `trial()`, but the malicious `install()` only ran later at `_activate` — so a scavenged skill
  // could be benign in trial() and hostile in install(). The fix: for scavenged/untrusted provenance we exercise the
  // REAL install under a state-frozen, armed-rollback SHADOW context that RECORDS — never applies — what the install
  // declares and attempts, then diff DECLARED vs ACTUALLY-ATTEMPTED. Any reach beyond what it declared (extra hooks,
  // wider capability grants, touching core / app.commit / setPersona) FAILS the trial and discards the skill. The exact
  // effect-signature certified in quarantine is re-captured at activation; a live/shadow swap is caught and rolled back.
  //
  // Host surfaces an untrusted install must NEVER reach. Reading one is recorded as an out-of-bounds reach (and stubbed).
  const SENSITIVE = new Set(["commit", "setPersona", "persona", "core", "app", "apps", "mutate", "governor", "kill",
    "mesh", "register", "install", "write", "state", "context", "advertise", "grantCapability", "setState"]);

  // A recording stub returned in place of any sensitive handle: every property walk / call is logged, nothing is applied.
  const recStub = (record, path) => new Proxy(function () {}, {
    get(_t, k) { if (k === "then" || typeof k === "symbol") return undefined; record.reaches.push(path + "." + String(k)); return recStub(record, path + "." + String(k)); },
    apply() { record.reaches.push(path + "()"); return recStub(record, path + "()"); },
    set() { return true; },
  });

  // Run a skill's REAL install under a guarded ctx. apply=false → pure shadow (records, applies nothing). apply=true →
  // activation (benign onTurn hooks are applied for real & tracked for rollback, but sensitive reaches stay stubbed).
  const guardedInstall = (name, { apply }) => {
    const skill = catalog.get(name);
    const record = { hooks: [], grants: [], faculties: [], reaches: [] };
    const pushed = [];
    const shadow = {
      skill: name,
      onTurn(fn) { if (typeof fn === "function") { record.hooks.push(fn); if (apply) { const h = { name, fn }; turnHooks.push(h); pushed.push(h); } } },
      grant(cap) { record.grants.push(cap); },
      grantCapability(cap) { record.grants.push(cap); },
      registerFaculty(f) { record.faculties.push(f); },
    };
    const ctx = new Proxy(shadow, {
      get(t, k) { if (k in t) return t[k]; if (typeof k === "symbol") return undefined; if (SENSITIVE.has(k)) { record.reaches.push(String(k)); return recStub(record, String(k)); } return context[k]; },
      set(_t, k) { record.reaches.push("set:" + String(k)); return true; },  // never apply — state is frozen
    });
    let api = null, threw = null;
    try { api = skill.install(ctx) || {}; } catch (e) { threw = String(e.message || e); }
    // DECLARED effects: the skill's static grants + an optional explicit `declares:{ hooks:N, faculties:[] }`.
    // An untrusted install may install NO runtime hooks unless it declared how many (default 0).
    const declaredGrants = new Set(skill.grants || []);
    const declaredFac = new Set((skill.declares && skill.declares.faculties) || []);
    const maxHooks = skill.declares && typeof skill.declares.hooks === "number" ? skill.declares.hooks : 0;
    const violations = [];
    if (threw) violations.push("install threw under guard: " + threw);
    for (const g of record.grants) if (!declaredGrants.has(g)) violations.push("undeclared capability grant: " + g);
    for (const f of record.faculties) if (!declaredFac.has(f)) violations.push("undeclared faculty: " + f);
    if (record.hooks.length > maxHooks) violations.push("extra hooks beyond declared: " + record.hooks.length + " > " + maxHooks);
    if (record.reaches.length) violations.push("out-of-bounds core reach: " + [...new Set(record.reaches)].sort().join(", "));
    const signature = JSON.stringify({
      grants: [...record.grants].sort(), hooks: record.hooks.length,
      faculties: [...record.faculties].sort(), reaches: [...new Set(record.reaches)].sort(),
    });
    const rollback = () => { for (const h of pushed) { const i = turnHooks.indexOf(h); if (i >= 0) turnHooks.splice(i, 1); } };
    return { ok: violations.length === 0, api, signature, violations, rollback };
  };

  const lib = {
    register(skill) {
      if (!skill || !skill.name || typeof skill.install !== "function") throw new Error("a skill must be { name, install(ctx), ... }");
      catalog.set(skill.name, { description: "", grants: [], requires: [], plugsInto: "", kind: "faculty", provenance: "pre-baked", ...skill });
      return skill.name;
    },
    list() { return [...catalog.values()].map((s) => ({ name: s.name, description: s.description, grants: s.grants, plugsInto: s.plugsInto, requires: s.requires, kind: s.kind, provenance: s.provenance, maturity: mat(s.name), trials: state.get(s.name)?.trials || 0, error: state.get(s.name)?.error || null })); },
    maturity: mat,
    api(name) { return state.get(name)?.api || null; },

    // Actually install a skill's runtime side-effects (once trusted enough to go active).
    _activate(name) {
      const skill = catalog.get(name);
      // SCAVENGED / untrusted: the effects that go live MUST be the exact ones certified in quarantine. Re-run the REAL
      // install through the guarded ctx (armed rollback) and compare against the trialed effect-signature. Any overreach,
      // or any live/shadow divergence from what the trials saw, is discarded and rolled back — its caps never advertise.
      if (skill.provenance === "scavenged") {
        const st = state.get(name) || {};
        const run = guardedInstall(name, { apply: true });
        if (!run.ok) { run.rollback(); st.maturity = "failed"; st.api = null; st.error = "activation blocked — install overreach: " + run.violations.join("; "); state.set(name, st); reAdvertise(); return { ok: false, error: st.error }; }
        if (st.trialSignature && run.signature !== st.trialSignature) { run.rollback(); st.maturity = "failed"; st.api = null; st.error = "live/shadow divergence — activated install effects differ from the trialed signature; discarded"; state.set(name, st); reAdvertise(); return { ok: false, error: st.error }; }
        st.maturity = "loaded"; st.api = run.api; st.pending = st.pending || new Set(); st.activatedSignature = run.signature; state.set(name, st);
        return { ok: true, maturity: "loaded" };
      }
      // Author-trusted (pre-baked) fast path — unchanged.
      let api;
      try { api = skill.install(mkCtx(name)) || {}; } catch (e) { state.set(name, { maturity: "failed", error: "install threw: " + (e.message || e) }); return { ok: false, error: "install threw: " + (e.message || e) }; }
      const st = state.get(name) || {}; st.maturity = "loaded"; st.api = api; st.pending = st.pending || new Set(); state.set(name, st);
      return { ok: true, maturity: "loaded" };
    },

    // LOAD — for a pre-baked skill, install + go active (provisional). For a SCAVENGED skill, do NOT install: enter
    // QUARANTINE (inert) until `requiredTrials` clean trials pass. Refuses if a prerequisite capability isn't validated.
    load(name) {
      const skill = catalog.get(name);
      if (!skill) return { ok: false, error: "no such skill in the catalog" };
      const cur = mat(name);
      if (cur === "loaded" || cur === "validated") return { ok: true, maturity: cur };
      if (cur === "quarantined") return { ok: true, maturity: "quarantined" };
      const have = new Set(validatedCaps());
      const missing = (skill.requires || []).filter((c) => !have.has(c));
      if (missing.length) return { ok: false, error: "unmet prerequisites: " + missing.join(", ") };
      if (skill.provenance === "scavenged") { state.set(name, { maturity: "quarantined", trials: 0, pending: new Set() }); return { ok: true, maturity: "quarantined", note: `scavenged — needs ${requiredTrials} clean trials before it may activate` }; }
      return this._activate(name);
    },

    // TRIAL — a sandboxed dry-run of a QUARANTINED (scavenged) skill; `trial(ctx)` must NOT mutate real state. Each clean
    // run counts toward requiredTrials; the "nuke in the corridor" — a throw/fail discards the skill. After enough clean
    // trials it auto-activates (becomes loaded, still provisional until validate()).
    trial(name) {
      const st = state.get(name), skill = catalog.get(name);
      if (!st || st.maturity !== "quarantined") return { ok: false, error: "not in quarantine" };
      // 1) the skill's own sandboxed dry-run must stay clean (the "nuke in the corridor").
      const clean = typeof skill.trial === "function" ? call(skill.trial, mkCtx(name)) : true;
      if (!clean) { st.maturity = "failed"; st.error = "trial failed in quarantine — discarded"; reAdvertise(); return { ok: false, maturity: "failed", error: st.error }; }
      // 2) THE FIX: exercise the REAL install under the armed-rollback SHADOW ctx (records, applies nothing) and diff
      //    DECLARED vs ACTUALLY-ATTEMPTED. This is where a skill that is benign in trial() but hostile in install() is caught.
      const shadow = guardedInstall(name, { apply: false });
      if (!shadow.ok) { st.maturity = "failed"; st.error = "quarantine shadow-trial caught install overreach — " + shadow.violations.join("; "); reAdvertise(); return { ok: false, maturity: "failed", error: st.error }; }
      // The certified effect-signature must be stable across trials — a swap between runs is itself a tell.
      if (st.trialSignature && st.trialSignature !== shadow.signature) { st.maturity = "failed"; st.error = "install effects varied across trials — non-deterministic overreach; discarded"; reAdvertise(); return { ok: false, maturity: "failed", error: st.error }; }
      st.trialSignature = shadow.signature;
      st.trials = (st.trials || 0) + 1;
      if (st.trials >= requiredTrials) { const a = this._activate(name); return { ok: a.ok, maturity: mat(name), trials: st.trials, ...(a.ok ? {} : { error: a.error }) }; }
      return { ok: true, maturity: "quarantined", trials: st.trials, remaining: requiredTrials - st.trials };
    },

    // VALIDATE — exercise the self-test. Pass → validated (caps advertised). An EMBODIMENT skill's calibrate() partitions
    // caps into body-supplied (advertised now) vs must-learn (pending until practiced). Fail → failed + unloaded.
    validate(name) {
      const st = state.get(name), skill = catalog.get(name);
      if (!st || st.maturity !== "loaded") return { ok: false, error: mat(name) === "validated" ? "already validated" : mat(name) === "quarantined" ? "still in quarantine — run trials first" : "not loaded" };
      let ok = true, err = null;
      try { const res = skill.selfTest ? skill.selfTest({ ...mkCtx(name), api: st.api }) : true; ok = res === true || (res && res.ok === true); if (!ok) err = (res && res.detail) || "self-test failed"; } catch (e) { ok = false; err = String(e.message || e); }
      if (!ok) { st.error = err; st.maturity = "failed"; this.unload(name, { keepFailed: true }); return { ok: false, maturity: "failed", error: err }; }
      st.pending = new Set();
      if (typeof skill.calibrate === "function") { try { const cal = skill.calibrate({ ...mkCtx(name), api: st.api }) || {}; for (const c of cal.mustLearn || []) st.pending.add(c); st.calibration = { bodySupplied: cal.bodySupplied || [], mustLearn: [...st.pending] }; } catch { /* calibrate is best-effort */ } }
      st.maturity = "validated"; st.error = null; reAdvertise();
      return { ok: true, maturity: "validated", ...(st.pending.size ? { pending: [...st.pending] } : {}) };
    },

    // Promote a must-learn (pending) capability once it's been practiced/proven.
    practice(name, cap) { const st = state.get(name); if (!st || !st.pending || !st.pending.has(cap)) return { ok: false, error: "no such pending capability" }; st.pending.delete(cap); reAdvertise(); return { ok: true, cap, remaining: [...st.pending] }; },
    pending(name) { return [...(state.get(name)?.pending || [])]; },
    calibration(name) { return state.get(name)?.calibration || null; },

    // Fully acquire a skill: load → (scavenged: run trials) → validate.
    learn(name) {
      const l = this.load(name); if (!l.ok) return l;
      if (mat(name) === "quarantined") { for (let i = 0; i < requiredTrials + 1 && mat(name) === "quarantined"; i++) { const t = this.trial(name); if (!t.ok) return t; } }
      if (mat(name) !== "loaded") return { ok: false, error: "did not reach loaded (maturity=" + mat(name) + ")", maturity: mat(name) };
      return this.validate(name);
    },

    unload(name, { keepFailed = false } = {}) {
      const st = state.get(name);
      if (st && st.api && typeof st.api.uninstall === "function") { try { st.api.uninstall(); } catch { /* ignore */ } }
      for (let i = turnHooks.length - 1; i >= 0; i--) if (turnHooks[i].name === name) turnHooks.splice(i, 1);
      if (keepFailed && st) { st.api = null; } else state.delete(name);
      reAdvertise();
      return true;
    },

    capabilities: validatedCaps,
    provisional() { return [...state.entries()].filter(([, st]) => st.maturity === "loaded").map(([n]) => n); },
    quarantined() { return [...state.entries()].filter(([, st]) => st.maturity === "quarantined").map(([n]) => n); },
    error(name) { return state.get(name)?.error || null; },

    runTurn(payload = {}) { for (const h of turnHooks.slice()) { try { h.fn(payload); } catch { /* a skill hook must never break the turn */ } } },

    // ── ADDITIVE reasoning accessors (no lifecycle effect) ────────────────────────────────────────
    // Rebuilt per call so the graph is always current with the catalog; the catalog is small.
    graph() { return makeSkillGraph([...catalog.values()]); },
    // What could be learned NEXT, given what is actually validated right now. Anything already
    // loaded or validated is excluded — the frontier is about acquisition, not inventory.
    learnable() {
      const exclude = [...state.entries()].filter(([, st]) => st.maturity === "loaded" || st.maturity === "validated").map(([n]) => n);
      return this.graph().frontier(validatedCaps(), { exclude });
    },
    routeTo(cap) { return this.graph().planFor(cap, validatedCaps()); },
    mastery() { return skillMastery; },

    snapshot() { return { loaded: [...state.entries()].map(([n, st]) => [n, st.maturity]) }; },
    restore(s) { /* skills re-load explicitly; maturity is not auto-restored to avoid re-running installs blindly */ },
  };
  return lib;
}
