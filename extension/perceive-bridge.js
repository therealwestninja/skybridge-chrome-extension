// perceive-bridge.js — EXTENSION-SIDE cortex end of the optic nerve (runs in the MV3 service worker). It holds the LGN
// (perceiveIngest) and turns an incoming wire FRAME into percepts the extension brain can act on. This is the cortex in
// "the nerve terminates at whatever cortex is listening" — today the Rook AI extension. The SAME perceiveIngest pure
// module runs here and in rook-core; only this thin bridge (and the offscreen socket that feeds it) is extension-specific.
//
// Load in the SW before this: perceiveIngest.js, opticNerve.js (both UMD → self.makePerceiveIngest / self.makeOpticNerve).
//   importScripts('perceiveIngest.js','opticNerve.js','perceive-bridge.js')
// The durable socket lives in the OFFSCREEN document (see perceive-offscreen.js) because the SW is killed ~30s idle; it
// forwards each frame here via chrome.runtime.sendMessage({type:'rook/perceive-frame', frame, nerve}).
(function () {
  "use strict";
  var G = (typeof self !== "undefined" ? self : globalThis);
  var makeLGN = G.makePerceiveIngest, makeNerve = G.makeOpticNerve;

  // makePerceiveBridge({ onPercept, onEscalate, deviationBank, salience, bodySchema, now, staleMs })
  //   onPercept(percepts, result) : hand fresh percepts to the brain (e.g. attention.js). Optional.
  //   onEscalate(result)          : the fast→slow handoff — a loud sense wants the cortex to convene. Optional.
  //   deviationBank / salience / bodySchema : the real ports, injected (all optional).
  function makePerceiveBridge(opts) {
    opts = opts || {};
    if (typeof makeLGN !== "function") { return { deliver: function () { return { ok: false, reason: "no-lgn" }; }, provenance: function () { return { state: "never" }; }, organs: function () { return []; }, lgn: null }; }
    var now = (typeof opts.now === "function") ? opts.now : function () { return Date.now(); };
    var lgn = makeLGN({ deviationBank: opts.deviationBank || null, salience: opts.salience || null, bodySchema: opts.bodySchema || null, staleMs: opts.staleMs || 10000 });
    var parser = (typeof makeNerve === "function") ? makeNerve({}) : null;   // reuse the nerve's safe parseFrame

    function parse(frameRaw) {
      if (parser) return parser.parseFrame(frameRaw);
      try { var o = (typeof frameRaw === "string") ? JSON.parse(frameRaw) : frameRaw; return (o && Array.isArray(o.packets)) ? { nerve: o.nerve || null, packets: o.packets } : null; } catch (e) { return null; }
    }

    // deliver ONE wire frame (object or JSON string). Returns the LGN result; fires the brain hooks.
    function deliver(frameRaw, extra) {
      try {
        var parsed = parse(frameRaw);
        if (!parsed) return { ok: false, reason: "bad-frame" };
        var nerve = (extra && extra.nerve) || parsed.nerve || "?";
        var res = lgn.ingest(parsed.packets, { nerve: nerve, at: now() });
        if (res && res.percepts && res.percepts.length && typeof opts.onPercept === "function") { try { opts.onPercept(res.percepts, res); } catch (e) {} }
        if (res && res.escalate && typeof opts.onEscalate === "function") { try { opts.onEscalate(res); } catch (e) {} }
        return Object.assign({ ok: true, nerve: nerve }, res);
      } catch (e) { return { ok: false, reason: "threw" }; }
    }

    return {
      deliver: deliver,
      provenance: function (organId) { return lgn.provenance(organId, now()); },   // "is the watch present?" — read/stale/never
      organs: function () { return lgn.organs(now()); },
      lgn: lgn,
    };
  }

  // convenience: wire the offscreen→SW message pump straight into a bridge. Call once from the SW.
  //   listenForFrames(bridge)  — routes chrome.runtime messages {type:'rook/perceive-frame'} to bridge.deliver.
  function listenForFrames(bridge) {
    try {
      if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.onMessage) return false;
      chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
        if (!msg || msg.type !== "rook/perceive-frame") return;
        var r = bridge.deliver(msg.frame, { nerve: msg.nerve });
        try { sendResponse(r); } catch (e) {}
        return true;   // async-safe
      });
      return true;
    } catch (e) { return false; }
  }

  G.makePerceiveBridge = makePerceiveBridge;
  G.listenForPerceiveFrames = listenForFrames;
})();
