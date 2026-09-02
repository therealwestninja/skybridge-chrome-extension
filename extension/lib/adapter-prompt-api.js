'use strict';
/* adapter-prompt-api.js - Rook model adapter for Chrome's BUILT-IN AI (the Prompt API / Gemini
 * Nano). A ~4GB model that already ships inside Chrome: no key, no server, no install, no download
 * for the user (Chrome manages it), and it runs FULLY ON-DEVICE. The most thesis-aligned mouth -
 * a local model that needs nothing installed (vs Ollama). Same adapter shape as the others
 * (available() + chat(messages,{stream,onToken})), so the SAME brain/console drives it unchanged.
 *
 * API (per developer.chrome.com/docs/ai/prompt-api): global `LanguageModel`,
 *   await LanguageModel.availability()                  -> 'available' | 'downloading' | 'unavailable'
 *   const s = await LanguageModel.create({ initialPrompts:[{role,content},...], temperature?, topK? })
 *   await s.prompt(text)            /  for await (const chunk of s.promptStreaming(text)) {...}
 * Extension context also exposes LanguageModel.params() + temperature/topK.
 */
(function (root) {
  var W = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : root;
  function LM() { try { return W.LanguageModel || root.LanguageModel || (typeof LanguageModel !== 'undefined' ? LanguageModel : null); } catch (e) { return null; } }

  function PromptApiAdapter(opts) { opts = opts || {}; this.opts = opts; }
  PromptApiAdapter.prototype.label = 'chrome-ai';
  PromptApiAdapter.prototype.available = function () {
    var lm = LM(); if (!lm || typeof lm.availability !== 'function') return Promise.resolve(false);
    return Promise.resolve().then(function () { return lm.availability(); })
      .then(function (a) { return a === 'available' || a === 'downloading' || a === true || a === 'readily'; }, function () { return false; });
  };
  // messages -> { initialPrompts: [all but the final user turn], prompt: <final user content> }
  function split(messages) {
    var ip = (messages || []).map(function (m) { return { role: (m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user'), content: String(m.content == null ? '' : m.content) }; });
    var prompt = 'Continue.';
    if (ip.length && ip[ip.length - 1].role === 'user') prompt = ip.pop().content;
    return { initialPrompts: ip, prompt: prompt };
  }
  PromptApiAdapter.prototype.chat = function (messages, o) {
    o = o || {}; var lm = LM(), self = this;
    if (!lm || typeof lm.create !== 'function') return Promise.reject(new Error('Chrome built-in AI (Prompt API) unavailable'));
    var s = split(messages);
    var createOpts = {};
    if (s.initialPrompts.length) createOpts.initialPrompts = s.initialPrompts;
    if (self.opts.temperature != null) createOpts.temperature = self.opts.temperature;
    if (self.opts.topK != null) createOpts.topK = self.opts.topK;
    return Promise.resolve(lm.create(createOpts)).then(function (session) {
      // streaming: promptStreaming yields chunks; some Chrome builds emit CUMULATIVE text, others
      // DELTAS - normalise by tracking what we've already emitted and only sending the new tail.
      if (o.stream && o.onToken && typeof session.promptStreaming === 'function') {
        var seen = '';
        var it = session.promptStreaming(s.prompt);
        if (it && typeof it[Symbol.asyncIterator] === 'function') {
          return (async function () {
            for await (var ch of it) {
              var piece = (typeof ch === 'string') ? ch : (ch && (ch.text || ch.content || '')) || '';
              var delta = piece.indexOf(seen) === 0 ? piece.slice(seen.length) : piece;   // cumulative -> tail, else delta as-is
              if (delta) { o.onToken(delta); }
              seen = piece.length >= seen.length ? piece : seen + piece;
            }
            return seen;
          })();
        }
      }
      return Promise.resolve(session.prompt(s.prompt)).then(function (r) {
        var text = String(r == null ? '' : r);
        if (o.stream && o.onToken && text) o.onToken(text);   // no native stream -> emit once so streaming UIs still update
        return text;
      });
    });
  };

  root.RookPromptApi = { PromptApiAdapter: PromptApiAdapter };
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : this));
