'use strict';
/* rook-weld-client.js - the PAGE-SIDE Weld client we own.
 *
 * Installs window.weld.skybridge as a full protocol-v2 client: it runs the
 * hello->here handshake with an anchor (extension content script / App Engine
 * injection / Tampermonkey), negotiates the version, and exposes ONE object for
 * everything - request/reply (with nonce matching + timeout), ai() streaming,
 * the v2 manifest (agent/instance/proto/features/capabilities/caps), describe()/
 * ping()/subscribe(), an on()/off() event bus fed by the anchor's push, the
 * cross-generator `bus` (publish/subscribe with the anchor's push), onConnect(),
 * and `socket`: a WebSocket-shaped object tunnelled through the anchor to a
 * localhost/LAN service the sandboxed page cannot reach itself.
 *
 * It is a drop-in SUPERSET of the external weld-skybridge-plugin: same
 * .connected/.protocol/.has/.request/.ai/.bus/.onConnect surface, so existing
 * callers keep working, plus the proto-2 surface the external plugin never had.
 * Self-installing + idempotent. With no anchor present, .connected stays false and
 * every request resolves { ok:false, code:'no-anchor' } - never throws.
 *
 * Embedded in the bridge (build-bridge.sh LIBS) and the standalone demo. Lives
 * in the generator frame; the anchor lives in the top frame, reached by
 * postMessage to window.top. Protocol spec: docs/weld-protocol.md.
 */
