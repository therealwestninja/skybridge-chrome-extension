// extension/brain/app-ext.js — entry module for the Rook side panel.
//
// Stage A (tiered brain): the console NO LONGER builds its own brain. The single, always-on brain lives in a
// persistent MV3 offscreen document (offscreen.js) that is the sole writer to IndexedDB "rook-brain". This
// module is now a THIN CLIENT: `app` is a proxy whose every method forwards to that brain via the service
// worker ({type:'rook-brain', op, args}) and returns the reply's `.value` (throwing on {ok:false}). All the
// autonomous timers (reachOut / consolidate / tick) live in the offscreen doc now, not here.
//
// Consequence: every brain call is ASYNC (a message round-trip). Former synchronous getters
// (status/getPersona/getProfile/listMemories/exportFile) are now awaited; the render helpers below became
// async to suit. Known Stage-A limitation: app.send()'s onReflex streaming-filler callback cannot cross the
// messaging boundary (functions aren't serializable), so the interim "(reflex...)" line is dropped — the
// final reply still renders. Everything is guarded; a dead brain surfaces as a thrown error, not a crash.

// One RPC to the offscreen brain (via the worker). Resolves with the method's return value, rejects on error.
function brainCall(op, args) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage({ type: "rook-brain", op, args: args || [] }, (r) => {
        void chrome.runtime.lastError;
        if (!r) { reject(new Error("no response from brain" + (chrome.runtime.lastError ? " (" + chrome.runtime.lastError.message + ")" : ""))); return; }
        if (r.ok) resolve(r.value); else reject(new Error(r.reason || "brain error"));
      });
    } catch (e) { reject(e); }
  });
}
// A proxy so `app.anything(...args)` transparently becomes brainCall("anything", args). Every method is async.
const app = new Proxy({}, {
  get(_t, op) {
    if (typeof op !== "string") return undefined;
    // Strip non-serializable args (e.g. send()'s onReflex callback) before they cross the messaging boundary.
    return (...args) => brainCall(op, args.map((a) => (typeof a === "function" ? undefined : a)));
  },
});
window.app = app;
// No app.init() here — the offscreen doc owns brain lifecycle. A no-op status() primes the RPC path.
try { await app.status(); } catch (e) { /* brain still spinning up / offscreen not ready yet — UI will retry on use */ }

