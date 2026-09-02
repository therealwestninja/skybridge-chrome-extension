'use strict';
/* popup.js - Rook's extension control surface. Talks to the background worker only
 * (no inline handlers; MV3 CSP). Shows the focused page's abilities + metadata, lets
 * you set per-site powers + extension settings, and lists newly-discovered pages. */
(function () {
  var $ = function (id) { return document.getElementById(id); };
  function send(msg) { return new Promise(function (res) { try { chrome.runtime.sendMessage(msg, function (r) { res(chrome.runtime.lastError ? null : r); }); } catch (e) { res(null); } }); }
  var CUR = { host: null };

  try { $('ver').textContent = 'v' + chrome.runtime.getManifest().version; } catch (e) {}

  $('open').addEventListener('click', function () { send({ type: 'rook-popup-open' }).then(function () { window.close(); }); });
  // open the persistent SIDE PANEL (next to the page) - must be called in the popup's user gesture
  var op = document.getElementById('open-panel');
  if (op) op.addEventListener('click', function () {
    try {
      if (chrome.sidePanel && chrome.sidePanel.open) {
        chrome.windows.getLastFocused({ windowTypes: ['normal'] }, function (win) {
          if (win && win.id != null) { chrome.sidePanel.open({ windowId: win.id }, function () { if (chrome.runtime.lastError) send({ type: 'rook-popup-open' }); window.close(); }); }
          else send({ type: 'rook-popup-open' }).then(function () { window.close(); });
        });
        return;
      }
    } catch (e) {}
    send({ type: 'rook-popup-open' }).then(function () { window.close(); });
  });

  $('readmeta').addEventListener('click', function () {
    var box = $('meta'); box.style.display = 'block'; box.textContent = 'Reading the page...';
    send({ type: 'rook-popup-readmeta' }).then(function (r) {
      if (!r || !r.ok) { box.textContent = (r && r.reason) || 'Could not read (sensitive site, or no Rook sensor on that tab).'; return; }
      var s = r.structure || {};
      box.textContent =
        'Title: ' + (r.title || '-') +
        '\nDescription: ' + (s.description || '-') +
        (s.site ? '\nSite: ' + s.site : '') +
        '\nHeadings: ' + ((s.headings || []).slice(0, 6).join('  /  ') || '-') +
        '\nLinks: ' + ((r.links || []).length) + '   Words: ~' + Math.round(((r.text || '').match(/\S+/g) || []).length) +
        (r.suspicious ? '\n(!) hidden text detected (' + r.hiddenChars + ' chars) - treat with caution' : '');
    });
  });

  function siteToggle(id, key) { $(id).addEventListener('change', function () { if (!CUR.host) return; var patch = {}; patch[key] = $(id).checked; send({ type: 'rook-popup-site', host: CUR.host, patch: patch }); }); }
  siteToggle('p-trust', 'trust'); siteToggle('p-index', 'index'); siteToggle('p-watch', 'watch'); siteToggle('p-mute', 'mute');

  function setToggle(id, key) { $(id).addEventListener('change', function () { var patch = {}; patch[key] = $(id).checked; send({ type: 'rook-popup-setting', patch: patch }); }); }
  setToggle('s-notify', 'notify'); setToggle('s-pulse', 'pulse');

  // ONE-TIME serial port GRANT for the `serial` cap (the SexCode / OSSM drive). navigator.serial.requestPort()
  // needs a user gesture + a visible document — neither the sandboxed page nor the MV3 worker qualifies, so it
  // lives here in the popup. Once granted, the offscreen doc reaches the port with getPorts() (no gesture). The
  // grant persists for the extension; nothing is opened here — the SexCode backend opens it on Start.
  var cs = $('connect-serial'), csSub = $('serial-sub');
  if (cs) cs.addEventListener('click', function () {
    if (!(navigator.serial && navigator.serial.requestPort)) { if (csSub) csSub.textContent = 'Web Serial is not available in this browser.'; return; }
    if (csSub) csSub.textContent = 'Choose the OSSM port…';
    navigator.serial.requestPort().then(function (port) {
      var info = {}; try { info = port.getInfo() || {}; } catch (e) {}
      if (csSub) csSub.textContent = 'Port granted' + (info.usbVendorId != null ? (' (VID 0x' + Number(info.usbVendorId).toString(16) + ')') : '') + ' — open it from the SexCode drive (Start).';
    }, function (e) {
      if (csSub) csSub.textContent = (e && e.name === 'NotFoundError') ? 'No port selected.' : ('Grant failed: ' + String((e && e.message) || e).slice(0, 80));
    });
  });

  // Settings & Debug: open the extension's own settings page; show the current mouth model.
  $('debug').addEventListener('click', function () { try { chrome.tabs.create({ url: chrome.runtime.getURL('settings.html') }); } catch (e) { try { window.open(chrome.runtime.getURL('settings.html')); } catch (e2) {} } window.close(); });
  // optional Perchance bridge (the web surface) — the local console is the default ("Open Rook" button)
  $('open-perchance').addEventListener('click', function () { send({ type: 'rook-popup-open', target: 'perchance' }).then(function () { window.close(); }); });
  { var hr = $('open-hr'); if (hr) hr.addEventListener('click', function () { try { chrome.tabs.create({ url: chrome.runtime.getURL('hr.html') }); } catch (e) { try { window.open(chrome.runtime.getURL('hr.html')); } catch (e2) {} } window.close(); }); }
  send({ type: 'rook-model-config' }).then(function (r) {
    var sub = $('model-sub'); if (!sub) return;
    var s = r && r.snapshot; if (!s) { sub.textContent = 'unavailable'; return; }
    var o = s.ollama || {}, c = s.config || {};
    sub.textContent = o.reachable ? ('local: ' + (c.resolved || c.model || 'auto')) : 'Ollama offline - using Perchance';
  });

  function render(st) {
    if (!st || !st.ok) { $('host').textContent = 'Extension not responding'; return; }
    var p = st.page;
    if (p && p.host) {
      CUR.host = p.host;
      $('host').textContent = p.host + (p.sensitive ? '  -  sensitive (skipped)' : '');
      $('url').textContent = p.title || p.url || '';
      var chips = $('chips'); chips.textContent = '';
      var abil = p.abilities || [];
      if (abil.length) { abil.forEach(function (a) { var c = document.createElement('span'); c.className = 'chip on'; c.textContent = a; chips.appendChild(c); }); }
      else { var c0 = document.createElement('span'); c0.className = 'chip'; c0.textContent = p.sensitive ? 'sensitive page' : 'no abilities found'; chips.appendChild(c0); }
      $('metarow').style.display = p.sensitive ? 'none' : 'flex';
      $('powersec').style.display = p.sensitive ? 'none' : 'block';
      var sp = st.site || {};
      $('p-trust').checked = !!sp.trust; $('p-index').checked = !!sp.index; $('p-watch').checked = !!sp.watch; $('p-mute').checked = !!sp.mute;
    } else {
      $('host').textContent = 'No page in focus';
      $('url').textContent = 'Focus a normal browser tab, then reopen this panel.';
      $('powersec').style.display = 'none'; $('metarow').style.display = 'none'; $('chips').textContent = '';
    }
    var set = st.settings || {};
    $('s-notify').checked = set.notify !== false;
    $('s-pulse').checked = set.pulse !== false;
    var dl = $('discovered'), disc = st.discovered || [];
    if (!disc.length) { dl.innerHTML = '<div class="empty">Nothing yet. Browse a site with search, login, or a live chat.</div>'; return; }
    dl.textContent = '';
    disc.forEach(function (d) {
      var row = document.createElement('div'); row.className = 'disc';
      var dot = document.createElement('span'); dot.className = 'dot'; row.appendChild(dot);
      var box = document.createElement('div'); box.style.flex = '1';
      var h = document.createElement('div'); h.className = 'dh'; h.textContent = d.host || '(page)';
      var a = document.createElement('div'); a.className = 'da'; a.textContent = (d.abilities || []).join(', ');
      box.appendChild(h); box.appendChild(a); row.appendChild(box);
      dl.appendChild(row);
    });
  }

  send({ type: 'rook-popup-state' }).then(render);
})();
