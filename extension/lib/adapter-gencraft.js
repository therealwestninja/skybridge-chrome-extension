'use strict';
/* adapter-gencraft.js - Rook image backend for gencraft.com (text->image AND image-to-image).
 *
 * Protocol reconstructed from a live HAR (2026-06-19) + the site's JS bundle:
 *   base   https://api.gencraft.com/api/v38   (HAR-confirmed)
 *   auth   Authorization: Bearer <JWT>        (HAR-confirmed; JWT from localStorage["sid"], bundle-mined)
 *   gen    POST /prompt/generate  {prompt_text, negative_prompt_text, media_type:'image',
 *            generation_type:'text_to_image'|'image_to_image', width, height,
 *            components:[{generic_model_id, strength}]}              (payload HAR-confirmed)
 *   poll   GET /user/history?last=true -> data.creations[]; the finished image lives in the newest
 *            creation (client exposes it via getViewableMedia({type:'img_large'})). We deep-scan the
 *            JSON for the image URL so we don't depend on the exact field name.   (bundle-mined)
 *   i2i    POST /image_repo/upload (multipart) -> an id referenced by the generate payload.
 *
 * CAPTURE-NOT-FORGE: the token is the user's own live session (localStorage["sid"] on a gencraft tab,
 * or passed in). Cross-origin calls run through Rook's background worker (host_permission), human-rate.
 * Residual unknowns (marked TODO): the exact i2i source-ref field name, and the result-URL field
 * (handled by the deep-scan). Confirm both against one live generation.
 */
(function (root) {
  var BASE = 'https://api.gencraft.com/api/v38';
  function tokenOf(opts) {
    try { return (opts && opts.token) || (root.localStorage && root.localStorage.getItem('sid')) || null; }
    catch (e) { return (opts && opts.token) || null; }
  }
  // deep-scan any object/array for the first image URL - survives unknown field names
  function findImageUrl(o, depth) {
    if (o == null || depth > 12) return null;
    if (typeof o === 'string') return /^https?:\/\/\S+\.(png|jpe?g|webp)(\?|$)/i.test(o) ? o : null;
    if (Array.isArray(o)) { for (var i = 0; i < o.length; i++) { var u = findImageUrl(o[i], depth + 1); if (u) return u; } return null; }
    if (typeof o === 'object') { for (var k in o) { try { var v = findImageUrl(o[k], depth + 1); if (v) return v; } catch (e) {} } }
    return null;
  }

  function GencraftAdapter(opts) {
    this.opts = opts || {};
    this._fetch = this.opts.fetch || (root.fetch ? root.fetch.bind(root) : null);
    this.label = 'gencraft';
  }
  GencraftAdapter.prototype.available = function () { return Promise.resolve(!!(tokenOf(this.opts) && this._fetch)); };
  GencraftAdapter.prototype._req = function (method, path, body, isForm) {
    var t = tokenOf(this.opts); if (!t) return Promise.reject(new Error('gencraft: no session token (log in, or pass {token})'));
    if (!this._fetch) return Promise.reject(new Error('gencraft: no fetch (run via the extension worker)'));
    var headers = { 'Authorization': 'Bearer ' + t }, init = { method: method, headers: headers, credentials: 'omit' };
    if (body != null) { if (isForm) { init.body = body; } else { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); } }
    return this._fetch(BASE + path, init).then(function (r) { return r.json(); });
  };
  // upload a source image (Blob/File) for image-to-image -> returns an id
  GencraftAdapter.prototype.uploadImage = function (blob) {
    if (typeof FormData === 'undefined') return Promise.reject(new Error('no FormData'));
    var fd = new FormData(); fd.append('file', blob);
    return this._req('POST', '/image_repo/upload', fd, true).then(function (r) { return (r && (r.id || r.image_id || (r.data && r.data.id))) || null; });
  };
  // prompt -> image URL. opts: {negativePrompt, width, height, modelId, strength, sourceImageId}
  GencraftAdapter.prototype.imageGen = function (prompt, opts) {
    opts = opts || {}; var self = this, i2i = !!opts.sourceImageId;
    var payload = {
      prompt_text: String(prompt == null ? '' : prompt),
      negative_prompt_text: opts.negativePrompt || '',
      media_type: 'image',
      generation_type: i2i ? 'image_to_image' : 'text_to_image',
      width: opts.width || 1024, height: opts.height || 1024,
      components: [{ generic_model_id: (opts.modelId != null ? opts.modelId : 36), strength: i2i ? (opts.strength != null ? opts.strength : 0.6) : null }],
    };
    if (i2i) payload.components[0].source_image_id = opts.sourceImageId;   // TODO confirm exact i2i field name
    return self._req('POST', '/prompt/generate', payload).then(function () {
      var tries = 0, MAX = 40;   // ~60s at 1.5s
      return new Promise(function (resolve, reject) {
        (function poll() {
          self._req('GET', '/user/history?last=true').then(function (h) {
            var url = findImageUrl(h, 0);
            if (url) return resolve(url);
            if (++tries >= MAX) return reject(new Error('gencraft: timed out waiting for the image'));
            (root.setTimeout || setTimeout)(poll, 1500);
          }, reject);
        })();
      });
    });
  };

  root.RookGencraft = { GencraftAdapter: GencraftAdapter, _findImageUrl: findImageUrl };
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : this));
