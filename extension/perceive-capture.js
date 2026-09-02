'use strict';
/* perceive-capture.js — the OPT-IN perception capture surface for the Rook extension. Gives the desktop
 * extension the phone anchor's vision/device/geo parity (see sweetie-phone-slim RookVision.java / RookGeo.java).
 *
 * WHERE IT RUNS: inside the extension's single persistent OFFSCREEN document (offscreen.html loads this
 * alongside the brain). Chrome allows only ONE offscreen document per extension and the always-on brain owns
 * that slot, so the capture cannot live in a second doc — it is folded into the one doc and gated ENTIRELY by
 * a start message. Nothing here touches the camera or geolocation until the worker sends
 * { type:'rook-perceive-capture-cmd', on:true, which:[...] }, which the worker only sends after a generator
 * holds the `perceive` consent. No consent → no start → the OS camera/location prompt never even appears.
 *
 * PRIVACY: raw video frames and raw lat/lng NEVER leave this document. Only three derived scalars per organ
 * cross out via chrome.runtime.sendMessage({ type:'rook-perceive', organ, data }):
 *   vision : { presence:bool, motion:0..1, brightness:0..1 }
 *   geo    : { speed:0..1, place:'<opaque FNV hash>', moved:bool }
 *   device : { presence:bool }
 * Native (phone) does deviation+keepalive gating so the bus stays quiet; we mirror that exactly.
 */