const $ = (id) => document.getElementById(id);
const log = $("log");
const line = (cls, text, meta) => {
  const d = document.createElement("div"); d.className = cls; d.textContent = text;
  if (meta) { const m = document.createElement("span"); m.className = "meta"; m.textContent = " " + meta; d.appendChild(m); }
  log.appendChild(d); log.scrollTop = log.scrollHeight; return d;
};
async function refreshStatus() {
  const s = await app.status();
  if (!s) return;
  $("st-mood").textContent = `mood ${s.mood.valence.toFixed(2)} / ${s.mood.arousal.toFixed(2)}`;
  $("st-action").textContent = `action ${s.action}`;
  $("st-src").textContent = `via ${s.source} · energy ${Math.round((s.energy ?? 1) * 100)}%`;
}
async function refreshPersona() {
  const p = await app.getPersona();
  if (!p) return;
  $("desc").value = p.description;
  if ($("greeting")) $("greeting").value = p.greeting || "";
  $("setpoints").innerHTML = Object.entries(p.setpoints)
    .map(([k, v]) => `<div class="row"><label style="width:110px">${k}</label> ${v.toFixed(2)}</div>`).join("");
}
const PF = ["name", "pronouns", "about", "interests", "goals", "style"];
async function refreshProfile() {
  const p = await app.getProfile();
  if (!p) return;
  for (const f of PF) { const el = $("pf-" + f); if (el) el.value = p[f] || ""; }
}
async function refreshMemory() {
  $("memlist").innerHTML = "";
  for (const m of (await app.listMemories()) || []) {
    const d = document.createElement("div"); d.className = "mem";
    d.textContent = `${m.pinned ? "PIN " : ""}[${m.type}] ${m.text}`;
    const del = document.createElement("button"); del.textContent = "x"; del.style.marginLeft = "6px";
    del.onclick = async () => { await app.removeMemory(m.id); refreshMemory(); };
    d.appendChild(del); $("memlist").appendChild(d);
  }
}
async function send() {
  const msg = $("in").value.trim(); if (!msg) return;
  $("in").value = ""; line("u", "you: " + msg);
  let filler = null;
  const r = await app.send(msg, { onReflex: (t) => { if (t) filler = line("a", "rook: " + t, "(reflex...)"); } });
  if (r.source === "quiet") { line("meta", "(stayed quiet)"); }
  else { if (filler && r.source === "backend") filler.remove(); const d = line("a", "rook: " + r.text, `[${r.action} - ${r.source}${r.shed ? " (shed)" : ""} - ${r.confidence.toFixed(2)}]`); if (r.trace) d.title = r.trace.why + ` | energy ${Math.round((r.trace.energy || 1) * 100)}%` + (r.audit ? ` | ctx ${r.audit.total}t (saved ${r.audit.saved}t)` : ""); if (r.thinking) line("meta", "thought: " + r.thinking); }
  refreshStatus(); refreshMemory();
}
$("send").onclick = send;
$("in").addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
document.querySelectorAll(".tabs button").forEach((b) => b.onclick = () => {
  document.querySelectorAll(".tabs button").forEach((x) => x.classList.remove("on"));
  document.querySelectorAll(".tabpane").forEach((x) => x.classList.remove("on"));
  b.classList.add("on"); $("tab-" + b.dataset.tab).classList.add("on");
});
$("savePersona").onclick = async () => {
  await app.setPersona($("desc").value, {}, $("greeting") ? $("greeting").value : undefined);
  refreshPersona(); refreshStatus();
};
$("saveProfile").onclick = async () => {
  const fields = {};
  for (const f of PF) { const el = $("pf-" + f); if (el) fields[f] = el.value.trim(); }
  await app.setProfile(fields); refreshProfile();
};
$("addFact").onclick = async () => { const t = $("factText").value.trim(); if (t) { await app.addFact(t); $("factText").value = ""; refreshMemory(); } };
$("restBtn").onclick = async () => {
  line("meta", "(resting…)");
  const r = await app.consolidate({ force: true });   // associative replay into the substrate
  const d = await app.distill();                      // declarative: episodes -> durable facts
  const rc = await app.reconcile();                   // dedupe/resolve the distilled fact set
  line("meta", `(rested — replayed ${r.replayed}${r.skipped ? " (nothing new)" : `, ${r.kept ? "kept" : "rolled back"}`}; distilled ${d.distilled} facts${rc.reconciled ? `, reconciled to ${rc.reconciled}` : ""}${r.reflected ? "; refreshed self-note" : ""})`);
  refreshStatus(); refreshMemory();
};

