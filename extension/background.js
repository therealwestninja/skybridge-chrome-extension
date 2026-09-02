'use strict';
/* background.js — Rook's privileged MV3 service worker.
 *
 * Jobs: (1) the privileged MODEL call — a page can't reach http://127.0.0.1, this worker can
 * (host_permissions) — streamed back over the 'rook-model' Port, provider-aware (Ollama or
 * OpenAI-compatible); (2) the popup control surface + the Settings/Debug diagnostics + model
 * config + backup/restore; (3) page-sensor discovery badges + the skybridge fetch/page/storage
 * services. The full console runs in two surfaces: the LOCAL extension page console.html
 * (default, primary) and the optional Perchance bridge — both use this worker's model.
 */
// Load the privileged libs. importScripts is SYNCHRONOUS and runs at SW-registration time: if any one
// file fails to fetch/eval on a cold start (transient disk read, registration timeout on the 112KB
// nation.js), the WHOLE worker fails to register and the extension "won't load" until a Chrome restart
// retries it. Guard it so a bad import degrades features instead of killing registration, and so the
// real error surfaces in the service-worker console (chrome://extensions → "service worker" link).
self.__rookImportError = null;
(function loadLibs() {
  var libs = ['lib/token-counter.js', 'lib/brain.min.js', 'lib/nation.js', 'lib/intent-directive.js', 'lib/rook-core.js',
    // Edge-sensor cortex: the phone's retinal packets converge + fuse here. IIFE-wrapped UMD (safe under importScripts'
    // shared global scope). perceiveIngest + opticNerve MUST precede perceive-bridge (it reads them at load). See rook-sensory-nerve-lgn.
    'lib/perceiveIngest.js', 'lib/opticNerve.js', 'lib/perceptFusion.js', 'perceive-bridge.js'];
  for (var i = 0; i < libs.length; i++) {
    try { importScripts(libs[i]); }
    catch (e) { self.__rookImportError = libs[i] + ': ' + (e && e.message || e); console.error('[rook] importScripts failed —', self.__rookImportError); }
  }
})();

// ---- PERCEPTION CORTEX (receive end of the optic nerve) --------------------------------------------------------
// A wire frame from the phone arrives (as {type:'rook/perceive-frame'}); the LGN converges its packets, the fusion
// arbiter picks the clearest-led verdict per dimension, and the fused dimensions are handed to the offscreen brain's
// `perceive` op, where they compete in attention by their fused confidence. Fully guarded: a missing lib degrades to
// a no-op, never a broken worker. The phone→extension TRANSPORT (getting frames onto {type:'rook/perceive-frame'})
// is the one live-unproven link — a page/relay bridge or the moot mesh must carry them; see rook-sensory-nerve-lgn.
(function wirePerceptionCortex() {
  try {
    if (typeof makePerceiveBridge !== 'function') { console.warn('[rook] perceive cortex: bridge lib not loaded'); return; }
    var fusion = (typeof makePerceptFusion === 'function') ? makePerceptFusion({ now: function () { return Date.now(); } }) : null;
    var bridge = makePerceiveBridge({
      now: function () { return Date.now(); },
      onPercept: function (percepts) {
        try {
          var dims = fusion ? fusion.fuse(percepts, { at: Date.now() }).dimensions : percepts;
          chrome.runtime.sendMessage({ type: 'rook-brain-call', op: 'perceive', args: [dims] }, function () { void chrome.runtime.lastError; });
        } catch (e) { /* a fusion/forward failure must not break ingest */ }
      },
    });
    if (typeof listenForPerceiveFrames === 'function') listenForPerceiveFrames(bridge);
    self.__rookPerceiveBridge = bridge;   // exposed for a console smoke test: __rookPerceiveBridge.deliver(frame)
  } catch (e) { console.error('[rook] perceive cortex wiring failed —', e && e.message || e); }
})();

var CONFIG = { endpoint: 'http://127.0.0.1:11434', model: '', provider: 'ollama' };   // model '' = auto (first installed)
var _resolvedModel = null;   // resolved once: the configured model if installed, else the first available

// list installed models for the active provider: ollama -> GET /api/tags ; openai-compatible -> GET /v1/models
function listModels() {
  var prov = CONFIG.provider || 'ollama';
  if (prov === 'perchance') return Promise.resolve({ reachable: true, models: ['Perchance free (aiTextPlugin)'] });   // borrowed via the relay; reachability is tested by the model ping / bridge check
  var url = CONFIG.endpoint + (prov === 'openai' ? '/v1/models' : '/api/tags');
  return self.fetch(url).then(function (r) {
    if (!r.ok) return { reachable: false, status: r.status, error: 'HTTP ' + r.status };
    return r.json().then(function (j) {
      var models = prov === 'openai' ? ((j && j.data) || []).map(function (m) { return m.id; }) : ((j && j.models) || []).map(function (m) { return m.name; });
      return { reachable: true, models: models };
    });
  }).catch(function (e) { return { reachable: false, error: String(e && e.message || e).slice(0, 140) }; });
}
function resolveModel() {
  if ((CONFIG.provider || 'ollama') === 'perchance') return Promise.resolve('Perchance free');
  if (_resolvedModel) return Promise.resolve(_resolvedModel);
  return listModels().then(function (r) {
    var names = r.models || [];
    // prefer the configured model; else the first installed, so the path works with whatever the user has.
    _resolvedModel = (CONFIG.model && names.indexOf(CONFIG.model) >= 0) ? CONFIG.model : (names[0] || CONFIG.model || 'llama3.1');
    return _resolvedModel;
  }).catch(function () { return CONFIG.model || 'llama3.1'; });
}
// build the right adapter for the active provider (both live in lib/rook-core.js)
function buildAdapter(model, opts) {
  opts = opts || {};
  var base = { endpoint: CONFIG.endpoint, model: model || CONFIG.model, fetch: self.fetch.bind(self) };
  if (opts.options) base.options = opts.options;
  if ((CONFIG.provider || 'ollama') === 'openai') { base.kind = 'openai'; return new self.RookBrain.LocalModelAdapter(base); }
  return new self.RookBrain.OllamaAdapter(base);
}
// map a model failure to a plain-language CAUSE + actionable FIX (the verbose point-of-failure surface)
function classifyModelError(status, body, errMsg) {
  var s = status || 0, b = String(body || ''), e = String(errMsg || '');
  var id = (chrome.runtime && chrome.runtime.id) || '<extension-id>';
  if (s === 403 || /\b403\b/.test(e)) return { cause: 'The model server is rejecting this extension’s origin (HTTP 403).', fix: 'Allow the extension origin: set OLLAMA_ORIGINS=* (or chrome-extension://' + id + '), then restart the server. Windows: setx OLLAMA_ORIGINS "*" then restart Ollama.' };
  if (s === 404 || /\b404\b/.test(e)) return { cause: 'Model not found on the server (HTTP 404).', fix: 'Pull it (ollama pull <model>) or pick an installed model above.' };
  if (s === 401 || s === 407) return { cause: 'Authentication required (HTTP ' + s + ').', fix: 'This endpoint needs an API key (OpenAI-compatible provider).' };
  if (/failed to fetch|networkerror|load failed|econnrefused|connection refused|refused to connect/i.test(e)) return { cause: 'Could not reach the model server.', fix: 'Start the server (ollama serve) and confirm the endpoint above.' };
  if (/abort|timeout|timed out/i.test(e)) return { cause: 'The request was aborted / timed out.', fix: 'A big model can take ~60s on its first (cold) call — try again once it is loaded.' };
  if (s >= 500) return { cause: 'The model server errored (HTTP ' + s + ').', fix: 'Check the server logs; the model may have failed to load.' };
  if (s && (s < 200 || s >= 400)) return { cause: 'Unexpected server response (HTTP ' + s + ').', fix: b ? ('Server said: ' + b.slice(0, 120)) : 'Check the server logs.' };
  if (e) return { cause: e.slice(0, 160), fix: '' };
  return { cause: '', fix: '' };
}

// ---- worker diagnostics: a small log ring the extension Debug page reads ----
var WLOG = [], WLOG_MAX = 120;
function wlog(msg, level) { try { WLOG.push({ t: Date.now(), level: level || 'info', msg: String(msg).slice(0, 300) }); if (WLOG.length > WLOG_MAX) WLOG.shift(); } catch (e) {} }

