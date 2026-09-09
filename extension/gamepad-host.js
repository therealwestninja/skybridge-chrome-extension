/* gamepad-host.js — top-level game-controller HOST for the Rook extension.
 *
 * The MIRROR of hr-ble.js, for a physical game pad instead of a BLE heart-rate strap. Inside Perchance's
 * sandboxed generator iframe navigator.getGamepads() is Permissions-Policy-gated to empty, so the embed can never
 * read a pad directly (see src/scripts/071-gamepad.js, which stays inert there). This page runs at the TOP level
 * (gamepad.html, opened from the popup), where getGamepads() works: it polls the pad on a rAF loop, detects button
 * RISING EDGES, maps each to the SAME gate signal id the embed's overlay uses (reusing 071's map), and forwards the
 * raw edge to the background worker as { type:'rook-gamepad', id }. The worker fans it out to every perchance.org
 * anchor tab as { type:'rook-gamepad-in', id }, the anchor republishes it on the weld bus channel 'gamepad:input',
 * and the embed's SB.bus.subscribe('gamepad:input') routes it into window.Gamepad.ingestExternal — where it fires
 * through the embed's debounced/rate-limited press path, tagged via:"remote" so its escalation is DOWN-RANKED to the
 * consent matrix (RED / de-escalation stay always-honored). All the consent gating lives on the embed side; the host
 * merely FORWARDS raw presses. We keep the host's own debounce LIGHT (rising-edge only — a held button fires once);
 * the embed owns the rate-limit + down-rank.
 *
 * RUMBLE (embed -> pad): the embed's actuation backend (187-rookActuationGamepad.js) publishes an already-gated +
 * attenuated { strong, weak, duration } frame on bus channel 'gamepad:rumble' when it has no LOCAL vibration pad;
 * the anchor forwards it up, the worker routes it here as { type:'rook-rumble', strong, weak, duration }, and we
 * drive THIS page's pad motor with playEffect("dual-rumble", ...). A zero/stop frame (duration 0 or strong+weak 0)
 * calls vibrationActuator.reset() so a safeword halts the host motor. Every safety decision (consent, clamp, CEIL
 * attenuation, estop) is made upstream on the embed; the host just plays the frame it is handed.
 *
 * Self-halts polling on hidden/blur (a held button can't leak while backgrounded; a fresh baseline on resume avoids
 * a spurious edge). Never throws when no pad is present.
 */
