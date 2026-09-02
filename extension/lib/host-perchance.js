'use strict';
/* host-perchance.js - Rook's Perchance / AI-Character-Chat host adapter.
 *
 * Makes Rook behave like the Memory-Hero fork from OUTSIDE the sandbox: recall from
 * the LIVE memory source, steer the host model by writing readable fields it reads,
 * generate images through the top-panel plugin, and resolve the AICC DOM. Grounded in
 * docs/perchance-integration-surface.md.
 *
 * The pure cores (recallFromMessages, sanitizeImagePrompt, composeSteer, learnedBlock)
 * are exported separately so they can be unit-tested without a live page. The live
 * wiring (DB open, plugin calls, DOM) is best-effort and degrades to no-ops off-host.
 */
(function (root) {
  var W = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : root;   // page globals in a userscript
  var DB_NAME = 'chatbot-ui-v1';
  var STEER_PHRASE = 'Direction for your next reply:';
  var LEARNED_HEADING = '# Notes the story has gathered';

  // ---------------------------------------------------------------- pure cores
  // Recall the SAME sources the host prompt uses: memoriesEndingHere + the highest
  // summariesEndingHere per message. (db.memories is dead here - never read it.)
  function recallFromMessages(messages) {
    var memories = [], summary = '';
    (messages || []).forEach(function (m) {
      var meh = m && m.memoriesEndingHere;
      if (meh) Object.keys(meh).forEach(function (lvl) {
        (meh[lvl] || []).forEach(function (e) { if (e && e.text) memories.push(e.text); });
      });
      var seh = m && m.summariesEndingHere;
      if (seh) {
        var levels = Object.keys(seh).map(Number).filter(function (n) { return !isNaN(n); });
        if (levels.length) { var top = Math.max.apply(null, levels); if (seh[top]) summary = seh[top]; }
      }
    });
    // de-dupe memories, keep order
    var seen = {}, uniq = [];
    memories.forEach(function (t) { if (!seen[t]) { seen[t] = 1; uniq.push(t); } });
    return { memories: uniq, summary: summary };
  }

  // Sanitize an image prompt for Perchance's DSL + the SD backend (see sec6 of the surface).
  function sanitizeImagePrompt(p) {
    var s = String(p == null ? '' : p);
    s = s.replace(/\[([^\]]*)\]/g, '$1');     // strip A1111 [..] - eaten by the DSL parser
    s = s.replace(/[{}]/g, ' ');              // braces are DSL tokens
    s = s.replace(/\s+/g, ' ').trim();
    if (!s) s = 'a portrait, soft light';     // empty/inline-only prompts hang forever
    return s;
  }

  // The steer the host model will read. Written into reminderMessage after STEER_PHRASE;
  // no HTML-comment markers (they leak to the model). Optionally framed as an impulse.
  function composeSteer(charName, directive, opts) {
    if (!directive) return '';
    opts = opts || {};
    if (opts.impulse) {
      return 'IN-CHARACTER IMPULSE for ' + (charName || 'this character') + ' this turn: ' + directive +
        " Let this pull surface through " + (charName || 'their') + "'s actions, voice, and choices - show it, don't announce it.";
    }
    return STEER_PHRASE + ' ' + directive;
  }

  // Vision: rebuild a Blob from a dataURL that crossed a postMessage boundary as a string.
  // Returns null on a malformed dataURL (caller falls back to text-only). Works in a window
  // or a worker (atob + Blob are both available). ONE image per mouth call (plugin enforces it).
  function dataUrlToBlob(dataUrl) {
    var s = String(dataUrl == null ? '' : dataUrl);
    var m = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(s);
    if (!m) return null;
    var mime = m[1] || 'image/png', isB64 = !!m[2], data = m[3];
    try {
      if (isB64) {
        var bin = atob(data), len = bin.length, arr = new Uint8Array(len);
        for (var i = 0; i < len; i += 1) arr[i] = bin.charCodeAt(i);
        return new Blob([arr], { type: mime });
      }
      // A non-base64 data URL would need latin1 byte handling, not a UTF-8 string (decodeURIComponent
      // corrupts binary). The vision path only ever carries base64 image data URLs, so treat the rest as unusable.
      return null;
    } catch (e) { return null; }
  }
  var MOUTH_IMG_MIME = { 'image/png': 1, 'image/jpeg': 1, 'image/webp': 1 };   // aiTextPlugin vision accepts only these
  var MOUTH_IMG_MAX = 20 * 1024 * 1024;                                        // ...and rejects >20MB pre-encode

  // Build the aiTextPlugin `instruction` argument: a plain string, or (when an image rides along)
  // the [text, Blob] array the plugin's vision path expects. Bad/absent image -> text-only (no throw).
  function mouthInstruction(text, imageDataUrl) {
    var t = String(text == null ? '' : text);
    if (!imageDataUrl) return t;
    var blob = dataUrlToBlob(imageDataUrl);
    // enforce aiTextPlugin's vision contract client-side (one png/jpeg/webp image, <=20MB); anything else -> text-only
    if (!blob || !MOUTH_IMG_MIME[blob.type] || blob.size > MOUTH_IMG_MAX) return t;
    return [t, blob];
  }

  function learnedBlock(facts) {
    var f = (facts || []).filter(Boolean);
    if (!f.length) return '';
    return LEARNED_HEADING + '\n' + f.map(function (x) { return '- ' + x; }).join('\n');
  }

  // strip any prior steer/learned block so we never double-append
  function stripSteer(reminder) {
    var s = String(reminder || ''); var i = s.indexOf(STEER_PHRASE);
    return (i < 0 ? s : s.slice(0, i)).trim();
  }
  function stripLearned(role) {
    var s = String(role || ''); var i = s.indexOf(LEARNED_HEADING);
    return (i < 0 ? s : s.slice(0, i)).trim();
  }

  // ---------------------------------------------------------------- live wiring
  function detect() {
    try {
      var h = (root.location && root.location.hostname || '').toLowerCase();
      if (h.indexOf('perchance.org') < 0) return false;
      return !!(W.activeThreadId || W.currentChatId) || hasDB();
    } catch (e) { return false; }
  }
  function hasDB() { try { return !!(W.Dexie || (root.indexedDB)); } catch (e) { return false; } }
  function activeThreadId() { try { return W.activeThreadId || W.currentChatId || null; } catch (e) { return null; } }

  function openDB() {
    return new Promise(function (resolve, reject) {
      try {
        if (W.Dexie) { var d = new W.Dexie(DB_NAME); d.open().then(function () { resolve(d); }, reject); return; }
        var req = root.indexedDB.open(DB_NAME);
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      } catch (e) { reject(e); }
    });
  }

  // read this thread's messages (Dexie or raw IDB), then recall from them
  function recall(threadId) {
    threadId = threadId || activeThreadId();
    return openDB().then(function (db) {
      if (W.Dexie && db.messages) {
        return db.messages.where('threadId').equals(threadId).toArray();
      }
      return new Promise(function (res) {
        try {
          var tx = db.transaction('messages', 'readonly'); var out = [];
          var idx = tx.objectStore('messages').index('threadId');
          idx.openCursor(threadId).onsuccess = function (e) { var c = e.target.result; if (c) { out.push(c.value); c.continue(); } else res(out); };
        } catch (e) { res([]); }
      });
    }).then(function (msgs) {
      var r = recallFromMessages(msgs);
      // lore: best-effort by thread.loreBookId (defaults to threadId)
      return r;
    }).catch(function () { return { memories: [], summary: '' }; });
  }

  // write the council's directive where the host model reads it
  function writeSteer(directive, opts) {
    return openDB().then(function (db) {
      if (!(W.Dexie && db.characters)) return false;
      var tid = activeThreadId();
      return db.threads.get(tid).then(function (thread) {
        if (!thread) return false;
        return db.characters.get(thread.characterId).then(function (ch) {
          if (!ch) return false;
          var base = stripSteer(ch.reminderMessage);
          ch.reminderMessage = (base ? base + '\n\n' : '') + composeSteer(ch.name, directive, opts);
          return db.characters.put(ch).then(function () { return true; });
        });
      });
    }).catch(function () { return false; });
  }

  // generate an image through the top-panel plugin; returns a dataUrl
  function generateImage(prompt) {
    var p = sanitizeImagePrompt(prompt);
    return new Promise(function (resolve, reject) {
      try {
        var plugin = W.textToImagePlugin || (W.root && W.root.textToImagePlugin);
        if (typeof plugin !== 'function') return reject(new Error('textToImagePlugin unavailable'));
        Promise.resolve(plugin({ prompt: p })).then(function (r) {
          // boxed String - extract .dataUrl; never use the object as a URL
          var url = (r && r.dataUrl) ? String(r.dataUrl) : String(r || '');
          resolve(url);
        }, reject);
      } catch (e) { reject(e); }
    });
  }

  function dom() {
    var doc = root.document;
    return {
      feed: doc.getElementById('chatMessagesEl') || doc.getElementById('messageFeed'),
      messageTextSel: '.messageText, .content',
      input: doc.querySelector('textarea'),
    };
  }

  root.RookHostPerchance = {
    // pure (testable)
    recallFromMessages: recallFromMessages,
    sanitizeImagePrompt: sanitizeImagePrompt,
    composeSteer: composeSteer,
    learnedBlock: learnedBlock,
    dataUrlToBlob: dataUrlToBlob,
    mouthInstruction: mouthInstruction,
    stripSteer: stripSteer,
    stripLearned: stripLearned,
    // live
    name: 'perchance',
    detect: detect,
    activeThreadId: activeThreadId,
    openDB: openDB,
    recall: recall,
    writeSteer: writeSteer,
    generateImage: generateImage,
    dom: dom,
    DB_NAME: DB_NAME,
  };
})(typeof self !== 'undefined' ? self : this);