// ---- worker model/endpoint config, persisted so the popup (not the web app) sets it ----
var CFG_KEY = 'rook_model_cfg';
try { chrome.storage.local.get(CFG_KEY, function (o) { var c = o && o[CFG_KEY]; if (c) { if (c.endpoint) CONFIG.endpoint = String(c.endpoint); if (typeof c.model === 'string') CONFIG.model = c.model; if (c.provider) CONFIG.provider = String(c.provider); _resolvedModel = null; wlog('config loaded: ' + CONFIG.provider + ' ' + CONFIG.endpoint + ' / ' + (CONFIG.model || '(auto)')); } }); } catch (e) {}
function setModelConfig(patch, cb) {
  if (patch && typeof patch.endpoint === 'string' && patch.endpoint) CONFIG.endpoint = patch.endpoint.replace(/\/+$/, '');
  if (patch && typeof patch.model === 'string') CONFIG.model = patch.model;   // '' = auto (first installed)
  if (patch && (patch.provider === 'ollama' || patch.provider === 'openai' || patch.provider === 'perchance')) CONFIG.provider = patch.provider;
  _resolvedModel = null;   // force a fresh resolve
  wlog('config set: ' + CONFIG.provider + ' ' + CONFIG.endpoint + ' / ' + (CONFIG.model || '(auto)'));
  try { var s = {}; s[CFG_KEY] = { endpoint: CONFIG.endpoint, model: CONFIG.model, provider: CONFIG.provider }; chrome.storage.local.set(s, function () { cb && cb(); }); } catch (e) { cb && cb(); }
}
function extDebugSnapshot() {
  var snap = { ts: Date.now(), version: (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '?',
    extId: (chrome.runtime && chrome.runtime.id) || '', config: { endpoint: CONFIG.endpoint, model: CONFIG.model || '(auto)', provider: CONFIG.provider || 'ollama', resolved: _resolvedModel }, log: WLOG.slice(-80) };
  return listModels().then(function (r) { snap.ollama = r.reachable ? { reachable: true, models: r.models || [] } : { reachable: false, error: r.error }; return snap; });
}

// ---- DEEP DIAGNOSTICS: the Debug page's "test the whole stack" pass. Each check exercises a real
//      point of failure (worker, storage, host permission, the local model server + a chosen model,
//      and the LIVE bridge/anchor link on any open Perchance tab) and returns {id,label,status,detail,ms}. ----
function mk(id, label, status, detail, ms) { return { id: id, label: label, status: status, detail: detail || '', ms: ms || 0 }; }
function mkfix(id, label, status, detail, fix, ms) { var o = mk(id, label, status, detail, ms); o.fix = fix || ''; return o; }
function chkStorage() {
  return new Promise(function (res) {
    var k = 'rook_diag_probe', v = 'p' + Date.now();
    try {
      var s = {}; s[k] = v;
      chrome.storage.local.set(s, function () {
        if (chrome.runtime.lastError) { res(mk('storage', 'Extension storage', 'fail', 'write failed: ' + chrome.runtime.lastError.message)); return; }
        chrome.storage.local.get(k, function (o) {
          var ok = !!(o && o[k] === v);
          try { chrome.storage.local.remove(k); } catch (e) {}
          res(mk('storage', 'Extension storage', ok ? 'ok' : 'fail', ok ? 'read + write OK' : 'readback mismatch'));
        });
      });
    } catch (e) { res(mk('storage', 'Extension storage', 'fail', String(e && e.message || e))); }
  });
}
function chkPerms() {
  return new Promise(function (res) {
    try {
      chrome.permissions.contains({ origins: ['http://127.0.0.1/*', 'http://localhost/*'] }, function (has) {
        var le = chrome.runtime.lastError;
        res(mk('perms', 'Local network permission', has ? 'ok' : 'warn',
          has ? 'http://127.0.0.1 + localhost granted' : 'localhost host permission missing — Ollama calls may be blocked' + (le ? ' (' + le.message + ')' : '')));
      });
    } catch (e) { res(mk('perms', 'Local network permission', 'warn', String(e && e.message || e))); }
  });
}
function chkOllama(base) {
  var prov = CONFIG.provider || 'ollama';
  if (prov === 'perchance') {
    base.ollama = { reachable: true, models: ['Perchance free (aiTextPlugin)'] };
    return Promise.resolve([
      mk('ollama', 'Mouth — Perchance (free)', 'ok', 'borrowed via the Perchance relay (no local server). Use "Test this model" to exercise it end-to-end.'),
      mk('ollama-model', 'Model', 'ok', 'Perchance free model (aiTextPlugin)')
    ]);
  }
  var t0 = Date.now(), label = 'Model server (' + (prov === 'openai' ? 'OpenAI-compatible' : 'Ollama') + ')';
  return listModels().then(function (r) {
    var ms = Date.now() - t0;
    if (!r.reachable) {
      var c = classifyModelError(r.status || 0, '', r.error || '');
      base.ollama = { reachable: false, error: r.error };
      return [mkfix('ollama', label, 'fail', 'unreachable at ' + CONFIG.endpoint + (r.error ? ' (' + r.error + ')' : ''), c.fix, ms),
              mk('ollama-model', 'Model installed', 'skip', 'skipped — server unreachable')];
    }
    var models = r.models || [];
    base.ollama = { reachable: true, models: models };
    var out = [mk('ollama', label, 'ok', 'reachable — ' + models.length + ' model(s) at ' + CONFIG.endpoint, ms)];
    if (!models.length) out.push(mkfix('ollama-model', 'Model installed', 'fail', 'no models installed', 'Pull one: ollama pull <model>'));
    else if (CONFIG.model && models.indexOf(CONFIG.model) < 0) out.push(mkfix('ollama-model', 'Model installed', 'warn', 'configured "' + CONFIG.model + '" not installed; auto will use "' + models[0] + '"', 'Pick an installed model, or pull "' + CONFIG.model + '".'));
    else out.push(mk('ollama-model', 'Model installed', 'ok', (CONFIG.model || ('auto -> ' + models[0])) + ' ready'));
    return out;
  });
}
// FAST origin/chat-endpoint probe: a minimal POST that fails validation quickly (empty messages) rather
// than generating. The server's origin check runs first -> 403 = origin-blocked (the verbose fix); any
// other status = origin accepted + chat endpoint reachable. This catches the 403 in the auto-battery
// without a slow generation. (Ollama only; OpenAI-compatible servers don't share this origin behaviour.)
function chkChatEndpoint() {
  if ((CONFIG.provider || 'ollama') !== 'ollama') return Promise.resolve(mk('chat', 'Chat endpoint', 'skip', 'origin probe is Ollama-specific'));
  var t0 = Date.now();
  return self.fetch(CONFIG.endpoint + '/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: CONFIG.model || 'x', messages: [], stream: false }) })
    .then(function (r) {
      var ms = Date.now() - t0, st = r.status;
      if (st === 403) { var c = classifyModelError(403, '', ''); return mkfix('chat', 'Chat endpoint (origin)', 'fail', c.cause, c.fix, ms); }
      return mk('chat', 'Chat endpoint (origin)', 'ok', 'origin accepted (probe returned HTTP ' + st + ')', ms);
    })
    .catch(function (e) { var ms = Date.now() - t0, emsg = String(e && e.message || e), c = classifyModelError(0, '', emsg); return mkfix('chat', 'Chat endpoint (origin)', 'warn', c.cause || emsg.slice(0, 120), c.fix, ms); });
}
function chkBridge() {
  // Candidate Perchance tab ids from BOTH sources, unioned: the page-sensor cache (tabMeta — works even
  // without tabs host-permission, the same source the "Sensed pages" check uses) AND chrome.tabs.query
  // (authoritative, survives a cold worker with empty tabMeta — needs the perchance host_permission).
  function metaIds() { var ids = []; for (var id in tabMeta) { var h = (tabMeta[id] || {}).host || ''; if (/(^|\.)perchance\.org$/i.test(h)) ids.push(+id); } return ids; }
  return new Promise(function (resolve) {
    function go(queryTabs) {
      var set = {};
      (queryTabs || []).forEach(function (t) { if (t && t.id != null) set[t.id] = 1; });
      metaIds().forEach(function (id) { set[id] = 1; });
      var ids = Object.keys(set).map(Number);
      // The Perchance bridge is OPTIONAL: the local console (console.html) talks to the worker directly,
      // so "no bridge" is normal, not a problem -> 'skip' (gray), never a warning.
      if (!ids.length) { resolve([mk('bridge', 'Perchance bridge (optional)', 'skip', 'not open — the local console talks to the worker directly. Open the Perchance bridge only if you want that web surface.')]); return; }
      var pending = ids.length, got = [];
      function finish() {
        var anchored = got.filter(function (x) { return x.ok; });
        // Tabs are open but no anchor answered — that IS worth a warning (the bridge won't work).
        if (!anchored.length) { resolve([mkfix('bridge', 'Perchance bridge', 'warn', ids.length + ' Perchance tab(s) open, but no Rook anchor answered', 'Reload the Perchance tab so the anchor content script re-injects.')]); return; }
        resolve(anchored.map(function (x) {
          var d = x.d, served = (d.stats && d.stats.requests) || 0, last = (d.stats && d.stats.lastRequest) || 0;
          var ago = last ? (Math.round((Date.now() - last) / 1000) + 's ago') : 'no requests yet';
          if (d.disabled) return mk('bridge', 'Perchance bridge — ' + (d.slug || '?'), 'fail', 'stood down (generator on the block list)');
          if (!d.hydrated) return mk('bridge', 'Perchance bridge — ' + (d.slug || '?'), 'warn', 'present but still initializing');
          return mk('bridge', 'Perchance bridge — ' + (d.slug || '?'), 'ok', 'linked (' + (d.state || '?') + '); caps ' + (d.caps || []).join(',') + '; ' + served + ' request(s), last ' + ago);
        }));
      }
      ids.forEach(function (id) {
        var settled = false;
        var to = setTimeout(function () { if (settled) return; settled = true; got.push({ ok: false }); if (--pending === 0) finish(); }, 1500);
        try {
          chrome.tabs.sendMessage(id, { type: 'rook-anchor-status' }, function (r) {
            if (settled) return; settled = true; clearTimeout(to);
            got.push({ ok: !(chrome.runtime.lastError || !r || !r.ok), d: r });
            if (--pending === 0) finish();
          });
        } catch (e) { if (!settled) { settled = true; clearTimeout(to); got.push({ ok: false }); if (--pending === 0) finish(); } }
      });
    }
    try { chrome.tabs.query({ url: ['*://perchance.org/*', '*://*.perchance.org/*'] }, function (tabs) { if (chrome.runtime.lastError) tabs = null; go(tabs); }); }
    catch (e) { go(null); }
  });
}
function chkPages() {
  try {
    var ids = Object.keys(tabMeta);
    if (!ids.length) return Promise.resolve(mk('pages', 'Sensed pages', 'skip', 'no pages sensed yet (browse a site with search / login / live-chat)'));
    var list = ids.map(function (id) { var m = tabMeta[id] || {}; return (m.host || '?') + (m.sensitive ? '(sensitive)' : '') + '[' + ((m.abilities || []).join(',') || 'none') + ']'; });
    return Promise.resolve(mk('pages', 'Sensed pages', 'ok', ids.length + ' tab(s): ' + list.slice(0, 8).join('  ·  ')));
  } catch (e) { return Promise.resolve(mk('pages', 'Sensed pages', 'warn', String(e && e.message || e))); }
}
function extDiagnose() {
  var version = (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '?';
  var base = { ts: Date.now(), version: version, extId: (chrome.runtime && chrome.runtime.id) || '', config: { endpoint: CONFIG.endpoint, model: CONFIG.model || '(auto)', provider: CONFIG.provider || 'ollama', resolved: _resolvedModel }, log: WLOG.slice(-80) };
  return Promise.all([chkStorage(), chkPerms(), chkOllama(base), chkChatEndpoint(), chkBridge(), chkPages()]).then(function (parts) {
    var checks = [mk('worker', 'Service worker', 'ok', 'alive, v' + version)];
    parts.forEach(function (p) { if (Array.isArray(p)) checks.push.apply(checks, p); else if (p) checks.push(p); });
    base.checks = checks;
    return base;
  });
}
// GENTLE on-demand generation test: tiny prompt, num_predict capped, no timeout (a 24GB model can take ~60s).
function extPingModel() {
  if ((CONFIG.provider || 'ollama') === 'perchance') return perchancePing();
  var t0 = Date.now(), url = CONFIG.endpoint + ((CONFIG.provider || 'ollama') === 'openai' ? '/v1/chat/completions' : '/api/chat');
  return resolveModel().then(function (model) {
    wlog('diag: ping model -> ' + model);
    var ad = buildAdapter(model, { options: { num_predict: 16 } });
    return ad.chat([{ role: 'user', content: 'Reply with exactly one word: pong' }], { stream: false }).then(function (text) {
      var ms = Date.now() - t0; wlog('diag: ping ok in ' + ms + 'ms');
      return { ok: true, model: model, ms: ms, url: url, status: 200, reply: String(text || '').trim().slice(0, 200) };
    });
  }).catch(function (e) {
    var ms = Date.now() - t0, emsg = String(e && e.message || e);
    var pm = /(?:ollama|openai|http)\D*(\d{3})\D*:?\s*([\s\S]*)/i.exec(emsg), status = pm ? +pm[1] : 0, body = pm ? pm[2] : '';
    var c = classifyModelError(status, body, emsg);
    wlog('diag: ping fail: ' + emsg.slice(0, 120) + (c.cause ? ' [' + c.cause + ']' : ''), 'error');
    return { ok: false, ms: ms, url: url, status: status, error: emsg.slice(0, 200), cause: c.cause, fix: c.fix };
  });
}

// ---- Perchance as a borrowed MOUTH + IMAGE-GEN: relay to a background perchance.org/rook-ai tab.
//      Reuses ensureHost/rook-host/pending (defined below); the rook-ai build answers __rookPerchanceReq /
//      __rookPerchanceImgReq, remote-host.js bridges worker<->iframe. Non-streaming (single reply).
function perchanceModelChat(msg, port) {   // route a 'rook-model' chat through the relay (provider 'perchance')
  var reqId = 'rm' + (reqSeq++); pending[reqId] = port;   // rook-host relay forwards {type,reqId}->pending[reqId].postMessage; WorkerModelAdapter handles token/done/error
  wlog('ai chat -> perchance relay');
  ensureHost('perchance.org').then(function (hostPort) {
    if (!hostPort) { try { port.postMessage({ type: 'error', error: 'Perchance relay unavailable — is perchance.org/rook-ai reachable?' }); } catch (e) {} delete pending[reqId]; return; }
    // msg.image (optional dataURL) rides through to the mouth's vision path; undefined = text-only (unchanged)
    try { hostPort.postMessage({ type: 'chat', reqId: reqId, messages: msg.messages, image: msg.image }); startKeepAlive(reqId, hostPort); }
    catch (e) { try { port.postMessage({ type: 'error', error: 'relay send failed' }); } catch (e2) {} delete pending[reqId]; }
  });
}
// streamKeepAlive: a long generation must not let the MV3 worker sleep or the relay tab go cold mid-stream.
// While a perchance gen is in-flight, tick a trivial async API call (resets the ~30s SW idle timer) and nudge
// the relay tab. Cleared the moment the request settles (see stopKeepAlive, called from the rook-host handler).
var keepAlives = {};   // reqId -> intervalId
var KEEPALIVE_MAX_MS = 180000;   // hard ceiling: a gen that never settles (relay hang / lost frame) must not tick forever
function startKeepAlive(reqId, hostPort) {
  stopKeepAlive(reqId);
  try {
    var started = Date.now();
    keepAlives[reqId] = setInterval(function () {
      if (Date.now() - started > KEEPALIVE_MAX_MS) {   // give up: stop ticking and fail the pending request so nothing leaks
        stopKeepAlive(reqId);
        var p = pending[reqId]; if (p) { delete pending[reqId]; try { p.postMessage({ type: 'error', error: 'perchance relay timed out (no reply in ' + Math.round(KEEPALIVE_MAX_MS / 1000) + 's)' }); } catch (e) {} }
        return;
      }
      try { chrome.runtime.getPlatformInfo(function () { void chrome.runtime.lastError; }); } catch (e) {}
      try { if (hostPort) hostPort.postMessage({ type: 'keepalive', reqId: reqId }); } catch (e) {}
    }, 20000);
  } catch (e) {}
}
// the relay (rook-host) is gone: every in-flight perchance gen is dead - settle each so keepalives + pending don't leak
function cancelAllKeepAlives(reason) {
  for (var rid in keepAlives) { if (!keepAlives.hasOwnProperty(rid)) continue; stopKeepAlive(rid); var p = pending[rid]; if (p && typeof p.postMessage === 'function') { delete pending[rid]; try { p.postMessage({ type: 'error', error: reason || 'perchance relay closed' }); } catch (e) {} } }
}
function stopKeepAlive(reqId) { try { if (keepAlives[reqId]) { clearInterval(keepAlives[reqId]); delete keepAlives[reqId]; } } catch (e) {} }
function perchancePing() {   // extPingModel for provider 'perchance' — one relay round-trip
  var t0 = Date.now();
  return new Promise(function (resolve) {
    ensureHost('perchance.org').then(function (hostPort) {
      if (!hostPort) { resolve({ ok: false, ms: Date.now() - t0, error: 'relay unavailable', cause: 'Could not open the Perchance relay tab.', fix: 'Make sure perchance.org/rook-ai is published and reachable, then retry.' }); return; }
      var reqId = 'pg' + (reqSeq++), settled = false;
      pending[reqId] = { postMessage: function (m) {
        if (settled) return;
        if (m.type === 'done') { settled = true; wlog('diag: perchance ping ok in ' + (Date.now() - t0) + 'ms'); resolve({ ok: true, model: 'Perchance free', ms: Date.now() - t0, reply: String(m.text || '').trim().slice(0, 200) }); }
        else if (m.type === 'error') { settled = true; resolve({ ok: false, ms: Date.now() - t0, error: String(m.error || 'relay error') }); }
      } };
      try { hostPort.postMessage({ type: 'chat', reqId: reqId, messages: [{ role: 'user', content: 'Reply with exactly one word: pong' }] }); }
      catch (e) { settled = true; delete pending[reqId]; resolve({ ok: false, ms: Date.now() - t0, error: 'relay send failed' }); }
      setTimeout(function () { if (!settled) { settled = true; delete pending[reqId]; resolve({ ok: false, ms: Date.now() - t0, error: 'relay timeout', cause: 'No reply from the Perchance relay within 60s.', fix: 'Open perchance.org/rook-ai in a tab and retry.' }); } }, 60000);
    });
  });
}
function perchanceImage(prompt, done) {   // borrow textToImagePlugin via the relay -> done({ok,dataUrl}|{ok:false,error})
  ensureHost('perchance.org').then(function (hostPort) {
    if (!hostPort) { done({ ok: false, error: 'Perchance relay unavailable (image-gen needs Perchance)' }); return; }
    var reqId = 'pi' + (reqSeq++), settled = false;
    pending[reqId] = { postMessage: function (m) {
      if (settled) return;
      if (m.type === 'image-done') { settled = true; done({ ok: true, dataUrl: m.dataUrl }); }
      else if (m.type === 'error') { settled = true; done({ ok: false, error: String(m.error || 'image relay error') }); }
    } };
    try { hostPort.postMessage({ type: 'image', reqId: reqId, prompt: prompt }); }
    catch (e) { settled = true; delete pending[reqId]; done({ ok: false, error: 'relay send failed' }); }
    setTimeout(function () { if (!settled) { settled = true; delete pending[reqId]; done({ ok: false, error: 'image relay timeout' }); } }, 120000);
  });
}

// ---- privileged web FETCH (the skybridge anchor's "hands"): the worker reaches
//      cross-origin hosts the Perchance sandbox / a content script can't. Hardened:
//      http(s) only, loopback/private/link-local hosts blocked, anonymous (no cookies),
//      size + time capped. The brain asks for "the contents of this URL", never raw power. ----
function hostBlocked(h) {
  h = String(h || '').toLowerCase().replace(/^\[|\]$/g, '');
  return !h || h === 'localhost' || /\.local$/.test(h) || h === '0.0.0.0' || h === '::1'
    || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^169\.254\./.test(h) || /^fe80:/.test(h) || /^f[cd][0-9a-f]{0,2}:/.test(h);   // IPv6 ULA fc00::/7 — require the colon so we don't over-block hostnames like fdn.example.com
}
// safeFetch(url[, opts]) - opts is OPT-IN privilege the sandbox/superFetch can never have. Default (no opts) is
// byte-identical to the old hardened behavior (anonymous, https/http only, private hosts blocked), so existing
// callers are unaffected. With opts (consent-gated upstream at the anchor): allowLocal reaches localhost/LAN (your
// own model/tool servers - superFetch SSRF-blocks these), headers carries auth/API keys (superFetch STRIPS them),
// credentials:'include' uses the cookie jar (superFetch has none).
function safeFetch(url, opts) {
  opts = opts || {};
  return new Promise(function (resolve) {
    var u; try { u = new URL(url); } catch (e) { return resolve({ ok: false, reason: 'bad-url' }); }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return resolve({ ok: false, reason: 'bad-scheme' });
    if (hostBlocked(u.hostname) && opts.allowLocal !== true) return resolve({ ok: false, reason: 'blocked-host' });
    var init = { redirect: 'follow', cache: 'no-store', credentials: (opts.credentials === 'include' ? 'include' : 'omit') };
    if (opts.method) init.method = String(opts.method).toUpperCase();
    if (opts.body != null) init.body = opts.body;
    if (opts.headers && typeof opts.headers === 'object') { var h = {}; for (var k in opts.headers) { if (Object.prototype.hasOwnProperty.call(opts.headers, k)) h[String(k)] = String(opts.headers[k]); } init.headers = h; }
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    init.signal = ctrl ? ctrl.signal : undefined;
    var timer = setTimeout(function () { try { ctrl && ctrl.abort(); } catch (e) {} resolve({ ok: false, reason: 'timeout' }); }, 8000);
    // OPT-IN binary response: WAV/audio bytes garble through r.text(); when asked (responseType:'arraybuffer' OR
    // binary:true) read arrayBuffer, base64-encode, return { b64, contentType }. DEFAULT (no flag) is the unchanged
    // text path, so every existing fetch-cap caller is byte-for-byte unaffected.
    var wantBin = opts.binary === true || String(opts.responseType || '').toLowerCase() === 'arraybuffer';
    self.fetch(u.href, init)
      .then(function (r) {
        var st = r.status;
        if (wantBin) {
          var ct = ''; try { ct = r.headers.get('content-type') || ''; } catch (e) {}
          return r.arrayBuffer().then(function (buf) {
            var bytes = new Uint8Array(buf), CAP = 8 * 1024 * 1024;   // 8MB cap (audio)
            if (bytes.length > CAP) bytes = bytes.subarray(0, CAP);
            var bin = '', CH = 0x8000;                                // chunked to dodge apply()'s arg-count limit
            for (var i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
            var b64 = ''; try { b64 = btoa(bin); } catch (e) {}
            return { bin: true, st: st, b64: b64, ct: ct };
          });
        }
        return r.text().then(function (t) { return { st: st, t: t }; });
      })
      .then(function (o) {
        clearTimeout(timer);
        if (o.bin) { resolve({ ok: o.st >= 200 && o.st < 400, status: o.st, b64: o.b64, contentType: o.ct }); return; }
        var body = (o.t || '').slice(0, 200000);   // 200KB cap
        var json = null; try { json = JSON.parse(body); } catch (e) {}
        resolve({ ok: o.st >= 200 && o.st < 400, status: o.st, body: body, json: json });
      })
      .catch(function (e) { clearTimeout(timer); resolve({ ok: false, reason: String(e && e.message || e).slice(0, 120) }); });
  });
}

// ---- toolbar button: open (or focus) Rook in a single popup window ----
// The popup IS the Perchance bridge (perchance.org/rook-ai): the full Rook console running
// on Perchance's own free aiTextPlugin NATIVELY — no hidden host window, no nested relay.
// (Rook is ephemeral; the popup is the convenience + settings surface. Bridge state lives in
// Perchance's own storage.) Requires the bridge generator to be published at that slug.
// LOCAL console = the extension's own bundled page (default, primary). Perchance bridge = optional.
var CONSOLE_URL = 'https://perchance.org/rook-ai';
var LOCAL_CONSOLE = (chrome.runtime.getURL && chrome.runtime.getURL('console.html')) || 'console.html';
var consoleWins = {};   // url -> windowId — tracked PER-URL so the local console and the Perchance bridge
                        // each get/keep their OWN window (a single id made the 2nd button just refocus the 1st).
function openConsole(url) {
  url = url || LOCAL_CONSOLE;
  if (consoleWins[url] != null) {
    chrome.windows.update(consoleWins[url], { focused: true }, function () {
      if (chrome.runtime.lastError) { delete consoleWins[url]; openConsole(url); }   // window was closed out from under us
    });
    return;
  }
  // MV3: the worker can be killed + restarted, losing consoleWins. Before creating a new window, check
  // whether one already exists for THIS url and adopt it so we don't open a duplicate.
  function create() { try { chrome.windows.create({ url: url, type: 'popup', width: 460, height: 820 }, function (win) { if (win) consoleWins[url] = win.id; }); } catch (e) {} }
  try {
    chrome.tabs.query({ url: url + '*' }, function (tabs) {
      if (chrome.runtime.lastError || !tabs || !tabs.length) { create(); return; }
      var existWinId = tabs[0].windowId; consoleWins[url] = existWinId;
      chrome.windows.update(existWinId, { focused: true }, function () { if (chrome.runtime.lastError) { delete consoleWins[url]; } });
    });
  } catch (e) { create(); }
}
try { chrome.windows.onRemoved.addListener(function (id) { for (var u in consoleWins) { if (consoleWins[u] === id) delete consoleWins[u]; } }); } catch (e) {}
try { chrome.action.onClicked.addListener(function () { openConsole(); }); } catch (e) {}

// ===== NAVIGATION QoL: reach Rook from anywhere - side panel, keyboard shortcut, right-click menu,
//       omnibox. A queued input (a selection, omnibox text, or "/page") is parked in chrome.storage
//       and consumed by the console on boot. =====
function queueInput(text, submit) { try { chrome.storage.local.set({ 'rook:pendingInput': { text: String(text == null ? '' : text).slice(0, 4000), submit: !!submit, ts: Date.now() } }); } catch (e) {} }
function openRook(opts) {
  opts = opts || {};
  if (opts.windowId != null && chrome.sidePanel && chrome.sidePanel.open) {   // prefer the persistent SIDE PANEL (alongside the page) when we have a window + gesture
    try { chrome.sidePanel.open({ windowId: opts.windowId }, function () { if (chrome.runtime.lastError) openConsole(); }); return; } catch (e) {}
  }
  openConsole();   // fallback: the popup window (no gesture / no windowId)
}
try { if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }); } catch (e) {}   // toolbar click shows the popup menu (which offers "open panel")

// keyboard: Alt+Shift+P -> side panel (Alt+Shift+R opens the popup menu via _execute_action)
try { chrome.commands && chrome.commands.onCommand.addListener(function (command, tab) { if (command === 'open-rook-panel') openRook({ windowId: tab && tab.windowId }); }); } catch (e) {}

// right-click: ask Rook about a selection, or read the page
function buildMenus() { try { chrome.contextMenus.removeAll(function () { void chrome.runtime.lastError; try { chrome.contextMenus.create({ id: 'rook-ask', title: 'Ask Rook about “%s”', contexts: ['selection'] }); chrome.contextMenus.create({ id: 'rook-page', title: 'Rook: read this page', contexts: ['page'] }); } catch (e) {} }); } catch (e) {} }
try { chrome.runtime.onInstalled.addListener(buildMenus); } catch (e) {}
try { chrome.runtime.onStartup && chrome.runtime.onStartup.addListener(buildMenus); } catch (e) {}
try { chrome.contextMenus && chrome.contextMenus.onClicked.addListener(function (info, tab) { if (info.menuItemId === 'rook-ask') queueInput(info.selectionText || '', false); else if (info.menuItemId === 'rook-page') queueInput('/page', true); else return; openRook({ windowId: tab && tab.windowId }); }); } catch (e) {}

// omnibox: type "rook <query>" in the address bar, Enter -> opens Rook and asks
try { if (chrome.omnibox) { chrome.omnibox.setDefaultSuggestion && chrome.omnibox.setDefaultSuggestion({ description: 'Ask Rook: <match>%s</match>' }); chrome.omnibox.onInputEntered.addListener(function (text) { queueInput(text, true); openConsole(); }); } } catch (e) {}

// ---- page sensor → toolbar DISCOVERY BADGE (replaces the on-page pip lost in the popup move) ----
// A page-sensor content script reports the affordances it sees (search/login/live-chat); we light a
// per-tab badge (and pulse it on first sight) so the toolbar invites opt-in. Live-chat lines stream in
// and are ringed per tab for a future consumer. All metadata/opt-in; content is only read on request.
var tabAbil = {};      // tabId -> abilities[]
var tabMeta = {};      // tabId -> {url,host,title,abilities,sensitive,at} (for the popup control surface)
var discovered = [];   // recent {host,title,abilities,at} - newly-found pages, surfaced in the popup
var chatRing = {};     // tabId -> recent live-chat lines
// ---- extension settings + per-site powers, persisted in chrome.storage (the popup reads/writes these) ----
function extGet(cb) { try { chrome.storage.local.get(['rook_ext', 'rook_sites'], function (o) { cb(((o && o.rook_ext) || { notify: true }), ((o && o.rook_sites) || {})); }); } catch (e) { cb({ notify: true }, {}); } }
function extSet(patch, cb) { try { chrome.storage.local.get('rook_ext', function (o) { var s = Object.assign({ notify: true }, o && o.rook_ext, patch); chrome.storage.local.set({ rook_ext: s }, function () { cb && cb(s); }); }); } catch (e) { cb && cb({}); } }
function siteSet(host, patch, cb) { try { chrome.storage.local.get('rook_sites', function (o) { var all = (o && o.rook_sites) || {}; all[host] = Object.assign({}, all[host], patch); chrome.storage.local.set({ rook_sites: all }, function () { cb && cb(all[host]); }); }); } catch (e) { cb && cb({}); } }
var _extCache = { notify: true, pulse: true };   // sync mirror for the hot path (badge pulse); refreshed from storage
try { chrome.storage.local.get('rook_ext', function (o) { if (o && o.rook_ext) _extCache = Object.assign(_extCache, o.rook_ext); }); } catch (e) {}
try { chrome.storage.onChanged && chrome.storage.onChanged.addListener(function (ch, area) { if (area === 'local' && ch.rook_ext && ch.rook_ext.newValue) _extCache = Object.assign({ notify: true, pulse: true }, ch.rook_ext.newValue); }); } catch (e) {}
// a small Rook icon as a data URL (built once via OffscreenCanvas) for chrome.notifications - best-effort, no asset files
var ICON_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC';
(function () { try { var c = new OffscreenCanvas(64, 64), x = c.getContext('2d'); x.fillStyle = '#4493f8'; x.beginPath(); x.arc(32, 32, 30, 0, 6.2832); x.fill(); x.fillStyle = '#fff'; x.font = 'bold 40px sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText('R', 32, 34); c.convertToBlob().then(function (b) { return new Response(b).arrayBuffer(); }).then(function (buf) { var u8 = new Uint8Array(buf), s = ''; for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); ICON_URL = 'data:image/png;base64,' + btoa(s); }).catch(function () {}); } catch (e) {} })();
function noteDiscovery(meta) {
  if (!meta || !meta.abilities || !meta.abilities.length || meta.sensitive) return;
  discovered = discovered.filter(function (d) { return d.host !== meta.host; });
  discovered.unshift({ host: meta.host, title: meta.title, abilities: meta.abilities, at: meta.at }); while (discovered.length > 12) discovered.pop();
  extGet(function (ext, sites) {
    if (ext.notify === false) return;
    var sp = sites[meta.host] || {}; if (sp.mute) return;   // per-site mute
    try { chrome.notifications.create('rook-disc:' + meta.host, { type: 'basic', iconUrl: ICON_URL, title: 'Rook found abilities on ' + (meta.host || 'this page'), message: meta.abilities.join(', ') + ' - open Rook to use them.', priority: 0 }); } catch (e) {}
  });
}
try { chrome.notifications && chrome.notifications.onClicked && chrome.notifications.onClicked.addListener(function (id) { if (String(id).indexOf('rook-') === 0) { openConsole(); try { chrome.notifications.clear(id); } catch (e) {} } }); } catch (e) {}
var pulseT = {};       // tabId -> pulse interval id
var seenAbil = {};     // tabId -> last ability-set we already pulsed (don't re-pulse the same page)
function setBadge(tabId, on, color) {
  try { chrome.action.setBadgeText({ tabId: tabId, text: on ? '●' : '' }); if (on) chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: color || '#4493f8' }); } catch (e) {}
}
function pulseBadge(tabId, color) {
  if (pulseT[tabId]) { clearInterval(pulseT[tabId]); delete pulseT[tabId]; }
  var dim = '#2b3138', i = 0;
  pulseT[tabId] = setInterval(function () {
    try { chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: (i % 2 ? dim : color) }); } catch (e) {}
    if (++i >= 6) { clearInterval(pulseT[tabId]); delete pulseT[tabId]; try { chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: color }); } catch (e) {} }
  }, 320);
}
// global badge pulse (no tabId) — for internal alerts like a Parliament bill awaiting your assent
var pulseGT = null;
function pulseGlobal(color) {
  if (pulseGT) { clearInterval(pulseGT); pulseGT = null; }
  var dim = '#5a4a16', i = 0;
  pulseGT = setInterval(function () {
    try { chrome.action.setBadgeBackgroundColor({ color: (i % 2 ? dim : color) }); } catch (e) {}
    if (++i >= 6) { clearInterval(pulseGT); pulseGT = null; try { chrome.action.setBadgeBackgroundColor({ color: color }); } catch (e) {} }
  }, 320);
}
chrome.runtime.onMessage.addListener(function (m, sender, send) {
  var tabId = sender && sender.tab && sender.tab.id;
  if (m && m.type === 'rook-sensor' && tabId != null) {
    var ab = m.sensitive ? [] : (m.abilities || []), key = ab.join(',');
    tabAbil[tabId] = ab;
    tabMeta[tabId] = { url: m.url, host: m.host, title: m.title, abilities: ab, sensitive: !!m.sensitive, at: Date.now() };   // cache for the popup control surface
    var color = ab.indexOf('livechat') >= 0 ? '#a371f7' : '#4493f8';
    setBadge(tabId, ab.length > 0, color);
    if (ab.length && seenAbil[tabId] !== key) { seenAbil[tabId] = key; if (_extCache.pulse !== false) pulseBadge(tabId, color); noteDiscovery(tabMeta[tabId]); }   // first sight of an affordance-set: pulse the icon (if enabled) + notify
    return;
  }
  if (m && m.type === 'rook-chat' && tabId != null) {
    var r = chatRing[tabId] || (chatRing[tabId] = []); r.push.apply(r, m.lines || []); while (r.length > 120) r.shift();
    return;
  }
  if (m && m.type === 'rook-notify') {   // the bridge reflects its internal "needs your okay" state on the toolbar (global, persists after the popup closes)
    var ntxt = String(m.badge || '').slice(0, 4);
    try { chrome.action.setBadgeText({ text: ntxt }); } catch (e) {}
    try { chrome.action.setTitle({ title: m.title ? ('Rook — ' + m.title) : 'Rook AI — Your Agent. Your Data. Wherever you go.' }); } catch (e) {}
    if (ntxt) { try { chrome.action.setBadgeBackgroundColor({ color: m.color || '#d29922' }); } catch (e) {} pulseGlobal(m.color || '#d29922'); }
    return;
  }
  // consumer (popup → anchor 'page' cap) asks about the page the user is actually looking at
  if (m && (m.type === 'rook-active-read' || m.type === 'rook-active-watch' || m.type === 'rook-active-unwatch')) {
    var fwd = m.type === 'rook-active-watch' ? 'rook-watch' : m.type === 'rook-active-unwatch' ? 'rook-unwatch' : 'rook-read';
    withPageTab(function (id) {
      if (id == null) { send({ ok: false, reason: 'no page tab — focus a normal browser tab' }); return; }
      try { chrome.tabs.sendMessage(id, { type: fwd }, function (rr) { if (chrome.runtime.lastError || !rr) { send({ ok: false, reason: 'no sensor on that tab' }); return; } send(rr); }); } catch (e) { send({ ok: false, reason: 'send failed' }); }
    });
    return true;   // async
  }
  if (m && m.type === 'rook-active-pollchat') {   // drain + return new live-chat lines from the focused page
    withPageTab(function (id) {
      if (id == null) { send({ ok: true, lines: [], watching: false }); return; }
      var lines = chatRing[id] || []; chatRing[id] = [];
      send({ ok: true, lines: lines, watching: lines.length > 0 || tabAbil[id] && tabAbil[id].indexOf('livechat') >= 0 });
    });
    return true;   // async
  }
  if (m && m.type === 'rook-active-chat-read') {
    withPageTab(function (id) {
      if (id == null) { send({ ok: false, reason: 'no page tab — focus a normal browser tab' }); return; }
      try { chrome.tabs.sendMessage(id, { type: 'rook-chat-read', n: m.n }, function (rr) { if (chrome.runtime.lastError || !rr) { send({ ok: false, reason: 'no sensor on that tab' }); return; } send(rr); }); } catch (e) { send({ ok: false, reason: 'send failed' }); }
    });
    return true;   // async
  }
  if (m && m.type === 'rook-active-chat-type') {
    withPageTab(function (id) {
      if (id == null) { send({ ok: false, reason: 'no page tab — focus a normal browser tab' }); return; }
      try { chrome.tabs.sendMessage(id, { type: 'rook-chat-type', text: m.text }, function (rr) { if (chrome.runtime.lastError || !rr) { send({ ok: false, reason: 'no sensor on that tab' }); return; } send(rr); }); } catch (e) { send({ ok: false, reason: 'send failed' }); }
    });
    return true;   // async
  }
  if (m && m.type === 'rook-active-chat-send') {
    withPageTab(function (id) {
      if (id == null) { send({ ok: false, reason: 'no page tab — focus a normal browser tab' }); return; }
      try { chrome.tabs.sendMessage(id, { type: 'rook-chat-send', text: m.text }, function (rr) { if (chrome.runtime.lastError || !rr) { send({ ok: false, reason: 'no sensor on that tab' }); return; } send(rr); }); } catch (e) { send({ ok: false, reason: 'send failed' }); }
    });
    return true;   // async
  }
});
// the page the user is actually viewing = the active tab of the last-focused NORMAL window (never the
// Rook popup window), so /read + /watch target it. Tracked on tab/window focus changes.
var lastPageTab = null;
function noteActive(tabId, windowId) {
  if (tabId == null || windowId == null) return;
  try { chrome.windows.get(windowId, function (w) { if (!chrome.runtime.lastError && w && w.type === 'normal') lastPageTab = tabId; }); } catch (e) {}
}
function withPageTab(cb) {
  if (lastPageTab != null) { cb(lastPageTab); return; }
  try { chrome.tabs.query({ active: true, lastFocusedWindow: true }, function (tabs) { var t = tabs && tabs[0]; cb(t ? t.id : null); }); } catch (e) { cb(null); }
}
try { chrome.tabs.onActivated.addListener(function (info) { noteActive(info.tabId, info.windowId); }); } catch (e) {}
try { chrome.windows.onFocusChanged.addListener(function (winId) { if (winId == null || winId < 0) return; try { chrome.tabs.query({ active: true, windowId: winId }, function (tabs) { var t = tabs && tabs[0]; if (t) noteActive(t.id, winId); }); } catch (e) {} }); } catch (e) {}
try {
  chrome.tabs.onRemoved.addListener(function (id) { delete tabAbil[id]; delete tabMeta[id]; delete chatRing[id]; delete seenAbil[id]; if (lastPageTab === id) lastPageTab = null; if (pulseT[id]) { clearInterval(pulseT[id]); delete pulseT[id]; } });
} catch (e) {}

