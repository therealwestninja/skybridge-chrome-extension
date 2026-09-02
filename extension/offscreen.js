// offscreen.js -- the persistent MV3 offscreen document that hosts the SINGLE, always-on RookAI brain.
//
// Stage A of the tiered-brain architecture. This document owns the one and only makeApp() instance that
// writes to IndexedDB ("rook-brain" -> key "session"). The side-panel console (brain/app-ext.js) and any
// other surface become THIN CLIENTS: they RPC into this brain through the service worker instead of building
// a second makeApp() (two instances on the same store would clobber each other).
//
// Wiring is intentionally byte-for-byte identical to what app-ext.js used to build, only the import paths
// are relative to the extension ROOT ("./brain/src/...") since this file lives at the root.
import { makeApp } from "./brain/src/app.js";
import { makeIndexedDbStorage } from "./brain/src/storage.js";
import { makeWorkerPortBackend } from "./brain/src/backends/workerPort.js";
import { makeWebLLMBackend } from "./brain/src/backends/webllm.js";
import { makeBackendChain } from "./brain/src/backendChain.js";
import { makeOllamaEmbedder, makeHashEmbedder, makeEmbedderChain } from "./brain/src/embedder.js";
import { redactSecrets } from "./brain/src/redact.js";

const app = makeApp({
  storage: makeIndexedDbStorage("rook-brain"),
  backend: makeBackendChain([makeWorkerPortBackend(), makeWebLLMBackend()], { timeoutMs: 30000 }),
  embedder: makeEmbedderChain([makeOllamaEmbedder({ url: "http://localhost:11434" }), makeHashEmbedder()]),
  seed: 1, sizes: { sensory: 40, memory: 20, association: 80, salience: 40, decision: 40 },
  personality: "You are Rook, a calm, curious companion.", ticksPerTurn: 30,
  redact: redactSecrets,
});
try { self.app = app; } catch (e) {}

// init() is async; RPCs may arrive before it resolves. Gate every call on this promise so the first
// request from a freshly-opened console doesn't race the brain's construction. Never rejects (guarded).
let ready = false;
const readyPromise = (async () => { try { await app.init(); ready = true; } catch (e) { /* init failed: keep the doc alive so ops surface {ok:false}, but ready stays FALSE so the autonomous timers don't run against a half-built app */ } })();

// ---- RPC ALLOW list: the app methods a client may invoke. Excludes _internals()/roamerHub() (they return
//      live, non-serializable objects) and init (the offscreen doc owns the lifecycle). Everything else on
//      the returned app object is here, so the console keeps every feature it had. ----
const ALLOW = new Set([
  "send", "status", "feeling", "bond", "body", "hormones", "beliefs",
  "reachOut", "innerThought", "noteDream", "wander", "ruminate", "express", "whatsNew", "welcome",
  "setPersona", "getPersona", "commit", "getCreed", "setProfile", "getProfile", "autotune",
  "addGoal", "completeGoal", "dropGoal", "listGoals", "listHabits", "imagine",
  "drives", "setDrive",
  "addFact", "identityDigest", "listMemories", "updateMemory", "removeMemory",
  "forget", "confirmForget", "cancelForget",
  "propose", "issueConfirmation", "safetyHalted", "resumeSafety", "safetyEvents",
  "backup", "listBackups", "backupStatus", "verifyBackups", "restoreBackup",
  "snapshot", "restore", "undoTag", "factoryReset", "feedback",
  "consolidate", "reflect", "getSelf", "distill", "buildThemes", "listThemes", "reconcile",
  "exportFile", "importFile", "exportSelf", "importSelf", "fork", "rejoin",
  "quickAsk", "frameJack", "tempoState", "save", "tick",
  "perceive", "senses",   // edge-sensor cortex: fused body-senses → attention (see app.perceive / rook-sensory-nerve-lgn)
]);

