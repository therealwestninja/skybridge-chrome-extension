'use strict';
/* worker-model-adapter.js — the model "mouth" for the extension's LOCAL console page.
 *
 * An extension page can't hold the model itself, but the background worker can (it owns the
 * provider config + reaches http://127.0.0.1 via host_permissions). This adapter routes
 * chat(messages,{stream,onToken}) over the 'rook-model' Port to the worker — the same path
 * the Perchance bridge uses via the skybridge anchor, but DIRECT (no weld, no Perchance).
 * Adapter shape mirrors OllamaAdapter so RookConsole runs it unchanged.
 */
(function (root) {
  function WorkerModelAdapter() {}
  WorkerModelAdapter.prototype.label = 'local (worker)';
  WorkerModelAdapter.prototype.available = function () {
    return new Promise(function (res) {
      try { chrome.runtime.sendMessage({ type: 'rook-model-available' }, function (r) { res(!(chrome.runtime.lastError) && !!(r && r.ok)); }); }
      catch (e) { res(false); }
    });
  };
  WorkerModelAdapter.prototype.chat = function (messages, o) {
    o = o || {};
    return new Promise(function (resolve, reject) {
      var port;
      try { port = chrome.runtime.connect({ name: 'rook-model' }); }
      catch (e) { reject(new Error('model worker unavailable')); return; }
      var settled = false, full = '';
      function finish(fn, v) { if (settled) return; settled = true; try { port.disconnect(); } catch (e) {} fn(v); }
      port.onMessage.addListener(function (m) {
        if (!m) return;
        if (m.type === 'token') { full += (m.t || ''); if (typeof o.onToken === 'function') { try { o.onToken(m.t); } catch (e) {} } }
        else if (m.type === 'done') { finish(resolve, (m.text != null ? m.text : full)); }
        else if (m.type === 'error') { finish(reject, new Error(String(m.error || 'model error'))); }
      });
      try { port.onDisconnect.addListener(function () { finish(reject, new Error('model worker disconnected')); }); } catch (e) {}
      try { port.postMessage({ type: 'chat', messages: messages, stream: !!o.stream }); }
      catch (e) { finish(reject, new Error('model send failed')); }
    });
  };
  root.WorkerModelAdapter = WorkerModelAdapter;
})(window);