// is a local model reachable? (fast-fail / race timeout lives in OllamaAdapter.available)
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (msg && msg.type === 'rook-ping') { sendResponse({ ok: true }); return true; }   // MV3 warm-up (R25 B4)
  if (msg && msg.type === 'rook-rate') {   // relay a quality/honesty rating for the last gen to the mouth (aiTextPlugin.submitUserRating)
    ensureHost('perchance.org').then(function (hostPort) {
      if (!hostPort) { try { sendResponse({ ok: false, reason: 'relay unavailable' }); } catch (e) {} return; }
      try { hostPort.postMessage({ type: 'rate', reqId: msg.reqId, score: msg.score, reason: msg.reason }); sendResponse({ ok: true }); }
      catch (e) { try { sendResponse({ ok: false, reason: 'relay send failed' }); } catch (e2) {} }
    });
    return true;   // async
  }
  if (msg && msg.type === 'rook-model-available') {
    buildAdapter().available().then(function (ok) { sendResponse({ ok: ok }); }).catch(function () { sendResponse({ ok: false }); });
    return true;
  }
  if (msg && msg.type === 'rook-model-info') {   // which model WOULD run (name/provider/endpoint) - so the bridge can show it before a call
    resolveModel().then(function (model) {
      sendResponse({ ok: true, provider: CONFIG.provider || 'ollama', model: model || CONFIG.model || '(auto)', endpoint: CONFIG.endpoint, configured: CONFIG.model || '(auto)' });
    }).catch(function () { sendResponse({ ok: true, provider: CONFIG.provider || 'ollama', model: CONFIG.model || '(auto)', endpoint: CONFIG.endpoint, configured: CONFIG.model || '(auto)' }); });
    return true;
  }
  if (msg && msg.type === 'rook-fetch') {
    safeFetch(msg.url, msg.opts).then(sendResponse);   // msg.opts (privileged) is only ever set after anchor consent
    return true;   // async
  }
  // GLOBAL MEMORY: the extension OWNS Rook's durable store (vs perchance.org's localStorage). Namespaced 'rookmem:'
  // so it can't collide with the anchor's own keys (rook:settings / rook_sb_consent). Reached only via the
  // slug-restricted 'storage' cap (the Rook bridge only) - see rook-skybridge-anchor.js.
  if (msg && msg.type === 'rook-storage') {
    var P = 'rookmem:';
    try {
      if (msg.op === 'getAll') { chrome.storage.local.get(null, function (all) { var out = {}; for (var k in all) { if (k.indexOf(P) === 0) out[k.slice(P.length)] = all[k]; } sendResponse({ ok: true, data: out }); }); return true; }
      if (msg.op === 'get') { chrome.storage.local.get(P + msg.key, function (o) { sendResponse({ ok: true, value: o[P + msg.key] }); }); return true; }
      if (msg.op === 'set') { var s = {}; s[P + msg.key] = msg.value; chrome.storage.local.set(s, function () { sendResponse({ ok: !chrome.runtime.lastError }); }); return true; }
      if (msg.op === 'setMany' && msg.data) { var sm = {}; for (var mk in msg.data) sm[P + mk] = msg.data[mk]; chrome.storage.local.set(sm, function () { sendResponse({ ok: !chrome.runtime.lastError }); }); return true; }
      if (msg.op === 'remove') { chrome.storage.local.remove(P + msg.key, function () { sendResponse({ ok: true }); }); return true; }
    } catch (e) { sendResponse({ ok: false, reason: String(e && e.message || e) }); return true; }
    sendResponse({ ok: false, reason: 'bad-op' });
  }
  // ---- the action POPUP control surface: read current-page abilities + metadata, manage per-site powers + settings ----
  if (msg && msg.type === 'rook-popup-state') {
    withPageTab(function (id) {
      var meta = (id != null && tabMeta[id]) || null;
      extGet(function (ext, sites) { sendResponse({ ok: true, page: meta, site: (meta && meta.host && sites[meta.host]) || {}, settings: ext, discovered: discovered }); });
    });
    return true;
  }
  if (msg && msg.type === 'rook-popup-open') { try { openConsole(msg.target === 'perchance' ? CONSOLE_URL : LOCAL_CONSOLE); } catch (e) {} sendResponse({ ok: true }); return; }
  if (msg && msg.type === 'rook-popup-setting') { extSet(msg.patch || {}, function (s) { sendResponse({ ok: true, settings: s }); }); return true; }
  if (msg && msg.type === 'rook-popup-site') { if (!msg.host) { sendResponse({ ok: false, reason: 'no host' }); return; } siteSet(msg.host, msg.patch || {}, function (sp) { sendResponse({ ok: true, site: sp }); }); return true; }
  if (msg && msg.type === 'rook-popup-readmeta') {
    withPageTab(function (id) {
      if (id == null) { sendResponse({ ok: false, reason: 'no page tab in focus' }); return; }
      try { chrome.tabs.sendMessage(id, { type: 'rook-read' }, function (rr) { sendResponse((chrome.runtime.lastError || !rr) ? { ok: false, reason: 'no sensor on that tab' } : rr); }); } catch (e) { sendResponse({ ok: false, reason: 'send failed' }); }
    });
    return true;
  }
  // model/endpoint config (the GPT-mouth selector now lives in the extension). No patch = read; with patch = set.
  if (msg && msg.type === 'rook-model-config') {
    if (msg.patch) { setModelConfig(msg.patch, function () { extDebugSnapshot().then(function (s) { sendResponse({ ok: true, snapshot: s }); }); }); }
    else { extDebugSnapshot().then(function (s) { sendResponse({ ok: true, snapshot: s }); }); }
    return true;
  }
  // the extension's own Debug surface: a live diagnostics snapshot (config, Ollama reachability, log ring)
  if (msg && msg.type === 'rook-ext-debug') { extDebugSnapshot().then(function (s) { sendResponse({ ok: true, snapshot: s }); }, function () { sendResponse({ ok: false }); }); return true; }
  // deep diagnostics: test the whole stack (worker/storage/perms/model/bridge) and return per-check results
  if (msg && msg.type === 'rook-ext-diagnose') { extDiagnose().then(function (s) { sendResponse({ ok: true, snapshot: s }); }, function (e) { sendResponse({ ok: false, reason: String(e && e.message || e) }); }); return true; }
  // gentle on-demand generation test against the local model (separate button — it can take ~60s)
  if (msg && msg.type === 'rook-ext-ping-model') { extPingModel().then(function (r) { sendResponse(r); }); return true; }
  // IMAGE-GEN: the local console borrows Perchance's textToImagePlugin via the relay (one-shot -> dataUrl)
  if (msg && msg.type === 'rook-perchance-image') { perchanceImage(String(msg.prompt || ''), function (r) { sendResponse(r); }); return true; }
  // BACKUP: dump all durable Rook keys from chrome.storage (rook_* / rookmem:* / rook:*). The Settings
  // page adds this extension origin's localStorage rook:* (the local console's state) before download.
  if (msg && msg.type === 'rook-ext-backup') {
    chrome.storage.local.get(null, function (all) {
      var out = {}, k; for (k in all) { if (!Object.prototype.hasOwnProperty.call(all, k)) continue; if (k === 'rook_diag_probe') continue; if (/^(rook_|rookmem:|rook:)/.test(k)) out[k] = all[k]; }
      sendResponse({ ok: true, backup: { kind: 'rook-backup', ts: Date.now(), version: (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '?', extId: chrome.runtime.id, chrome: out } });
    });
    return true;
  }
  // RESTORE: write durable keys back into chrome.storage (never apiKeys/vault — caller filters). Refresh CONFIG.
  if (msg && msg.type === 'rook-ext-restore') {
    var data = (msg.data && (msg.data.chrome || msg.data)) || {};
    var write = {}, n = 0, kk; for (kk in data) { if (!Object.prototype.hasOwnProperty.call(data, kk)) continue; if (kk === 'rook_diag_probe' || kk === 'apiKeys') continue; if (/^(rook_|rookmem:|rook:)/.test(kk)) { write[kk] = data[kk]; n++; } }
    if (!n) { sendResponse({ ok: false, reason: 'no Rook keys found in that file' }); return true; }
    chrome.storage.local.set(write, function () {
      try { chrome.storage.local.get(CFG_KEY, function (o) { var c = o && o[CFG_KEY]; if (c) { if (c.endpoint) CONFIG.endpoint = String(c.endpoint); if (typeof c.model === 'string') CONFIG.model = c.model; if (c.provider) CONFIG.provider = String(c.provider); _resolvedModel = null; } }); } catch (e) {}
      sendResponse({ ok: !chrome.runtime.lastError, restored: n });
    });
    return true;
  }
  // per-site powers: list all, or remove one host
  if (msg && msg.type === 'rook-sites-all') { chrome.storage.local.get('rook_sites', function (o) { sendResponse({ ok: true, sites: (o && o.rook_sites) || {} }); }); return true; }
  if (msg && msg.type === 'rook-site-remove') { chrome.storage.local.get('rook_sites', function (o) { var all = (o && o.rook_sites) || {}; delete all[msg.host]; chrome.storage.local.set({ rook_sites: all }, function () { sendResponse({ ok: true, sites: all }); }); }); return true; }
  // safety/verify lists (rook:settings.verify): read a summary, or clear the user's LOCAL overrides
  if (msg && msg.type === 'rook-verify') {
    chrome.storage.local.get('rook:settings', function (o) {
      var s = (o && o['rook:settings']) || {}, v = s.verify || {};
      if (msg.clear) {
        if (msg.clear === 'localBlock' || msg.clear === 'all') v.localBlock = {};
        if (msg.clear === 'localTrust' || msg.clear === 'all') v.localTrust = {};
        s.verify = v; var w = {}; w['rook:settings'] = s;
        chrome.storage.local.set(w, function () { sendResponse({ ok: true, verify: summarizeVerify(v) }); });
        return;
      }
      sendResponse({ ok: true, verify: summarizeVerify(v) });
    });
    return true;
  }
  // SELF-EDIT approval queue: the inner AI proposes changes to its own generator over the bus; the anchor
  // snoops the reserved 'weld:agent' channel and forwards proposals here to ENQUEUE. Nothing is applied
  // automatically — the console's Self-edits tab reviews each one; every status change is a human click.
  if (msg && msg.type === 'rook-selfedit') { handleSelfEdit(msg, sendResponse); return true; }
});
function summarizeVerify(v) { v = v || {}; function n(x) { return x ? Object.keys(x).length : 0; } return { rejected: n(v.rejected), verified: n(v.verified), localBlock: n(v.localBlock), localTrust: n(v.localTrust), localOnly: !!v.localOnly }; }