// NOTE (Stage A): the idle-consolidate + reach-out timers that used to live here were REMOVED. They now run
// in the persistent offscreen brain (offscreen.js) so autonomous cognition continues even when no console is
// open. The console stays a passive client; it reflects the brain's state on demand (send / Rest / refresh).
$("resetBtn").onclick = async () => { await app.factoryReset(); line("meta", "(factory reset)"); refreshStatus(); };
$("exportBtn").onclick = async () => {
  const blob = new Blob([await app.exportFile()], { type: "application/json" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "brain.json"; a.click();
};
refreshStatus(); refreshPersona(); refreshProfile(); refreshMemory();

// One-time welcome: Rook greets a brand-new user (AiCC-style character greeting). Shown once,
// recorded into context, then never again (the greeted flag is persisted).
const hello = await app.welcome();
if (hello) { line("a", "rook: " + hello, "(welcome)"); refreshStatus(); }

// Proactive reach-out now runs in the offscreen brain (app.reachOut on a 60s timer there). Because that doc
// has no UI, an autonomous reach-out is recorded into context + persisted rather than printed live here; the
// console surfaces it on the next refresh/turn. (Stage B can add a push so the panel prints it in real time.)

// ---- Self-edit approval queue (review UI) --------------------------------------------------------
// The inner AI proposes changes to its own generator over the agent bus; the anchor forwards them to the
// worker's durable queue. Here we list + let a human act. NO AUTO-ACCEPT: applying requires an Accept
// click THEN a Confirm click. Every status change routes back to the worker (op:update), which fans the
// new status out to the perchance anchors so the inner AI hears the outcome over the same bus.
const SE = {
  list: () => new Promise((res) => { try { chrome.runtime.sendMessage({ type: "rook-selfedit", op: "list" }, (r) => { void chrome.runtime.lastError; res((r && r.items) || []); }); } catch (e) { res([]); } }),
  update: (id, patch, statusText) => new Promise((res) => { try { chrome.runtime.sendMessage({ type: "rook-selfedit", op: "update", id, patch, statusText }, (r) => { void chrome.runtime.lastError; res(r || { ok: false }); }); } catch (e) { res({ ok: false }); } }),
  remove: (id) => new Promise((res) => { try { chrome.runtime.sendMessage({ type: "rook-selfedit", op: "remove", id }, (r) => { void chrome.runtime.lastError; res(r || { ok: false }); }); } catch (e) { res({ ok: false }); } }),
};
const seExpanded = {};
let seShowDeferred = false;
function seColor(s) { return s === "pending" ? "#d29922" : s === "applied" ? "#2ea043" : s === "rejected" ? "#d9736b" : s === "error" ? "#e0894a" : "#8b949e"; }
function seBtn(label, fn, ghost) {
  const b = document.createElement("button"); b.textContent = label;
  b.style.cssText = "padding:4px 8px;font-size:12px" + (ghost ? ";background:#21262d;color:#e6edf3" : "");
  b.onclick = fn; return b;
}
async function refreshSelfEdits() {
  const pane = $("tab-selfedit"); if (!pane) return;
  const items = await SE.list();
  const pending = items.filter((x) => x.status === "pending").length;
  const deferred = items.filter((x) => x.status === "deferred").length;
  const tabButton = document.querySelector('.tabs button[data-tab="selfedit"]');
  if (tabButton) tabButton.textContent = "Self-edits" + (pending ? ` (${pending})` : "");
  pane.innerHTML = "";
  const head = document.createElement("p"); head.className = "meta";
  head.textContent = pending ? `${pending} pending — review each proposal from the inner AI.` : "No pending proposals. The inner AI sends these over the agent bus.";
  pane.appendChild(head);
  if (deferred) pane.appendChild(seBtn((seShowDeferred ? "Hide" : "Show") + ` deferred (${deferred})`, () => { seShowDeferred = !seShowDeferred; refreshSelfEdits(); }, true));
  const visible = items.filter((x) => x.status !== "deferred" || seShowDeferred).sort((a, b) => b.id - a.id);
  for (const item of visible) pane.appendChild(seRow(item));
}
function seRow(item) {
  const row = document.createElement("div"); row.className = "mem";
  const top = document.createElement("div"); top.className = "row"; top.style.margin = "0 0 4px";
  const dot = document.createElement("span"); dot.style.cssText = `width:8px;height:8px;border-radius:50%;background:${seColor(item.status)};display:inline-block;flex:0 0 auto`;
  const title = document.createElement("strong"); title.style.fontSize = "12px"; title.textContent = `#${item.id} · ${item.status}`;
  const gen = document.createElement("span"); gen.className = "meta"; gen.style.marginLeft = "auto"; gen.textContent = item.generator || "this generator";
  top.appendChild(dot); top.appendChild(title); top.appendChild(gen); row.appendChild(top);

  const expanded = !!seExpanded[item.id];
  const body = document.createElement("div"); body.style.cssText = "white-space:pre-wrap;word-break:break-word;margin:4px 0;font-size:12px";
  const full = String(item.text || "");
  body.textContent = expanded ? full : (full.length > 160 ? full.slice(0, 160) + "…" : full);
  row.appendChild(body);
  if (item.note) { const n = document.createElement("div"); n.className = "meta"; n.textContent = (item.status === "error" ? "⚠ " : "") + item.note; row.appendChild(n); }

  const acts = document.createElement("div"); acts.className = "row"; acts.style.flexWrap = "wrap";
  acts.appendChild(seBtn(expanded ? "Collapse" : "Read", () => { seExpanded[item.id] = !expanded; refreshSelfEdits(); }, true));
  const active = item.status === "pending" || item.status === "deferred" || item.status === "error";
  if (active) {
    acts.appendChild(seBtn("Accept", () => seBeginAccept(item, row), false));
    acts.appendChild(seBtn("Edit", () => seBeginEdit(item, row), true));
    if (item.status === "deferred") acts.appendChild(seBtn("Un-defer", async () => { await SE.update(item.id, { status: "pending" }, `Proposal #${item.id} un-deferred.`); refreshSelfEdits(); }, true));
    else acts.appendChild(seBtn("Defer", async () => { await SE.update(item.id, { status: "deferred" }, `Proposal #${item.id} deferred for later.`); refreshSelfEdits(); }, true));
    acts.appendChild(seBtn("Reject", async () => {
      let reason = ""; try { reason = window.prompt(`Reject proposal #${item.id} — optional reason:`, "") || ""; } catch (e) {}
      reason = String(reason).trim().slice(0, 200);
      await SE.update(item.id, { status: "rejected", note: reason ? "rejected: " + reason : "rejected" }, `Rejected proposal #${item.id}${reason ? ": " + reason : ""}.`);
      refreshSelfEdits();
    }, true));
  }
  acts.appendChild(seBtn("Delete", async () => { if (window.confirm(`Delete proposal #${item.id} from the queue?`)) { await SE.remove(item.id); refreshSelfEdits(); } }, true));
  row.appendChild(acts);
  return row;
}
// Accept = Accept click THEN Confirm click (no auto-accept). This extension cannot write the running
// generator's source (the generator owns it), so "applied" means the human reviewed and applied it.
function seBeginAccept(item, row) {
  const box = document.createElement("div"); box.dataset.seEditing = "1"; box.style.marginTop = "6px";
  const note = document.createElement("div"); note.className = "meta";
  note.textContent = "Mark this proposal reviewed & applied? Rook does not edit the generator's source — you apply the change yourself, then confirm here so the inner AI is told.";
  const bar = document.createElement("div"); bar.className = "row";
  bar.appendChild(seBtn("Confirm apply", async () => {
    await SE.update(item.id, { status: "applied", note: item.note || "applied (reviewed by human)" }, `Applied proposal #${item.id}. Reviewed and marked applied.`);
    refreshSelfEdits();
  }, false));
  bar.appendChild(seBtn("Cancel", () => refreshSelfEdits(), true));
  box.appendChild(note); box.appendChild(bar); row.appendChild(box);
}
function seBeginEdit(item, row) {
  const box = document.createElement("div"); box.dataset.seEditing = "1"; box.style.marginTop = "6px";
  const ta = document.createElement("textarea"); ta.rows = 4; ta.value = String(item.text || "");
  const bar = document.createElement("div"); bar.className = "row";
  bar.appendChild(seBtn("Update", async () => { await SE.update(item.id, { text: String(ta.value || "") }); refreshSelfEdits(); }, false));
  bar.appendChild(seBtn("Cancel", () => refreshSelfEdits(), true));
  box.appendChild(ta); box.appendChild(bar); row.appendChild(box);
  try { ta.focus(); } catch (e) {}
}
const seTabButton = document.querySelector('.tabs button[data-tab="selfedit"]');
if (seTabButton) seTabButton.addEventListener("click", refreshSelfEdits);
refreshSelfEdits();
// poll for new proposals, but never clobber an open inline editor (Accept/Edit box)
setInterval(() => { const pane = $("tab-selfedit"); if (pane && pane.querySelector("[data-se-editing]")) return; refreshSelfEdits(); }, 5000);
