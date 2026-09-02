// plugins.js — the DLC / extension system. The brain is a stack of faculties over a substrate; this lets new CONTENT
// (vocabulary), ABILITIES (faculties), and BEHAVIOURS (lifecycle hooks) be added LATER without editing core — a plugin
// installs itself into an app instance. It builds on the Phase-0 faculty registry (which already gives any registered
// faculty free persistence + ablation): a plugin is just a bundle of registrations + content + hooks.
//
// A plugin is `{ name, version?, install(ctx) }`. Its install() receives a context whose calls accumulate into this
// host; the app then reads the host to graft the additions in. Everything is PER-APP (a plugin installed on one
// companion doesn't leak into another) and inert by default (no plugins → zero behaviour change).
//
//   const nautical = {
//     name: "nautical-dlc", version: "1.0.0",
//     install(ctx) {
//       ctx.vocab("positive", ["seaworthy", "shipshape"]);            // extend the affect lexicon
//       ctx.vocab("disgust",  ["barnacled", "brackish"]);
//       ctx.faculty("navigator", (deps) => makeNavigator(deps));       // add an ability (persisted like any faculty)
//       ctx.onTurn(({ app, result }) => { /* react each turn */ });    // hook a behaviour
//       ctx.fact("the user keeps a sloop named Kestrel");              // seed content/knowledge
//     },
//   };
//   const app = makeApp({ ..., plugins: [nautical] });

const LEX_CATEGORIES = ["positive", "negative", "reward", "threat", "disgust", "desire", "challenge", "playfulBid"];

export function makePluginHost() {
  const installed = [];
  const vocab = {};                 // affect-lexicon extensions, merged into extractFeatures per turn
  for (const c of LEX_CATEGORIES) vocab[c] = [];
  const faculties = [];             // { name, factory, opts }
  const hooks = { turn: [], rest: [], init: [] };
  const facts = [];
  let lexCache;                     // memoized merged lexicon (rebuilt only when vocab changes) — read once per turn

  function makeCtx(pluginName) {
    const ctx = {
      // Extend an affect-lexicon category so new words register as affect (positive/negative/reward/threat/disgust).
      vocab(category, words) {
        if (!vocab[category]) throw new Error(`plugin ${pluginName}: unknown lexicon category "${category}" (use ${LEX_CATEGORIES.join("/")})`);
        for (const w of [].concat(words)) if (w) vocab[category].push(String(w).toLowerCase());
        lexCache = undefined; // invalidate the memo
        return ctx;
      },
      // Register a new faculty (ability). `factory(deps)` returns the faculty; if it has snapshot/restore it is
      // persisted, and ablation.no<Name> disables it. Reachable at runtime via app.faculty(name).
      faculty(name, factory, opts = {}) {
        if (!name || typeof factory !== "function") throw new Error(`plugin ${pluginName}: faculty needs a name + factory`);
        faculties.push({ name, factory, opts, plugin: pluginName });
        return ctx;
      },
      onTurn(fn) { if (typeof fn === "function") hooks.turn.push(fn); return ctx; },   // ({ app, message, result }) after each turn
      onRest(fn) { if (typeof fn === "function") hooks.rest.push(fn); return ctx; },   // ({ app }) on consolidation/sleep
      onInit(fn) { if (typeof fn === "function") hooks.init.push(fn); return ctx; },   // ({ app }) once, after the app is built
      fact(text) { if (text) facts.push(String(text)); return ctx; },                  // seed durable knowledge
    };
    return ctx;
  }

  return {
    install(plugin) {
      if (!plugin || typeof plugin.install !== "function") throw new Error("a plugin must be { name, install(ctx) }");
      const name = plugin.name || "unnamed-plugin";
      plugin.install(makeCtx(name));
      installed.push({ name, version: plugin.version || "0" });
    },
    // The merged affect-lexicon extension to hand extractFeatures (only categories that got words).
    lexicon() { if (lexCache !== undefined) return lexCache; const out = {}; for (const c of LEX_CATEGORIES) if (vocab[c].length) out[c] = vocab[c].slice(); lexCache = Object.keys(out).length ? out : null; return lexCache; },
    faculties, hooks, facts,
    list: () => installed.slice(),
  };
}
