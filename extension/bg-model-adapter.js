'use strict';
/* bg-model-adapter.js — content-script side. The brain (council) runs in the
 * content script, but a content script can't reach http://127.0.0.1 (page CSP).
 * So the MODEL call is proxied to the background service worker, which has
 * host_permissions for localhost. Same adapter shape as OllamaAdapter, so the
 * Console/RookAgent use it unchanged; falls back to reflex when the daemon is down.
 */
(function (root) {
  function BackgroundModelAdapter() {}
  BackgroundModelAdapter.prototype.label = 'ollama';

  BackgroundModelAdapter.prototype.available = function () {
    return new Promise(function (res) {
      try {
        chrome.runtime.sendMessage({ type: 'rook-model-available' }, function (r) {
          if (chrome.runtime.lastError) return res(false);
          res(!!(r && r.ok));
        });
      } catch (e) { res(false); }
    });
  };

  BackgroundModelAdapter.prototype.chat = function (messages, o) {
    o = o || {};
    return new Promise(function (resolve, reject) {
      var text = '', done = false;
      var port;
      try { port = chrome.runtime.connect({ name: 'rook-model' }); }
      catch (e) { return reject(new Error('background unreachable')); }
      port.onMessage.addListener(function (m) {
        if (m.type === 'token') { text += m.t; if (o.stream && o.onToken) o.onToken(m.t); }
        else if (m.type === 'done') { done = true; resolve(m.text != null ? m.text : text); try { port.disconnect(); } catch (e) {} }
        else if (m.type === 'error') { done = true; reject(new Error(m.error)); try { port.disconnect(); } catch (e) {} }
      });
      port.onDisconnect.addListener(function () { if (!done) reject(new Error('background port closed')); });
      port.postMessage({ type: 'chat', messages: messages, stream: !!o.stream });
    });
  };

  root.RookBackgroundModel = { BackgroundModelAdapter: BackgroundModelAdapter };
})(typeof self !== 'undefined' ? self : this);
