// Rook Brain Bench — a cognition test bench for the new brain. Fire probe inputs and inspect the
// internal decision (intent, action competition, mood/chemistry, Reflex sample, final reply),
// and run the deterministic ablation validation in-page. ESM module (extension page).
import { makeOrganism } from "./brain/src/organism.js";
import { makeReflex } from "./brain/src/reflex.js";
import { makeMind } from "./brain/src/mind.js";
import { makeMemory } from "./brain/src/memory.js";
import { classifyIntent } from "./brain/src/intent.js";
import { CHEMICALS } from "./brain/src/neuromodulation.js";
import { makeWorkerPortBackend } from "./brain/src/backends/workerPort.js";
import { makeBackendChain } from "./brain/src/backendChain.js";
import { runValidation } from "./brain/src/validation.js";

const $ = (id) => document.getElementById(id);
const SIZES = { sensory: 40, memory: 20, association: 80, salience: 40, decision: 40 };
const ACTIONS = ["RESPOND", "ESCALATE", "REFLEX_REPLY", "HOLD", "QUIET"];

let brain = null;

function buildBrain() {
  const noise = +$("noise").value || 0;
  const organism = makeOrganism({ seed: 1, noiseStd: noise, sizes: SIZES,
    personality: { setpoints: { serotonin: 0.6 } } });
  const reflex = makeReflex({ seed: 1 });
  const backend = $("backend").value === "worker"
    ? makeBackendChain([makeWorkerPortBackend()], { timeoutMs: 30000 })
    : null;
  const mind = makeMind({ organism, reflex, backend, memory: makeMemory(),
    personality: "You are Rook, a calm, curious companion.", ticksPerTurn: +$("ticks").value || 30 });
  organism.captureBaseline();
  brain = { organism, reflex, mind };
  $("cards").innerHTML = "";
}

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

function card(probe) {
  const { msg, intent, action, confidence, rates, mood, chems, reflexSample, reply, source } = probe;
  const maxRate = Math.max(0.001, ...Object.values(rates));
  const bars = ACTIONS.map((a) => {
    const v = rates[a] || 0, win = a === action;
    return `<div class="bar"><span class="name${win ? " win" : ""}">${a}</span>` +
      `<span class="track"><span class="fill${win ? " win" : ""}" style="width:${(100 * v / maxRate).toFixed(0)}%"></span></span>` +
      `<span>${v.toFixed(2)}</span></div>`;
  }).join("");
  const chemRow = Object.entries(chems).map(([k, v]) => `${k.slice(0, 4)} ${v.toFixed(2)}`).join("  ");
  const el = document.createElement("div");
  el.className = "card";
  el.innerHTML =
    `<div class="head"><span class="you">you: ${esc(msg)}</span><span class="tag">intent: ${intent}</span></div>` +
    `<div class="body">` +
      `<div class="kv">` +
        `<span class="k">action</span><span class="v">${action} &middot; confidence ${confidence.toFixed(2)}</span>` +
        `<span class="k">mood</span><span class="v">valence ${mood.valence.toFixed(2)} &middot; arousal ${mood.arousal.toFixed(2)}</span>` +
        `<span class="k">chemistry</span><span class="v">${chemRow}</span>` +
      `</div>` +
      `<div class="bars">${bars}</div>` +
      `<div class="reply"><div class="src">reflex sample: ${esc(reflexSample) || "(none)"}</div>` +
        `<div>rook: ${esc(reply) || "(quiet)"} <span class="src">[${source}]</span></div></div>` +
    `</div>`;
  $("cards").prepend(el);
}

