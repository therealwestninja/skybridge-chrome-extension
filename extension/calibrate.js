/* calibrate.js — Rook game-controller CALIBRATION + TEST bench (top-level page, where the Gamepad API works).
 *
 * Live view of every button / stick / trigger on the connected pad, the Rook signal each MAPPED control fires,
 * a test log that flashes when a mapped control crosses its edge, and calibration sliders for the analog-trigger
 * hysteresis (enter/exit) + stick deadzone. Saves to chrome.storage.local 'rook-gamepad-cal'; gamepad-host.js
 * reads the same key so the trigger limits you set here actually govern what gets forwarded. Read-only diagnostic
 * otherwise — it forwards NOTHING to Rook (that is gamepad-host.js's job); this page is purely for setup/verify.
 */
(function () {
  'use strict';
  var DEF = { enter: 0.60, exit: 0.40, deadzone: 0.15 };
  var CAL_KEY = 'rook-gamepad-cal';
  var cal = { enter: DEF.enter, exit: DEF.exit, deadzone: DEF.deadzone };

  // The SAME map gamepad-host.js / 071-gamepad.js use (button index / trigger index -> gate signal id).
  var BTN = { 0: 'green', 1: 'yellow', 3: 'surpriseme', 12: 'more', 13: 'less', 4: 'less', 5: 'more', 9: 'red' };
  var TRIG = { 6: 'less', 7: 'more' };           // LT / RT analog triggers
  var CHORD = [10, 11];                            // L3 + R3 held together -> red
  var BTN_NAME = { 0: 'A', 1: 'B', 2: 'X', 3: 'Y', 4: 'LB', 5: 'RB', 6: 'LT', 7: 'RT', 8: 'Back', 9: 'Start', 10: 'L3', 11: 'R3', 12: 'D↑', 13: 'D↓', 14: 'D←', 15: 'D→', 16: 'Guide' };
  var SIG_COLOR = { green: 'var(--green)', more: 'var(--green)', yellow: 'var(--amber)', less: 'var(--amber)', surpriseme: 'var(--accent)', red: 'var(--red)' };

  var $ = function (id) { return document.getElementById(id); };
  var prevPressed = {};    // edge detection for the test log
  var prevTrig = {};       // hysteresis state for the test log
  var logLines = [];

  // ---- persisted calibration ----
  function loadCal(done) {
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(CAL_KEY, function (o) { var v = o && o[CAL_KEY]; if (v) merge(v); done && done(); });
        return;
      }
    } catch (e) {}
    try { var v = JSON.parse(localStorage.getItem(CAL_KEY) || 'null'); if (v) merge(v); } catch (e) {}
    done && done();
  }
  function merge(v) {
    if (typeof v.enter === 'number') cal.enter = clamp(v.enter, 0.05, 0.95);
    if (typeof v.exit === 'number') cal.exit = clamp(v.exit, 0.02, cal.enter - 0.02);
    if (typeof v.deadzone === 'number') cal.deadzone = clamp(v.deadzone, 0, 0.5);
  }
  function saveCal() {
    try { if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) chrome.storage.local.set((function () { var o = {}; o[CAL_KEY] = cal; return o; })()); } catch (e) {}
    try { localStorage.setItem(CAL_KEY, JSON.stringify(cal)); } catch (e) {}
    flash('saved — the host will use these limits');
  }
  function clamp(x, lo, hi) { x = +x; if (!(x > lo)) x = lo; return x > hi ? hi : x; }

  // ---- gamepad access ----
  function pads() { try { var g = navigator.getGamepads ? navigator.getGamepads() : []; return g ? Array.prototype.slice.call(g).filter(Boolean) : []; } catch (e) { return []; } }

  function pushLog(txt, color) {
    logLines.unshift({ t: Date.now(), txt: txt, color: color || 'var(--ink)' });
    if (logLines.length > 8) logLines.pop();
    var el = $('log');
    if (el) el.innerHTML = logLines.map(function (l) { return '<div class="logline" style="color:' + l.color + '">' + esc(l.txt) + '</div>'; }).join('');
  }
  function esc(s) { return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }
  function flash(msg) { var el = $('savemsg'); if (el) { el.textContent = msg; el.style.opacity = '1'; setTimeout(function () { el.style.opacity = '0'; }, 1800); } }

  // ---- render one frame ----
  function bar(v, mark1, mark2) {
    var pct = Math.round(clamp(v, 0, 1) * 100);
    var marks = '';
    if (mark1 != null) marks += '<span class="tick" style="left:' + Math.round(mark1 * 100) + '%"></span>';
    if (mark2 != null) marks += '<span class="tick exit" style="left:' + Math.round(mark2 * 100) + '%"></span>';
    return '<div class="bar"><span class="fill" style="width:' + pct + '%"></span>' + marks + '</div>';
  }

  function render() {
    var ps = pads();
    var st = $('status');
    if (!navigator.getGamepads) { st.className = 'status err'; st.textContent = 'This browser has no Gamepad API.'; requestAnimationFrame(render); return; }
    if (!ps.length) { st.className = 'status warn'; st.textContent = 'No controller detected — connect a pad and PRESS ANY BUTTON (the browser reveals a pad only after a button press).'; $('body-panels').style.opacity = '.35'; requestAnimationFrame(render); return; }
    $('body-panels').style.opacity = '1';
    var p = ps[0];
    st.className = 'status ok'; st.textContent = 'Connected: ' + (p.id || 'controller') + '  ·  ' + p.buttons.length + ' buttons, ' + p.axes.length + ' axes  ·  mapping: ' + (p.mapping || 'non-standard');

    // BUTTONS
    var bhtml = '';
    for (var i = 0; i < p.buttons.length; i++) {
      var b = p.buttons[i], pressed = !!(b && (b.pressed || b.value > 0.5)), val = b ? (+b.value || 0) : 0;
      var sig = BTN[i] || (TRIG[i] || '');
      var nm = BTN_NAME[i] || ('b' + i);
      var cls = 'btn' + (pressed ? ' on' : '') + (sig ? ' mapped' : '');
      var scol = sig ? (SIG_COLOR[sig] || 'var(--accent)') : 'var(--muted)';
      bhtml += '<div class="' + cls + '"><span class="bi">' + i + '</span><span class="bn">' + nm + '</span>'
        + (sig ? '<span class="bs" style="color:' + scol + '">' + sig + '</span>' : '<span class="bs off">—</span>')
        + (val > 0 && val < 1 ? '<span class="bv">' + val.toFixed(2) + '</span>' : '') + '</div>';
      // test-log edge for mapped digital buttons
      var key = 'b' + i;
      if (BTN[i] && pressed && !prevPressed[key]) pushLog('▸ ' + nm + ' (btn ' + i + ') → ' + BTN[i], SIG_COLOR[BTN[i]]);
      prevPressed[key] = pressed;
    }
    $('buttons').innerHTML = bhtml;
    // chord
    var chord = p.buttons[CHORD[0]] && p.buttons[CHORD[0]].pressed && p.buttons[CHORD[1]] && p.buttons[CHORD[1]].pressed;
    if (chord && !prevPressed.chord) pushLog('▸ L3+R3 chord → red (backup STOP)', 'var(--red)');
    prevPressed.chord = chord;

    // STICKS (axes 0/1 = left, 2/3 = right) with deadzone ring
    $('sticks').innerHTML = stickHtml('Left', p.axes[0], p.axes[1]) + stickHtml('Right', p.axes[2], p.axes[3]);

    // TRIGGERS (analog) with enter/exit hysteresis marks + armed state
    var thtml = '';
    for (var t in TRIG) {
      if (!Object.prototype.hasOwnProperty.call(TRIG, t)) continue;
      var tb = p.buttons[+t], tv = tb ? (+tb.value || 0) : 0, sg = TRIG[t];
      var was = !!prevTrig[t], armed = was ? (tv > cal.exit) : (tv > cal.enter);
      if (armed && !was) pushLog('▸ ' + (BTN_NAME[+t] || ('b' + t)) + ' trigger → ' + sg + ' (crossed ' + cal.enter.toFixed(2) + ')', SIG_COLOR[sg]);
      prevTrig[t] = armed;
      thtml += '<div class="trigrow"><span class="tl">' + (BTN_NAME[+t] || t) + ' → <b style="color:' + (SIG_COLOR[sg] || 'var(--accent)') + '">' + sg + '</b></span>'
        + bar(tv, cal.enter, cal.exit)
        + '<span class="tv ' + (armed ? 'armed' : '') + '">' + tv.toFixed(2) + (armed ? ' ▸FIRE' : '') + '</span></div>';
    }
    $('triggers').innerHTML = thtml;

    requestAnimationFrame(render);
  }

  function stickHtml(label, ax, ay) {
    ax = +ax || 0; ay = +ay || 0;
    var mag = Math.sqrt(ax * ax + ay * ay), live = mag > cal.deadzone;
    var cx = 50 + ax * 42, cy = 50 + ay * 42;   // % within the 100x100 box
    var dz = Math.round(cal.deadzone * 84);      // deadzone ring diameter (% of box, 42*2)
    return '<div class="stick"><div class="pad"><span class="dz" style="width:' + dz + '%;height:' + dz + '%"></span>'
      + '<span class="dot' + (live ? ' live' : '') + '" style="left:' + cx + '%;top:' + cy + '%"></span></div>'
      + '<div class="sl">' + label + ' <span class="sxy">' + ax.toFixed(2) + ', ' + ay.toFixed(2) + (live ? '' : '  (deadzone)') + '</span></div></div>';
  }

  // ---- calibration controls ----
  function wireControls() {
    var e = $('enter'), x = $('exit'), d = $('deadzone');
    function reflect() {
      e.value = cal.enter; x.value = cal.exit; d.value = cal.deadzone;
      $('enterv').textContent = cal.enter.toFixed(2); $('exitv').textContent = cal.exit.toFixed(2); $('deadzonev').textContent = cal.deadzone.toFixed(2);
    }
    e.addEventListener('input', function () { cal.enter = clamp(+e.value, 0.05, 0.95); if (cal.exit > cal.enter - 0.02) cal.exit = cal.enter - 0.02; reflect(); });
    x.addEventListener('input', function () { cal.exit = clamp(+x.value, 0.02, cal.enter - 0.02); reflect(); });
    d.addEventListener('input', function () { cal.deadzone = clamp(+d.value, 0, 0.5); reflect(); });
    $('save').addEventListener('click', saveCal);
    $('reset').addEventListener('click', function () { cal.enter = DEF.enter; cal.exit = DEF.exit; cal.deadzone = DEF.deadzone; reflect(); flash('reset to defaults (not yet saved)'); });
    reflect();
  }

  loadCal(function () { wireControls(); requestAnimationFrame(render); });
})();
