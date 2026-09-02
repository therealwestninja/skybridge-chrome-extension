'use strict';
/* remote-host.js — content script on perchance.org (isolated world). When this tab is
 * the background Perchance host, it relays chat/image requests from the worker down into
 * the rook-ai generator frame (PerchanceRelay) and streams the reply back. The old
 * "borrow a foreign chatbot" adapters (duck.ai capture / pagechat UI-drive) were RETIRED —
 * Rook's mouth is now local Ollama + this Perchance relay.
 */
(function () {
  if (window.top !== window) return;
  if (window.__rookRemoteHost) return;
  window.__rookRemoteHost = true;

  // Perchance's free model lives as aiTextPlugin INSIDE the generator's sandboxed iframe — not in this
  // content-script world. So relay the prompt down into the rook-ai generator frame (which boots a
  // host-responder via build-bridge) and await its reply. This is what lets Perchance be a background mouth.
  function PerchanceRelay() { this.label = 'perchance'; }
  PerchanceRelay.prototype.available = function () { return Promise.resolve(!!document.querySelector('iframe')); };
  PerchanceRelay.prototype.chat = function (messages, o) {
    o = o || {};
    return new Promise(function (resolve, reject) {
      var frame = document.querySelector('iframe'); if (!frame || !frame.contentWindow) { reject(new Error('no generator frame')); return; }
      var id = 'pr' + Date.now() + Math.floor(Math.random() * 1e6), done = false;
      function onMsg(ev) { var d = ev && ev.data; if (!d || d.__rookPerchance !== id) return; done = true; window.removeEventListener('message', onMsg); d.ok ? resolve(String(d.text || '')) : reject(new Error(d.error || 'perchance relay failed')); }
      window.addEventListener('message', onMsg);
      try { frame.contentWindow.postMessage({ __rookPerchanceReq: id, messages: messages, image: (o && o.image) || undefined }, '*'); } catch (e) { reject(e); return; }   // o.image (dataURL) rides into the generator frame for the mouth's vision path
      setTimeout(function () { if (!done) { window.removeEventListener('message', onMsg); reject(new Error('perchance relay timeout')); } }, 90000);   // free model + backgrounded tab can be slow
    });
  };
  PerchanceRelay.prototype.image = function (prompt) {   // borrow textToImagePlugin inside the generator frame
    return new Promise(function (resolve, reject) {
      var frame = document.querySelector('iframe'); if (!frame || !frame.contentWindow) { reject(new Error('no generator frame')); return; }
      var id = 'pi' + Date.now() + Math.floor(Math.random() * 1e6), done = false;
      function onMsg(ev) { var d = ev && ev.data; if (!d || d.__rookPerchanceImg !== id) return; done = true; window.removeEventListener('message', onMsg); d.ok ? resolve(String(d.dataUrl || '')) : reject(new Error(d.error || 'perchance image relay failed')); }
      window.addEventListener('message', onMsg);
      try { frame.contentWindow.postMessage({ __rookPerchanceImgReq: id, prompt: String(prompt || '') }, '*'); } catch (e) { reject(e); return; }
      setTimeout(function () { if (!done) { window.removeEventListener('message', onMsg); reject(new Error('perchance image relay timeout')); } }, 120000);
    });
  };
  function localAdapter() {
    var hn = location.hostname;
    if (/(^|\.)perchance\.org$/.test(hn)) return new PerchanceRelay();
    return null;
  }

  var port;
  try { port = chrome.runtime.connect({ name: 'rook-host' }); } catch (e) { return; }
  port.postMessage({ type: 'register', host: location.hostname });
  port.onMessage.addListener(function (m) {
    if (!m) return;
    if (m.type === 'image') {   // borrowed image-gen (Perchance textToImagePlugin)
      var rid = m.reqId, ia = localAdapter();
      if (!ia || typeof ia.image !== 'function') { try { port.postMessage({ type: 'error', reqId: rid, error: 'no image adapter for ' + location.hostname }); } catch (e) {} return; }
      ia.image(m.prompt).then(function (dataUrl) { try { port.postMessage({ type: 'image-done', reqId: rid, dataUrl: dataUrl }); } catch (e) {} })
        .catch(function (e) { try { port.postMessage({ type: 'error', reqId: rid, error: String(e && e.message || e) }); } catch (e2) {} });
      return;
    }
    if (m.type === 'rate') {   // forward a rating for the last gen into the generator frame (best-effort, no reply)
      var rframe = document.querySelector('iframe');
      if (rframe && rframe.contentWindow) { try { rframe.contentWindow.postMessage({ __rookPerchanceRate: true, reqId: m.reqId, score: m.score, reason: m.reason }, '*'); } catch (e) {} }
      return;
    }
    if (m.type === 'keepalive') return;   // relay warm-up nudge: receipt alone keeps the tab responsive
    if (m.type !== 'chat') return;
    var reqId = m.reqId, ad = localAdapter();
    if (!ad) { try { port.postMessage({ type: 'error', reqId: reqId, error: 'no local adapter for ' + location.hostname }); } catch (e) {} return; }
    ad.chat(m.messages, { stream: true, image: m.image, onToken: function (t) { try { port.postMessage({ type: 'token', reqId: reqId, t: t }); } catch (e) {} } })
      .then(function (text) { try { port.postMessage({ type: 'done', reqId: reqId, text: text }); } catch (e) {} })
      .catch(function (e) { try { port.postMessage({ type: 'error', reqId: reqId, error: String(e && e.message || e) }); } catch (e) {} });
  });
})();
