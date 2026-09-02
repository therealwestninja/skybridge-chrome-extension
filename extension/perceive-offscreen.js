// perceive-offscreen.js — the DURABLE end of the optic nerve, in the extension's OFFSCREEN document. The MV3 service
// worker is killed after ~30s idle, so it cannot hold a live socket; the offscreen document persists, so the socket for
// the nerve lives HERE, and every frame it receives is forwarded to the SW (which runs the LGN via perceive-bridge.js)
// as chrome.runtime.sendMessage({type:'rook/perceive-frame', frame, nerve}).
//
// The concrete transport is INJECTED via connect() so this file guesses nothing about the relay: pass it whatever the
// extension already uses to reach the Skybridge/Perchance channel (remote-host.js) or a plain WebSocket to a relay. Load
// from offscreen.html. Not unit-gated (needs the live extension runtime + a relay); the frame parse/ingest it feeds IS
// gated in rook-core (verify-optic-nerve.cjs, verify-perceive-ingest.cjs).
(function () {
  "use strict";

  // startPerceiveNerve({ connect, nerve, reconnectMs })
  //   connect({ onFrame, onOpen, onClose }) -> { close() }   — you own the socket; call onFrame(frameObjOrString) per frame.
  //   nerve : a label for provenance (e.g. "skybridge"). Optional.
  // Returns { stop() }. Auto-reconnects with backoff if the transport reports a close.
  function startPerceiveNerve(opts) {
    opts = opts || {};
    if (typeof opts.connect !== "function") return { stop: function () {} };
    var nerveLabel = opts.nerve || "skybridge";
    var reconnectMs = opts.reconnectMs || 2000;
    var handle = null, stopped = false, backoff = reconnectMs;

    function forward(frame) {
      try {
        // hand the frame to the SW bridge. If the SW is asleep, sendMessage wakes it.
        if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
          chrome.runtime.sendMessage({ type: "rook/perceive-frame", frame: frame, nerve: nerveLabel });
        }
      } catch (e) { /* a dead SW / no-receiver is not fatal; the next frame retries */ }
    }

    function open() {
      if (stopped) return;
      try {
        handle = opts.connect({
          onFrame: forward,
          onOpen: function () { backoff = reconnectMs; },
          onClose: function () { handle = null; if (!stopped) { setTimeout(open, backoff); backoff = Math.min(backoff * 2, 30000); } },
        });
      } catch (e) { if (!stopped) { setTimeout(open, backoff); backoff = Math.min(backoff * 2, 30000); } }
    }
    open();

    return { stop: function () { stopped = true; try { if (handle && handle.close) handle.close(); } catch (e) {} } };
  }

  // a ready-made WebSocket transport, if the nerve is a plain WS relay. Pass to startPerceiveNerve({ connect: wsTransport(url) }).
  function wsTransport(url) {
    return function (cbs) {
      var ws;
      try {
        ws = new WebSocket(url);
        ws.onopen = function () { if (cbs.onOpen) cbs.onOpen(); };
        ws.onmessage = function (ev) { if (cbs.onFrame) cbs.onFrame(ev.data); };
        ws.onclose = function () { if (cbs.onClose) cbs.onClose(); };
        ws.onerror = function () { try { ws.close(); } catch (e) {} };
      } catch (e) { setTimeout(function () { if (cbs.onClose) cbs.onClose(); }, 0); }
      return { close: function () { try { ws && ws.close(); } catch (e) {} } };
    };
  }

  var G = (typeof self !== "undefined" ? self : (typeof window !== "undefined" ? window : globalThis));
  G.startPerceiveNerve = startPerceiveNerve;
  G.perceiveWsTransport = wsTransport;
})();
