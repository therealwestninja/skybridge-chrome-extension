'use strict';
/* page-sensor.js — Rook's headless presence on a page (no UI). Replaces the on-page console's
 * discovery scan after the move to the popup window. Two jobs:
 *   1) On load, do a light STRUCTURAL scan (what affordances exist — search/login/live-chat) and
 *      report it to the background so the toolbar BADGE can invite opt-in. Metadata only, NEVER content.
 *   2) Answer the background's read / watch requests — but only on explicit request (the brain decides,
 *      deny-by-default; nothing is read or streamed until Rook asks, which it only does on your opt-in).
 * Sensitive hosts (bank/login/mail/…) are skipped entirely.
 */
(function () {
  if (window.top !== window) return;                 // top frame only
  if (window.__rookSensor) return; window.__rookSensor = true;

  // ---- sensitive-host guard (mirrors the console's deny list) ----
  var SENSITIVE = /(^|\.)(bank|paypal|venmo|coinbase|metamask|wallet|1password|lastpass|bitwarden)\.|irs\.gov|mail\.google|outlook\.live|webmail|\/login|sign-?in|\/account|\/checkout|\/billing|patient|medical/i;
  function sensitive() { try { return SENSITIVE.test(location.href); } catch (e) { return true; } }

  // ---- detect a rolling chat feed (Discord / Twitch / YouTube / generic) ----
  function chatFeed() {
    var sels = ['[data-a-target="chat-scroller"]', 'yt-live-chat-item-list-renderer #items', '[class*="chatLog"]', '[class*="messageListItem"]', 'ol[class*="scrollerInner"]', '[class*="chat-line"]', '[role="log"]', '[aria-live="polite"][role="log"]'];
    for (var i = 0; i < sels.length; i++) { try { var el = document.querySelector(sels[i]); if (el && el.children && el.children.length) return el; } catch (e) {} }
    return null;
  }

  // ---- structural ability scan: metadata only (no page content) ----
  function abilities() {
    if (sensitive()) return [];
    var a = [];
    try {
      if (document.querySelector('input[type="search"], [role="search"], input[name="q"], input[placeholder*="search" i]')) a.push('search');
      if (document.querySelector('input[type="password"]')) a.push('login');
      if (chatFeed()) a.push('livechat');
    } catch (e) {}
    return a;
  }

  function report() {
    try { chrome.runtime.sendMessage({ type: 'rook-sensor', url: location.href, host: location.hostname, title: document.title, sensitive: sensitive(), abilities: abilities() }); } catch (e) {}
  }
  report();                                            // on load
  setTimeout(report, 1500); setTimeout(report, 4500);  // again as the page lazy-loads (SPAs, live feeds)

  // ---- human-visibility filter (anti hidden-text injection) ----
  // A hostile page can hide text from PEOPLE but not from a naive reader: colour matched to the
  // background, 1px fonts, opacity:0, off-screen, clipped, or aria-hidden — then smuggle instructions
  // to the bot. We read only what a person could actually SEE, and flag pages carrying a lot of hidden
  // text (a manipulation / prompt-injection signal). innerText already drops display:none / visibility:
  // hidden; this catches the rest.
  function _rgb(s) { var m = String(s || '').match(/-?\d+(\.\d+)?/g); return m ? { r: +m[0], g: +m[1], b: +m[2], a: m[3] != null ? +m[3] : 1 } : null; }
  function _lum(c) { return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b; }
  function _bgOf(el) { var n = el; while (n && n.nodeType === 1) { try { var b = _rgb(getComputedStyle(n).backgroundColor); if (b && b.a > 0.3) return b; } catch (e) {} n = n.parentElement; } return { r: 255, g: 255, b: 255, a: 1 }; }
  function _hidden(el, cs) {
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return true;
    if (parseFloat(cs.opacity) < 0.1) return true;                                   // opacity:0
    if (parseFloat(cs.fontSize) < 6) return true;                                    // 1px / tiny text
    if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return true;
    try { if (el.offsetWidth === 0 && el.offsetHeight === 0 && el.getClientRects().length === 0) return true; } catch (e) {}   // clipped / zero-size
    try { var r = el.getBoundingClientRect(); if ((r.width || r.height) && (r.right < -64 || r.bottom < -64 || r.left > (document.documentElement.clientWidth || 0) + 4096)) return true; } catch (e) {}   // shoved off-screen
    var fg = _rgb(cs.color); if (fg) { if (fg.a < 0.1) return true; if (Math.abs(_lum(fg) - _lum(_bgOf(el))) < 16) return true; }   // text colour ≈ background → invisible
    return false;
  }
  function visibleText(rootEl) {
    var out = [], seen = 0, CAP = 9000;   // bound the walk on huge pages
    (function walk(el) {
      if (seen++ > CAP || !el) return;
      var cs; try { cs = getComputedStyle(el); } catch (e) { return; }
      if (_hidden(el, cs)) return;        // prune the whole subtree — nothing under a hidden node is read
      for (var i = 0; i < el.childNodes.length; i++) {
        var n = el.childNodes[i];
        if (n.nodeType === 3) { var t = n.nodeValue; if (t && t.trim()) out.push(t); }
        else if (n.nodeType === 1) { var tag = n.tagName; if (tag !== 'SCRIPT' && tag !== 'STYLE' && tag !== 'NOSCRIPT' && tag !== 'TEMPLATE') walk(n); }
      }
    })(rootEl);
    return out.join(' ').replace(/\s+/g, ' ').trim();
  }

  // ---- read the page on request (content) — only ever called by the background on Rook's behalf ----
  function readPage() {
    var main, vis = '', rawLen = 0;
    try { main = document.querySelector('article, main, [role="main"]') || document.body; } catch (e) { main = document.body; }
    try { vis = visibleText(main); } catch (e) {}
    try { rawLen = ((main && main.innerText) || '').replace(/\s+/g, ' ').trim().length; } catch (e) {}   // innerText catches the sneaky tricks; visibleText drops them → the gap is hidden text
    var hidden = Math.max(0, rawLen - vis.length);
    var suspicious = hidden > 240 && rawLen > 0 && (hidden / rawLen) > 0.25;   // a lot of human-invisible text → likely manipulation
    var links = [];
    try { links = [].slice.call(document.querySelectorAll('a[href]')).slice(0, 60).map(function (a) { return { t: (a.textContent || '').trim().slice(0, 80), href: a.href }; }).filter(function (l) { return l.t; }); } catch (e) {}
    // STRUCTURE for cognition (cheap, visible-only): headings + meta give the eyes shape, not just a text blob
    var meta = function (s) { try { var el = document.querySelector(s); return el ? (el.getAttribute('content') || '').trim().slice(0, 300) : ''; } catch (e) { return ''; } };
    var headings = [];
    try { headings = [].slice.call(document.querySelectorAll('h1, h2')).slice(0, 12).map(function (h) { return (h.textContent || '').trim().slice(0, 100); }).filter(Boolean); } catch (e) {}
    var structure = { description: meta('meta[name="description"]') || meta('meta[property="og:description"]'), site: meta('meta[property="og:site_name"]'), type: meta('meta[property="og:type"]'), headings: headings };
    return { ok: true, url: location.href, title: document.title, text: vis.slice(0, 20000), links: links, structure: structure, hiddenChars: hidden, suspicious: suspicious };
  }

  // ---- watch a live chat feed: stream only NEW lines up to the background ----
  var watcher = null, lastN = 0;
  function watchChat() {
    var feed = chatFeed(); if (!feed) return { ok: false, reason: 'no chat feed found' };
    if (watcher) { try { watcher.disconnect(); } catch (e) {} }
    lastN = feed.children.length;
    watcher = new MutationObserver(function () {
      var kids = feed.children, n = kids.length; if (n <= lastN) { lastN = n; return; }
      var fresh = [];
      for (var i = Math.max(lastN, n - 12); i < n; i++) { var line = (kids[i] ? visibleText(kids[i]) : '').slice(0, 280); if (line) fresh.push(line); }   // visibleText drops hidden-text smuggled into a chat line
      lastN = n;
      if (fresh.length) { try { chrome.runtime.sendMessage({ type: 'rook-chat', host: location.hostname, lines: fresh }); } catch (e) {} }
    });
    try { watcher.observe(feed, { childList: true, subtree: true }); } catch (e) { return { ok: false, reason: 'observe failed' }; }
    return { ok: true };
  }
  function unwatch() { if (watcher) { try { watcher.disconnect(); } catch (e) {} watcher = null; } return { ok: true }; }

  // --- chat adapters: one per platform, pure DOM, run in the page context ---
  var CHAT_ADAPTERS = [
    {
      id: 'discord',
      match: function () { return /(^|\.)discord\.com$/.test(location.hostname); },
      readRecent: function (n) {
        var out = [], nodes = document.querySelectorAll('li[id^="chat-messages-"]');
        for (var i = Math.max(0, nodes.length - (n || 30)); i < nodes.length; i++) {
          var el = nodes[i];
          var un = el.querySelector('[class*="username"]');
          var bd = el.querySelector('[id^="message-content-"]');
          var user = (un ? un.textContent : '') || '', text = (bd ? bd.textContent : '') || '';
          if (text) out.push({ user: ('' + user).replace(/^\s+|\s+$/g, ''), text: ('' + text).replace(/^\s+|\s+$/g, ''), at: Date.now() });
        }
        return out;
      },
      findInput: function () { return document.querySelector('div[role="textbox"][data-slate-editor="true"]'); },
      type: function (text) {
        var box = this.findInput(); if (!box) return false;
        box.focus();
        box.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
        try { if (!box.textContent) document.execCommand('insertText', false, text); } catch (e) {}
        return true;
      },
      send: function () {
        var box = this.findInput(); if (!box) return false;
        var ev = { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 };
        box.dispatchEvent(new KeyboardEvent('keydown', ev)); box.dispatchEvent(new KeyboardEvent('keyup', ev));
        return true;
      }
    }
  ];
  function activeChatAdapter() { for (var i = 0; i < CHAT_ADAPTERS.length; i++) { try { if (CHAT_ADAPTERS[i].match()) return CHAT_ADAPTERS[i]; } catch (e) {} } return null; }

  chrome.runtime.onMessage.addListener(function (m, sender, send) {
    if (!m) return;
    if (m.type === 'rook-read') { if (sensitive()) { send({ ok: false, reason: 'sensitive host' }); } else { send(readPage()); } return true; }
    if (m.type === 'rook-watch') { send(sensitive() ? { ok: false, reason: 'sensitive host' } : watchChat()); return true; }
    if (m.type === 'rook-unwatch') { send(unwatch()); return true; }
    if (m.type === 'rook-rescan') { report(); send({ ok: true }); return true; }
    if (m.type === 'rook-chat-read') { var a1 = activeChatAdapter(); send({ ok: !!a1, surface: a1 && a1.id, messages: a1 ? a1.readRecent(m.n || 30) : [] }); return true; }
    if (m.type === 'rook-chat-type') { var a2 = activeChatAdapter(); send({ ok: !!(a2 && a2.type(String(m.text || ''))) }); return true; }
    if (m.type === 'rook-chat-send') { var a3 = activeChatAdapter(); if (a3 && m.text != null) a3.type(String(m.text)); send({ ok: !!(a3 && a3.send()) }); return true; }
  });
})();