(function () {
  'use strict';

  // Standard-mapping button indices -> a gate signal id (identical to 071-gamepad.js's BTN map).
  var BTN = {
    0:  'green',        // South (A) — Go
    1:  'yellow',       // East (B)  — Ease
    3:  'surpriseme',   // North (Y) — yield the next beat
    12: 'more',         // D-pad up
    13: 'less',         // D-pad down
    4:  'less',         // LB / L1
    5:  'more',         // RB / R1
    9:  'red'           // Start / Options — the single prominent STOP
  };
  var TRIG = { 6: 'less', 7: 'more' };   // LT -> less, RT -> more (analog, past threshold)
  var ENTER = 0.6, EXIT = 0.4;           // hysteresis band for analog triggers (calibrate.html overrides these)
  var CHORD_STICKS = [10, 11];           // both stick-clicks (L3 + R3) = backup RED chord

  // Trigger limits are user-tunable in calibrate.html, persisted at chrome.storage.local 'rook-gamepad-cal'.
  // Load them on start and follow live edits, so the FIRE/RELEASE thresholds the user set actually govern forwarding.
  function applyCal(v) {
    try {
      if (!v) return;
      if (typeof v.enter === 'number' && v.enter > 0.05 && v.enter < 0.98) ENTER = v.enter;
      if (typeof v.exit === 'number' && v.exit >= 0.02 && v.exit < ENTER) EXIT = v.exit;
    } catch (e) {}
  }
  function loadCal() {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get('rook-gamepad-cal', function (o) { applyCal(o && o['rook-gamepad-cal']); });
        if (chrome.storage.onChanged) chrome.storage.onChanged.addListener(function (ch, area) { if (area === 'local' && ch['rook-gamepad-cal']) applyCal(ch['rook-gamepad-cal'].newValue); });
        return;
      }
    } catch (e) {}
    try { applyCal(JSON.parse(localStorage.getItem('rook-gamepad-cal') || 'null')); } catch (e) {}
  }
  try { loadCal(); } catch (e) {}

  var running = false, rafId = null;
  var everSaw = false;
  var prevActive = {};                   // logical-control-id -> boolean (rising-edge diff)
  var count = 0;                         // presses forwarded this session (UI only)

  function $(id) { return document.getElementById(id); }
  function setStatus(txt, cls) { var e = $('status'); if (e) { e.textContent = txt; e.className = 'status ' + (cls || ''); } }
  function report(state, extra) {
    try { chrome.runtime.sendMessage({ type: 'rook-gamepad-status', state: state, extra: extra || '' }, function () { void chrome.runtime.lastError; }); } catch (e) {}
  }

  function padsApi() { try { return (typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function'); } catch (e) { return false; } }
  function padList() { try { var g = navigator.getGamepads(); return g ? Array.prototype.slice.call(g) : []; } catch (e) { return []; } }
  function livePads() { return padList().filter(function (p) { return !!p; }); }

  // The ONE outbound path: forward a raw press edge to the worker. No rate-limit here — the embed owns that.
  function forward(id) {
    if (!id) return;
    try { chrome.runtime.sendMessage({ type: 'rook-gamepad', id: String(id) }, function () { void chrome.runtime.lastError; }); } catch (e) {}
    count++;
    try {
      var s = $('signal'); if (s) s.textContent = id;
      var c = $('count'); if (c) c.textContent = String(count);
    } catch (e) {}
  }

  // CONTINUOUS motion: forward a throttled RAW analog frame { ax:[lx,ly,rx,ry], lt, rt } to the worker → embed
  // ingestMotion (which owns the deadzone/curve/smoothing/mapping, identical to the phone module). Host stays dumb:
  // raw values only. ~30 Hz cap + a small deadband so a resting/held pad doesn't spam the bus, but the first settled
  // frame after movement (incl. the return to rest) always goes so the embed eases to 0.
  var _lastMotion = null, _lastMotionAt = 0;
  function r3(v) { v = +v || 0; return Math.round(v * 1000) / 1000; }
  function forwardMotion(ax, lt, rt) {
    var now = Date.now();
    if (now - _lastMotionAt < 33) return;                            // ~30 Hz
    var f = { ax: [r3(ax[0]), r3(ax[1]), r3(ax[2]), r3(ax[3])], lt: r3(lt), rt: r3(rt) };
    if (_lastMotion) {
      var l = _lastMotion, same = Math.abs(f.ax[0] - l.ax[0]) < 0.008 && Math.abs(f.ax[1] - l.ax[1]) < 0.008 &&
        Math.abs(f.ax[2] - l.ax[2]) < 0.008 && Math.abs(f.ax[3] - l.ax[3]) < 0.008 && Math.abs(f.lt - l.lt) < 0.008 && Math.abs(f.rt - l.rt) < 0.008;
      if (same) return;                                              // deadband — nothing meaningful changed
    }
    _lastMotion = f; _lastMotionAt = now;
    try { chrome.runtime.sendMessage({ type: 'rook-gamepad-motion', frame: f }, function () { void chrome.runtime.lastError; }); } catch (e) {}
  }

  // rising-edge: forward only on false->true for a logical control.
  function edge(key, active, signal) {
    var was = !!prevActive[key];
    prevActive[key] = !!active;
    if (active && !was) forward(signal);
  }
  // hysteresis edge for analog triggers: enter above ENTER, exit below EXIT; forward once on entry.
  function analogEdge(key, value, signal) {
    var was = !!prevActive[key], active = was ? (value > EXIT) : (value > ENTER);
    prevActive[key] = active;
    if (active && !was) forward(signal);
  }

  function scan(pad) {
    if (!pad) return;
    everSaw = true;
    var pid = pad.index != null ? pad.index : 0, B = pad.buttons || [];
    for (var idx in BTN) {
      if (!Object.prototype.hasOwnProperty.call(BTN, idx)) continue;
      var b = B[+idx], active = !!(b && (b.pressed || (typeof b.value === 'number' && b.value > 0.5)));
      edge('b:' + pid + ':' + idx, active, BTN[idx]);
    }
    for (var t in TRIG) {
      if (!Object.prototype.hasOwnProperty.call(TRIG, t)) continue;
      var tb = B[+t], v = tb ? (typeof tb.value === 'number' ? tb.value : (tb.pressed ? 1 : 0)) : 0;
      analogEdge('t:' + pid + ':' + t, v, TRIG[t]);
    }
    var c0 = B[CHORD_STICKS[0]], c1 = B[CHORD_STICKS[1]];
    var chord = !!(c0 && c0.pressed) && !!(c1 && c1.pressed);
    edge('chord:' + pid, chord, 'red');
  }

  function poll() {
    if (!running) return;
    try {
      var pads = livePads();
      for (var i = 0; i < pads.length; i++) scan(pads[i]);
      if (pads.length) {
        var p0 = pads[0], B0 = p0.buttons || [], rd = function (n) { var b = B0[n]; return b ? (typeof b.value === 'number' ? b.value : (b.pressed ? 1 : 0)) : 0; };
        forwardMotion(p0.axes || [], rd(6), rd(7));
        setStatus('live — forwarding presses + motion from ' + (p0.id || 'pad'), 'ok');
      }
    } catch (e) { /* never throw */ }
    rafId = (typeof requestAnimationFrame === 'function') ? requestAnimationFrame(poll) : null;
    if (!rafId) { try { rafId = setTimeout(poll, 50); } catch (e) {} }
  }

  function start() {
    if (running) return;
    if (!padsApi()) { setStatus('This browser build has no Gamepad API.', 'err'); return; }
    running = true;
    prevActive = {};                     // fresh baseline so a button already held at start doesn't fire
    poll();
    if (!livePads().length) setStatus('waiting for a pad — press a button on your controller…', '');
    report('running');
  }
  function stop() {
    running = false;
    try { if (rafId && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId); } catch (e) {}
    try { if (rafId) clearTimeout(rafId); } catch (e) {}
    rafId = null; prevActive = {};
  }

  // ---- RUMBLE receive: drive THIS page's pad motor with the embed's already-gated + attenuated frame ----
  function vibePads() {
    return livePads().filter(function (p) { return p && p.vibrationActuator && typeof p.vibrationActuator.playEffect === 'function'; });
  }
  // The same frame can arrive twice: the anchor's runtime.sendMessage reaches this extension page DIRECTLY, and the
  // worker ALSO routes a copy to this tab. Drop an identical NON-STOP frame seen within a hair of the last one — the
  // embed's tick is 100ms apart and each tick differs, so a same-value frame <32ms later is the duplicate, not a real
  // beat. Stop frames (safeword) are NEVER deduped: a halt must always reach the motor.
  var _lastFrame = '', _lastFrameAt = 0;
  function playRumble(strong, weak, dur) {
    var s = Number(strong), w = Number(weak), d = Number(dur);
    if (!isFinite(s)) s = 0; if (!isFinite(w)) w = 0; if (!isFinite(d)) d = 0;
    s = Math.max(0, Math.min(1, s)); w = Math.max(0, Math.min(1, w)); d = Math.max(0, Math.min(5000, d));
    var isStop = (d <= 0 || (s <= 0 && w <= 0));
    if (!isStop) {
      var key = s.toFixed(3) + '|' + w.toFixed(3) + '|' + d, now = Date.now();
      if (key === _lastFrame && (now - _lastFrameAt) < 32) return;   // duplicate delivery — skip
      _lastFrame = key; _lastFrameAt = now;
    }
    var pads = vibePads();
    // A zero/stop frame (safeword upstream) — reset the LATCHED effect immediately so the host motor halts.
    if (d <= 0 || (s <= 0 && w <= 0)) {
      for (var j = 0; j < pads.length; j++) {
        var va = pads[j].vibrationActuator;
        try { if (typeof va.reset === 'function') va.reset(); else va.playEffect('dual-rumble', { duration: 0, strongMagnitude: 0, weakMagnitude: 0 }); } catch (e) {}
      }
      try { var rz = $('rumble'); if (rz) rz.textContent = '— (stop)'; } catch (e) {}
      return;
    }
    for (var i = 0; i < pads.length; i++) {
      try { pads[i].vibrationActuator.playEffect('dual-rumble', { startDelay: 0, duration: d, strongMagnitude: s, weakMagnitude: w }); } catch (e) {}
    }
    try { var r = $('rumble'); if (r) r.textContent = s.toFixed(2) + ' / ' + w.toFixed(2); } catch (e) {}
  }

  try {
    chrome.runtime.onMessage.addListener(function (m, sender, sendResp) {
      if (!m || m.type !== 'rook-rumble') return;
      try { playRumble(m.strong, m.weak, m.duration); if (sendResp) sendResp({ ok: true }); }
      catch (e) { try { if (sendResp) sendResp({ ok: false }); } catch (e2) {} }
      return true;
    });
  } catch (e) {}

  // lifecycle: self-halt polling when the tab is hidden / loses focus; resume when visible + focused.
  function onHide() { if (typeof document !== 'undefined' && document.hidden) stop(); }
  function onVisible() { try { if (typeof document !== 'undefined' && !document.hidden) start(); } catch (e) {} }
  try {
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('gamepadconnected', function () { everSaw = true; start(); setStatus('pad connected', 'ok'); });
      window.addEventListener('gamepaddisconnected', function () { if (!livePads().length) { prevActive = {}; setStatus('pad disconnected', 'warn'); } });
      window.addEventListener('blur', stop);
      window.addEventListener('focus', onVisible);
    }
    if (typeof document !== 'undefined' && document.addEventListener) document.addEventListener('visibilitychange', onHide);
  } catch (e) {}

  document.addEventListener('DOMContentLoaded', function () {
    if (!padsApi()) { setStatus('This browser build has no Gamepad API — controller forwarding unavailable.', 'err'); return; }
    start();
  });
})();