// The RPC handler answers ONLY worker->offscreen frames ({type:'rook-brain-call'}). The client->worker
// frame is a DIFFERENT type ({type:'rook-brain'}), so the worker's own forward can never be re-handled here
// (and this doc never answers the client's original frame -- no echo/self-reply loop).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== "rook-brain-call") return;
  const op = msg.op, args = Array.isArray(msg.args) ? msg.args : [];
  (async () => {
    try {
      await readyPromise;
      if (!ALLOW.has(op) || typeof app[op] !== "function") { sendResponse({ ok: false, reason: "unknown op: " + String(op) }); return; }
      let value = app[op](...args);
      if (value && typeof value.then === "function") value = await value;
      sendResponse({ ok: true, value });
    } catch (e) {
      try { sendResponse({ ok: false, reason: String((e && e.message) || e).slice(0, 300) }); } catch (e2) {}
    }
  })();
  return true; // async response
});

// ---- Autonomous background cognition (moved here from app-ext.js so it runs while THIS doc is alive, i.e.
//      always -- not only while a console window happens to be open). All guarded; a throw never kills a timer. ----

// Proactive reach-out (60s): the brain self-gates -- nearly every tick is a cheap no-op; it only speaks when
// a real lull + a built-up need clear the urge threshold. There is no console to print to here; the line is
// recorded into context + persisted by app.reachOut() itself, and a client sees it via status()/whatsNew().
setInterval(async () => { try { if (ready) await app.reachOut(); } catch (e) {} }, 60000);

// Idle consolidation (180s): replay salient episodes into the substrate; app.consolidate() self-skips when
// nothing new was said since the last pass, so calling it on a fixed cadence is safe/cheap.
setInterval(async () => { try { if (ready) await app.consolidate(); } catch (e) {} }, 180000);

// Autonomous executive tick (30s): advance the executive/temporal cognition WITHOUT a user turn, so a plan's
// phase keeps moving during a lull. app.tick() is minimal + fully guarded + persists.
setInterval(async () => { try { if (ready) await app.tick(); } catch (e) {} }, 30000);

// ---- PERCEPTION NERVE INGRESS (the receive end of the transport bridge) ----------------------------------------
// The offscreen doc is durable (the SW is not), so the live nerve lives here: an EventSource to the rook-core myelin
// relay (POST /perceive fans out to /perceive/stream). Each SSE frame is forwarded to the SW as {type:'rook/perceive-
// frame'}, where the perceive-bridge runs the LGN + fusion → brain.perceive. Auto-reconnects with backoff; a relay
// that isn't running just retries quietly. Override the URL by setting self.__rookPerceiveUrl before this runs, or via
// chrome.storage 'rook-perceive-url'. Default localhost:48930 (rook-core on the same machine as Chrome). See rook-sensory-nerve-lgn.
(function startPerceiveIngress() {
  let url = "http://127.0.0.1:48930/perceive/stream";
  try { if (self.__rookPerceiveUrl) url = String(self.__rookPerceiveUrl); } catch (e) {}
  let es = null, backoff = 2000, stopped = false;
  function open() {
    if (stopped) return;
    try {
      es = new EventSource(url);
      es.onopen = () => { backoff = 2000; };
      es.onmessage = (ev) => { try { chrome.runtime.sendMessage({ type: "rook/perceive-frame", frame: ev.data, nerve: "relay" }, () => { void chrome.runtime.lastError; }); } catch (e) {} };
      es.onerror = () => { try { es.close(); } catch (e) {} es = null; if (!stopped) { setTimeout(open, backoff); backoff = Math.min(backoff * 2, 30000); } };
    } catch (e) { if (!stopped) { setTimeout(open, backoff); backoff = Math.min(backoff * 2, 30000); } }
  }
  // resolve an override from chrome.storage, then connect.
  try { chrome.storage && chrome.storage.local && chrome.storage.local.get(["rook-perceive-url"], (r) => { try { if (r && r["rook-perceive-url"]) url = String(r["rook-perceive-url"]); } catch (e) {} open(); }); }
  catch (e) { open(); }
})();
