'use strict';
/* weld-route.js — the FORWARDING decision for the weld.skybridge anchor, factored out so it is
 * unit-testable under plain node (the anchor itself is a content script full of chrome.* calls).
 *
 * WHY: an https Perchance page cannot fetch http://127.0.0.1 (mixed content / Private Network
 * Access). The extension's BACKGROUND worker can (host_permissions holds http://127.0.0.1/*).
 * So when a page asks the anchor for a capability the extension does NOT serve locally, and
 * NEKO's anchor at http://127.0.0.1:48922/weld advertises it, we forward the request there.
 *
 * Rules that must not drift:
 *   - LOCAL ALWAYS WINS. A remote cap never shadows one the extension serves itself.
 *   - Meta/protocol caps are never forwardable (ping/describe/subscribe/... stay ours).
 *   - A forwarded cap is advertised ONLY while NEKO is actually reachable (probe cache).
 *   - Forwarding goes through the SAME per-generator consent gate as every other capability.
 *   - Nothing here throws; failures come back as { ok:false, code, reason }.
 *
 * Loaded as a content script (sets window.__rookWeldRoute) and as a node module (module.exports).
 */
(function (root) {
  var SB = 'weld.skybridge';
  var NEKO_AGENT = 'rook-neko';
  var PROBE_TTL_MS = 10000;          // how long a reachability probe is trusted
  var PROBE_FAIL_TTL_MS = 10000;     // a failed probe is cached just as long (don't hammer a down bridge)

  // protocol / meta capabilities the anchor answers itself — a remote peer may never claim these
  var RESERVED = { ping: 1, describe: 1, subscribe: 1, unsubscribe: 1, rate: 1, modelInfo: 1, hello: 1, here: 1 };

  function list(a) {
    var out = [], i, s;
    if (!a || typeof a.length !== 'number') return out;
    for (i = 0; i < a.length; i++) { s = String(a[i] == null ? '' : a[i]); if (s && out.indexOf(s) === -1) out.push(s); }
    return out;
  }

  // capabilities a `here` reply from NEKO legitimately offers us to forward
  function remoteCapsFrom(here) {
    if (!here || typeof here !== 'object') return [];
    if (here.type !== 'here') return [];
    return list(here.capabilities).filter(function (c) { return !RESERVED[c]; });
  }

  // what the handshake advertises: local caps in their own order, then reachable remote caps.
  function mergeCaps(local, remote) {
    var L = list(local), R = list(remote), out = L.slice(), i;
    for (i = 0; i < R.length; i++) { if (RESERVED[R[i]]) continue; if (out.indexOf(R[i]) === -1) out.push(R[i]); }
    return out;
  }

  // 'local' | 'forward' | 'unsupported'
  function routeCap(cap, local, remote) {
    var c = String(cap == null ? '' : cap);
    if (!c) return 'unsupported';
    if (list(local).indexOf(c) !== -1) return 'local';     // LOCAL WINS — checked first, always
    if (RESERVED[c]) return 'unsupported';
    if (list(remote).indexOf(c) !== -1) return 'forward';
    return 'unsupported';
  }

  function err(code, reason) { return { ok: false, code: code, reason: reason || code }; }

  // turn the background worker's { ok, reply } / { ok:false, code, reason } into a page-facing result
  function normalizeReply(r) {
    if (!r || typeof r !== 'object') return err('unavailable', 'NEKO bridge unreachable');
    if (r.ok === false) return err(r.code || 'unavailable', r.reason || 'NEKO bridge unreachable');
    var m = r.reply;
    if (!m || typeof m !== 'object') return err('unavailable', 'NEKO bridge returned nothing');
    if (m.type === 'reply') {
      var res = m.result;
      if (res && typeof res === 'object') return res;
      return { ok: true, value: res };
    }
    if (m.type === 'error' || m.ok === false) return err(m.code || 'error', m.reason || 'NEKO bridge error');
    return err('unavailable', 'unexpected reply from NEKO bridge');
  }

  function helloMsg() { return { channel: SB, type: 'hello', protoMax: 2, from: 'rook-extension' }; }
  function requestMsg(cap, nonce, payload) { return { channel: SB, type: 'request', cap: String(cap), nonce: nonce, payload: payload }; }

  // ---- reachability probe with a short cache so describe()/capabilities() stay HONEST ----
  // deps.sendBg(msg) -> Promise of the worker response; deps.now() optional.
  function makeProbe(deps) {
    deps = deps || {};
    var now = deps.now || function () { return Date.now(); };
    var ttl = deps.ttl || PROBE_TTL_MS, failTtl = deps.failTtl || PROBE_FAIL_TTL_MS;
    var state = { at: 0, caps: [], up: false, agent: '', pending: false };

    function refresh() {
      if (state.pending) return Promise.resolve(state.caps);
      state.pending = true;
      var p;
      try { p = deps.sendBg({ type: 'rook-weld-forward', message: helloMsg() }); } catch (e) { p = Promise.resolve(null); }
      return Promise.resolve(p).then(function (r) {
        var caps = [], up = false, agent = '';
        if (r && r.ok !== false && r.reply && r.reply.type === 'here') { caps = remoteCapsFrom(r.reply); up = caps.length > 0; agent = String(r.reply.agent || NEKO_AGENT); }
        state = { at: now(), caps: caps, up: up, agent: agent, pending: false };
        return state.caps;
      }, function () { state = { at: now(), caps: [], up: false, agent: '', pending: false }; return []; });
    }
    // synchronous read used by advCaps(): serves the cache, kicks a background refresh when stale.
    function caps() {
      var age = now() - state.at, fresh = state.at && age < (state.up ? ttl : failTtl);
      if (!fresh && !state.pending) { try { refresh(); } catch (e) {} }
      return fresh ? state.caps.slice() : (state.at ? [] : []);
    }
    return { caps: caps, refresh: refresh, up: function () { return !!state.up && (now() - state.at) < ttl; }, agent: function () { return state.agent || NEKO_AGENT; }, _state: function () { return state; } };
  }

  // ---- one forwarded capability request, consent-gated exactly like a local one ----
  // deps: { sendBg, allowCap(gen, cap) -> Promise<bool>, gen, nonce? }
  function forwardCap(deps, cap, payload) {
    deps = deps || {};
    var gen = deps.gen || 'unknown';
    var allow = deps.allowCap || function () { return Promise.resolve(false); };
    return Promise.resolve().then(function () { return allow(gen, cap); }).then(function (ok) {
      if (!ok) return err('denied', 'denied by the user');
      var nonce = deps.nonce || ('fw-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8));
      var p;
      try { p = deps.sendBg({ type: 'rook-weld-forward', message: requestMsg(cap, nonce, payload) }); }
      catch (e) { return err('unavailable', 'NEKO bridge unreachable'); }
      return Promise.resolve(p).then(normalizeReply, function () { return err('unavailable', 'NEKO bridge unreachable'); });
    }, function () { return err('denied', 'consent check failed'); });
  }

  function capDesc(cap, agent) { return { v: 1, forwarded: true, via: agent || NEKO_AGENT }; }

  var API = {
    SB: SB, NEKO_AGENT: NEKO_AGENT, RESERVED: RESERVED, PROBE_TTL_MS: PROBE_TTL_MS,
    list: list, remoteCapsFrom: remoteCapsFrom, mergeCaps: mergeCaps, routeCap: routeCap,
    normalizeReply: normalizeReply, helloMsg: helloMsg, requestMsg: requestMsg,
    makeProbe: makeProbe, forwardCap: forwardCap, capDesc: capDesc, err: err
  };
  try { root.__rookWeldRoute = API; } catch (e) {}
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof globalThis !== 'undefined' ? globalThis : this);
