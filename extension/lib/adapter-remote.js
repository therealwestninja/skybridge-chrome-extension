'use strict';
/* adapter-remote.js - drawer-side model adapter that runs a backend in the
 * BACKGROUND. Rook can be open on any site; this routes the turn to the background
 * worker, which opens (or reuses) a hidden minimized popup of the chosen AI site,
 * captures its token / drives its UI there, and streams the reply back. Same adapter
 * shape, so RookAgent uses it unchanged.
 *
 *   new RemoteModelAdapter('chatgpt.com')   // gemini.google.com - duck.ai - ...
 */
(function (root) {
  function RemoteModelAdapter(backend) { this.backend = backend; this.label = 'bg:' + String(backend).split('.')[0]; }
  RemoteModelAdapter.prototype.available = function () {
    return Promise.resolve(typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.connect));
  };
  RemoteModelAdapter.prototype.chat = function (messages, o) {
    o = o || {};
    var backend = this.backend;
    return new Promise(function (resolve, reject) {
      var text = '', done = false, port;
      try { port = chrome.runtime.connect({ name: 'rook-remote' }); }
      catch (e) { return reject(new Error('background unreachable')); }
      port.onMessage.addListener(function (m) {
        if (!m) return;   // a null/undefined port message must not throw inside the listener
        if (m.type === 'token') { text += m.t; if (o.stream && o.onToken) o.onToken(m.t); }
        else if (m.type === 'status') { if (o.onStatus) o.onStatus(m.note); }
        else if (m.type === 'done') { done = true; resolve(m.text != null ? m.text : text); try { port.disconnect(); } catch (e) {} }
        else if (m.type === 'error') { done = true; reject(new Error(m.error)); try { port.disconnect(); } catch (e) {} }
      });
      port.onDisconnect.addListener(function () { if (!done) reject(new Error('remote port closed')); });
      port.postMessage({ type: 'chat', backend: backend, messages: messages, stream: !!o.stream });
    });
  };
  root.RookRemote = { RemoteModelAdapter: RemoteModelAdapter };
})(typeof self !== 'undefined' ? self : this);