// ---- SELF-EDIT approval queue (durable). We only STORE and status-track proposals here; APPLYING an
//      edit is out of scope (the running generator owns its own source). Queue item shape:
//      { id, text, status:'pending'|'deferred'|'rejected'|'applied'|'error', ts, from, generator, href, note, draft }.
//      Cap the array at 100, dropping the oldest TERMINAL (applied/rejected) items first. NEVER auto-accept. ----
var SE_KEY = 'rook_selfedits', SE_SEQ = 'rook_selfedit_seq', SE_CAP = 100;
function seCapArray(q) {
  try {
    if (q.length > SE_CAP) {
      var terminal = function (s) { return s === 'applied' || s === 'rejected'; };
      for (var i = 0; i < q.length && q.length > SE_CAP;) { if (terminal(q[i].status)) q.splice(i, 1); else i++; }
      if (q.length > SE_CAP) q = q.slice(q.length - SE_CAP);   // still over -> hard-trim oldest
    }
  } catch (e) {}
  return q;
}
// fan the new status out to every open perchance anchor so the INNER AI hears it over the agent bus
function seBroadcastStatus(item, text) {
  try {
    chrome.tabs.query({ url: ['*://perchance.org/*', '*://*.perchance.org/*'] }, function (tabs) {
      if (chrome.runtime.lastError || !tabs) return;
      tabs.forEach(function (t) {
        if (!t || t.id == null) return;
        try { chrome.tabs.sendMessage(t.id, { type: 'rook-selfedit-status', id: item.id, status: item.status, text: text }, function () { void chrome.runtime.lastError; }); } catch (e) {}
      });
    });
  } catch (e) {}
}
function handleSelfEdit(msg, sendResponse) {
  var op = msg && msg.op;
  try {
    chrome.storage.local.get([SE_KEY, SE_SEQ], function (o) {
      var q = (o && o[SE_KEY]); if (!Array.isArray(q)) q = [];
      var seq = (o && +o[SE_SEQ]) || 0;
      if (op === 'list') { sendResponse({ ok: true, items: q }); return; }
      if (op === 'enqueue') {
        var p = msg.proposal || {};
        var id = seq + 1;
        var item = { id: id, text: String(p.text == null ? '' : p.text), status: 'pending', ts: Date.now(),
          from: String(p.from || 'inner'), generator: String(p.generator || ''), href: String(p.href || ''), note: '', draft: null };
        q.push(item); q = seCapArray(q);
        var w = {}; w[SE_KEY] = q; w[SE_SEQ] = id;
        chrome.storage.local.set(w, function () { sendResponse({ ok: !chrome.runtime.lastError, item: item }); });
        return;
      }
      if (op === 'update') {
        var found = null, i;
        for (i = 0; i < q.length; i++) { if (q[i].id === msg.id) { found = q[i]; break; } }
        if (!found) { sendResponse({ ok: false, reason: 'not-found' }); return; }
        var patch = msg.patch || {};
        if (typeof patch.status === 'string') found.status = patch.status;
        if (typeof patch.note === 'string') found.note = patch.note;
        if (Object.prototype.hasOwnProperty.call(patch, 'draft')) found.draft = patch.draft;
        if (typeof patch.text === 'string') found.text = patch.text;
        q = seCapArray(q);
        var w2 = {}; w2[SE_KEY] = q;
        chrome.storage.local.set(w2, function () {
          try { if (/^(applied|rejected|deferred)$/.test(found.status)) seBroadcastStatus(found, String(msg.statusText || ('Proposal #' + found.id + ' is now ' + found.status + '.'))); } catch (e) {}
          sendResponse({ ok: !chrome.runtime.lastError, item: found });
        });
        return;
      }
      if (op === 'remove') {
        q = q.filter(function (x) { return x.id !== msg.id; });
        var w3 = {}; w3[SE_KEY] = q;
        chrome.storage.local.set(w3, function () { sendResponse({ ok: !chrome.runtime.lastError }); });
        return;
      }
      sendResponse({ ok: false, reason: 'bad-op' });
    });
  } catch (e) { try { sendResponse({ ok: false, reason: String(e && e.message || e).slice(0, 120) }); } catch (e2) {} }
}

