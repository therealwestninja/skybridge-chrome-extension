'use strict';
/* rook-core.js - Rook AI's browser-native brain wrapper.
 *
 * Loads AFTER brain.min.js (self.ChloeBrain), nation.js (self.ChloeNation) and
 * intent-directive.js (self.RookIntentDirective). It mirrors the headless
 * package's council.js + index.js + adapters/ollama.js - but with zero require()
 * so it runs in a service worker, a content script, or a plain page.
 *
 * The brain bytes themselves are untouched: the deterministic council decides
 * WHO speaks and WITH WHAT INTENT; an adapter writes the words. Clean seam.
 *
 *   council.decide(text) -> { intent, directive, speaker, vibe, floor }   (no model)
 *   agent.chat(text)     -> decide -> system prompt -> generate -> evolve  (with a model)
 */
(function (root) {
  var Nation = root.ChloeNation;
  var Brain = root.ChloeBrain;
  var INTENT_DIRECTIVE = root.RookIntentDirective || {};
  if (!Nation || !Brain) throw new Error('[rook-core] load brain.min.js + nation.js first');

  var CORE = Nation.NATIONS.map(function (n) { return n.id; });
  var EXTRA_IDS = Nation.EXTRAS.map(function (e) { return e.id; });

  function buildRoster(faculties) {
    var want = {};
    (faculties || []).forEach(function (f) { want[f] = true; });
    return Nation.NATIONS.concat(Nation.EXTRAS.filter(function (e) { return want[e.id]; }));
  }

  // ---- Council: the deterministic decision layer (mirror of council.js) ----
  function Council(opts) {
    opts = opts || {};
    this.opts = opts;
    this.faculties = opts.faculties || [];
    this.noise = opts.noise || 0;
    this.frame = opts.frame || null;
    this.weights = opts.weights || {};            // per-faculty vote weights (the sliders)
    this.settle = !!opts.settle;                  // RECURRENCE: lateral bond-settling before the vote (forwarded into nation cfg)
    this.composeIntents = opts.composeIntents !== false;   // INTENT COMPOSITION: blend the winner with a strong runner-up (default on)
    this.user = opts.user || { name: 'You', description: '' };
    this._build();
  }
  Council.prototype._build = function () {
    this.army = Nation.createArmy({
      brain: Brain,
      config: { noise: this.noise, weights: this.weights, settle: this.settle },   // weightOf(id) reads config.weights; cfg.settle gates lateral recurrence
      nations: buildRoster(this.faculties),
    });
    this.setUser(this.user.name, this.user.description);
  };
  Council.prototype.setUser = function (name, description) {
    this.user = { name: name || 'You', description: description || '' };
    try {
      this.army.setUserDescription([this.user.name, this.user.description].filter(Boolean).join(' - ') || 'You');
    } catch (e) {}
  };
  Council.prototype.setFrame = function (frame) { this.frame = frame || null; };
  Council.prototype.setWeights = function (w) { this.weights = w || {}; this._build(); };
  Council.prototype.setFaculties = function (f) { this.faculties = f || []; this._build(); };
  Council.prototype.perceiveUser = function (text, valence) {
    this.army.perceive({ who: this.user.name, role: 'user', text: String(text || ''), valence: (valence == null ? null : valence) });
  };
  Council.prototype.hearReply = function (speakerId, text) {
    try { this.army.reactToSpoken(speakerId || (this.opts.character && this.opts.character.name) || 'Rook', String(text || '')); } catch (e) {}
  };
  Council.prototype.feedback = function (kind, toward) { try { this.army.ingestReaction({ kind: kind, toward: toward }); } catch (e) {} };
  Council.prototype.decide = function (text) {
    var self = this;
    if (text != null) this.perceiveUser(text);
    return Promise.resolve(this.army.deliberateIntents({ prompt: String(text || ''), frame: this.frame })).then(function (dec) {
      var kind = dec && dec.intent ? dec.intent.kind : null;
      var leans = (dec && dec.intents) || (kind ? [{ kind: kind, lead: true }] : []);
      var intents = leans.map(function (x) { return x.kind; }).filter(Boolean);
      var directive = kind ? (INTENT_DIRECTIVE[kind] || '') : '';
      // INTENT COMPOSITION: when the society backed a strong, distinct runner-up, blend it in. The LEAD directive stays
      // verbatim on line 1 (so the ReflexAdapter still resolves the opener + the mouth keeps its primary aim); the
      // secondary lean is appended on line 2, which only a real model reads (Reflex speaks line 1 only).
      if (self.composeIntents && leans.length >= 2) {
        var leadDir = INTENT_DIRECTIVE[leans[0].kind] || directive;
        var secDir = INTENT_DIRECTIVE[leans[1].kind] || '';
        if (leadDir && secDir) directive = leadDir + '\nAlso let a thread of ' + leans[1].kind + ' through: ' + secDir.charAt(0).toLowerCase() + secDir.slice(1);
      }
      return {
        intent: kind,
        intents: intents,
        directive: directive,
        speaker: dec && dec.speaker ? (dec.speaker.id || dec.speaker) : null,
        vibe: (dec && dec.vibe) || null,
        floor: (dec && dec.floor) || [],
      };
    });
  };
  Council.prototype.inspect = function () { try { return this.army.inspect(); } catch (e) { return null; } };
  Council.prototype.about = function (q) { try { return this.army.about(q); } catch (e) { return ''; } };
  // ---- Nation status snapshot + health-check (introspection of the live council) ----
  Council.prototype.status = function () {
    try {
      var a = this.army, ins = a.inspect() || {}, council = ins.council || [];
      var moods = council.map(function (n) { return n.mood; }).filter(function (m) { return typeof m === 'number'; });
      var avgMood = moods.length ? Math.round(moods.reduce(function (x, y) { return x + y; }, 0) / moods.length * 100) / 100 : null;
      return {
        identity: (typeof a.identity === 'string') ? a.identity : (a.identity && (a.identity.name || a.identity.who)) || null,
        roster: (a.nations || []).length,
        seated: ins.room || [], vibe: ins.vibe || null, avgMood: avgMood, state: a.state || {},
        standings: council.slice().sort(function (p, q) { return (q.relevance || 0) - (p.relevance || 0); }).slice(0, 5)
          .map(function (n) { return { id: n.id, relevance: n.relevance, weight: n.weight, mood: n.mood, reads: n.reads, spokeLast: n.spokeLast }; }),
      };
    } catch (e) { return { error: String(e && e.message || e) }; }
  };
  Council.prototype.health = function () {
    var checks = [];
    try {
      var ins = this.army.inspect() || {}, seated = ins.room || [], council = ins.council || [];
      checks.push({ name: 'seated', ok: seated.length >= 1, detail: seated.length + ' faculty seated' + (seated.length ? '' : ' - she would go silent!') });
      var anyW = council.map(function (n) { return n.weight; }).some(function (w) { return typeof w === 'number' && w > 0; });
      checks.push({ name: 'vote-weights', ok: anyW, detail: anyW ? 'non-zero' : 'ALL zero - voting broken' });
      var v = ins.vibe;
      var vibeOk = !!(v && typeof v.tone !== 'undefined' && isFinite(v.warmth) && isFinite(v.tension));
      checks.push({ name: 'vibe', ok: vibeOk, detail: vibeOk ? ('tone ' + v.tone) : 'missing/NaN' });
    } catch (e) { checks.push({ name: 'inspect', ok: false, detail: String(e && e.message || e) }); }
    return checks;
  };

  // ---- OllamaAdapter: local model over HTTP (mirror of adapters/ollama.js) ----
  function OllamaAdapter(opts) {
    opts = opts || {};
    this.endpoint = String(opts.endpoint || 'http://127.0.0.1:11434').replace(/\/+$/, '');
    this.model = opts.model || opts.name || 'llama3.1';
    this.options = opts.options || {};
    this.fetchImpl = opts.fetch || root.fetch;
  }
  OllamaAdapter.prototype.label = 'ollama';   // so the Overseer/telemetry don't read it as undefined -> 'reflex'
  OllamaAdapter.prototype.available = function () {
    var self = this;
    if (typeof this.fetchImpl !== 'function') return Promise.resolve(false);
    // fast-fail: best-effort abort PLUS a hard race timeout, because some embedders
    // never settle (or never abort) a fetch to a dead localhost port. The race
    // guarantees this resolves in <=900ms regardless; a dangling fetch is harmless.
    var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    (root.setTimeout || setTimeout)(function () { try { if (ctl) ctl.abort(); } catch (e) {} }, 800);
    var probe = this.fetchImpl(this.endpoint + '/api/tags', ctl ? { signal: ctl.signal } : undefined).then(function (r) {
      if (!r || !r.ok) return false;
      return r.json().then(function (j) {
        if (!j || !Array.isArray(j.models)) return true;
        return j.models.length > 0;
      }).catch(function () { return true; });
    }).catch(function () { return false; });
    var timeout = new Promise(function (res) { (root.setTimeout || setTimeout)(function () { res(false); }, 900); });
    return Promise.race([probe, timeout]);
  };
  OllamaAdapter.prototype.chat = function (messages, o) {
    o = o || {};
    var stream = !!o.stream, onToken = o.onToken;
    var options = o.stop ? Object.assign({}, this.options, { stop: o.stop }) : this.options;
    var self = this;
    // think defaults OFF (keeps the character's voice clean); callers like the Game Bench pass think:true
    // for reasoning tasks (the <think> block is still stripped from the returned text by stripThink).
    return this.fetchImpl(this.endpoint + '/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, messages: messages, stream: stream, think: !!o.think, options: options }),
    }).then(function (res) {
      if (!res || !res.ok) {
        return (res ? res.text().catch(function () { return ''; }) : Promise.resolve('no response'))
          .then(function (t) { throw new Error('ollama ' + (res && res.status) + ': ' + t); });
      }
      if (!stream) return res.json().then(function (j) { return stripThink((j && j.message && j.message.content) || ''); });
      var text = '', buf = '';
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) return stripThink(text);
          buf += decoder.decode(r.value, { stream: true });
          var nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            var line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            try {
              var j = JSON.parse(line);
              var t = j && j.message && j.message.content;
              if (t) { text += t; if (onToken) onToken(t); }
            } catch (e) {}
          }
          return pump();
        });
      }
      return pump();
    });
  };

  // ---- stripThink + LocalModelAdapter: provider-agnostic LOCAL model (Qwen 3 et al.) over HTTP ----
  //   Talks to EITHER Ollama (POST /api/chat, probe /api/tags) OR an OpenAI-compatible server
  //   (LM Studio / llama.cpp / vLLM - POST /v1/chat/completions, probe /v1/models). Auto-detects
  //   which is up (or honour opts.kind). Same adapter shape as OllamaAdapter, so RookConsole + the
  //   brain run it unchanged. QWEN-3 AWARE: Qwen 3 is a hybrid "thinking" model - it emits
  //   <think>...</think> reasoning by default. We ask the server to disable it (Ollama think:false /
  //   OpenAI enable_thinking:false) AND strip any <think>...</think> as the reliable fallback, so
  //   chain-of-thought never bleeds into the character's voice.
  function stripThink(s) {
    s = String(s == null ? '' : s);
    s = s.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*$/i, '');   // closed blocks, then a dangling unclosed one
    return s.replace(/^\s+/, '').replace(/\s+$/, '');
  }
  function LocalModelAdapter(opts) {
    opts = opts || {};
    this.endpoint = String(opts.endpoint || '').replace(/\/+$/, '');   // '' -> auto: try Ollama :11434 then OpenAI :1234
    this.model = opts.model || opts.name || 'qwen3';
    this.kind = opts.kind || 'auto';                                   // 'ollama' | 'openai' | 'auto'
    this.options = opts.options || {};
    this.fetchImpl = opts.fetch || root.fetch;
    this._resolved = null;                                             // {kind, base} once a server answers
  }
  LocalModelAdapter.prototype.label = 'local';
  LocalModelAdapter.prototype._candidates = function () {
    var c = [];
    if (this.endpoint) {
      if (this.kind === 'openai') c.push({ kind: 'openai', base: this.endpoint });
      else if (this.kind === 'ollama') c.push({ kind: 'ollama', base: this.endpoint });
      else { c.push({ kind: 'ollama', base: this.endpoint }); c.push({ kind: 'openai', base: this.endpoint }); }
    } else {
      if (this.kind !== 'openai') c.push({ kind: 'ollama', base: 'http://127.0.0.1:11434' });
      if (this.kind !== 'ollama') c.push({ kind: 'openai', base: 'http://127.0.0.1:1234' });
    }
    return c;
  };
  LocalModelAdapter.prototype._probe = function (cand) {
    var f = this.fetchImpl; if (typeof f !== 'function') return Promise.resolve(false);
    var url = cand.kind === 'ollama' ? cand.base + '/api/tags' : cand.base + '/v1/models';
    var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    (root.setTimeout || setTimeout)(function () { try { if (ctl) ctl.abort(); } catch (e) {} }, 800);
    var probe = f(url, ctl ? { signal: ctl.signal } : undefined).then(function (r) { return !!(r && r.ok); }).catch(function () { return false; });
    var timeout = new Promise(function (res) { (root.setTimeout || setTimeout)(function () { res(false); }, 900); });
    return Promise.race([probe, timeout]);
  };
  LocalModelAdapter.prototype.available = function () {
    var self = this, cands = this._candidates();
    return (function step(i) {
      if (i >= cands.length) return Promise.resolve(false);
      return self._probe(cands[i]).then(function (ok) { if (ok) { self._resolved = cands[i]; return true; } return step(i + 1); });
    })(0);
  };
  LocalModelAdapter.prototype.chat = function (messages, o) {
    o = o || {}; var self = this;
    return (this._resolved ? Promise.resolve(true) : this.available()).then(function (ok) {
      if (!ok || !self._resolved) throw new Error('no local model reachable (Ollama :11434 / OpenAI-compatible :1234) - is the server up with CORS open?');
      return self._resolved.kind === 'ollama' ? self._ollama(messages, o) : self._openai(messages, o);
    });
  };
  LocalModelAdapter.prototype._ollama = function (messages, o) {
    var f = this.fetchImpl, base = this._resolved.base, model = this.model;
    var options = o.stop ? Object.assign({}, this.options, { stop: o.stop }) : this.options;
    return f(base + '/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: model, messages: messages, stream: false, think: false, options: options }),
    }).then(function (res) {
      if (!res || !res.ok) return (res ? res.text().catch(function () { return ''; }) : Promise.resolve('')).then(function (t) { throw new Error('ollama ' + (res && res.status) + ': ' + t); });
      return res.json().then(function (j) { return stripThink((j && j.message && j.message.content) || ''); });
    });
  };
  LocalModelAdapter.prototype._openai = function (messages, o) {
    var f = this.fetchImpl, base = this._resolved.base, model = this.model;
    var body = { model: model, messages: messages, stream: false, chat_template_kwargs: { enable_thinking: false } };
    if (o.stop) body.stop = o.stop;
    return f(base + '/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (res) {
      if (!res || !res.ok) return (res ? res.text().catch(function () { return ''; }) : Promise.resolve('')).then(function (t) { throw new Error('openai ' + (res && res.status) + ': ' + t); });
      return res.json().then(function (j) { var ch = j && j.choices && j.choices[0] && j.choices[0].message; return stripThink((ch && ch.content) || ''); });   // ignore ch.reasoning_content (R1-style split)
    });
  };

  // ---- ReflexAdapter: a brain-steered voice with NO model (proves steering offline) ----
  // It cannot write like an LLM, but it visibly obeys the council's directive, so the
  // decision layer is demonstrable on a machine with nothing installed.
  var REFLEX_OPENERS = {
    comfort: ["Hey, I'm here.", "I've got you.", "Take a breath - I'm with you."],
    ground: ["Straight answer:", "Here's the honest version.", "Let's keep this clear."],
    recall: ["That connects to something you told me.", "I remember this matters to you."],
    caution: ["One thing gives me pause here.", "Gently - something feels a little off."],
    express: ["Okay, picture this.", "Here's how I see it, vividly."],
    protect: ["Your wellbeing comes first here.", "Let's look after you first."],
    play: ["Ha - alright.", "Okay, I'll bite - playfully."],
    lighten: ["Let's find the lighter side.", "Come on, a little levity."],
    ease: ["I'll keep this short.", "No rush. Quietly."],
    hold: ["I'll be straight about a limit.", "Here's a line I'll keep, kindly."],
    inhabit: ["*stays in the scene with you*", "I lean in, still in it."],
    initiate: ["Here's something I want.", "Let me take this somewhere."],
    feel: ["Honestly? This lands on me too.", "I feel that."],
    own: ["That's on me.", "You're right - I got that wrong."],
    apologize: ["I'm sorry, truly.", "My mistake - sorry."]
  };
  function ReflexAdapter() {}
  ReflexAdapter.prototype.label = 'reflex';
  ReflexAdapter.prototype.available = function () { return Promise.resolve(true); };
  ReflexAdapter.prototype.chat = function (messages, o) {
    o = o || {};
    var sys = (messages[0] && messages[0].content) || '';
    var dir = (sys.match(/Direction for your next reply:\s*([\s\S]*)$/m) || [])[1] || '';
    dir = dir.split('\n')[0].trim();
    var intentKey = '';
    for (var k in INTENT_DIRECTIVE) { if (INTENT_DIRECTIVE[k] === dir) { intentKey = k; break; } }
    var last = '';
    for (var i = messages.length - 1; i >= 0; i--) { if (messages[i].role === 'user') { last = messages[i].content; break; } }
    var openers = REFLEX_OPENERS[intentKey] || ["Okay."];
    // deterministic pick from the user's text length so it's stable, not random
    var opener = openers[(String(last).length) % openers.length];
    var body = dir ? (' ' + dir) : '';
    var out = opener + body;
    // stream it out a few chars at a time for a live feel
    if (o.stream && o.onToken) {
      var idx = 0, chunk = 3;
      return new Promise(function (resolve) {
        function tick() {
          if (idx >= out.length) return resolve(out);
          o.onToken(out.slice(idx, idx + chunk));
          idx += chunk;
          (root.setTimeout || setTimeout)(tick, 12);
        }
        tick();
      });
    }
    return Promise.resolve(out);
  };

  // ---- RookAgent: full turn (mirror of index.js Brain) ----
  function RookAgent(opts) {
    opts = opts || {};
    this.character = opts.character || { name: 'Rook', persona: '' };
    this.user = opts.user || { name: 'You', description: '' };
    this.maxHistory = opts.maxHistory || 24;
    this.council = new Council({ faculties: opts.faculties, noise: opts.noise, frame: opts.frame, weights: opts.weights, settle: opts.settle, composeIntents: opts.composeIntents, user: this.user, character: this.character });
    this.model = (opts.model && typeof opts.model.chat === 'function') ? opts.model : new ReflexAdapter();
    this.fallback = opts.fallback || new ReflexAdapter();
    this.history = [];
    this._probed = null;
  }
  RookAgent.prototype._system = function (decision, o) {
    o = o || {};
    var parts = [];
    parts.push(o.persona || this.character.persona || ('You are ' + this.character.name + '.'));
    if (this.user.description) parts.push("The person you're talking to: " + this.user.description + '.');
    if (o.facts) parts.push('# Notes the story has gathered\n' + o.facts);
    if (o.memory) parts.push('What you remember of this conversation (recalled):\n' + o.memory);
    if (o.abilities) parts.push(o.abilities);
    if (o.tools) parts.push('Just looked this up for you (use it if relevant, and trust it over your own memory):\n' + o.tools);
    if (o.now) parts.push('Right now it is ' + o.now + '. Use this for any time, date, scheduling, or reminder reasoning.');
    if (o.locus) parts.push(o.locus);   // the Global Workspace: every lobe's state, integrated - the mouth speaks FROM here
    if (o.confidence) parts.push(o.confidence);   // calibrated self-doubt: hedge honestly when she's not on solid ground
    if (o.style) parts.push(o.style);
    if (o.sys) parts.push('Standing directive (always honor): ' + o.sys);
    if (o.context) parts.push('Context from the page they are looking at (use it only if relevant):\n' + o.context);
    if (o.lang) parts.push('Reply in this language: ' + o.lang + '.');
    if (decision.directive) parts.push('Direction for your next reply (the council lead; if your integrated state above conflicts with it, the integrated state wins): ' + decision.directive);
    return parts.join('\n\n');
  };
  RookAgent.prototype._pickModel = function () {
    var self = this, now = Date.now();
    if (this._probed && (now - (this._probedAt || 0)) < 60000) return this._probed;   // re-probe at most once/min - a model can die or revive after the first probe
    this._probedAt = now;
    if (!this.model || this.model instanceof ReflexAdapter) { this._probed = Promise.resolve(this.model || this.fallback); return this._probed; }
    this._probed = Promise.resolve(this.model.available()).then(function (ok) {
      return ok ? self.model : self.fallback;
    }).catch(function () { return self.fallback; });
    return this._probed;
  };
  // pair-boundary-safe trim: after slicing to the tail, advance one entry if we'd start mid-pair (on an assistant turn)
  function _trimHistory(h, cap) {
    try {
      if (!Array.isArray(h) || h.length <= cap) return h;
      var start = h.length - cap;
      if (start > 0 && h[start] && h[start].role !== 'user') start++;
      return h.slice(start);
    } catch (e) { return h; }
  }
  RookAgent.prototype.chat = function (userText, o) {
    o = o || {};
    var self = this;
    var decision;
    return this.council.decide(userText).then(function (d) {
      decision = d;
      self.history.push({ role: 'user', content: String(userText || '') });
      return self._pickModel();
    }).then(function (model) {
      var messages = [{ role: 'system', content: self._system(decision, o) }].concat(self.history.slice(-self.maxHistory));
      if (typeof o.redact === 'function') { try { messages = messages.map(function (m) { return { role: m.role, content: o.redact(m.content) }; }); } catch (e) {} }   // EGRESS MOAT: redact secrets/PII before the payload crosses to a cloud model
      var usingReflex = model instanceof ReflexAdapter;
      try { if (typeof o.onTrace === 'function') o.onTrace('prompt', { system: messages[0].content, history: messages.slice(1), model: (model && model.label) || (usingReflex ? 'reflex' : 'model') }); } catch (e) {}   // trace harness: capture the EXACT prompt the mouth sends
      return Promise.resolve(model.chat(messages, { stream: o.stream, onToken: o.onToken })).then(function (text) {
        text = (typeof text === 'string') ? text : String(text == null ? '' : text);   // a bad adapter returning non-string must not corrupt history/persist
        if (text.length > 20000) text = text.slice(0, 20000);
        try { if (typeof o.onTrace === 'function') o.onTrace('mouth', { engine: usingReflex ? 'reflex' : (model && model.label || 'ollama'), raw: text }); } catch (e) {}   // trace: the raw model reply, pre-hygiene
        self.history.push({ role: 'assistant', content: text });
        self.council.hearReply(decision.speaker, text);
        if (self.history.length > self.maxHistory * 2) self.history = _trimHistory(self.history, self.maxHistory * 2);
        return { text: text, decision: decision, engine: usingReflex ? 'reflex' : (model && model.label || 'ollama') };
      }).catch(function (err) {
        // model died mid-call -> fall back to reflex so the turn never fails. Do NOT re-stream onToken:
        // the primary may have already emitted partial tokens, and a second stream would concatenate onto
        // them. Return the full reflex text; the caller uses r.text when r.error is set.
        self._probed = null;   // it just failed - force a fresh probe next turn
        return Promise.resolve(self.fallback.chat(messages, { stream: false })).then(function (text) {
          try { if (typeof o.onTrace === 'function') o.onTrace('mouth', { engine: 'reflex', raw: text, error: String(err && err.message || err) }); } catch (e) {}   // trace: the fallback reply after the primary died
          self.history.push({ role: 'assistant', content: text });
          self.council.hearReply(decision.speaker, text);
          if (self.history.length > self.maxHistory * 2) self.history = _trimHistory(self.history, self.maxHistory * 2);
          return { text: text, decision: decision, engine: 'reflex', error: String(err && err.message || err) };
        });
      });
    });
  };
  RookAgent.prototype.inspect = function () { return this.council.inspect(); };
  RookAgent.prototype.status = function () { return this.council.status(); };            // Nation status snapshot
  RookAgent.prototype.health = function () { return this.council.health(); };            // Nation health-check
  RookAgent.prototype.about = function (q) { return this.council.about(q); };
  RookAgent.prototype.decide = function (text) { return this.council.decide(text); };   // pure decision, no model
  RookAgent.prototype.setFrame = function (f) { this.council.setFrame(f); };
  RookAgent.prototype.setWeights = function (w) { this.council.setWeights(w); };
  RookAgent.prototype.feedback = function (kind, toward) { this.council.feedback(kind, toward || this.character.name); };
  RookAgent.prototype.setHistory = function (h) { this.history = Array.isArray(h) ? h.slice(-this.maxHistory * 2) : []; };

  root.RookBrain = {
    Council: Council, RookAgent: RookAgent,
    OllamaAdapter: OllamaAdapter, LocalModelAdapter: LocalModelAdapter, stripThink: stripThink, ReflexAdapter: ReflexAdapter,
    CORE: CORE, EXTRA_IDS: EXTRA_IDS, INTENT_DIRECTIVE: INTENT_DIRECTIVE,
    calcOf: (Nation && Nation.calcOf) || null,   // guarded math (length-capped, safe-num gated, no eval)
  };
})(typeof self !== 'undefined' ? self : this);
