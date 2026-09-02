// Tries adapters in order; on throw/timeout/empty it falls through. Each adapter returns a string;
// this wraps it as { text, source }. If all fail it throws lastErr (callers decide the fallback --
// mind.js routes to Reflex).
function withTimeout(promise, ms) {
  if (!ms || ms <= 0) return promise;
  return new Promise((resolve, reject) => {
    const id = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then((v) => { clearTimeout(id); resolve(v); }, (e) => { clearTimeout(id); reject(e); });
  });
}

export function makeBackendChain(adapters = [], { timeoutMs = 15000 } = {}) {
  return {
    name: "chain",
    async generate(req) {
      let lastErr = null;
      for (const a of adapters) {
        try {
          const result = await withTimeout(a.generate(req), timeoutMs);
          if (result != null && result !== "") return { text: result, source: a.name };
        } catch (e) { lastErr = e; }
      }
      throw lastErr || new Error("no backend available");
    },
  };
}

// --- Declarative backend selection (additive; does NOT change makeBackendChain above) -----------------
// Callers that want more than ollama+mock (an in-browser WebLLM mouth, an off-main-thread worker port, or a
// privacy-filtering wrapper) can describe a chain as a list of SPECS and resolve them here, instead of
// importing every backend factory at each call site. A spec is one of:
//   - an adapter object already (has .generate)      -> used verbatim (the escape hatch)
//   - a string type                                  -> "ollama" | "mock" | "webllm" | "workerPort"
//   - { type, ...opts }                              -> leaf backend built from its factory with opts
//   - { type:"privacyMouth", cloud, local?, redactor } -> the redaction WRAPPER around a cloud (+ optional
//                                                          on-device) mouth; cloud/local are themselves specs
// The factories are injectable so tests (and browsers that must avoid pulling the multi-MB WebLLM lib) can
// substitute doubles without touching the real ones.
import { makeOllamaBackend } from "./backends/ollama.js";
import { makeMockBackend } from "./backends/mock.js";
import { makeWebLLMBackend } from "./backends/webllm.js";
import { makeWorkerPortBackend } from "./backends/workerPort.js";
import { makePrivacyMouth } from "./backends/privacyMouth.js";

export const BACKEND_FACTORIES = {
  ollama: (o) => makeOllamaBackend(o),
  mock: (o) => makeMockBackend(o.fn),
  webllm: (o) => makeWebLLMBackend(o),
  workerPort: (o) => makeWorkerPortBackend(o),
  "worker-port": (o) => makeWorkerPortBackend(o),
};

// Turn one spec into a live backend adapter. `factories` override individual leaf builders (e.g. a mocked
// webllm in Node). The extra `type` key is harmless: every factory destructures only the keys it knows.
export function resolveBackend(spec, { factories = BACKEND_FACTORIES } = {}) {
  if (spec && typeof spec.generate === "function") return spec;              // already an adapter
  if (typeof spec === "string") spec = { type: spec };
  if (!spec || !spec.type) throw new Error("resolveBackend: spec needs a `type` (or be an adapter)");
  if (spec.type === "privacyMouth" || spec.type === "privacy-mouth") {
    if (!spec.cloud) throw new Error("resolveBackend: privacyMouth needs a `cloud` sub-spec");
    const cloud = resolveBackend(spec.cloud, { factories });
    const local = spec.local ? resolveBackend(spec.local, { factories }) : null;
    return makePrivacyMouth({ cloud, local, redactor: spec.redactor });
  }
  const make = factories[spec.type];
  if (!make) throw new Error(`resolveBackend: unknown backend type "${spec.type}"`);
  return make(spec);
}

// Build a fallback chain from specs (each resolved via resolveBackend). Same shape as makeBackendChain.
export function makeChainFromSpecs(specs = [], { factories, ...opts } = {}) {
  return makeBackendChain(specs.map((s) => resolveBackend(s, { factories })), opts);
}