// ---- background backend hosts: run an AI site in a hidden minimized popup and
//      route chat requests to it (Rook can be open on any other tab) ----
// The "borrow a foreign chatbot" backends (duck.ai / chatgpt / gemini / copilot) were RETIRED — Rook's mouth is now
// local Ollama plus the Perchance relay. Perchance is the only remaining background host: the popup IS the perchance
// bridge (see openConsole) and it calls aiTextPlugin natively; ensureHost('perchance.org') still opens the relay tab
// for the borrowed Mouth + Image-gen path (reuses the full rook-ai bridge as host).
var BACKEND_URL = { 'perchance.org': 'https://perchance.org/rook-ai' };
var hostPorts = {};     // hostname -> the backend tab's relay port
var hostWindows = {};   // hostname -> windowId
var hostWaiters = {};   // hostname -> [resolve,...]
var pending = {};       // reqId -> the drawer port to stream back to
var reqSeq = 0;

function ensureHost(backend) {
  if (hostPorts[backend]) return Promise.resolve(hostPorts[backend]);
  var url = BACKEND_URL[backend];
  if (!url) return Promise.resolve(null);
  return new Promise(function (resolve) {
    (hostWaiters[backend] = hostWaiters[backend] || []).push(resolve);
    if (hostWindows[backend] != null) return;            // already opening
    hostWindows[backend] = -1;
    try {
      // created minimized from the start (no width/height with `state`) so the backend
      // page loads hidden — no popup flashes onto the user's screen on send.
      chrome.windows.create({ url: url, type: 'popup', focused: false, state: 'minimized' }, function (win) {
        if (!win) { flushWaiters(backend, null); hostWindows[backend] = null; return; }
        hostWindows[backend] = win.id;
        try { chrome.windows.update(win.id, { state: 'minimized', focused: false }); } catch (e) {}   // belt-and-suspenders: keep it down if the platform briefly restored it
        setTimeout(function () { if (!hostPorts[backend]) flushWaiters(backend, null); }, 20000);  // give the page time to load + register
      });
    } catch (e) { flushWaiters(backend, null); hostWindows[backend] = null; }
  });
}
function flushWaiters(backend, val) {
  var ws = hostWaiters[backend] || []; hostWaiters[backend] = [];
  ws.forEach(function (r) { try { r(val); } catch (e) {} });
}

