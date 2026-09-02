'use strict';
/* offscreen-serial.js — the SERIAL port HOLDER for Rook's `serial` capability (drives an OSSM over USB @115200).
 *
 * WHY here: navigator.serial is NOT available in an MV3 service worker; it needs a DOCUMENT context. The one-time
 * PORT GRANT (navigator.serial.requestPort) happens in the POPUP (a user gesture + visible page). The live port is
 * then OPENED + read/written HERE, in the persistent offscreen document, which can call navigator.serial.getPorts()
 * to reach an already-granted port with no gesture. The background worker is only a MESSAGE ROUTER between the
 * page's anchor Port ('rook-serial') and this doc — it never holds the port itself.
 *
 * Protocol with the worker:
 *   worker -> here (chrome.runtime.sendMessage, we sendResponse):  { type:'rook-serial', op:'list'|'open'|'write'|'close', ... }
 *   here   -> worker (chrome.runtime.sendMessage, no response):    { type:'rook-serial-rx', id, b64 }         (bytes read)
 *                                                                  { type:'rook-serial-event', id, event:'close', reason } (port lost)
 * Bytes are base64 for binary (mirrors the ble cap's dataB64). */
(function () {
  var ports = {};   // id -> { port, writer, keepReading }
  var seq = 0;

  function serialApi() { try { return navigator.serial || null; } catch (e) { return null; } }
  function u8ToB64(u8) { var s = "", i; for (i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); try { return btoa(s); } catch (e) { return ""; } }
  function b64ToU8(b64) { var out = []; try { var bin = atob(String(b64 || "")); for (var i = 0; i < bin.length; i++) out.push(bin.charCodeAt(i) & 0xFF); } catch (e) {} return new Uint8Array(out); }
  function toWorker(msg) { try { chrome.runtime.sendMessage(msg, function () { void chrome.runtime.lastError; }); } catch (e) {} }

  function listPorts() {
    var s = serialApi(); if (!s) return Promise.resolve([]);
    return Promise.resolve(s.getPorts()).then(function (list) {
      return (list || []).map(function (p, i) { var info = {}; try { info = p.getInfo() || {}; } catch (e) {} return { index: i, usbVendorId: info.usbVendorId, usbProductId: info.usbProductId }; });
    }, function () { return []; });
  }

  async function readLoop(id) {
    var rec = ports[id]; if (!rec) return;
    var closedReason = "eof";
    try {
      while (rec.keepReading && rec.port && rec.port.readable) {
        var reader = rec.port.readable.getReader();
        rec.reader = reader;
        try {
          while (true) {
            var res = await reader.read();
            if (res.done) break;
            if (res.value && res.value.length) toWorker({ type: "rook-serial-rx", id: id, b64: u8ToB64(res.value) });
          }
        } catch (e) { closedReason = "read-error"; break; }
        finally { try { reader.releaseLock(); } catch (e) {} }
      }
    } catch (e) { closedReason = "loop-error"; }
    // the read loop ended -> the port was closed or physically unplugged. Tell the page (via worker -> bus rook:serial).
    if (ports[id]) { cleanup(id); toWorker({ type: "rook-serial-event", id: id, event: "close", reason: closedReason }); }
  }

  function cleanup(id) {
    var rec = ports[id]; if (!rec) return;
    rec.keepReading = false;
    try { if (rec.writer) rec.writer.releaseLock(); } catch (e) {}
    try { if (rec.reader) rec.reader.cancel(); } catch (e) {}
    try { if (rec.port) rec.port.close(); } catch (e) {}
    delete ports[id];
  }

  function openPort(path, baud) {
    var s = serialApi(); if (!s) return Promise.resolve({ ok: false, reason: "no-web-serial" });
    return Promise.resolve(s.getPorts()).then(function (list) {
      list = list || [];
      if (!list.length) return { ok: false, reason: "no-granted-port" };   // the popup must grant a port first (requestPort)
      var idx = 0; if (path != null && path !== "") { var n = parseInt(path, 10); if (!isNaN(n) && n >= 0 && n < list.length) idx = n; }
      var port = list[idx];
      return Promise.resolve(port.open({ baudRate: baud || 115200 })).then(function () {
        var id = "sc" + (++seq) + "-" + Date.now().toString(36);
        var writer = null; try { writer = port.writable ? port.writable.getWriter() : null; } catch (e) { writer = null; }
        ports[id] = { port: port, writer: writer, reader: null, keepReading: true };
        readLoop(id);   // start streaming reads
        return { ok: true, id: id };
      }, function (e) { return { ok: false, reason: String((e && e.message) || e).slice(0, 120) }; });
    }, function () { return { ok: false, reason: "getPorts-failed" }; });
  }

  function writePort(id, bytesU8) {
    var rec = ports[id]; if (!rec) return Promise.resolve({ ok: false, reason: "no-such-port" });
    try {
      if (!rec.writer) { if (!rec.port || !rec.port.writable) return Promise.resolve({ ok: false, reason: "not-writable" }); rec.writer = rec.port.writable.getWriter(); }
      return Promise.resolve(rec.writer.write(bytesU8)).then(function () { return { ok: true }; }, function (e) { cleanup(id); toWorker({ type: "rook-serial-event", id: id, event: "close", reason: "write-error" }); return { ok: false, reason: "write-error" }; });
    } catch (e) { return Promise.resolve({ ok: false, reason: String((e && e.message) || e).slice(0, 120) }); }
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || msg.type !== "rook-serial") return;   // only the worker's serial ops; everything else ignored
    var op = String(msg.op || "");
    if (op === "list") { listPorts().then(function (ports) { sendResponse({ ok: true, ports: ports }); }); return true; }
    if (op === "open") { openPort(msg.path, msg.baud).then(function (r) { sendResponse(r); }); return true; }
    if (op === "write") { writePort(String(msg.id || ""), b64ToU8(msg.dataB64)).then(function (r) { sendResponse(r); }); return true; }
    if (op === "close") { cleanup(String(msg.id || "")); sendResponse({ ok: true }); return true; }
    return false;
  });
})();
