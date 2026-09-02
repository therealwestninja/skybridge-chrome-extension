/* hr-ble.js — Web Bluetooth Heart Rate client for the Rook extension.
 *
 * Reads the STANDARD BLE Heart Rate Service (0x180D) / Heart Rate Measurement characteristic (0x2A37, NOTIFY)
 * directly from the watch/strap on THIS PC — the same profile Rook-Face reads on the phone (RookBle.java). No
 * Samsung Health, no phone, no server, no Node: Chrome talks to the sensor over Bluetooth.
 *
 * Parses the 2A37 format (flags + BPM + optional RR intervals), computes a rolling HRV (RMSSD) from the RR
 * intervals when present, and forwards { type:'rook-hr', bpm, hrv, rr, ts } to the extension background, which
 * fans it out to perchance.org anchors → the Skybridge `soma` capability → a Perchance generator.
 *
 * Web Bluetooth needs a user gesture in a visible document, so this runs on hr.html (opened from the popup).
 * The GATT connection lives as long as this page is open; keep it open (or pinned) while you want live HR.
 */
(function () {
  'use strict';
  var HR_SERVICE = 0x180d, HR_MEASUREMENT = 0x2a37;
  var device = null, server = null, characteristic = null;
  var rrBuf = [];                 // recent RR intervals (ms) for HRV
  var reconnectTimer = null, userStopped = false;

  function $(id) { return document.getElementById(id); }
  function setStatus(txt, cls) { var e = $('status'); if (e) { e.textContent = txt; e.className = 'status ' + (cls || ''); } }
  function report(state, extra) {
    try { chrome.runtime.sendMessage({ type: 'rook-hr-status', state: state, device: device && device.name || '', extra: extra || '' }, function () { void chrome.runtime.lastError; }); } catch (e) {}
  }

  // ---- parse the 0x2A37 Heart Rate Measurement value ----
  function parseHr(dv) {
    var flags = dv.getUint8(0);
    var hr16 = (flags & 0x01) !== 0;                 // bit0: HR is uint16 (else uint8)
    var i = 1, bpm;
    if (hr16) { bpm = dv.getUint16(i, true); i += 2; } else { bpm = dv.getUint8(i); i += 1; }
    var eePresent = (flags & 0x08) !== 0;            // bit3: Energy Expended present (uint16) — skip
    if (eePresent) i += 2;
    var rrPresent = (flags & 0x10) !== 0;            // bit4: RR-Interval(s) present (uint16, units of 1/1024 s)
    var rr = [];
    if (rrPresent) { for (; i + 1 < dv.byteLength; i += 2) { rr.push(Math.round(dv.getUint16(i, true) * 1000 / 1024)); } }
    return { bpm: bpm, rr: rr };
  }

  // rolling RMSSD over the last ~30 RR intervals — a simple, standard HRV proxy (ms).
  function updateHrv(rr) {
    if (!rr || !rr.length) return null;
    for (var k = 0; k < rr.length; k++) { if (rr[k] > 250 && rr[k] < 2000) rrBuf.push(rr[k]); }   // sane RR range
    if (rrBuf.length > 30) rrBuf = rrBuf.slice(-30);
    if (rrBuf.length < 3) return null;
    var sum = 0, n = 0;
    for (var j = 1; j < rrBuf.length; j++) { var d = rrBuf[j] - rrBuf[j - 1]; sum += d * d; n++; }
    return n ? Math.round(Math.sqrt(sum / n)) : null;
  }

  function onValue(ev) {
    try {
      var dv = ev.target.value;
      var p = parseHr(dv);
      if (!(p.bpm > 0)) return;
      var hrv = updateHrv(p.rr);
      $('bpm').textContent = p.bpm;
      $('bpm').classList.add('beat'); setTimeout(function () { $('bpm').classList.remove('beat'); }, 140);
      if (hrv != null) $('hrv').textContent = hrv + ' ms';
      var msg = { type: 'rook-hr', bpm: p.bpm, ts: Date.now() };
      if (hrv != null) msg.hrv = hrv;
      if (p.rr.length) msg.rr = p.rr;
      try { chrome.runtime.sendMessage(msg, function () { void chrome.runtime.lastError; }); } catch (e) {}
    } catch (e) { /* keep streaming */ }
  }

  function onDisconnect() {
    setStatus('disconnected — reconnecting…', 'warn'); report('disconnected');
    characteristic = null; server = null;
    if (userStopped) { setStatus('stopped', ''); return; }
    if (device && !reconnectTimer) {
      reconnectTimer = setTimeout(function () { reconnectTimer = null; connectGatt().catch(function () { setStatus('reconnect failed — click Reconnect', 'err'); }); }, 2500);
    }
  }

  async function connectGatt() {
    if (!device) return;
    setStatus('connecting to ' + (device.name || 'sensor') + '…', '');
    server = await device.gatt.connect();
    var service = await server.getPrimaryService(HR_SERVICE);
    characteristic = await service.getCharacteristic(HR_MEASUREMENT);
    await characteristic.startNotifications();
    characteristic.addEventListener('characteristicvaluechanged', onValue);
    setStatus('live — streaming HR from ' + (device.name || 'sensor'), 'ok'); report('connected');
    $('connect').textContent = 'Reconnect';
    $('disconnect').disabled = false;
  }

  async function pick() {
    if (!navigator.bluetooth) { setStatus('Web Bluetooth not available in this browser', 'err'); return; }
    userStopped = false;
    try {
      device = await navigator.bluetooth.requestDevice({ filters: [{ services: [HR_SERVICE] }], optionalServices: [HR_SERVICE] });
    } catch (e) {
      setStatus(e && e.name === 'NotFoundError' ? 'no device chosen' : ('device pick failed: ' + (e && e.message || e)), 'warn');
      return;
    }
    $('devname').textContent = device.name || '(unnamed)';
    device.addEventListener('gattserverdisconnected', onDisconnect);
    try { await connectGatt(); } catch (e) { setStatus('connect failed: ' + (e && e.message || e) + ' — is the phone/Rook-Face still holding the sensor? A BLE HR device allows one link at a time.', 'err'); }
  }

  function stop() {
    userStopped = true;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    try { if (characteristic) characteristic.removeEventListener('characteristicvaluechanged', onValue); } catch (e) {}
    try { if (device && device.gatt && device.gatt.connected) device.gatt.disconnect(); } catch (e) {}
    setStatus('stopped', ''); report('stopped'); $('disconnect').disabled = true;
  }

  document.addEventListener('DOMContentLoaded', function () {
    $('connect').addEventListener('click', pick);
    $('disconnect').addEventListener('click', stop);
    if (!navigator.bluetooth) setStatus('This browser build has no Web Bluetooth — HR-over-BLE unavailable.', 'err');
    else setStatus('idle — click Connect and pick your HR sensor', '');
  });
})();
