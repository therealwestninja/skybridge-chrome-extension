'use strict';
/* adapter-perchance.js - model + image adapters for when Rook IS a Perchance
 * generator (perchance.org/rook-ai). The brain decides; Perchance's own
 * aiTextPlugin writes the words and textToImagePlugin draws - free, on-platform,
 * no install, any device. Same adapter shape as OllamaAdapter, so the SAME
 * RookConsole + brain run here and in the standalone demo unchanged.
 *
 * DSL-SAFE: this file is embedded in a Perchance HTML panel, whose raw source is
 * scanned by the platform preprocessor before any JS runs. So the AICC name
 * brackets and any braces that must appear in string output are built from hex
 * escapes (\x5b etc.), never typed literally - otherwise the preprocessor parses
 * them as DSL list/bracket tokens.
 */
(function (root) {
  var W = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : root;
  var LB = '\x5b\x5b', RB = '\x5d\x5d';                       // the AICC name brackets, hex-built (no literal tokens)
  function textPlugin() { return (W.root && W.root.aiTextPlugin) || W.aiTextPlugin; }
  function imagePlugin() { return (W.root && W.root.textToImagePlugin) || W.textToImagePlugin; }

  // messages -> a single AICC-style instruction string for aiTextPlugin
  function messagesToInstruction(messages, charName) {
    var sys = '', lines = [];
    (messages || []).forEach(function (m) {
      if (m.role === 'system') sys = m.content;
      else if (m.role === 'user') lines.push(LB + 'User' + RB + ': ' + m.content);
      else lines.push(LB + (charName || 'Rook') + RB + ': ' + m.content);
    });
    return (sys ? sys + '\n\n' : '') +
      '<MESSAGES>\n' + lines.join('\n\n') + '\n</MESSAGES>\n\n' +
      'Write the next message for ' + LB + (charName || 'Rook') + RB + '.';
  }

  // R25 A3: the broker is COLD (~4.6s) on first hit, WARM (~0.9s) after. Fire one throwaway
  // generation early and stop it immediately, so the user's first real turn is already warm.
  var _warmed = false;
  function warmUp() {
    if (_warmed) return; _warmed = true;
    var fn = textPlugin(); if (typeof fn !== 'function') { _warmed = false; return; }
    try { var h = fn({ instruction: 'hi', startWith: '', stopSequences: ['\n'] }); Promise.resolve(h).then(function () {}, function () {}); if (h && h.stop) { try { h.stop(); } catch (e) {} } } catch (e) { _warmed = false; }
  }

  // Rating channel: aiTextPlugin's handle exposes submitUserRating({score,reason}) which posts the
  // last generation's quality/honesty signal back to the broker. Retain the most recent handle so a
  // later rate() call can reach it (the handle is transient - only valid for the gen it came from).
  var _lastHandle = null;

  function PerchanceModelAdapter(opts) { opts = opts || {}; this.charName = opts.charName || 'Rook'; }
  PerchanceModelAdapter.prototype.label = 'perchance';
  PerchanceModelAdapter.prototype.available = function () { return Promise.resolve(typeof textPlugin() === 'function'); };   // pure predicate: no side effects (warm-up is triggered once at boot via RookPerchanceAdapter.warmUp)
  PerchanceModelAdapter.prototype.chat = function (messages, o) {
    o = o || {};
    var fn = textPlugin(), name = this.charName, self = this;
    if (typeof fn !== 'function') return Promise.reject(new Error('aiTextPlugin unavailable'));
    var base = messagesToInstruction(messages, name);
    var startWith = LB + name + RB + ':';
    var onTok = (o.stream && o.onToken) ? function (t) { if (t) o.onToken(t); } : null;
    // Vision: an optional image (dataURL) rides the FIRST generation. RookHostPerchance rebuilds the Blob
    // and returns the [text, Blob] instruction array aiTextPlugin's vision path expects; no image -> string.
    var baseInstruction = (o.image && root.RookHostPerchance && root.RookHostPerchance.mouthInstruction)
      ? root.RookHostPerchance.mouthInstruction(base, o.image) : base;
    function gen(instruction, sw, isPrimary) {
      return new Promise(function (resolve, reject) {
        try {
          var handle = fn({ instruction: instruction, startWith: sw, hideStartWith: true, stopSequences: ['\n\n' + LB, '\n' + LB],
            onChunk: onTok ? function (ev) { onTok(ev && (ev.textChunk || ev.text || '')); } : undefined });   // R25: delta is {text} or {textChunk}
          if (isPrimary) _lastHandle = handle;   // rate() targets the PRIMARY generation only - never a continuation fragment (see rate())
          Promise.resolve(handle).then(function (r) { resolve({ text: String(r && r.generatedText != null ? r.generatedText : (r || '')), stop: (r && r.stopReason) || '' }); }, reject);
        } catch (e) { reject(e); }
      });
    }
    // R25 A3: the broker caps output (~900 tok -> stopReason 'artificial'). When a reply is cut, continue
    // ONCE so a long answer isn't lost mid-sentence (vs output-hygiene merely trimming the fragment).
    return gen(baseInstruction, startWith, true).then(function (r1) {
      self._lastStop = r1.stop;
      if (r1.stop !== 'artificial' || !r1.text) return r1.text;
      var cont = base + '\n\n' + LB + name + RB + ': ' + r1.text + '\n\n(Continue the message above seamlessly - no repetition, no restating.)';
      return gen(cont, '').then(function (r2) {
        self._lastStop = r2.stop;
        return r2.text ? (r1.text + (/\s$/.test(r1.text) ? '' : ' ') + r2.text) : r1.text;
      }, function () { return r1.text; });   // continuation failed -> keep what we had
    });
  };

  function sanitize(p) {
    if (root.RookHostPerchance && root.RookHostPerchance.sanitizeImagePrompt) return root.RookHostPerchance.sanitizeImagePrompt(p);
    var s = String(p == null ? '' : p).replace(/[\x5b\x5d\x7b\x7d]/g, ' ').replace(/\s+/g, ' ').trim();
    return s || 'a portrait, soft light';
  }
  // Params mirror AICC's own textToImagePlugin call (mined from a live HAR): negativePrompt +
  // 768x768 + guidanceScale 7 are the canonical quality defaults. Still goes THROUGH the plugin
  // (not the raw /api/generate endpoint) - the plugin handles userKey/verification/ad-access.
  function imageGen(prompt, opts) {
    var fn = imagePlugin();
    if (typeof fn !== 'function') return Promise.reject(new Error('textToImagePlugin unavailable'));
    opts = opts || {};
    var req = {
      prompt: sanitize(prompt),
      negativePrompt: opts.negativePrompt || 'low quality, worst quality, blurry',
      seed: (opts.seed != null) ? opts.seed : -1,
      resolution: opts.resolution || '768x768',
      guidanceScale: (opts.guidanceScale != null) ? opts.guidanceScale : 7,
    };
    return Promise.resolve(fn(req)).then(function (r) {
      return (r && r.dataUrl) ? String(r.dataUrl) : String(r || '');   // boxed String -> extract .dataUrl
    });
  }

  // Feed a quality/honesty rating back to the broker for the most recent generation (backward-compatible:
  // callers that never rate are unaffected). Resolves {ok:true} on success, {ok:false,error} otherwise.
  function rate(score, reason) {
    try {
      if (_lastHandle && typeof _lastHandle.submitUserRating === 'function') {
        return Promise.resolve(_lastHandle.submitUserRating({ score: score, reason: reason }))
          .then(function () { return { ok: true }; }, function (e) { return { ok: false, error: String(e && e.message || e) }; });
      }
    } catch (e) { return Promise.resolve({ ok: false, error: String(e && e.message || e) }); }
    return Promise.resolve({ ok: false, error: 'no rateable generation' });
  }

  function detect() {
    try { return ('' + (root.location && root.location.hostname)).indexOf('perchance.org') >= 0 && typeof textPlugin() === 'function'; }
    catch (e) { return false; }
  }

  root.RookPerchanceAdapter = {
    PerchanceModelAdapter: PerchanceModelAdapter,
    imageGen: imageGen,
    messagesToInstruction: messagesToInstruction,
    rate: rate,
    warmUp: warmUp,
    detect: detect,
  };
})(typeof self !== 'undefined' ? self : this);