(function () {
  var W;
  try { W = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window; } catch (e) { W = window; }
  if (W.weld && W.weld.skybridge && W.weld.skybridge.__rookClient) return;   // idempotent: don't re-install over ourselves

  var CH = 'weld.skybridge', MIN = 1, MAX = 2;
  var pending = {}, listeners = {}, seq = 0, helloTries = 0, helloIv = null;

  var client = {
    __rookClient: '1.1',
    connected: false,
    protocol: 0,            // negotiated proto once linked
    agent: null,            // which anchor build answered (rook-extension / rook-app-engine / ...)
    instance: null,         // this anchor run's id
    version: null,
    features: [],           // optional mechanisms the anchor supports (events/codes/describe/ping/socket)
    capabilities: [],       // flat cap list (proto 1 compatible)
    caps: {}                // machine-readable descriptor map (proto 2)
  };

  // ---- transport: the anchor lives in window.top (it stands down in sub-frames). Posting to a
  //      specific window with targetOrigin '*' delivers ONLY to that window, not a broadcast. ----
  function anchorWin() { try { return window.top || window; } catch (e) { return window; } }
  function post(msg) { try { anchorWin().postMessage(msg, '*'); } catch (e) {} }
  function fromAnchor(ev) { try { return ev.source === window.top || ev.source === window.parent || ev.source === window; } catch (e) { return false; } }

  // ---- handshake ----
  function hello() { post({ channel: CH, type: 'hello', protoMax: MAX }); }
  function adopt(d) {
    var wasConnected = client.connected;
    client.connected = !d.blocked;
    // defensive: keep prior values when a refresh omits a field (a partial describe must not wipe the manifest)
    client.protocol = d.proto || d.protoMax || client.protocol || 1;
    client.agent = d.agent || client.agent;
    client.instance = d.instance || client.instance;
    client.version = d.version || client.version;
    if (d.features) client.features = d.features;
    if (d.capabilities) client.capabilities = d.capabilities;
    if (d.caps) client.caps = d.caps;
    if (helloIv) { clearInterval(helloIv); helloIv = null; }
    if (client.connected && client.features.indexOf('events') >= 0) { try { request('subscribe', { topics: ['caps-changed'] }); } catch (e) {} }
    if (!wasConnected && client.connected) {
      busResubscribe();   // an anchor (re)link: re-assert every bus channel the page listens on
      fire('connect', { agent: client.agent, proto: client.protocol });
    }
    try { console.log('[RookWeldClient] linked to ' + (client.agent || 'anchor') + ' proto ' + client.protocol + '; caps: ' + client.capabilities.join(', ')); } catch (e) {}
  }

  // ---- request / reply (nonce-matched, timeout-guarded, streaming-aware) ----
  function request(cap, payload, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var nonce = 'rwc-' + (++seq) + '-' + Date.now().toString(36);
      var ms = opts.timeout || 30000;
      var rec = { resolve: resolve, onChunk: opts.onChunk, timer: null, ms: ms };
      rec.arm = function () { rec.timer = setTimeout(function () { if (pending[nonce]) { delete pending[nonce]; resolve({ ok: false, code: 'timeout', reason: 'no reply from anchor' }); } }, ms); };   // (re)arm the idle timeout; streaming refreshes it so a slow local model isn't cut mid-reply
      pending[nonce] = rec;
      rec.arm();
      post({ channel: CH, type: 'request', cap: String(cap), nonce: nonce, payload: payload || {} });
    });
  }

  // ---- events ----
  function fire(topic, data) {
    var a = listeners[topic] || [], b = listeners['*'] || [], i;
    for (i = 0; i < a.length; i++) { try { a[i](data, topic); } catch (e) {} }
    for (i = 0; i < b.length; i++) { try { b[i](data, topic); } catch (e) {} }
  }
  function on(topic, fn) { (listeners[topic] = listeners[topic] || []).push(fn); return function () { off(topic, fn); }; }
  function off(topic, fn) { var arr = listeners[topic]; if (!arr) return; var i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); }

  // ---- bus: cross-generator / cross-tab pub-sub (anchor cap 'bus'). The anchor pushes
  //      { type:'bus', busChannel, message } for every channel this frame subscribed to. ----
  var busSubs = {};   // channel -> [fn]
  function busDeliver(channel, message) {
    var arr = busSubs[channel]; if (!arr) return;
    for (var i = 0; i < arr.length; i++) { try { arr[i](message, channel); } catch (e) {} }
  }
  function busResubscribe() {
    for (var ch in busSubs) { if (busSubs.hasOwnProperty(ch) && busSubs[ch].length) { try { request('bus', { op: 'subscribe', channel: ch }); } catch (e) {} } }
  }
  var bus = {
    publish: function (channel, message) { return client.request('bus', { op: 'publish', channel: String(channel), message: message }); },
    subscribe: function (channel, fn) {
      channel = String(channel);
      if (typeof fn === 'function') (busSubs[channel] = busSubs[channel] || []).push(fn);
      return client.request('bus', { op: 'subscribe', channel: channel });
    },
    unsubscribe: function (channel, fn) {
      channel = String(channel);
      var arr = busSubs[channel];
      if (arr && typeof fn === 'function') { var i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); }
      if (!fn || !(arr && arr.length)) { delete busSubs[channel]; return client.request('bus', { op: 'unsubscribe', channel: channel }); }
      return Promise.resolve({ ok: true });
    }
  };

  // ---- socket: a WebSocket-SHAPED object tunnelled through the anchor (cap 'socket') to a localhost/LAN
  //      service the sandboxed page cannot reach itself (e.g. ws://localhost:12345 Intiface, your own Rook
  //      server). Same surface as a browser WebSocket (readyState, send, close, addEventListener, onopen/
  //      onmessage/onclose/onerror), so any library that accepts a WebSocket CONSTRUCTOR can be pointed at
  //      it unchanged - e.g. buttplug-js: connector._websocketConstructor = weld.skybridge.WebSocket. ----
  var sockets = {};   // id -> SbSocket
  function b64enc(buf) { var b = new Uint8Array(buf), s = '', i; for (i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); }
  function b64dec(s) { var bin = atob(String(s || '')), arr = new Uint8Array(bin.length), i; for (i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i); return arr.buffer; }
  function SbSocket(url, protocols) {
    var self = this;
    this.url = String(url || ''); this.protocol = ''; this.readyState = 0; this.binaryType = 'arraybuffer'; this.bufferedAmount = 0;
    this.onopen = null; this.onmessage = null; this.onclose = null; this.onerror = null;
    this._id = null; this._ls = {}; this._queue = []; this._closeWanted = null;
    client.request('socket', { op: 'open', url: this.url, protocols: protocols }, { timeout: 12000 }).then(function (r) {
      if (r && r.ok && r.id) {
        self._id = r.id; sockets[r.id] = self; self.protocol = r.protocol || '';
        if (self._closeWanted) { self._finishClose(self._closeWanted.code, self._closeWanted.reason); return; }   // close() raced the open
        self.readyState = 1;
        self._dispatch('open', {});
        var q = self._queue; self._queue = [];
        for (var i = 0; i < q.length; i++) { try { self.send(q[i]); } catch (e) {} }
      } else {
        var why = (r && (r.reason || r.code)) || 'open failed';
        self.readyState = 3;
        self._dispatch('error', { reason: why });
        self._dispatch('close', { code: 1006, reason: why, wasClean: false });
      }
    });
  }
  SbSocket.CONNECTING = 0; SbSocket.OPEN = 1; SbSocket.CLOSING = 2; SbSocket.CLOSED = 3;
  SbSocket.prototype.CONNECTING = 0; SbSocket.prototype.OPEN = 1; SbSocket.prototype.CLOSING = 2; SbSocket.prototype.CLOSED = 3;
  SbSocket.prototype.addEventListener = function (type, fn) { if (typeof fn !== 'function') return; (this._ls[type] = this._ls[type] || []).push(fn); };
  SbSocket.prototype.removeEventListener = function (type, fn) { var a = this._ls[type]; if (!a) return; var i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); };
  SbSocket.prototype._dispatch = function (type, props) {
    var ev = { type: type, target: this, currentTarget: this, timeStamp: Date.now() };
    for (var k in props) { if (props.hasOwnProperty(k)) ev[k] = props[k]; }
    var a = (this._ls[type] || []).slice(), i;
    for (i = 0; i < a.length; i++) { try { a[i].call(this, ev); } catch (e) {} }
    var h = this['on' + type]; if (typeof h === 'function') { try { h.call(this, ev); } catch (e) {} }
  };
  SbSocket.prototype.send = function (data) {
    if (this.readyState === 0) { this._queue.push(data); return; }   // lenient: queue until open (a real WebSocket would throw)
    if (this.readyState !== 1 || !this._id) throw new Error('socket is not open');
    var payload;
    if (typeof data === 'string') payload = { op: 'send', id: this._id, data: data };
    else if (data && (data instanceof ArrayBuffer)) payload = { op: 'send', id: this._id, data: b64enc(data), binary: true };
    else if (data && data.buffer && (data.buffer instanceof ArrayBuffer)) payload = { op: 'send', id: this._id, data: b64enc(data.buffer.slice(data.byteOffset || 0, (data.byteOffset || 0) + data.byteLength)), binary: true };
    else payload = { op: 'send', id: this._id, data: String(data) };
    var self = this;
    client.request('socket', payload, { timeout: 8000 }).then(function (r) { if (!(r && r.ok)) self._dispatch('error', { reason: (r && (r.reason || r.code)) || 'send failed' }); });
  };
  SbSocket.prototype.close = function (code, reason) {
    if (this.readyState === 2 || this.readyState === 3) return;
    if (!this._id) { this._closeWanted = { code: code, reason: reason }; this.readyState = 2; return; }   // still opening: finish after the open resolves
    this._finishClose(code, reason);
  };
  SbSocket.prototype._finishClose = function (code, reason) {
    this.readyState = 2;
    client.request('socket', { op: 'close', id: this._id, code: code, reason: reason }, { timeout: 8000 });
    // the anchor's 'close' push finalizes (readyState 3 + close event); if it never comes, finalize locally.
    var self = this; setTimeout(function () { if (self.readyState === 2) self._push({ event: 'close', code: code || 1000, reason: reason || '' }); }, 4000);
  };
  SbSocket.prototype._push = function (d) {
    if (d.event === 'message') {
      var data = d.binary ? b64dec(d.data) : d.data;
      if (d.binary && this.binaryType === 'blob' && typeof Blob !== 'undefined') { try { data = new Blob([data]); } catch (e) {} }
      this._dispatch('message', { data: data, origin: this.url });
    } else if (d.event === 'close') {
      if (this.readyState === 3) return;
      this.readyState = 3; if (this._id) delete sockets[this._id];
      this._dispatch('close', { code: d.code || 1005, reason: d.reason || '', wasClean: (d.code === 1000) });
    } else if (d.event === 'error') {
      this._dispatch('error', { reason: d.reason || 'socket error' });
    } else if (d.event === 'open') {
      // informational: open is settled via the request reply; nothing extra to do here
    }
  };

  // ---- inbound messages from the anchor ----
  function onMessage(ev) {
    var d = ev && ev.data;
    if (!d || d.channel !== CH || !fromAnchor(ev)) return;
    if (d.type === 'here') {
      // a probe / capability-less announce is PRESENCE only (an anchor won't broadcast its
      // caps to '*'); re-handshake to fetch the real manifest, never latch onto empty caps.
      if (d.probe || !(d.capabilities && d.capabilities.length)) { if (!client.connected) hello(); return; }
      adopt(d);
      return;
    }
    if (d.type === 'reply' && d.nonce && pending[d.nonce]) {
      var rec = pending[d.nonce], res = d.result || {};
      if (res.partial) { if (typeof rec.onChunk === 'function') { try { rec.onChunk(res.chunk); } catch (e) {} } if (rec.timer) { clearTimeout(rec.timer); if (rec.arm) rec.arm(); } return; }   // streaming chunk: keep the request open + refresh the idle timeout
      clearTimeout(rec.timer); delete pending[d.nonce]; rec.resolve(res);
      return;
    }
    if (d.type === 'event') {
      fire(String(d.topic || 'event'), d.data);
      if (d.topic === 'caps-changed') { describe().then(function (m) { if (m) adopt(m); }); }   // refresh the manifest on a cap change
      return;
    }
    if (d.type === 'bus' && d.busChannel) { busDeliver(String(d.busChannel), d.message); return; }
    if (d.type === 'socket' && d.id && sockets[d.id]) { try { sockets[d.id]._push(d); } catch (e) {} return; }
  }

  // ---- public API (drop-in for the external plugin + the proto-2 surface) ----
  client.has = function (cap) { return client.capabilities.indexOf(cap) >= 0; };
  client.supports = function (cap, feat) {
    var c = client.caps[cap]; if (!c) return false;
    if (!feat) return true;
    return (c.features && c.features.indexOf(feat) >= 0) || (c.ops && c.ops.indexOf(feat) >= 0);
  };
  client.request = function (cap, payload, opts) {
    if (!client.connected && cap !== 'ping' && cap !== 'describe') return Promise.resolve({ ok: false, code: 'no-anchor', reason: 'no Weld anchor present' });
    return request(cap, payload, opts);
  };
  client.ai = function (prompt, opts) {
    opts = opts || {};
    // AI generation is slow (a local model can take a minute+, plus first-load); give it a generous
    // idle timeout that streaming refreshes per token. Fast cloud models still return in seconds.
    // opts.image (a dataURL) is optional vision input carried through to the mouth; omitted = text-only.
    return client.request('ai', { prompt: String(prompt == null ? '' : prompt), system: opts.system, stream: !!opts.onChunk, image: opts.image }, { onChunk: opts.onChunk, timeout: opts.timeout || 120000 });
  };
  // Rating channel: feed a quality/honesty score back to the mouth for the LAST generation. Best-effort,
  // additive - anchors that don't support it reply { ok:false, code:'unsupported' } and nothing breaks.
  client.rate = function (score, reason) { return client.request('rate', { score: score, reason: reason }, { timeout: 8000 }); };
  function describe() { return request('describe', {}, { timeout: 8000 }).then(function (r) { return (r && r.ok) ? r : null; }, function () { return null; }); }
  client.describe = describe;
  client.ping = function () { return request('ping', {}, { timeout: 6000 }); };
  // which model the anchor would run (name/provider) - a consent-free meta-request, so the UI can show it
  // BEFORE the first 'ai' call. Resolves { ok, provider, model, ... } or null (no anchor / older anchor).
  client.modelInfo = function () { return request('modelInfo', {}, { timeout: 6000 }).then(function (r) { return (r && r.ok) ? r : null; }, function () { return null; }); };
  client.subscribe = function (topics) { return request('subscribe', { topics: topics || ['caps-changed'] }); };
  client.unsubscribe = function () { return request('unsubscribe', {}); };
  client.on = on;
  client.off = off;
  // onConnect(fn): fire once per link; if already linked, fire on the next tick (external-plugin parity).
  client.onConnect = function (fn) {
    if (typeof fn !== 'function') return function () {};
    if (client.connected) { setTimeout(function () { try { fn({ agent: client.agent, proto: client.protocol }); } catch (e) {} }, 0); }
    return on('connect', fn);
  };
  client.bus = bus;
  client.WebSocket = SbSocket;                                                    // constructor: new weld.skybridge.WebSocket(url)
  client.socket = function (url, protocols) { return new SbSocket(url, protocols); };   // factory form of the same
  // re-handshake on demand (e.g. after the anchor reloads)
  client.relink = function () { client.connected = false; hello(); };

  // ---- install + start the handshake ----
  W.weld = W.weld || {};
  W.weld.skybridge = client;

  window.addEventListener('message', onMessage, false);
  hello();
  helloIv = setInterval(function () { if (client.connected || ++helloTries >= 20) { clearInterval(helloIv); helloIv = null; return; } hello(); }, 500);
  try { console.log('[RookWeldClient] installed (proto ' + MAX + '); awaiting anchor...'); } catch (e) {}
})();