async function probe() {
  if (!brain) buildBrain();
  const msg = $("msg").value.trim();
  if (!msg) return;
  $("msg").value = "";
  $("send").disabled = true;
  try {
    const { organism, reflex, mind } = brain;
    const intent = classifyIntent(msg);
    let filler = null;
    const r = await mind.respond(msg, { onReflex: (t) => { filler = t; } });
    const act = organism.readAction();
    const mood = organism.mood();
    const chems = Object.fromEntries(Object.values(CHEMICALS).map((c) => [c, organism.chemLevel(c)]));
    const reflexSample = filler != null ? filler : reflex.render({ action: act.action, mood, message: msg, intent });
    card({ msg, intent, action: r.action, confidence: r.confidence, rates: act.rates || {}, mood, chems, reflexSample, reply: r.text, source: r.source });
  } catch (e) {
    card({ msg, intent: "?", action: "ERROR", confidence: 0, rates: {}, mood: { valence: 0, arousal: 0 }, chems: {}, reflexSample: "", reply: String(e && e.message || e), source: "error" });
  } finally {
    $("send").disabled = false;
    $("msg").focus();
  }
}

async function validate() {
  $("validate").disabled = true;
  $("valstatus").textContent = "running...";
  try {
    const r = await runValidation();
    const pct = (x) => `${(x * 100).toFixed(0)}%`;
    const v = (ok) => ok ? '<td class="ok">PASS</td>' : '<td class="no">FAIL</td>';
    const rows = [
      ["Local-answer rate", pct(r.localAnswerRate.brainOn), `${pct(r.localAnswerRate.noRouting)} (noRouting)`, r.localAnswerRate.brainOn > r.localAnswerRate.noRouting],
      ["Gated learning (drift)", r.learning.rewarded.toFixed(2), `${r.learning.noLearning} noLearning`, r.learning.rewarded > 0 && r.learning.noLearning === 0],
      ["Mood on reward (valence)", r.mood.brainOn.valenceRise.toFixed(2), `${r.mood.noMood.valenceRise} (noMood)`, r.mood.brainOn.valenceRise > 0 && r.mood.noMood.valenceRise === 0],
      ["Mood on threat (arousal)", r.mood.brainOn.arousalRise.toFixed(2), `${r.mood.noMood.arousalRise} (noMood)`, r.mood.brainOn.arousalRise > 0 && r.mood.noMood.arousalRise === 0],
      ["Recall precision@3", pct(r.recall.content), `${pct(r.recall.recency)} recency`, r.recall.content > r.recall.recency],
      ["Fast arc < slow loop", String(r.latency.salience), `${r.latency.association} (assoc)`, r.latency.salience < r.latency.association],
    ];
    $("valout").innerHTML = "<table><tr><th>Claim</th><th>Full brain</th><th>Ablated</th><th>Verdict</th></tr>" +
      rows.map(([c, f, a, ok]) => `<tr><td>${c}</td><td>${f}</td><td>${a}</td>${v(ok)}</tr>`).join("") + "</table>";
    $("valstatus").textContent = "done";
  } catch (e) {
    $("valstatus").textContent = "error: " + (e && e.message || e);
  } finally {
    $("validate").disabled = false;
  }
}

$("send").onclick = probe;
$("msg").addEventListener("keydown", (e) => { if (e.key === "Enter") probe(); });
$("rebuild").onclick = buildBrain;
function feedback(kind) {
  if (!brain) buildBrain();
  brain.organism.feedback(kind);
  const o = brain.organism, m = o.mood();
  $("fbOut").textContent = `${kind === "up" ? "reward" : "wary"} -> mood v ${m.valence.toFixed(2)} a ${m.arousal.toFixed(2)} | dopa ${o.chemLevel("dopamine").toFixed(2)} nore ${o.chemLevel("norepinephrine").toFixed(2)}`;
}
$("fbUp").onclick = () => feedback("up");
$("fbDown").onclick = () => feedback("down");
// Settings apply immediately on change (no stale brain): changing the backend toggle, ticks, or
// noise rebuilds the brain right away, so the dropdown can never lie about what's wired.
["backend", "ticks", "noise"].forEach((id) => $(id).addEventListener("change", buildBrain));
$("validate").onclick = validate;
buildBrain();