// presence: count tabs with Rook actively open, broadcast the count to all of them
var presencePorts = new Set();
function broadcastPresence() {
  var n = presencePorts.size;
  updateKeepAlive();   // warm the worker while a surface is open; let it sleep when none are
  presencePorts.forEach(function (p) { try { p.postMessage({ type: 'presence', n: n }); } catch (e) {} });
}
// ---- keep the worker WARM while a Rook surface is open (NOT 24/7). An MV3 service worker goes
//      "Inactive" after ~30s idle by design; for Rook that means the next model call / anchor request
//      pays a cold-start. So we run a 30s keep-alive ALARM only while >=1 surface is connected, and
//      clear it the moment none are - good citizen: warm in use, asleep when idle. (alarms persist
//      across SW restarts; a trivial async API call on each wake resets the ~30s idle timer.) ----
function updateKeepAlive() {
  try { if (presencePorts.size > 0) chrome.alarms.create('rook-keepalive', { periodInMinutes: 0.5 }); else chrome.alarms.clear('rook-keepalive'); } catch (e) {}
}
chrome.alarms.onAlarm.addListener(function (a) {
  if (a && a.name === 'rook-keepalive' && presencePorts.size > 0) { try { chrome.runtime.getPlatformInfo(function () { void chrome.runtime.lastError; }); } catch (e) {} }
});

// ===== TIERED BRAIN (Stage A): the SINGLE always-on brain lives in a persistent offscreen document =========
// The offscreen doc (offscreen.html -> offscreen.js) hosts the one makeApp() instance that owns IndexedDB
// "rook-brain". The side-panel console + other surfaces are thin clients that RPC in through this worker.
//
// MESSAGE DISAMBIGUATION (avoids the worker re-handling its own forward, and the offscreen doc echoing):
//   client  -> worker   : { type:'rook-brain',      op, args }   (handled below; forwards on)
//   worker  -> offscreen : { type:'rook-brain-call', op, args }   (answered ONLY by offscreen.js)
// The two frame types are distinct, and runtime.sendMessage is never delivered back to its own sender, so
// there is no loop: only offscreen.js listens for 'rook-brain-call', and it never emits 'rook-brain'.
//
// OFFSCREEN reasons: chrome.offscreen has no generic "compute" reason, so we pick 'BLOBS' from the enum --
// accurate (the brain serializes/exports its state as JSON blobs) and accepted by Chrome for a long-lived
// data-processing host. (WORKERS is not a valid Reason; DOM/media reasons don't fit a headless compute doc.)
//
// KEEP-ALIVE: Chrome does NOT idle-kill an offscreen document the way it retires an idle service worker, and
// the brain's own timers (reachOut 60s / consolidate 180s / tick 30s in offscreen.js) keep it continuously
// active. As belt-and-suspenders, the worker (re-)ensures the doc on startup and on the keepalive alarm, so
// if it is ever torn down (extension reload / crash) it is transparently recreated.
var _offscreenCreating = null;   // in-flight createDocument promise (single-flight; also guards the create race)
function ensureOffscreen() {
  if (typeof chrome === 'undefined' || !chrome.offscreen) return Promise.resolve(false);   // API unavailable (old Chrome) -> caller degrades
  return Promise.resolve()
    .then(function () { return chrome.offscreen.hasDocument ? chrome.offscreen.hasDocument() : false; })
    .then(function (has) {
      if (has) return true;
      if (_offscreenCreating) return _offscreenCreating.then(function () { return true; });
      // Chrome allows only ONE offscreen document, and the brain owns it. The OPT-IN perception capture
      // (perceive-capture.js) is folded into this same doc, so we also declare USER_MEDIA (camera) and, where the
      // Chrome build supports it, GEOLOCATION. Declaring a reason does NOT start capture or raise any prompt — the
      // camera/location APIs stay untouched until a perceive-consented generator makes the worker send the start cmd.
      var R = chrome.offscreen.Reason || {};
      var reasons = [R.BLOBS || 'BLOBS', R.USER_MEDIA || 'USER_MEDIA'];
      if (R.GEOLOCATION) reasons.push(R.GEOLOCATION);   // guarded: absent on older Chrome, where offscreen geo is unsupported anyway
      _offscreenCreating = chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: reasons,
        justification: 'Host the persistent, always-on Rook brain (single IndexedDB owner + autonomous cognition), plus opt-in perception capture the user enables per generator.'
      }).then(function () { _offscreenCreating = null; return true; })
        .catch(function (e) {
          _offscreenCreating = null;
          // "Only a single offscreen document may be created" -> a concurrent create won the race; treat as success.
          if (/single offscreen|already/i.test(String(e && e.message || e))) return true;
          wlog('offscreen: create failed: ' + String(e && e.message || e).slice(0, 160), 'error');
          return false;
        });
      return _offscreenCreating.then(function () { return true; });
    })
    .catch(function (e) { wlog('offscreen: ensure failed: ' + String(e && e.message || e).slice(0, 160), 'error'); return false; });
}
// forward one brain RPC to the offscreen doc and relay its response back to the client
function callBrain(op, args, sendResponse) {
  ensureOffscreen().then(function (ok) {
    if (!ok) { try { sendResponse({ ok: false, reason: 'offscreen brain unavailable (chrome.offscreen not supported or failed to create)' }); } catch (e) {} return; }
    try {
      chrome.runtime.sendMessage({ type: 'rook-brain-call', op: op, args: args || [] }, function (resp) {
        var le = chrome.runtime.lastError;
        if (le || !resp) { try { sendResponse({ ok: false, reason: 'brain did not answer' + (le ? ' (' + le.message + ')' : '') }); } catch (e) {} return; }
        try { sendResponse(resp); } catch (e) {}
      });
    } catch (e) { try { sendResponse({ ok: false, reason: String(e && e.message || e).slice(0, 200) }); } catch (e2) {} }
  });
}
// EXTERNAL (skybridge / web page) brain access is HARD-RESTRICTED to a safe read/converse subset. A generator
// that "powers up" over the bridge may talk to the full brain and read/steer its everyday state, but must NEVER
// reach identity rewrites, backups, portability, safety controls, or destructive memory ops -- those stay for
// the trusted console/worker path (rook-brain). Defense in depth: the anchor gates too, this is the backstop.
var BRAIN_EXT_SAFE = {
  send: 1, quickAsk: 1, status: 1, feeling: 1, bond: 1, body: 1, hormones: 1, beliefs: 1,
  listGoals: 1, addGoal: 1, completeGoal: 1, dropGoal: 1, listHabits: 1,
  reachOut: 1, whatsNew: 1, imagine: 1, innerThought: 1, wander: 1, ruminate: 1, express: 1, welcome: 1,
  identityDigest: 1, listMemories: 1, addFact: 1, getSelf: 1, tempoState: 1,   // consolidate/reflect removed: CPU-heavy autonomous ops a third-party page has no reason to trigger
  drives: 1, setDrive: 1, frameJack: 1   // inner-state dashboard: read felt-need drives + honest single-drive/tempo steer
};
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (msg && msg.type === 'rook-brain') { callBrain(msg.op, msg.args, sendResponse); return true; }        // trusted: console/worker
  if (msg && msg.type === 'rook-brain-ext') {                                                              // external: skybridge page
    if (!BRAIN_EXT_SAFE[msg.op]) { try { sendResponse({ ok: false, reason: 'op not permitted over the bridge: ' + String(msg.op) }); } catch (e) {} return true; }
    callBrain(msg.op, msg.args, sendResponse); return true;
  }
});
// spin the brain up as soon as the worker loads, and keep it up via the keepalive alarm
try { ensureOffscreen(); } catch (e) {}
chrome.alarms.onAlarm.addListener(function (a) { if (a && a.name === 'rook-keepalive') { try { ensureOffscreen(); } catch (e) {} } });
// the keepalive alarm only runs while a surface is connected; also arm it once now so the offscreen brain
// is watched even before the first console opens (cleared behavior is unchanged elsewhere).
try { chrome.alarms.create('rook-keepalive', { periodInMinutes: 0.5 }); } catch (e) {}

