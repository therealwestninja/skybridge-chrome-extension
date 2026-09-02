'use strict';
/* settings.js — Rook's Settings panel (model picker + notifications + per-site powers + safety +
 * backup/import + an Advanced/Debug stack-test surface). Talks to the background worker only.
 * No inline handlers (MV3 CSP). */
(function () {
  var $ = function (id) { return document.getElementById(id); };
  function send(msg) { return new Promise(function (res) { try { chrome.runtime.sendMessage(msg, function (r) { res(chrome.runtime.lastError ? null : r); }); } catch (e) { res(null); } }); }
  function fmtTime(t) { try { return new Date(t).toLocaleTimeString(); } catch (e) { return '' + t; } }
  var LAST = null;
  try { $('ver').textContent = 'v' + chrome.runtime.getManifest().version; } catch (e) {}

  // ---------- Advanced/Debug: stack tests ----------
  function renderChecks(checks) {
    var box = $('checks'); box.innerHTML = '';
    var counts = { ok: 0, warn: 0, fail: 0, skip: 0 };
    (checks || []).forEach(function (c) {
      counts[c.status] = (counts[c.status] || 0) + 1;
      var row = document.createElement('div'); row.className = 'chk ' + c.status;
      var dot = document.createElement('span'); dot.className = 'dot'; row.appendChild(dot);
      var b = document.createElement('div'); b.className = 'body';
      var lab = document.createElement('div'); lab.className = 'lab'; lab.textContent = c.label; b.appendChild(lab);
      var det = document.createElement('div'); det.className = 'det'; det.textContent = c.detail; b.appendChild(det);
      if (c.fix) { var fx = document.createElement('div'); fx.className = 'fix'; fx.textContent = '→ ' + c.fix; b.appendChild(fx); }
      row.appendChild(b);
      if (c.ms) { var ms = document.createElement('span'); ms.className = 'ms'; ms.textContent = c.ms + 'ms'; row.appendChild(ms); }
      box.appendChild(row);
    });
    var s = $('summary');
    if (!checks || !checks.length) { s.textContent = 'no results'; s.style.color = 'var(--mut)'; return; }
    s.textContent = counts.ok + ' ok' + (counts.warn ? '  ·  ' + counts.warn + ' warn' : '') + (counts.fail ? '  ·  ' + counts.fail + ' FAIL' : '') + (counts.skip ? '  ·  ' + counts.skip + ' skipped' : '');
    s.style.color = counts.fail ? 'var(--bad)' : counts.warn ? 'var(--warn)' : 'var(--good)';
  }

  function renderSnapshot(snap) {
    if (!snap) { $('summary').textContent = 'worker not responding'; return; }
    LAST = snap;
    var cfg = snap.config || {}, oll = snap.ollama || {};
    renderChecks(snap.checks);
    if (document.activeElement !== $('provider')) $('provider').value = cfg.provider || 'ollama';
    gateProvider($('provider').value);
    if (document.activeElement !== $('endpoint')) $('endpoint').value = cfg.endpoint || '';
    var sel = $('model'), want = (cfg.model === '(auto)' || !cfg.model) ? '' : cfg.model;
    if (document.activeElement !== sel) {
      sel.innerHTML = '';
      var optAuto = document.createElement('option'); optAuto.value = ''; optAuto.textContent = 'Auto - first installed' + (oll.reachable && oll.models && oll.models[0] ? ' (' + oll.models[0] + ')' : ''); sel.appendChild(optAuto);
      (oll.models || []).forEach(function (m) { var o = document.createElement('option'); o.value = m; o.textContent = m; sel.appendChild(o); });
      if (want && (oll.models || []).indexOf(want) < 0) { var o2 = document.createElement('option'); o2.value = want; o2.textContent = want + ' (not installed)'; sel.appendChild(o2); }
      sel.value = want;
    }
    $('extid').textContent = snap.extId ? ('extension id: ' + snap.extId + '   (allowlist with OLLAMA_ORIGINS=chrome-extension://' + snap.extId + ')') : '';
    var rp = $('reach'); rp.className = 'pill ' + (oll.reachable ? 'on' : 'off'); $('reach-txt').textContent = oll.reachable ? 'server reachable' : ('server unreachable' + (oll.error ? ' - ' + oll.error : ''));
    var resv = $('resolved'); resv.className = 'pill ' + (cfg.resolved ? 'on' : 'off'); resv.textContent = 'model: ' + (cfg.resolved || cfg.model || '-');
    $('kv').innerHTML = '';
    [['provider', cfg.provider], ['endpoint', cfg.endpoint], ['configured', cfg.model], ['resolved', cfg.resolved || '(pending)'], ['installed', (oll.models || []).length + ' model(s)']].forEach(function (r) {
      var d = document.createElement('div'); var b = document.createElement('b'); b.textContent = r[0]; d.appendChild(b); d.appendChild(document.createTextNode(' ' + (r[1] == null ? '-' : r[1]))); $('kv').appendChild(d);
    });
    var ins = $('installed'); ins.innerHTML = '';
    (oll.models || []).forEach(function (m) { var c = document.createElement('span'); c.className = 'chip'; c.textContent = m; ins.appendChild(c); });
    var log = $('log'); log.innerHTML = '';
    var rows = (snap.log || []).slice().reverse();
    if (!rows.length) { log.textContent = '(no activity yet)'; }
    else rows.forEach(function (e) {
      var line = document.createElement('div'); if (e.level === 'error') line.className = 'err';
      var t = document.createElement('span'); t.className = 't'; t.textContent = fmtTime(e.t) + '  ';
      line.appendChild(t); line.appendChild(document.createTextNode(e.msg || '')); log.appendChild(line);
    });
  }
  function diagnose() { $('summary').textContent = 'running...'; $('summary').style.color = 'var(--mut)'; return send({ type: 'rook-ext-diagnose' }).then(function (r) { renderSnapshot(r && r.snapshot); }); }
  $('run').addEventListener('click', diagnose);

  // ---------- Model ----------
  function gateProvider(p) {   // Perchance is borrowed via relay -> no endpoint/model fields
    var per = (p === 'perchance');
    $('row-endpoint').style.display = per ? 'none' : 'flex';
    $('row-model').style.display = per ? 'none' : 'flex';
    $('perchance-note').style.display = per ? 'block' : 'none';
  }
  $('provider').addEventListener('change', function () { gateProvider($('provider').value); });
  $('open-bench').addEventListener('click', function () { try { chrome.tabs.create({ url: chrome.runtime.getURL('game-bench.html') }); } catch (e) { try { window.open(chrome.runtime.getURL('game-bench.html')); } catch (e2) {} } });
  function saveCfg() { return send({ type: 'rook-model-config', patch: { provider: $('provider').value, endpoint: $('endpoint').value.trim() || 'http://127.0.0.1:11434', model: $('model').value } }); }
  $('save').addEventListener('click', function () { $('saved').textContent = 'saving...'; saveCfg().then(function () { $('saved').textContent = 'saved ✓'; diagnose(); setTimeout(function () { $('saved').textContent = ''; }, 1600); }); });
  $('test').addEventListener('click', function () {
    var box = $('pingbox'); box.style.display = 'block'; box.className = 'pingbox'; box.textContent = 'saving + pinging this model... (a big model can take up to ~60s)';
    $('test').disabled = true; $('save').disabled = true;
    saveCfg().then(function () { return send({ type: 'rook-ext-ping-model' }); }).then(function (r) {
      $('test').disabled = false; $('save').disabled = false;
      if (!r) { box.className = 'pingbox bad'; box.textContent = 'no response from the worker'; return; }
      if (r.ok) { box.className = 'pingbox ok'; box.textContent = '✓ ' + r.model + ' replied in ' + r.ms + 'ms: "' + r.reply + '"'; }
      else { box.className = 'pingbox bad'; box.textContent = '✗ ' + (r.cause || ('failed after ' + r.ms + 'ms')) + (r.status ? ' (HTTP ' + r.status + ')' : ''); if (r.fix) { var f = document.createElement('span'); f.className = 'fix'; f.textContent = '→ ' + r.fix; box.appendChild(f); } }
      diagnose();
    });
  });

  // ---------- Notifications ----------
  function setToggle(id, key) { $(id).addEventListener('change', function () { var patch = {}; patch[key] = $(id).checked; send({ type: 'rook-popup-setting', patch: patch }); }); }
  setToggle('s-notify', 'notify'); setToggle('s-pulse', 'pulse');

  // ---------- Per-site powers ----------
  function renderSites(sites) {
    var box = $('sites'); box.innerHTML = ''; var hosts = Object.keys(sites || {});
    if (!hosts.length) { box.innerHTML = '<div class="empty">No per-site powers set yet.</div>'; return; }
    hosts.sort().forEach(function (h) {
      var sp = sites[h] || {}, on = Object.keys(sp).filter(function (k) { return sp[k]; });
      var row = document.createElement('div'); row.className = 'siterow';
      var hd = document.createElement('span'); hd.className = 'h'; hd.textContent = h; row.appendChild(hd);
      var p = document.createElement('span'); p.className = 'p'; p.textContent = on.length ? on.join(', ') : '(none)'; row.appendChild(p);
      var rm = document.createElement('button'); rm.className = 'ghost'; rm.textContent = 'Remove'; rm.addEventListener('click', function () { send({ type: 'rook-site-remove', host: h }).then(function (r) { renderSites((r && r.sites) || {}); }); });
      row.appendChild(rm); box.appendChild(row);
    });
  }
  function loadSites() { send({ type: 'rook-sites-all' }).then(function (r) { renderSites((r && r.sites) || {}); }); }

  // ---------- Safety ----------
  function renderVerify(v) {
    v = v || {}; $('verify').innerHTML = '';
    [['blocked (synced)', v.rejected], ['verified (synced)', v.verified], ['your local blocks', v.localBlock], ['your local trust', v.localTrust], ['local-only mode', v.localOnly ? 'on' : 'off']].forEach(function (r) {
      var d = document.createElement('div'); var b = document.createElement('b'); b.textContent = r[0]; d.appendChild(b); d.appendChild(document.createTextNode(' ' + (r[1] == null ? 0 : r[1]))); $('verify').appendChild(d);
    });
  }
  function loadVerify() { send({ type: 'rook-verify' }).then(function (r) { renderVerify(r && r.verify); }); }
  $('clear-block').addEventListener('click', function () { $('verify-msg').textContent = 'clearing...'; send({ type: 'rook-verify', clear: 'localBlock' }).then(function (r) { renderVerify(r && r.verify); $('verify-msg').textContent = 'cleared ✓'; setTimeout(function () { $('verify-msg').textContent = ''; }, 1500); }); });
  $('clear-trust').addEventListener('click', function () { $('verify-msg').textContent = 'clearing...'; send({ type: 'rook-verify', clear: 'localTrust' }).then(function (r) { renderVerify(r && r.verify); $('verify-msg').textContent = 'cleared ✓'; setTimeout(function () { $('verify-msg').textContent = ''; }, 1500); }); });

  // ---------- Backup / export / import ----------
  function readLocalRook() { var o = {}; try { for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (k && k.indexOf('rook:') === 0) o[k] = localStorage.getItem(k); } } catch (e) {} return o; }
  function download(name, obj) {
    try {
      var blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob); var a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1500);
    } catch (e) { $('backup-msg').textContent = 'download failed'; }
  }
  $('export').addEventListener('click', function () {
    $('backup-msg').textContent = 'building...';
    send({ type: 'rook-ext-backup' }).then(function (r) {
      var b = (r && r.backup) || { kind: 'rook-backup', chrome: {} };
      b.local = readLocalRook();
      var d = new Date(), name = 'rook-backup-' + d.getFullYear() + ('0' + (d.getMonth() + 1)).slice(-2) + ('0' + d.getDate()).slice(-2) + '.json';
      download(name, b); $('backup-msg').textContent = 'exported ✓'; setTimeout(function () { $('backup-msg').textContent = ''; }, 1800);
    });
  });
  $('import-btn').addEventListener('click', function () { $('import-file').click(); });
  $('import-file').addEventListener('change', function (ev) {
    var f = ev.target.files && ev.target.files[0]; if (!f) return;
    var rd = new FileReader();
    rd.onload = function () {
      var obj; try { obj = JSON.parse(rd.result); } catch (e) { $('backup-msg').textContent = 'invalid JSON'; return; }
      if (!obj || obj.kind !== 'rook-backup') { if (!window.confirm('This file is not a recognised Rook backup. Import anyway?')) { ev.target.value = ''; return; } }
      if (!window.confirm('Restore this backup? It overwrites matching Rook keys (settings, memory, per-site, model config).')) { ev.target.value = ''; return; }
      $('backup-msg').textContent = 'restoring...';
      // local console state (localStorage rook:*) first, then chrome.storage via the worker
      try { var loc = obj.local || {}; for (var k in loc) { if (k.indexOf('rook:') === 0) localStorage.setItem(k, loc[k]); } } catch (e) {}
      send({ type: 'rook-ext-restore', data: obj.chrome || obj }).then(function (r) {
        ev.target.value = '';
        if (r && r.ok) { $('backup-msg').textContent = 'restored ' + r.restored + ' key(s) ✓ — reopen the console'; diagnose(); loadSites(); loadVerify(); }
        else { $('backup-msg').textContent = 'restore failed: ' + ((r && r.reason) || 'unknown'); }
      });
    };
    rd.readAsText(f);
  });

  $('copy').addEventListener('click', function () {
    var report = 'Rook settings/debug\n' + new Date().toISOString() + '\n' + JSON.stringify(LAST, null, 2);
    try { navigator.clipboard.writeText(report).then(function () { $('copied').textContent = 'copied ✓'; }, function () { $('copied').textContent = 'copy failed'; }); } catch (e) { $('copied').textContent = 'copy failed'; }
    setTimeout(function () { $('copied').textContent = ''; }, 1800);
  });

  // ---------- init ----------
  send({ type: 'rook-popup-state' }).then(function (st) { var set = (st && st.settings) || {}; $('s-notify').checked = set.notify !== false; $('s-pulse').checked = set.pulse !== false; });
  loadSites(); loadVerify(); diagnose();
  setInterval(function () { if ($('advanced').open) diagnose(); }, 6000);
})();