(function () {
  if (typeof window !== 'undefined' && window.__rookPerceiveCapture) return;
  try { window.__rookPerceiveCapture = true; } catch (e) {}

  function emit(organ, data) {
    try { chrome.runtime.sendMessage({ type: 'rook-perceive', organ: organ, data: data }, function () { void chrome.runtime.lastError; }); } catch (e) {}
  }
  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  // ---------------- VISION: getUserMedia → 32x24 luma reduction (mirrors RookVision.java) ----------------
  var vision = {
    stream: null, video: null, canvas: null, cctx: null, timer: null, starting: false,
    prev: null, ring: [0, 0, 0, 0, 0, 0], ringLen: 0, ringPos: 0,
    lastPresence: false, lastMotion: -1, lastBright: -1, lastEmit: 0
  };
  var V_W = 32, V_H = 24, V_INTERVAL_MS = 500, V_MOTION_THRESH = 0.012, V_KEEPALIVE_MS = 4000;

  function visionStart() {
    if (vision.stream || vision.starting) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
    vision.starting = true;
    navigator.mediaDevices.getUserMedia({ video: { width: 160, height: 120, facingMode: 'user' } }).then(function (stream) {
      vision.starting = false;
      vision.stream = stream;
      var v = document.createElement('video');
      v.autoplay = true; v.muted = true; v.playsInline = true; v.srcObject = stream;
      vision.video = v;
      vision.canvas = document.createElement('canvas'); vision.canvas.width = V_W; vision.canvas.height = V_H;
      vision.cctx = vision.canvas.getContext('2d', { willReadFrequently: true });
      var begin = function () { if (!vision.timer) vision.timer = setInterval(visionTick, V_INTERVAL_MS); };
      v.addEventListener('loadeddata', begin);
      v.play().then(begin).catch(function () { begin(); });   // begin regardless; a stalled frame just skips
    }).catch(function () { vision.starting = false; /* denied/unavailable: vision stays off (silent) */ });
  }

  function visionTick() {
    try {
      var v = vision.video; if (!v || v.readyState < 2 || !v.videoWidth) return;
      vision.cctx.drawImage(v, 0, 0, V_W, V_H);
      var img = vision.cctx.getImageData(0, 0, V_W, V_H).data;
      var count = V_W * V_H, cur = new Float32Array(count);
      var sumLuma = 0, sumDiff = 0, k = 0, havePrev = vision.prev && vision.prev.length === count;
      for (var p = 0; p < img.length; p += 4) {
        var lv = 0.299 * img[p] + 0.587 * img[p + 1] + 0.114 * img[p + 2];   // Y (luma), 0..255
        cur[k] = lv; sumLuma += lv;
        if (havePrev) sumDiff += Math.abs(lv - vision.prev[k]);
        k++;
      }
      if (k === 0) return;
      var brightness = clamp01((sumLuma / k) / 255.0);
      var motion = havePrev ? clamp01((sumDiff / k) / 255.0) : 0.0;
      vision.prev = cur;

      // presence: ring of the last ~6 motions; present when >=3 samples and at least half exceed the threshold
      vision.ring[vision.ringPos] = motion;
      vision.ringPos = (vision.ringPos + 1) % vision.ring.length;
      if (vision.ringLen < vision.ring.length) vision.ringLen++;
      var over = 0; for (var i = 0; i < vision.ringLen; i++) if (vision.ring[i] > V_MOTION_THRESH) over++;
      var presence = vision.ringLen >= 3 && over * 2 >= vision.ringLen;

      var m2 = Math.round(motion * 100) / 100, b2 = Math.round(brightness * 100) / 100, now = Date.now();
      var doEmit = presence !== vision.lastPresence
        || vision.lastMotion < 0 || vision.lastBright < 0
        || Math.abs(m2 - vision.lastMotion) > 0.05
        || Math.abs(b2 - vision.lastBright) > 0.05
        || (now - vision.lastEmit) > V_KEEPALIVE_MS;
      if (!doEmit) return;
      vision.lastPresence = presence; vision.lastMotion = m2; vision.lastBright = b2; vision.lastEmit = now;
      emit('vision', { presence: presence, motion: m2, brightness: b2 });
    } catch (e) { /* a bad frame just skips */ }
  }

  function visionStop() {
    try { if (vision.timer) clearInterval(vision.timer); } catch (e) {}
    vision.timer = null;
    try { if (vision.stream) vision.stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) {} }); } catch (e) {}
    try { if (vision.video) vision.video.srcObject = null; } catch (e) {}
    vision.stream = null; vision.video = null; vision.canvas = null; vision.cctx = null;
    vision.prev = null; vision.ringLen = 0; vision.ringPos = 0;
    vision.lastPresence = false; vision.lastMotion = -1; vision.lastBright = -1; vision.lastEmit = 0;
  }

  // ---------------- GEO: watchPosition → speed / opaque place hash / moved (mirrors RookGeo.java) ----------------
  var geo = { watchId: null, prev: null, lastTag: null, lastSpeed: -1, lastEmit: 0 };
  var G_CELL_DEG = 0.02, G_KEEPALIVE_MS = 30000;

  // FNV-1a of the coarse cell string → a short, stable, non-reversible tag (same algorithm as RookGeo.hash).
  function fnvHash(s) {
    var h = 0x811c9dc5 | 0;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return 'g' + (h >>> 0).toString(16);
  }
  function haversineM(a, b) {   // metres between two {latitude,longitude}
    var R = 6371000, toR = Math.PI / 180;
    var dLat = (b.latitude - a.latitude) * toR, dLng = (b.longitude - a.longitude) * toR;
    var la1 = a.latitude * toR, la2 = b.latitude * toR;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.sin(dLng / 2) * Math.sin(dLng / 2) * Math.cos(la1) * Math.cos(la2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  function geoStart() {
    if (geo.watchId != null) return;
    if (!navigator.geolocation || !navigator.geolocation.watchPosition) return;
    try {
      geo.watchId = navigator.geolocation.watchPosition(geoOnPos, function () { /* denied/unavailable: geo stays off */ },
        { enableHighAccuracy: false, maximumAge: 15000, timeout: 60000 });
    } catch (e) { geo.watchId = null; }
  }
  function geoOnPos(pos) {
    try {
      var c = pos && pos.coords; if (!c) return;
      var now = Date.now();
      // speed: prefer the fix's own speed, else derive from distance/time vs the previous fix. RAW COORDS USED ONLY HERE.
      var speedMs;
      if (typeof c.speed === 'number' && isFinite(c.speed) && c.speed >= 0) speedMs = c.speed;
      else if (geo.prev) {
        var dt = (pos.timestamp - geo.prev.t) / 1000.0;
        speedMs = dt > 0 ? haversineM(geo.prev, { latitude: c.latitude, longitude: c.longitude }) / dt : 0;
      } else speedMs = 0;
      var speed = clamp01(speedMs / 8.0);
      // placeTag: round lat AND lng to ~2km cells and FNV-hash the cell. Raw coords are discarded, NEVER emitted.
      var rlat = Math.round(c.latitude / G_CELL_DEG) * G_CELL_DEG;
      var rlng = Math.round(c.longitude / G_CELL_DEG) * G_CELL_DEG;
      var tag = fnvHash('g' + rlat + ',' + rlng);
      var moved = geo.lastTag == null || tag !== geo.lastTag;
      var sp2 = Math.round(speed * 100) / 100;
      var doEmit = moved || geo.lastSpeed < 0 || Math.abs(sp2 - geo.lastSpeed) > 0.1 || (now - geo.lastEmit) > G_KEEPALIVE_MS;
      geo.prev = { latitude: c.latitude, longitude: c.longitude, t: pos.timestamp };   // held transiently for derived speed only
      if (!doEmit) return;
      geo.lastTag = tag; geo.lastSpeed = sp2; geo.lastEmit = now;
      emit('geo', { speed: sp2, place: tag, moved: moved });   // NO lat/lng — only the opaque tag crosses
    } catch (e) { /* a bad fix just skips */ }
  }
  function geoStop() {
    try { if (geo.watchId != null) navigator.geolocation.clearWatch(geo.watchId); } catch (e) {}
    geo.watchId = null; geo.prev = null; geo.lastTag = null; geo.lastSpeed = -1; geo.lastEmit = 0;
  }

  // ---------------- DEVICE (best-effort desktop presence): IdleDetector, else worker-relayed activity ----------------
  var device = { detector: null, on: false, lastPresence: null, lastEmit: 0, activityUntil: 0, poll: null };
  var D_KEEPALIVE_MS = 4000, D_ACTIVITY_WINDOW_MS = 60000;

  function devicePublish(presence) {
    var now = Date.now();
    if (presence !== device.lastPresence || (now - device.lastEmit) > D_KEEPALIVE_MS) {
      device.lastPresence = presence; device.lastEmit = now;
      emit('device', { presence: !!presence });
    }
  }
  function deviceStart() {
    if (device.on) return; device.on = true;
    // Preferred: the Idle Detection API (permission-gated; needs user activation, which an offscreen doc lacks — so
    // this usually throws and we fall back silently to worker-relayed activity).
    try {
      if (typeof IdleDetector !== 'undefined') {
        var d = new IdleDetector();
        d.addEventListener('change', function () { try { if (device.on) devicePublish(d.userState === 'active'); } catch (e) {} });
        d.start({ threshold: 60000 }).then(function () { device.detector = d; try { devicePublish(d.userState === 'active'); } catch (e) {} })
          .catch(function () { /* no permission/activation: rely on worker-relayed activity */ });
      }
    } catch (e) { /* IdleDetector unavailable: rely on worker-relayed activity */ }
    // Fallback: presence inferred from recent input activity relayed by the worker (see rook-perceive-activity).
    // Only publishes while we have at least one activity ping; if nothing ever arrives, device stays silent.
    device.poll = setInterval(function () {
      if (!device.on) return;
      if (device.activityUntil && Date.now() < device.activityUntil + D_KEEPALIVE_MS) devicePublish(Date.now() < device.activityUntil);
    }, D_KEEPALIVE_MS);
  }
  function deviceStop() {
    device.on = false;
    try { if (device.detector) device.detector.stop && device.detector.stop(); } catch (e) {}
    try { if (device.poll) clearInterval(device.poll); } catch (e) {}
    device.detector = null; device.poll = null; device.lastPresence = null; device.lastEmit = 0; device.activityUntil = 0;
  }

  // ---------------- start/stop dispatch (worker-controlled; nothing auto-starts) ----------------
  var wanted = { vision: false, geo: false, device: false };
  function applyCapture(on, which) {
    var set = { vision: false, geo: false, device: false };
    if (on) { var list = Array.isArray(which) ? which : ['vision', 'geo', 'device']; for (var i = 0; i < list.length; i++) if (set.hasOwnProperty(list[i])) set[list[i]] = true; }
    // vision
    if (set.vision && !wanted.vision) visionStart(); else if (!set.vision && wanted.vision) visionStop();
    // geo
    if (set.geo && !wanted.geo) geoStart(); else if (!set.geo && wanted.geo) geoStop();
    // device
    if (set.device && !wanted.device) deviceStart(); else if (!set.device && wanted.device) deviceStop();
    wanted = set;
  }

  try {
    chrome.runtime.onMessage.addListener(function (m, sender, sendResp) {
      if (!m) return;
      if (m.type === 'rook-perceive-capture-cmd') {
        try { applyCapture(!!m.on, m.which); if (sendResp) sendResp({ ok: true }); } catch (e) { try { if (sendResp) sendResp({ ok: false }); } catch (e2) {} }
        return true;
      }
      if (m.type === 'rook-perceive-activity') {   // worker-relayed input activity → device presence fallback
        try { if (m.active) device.activityUntil = Date.now() + D_ACTIVITY_WINDOW_MS; if (device.on) devicePublish(!!m.active); if (sendResp) sendResp({ ok: true }); } catch (e) {}
        return true;
      }
    });
  } catch (e) {}
})();