// ===== SKYBRIDGE SOCKET HUB - live WebSockets to localhost/LAN on a page's behalf =======================================
// A Perchance generator runs in a sandboxed iframe that cannot open ws://localhost (the same wall that blocks in-page
// Web Bluetooth). The skybridge anchor (content script) relays a consent-gated `socket` capability here over a long-lived
// Port ('rook-socket'); THIS worker holds the real WebSocket (it already holds one to the Moot server the same way) and
// shuttles frames both ways. Frames pass through UNREAD. One Port per anchor tab; a Port's sockets die with it. The
// anchor pings the Port every ~20s while sockets are open so the MV3 worker is not put to sleep mid-session.
var SOCK_MAX_PER_PORT = 4, SOCK_MAX_TOTAL = 12, SOCK_MAX_FRAME = 262144, sockTotal = 0;
function sockHub(port) {
  var socks = {};   // id -> WebSocket
  function say(o) { try { port.postMessage(o); } catch (e) {} }
  function drop(id) { if (socks[id]) { delete socks[id]; sockTotal = Math.max(0, sockTotal - 1); } }
  function closeAll(reason) { for (var id in socks) { if (!socks.hasOwnProperty(id)) continue; try { socks[id].close(1000, reason || 'port closed'); } catch (e) {} } socks = {}; }
  function validCode(c) { c = Number(c); return (c === 1000 || (c >= 3000 && c <= 4999)) ? c : 1000; }
  port.onMessage.addListener(function (m) {
    if (!m || !m.op) return;
    if (m.op === 'ping') { say({ ev: 'pong', t: Date.now() }); return; }   // keepalive: the receipt itself resets the SW idle timer
    var id = String(m.id || '');
    if (m.op === 'open') {
      var u; try { u = new URL(String(m.url || '')); } catch (e) { say({ ev: 'error', id: id, reason: 'bad-url' }); return; }
      if (u.protocol !== 'ws:' && u.protocol !== 'wss:') { say({ ev: 'error', id: id, reason: 'bad-scheme' }); return; }
      if (socks[id]) { say({ ev: 'error', id: id, reason: 'duplicate-id' }); return; }
      if (Object.keys(socks).length >= SOCK_MAX_PER_PORT || sockTotal >= SOCK_MAX_TOTAL) { say({ ev: 'error', id: id, reason: 'too-many-sockets' }); return; }
      var ws;
      try { ws = m.protocols ? new WebSocket(u.href, m.protocols) : new WebSocket(u.href); }
      catch (e) { say({ ev: 'error', id: id, reason: String(e && e.message || e).slice(0, 120) }); return; }
      ws.binaryType = 'arraybuffer';
      socks[id] = ws; sockTotal++;
      ws.onopen = function () { wlog('socket: open ' + u.host + ' (' + id + ')'); say({ ev: 'open', id: id, protocol: ws.protocol || '' }); };
      ws.onmessage = function (ev) {
        if (typeof ev.data === 'string') { say({ ev: 'message', id: id, data: (ev.data.length > SOCK_MAX_FRAME ? ev.data.slice(0, SOCK_MAX_FRAME) : ev.data) }); return; }
        try { var b = new Uint8Array(ev.data), s = '', i; for (i = 0; i < b.length && i < SOCK_MAX_FRAME; i++) s += String.fromCharCode(b[i]); say({ ev: 'message', id: id, binary: true, data: btoa(s) }); } catch (e) {}
      };
      ws.onerror = function () { say({ ev: 'error', id: id, reason: 'socket error' }); };
      ws.onclose = function (ev) { drop(id); wlog('socket: closed ' + u.host + ' (' + id + ')'); say({ ev: 'close', id: id, code: (ev && ev.code) || 1005, reason: (ev && ev.reason) || '' }); };
      return;
    }
    var ws2 = socks[id];
    if (!ws2) { if (m.op !== 'close') say({ ev: 'error', id: id, reason: 'no-such-socket' }); return; }
    if (m.op === 'send') {
      if (ws2.readyState !== 1) { say({ ev: 'error', id: id, reason: 'not-open' }); return; }
      var data = m.data;
      if (typeof data !== 'string') { say({ ev: 'error', id: id, reason: 'bad-data' }); return; }
      if (data.length > SOCK_MAX_FRAME) { say({ ev: 'error', id: id, reason: 'frame-too-large' }); return; }
      try {
        if (m.binary) { var bin = atob(data), arr = new Uint8Array(bin.length), j; for (j = 0; j < bin.length; j++) arr[j] = bin.charCodeAt(j); ws2.send(arr.buffer); }
        else ws2.send(data);
      } catch (e) { say({ ev: 'error', id: id, reason: String(e && e.message || e).slice(0, 120) }); }
      return;
    }
    if (m.op === 'close') { try { ws2.close(validCode(m.code), String(m.reason || '').slice(0, 100)); } catch (e) { drop(id); } return; }
  });
  port.onDisconnect.addListener(function () { closeAll('anchor gone'); });
}

// ===== SKYBRIDGE SERIAL HUB - live USB-Serial to a locally-plugged device (an OSSM @115200) on a page's behalf ==========
// navigator.serial is NOT available in this MV3 worker (it needs a document context), so UNLIKE the socket hub the worker
// does NOT hold the port here: it is only a ROUTER. The one-time port GRANT happens in the extension POPUP (requestPort,
// a user gesture); the live port is opened + read/written in the persistent OFFSCREEN document (offscreen-serial.js,
// which can getPorts() with no gesture). The anchor's 'rook-serial' Port relays list/open/write/close DOWN to here; we
// forward each to the offscreen and shuttle its replies + streamed bytes back UP. Incoming bytes reach the page on bus
// topic 'rook:serial' (the anchor publishes them). serialOwners maps a serial id -> the anchor Port that opened it, so an
// async rx/close push from the offscreen goes only to that owner. The anchor pings the Port every ~20s (keepalive).
var serialOwners = {};   // serial id -> the 'rook-serial' Port that owns it
function serialHub(port) {
  var ownIds = {};   // ids opened through THIS port
  function say(o) { try { port.postMessage(o); } catch (e) {} }
  port.onMessage.addListener(function (m) {
    if (!m || !m.op) return;
    if (m.op === 'ping') { say({ ev: 'pong', t: Date.now() }); return; }   // keepalive: the receipt itself resets the SW idle timer
    if (m.op === 'list') {
      ensureOffscreen().then(function (ok) {
        if (!ok) { say({ ev: 'list', reqId: m.reqId, ports: [] }); return; }
        try { chrome.runtime.sendMessage({ type: 'rook-serial', op: 'list' }, function (r) { void chrome.runtime.lastError; say({ ev: 'list', reqId: m.reqId, ports: (r && r.ports) || [] }); }); }
        catch (e) { say({ ev: 'list', reqId: m.reqId, ports: [] }); }
      });
      return;
    }
    if (m.op === 'open') {
      ensureOffscreen().then(function (ok) {
        if (!ok) { say({ ev: 'open', reqId: m.reqId, ok: false, reason: 'offscreen-unavailable' }); return; }
        try {
          chrome.runtime.sendMessage({ type: 'rook-serial', op: 'open', path: m.path, baud: m.baud }, function (r) {
            void chrome.runtime.lastError; r = r || { ok: false, reason: 'no-answer' };
            if (r.ok && r.id) { serialOwners[r.id] = port; ownIds[r.id] = 1; wlog('serial: open ' + r.id); }
            say({ ev: 'open', reqId: m.reqId, ok: !!r.ok, id: r.id, reason: r.reason });
          });
        } catch (e) { say({ ev: 'open', reqId: m.reqId, ok: false, reason: 'worker-unreachable' }); }
      });
      return;
    }
    var id = String(m.id || '');
    if (m.op === 'write') {
      if (!ownIds[id]) { say({ ev: 'error', id: id, reason: 'no-such-port' }); return; }   // a page may only touch ITS OWN ports
      try { chrome.runtime.sendMessage({ type: 'rook-serial', op: 'write', id: id, dataB64: m.dataB64 }, function () { void chrome.runtime.lastError; }); } catch (e) {}
      return;
    }
    if (m.op === 'close') {
      if (ownIds[id]) { delete ownIds[id]; delete serialOwners[id]; try { chrome.runtime.sendMessage({ type: 'rook-serial', op: 'close', id: id }, function () { void chrome.runtime.lastError; }); } catch (e) {} }
      say({ ev: 'close', id: id });
      return;
    }
  });
  port.onDisconnect.addListener(function () {
    for (var id in ownIds) { if (ownIds.hasOwnProperty(id)) { delete serialOwners[id]; try { chrome.runtime.sendMessage({ type: 'rook-serial', op: 'close', id: id }, function () { void chrome.runtime.lastError; }); } catch (e) {} } }
  });
}
// offscreen -> here: streamed bytes + port-lost events. Route each to the owning anchor Port (which publishes it on
// bus 'rook:serial'). Fire-and-forget (no sendResponse), so it never blocks the offscreen's read loop.
chrome.runtime.onMessage.addListener(function (m) {
  if (!m) return;
  if (m.type === 'rook-serial-rx') { var p = serialOwners[m.id]; if (p) { try { p.postMessage({ ev: 'rx', id: m.id, b64: m.b64 }); } catch (e) {} } return; }
  if (m.type === 'rook-serial-event') { var p2 = serialOwners[m.id]; if (p2) { try { p2.postMessage({ ev: m.event || 'close', id: m.id, reason: m.reason }); } catch (e) {} } if (m.event === 'close') delete serialOwners[m.id]; return; }
});

// stream a completion for the content-script brain
chrome.runtime.onConnect.addListener(function (port) {
  // a backend host tab's relay registers + carries its replies
  if (port.name === 'rook-host') {
    var hn = null;
    port.onMessage.addListener(function (m) {
      if (!m) return;
      if (m.type === 'register') { hn = m.host; hostPorts[hn] = port; flushWaiters(hn, port); }
      else if (m.type === 'token' || m.type === 'done' || m.type === 'error' || m.type === 'image-done') {
        var dport = pending[m.reqId];
        if (dport) { try { dport.postMessage(m); } catch (e) {} if (m.type !== 'token') delete pending[m.reqId]; }
        if (m.type !== 'token') stopKeepAlive(m.reqId);   // gen settled: end the keepalive tick
      }
    });
    port.onDisconnect.addListener(function () { if (hn && hostPorts[hn] === port) { delete hostPorts[hn]; hostWindows[hn] = null; } cancelAllKeepAlives('perchance relay tab closed'); });
    return;
  }
  // a drawer requesting a background backend
  if (port.name === 'rook-remote') {
    port.onMessage.addListener(function (m) {
      if (!m || m.type !== 'chat') return;
      var reqId = 'rq' + (reqSeq++);
      pending[reqId] = port;
      try { port.postMessage({ type: 'status', note: 'waking ' + m.backend + '…' }); } catch (e) {}
      ensureHost(m.backend).then(function (hostPort) {
        if (!hostPort) { try { port.postMessage({ type: 'error', error: 'could not open backend ' + m.backend }); } catch (e) {} delete pending[reqId]; return; }
        try { hostPort.postMessage({ type: 'chat', reqId: reqId, messages: m.messages }); }
        catch (e) { try { port.postMessage({ type: 'error', error: 'host send failed' }); } catch (e2) {} delete pending[reqId]; }
      });
    });
    return;
  }
  if (port.name === 'rook-presence') {
    presencePorts.add(port);
    broadcastPresence();
    port.onMessage.addListener(function () { /* heartbeat ping - the receipt itself resets the SW idle timer */ });
    port.onDisconnect.addListener(function () { presencePorts.delete(port); broadcastPresence(); });
    return;
  }
  if (port.name === 'rook-socket') { sockHub(port); return; }   // skybridge `socket` cap: the anchor's live-WebSocket relay
  if (port.name === 'rook-serial') { serialHub(port); return; }   // skybridge `serial` cap: the anchor's USB-Serial relay (port held in the offscreen doc)
  if (port.name !== 'rook-model') return;
  // the requester (drawer/tab) went away mid-gen: cancel any in-flight perchance request it owned so the
  // keepalive interval + pending entry don't leak (perchanceModelChat sets pending[reqId] = this port).
  port.onDisconnect.addListener(function () { for (var rid in pending) { if (pending.hasOwnProperty(rid) && pending[rid] === port) { stopKeepAlive(rid); delete pending[rid]; } } });
  port.onMessage.addListener(function (msg) {
    if (!msg || msg.type !== 'chat') return;
    if ((CONFIG.provider || 'ollama') === 'perchance') { perchanceModelChat(msg, port); return; }   // borrowed mouth: route through the relay
    var t0 = Date.now();
    resolveModel().then(function (model) {
      wlog('ai chat -> ' + model + (msg.stream ? ' (stream)' : '') + (msg.think ? ' (think)' : ''));
      return buildAdapter(model).chat(msg.messages, {
        stream: !!msg.stream,
        think: !!msg.think,
        onToken: function (t) { try { port.postMessage({ type: 'token', t: t }); } catch (e) {} },
      });
    }).then(function (text) {
      wlog('ai done in ' + (Date.now() - t0) + 'ms, ' + String(text || '').length + ' chars');
      try { port.postMessage({ type: 'done', text: text }); } catch (e) {}
    }).catch(function (err) {
      wlog('ai error: ' + String(err && err.message || err).slice(0, 160), 'error');
      try { port.postMessage({ type: 'error', error: String(err && err.message || err) }); } catch (e) {}
    });
  });
});

