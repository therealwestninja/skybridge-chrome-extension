'use strict';
/* rook-atlas.js - the Capability Atlas.
 *
 * One self-describing catalog of every external surface Rook can reach - model "mouths",
 * image backends, and web tools - with the metadata the brain needs to reason about them:
 * what each does, how to call it, WHEN it applies, which surfaces it works on, what it needs
 * (anchor / ollama / CORS), its auth + anti-bot posture, privacy cost, and live status.
 *
 * The deterministic council (nation.js) decides the *need* ("they want an image", "this needs
 * a web fact"); the Atlas knows the *surfaces* and picks the right one for the current context.
 * Kept as pure data + functions (no DOM) so the console, the background worker, and the bridge
 * page can all consult the same source of truth.
 *
 * UMD-ish: attaches RookAtlas to self/window/global.
 */
(function (root) {
  // surfaces: 'perchance' (on a perchance.org generator), 'extension' (Rook MV3 on any page),
  //           'standalone' (the demo / file). needs: capabilities the runtime must provide.
  var CAPABILITIES = [
    // ---- model "mouths" (write the words) ----
    { id: 'reflex', kind: 'model', label: 'Reflex (offline)',
      what: 'Instant brain-steered voice with no network or model.',
      how: 'Settings > Brain > Backend -> Reflex. Always the safe fallback.',
      when: 'No model reachable, or privacy/offline mode.',
      surfaces: '*', needs: [], auth: 'none', antibot: 'none', privacy: 'on-device', cost: 'free', status: 'ready' },
    { id: 'ollama', kind: 'model', label: 'Local model (Ollama)',
      what: 'A model running locally via Ollama, proxied through the worker.',
      how: 'Run Ollama (OLLAMA_ORIGINS=*); pick it in Backend, or ?model=ollama.',
      when: 'You want a private local LLM and have Ollama up.',
      surfaces: ['extension', 'standalone'], needs: ['ollama'], auth: 'none', antibot: 'none', privacy: 'on-device', cost: 'free', status: 'opt-in' },
    { id: 'chrome-ai', kind: 'model', label: 'Chrome built-in AI (Gemini Nano)',
      what: "Chrome's ~4GB on-device model via the Prompt API - no key, no server, NO install (Chrome ships it).",
      how: 'Auto-detected where window.LanguageModel exists (Chrome 138+ desktop). Picks it as a local mouth.',
      when: 'You want a fully on-device model with nothing to install or run.',
      surfaces: ['extension', 'standalone'], needs: ['language-model'], auth: 'none', antibot: 'none', privacy: 'on-device', cost: 'free', status: 'auto' },
    { id: 'perchance-model', kind: 'model', label: 'Perchance (DeepSeek) - free',
      what: "Perchance's own free text model via aiTextPlugin (AICC bracketed-name format).",
      how: 'Default on the rook-ai generator. Calls text-generation.perchance.org via the plugin.',
      when: 'On a Perchance generator and you want a free cloud model.',
      surfaces: ['perchance'], needs: [], auth: 'userKey (plugin-managed)', antibot: 'human-verify', privacy: 'perchance', cost: 'free', status: 'ready', doc: 'docs/perchance-integration-surface.md' },
    { id: 'skybridge-model', kind: 'model', label: 'Your own model (Rook extension)',
      what: "Borrow the extension anchor's model over skybridge - your key never crosses the bridge.",
      how: 'On the rook-ai page with the Rook extension installed: Backend -> Your own model.',
      when: 'On Perchance but you want your local/own model instead of Perchance\u2019s.',
      surfaces: ['perchance'], needs: ['anchor'], auth: 'anchor-side', antibot: 'none', privacy: 'on-device', cost: 'free', status: 'needs-anchor' },
    // NOTE: the "borrow a foreign chatbot" model backends (duck.ai / ChatGPT / Gemini / Bing Copilot) were RETIRED
    // and their adapters tree-shaken (2026-08-31) - Rook's mouth is local Ollama + the Perchance relay. Not catalogued.

    // ---- image backends (draw) ----
    { id: 'perchance-image', kind: 'image', label: 'Perchance image (textToImagePlugin)',
      what: 'Text->image via Perchance (768x768, guidanceScale 7, AICC negative-prompt defaults).',
      how: '/img <prompt>. Calls image-generation.perchance.org through the plugin (userKey/ad-gated).',
      when: 'They ask for a picture / portrait / scene on Perchance.',
      surfaces: ['perchance'], needs: [], i2i: false, auth: 'userKey + adAccessCode (plugin-managed)', antibot: 'human-verify', privacy: 'perchance', cost: 'ad-gated', status: 'ready', doc: 'docs/perchance-integration-surface.md' },
    { id: 'frosting', kind: 'image', label: 'frosting.ai',
      what: 'Text->image AND image-to-image (upload a source). Clean REST API, no Turnstile.',
      how: 'Capture the live JWT; POST /files/upload (i2i) -> generate -> poll. (adapter pending generate payload.)',
      when: 'They want image-to-image, or an image off-Perchance.',
      surfaces: ['extension', 'standalone'], needs: ['frosting-jwt'], i2i: true, auth: 'JWT in body (captured)', antibot: 'none (CDN only)', privacy: 'frosting.ai', cost: 'account/anon', status: 'planned', doc: 'docs/image-backends.md' },
    { id: 'craiyon', kind: 'image', label: 'Craiyon',
      what: 'Free text->image and image-to-image (upload->edit).',
      how: 'POST api2.craiyon.com/search {prompt,negative_prompt,model,aspect_ratio,n_images}; i2i: upload (file+hash) -> {prompt,image_id,mode:"edit"}.',
      when: 'They want a free image / image-to-image off-Perchance.',
      surfaces: ['extension', 'standalone'], needs: ['anchor-or-cors'], i2i: true, auth: 'anonymous', antibot: 'Cloudflare (cf-chl)', privacy: 'craiyon', cost: 'free', status: 'planned', doc: 'docs/image-backends.md' },
    { id: 'gencraft', kind: 'image', label: 'Gencraft',
      what: 'Text->image + image-to-image; model choice, sizes, strength.',
      how: 'POST api.gencraft.com/api/v38/prompt/generate {prompt_text,...,generation_type,width,height,components:[{generic_model_id,strength}]}; Bearer auth; async - poll /user/history.',
      when: 'They want higher-quality / model-choice image gen off-Perchance.',
      surfaces: ['extension'], needs: ['gencraft-token'], i2i: true, auth: 'Bearer JWT from localStorage["sid"] (your session)', antibot: 'none', privacy: 'gencraft', cost: 'account/credits', status: 'beta', doc: 'docs/image-backends.md', note: 'Adapter built (adapter-gencraft.js). Best on a gencraft.com tab (session + same-origin); registers as page:gencraft via /usepage. Confirm result-URL + i2i field on first live run.' },

    // ---- page perception (Rook sits ON the page) ----
    { id: 'page', kind: 'page', label: 'Read this page',
      what: 'Reads the page Rook is on - title, metadata, headings, a text sample, stats - and can search its text.',
      how: 'Auto on "what is this / what\'s on this page / read this page"; /page; /find <text>.',
      when: 'The user asks about the page/site/article they\'re looking at.',
      surfaces: '*', needs: [], auth: 'none', antibot: 'none', privacy: 'on-device (reads the open page locally)', cost: 'free', status: 'ready' },

    // ---- web tools (ground the brain in live facts) ----
    { id: 'wikipedia', kind: 'web', label: 'Wikipedia lookup',
      what: 'Encyclopedic summary for a named topic; injected into the prompt as trusted fact.',
      how: 'Auto on "who is / what is / tell me about X", or /wiki <topic>.',
      when: 'A turn names a person/place/thing the brain should ground on.',
      surfaces: '*', needs: [], auth: 'none', antibot: 'none', privacy: 'sends query (Wikimedia)', cost: 'free', status: 'ready' },
    { id: 'search', kind: 'web', label: 'Web search (DuckDuckGo)',
      what: 'Instant-answer / top results for a query; injected into the prompt.',
      how: 'Auto on "search for / look up / google X", or /search <query>.',
      when: 'A turn needs current/open-web info, not encyclopedic.',
      surfaces: '*', needs: ['anchor-or-cors'], auth: 'none', antibot: 'none', privacy: 'sends query (DuckDuckGo)', cost: 'free', status: 'ready', note: 'Needs the extension anchor\u2019s fetch off a CORS-friendly host (DDG isn\u2019t CORS-open).' },
    { id: 'dictionary', kind: 'web', label: 'Dictionary (definitions)',
      what: 'Definitions + part of speech + phonetics for an English word.',
      how: 'Auto on "define X / what does X mean / meaning of X", or /define <word>.',
      when: 'A turn hinges on a word the brain (or user) may not know.',
      surfaces: '*', needs: [], auth: 'none', antibot: 'none', privacy: 'sends the word (dictionaryapi.dev)', cost: 'free', status: 'ready' },
    { id: 'weather', kind: 'web', label: 'Weather (open-meteo)',
      what: 'Current temperature, conditions, and wind for a named place.',
      how: 'Auto on "weather in X", or /weather <place>. Geocodes the place, then fetches the forecast.',
      when: 'A turn asks about the weather somewhere.',
      surfaces: '*', needs: [], auth: 'none', antibot: 'none', privacy: 'sends the place name (open-meteo)', cost: 'free', status: 'ready' },
    { id: 'translate', kind: 'web', label: 'Translation (Google gtx)',
      what: 'Two-way translation at the edges - reads the user\u2019s language; the brain stays English.',
      how: 'Automatic: a non-English-looking turn is detected and translated both ways. /lang <code> to pin a language; /translate <text> for one-off.',
      when: 'The user writes in another language (auto-detected), a language is pinned, or a turn asks to translate.',
      surfaces: '*', needs: ['anchor-or-cors'], auth: 'none', antibot: 'none', privacy: 'sends text (Google Translate)', cost: 'free', status: 'ready',
      note: 'Free unofficial endpoint, no key; on any failure it falls back to the original text (never blocks).' },
    { id: 'fetch', kind: 'web', label: 'Web fetch (anchor)',
      what: "Borrow the extension worker's unsandboxed, hardened cross-origin fetch.",
      how: 'Used by web tools when on a sandboxed host; skybridge fetch -> background worker.',
      when: 'A tool must reach a URL the page sandbox/CORS would block.',
      surfaces: ['perchance', 'extension'], needs: ['anchor'], auth: 'none', antibot: 'none', privacy: 'sends URL', cost: 'free', status: 'ready', note: 'Loopback/private hosts blocked; anonymous; 6s/200KB caps.' },

    // ---- on-device faculties (no network) ----
    { id: 'calc', kind: 'local', label: 'Guarded math',
      what: 'Exact arithmetic / %, powers, unit conversion - hardened vs calc-buffer attacks.',
      how: 'Auto when a turn contains a computable expression, or /calc.',
      when: 'A turn needs an exact number.',
      surfaces: '*', needs: [], auth: 'none', antibot: 'none', privacy: 'on-device', cost: 'free', status: 'ready' },
    { id: 'reminders', kind: 'local', label: 'Reminders & timers',
      what: 'Durable reminders that survive reloads; NL planner ("remind me ... in 30m").',
      how: '/remind <dur> <text>, /reminders, or natural language.',
      when: 'They ask to be reminded or set a timer.',
      surfaces: '*', needs: [], auth: 'none', antibot: 'none', privacy: 'on-device', cost: 'free', status: 'ready' },
    { id: 'memory', kind: 'local', label: 'Progressive memory',
      what: 'Rolling summary + relevance-ranked episodes recalled into the prompt.',
      how: 'Automatic each turn; /sum /epi /ctx to inspect.',
      when: 'Always - grounds the brain in the conversation so far.',
      surfaces: '*', needs: [], auth: 'none', antibot: 'none', privacy: 'on-device', cost: 'free', status: 'ready' },
    // Twitch assisted-chat entry REMOVED 2026-08-31: twitch.tv host-permission + page-sensor adapter were tree-shaken with the VTuber bridge, so this capability can no longer run. Discord assisted-chat (below) is unaffected.
    { id: 'page:discord-chat', kind: 'chat', label: 'Discord chat (your tab)',
      what: 'Read a Discord channel (remembering each user) and, when approved, type+send messages via the Slate editor.',
      how: 'Open discord.com, /trust allow it, /chat on. Assisted by default; /chat kill stops.',
      when: 'Helping in your own server/channel.',
      surfaces: ['extension'], needs: ['tab', 'login'], auth: 'cookie', antibot: 'self-bot-risk', privacy: 'on-device', cost: 'free', status: 'beta' },
  ];

  // ---- context helpers ----
  function surfaceOk(cap, surface) { return cap.surfaces === '*' || (cap.surfaces.indexOf(surface) >= 0); }
  function needsMet(cap, ctx) {
    var have = (ctx && ctx.have) || {};
    return (cap.needs || []).every(function (n) {
      if (n === 'anchor-or-cors') return true;            // soft: works via anchor OR a CORS-friendly host
      if (n === 'tab' || n === 'login') return true;      // best-effort; runtime confirms at call time
      return !!have[n];                                   // hard: ollama / anchor / frosting-jwt
    });
  }
  function ctxOf(ctx) {
    ctx = ctx || {};
    return { surface: ctx.surface || 'standalone', have: ctx.have || {} };
  }

  // capabilities visible on the current surface (optionally a single kind)
  function list(ctx, kind) {
    ctx = ctxOf(ctx);
    return CAPABILITIES.filter(function (c) { return surfaceOk(c, ctx.surface) && (!kind || c.kind === kind); });
  }
  function describe(id) { for (var i = 0; i < CAPABILITIES.length; i++) if (CAPABILITIES[i].id === id) return CAPABILITIES[i]; return null; }

  // pick the best capability for a need: { kind, i2i?, prefer?:id }. Ranks by:
  // requested-id > needs-met & ready > needs-met > surface-only; i2i filter is hard for images.
  function pick(need, ctx) {
    ctx = ctxOf(ctx); need = need || {};
    var cands = list(ctx, need.kind).filter(function (c) {
      if (need.i2i && c.kind === 'image' && !c.i2i) return false;
      return true;
    });
    function score(c) {
      var s = 0;
      if (need.prefer && c.id === need.prefer) s += 100;
      if (needsMet(c, ctx)) s += 10;
      if (c.status === 'ready') s += 5;
      if (c.status === 'planned') s -= 3;
      if (c.cost === 'free') s += 1;
      return s;
    }
    cands.sort(function (a, b) { return score(b) - score(a); });
    return cands[0] || null;
  }

  // a compact, surface-aware line for the system prompt so the MODEL knows what's live and can
  // reference results. (Deterministic detect()/router still does the actual triggering.)
  function summaryForPrompt(ctx) {
    ctx = ctxOf(ctx);
    var web = list(ctx, 'web').filter(function (c) { return needsMet(c, ctx) && c.status === 'ready'; }).map(function (c) { return c.label.toLowerCase(); });
    var img = list(ctx, 'image').filter(function (c) { return needsMet(c, ctx) && c.status === 'ready'; });
    var bits = [];
    if (web.length) bits.push('live web lookups (' + web.join(', ') + ')');
    if (img.length) bits.push('image generation');
    bits.push('exact math');
    if (!bits.length) return '';
    return 'Tools that run automatically when relevant (you may rely on and reference their results): ' + bits.join('; ') + '.';
  }

  root.RookAtlas = { CAPABILITIES: CAPABILITIES, list: list, describe: describe, pick: pick, summaryForPrompt: summaryForPrompt };
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : this));
