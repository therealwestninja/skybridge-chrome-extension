'use strict';
/* rook-skybridge-anchor.js — content script on perchance.org (top frame). Makes the
 * Rook extension a weld.skybridge ANCHOR: it answers the handshake from a generator's
 * weld-skybridge-plugin and services the `ai` capability by routing the prompt to the
 * extension's model (local Ollama via the background worker, else reflex) and streaming
 * the reply back. Only the prompt + completion cross the bridge — never a key.
 *
 * Protocol mirrors weld-companion's anchor: channel 'weld.skybridge', reply `here`
 * to `hello`, then nonce-matched `request`s; the `ai` request streams {partial,chunk}
 * then a final {ok,value}. Per-generator consent (confirm once, remembered).
 */
(function () {
  if (window.top !== window) return;
  if (window.__rookSbAnchor) return; window.__rookSbAnchor = true;

  var SB = 'weld.skybridge', MIN = 1, MAX = 2, CAPS = ['ai', 'fetch', 'page', 'notify', 'storage', 'bus', 'brain', 'soma', 'socket', 'serial', 'perceive'];
  // 'brain' lets a linked generator "power up" over the bridge to the extension's FULL RookAI brain (the single
  // always-on instance in the offscreen doc) instead of its own lighter onboard faculties. HARD-restricted to a
  // safe read/converse subset (below) + the worker enforces the same allow-list; identity/backup/safety/portability
  // and destructive memory ops are NEVER reachable from a page. Consent-gated per generator like ai/fetch/page.
  var BRAIN_OPS_SAFE = {
    send: 1, quickAsk: 1, status: 1, feeling: 1, bond: 1, body: 1, hormones: 1, beliefs: 1,
    listGoals: 1, addGoal: 1, completeGoal: 1, dropGoal: 1, listHabits: 1,
    reachOut: 1, whatsNew: 1, imagine: 1, innerThought: 1, wander: 1, ruminate: 1, express: 1, welcome: 1,
    identityDigest: 1, listMemories: 1, addFact: 1, getSelf: 1, tempoState: 1,   // consolidate/reflect removed: CPU-heavy autonomous ops a third-party page has no reason to trigger
    drives: 1, setDrive: 1, frameJack: 1
  };
  // ---- protocol v2 (backward compatible: every new field is additive; a v1 client ignores them) ----
  // v2 adds: version NEGOTIATION (proto), machine-readable capability descriptors (caps), structured
  // error CODES, one-way EVENT push (subscribe), and ping/describe meta-requests. Reserved cap namespace
  // 'x-*' = experimental (may change shape between builds; always feature-detect via describe/has).
  var AGENT = 'rook-extension', VERSION = 'rook-1.4.7';   // anchor release string, tracks the extension manifest version (protocol version is separate: proto/MIN/MAX, already v2)
  var FEATURES = ['events', 'codes', 'describe', 'ping', 'modelInfo', 'socket', 'serial'];
  var INSTANCE = 'rk-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  // liveness stats so the extension's Debug page can verify the bridge link from the worker side
  var stats = { hellos: 0, requests: 0, lastHello: 0, lastRequest: 0, lastCap: null, caps: {} };
  var CAPDESC = {
    ai:      { v: 1, features: ['stream'] },
    fetch:   { v: 1, features: ['method', 'headers', 'body', 'credentials', 'allowLocal'] },
    page:    { v: 1, ops: ['read', 'watch', 'poll', 'unwatch', 'chat-read', 'chat-type', 'chat-send'] },
    notify:  { v: 1, scope: 'rook-ai' },
    storage: { v: 1, ops: ['get', 'getAll', 'set', 'setMany', 'remove'], scope: 'rook-ai' },
    bus:     { v: 1, ops: ['publish', 'subscribe', 'unsubscribe'] },
    brain:   { v: 1, ops: ['send', 'quickAsk', 'status', 'feeling', 'listGoals', 'addGoal', 'completeGoal', 'dropGoal', 'reachOut', 'whatsNew', 'imagine', 'drives', 'setDrive', 'frameJack'] },
    // device somatics pushed in from the extension's Web Bluetooth HR page (standard HR Service 0x180D/0x2A37) —
    // mirrors the Rook-Face on-phone `soma` cap so a PC Perchance generator reads live HR the same way.
    soma:    { v: 1, ops: ['latest'], channel: 'soma:sensors', keys: ['hr', 'hrv'] },
    // opt-in PERCEPTION pushed from the extension's capture doc (camera/geolocation/idle reduced to coarse scalars) —
    // mirrors the phone anchor's vision/device/geo organs so a PC generator perceives the room the same way. Consent-
    // gated per generator; the OS camera/location prompts are the per-sensor control. Raw video/coords NEVER cross.
    perceive: { v: 1, ops: ['latest'], channel: 'rook:perceive', organs: ['vision', 'device', 'geo'] },
    // a LIVE WebSocket to localhost/LAN held by the worker on the page's behalf (the sandboxed generator iframe
    // cannot open ws://localhost itself): Intiface/Buttplug device servers, your own Rook server, etc.
    socket:  { v: 1, ops: ['open', 'send', 'close'], schemes: ['ws', 'wss'], push: 'socket', maxPerPage: 4, maxFrame: 262144 },
    // a LIVE USB-Serial link to a locally-plugged device (an OSSM @115200) held by the offscreen doc on the page's
    // behalf (the sandboxed iframe cannot do Web Serial; the MV3 worker cannot either). Incoming bytes arrive on the
    // bus topic 'rook:serial' (the ble cap's request+bus shape). The one-time port grant is done from the popup.
    serial:  { v: 1, ops: ['list', 'open', 'write', 'close'], baud: 115200, push: 'rook:serial', binary: 'dataB64' }
  };
  // advertise only what THIS generator can actually use: storage + notify are reserved to
  // the Rook bridge (slug rook-ai), so a third-party generator must not see them in has()
  // (advertising-but-denying makes has('storage') lie). Honest caps per slug.
  function advCaps() { return (slug() === 'rook-ai') ? CAPS : CAPS.filter(function (c) { return c !== 'storage' && c !== 'notify'; }); }
  function advDesc() { var o = {}, a = advCaps(), i; for (i = 0; i < a.length; i++) { if (CAPDESC[a[i]]) o[a[i]] = CAPDESC[a[i]]; } return o; }
  function negotiate(theirMax) { var t = (typeof theirMax === 'number') ? theirMax : MAX; return Math.max(MIN, Math.min(MAX, t)); }
  function err(code, reason) { return { ok: false, code: code, reason: reason || code }; }   // structured failure: code is stable + branchable, reason is human text
  // one-way push: subscribers receive `event` messages (e.g. caps-changed). Carries only the anchor's own
  // state - never capability data the subscriber wasn't granted. Delivered direct, so a v1 page-plugin
  // (which only knows hello/request/reply) need not support events for them to reach a listener.
  var subs = [];
  function addSub(src, origin, topics) { var rec = null, i; for (i = 0; i < subs.length; i++) if (subs[i].src === src) rec = subs[i]; if (!rec) { rec = { src: src, origin: origin, topics: {} }; subs.push(rec); } (topics && topics.length ? topics : ['caps-changed']).forEach(function (t) { rec.topics[String(t)] = 1; }); return Object.keys(rec.topics); }
  function delSub(src) { subs = subs.filter(function (s) { return s.src !== src; }); }
  function emitEvent(topic, data) { for (var i = 0; i < subs.length; i++) { var s = subs[i]; if (!s.topics[topic]) continue; try { s.src.postMessage({ channel: SB, type: 'event', topic: topic, data: data, ts: Date.now() }, s.origin && s.origin !== 'null' ? s.origin : '*'); } catch (e) {} } }
  function originOk(o) {
    if (o === 'null') return true;                                  // sandboxed plugin iframe (opaque origin)
    if (typeof o !== 'string') return false;
    try { var h = new URL(o).hostname.toLowerCase(); return h === 'perchance.org' || /\.perchance\.org$/.test(h); }
    catch (e) { return false; }                                    // substring match (perchance.org.evil.com) no longer passes
  }
  function slug() { try { return (location.pathname.split('/').filter(Boolean)[0] || 'unknown').toLowerCase(); } catch (e) { return 'unknown'; } }
  function reply(src, origin, nonce, result) { try { src.postMessage({ channel: SB, type: 'reply', nonce: nonce, result: result }, origin && origin !== 'null' ? origin : '*'); } catch (e) {} }

  // ---- verification hard-block: a generator on the Weld block list (known-bad/malware) is refused
  //      at the bridge — no handshake, no capabilities — regardless of user consent. Reads the same
  //      rejected/localBlock lists the console maintains (chrome.storage 'rook:settings'). ----
  var vRejected = {}, vVerified = {}, vLocalBlock = {}, vLocalTrust = {}, vLocalOnly = false, disabled = false, hydrated = false;
  try { chrome.storage.local.get('rook:settings', function (o) { var v = o && o['rook:settings'] && o['rook:settings'].verify; if (v) { vRejected = v.rejected || {}; vVerified = v.verified || {}; vLocalBlock = v.localBlock || {}; vLocalTrust = v.localTrust || {}; vLocalOnly = !!v.localOnly; } hydrated = true; if (isRejected()) standDown(); }); } catch (e) { hydrated = true; }
  // REJECTED → fully stand down: remove the listener, stop announcing. WeldBridge does nothing here.
  function standDown() { disabled = true; try { window.removeEventListener('message', onMessage, false); } catch (e) {} try { clearInterval(iv); } catch (e) {} }
  // take note of an unverified generator that reached for Weld (so it can be reviewed later)
  function noteSeen() { try { if (genState()[0] !== 'unverified') return; chrome.storage.local.get('rook_sb_seen', function (o) { var seen = (o && o.rook_sb_seen) || {}, id = 'perchance:' + slug(); if (!seen[id]) { seen[id] = new Date().toISOString().slice(0, 10); chrome.storage.local.set({ rook_sb_seen: seen }); } }); } catch (e) {} }
  function genState() { var id = 'perchance:' + slug(); if (vLocalBlock[id]) return ['rejected']; if (vLocalTrust[id]) return ['verified', vLocalTrust[id]]; if (!vLocalOnly) { if (vRejected[id]) return ['rejected']; if (vVerified[id]) return ['verified', vVerified[id]]; } return ['unverified']; }
  function isRejected() { return genState()[0] === 'rejected'; }
  function vExpired(date) {
    var s = '' + (date || ''), t = null, m;
    if ((m = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(s))) t = new Date(+m[3], +m[1] - 1, +m[2]).getTime();       // MM-DD-YYYY
    else if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) t = new Date(+m[1], +m[2] - 1, +m[3]).getTime();   // ISO YYYY-MM-DD (noteSeen writes this)
    if (t == null || isNaN(t)) return false;
    return (Date.now() - t) > 90 * 86400000;
  }
  function verifyLine() {   // check #3 wording for the authorize prompt
    var st = genState();
    if (st[0] === 'verified') {
      var exp = vExpired(st[1]);
      return (exp ? '⚠ This generator was verified ' + st[1] + ' but that review has EXPIRED — code may have changed since.\n\n'
        : '✓ This generator was reviewed' + (typeof st[1] === 'string' ? (' (verified ' + st[1] + ')') : '') + ', but code can change after a review — please double-check.\n\n');
    }
    return '⚠ This generator has never been verified by anyone.\n\n';
  }

  // ---- per-generator, per-capability consent — TIME-BOUND, never permanent (generators change daily;
  //      a stale "yes" is how exploits slip in). A remembered choice lasts 30 days max, then re-prompts. ----
  var consent = {};   // { '<gen>': { ai:{v:bool,until:ts}, fetch:{...} } }
  try { chrome.storage.local.get('rook_sb_consent', function (o) { if (o && o.rook_sb_consent && typeof o.rook_sb_consent === 'object') consent = o.rook_sb_consent; }); } catch (e) {}
  function allowCap(gen, cap, elevated) {
    if (!consent[gen] || typeof consent[gen] !== 'object') consent[gen] = {};
    var slot = elevated ? cap + '!' : cap;   // elevated fetch tracks its OWN consent - a plain-fetch "yes" never grants it
    var rec = consent[gen][slot];
    if (rec && typeof rec === 'object' && rec.until > Date.now()) return Promise.resolve(rec.v);   // still within the remembered window
    noteSeen();
    var msg = verifyLine() + (
      (elevated && cap === 'fetch') ? 'Let "' + gen + '" make a PRIVILEGED fetch through Rook?\nThis can reach your LOCAL network (localhost/LAN) and/or send a saved API key or cookies. Only allow for endpoints you trust.'
      : cap === 'ai' ? 'Let "' + gen + '" use Rook\'s model (your local Ollama, else a built-in fallback)?\nThe prompt is sent to your model; no key ever leaves Rook.'
      : cap === 'page' ? 'Let "' + gen + '" read/watch the page you are viewing AND type or send messages AS YOU in a chat there (e.g. Twitch/Discord)?\nVisible text crosses and it can POST ON YOUR BEHALF; sensitive sites (bank/login/mail/…) are skipped.'
      : cap === 'bus' ? 'Let "' + gen + '" use Rook\'s message bus (cross-generator / cross-tab pub-sub)?\nOther Rook-enabled generators and tabs can exchange small messages; no page content, cookies, or keys are read.'
      : cap === 'brain' ? 'Let "' + gen + '" think with Rook\'s full brain?\nIt can hold a conversation, read/steer everyday state (mood, goals, memories it is told), and ask Rook to reflect. It can NOT rewrite Rook\'s identity, run backups, or delete memories.'
      : cap === 'soma' ? 'Let "' + gen + '" read your live body signals from Rook (heart rate / HRV from your connected BLE sensor)?\nOnly the numeric readings cross — no other data. Nothing is read unless a sensor is connected in Rook\'s Heart Rate page.'
      : cap === 'perceive' ? 'Let "' + gen + '" see through this computer\'s camera and sense your location/presence via Rook?\nOnly coarse derived signals cross — never the video, never your coordinates. You control it per-sensor with the browser\'s own camera/location prompts.'
      : cap === 'socket' ? 'Let "' + gen + '" open a LIVE socket connection through Rook to a local / LAN service?\n(e.g. ws://localhost - a device server like Intiface/Buttplug, or your own Rook server.) The page picks the address; frames pass through Rook unread. Only allow for software you run yourself.'
      : cap === 'serial' ? 'Let "' + gen + '" talk to a device plugged into this computer over USB-Serial through Rook?\n(e.g. an OSSM stroker at 115200 baud.) Rook opens a serial port you already granted (from the Rook popup) and passes bytes through unread. Only allow for hardware you control.'
      : 'Let "' + gen + '" use Rook to fetch web pages / APIs on its behalf?\nRook fetches anonymously (no cookies); loopback & private hosts are blocked.');
    var ok = false; try { ok = window.confirm(msg); } catch (e) { ok = true; }
    var until;
    if (ok) { var remember = false; try { remember = window.confirm('Remember this choice for "' + gen + '" for 30 days?\n(Cancel = allow just this time.)'); } catch (e) {} until = Date.now() + (remember ? 30 * 86400000 : 3600000); }
    else { until = Date.now() + 3600000; }   // soft 1h, then re-prompt — never a permanent "no" either
    consent[gen][slot] = { v: ok, until: until };
    try { chrome.storage.local.set({ rook_sb_consent: consent }); } catch (e) {}
    if (ok) { try { emitEvent('caps-changed', { gen: gen, cap: cap }); } catch (e) {} }   // a grant may unlock a cap for a subscribed page
    return Promise.resolve(ok);
  }

  // ---- MV3 cold-start: the service worker sleeps and DROPS the first 1-2 messages of a session
  //      ("Could not establish connection. Receiving end does not exist."). sendBg retries up to 4x /
  //      250ms on a lastError so a privileged request isn't silently lost. (R25 finding B4.) ----
  function sendBg(msg, tries) {
    tries = (tries == null) ? 4 : tries;
    return new Promise(function (resolve) {
      (function attempt(n) {
        try {
          chrome.runtime.sendMessage(msg, function (r) {
            if (chrome.runtime.lastError || !r) { if (n > 1) { setTimeout(function () { attempt(n - 1); }, 250); return; } resolve(null); return; }
            resolve(r);
          });
        } catch (e) { if (n > 1) { setTimeout(function () { attempt(n - 1); }, 250); } else resolve(null); }
      })(tries);
    });
  }
  // warm the worker so the FIRST real request doesn't pay the cold-start drop
  try { chrome.runtime.sendMessage({ type: 'rook-ping' }, function () { void chrome.runtime.lastError; }); } catch (e) {}

  // ---- the `fetch` service: borrow the worker's unsandboxed, cross-origin web access.
  //      Plain mode = anonymous, private hosts blocked (as before). ELEVATED opts (only after the
  //      stronger consent below) let the worker reach localhost/LAN and/or send a saved key / cookies. ----
  function fetchElevated(payload) { return !!(payload && (payload.allowLocal || payload.headers || payload.credentials === 'include')); }
  function serviceFetch(payload) {
    return new Promise(function (resolve) {
      payload = payload || {};
      var url = String(payload.url || '');
      if (!/^https?:\/\//i.test(url)) { resolve({ ok: false, reason: 'bad-url' }); return; }
      var opts = {};
      if (payload.allowLocal === true) opts.allowLocal = true;
      if (payload.headers && typeof payload.headers === 'object') opts.headers = payload.headers;
      if (payload.credentials === 'include') opts.credentials = 'include';
      if (payload.method) opts.method = payload.method;
      if (payload.body != null) opts.body = payload.body;
      if (payload.responseType) opts.responseType = payload.responseType;   // 'arraybuffer' -> base64 binary RESPONSE (not a new privilege; doesn't affect fetchElevated)
      if (payload.binary === true) opts.binary = true;
      sendBg({ type: 'rook-fetch', url: url, opts: (Object.keys(opts).length ? opts : undefined) }).then(function (r) { resolve(r || { ok: false, reason: 'anchor-unavailable' }); });   // { ok, status, body, json } | { ok, status, b64, contentType }
    });
  }

  // ---- the `page` service: read / watch the user's CURRENT page via the page-sensor (background-routed).
  //      op: 'read' (page text+links) · 'watch' (start streaming a live chat) · 'poll' (drain new chat lines) · 'unwatch'. ----
  function servicePage(payload) {
    return new Promise(function (resolve) {
      var op = String(payload && payload.op || 'read');
      var msg = (op === 'chat-read') ? { type: 'rook-active-chat-read', n: payload && payload.n }
        : (op === 'chat-type') ? { type: 'rook-active-chat-type', text: payload && payload.text }
        : (op === 'chat-send') ? { type: 'rook-active-chat-send', text: payload && payload.text }
        : { type: (op === 'watch' ? 'rook-active-watch' : op === 'poll' ? 'rook-active-pollchat' : op === 'unwatch' ? 'rook-active-unwatch' : 'rook-active-read') };
      sendBg(msg).then(function (r) { resolve(r || { ok: false, reason: 'anchor-unavailable' }); });
    });
  }

  // ---- the `notify` service: Rook's OWN bridge reflects its internal "needs your okay" state onto the
  //      toolbar badge (e.g. a Parliament bill awaiting assent). No page access, no data — just Rook's own
  //      UI — so it is NOT consent-gated, but it IS slug-locked to the rook-ai bridge (no other generator). ----
  function serviceNotify(payload) {
    return new Promise(function (resolve) {
      try { chrome.runtime.sendMessage({ type: 'rook-notify', badge: String(payload && payload.badge || ''), color: payload && payload.color, title: payload && payload.title }, function () { resolve({ ok: true }); }); }
      catch (e) { resolve({ ok: false, reason: 'anchor-unavailable' }); }
    });
  }

  // ---- the `storage` service: Rook's durable memory in the EXTENSION's own chrome.storage (not perchance.org's
  //      origin). RESERVED for the Rook bridge (slug rook-ai) - no third-party generator can read/write it. ----
  function serviceStorage(payload) {
    return new Promise(function (resolve) {
      payload = payload || {};
      try {
        chrome.runtime.sendMessage({ type: 'rook-storage', op: payload.op, key: payload.key, value: payload.value, data: payload.data }, function (r) {
          if (chrome.runtime.lastError || !r) { resolve({ ok: false, reason: 'anchor-unavailable' }); return; }
          resolve(r);
        });
      } catch (e) { resolve({ ok: false, reason: String(e && e.message || e).slice(0, 120) }); }
    });
  }

  // ---- the `bus` service: cross-generator / cross-tab pub-sub. UNLIKE storage/notify this is NOT
  //      slug-locked - ANY generator may use it (that is the whole point: a shared transport between
  //      different generators and tabs). Consent is still required per generator like ai/fetch/page.
  //      A published message fans out to every subscribed frame in THIS tab (skipping the publisher's
  //      own frame) AND, via a lazy BroadcastChannel('weld-bus'), to other perchance tabs; a message
  //      arriving over the BroadcastChannel is delivered LOCALLY only (never re-broadcast). ----
  var busSubs = {};   // channel -> [{ src, origin }]
  var busBC = null;   // lazy BroadcastChannel('weld-bus') for cross-tab fan-out
  var SB_AGENT_CH = 'weld:agent';                 // reserved inner-AI <-> outer-Helper channel
  var SE_PROPOSAL_PREFIX = '[SELF-EDIT PROPOSAL] ';
  function busChannel() {
    if (busBC || typeof BroadcastChannel === 'undefined') return busBC;
    try {
      busBC = new BroadcastChannel('weld-bus');
      busBC.onmessage = function (e) { try { var m = e && e.data; if (m && m.channel) busDeliverLocal(m.channel, m.message, null); } catch (x) {} };   // other tab -> local only
    } catch (e) { busBC = null; }
    return busBC;
  }
  function busPush(src, origin, channel, message) {
    try { src.postMessage({ channel: SB, type: 'bus', busChannel: channel, message: message }, origin && origin !== 'null' ? origin : '*'); return true; } catch (e) { return false; }
  }
  function busDeliverLocal(channel, message, skipSrc) {
    var arr = busSubs[channel]; if (!arr) return;
    var live = [];   // prune subscribers whose frame is gone (postMessage throws) so dead iframes don't accumulate
    for (var i = 0; i < arr.length; i++) {
      var s = arr[i];
      if (skipSrc && s.src === skipSrc) { live.push(s); continue; }   // never echo a publish back to its own frame
      if (busPush(s.src, s.origin, channel, message)) live.push(s);
    }
    if (live.length) busSubs[channel] = live; else delete busSubs[channel];
  }
  // used by the worker->anchor status relay (rook-selfedit-status): push a helper status onto the agent bus
  function busPublishBoth(channel, message) {
    try { busDeliverLocal(channel, message, null); } catch (e) {}
    var bc = busChannel(); if (bc) { try { bc.postMessage({ channel: channel, message: message }); } catch (e) {} }
  }
  // SELF-EDIT snoop: a proposal published on the reserved agent channel is ALSO forwarded to the worker to
  // enqueue for human review (in ADDITION to the normal bus fan-out). Never auto-applied anywhere.
  function busMaybeSelfEdit(channel, message) {
    try {
      if (channel !== SB_AGENT_CH || !message || slug() !== 'rook-ai') return;   // reserve the self-edit queue to the Rook bridge (rook-ai slug); a third-party bus-consented generator can't inject proposals
      var raw = String(message.text == null ? '' : message.text);
      if (raw.indexOf(SE_PROPOSAL_PREFIX) !== 0) return;
      sendBg({ type: 'rook-selfedit', op: 'enqueue', proposal: { text: raw, from: (message.from || 'inner'), generator: slug(), href: location.href } });
    } catch (e) {}
  }
  function serviceBus(payload, src, origin) {
    return new Promise(function (resolve) {
      try {
        payload = payload || {};
        var op = String(payload.op || ''), channel = String(payload.channel || '');
        if (!channel) { resolve(err('bad-channel', 'no bus channel')); return; }
        if (op === 'subscribe') {
          busChannel();   // warm the cross-tab channel on first subscribe
          var arr = busSubs[channel] || (busSubs[channel] = []);
          if (!arr.some(function (x) { return x.src === src; })) arr.push({ src: src, origin: origin });
          resolve({ ok: true, subscribed: channel }); return;
        }
        if (op === 'unsubscribe') {
          var a = busSubs[channel];
          if (a) { busSubs[channel] = a.filter(function (x) { return x.src !== src; }); if (!busSubs[channel].length) delete busSubs[channel]; }
          resolve({ ok: true, unsubscribed: channel }); return;
        }
        if (op === 'publish') {
          busDeliverLocal(channel, payload.message, src);                                       // same-tab subscribers, skipping the publisher
          var bc = busChannel(); if (bc) { try { bc.postMessage({ channel: channel, message: payload.message }); } catch (e) {} }   // other tabs
          busMaybeSelfEdit(channel, payload.message);                                           // reserved-channel self-edit proposals -> worker queue
          resolve({ ok: true, published: channel }); return;
        }
        resolve(err('bad-op', 'unsupported bus op: ' + (op || '(none)')));
      } catch (e) { resolve(err('error', String(e && e.message || e).slice(0, 120))); }
    });
  }

  // ---- the `ai` service: route to the extension's model, stream back ----
  // Relay the AI request to the BACKGROUND WORKER over the 'rook-model' port. The worker holds the
  // model (Ollama, else its fallback) - a content script can't (window.RookBrain/RookBackgroundModel
  // don't exist in this isolated world; constructing them here threw). Tokens stream back via emit, so
  // the page-side client refreshes its idle timeout per token and a slow local model isn't cut off.
  // Is our own `ai` provider a Perchance relay? If so, serving an 'ai' call that ORIGINATED in a Perchance
  // generator is a self-loop (relay back out to a Perchance host that may never answer) — and pointless, since
  // that page already has the same model in-iframe. Cache the answer briefly; the worker knows the provider.
  var _aiProv = { v: null, at: 0 };
  function aiProviderIsLoop(cb) {
    var now = Date.now();
    if (_aiProv.v !== null && (now - _aiProv.at) < 20000) { cb(_aiProv.v === 'perchance'); return; }
    try {
      chrome.runtime.sendMessage({ type: 'rook-model-info' }, function (r) {
        void chrome.runtime.lastError;
        var prov = (r && r.ok && r.provider) ? String(r.provider).toLowerCase() : '';
        _aiProv = { v: prov || 'unknown', at: now };
        cb(prov === 'perchance');
      });
    } catch (e) { cb(false); }   // unknown -> don't block; the page-side timeout still guards
  }

  function serviceAI(payload, emit) {
    return new Promise(function (resolve) {
      var messages = [{ role: 'system', content: payload.system || 'You are a helpful assistant inside a Perchance generator.' },
                      { role: 'user', content: String(payload.prompt || '') }];
      var port;
      try { port = chrome.runtime.connect({ name: 'rook-model' }); }
      catch (e) { resolve({ ok: false, reason: 'model worker unavailable' }); return; }
      var settled = false, full = '';
      function done(res) { if (settled) return; settled = true; try { port.disconnect(); } catch (e) {} resolve(res); }
      port.onMessage.addListener(function (m) {
        if (!m) return;
        if (m.type === 'token') { full += (m.t || ''); if (typeof emit === 'function') { try { emit(m.t); } catch (e) {} } }
        else if (m.type === 'done') { done({ ok: true, value: (m.text != null ? m.text : full) }); }
        else if (m.type === 'error') { done({ ok: false, reason: String(m.error || 'model error').slice(0, 160) }); }
      });
      try { port.onDisconnect.addListener(function () { done({ ok: false, reason: 'model worker disconnected' }); }); } catch (e) {}
      // payload.image (optional dataURL) rides along for the mouth's vision path; undefined = text-only (unchanged behavior)
      try { port.postMessage({ type: 'chat', messages: messages, stream: !!payload.stream && typeof emit === 'function', image: payload.image }); }
      catch (e) { done({ ok: false, reason: 'model send failed' }); }
    });
  }

  // ---- the `rate` service: relay a quality/honesty rating for the LAST generation to the worker,
  //      which forwards it to the mouth (aiTextPlugin.submitUserRating). No page data, additive. ----
  function serviceRate(payload) {
    return new Promise(function (resolve) {
      payload = payload || {};
      sendBg({ type: 'rook-rate', reqId: payload.reqId, score: payload.score, reason: payload.reason }).then(function (r) { resolve(r || { ok: false, reason: 'anchor-unavailable' }); });
    });
  }

  function onMessage(ev) {
    if (disabled) return;   // rejected generator — bridge stood down
    var d = ev && ev.data;
    if (!d || d.channel !== SB || !originOk(ev.origin)) return;
    var src = ev.source || window;
    // HARD BLOCK: a rejected generator gets no handshake and no service.
    if (isRejected()) {
      if (d.type === 'hello') src.postMessage({ channel: SB, type: 'here', agent: AGENT, instance: INSTANCE, version: VERSION, proto: negotiate(d.protoMax), protoMin: MIN, protoMax: MAX, capabilities: [], caps: {}, blocked: true }, ev.origin && ev.origin !== 'null' ? ev.origin : '*');
      else if (d.type === 'request') reply(src, ev.origin, d.nonce, err('blocked', 'this generator is on the Weld block list'));
      return;
    }
    if (d.type === 'hello') {
      stats.hellos++; stats.lastHello = Date.now();
      src.postMessage({ channel: SB, type: 'here', agent: AGENT, instance: INSTANCE, version: VERSION, proto: negotiate(d.protoMax), protoMin: MIN, protoMax: MAX, features: FEATURES, capabilities: advCaps(), caps: advDesc() }, ev.origin && ev.origin !== 'null' ? ev.origin : '*');
      return;
    }
    if (d.type === 'request') {
      var cap = String(d.cap || ''), nonce = d.nonce;
      stats.requests++; stats.lastRequest = Date.now(); stats.lastCap = cap; stats.caps[cap] = (stats.caps[cap] || 0) + 1;
      // proto-2 META-requests: no consent, no capability data - safe to answer always (even pre-hydration)
      if (cap === 'ping') { reply(src, ev.origin, nonce, { ok: true, agent: AGENT, instance: INSTANCE, proto: negotiate(), ts: Date.now() }); return; }
      if (cap === 'describe') { reply(src, ev.origin, nonce, { ok: true, agent: AGENT, instance: INSTANCE, version: VERSION, proto: negotiate(), protoMin: MIN, protoMax: MAX, features: FEATURES, capabilities: advCaps(), caps: advDesc(), blocked: isRejected() }); return; }
      if (cap === 'modelInfo') {   // which model the anchor WOULD run - metadata only (no prompt, no consent), so a page can show it before the first 'ai' call. Full detail (endpoint/config) only to the Rook bridge.
        try {
          chrome.runtime.sendMessage({ type: 'rook-model-info' }, function (r) {
            void chrome.runtime.lastError;
            if (!(r && r.ok)) { reply(src, ev.origin, nonce, err('unavailable', 'model info unavailable')); return; }
            var out = { ok: true, provider: r.provider, model: r.model };
            if (slug() === 'rook-ai') { out.endpoint = r.endpoint; out.configured = r.configured; }
            reply(src, ev.origin, nonce, out);
          });
        } catch (e) { reply(src, ev.origin, nonce, err('unavailable', 'worker unreachable')); }
        return;
      }
      if (cap === 'subscribe') { reply(src, ev.origin, nonce, { ok: true, topics: addSub(src, ev.origin, (d.payload && d.payload.topics) || []) }); return; }
      if (cap === 'unsubscribe') { delSub(src); reply(src, ev.origin, nonce, { ok: true }); return; }
      if (cap === 'rate') { serviceRate(d.payload || {}).then(function (r) { reply(src, ev.origin, nonce, r); }); return; }   // rating rides the already-consented ai flow - no extra prompt, harmless (a score back to the mouth)
      if (!hydrated) { reply(src, ev.origin, nonce, err('initializing', 'initializing - try again')); return; }   // never service a privileged request before the block lists load
      if (CAPS.indexOf(cap) === -1) { reply(src, ev.origin, nonce, err('unsupported', 'unsupported capability: ' + (cap || '(none)'))); return; }
      if (cap === 'ai') {
        allowCap(slug(), 'ai').then(function (ok) {
          if (!ok) { reply(src, ev.origin, nonce, err('denied', 'denied by the user')); return; }
          aiProviderIsLoop(function (loop) {
            // Perchance page + Perchance provider = self-loop that never answers. Decline fast so the page
            // uses its own in-iframe model. The rook-ai bridge itself is exempt (it has no in-page model).
            if (loop && slug() !== 'rook-ai') { reply(src, ev.origin, nonce, err('no-backend', 'ai provider is a perchance relay; use your own in-page model')); return; }
            var emit = function (chunk) { reply(src, ev.origin, nonce, { partial: true, chunk: String(chunk == null ? '' : chunk) }); };
            serviceAI(d.payload || {}, emit).then(function (r) { reply(src, ev.origin, nonce, r); });
          });
        });
      } else if (cap === 'fetch') {
        var fpl = d.payload || {};
        allowCap(slug(), 'fetch', fetchElevated(fpl)).then(function (ok) {
          if (!ok) { reply(src, ev.origin, nonce, err('denied', 'denied by the user')); return; }
          serviceFetch(fpl).then(function (r) { reply(src, ev.origin, nonce, r); });
        });
      } else if (cap === 'page') {
        allowCap(slug(), 'page').then(function (ok) {
          if (!ok) { reply(src, ev.origin, nonce, err('denied', 'denied by the user')); return; }
          servicePage(d.payload || {}).then(function (r) { reply(src, ev.origin, nonce, r); });
        });
      } else if (cap === 'notify') {
        if (slug() !== 'rook-ai') { reply(src, ev.origin, nonce, err('reserved', 'notify is reserved for the Rook bridge')); return; }   // Rook's own toolbar only
        serviceNotify(d.payload || {}).then(function (r) { reply(src, ev.origin, nonce, r); });
      } else if (cap === 'storage') {
        if (slug() !== 'rook-ai') { reply(src, ev.origin, nonce, err('reserved', 'storage is reserved for the Rook bridge')); return; }   // Rook's own memory - never exposed to a third-party generator
        serviceStorage(d.payload || {}).then(function (r) { reply(src, ev.origin, nonce, r); });
      } else if (cap === 'bus') {
        allowCap(slug(), 'bus').then(function (ok) {   // NOT slug-locked (cross-generator transport), but still consent-gated per generator
          if (!ok) { reply(src, ev.origin, nonce, err('denied', 'denied by the user')); return; }
          serviceBus(d.payload || {}, src, ev.origin).then(function (r) { reply(src, ev.origin, nonce, r); });
        });
      } else if (cap === 'soma') {
        allowCap(slug(), 'soma').then(function (ok) {   // personal body data — consent-gated per generator like bus/page
          if (!ok) { reply(src, ev.origin, nonce, err('denied', 'denied by the user')); return; }
          serviceSoma(d.payload || {}).then(function (r) { reply(src, ev.origin, nonce, r); });
        });
      } else if (cap === 'perceive') {
        allowCap(slug(), 'perceive').then(function (ok) {   // camera/location/presence — consent-gated per generator
          perceiveSetCapture(ok);   // grant → ask the worker to start capture (raises the OS prompts); deny → release
          if (!ok) { reply(src, ev.origin, nonce, err('denied', 'denied by the user')); return; }
          servicePerceive(d.payload || {}).then(function (r) { reply(src, ev.origin, nonce, r); });
        });
      } else if (cap === 'brain') {
        allowCap(slug(), 'brain').then(function (ok) {   // NOT slug-locked (any generator may power up), consent-gated per generator
          if (!ok) { reply(src, ev.origin, nonce, err('denied', 'denied by the user')); return; }
          serviceBrain(d.payload || {}).then(function (r) { reply(src, ev.origin, nonce, r); });
        });
      } else if (cap === 'socket') {
        allowCap(slug(), 'socket').then(function (ok) {   // NOT slug-locked, consent-gated per generator: a live socket to a LOCAL/LAN service the user runs
          if (!ok) { reply(src, ev.origin, nonce, err('denied', 'denied by the user')); return; }
          serviceSocket(d.payload || {}, src, ev.origin).then(function (r) { reply(src, ev.origin, nonce, r); });
        });
      } else if (cap === 'serial') {
        allowCap(slug(), 'serial').then(function (ok) {   // NOT slug-locked, consent-gated per generator: a live USB-Serial link to hardware the user plugged in
          if (!ok) { reply(src, ev.origin, nonce, err('denied', 'denied by the user')); return; }
          serviceSerial(d.payload || {}, src, ev.origin).then(function (r) { reply(src, ev.origin, nonce, r); });
        });
      }
    }
  }

  // ---- the `brain` service: "power up" to the extension's FULL RookAI brain (offscreen doc, via the worker).
  //      HARD-gated to a safe read/converse op subset here AND again in the worker (rook-brain-ext). ----
  var BRAIN_REPLY_OPS = { send: 1, quickAsk: 1 };   // ops that return a spoken REPLY (vs read-only state)
  function serviceBrain(payload) {
    return new Promise(function (resolve) {
      payload = payload || {};
      var op = String(payload.op || '');
      if (!BRAIN_OPS_SAFE[op]) { resolve(err('unsupported', 'brain op not permitted over the bridge: ' + (op || '(none)'))); return; }
      var args = Array.isArray(payload.args) ? payload.args : [];
      sendBg({ type: 'rook-brain-ext', op: op, args: args }).then(function (r) {
        if (!r) { resolve({ ok: false, reason: 'anchor-unavailable' }); return; }
        // HONESTY: when the brain has no working model backend it degrades to a reflex/HOLD STALL ("One sec." /
        // "Hmm, let me think."). A page can't tell that from a real reply, so it speaks the stall. Tell the page
        // the power-up couldn't answer (no-backend) so it falls back to its OWN model instead of our stall.
        try {
          if (BRAIN_REPLY_OPS[op] && r.ok) {
            var v = r.value, src = String((v && v.source) || '');
            if (!v || (typeof v.text === 'string' && !v.text.trim()) || /^(reflex|hold|clarify|quiet|primal|shed|stall)/i.test(src)) {
              resolve(err('no-backend', 'the full brain has no working model backend; answer with your own model')); return;
            }
          }
        } catch (e) {}
        resolve(r);
      });
    });
  }

  // announce presence proactively so a late-loading plugin iframe re-sends 'hello'. This broadcast goes to
  // '*' (child frame origins are unknown), so it carries NO capabilities — the real CAPS list is only ever
  // returned through the origin-checked hello→here handshake, never advertised to arbitrary frames.
  // ---- the `soma` service: device somatics (HR/HRV) pushed from the extension's Web Bluetooth page via the
  //      worker. Mirrors the Rook-Face on-phone soma cap: a generator PULLS the latest snapshot (`op:'latest'`)
  //      and/or subscribes to bus channel 'soma:sensors' for throttled live pushes. Only numeric readings. ----
  var SOMA_CHANNEL = 'soma:sensors';
  var somaLatest = { t: 0, ch: {} };
  var SOMA_KEYS = ['hr', 'hrv'];
  var somaLastPush = 0, SOMA_PUSH_MS = 800;
  function serviceSoma(payload) {
    return new Promise(function (resolve) {
      var op = String(payload && payload.op || 'latest');
      if (op === 'latest') { resolve({ ok: true, value: { t: somaLatest.t, ch: somaLatest.ch } }); return; }
      resolve(err('bad-op', 'unsupported soma op: ' + (op || '(none)')));
    });
  }
  // ingest a reading from the worker; coerce finite numbers, merge, publish (throttled) on the bus channel.
  function somaIngest(obj) {
    try {
      if (obj && typeof obj === 'object') {
        var merged = {}, kk, i, k, n;
        for (kk in somaLatest.ch) { if (Object.prototype.hasOwnProperty.call(somaLatest.ch, kk)) merged[kk] = somaLatest.ch[kk]; }
        for (i = 0; i < SOMA_KEYS.length; i++) { k = SOMA_KEYS[i]; if (obj[k] == null) continue; n = Number(obj[k]); if (isFinite(n)) merged[k] = n; }
        somaLatest = { t: Date.now(), ch: merged };
      }
      var now = Date.now();
      if (now - somaLastPush >= SOMA_PUSH_MS) { somaLastPush = now; try { busPublishBoth(SOMA_CHANNEL, { t: somaLatest.t, ch: somaLatest.ch }); } catch (e) {} }
    } catch (e) { /* never throw */ }
  }
  // worker pushes { type:'rook-soma', ch:{hr,hrv}, t } whenever the Web Bluetooth HR page reports a reading.
  try {
    chrome.runtime.onMessage.addListener(function (m, sender, sendResp) {
      if (!m || m.type !== 'rook-soma') return;
      try { somaIngest(m.ch || {}); if (sendResp) sendResp({ ok: true }); } catch (e) { try { if (sendResp) sendResp({ ok: false }); } catch (e2) {} }
      return true;
    });
  } catch (e) {}
  // on load, ask the worker for the last known reading so a page that connects mid-session isn't empty.
  try { chrome.runtime.sendMessage({ type: 'rook-soma-latest' }, function (r) { void chrome.runtime.lastError; if (r && r.ok && r.ch) somaIngest(r.ch); }); } catch (e) {}

  // ---- the `perceive` service: opt-in vision/device/geo pushed from the extension's capture doc via the worker.
  //      Mirrors the phone anchor's perception: a generator PULLS the latest per-organ snapshot (`op:'latest'`) and/or
  //      subscribes to bus channel 'rook:perceive' for live pushes. Publishing is HARD-gated on this generator holding
  //      current `perceive` consent (defense in depth: capture itself never starts without a grant). Raw video / raw
  //      coordinates never reach here — only the derived scalars. The publish shape matches the phone anchor's packets
  //      so the companion app's __rookSensory demuxes desktop and phone identically. ----
  var PERCEIVE_CHANNEL = 'rook:perceive';
  var perceiveLatest = {};   // organ -> { data, t }
  function perceiveConsented() {   // is THIS generator's perceive consent currently granted (and unexpired)?
    try { var r = consent[slug()] && consent[slug()]['perceive']; return !!(r && r.v && r.until > Date.now()); } catch (e) { return false; }
  }
  function servicePerceive(payload) {
    return new Promise(function (resolve) {
      var op = String(payload && payload.op || 'latest');
      if (op === 'latest') { resolve({ ok: true, value: { organs: perceiveLatest } }); return; }
      resolve(err('bad-op', 'unsupported perceive op: ' + (op || '(none)')));
    });
  }
  // tell the worker to start (grant) or release (deny/expire) capture for this tab. No consent → no capture → no OS
  // camera/location prompt at all. `which` requests all three organs; the OS per-sensor prompts gate each one.
  function perceiveSetCapture(on) {
    try { chrome.runtime.sendMessage({ type: 'rook-perceive-capture', on: !!on, which: ['vision', 'device', 'geo'] }, function () { void chrome.runtime.lastError; }); } catch (e) {}
  }
  // worker pushes { type:'rook-perceive-organ', organ, data, t } whenever the capture doc reports a derived reading.
  try {
    chrome.runtime.onMessage.addListener(function (m, sender, sendResp) {
      if (!m || m.type !== 'rook-perceive-organ') return;
      try {
        var organ = String(m.organ || '');
        if (organ && m.data && typeof m.data === 'object') {
          perceiveLatest[organ] = { data: m.data, t: m.t || Date.now() };
          if (perceiveConsented()) {   // gate the bus publish on consent; drop otherwise (do NOT publish)
            busPublishBoth(PERCEIVE_CHANNEL, { organ: organ, kind: organ, data: m.data, src: INSTANCE, sampleAt: Date.now() });
          }
        }
        if (sendResp) sendResp({ ok: true });
      } catch (e) { try { if (sendResp) sendResp({ ok: false }); } catch (e2) {} }
      return true;
    });
  } catch (e) {}
  // on load, pull the last per-organ readings so a page that connects mid-session isn't empty (still consent-gated to publish).
  try { chrome.runtime.sendMessage({ type: 'rook-perceive-latest' }, function (r) { void chrome.runtime.lastError; if (r && r.ok && r.organs) { try { perceiveLatest = r.organs; } catch (e) {} } }); } catch (e) {}

  // ---- the `socket` service: a LIVE WebSocket to localhost/LAN, held by the WORKER on the page's behalf (the
  //      sandboxed generator iframe cannot open ws://localhost; the worker can - it already holds one to the Moot
  //      server). One long-lived Port ('rook-socket') per anchor relays open/send/close up and open/message/
  //      close/error pushes down, each push going ONLY to the frame that owns that socket id. A page can only touch
  //      its OWN sockets (ownership checked on every op). Frames pass through unread. The anchor pings the Port
  //      every ~20s while sockets live so the MV3 worker stays awake; a dead frame (postMessage throws) has its
  //      socket closed; a dropped Port closes every socket and tells each owner. Consent-gated per generator. ----
  var SOCK_PUSH = 'socket', SOCK_MAX_PER_PAGE = 4, SOCK_MAX_FRAME = 262144;
  var sockPort = null, sockById = {}, sockOpenWait = {}, sockSeq = 0, sockPing = null;
  function sockPush(id, rec, body) {
    body.channel = SB; body.type = SOCK_PUSH; body.id = id;
    try { rec.src.postMessage(body, rec.origin && rec.origin !== 'null' ? rec.origin : '*'); return true; } catch (e) { return false; }
  }
  function sockMaybeIdle() { if (sockPing && !Object.keys(sockById).length) { clearInterval(sockPing); sockPing = null; } }
  function sockTell(id, op, extra) { var p = sockPort; if (!p) return false; var m = { op: op, id: id }; if (extra) { for (var k in extra) { if (extra.hasOwnProperty(k)) m[k] = extra[k]; } } try { p.postMessage(m); return true; } catch (e) { return false; } }
  function sockSettleOpen(id, result) { var w = sockOpenWait[id]; if (!w) return; delete sockOpenWait[id]; clearTimeout(w.t); try { w.resolve(result); } catch (e) {} }
  function sockEnsurePort() {
    if (sockPort) return sockPort;
    try { sockPort = chrome.runtime.connect({ name: 'rook-socket' }); } catch (e) { sockPort = null; return null; }
    sockPort.onMessage.addListener(function (m) {
      if (!m || !m.ev || m.ev === 'pong') return;
      var id = String(m.id || ''), rec = sockById[id];
      if (!rec) return;
      if (m.ev === 'open') sockSettleOpen(id, { ok: true, id: id, protocol: m.protocol || '' });
      else if (m.ev === 'error' && sockOpenWait[id]) sockSettleOpen(id, err('socket-failed', m.reason || 'socket failed'));
      var delivered = sockPush(id, rec, { event: m.ev, data: m.data, binary: !!m.binary, code: m.code, reason: m.reason });
      if (m.ev === 'close') { delete sockById[id]; sockMaybeIdle(); }
      else if (!delivered) { delete sockById[id]; sockTell(id, 'close', { code: 1000, reason: 'frame gone' }); sockMaybeIdle(); }   // owner frame is gone: close its socket
    });
    sockPort.onDisconnect.addListener(function () {
      sockPort = null;
      var id;
      for (id in sockOpenWait) { if (sockOpenWait.hasOwnProperty(id)) sockSettleOpen(id, err('socket-failed', 'bridge port closed')); }
      for (id in sockById) { if (sockById.hasOwnProperty(id)) sockPush(id, sockById[id], { event: 'close', code: 1006, reason: 'bridge port closed' }); }
      sockById = {}; sockMaybeIdle();
    });
    return sockPort;
  }
  function serviceSocket(payload, src, origin) {
    return new Promise(function (resolve) {
      try {
        payload = payload || {};
        var op = String(payload.op || '');
        if (op === 'open') {
          var url = String(payload.url || '');
          if (!/^wss?:\/\//i.test(url)) { resolve(err('bad-url', 'socket needs a ws:// or wss:// url')); return; }
          var mine = 0, k; for (k in sockById) { if (sockById.hasOwnProperty(k) && sockById[k].src === src) mine++; }
          if (mine >= SOCK_MAX_PER_PAGE) { resolve(err('too-many-sockets', 'at most ' + SOCK_MAX_PER_PAGE + ' sockets per page')); return; }
          var p = sockEnsurePort(); if (!p) { resolve(err('anchor-unavailable', 'worker unreachable')); return; }
          var id = 'sk' + (++sockSeq) + '-' + Date.now().toString(36);
          sockById[id] = { src: src, origin: origin };
          sockOpenWait[id] = { resolve: resolve, t: setTimeout(function () { if (sockOpenWait[id]) { delete sockOpenWait[id]; delete sockById[id]; sockTell(id, 'close', { code: 1000, reason: 'open timeout' }); sockMaybeIdle(); resolve(err('timeout', 'socket open timed out')); } }, 10000) };
          if (!sockPing) sockPing = setInterval(function () { var pp = sockPort; if (pp) { try { pp.postMessage({ op: 'ping' }); } catch (e) {} } }, 20000);   // keep the worker awake while sockets live
          if (!sockTell(id, 'open', { url: url, protocols: payload.protocols })) { delete sockById[id]; sockSettleOpen(id, err('anchor-unavailable', 'worker send failed')); sockMaybeIdle(); }
          return;
        }
        var sid = String(payload.id || ''), rec = sockById[sid];
        if (!rec || rec.src !== src) { resolve(err('no-such-socket', 'unknown socket id')); return; }   // a page may only touch ITS OWN sockets
        if (op === 'send') {
          if (typeof payload.data !== 'string') { resolve(err('bad-data', 'socket send needs string data (base64 with binary:true for bytes)')); return; }
          if (payload.data.length > SOCK_MAX_FRAME) { resolve(err('frame-too-large', 'frame over ' + SOCK_MAX_FRAME + ' bytes')); return; }
          resolve(sockTell(sid, 'send', { data: payload.data, binary: !!payload.binary }) ? { ok: true } : err('anchor-unavailable', 'worker unreachable'));
          return;
        }
        if (op === 'close') { sockTell(sid, 'close', { code: payload.code, reason: payload.reason }); resolve({ ok: true }); return; }
        resolve(err('bad-op', 'unsupported socket op: ' + (op || '(none)')));
      } catch (e) { resolve(err('error', String(e && e.message || e).slice(0, 120))); }
    });
  }

  // ---- the `serial` service: a LIVE USB-Serial link to a locally-plugged device (an OSSM @115200), routed through the
  //      worker to the OFFSCREEN doc which actually holds the port (navigator.serial is unavailable in the sandboxed
  //      iframe AND in the MV3 worker). One long-lived Port ('rook-serial') per anchor relays list/open/write/close DOWN
  //      and shuttles list/open replies + streamed bytes back UP. UNLIKE socket, incoming bytes are delivered on the bus
  //      topic 'rook:serial' (the ble cap's request+bus shape) as { id, b64 }; a port-close/error arrives there too as
  //      { id, event }. A page may only write/close ports IT opened. The one-time port GRANT is done from the popup
  //      (requestPort). The anchor pings the Port every ~20s while a port is open so the MV3 worker stays awake. ----
  var SERIAL_PUSH = 'rook:serial';
  var serialPort = null, serialReqs = {}, serialSeq = 0, serialPing = null, serialOwn = {};   // id -> { src, origin }
  function serialAnyOpen() { for (var k in serialOwn) { if (serialOwn.hasOwnProperty(k)) return true; } return false; }
  function serialMaybeIdle() { if (serialPing && !serialAnyOpen()) { clearInterval(serialPing); serialPing = null; } }
  function serialStartPing() { if (serialPing) return; serialPing = setInterval(function () { var pp = serialPort; if (pp) { try { pp.postMessage({ op: 'ping' }); } catch (e) {} } }, 20000); }
  function serialEnsurePort() {
    if (serialPort) return serialPort;
    try { serialPort = chrome.runtime.connect({ name: 'rook-serial' }); } catch (e) { serialPort = null; return null; }
    serialPort.onMessage.addListener(function (m) {
      if (!m || !m.ev || m.ev === 'pong') return;
      if (m.ev === 'list') { var w = serialReqs[m.reqId]; if (w) { delete serialReqs[m.reqId]; clearTimeout(w.t); w.resolve({ ok: true, ports: m.ports || [] }); } return; }
      if (m.ev === 'open') {
        var w2 = serialReqs[m.reqId]; if (!w2) return; delete serialReqs[m.reqId]; clearTimeout(w2.t);
        if (m.ok && m.id != null) { serialOwn[m.id] = w2.owner; serialStartPing(); w2.resolve({ ok: true, id: m.id }); }
        else w2.resolve(err('serial-open-failed', m.reason || 'open failed'));
        return;
      }
      if (m.ev === 'rx') { busPublishBoth(SERIAL_PUSH, { id: m.id, b64: m.b64 }); return; }                          // incoming bytes -> bus 'rook:serial'
      if (m.ev === 'close') { delete serialOwn[m.id]; busPublishBoth(SERIAL_PUSH, { id: m.id, event: 'close', reason: m.reason }); serialMaybeIdle(); return; }
      if (m.ev === 'error') { busPublishBoth(SERIAL_PUSH, { id: m.id, event: 'error', reason: m.reason }); return; }
    });
    serialPort.onDisconnect.addListener(function () {
      serialPort = null;
      var rid, id;
      for (rid in serialReqs) { if (serialReqs.hasOwnProperty(rid)) { try { serialReqs[rid].resolve(err('serial-failed', 'bridge port closed')); } catch (e) {} } }
      serialReqs = {};
      for (id in serialOwn) { if (serialOwn.hasOwnProperty(id)) busPublishBoth(SERIAL_PUSH, { id: id, event: 'close', reason: 'bridge port closed' }); }
      serialOwn = {}; serialMaybeIdle();
    });
    return serialPort;
  }
  function serialTell(op, extra) { var p = serialEnsurePort(); if (!p) return false; var m = { op: op }; if (extra) { for (var k in extra) { if (extra.hasOwnProperty(k)) m[k] = extra[k]; } } try { p.postMessage(m); return true; } catch (e) { return false; } }
  function serviceSerial(payload, src, origin) {
    return new Promise(function (resolve) {
      try {
        payload = payload || {};
        var op = String(payload.op || '');
        var p = serialEnsurePort(); if (!p) { resolve(err('anchor-unavailable', 'worker unreachable')); return; }
        if (op === 'list' || op === 'open') {
          var reqId = 'se' + (++serialSeq) + '-' + Date.now().toString(36);
          serialReqs[reqId] = { resolve: resolve, owner: { src: src, origin: origin }, t: setTimeout(function () { if (serialReqs[reqId]) { delete serialReqs[reqId]; resolve(err('timeout', 'serial ' + op + ' timed out')); } }, op === 'open' ? 12000 : 6000) };
          if (!serialTell(op, op === 'open' ? { reqId: reqId, path: payload.path, baud: payload.baud || 115200 } : { reqId: reqId })) { clearTimeout(serialReqs[reqId].t); delete serialReqs[reqId]; resolve(err('anchor-unavailable', 'worker send failed')); }
          return;
        }
        var sid = String(payload.id || ''), owner = serialOwn[sid];
        if (!owner || owner.src !== src) { resolve(err('no-such-port', 'unknown serial id')); return; }   // a page may only touch ITS OWN ports
        if (op === 'write') {
          if (typeof payload.dataB64 !== 'string') { resolve(err('bad-data', 'serial write needs base64 dataB64')); return; }
          resolve(serialTell('write', { id: sid, dataB64: payload.dataB64 }) ? { ok: true } : err('anchor-unavailable', 'worker unreachable'));
          return;
        }
        if (op === 'close') { serialTell('close', { id: sid }); delete serialOwn[sid]; serialMaybeIdle(); resolve({ ok: true }); return; }
        resolve(err('bad-op', 'unsupported serial op: ' + (op || '(none)')));
      } catch (e) { resolve(err('error', String(e && e.message || e).slice(0, 120))); }
    });
  }

  function announce() { if (isRejected()) return; try { for (var i = 0; i < window.frames.length; i++) { try { window.frames[i].postMessage({ channel: SB, type: 'here', agent: AGENT, version: VERSION, protoMin: MIN, protoMax: MAX, capabilities: [], probe: true }, '*'); } catch (e) {} } } catch (e) {} }
  window.addEventListener('message', onMessage, false);
  announce();
  var ticks = 0, iv = setInterval(function () { announce(); if (++ticks >= 20) clearInterval(iv); }, 600);

  // ---- the extension Debug page asks (via the worker) whether this anchor is live and how the bridge
  //      is using it. Pure read-out of the anchor's own state; no capability data, no page content. ----
  try {
    chrome.runtime.onMessage.addListener(function (m, sender, sendResp) {
      if (!m || m.type !== 'rook-anchor-status') return;
      try {
        sendResp({ ok: true, present: true, slug: slug(), agent: AGENT, version: VERSION,
          hydrated: hydrated, disabled: disabled, state: genState()[0], caps: advCaps(),
          subs: subs.length, stats: stats, href: location.href });
      } catch (e) { try { sendResp({ ok: false, reason: String(e && e.message || e) }); } catch (e2) {} }
      return true;
    });
  } catch (e) {}

  // ---- self-edit STATUS relay: the console reviews a proposal and the worker records the new status,
  //      then fans it out to the perchance anchors so the INNER AI hears the outcome over the SAME agent
  //      bus it proposed on. The worker can't postMessage the bus itself, so it messages us and we publish. ----
  try {
    chrome.runtime.onMessage.addListener(function (m, sender, sendResp) {
      if (!m || m.type !== 'rook-selfedit-status') return;
      try { busPublishBoth(SB_AGENT_CH, { to: 'inner', from: 'helper', kind: 'status', id: m.id, status: m.status, text: String(m.text == null ? '' : m.text) }); sendResp({ ok: true }); }
      catch (e) { try { sendResp({ ok: false, reason: String(e && e.message || e) }); } catch (e2) {} }
      return true;
    });
  } catch (e) {}
})();