// ===== MOOT MOUTH BRIDGE — offer this browser's FREE PERCHANCE mouth to a Rook Moot server ==============================
// The extension connects OUT to a Moot server (a WebSocket at ws://host:port) and registers as a free text-generation
// provider. Any bot on the mesh can then ask the Moot to generate, and the Moot routes the request here; we answer with
// Perchance's free aiTextPlugin via the existing relay. SECURITY: this exposes ONLY the keyless Perchance mouth — never
// safeFetch, never a logged-in chat session, never memory. Off by default; the operator sets the Moot URL explicitly.
// Point it at YOUR OWN server (ideally ws://127.0.0.1:8791 on the same box). Enable:
//   chrome.storage.local.set({ rook_moot_url: 'ws://127.0.0.1:8791' })   // '' or unset = off
var MOOT_ID = 'ext-perchance-mouth', mootWS = null, mootUrl = '', mootTimer = null, mootPing = null, mootBackoff = 1000;
function perchanceGenerate(messages, done) {   // one non-streaming completion via the Perchance relay → done(text) | done(null, err)
  var reqId = 'mo' + (reqSeq++), settled = false;
  ensureHost('perchance.org').then(function (hostPort) {
    if (!hostPort) { done(null, 'Perchance relay unavailable — open perchance.org/rook-ai'); return; }
    pending[reqId] = { postMessage: function (m) {
      if (settled) return;
      if (m.type === 'done') { settled = true; delete pending[reqId]; done(String(m.text || '')); }
      else if (m.type === 'error') { settled = true; delete pending[reqId]; done(null, String(m.error || 'relay error')); }
    } };
    try { hostPort.postMessage({ type: 'chat', reqId: reqId, messages: messages }); }
    catch (e) { settled = true; delete pending[reqId]; done(null, 'relay send failed'); }
    setTimeout(function () { if (!settled) { settled = true; delete pending[reqId]; done(null, 'relay timeout'); } }, 60000);
  });
}
function mootSend(o) { try { if (mootWS && mootWS.readyState === 1) mootWS.send(JSON.stringify(o)); } catch (e) {} }
function mootConnect() {
  if (!mootUrl || (mootWS && (mootWS.readyState === 0 || mootWS.readyState === 1))) return;
  try { mootWS = new WebSocket(mootUrl); } catch (e) { wlog('moot: bad url ' + mootUrl, 'error'); return; }
  mootWS.onopen = function () {
    wlog('moot: connected ' + mootUrl); mootBackoff = 1000;
    mootSend({ t: 'announce', from: MOOT_ID, proto: 1, cert: { id: MOOT_ID, name: 'Perchance Mouth' } });   // proto = PROTOCOL_VERSION (server rejects a missing/mismatched version → frames get pre-announce-held)
    mootSend({ t: 'mouth-offer', from: MOOT_ID, kinds: ['perchance', 'default'] });
    mootSend({ t: 'tool-offer', from: MOOT_ID, tools: ['image'], max: 1 });   // also serve free image-gen (Perchance textToImagePlugin)
    if (mootPing) clearInterval(mootPing);
    mootPing = setInterval(function () { mootSend({ t: 'beacon', from: MOOT_ID, beacon: { id: MOOT_ID } }); }, 20000);   // keep the WS (and the MV3 worker) warm
  };
  mootWS.onmessage = function (ev) {
    var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (!m || m.from === MOOT_ID) return;
    if (m.t === 'mouth-do' && m.reqId) {
      perchanceGenerate((m.messages || []).slice(-12), function (text, err) {
        if (err) mootSend({ t: 'mouth-error', from: MOOT_ID, reqId: m.reqId, error: err });
        else mootSend({ t: 'mouth-reply', from: MOOT_ID, reqId: m.reqId, text: String(text || '').slice(0, 2000) });
      });
    } else if (m.t === 'tool-do' && m.reqId && m.tool === 'image') {
      perchanceImage(String((m.args && m.args.prompt) || ''), function (r) {
        if (r && r.ok && r.dataUrl) mootSend({ t: 'tool-reply', from: MOOT_ID, reqId: m.reqId, tool: 'image', result: { dataUrl: r.dataUrl } });
        else mootSend({ t: 'tool-error', from: MOOT_ID, reqId: m.reqId, code: 'image-failed', error: (r && r.error) || 'no image' });
      });
    }
  };
  mootWS.onclose = function () { wlog('moot: closed'); if (mootPing) { clearInterval(mootPing); mootPing = null; } mootWS = null; if (mootUrl) { mootBackoff = Math.min(mootBackoff * 2, 30000); mootTimer = setTimeout(mootConnect, mootBackoff); } };
  mootWS.onerror = function () { try { mootWS.close(); } catch (e) {} };
}
function mootDisconnect() { mootUrl = ''; if (mootTimer) { clearTimeout(mootTimer); mootTimer = null; } if (mootPing) { clearInterval(mootPing); mootPing = null; } try { if (mootWS) mootWS.close(); } catch (e) {} mootWS = null; }
function mootApply(url) { mootDisconnect(); mootUrl = String(url || '').trim(); if (mootUrl) { mootBackoff = 1000; mootConnect(); wlog('moot: bridging to ' + mootUrl); } }
try { chrome.storage.local.get('rook_moot_url', function (o) { if (o && o.rook_moot_url) mootApply(o.rook_moot_url); }); } catch (e) {}
try { chrome.storage.onChanged && chrome.storage.onChanged.addListener(function (ch, area) { if (area === 'local' && ch.rook_moot_url) mootApply(ch.rook_moot_url.newValue || ''); }); } catch (e) {}
// keep the worker warm while bridging (WS activity resets the idle timer, but belt-and-suspenders via the keepalive alarm)
chrome.alarms.onAlarm.addListener(function (a) { if (a && a.name === 'rook-keepalive' && mootUrl && (!mootWS || mootWS.readyState > 1)) mootConnect(); });
// message API so the popup/console can set the Moot URL: {type:'rook-moot-config', url} → connect; url:'' → off
chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (msg && msg.type === 'rook-moot-config') {
    try { chrome.storage.local.set({ rook_moot_url: String(msg.url || '') }); } catch (e) {}
    mootApply(msg.url || '');
    sendResponse({ ok: true, url: mootUrl, connected: !!(mootWS && mootWS.readyState === 1) });
    return true;
  }
  if (msg && msg.type === 'rook-moot-status') { sendResponse({ ok: true, url: mootUrl, connected: !!(mootWS && mootWS.readyState === 1) }); return true; }
});

// TWITCH VTuber bridge REMOVED 2026-08-31 (Fish): it injected external stream-chat toward the Moot/AI (same
// external-message vector as the retired World/Inbox chat) and pulled a broad twitch.tv host-permission. Dropped
// the bridge code + the manifest twitch.tv host_permission. Can be re-added later behind a stranger-chat safety model.

// ===== SOMA HR HUB — live Body signals to Perchance ==================================================================
// The Web Bluetooth HR page (hr.html / hr-ble.js) reads the STANDARD BLE Heart Rate profile (0x180D/0x2A37) — the same
// stream Rook-Face reads on the phone — and pushes { type:'rook-hr', bpm, hrv?, rr?, ts } here. We cache the latest and
// fan it out to every perchance.org anchor tab as { type:'rook-soma', ch:{hr,hrv} }, which the anchor republishes on the
// Skybridge 'soma' cap. NO server, NO Node: the PC talks to the sensor directly over Bluetooth.
var somaLatest = { t: 0, ch: {} };
function somaBroadcast(ch) {
  try {
    chrome.tabs.query({ url: ['*://perchance.org/*', '*://*.perchance.org/*'] }, function (tabs) {
      if (chrome.runtime.lastError || !tabs) return;
      for (var i = 0; i < tabs.length; i++) {
        try { chrome.tabs.sendMessage(tabs[i].id, { type: 'rook-soma', ch: ch, t: somaLatest.t }, function () { void chrome.runtime.lastError; }); } catch (e) {}
      }
    });
  } catch (e) {}
}
chrome.runtime.onMessage.addListener(function (m, sender, sendResponse) {
  if (!m) return;
  if (m.type === 'rook-hr') {
    var ch = {};
    var bpm = Number(m.bpm); if (isFinite(bpm) && bpm > 0) ch.hr = Math.round(bpm);
    var hrv = Number(m.hrv); if (isFinite(hrv) && hrv > 0) ch.hrv = hrv;
    if (Object.keys(ch).length) { somaLatest = { t: Date.now(), ch: ch }; somaBroadcast(ch); }
    try { sendResponse({ ok: true }); } catch (e) {}
    return true;
  }
  if (m.type === 'rook-soma-latest') {   // a freshly-loaded anchor asks for the last reading
    try { sendResponse({ ok: true, ch: somaLatest.ch, t: somaLatest.t }); } catch (e) {}
    return true;
  }
  if (m.type === 'rook-hr-status') {     // hr.html can report connect/disconnect for UI; just log
    try { wlog('HR sensor ' + String(m.state || '?') + (m.device ? ' (' + m.device + ')' : '')); } catch (e) {}
    try { sendResponse({ ok: true }); } catch (e) {}
    return true;
  }
});

// ===== PERCEIVE HUB — opt-in vision/device/geo signals to Perchance (mirrors the SOMA HR HUB) =========================
// The OPT-IN capture doc (perceive-capture.js, inside the single offscreen document) reduces camera/geolocation/idle to
// coarse scalars ON-DEVICE and pushes { type:'rook-perceive', organ, data } here. We cache the latest per organ and fan
// it out to every perchance.org anchor tab as { type:'rook-perceive-organ', organ, data, t }, which the anchor republishes
// on the Skybridge 'perceive' cap → bus channel 'rook:perceive'. RAW FRAMES / RAW COORDS never reach this worker — only
// the derived scalars. Capture is worker-controlled and consent-linked: an anchor asks us to start/stop as its generators
// grant/drop `perceive` consent; we ref-count those requests per tab and drive the offscreen capture doc accordingly, so
// with no consent there is no capture and the OS camera/location prompt never appears.
var perceiveLatest = {};                 // organ -> { data, t }
var perceiveWants = {};                  // tabId -> [organs] the tab's consented generators want captured
var perceiveActiveWhich = [];            // organs currently being captured (union across tabs)
function perceiveBroadcast(organ, data, t) {
  try {
    chrome.tabs.query({ url: ['*://perchance.org/*', '*://*.perchance.org/*'] }, function (tabs) {
      if (chrome.runtime.lastError || !tabs) return;
      for (var i = 0; i < tabs.length; i++) {
        try { chrome.tabs.sendMessage(tabs[i].id, { type: 'rook-perceive-organ', organ: organ, data: data, t: t }, function () { void chrome.runtime.lastError; }); } catch (e) {}
      }
    });
  } catch (e) {}
}
// recompute the union of wanted organs across all tabs; (re)drive the offscreen capture doc. Empty union → stop.
function perceiveSyncCapture() {
  var set = {}, tid, arr, i;
  for (tid in perceiveWants) { if (!perceiveWants.hasOwnProperty(tid)) continue; arr = perceiveWants[tid] || []; for (i = 0; i < arr.length; i++) set[arr[i]] = true; }
  var which = Object.keys(set);
  perceiveActiveWhich = which;
  var on = which.length > 0;
  ensureOffscreen().then(function (ok) {
    if (!ok) return;   // no offscreen host → capture simply can't run (degrade; the brain path logs its own failure)
    try { chrome.runtime.sendMessage({ type: 'rook-perceive-capture-cmd', on: on, which: which }, function () { void chrome.runtime.lastError; }); } catch (e) {}
  });
}
chrome.runtime.onMessage.addListener(function (m, sender, sendResponse) {
  if (!m) return;
  if (m.type === 'rook-perceive') {              // a derived reading from the offscreen capture doc
    var organ = String(m.organ || ''); if (!organ) { try { sendResponse({ ok: false }); } catch (e) {} return true; }
    var data = (m.data && typeof m.data === 'object') ? m.data : {};
    var t = Date.now(); perceiveLatest[organ] = { data: data, t: t };
    perceiveBroadcast(organ, data, t);
    try { sendResponse({ ok: true }); } catch (e) {}
    return true;
  }
  if (m.type === 'rook-perceive-capture') {      // an anchor: start/stop capture as its generators grant/drop consent
    try {
      var tabId = sender && sender.tab && sender.tab.id;
      if (tabId != null) {
        if (m.on) { perceiveWants[tabId] = Array.isArray(m.which) && m.which.length ? m.which.slice() : ['vision', 'device', 'geo']; }
        else { delete perceiveWants[tabId]; }
        perceiveSyncCapture();
      }
      sendResponse({ ok: true, which: perceiveActiveWhich });
    } catch (e) { try { sendResponse({ ok: false }); } catch (e2) {} }
    return true;
  }
  if (m.type === 'rook-perceive-latest') {       // a freshly-loaded anchor asks for the last per-organ readings
    try { sendResponse({ ok: true, organs: perceiveLatest }); } catch (e) {}
    return true;
  }
});
// a Perchance tab closing must release its perceive request so capture stops when the last consenter is gone.
try { chrome.tabs.onRemoved.addListener(function (tabId) { if (perceiveWants[tabId]) { delete perceiveWants[tabId]; perceiveSyncCapture(); } }); } catch (e) {}
