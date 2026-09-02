// minecraftChat.js — make Rook PRESENT in the shared Minecraft world, not just moving: a two-way chat bridge. The server
// writes player chat to its log ("[..] [Server thread/INFO] [..]: <Fish> hello"); we TAIL that log, parse each chat line,
// hand the player's words to Rook's conversational MOUTH, and speak her reply back into the world via /tellraw (or /say).
//
// REUSE + shape: the mouth is INJECTED (the same conversational organ the Moot/phone use — this file doesn't own a model),
// and the body is a minecraftRcon body ({ send }). Parsing is PURE and unit-testable; the fs tail is a thin injectable
// poller so the routing logic is provable without a live server. Loop-safe: Rook's own lines (her name / the [Rook] prefix)
// are ignored so she never answers herself.

// parseChat(line) → { player, text } | null. Handles vanilla/NeoForge "...: <player> message" and "[player] message" forms.
export function parseChat(line) {
  const s = String(line || "");
  let m = /: <([^>]{1,40})> (.+?)\s*$/.exec(s);          // "<player> message" (standard chat)
  if (!m) m = /: \[([^\]]{1,40})\] (.+?)\s*$/.exec(s);   // "[player] message" (some chat mods)
  if (!m) return null;
  const player = m[1].trim(), text = m[2].trim();
  if (!player || !text) return null;
  return { player, text };
}

// tellrawJson(name, text) — a colored /tellraw payload so Rook's voice reads distinctly in chat.
export function tellrawJson(name, text) {
  return JSON.stringify([{ text: `<${name}> `, color: "aqua", bold: true }, { text: String(text), color: "white" }]);
}

// makeChatBridge — the routing organ. handleLine(logLine) parses → (not self) → mouth → speak reply into the world.
export function makeChatBridge({ body, mouth, selfName = "Rook", ignore = [], useTellraw = true, maxLen = 240 } = {}) {
  if (!body || typeof body.send !== "function") throw new Error("makeChatBridge: inject a body with send()");
  if (typeof mouth !== "function") throw new Error("makeChatBridge: inject a mouth(text,ctx)->reply");
  const muted = new Set([selfName.toLowerCase(), ...ignore.map((s) => String(s).toLowerCase())]);

  async function speak(text) {
    const t = String(text).slice(0, maxLen);
    if (useTellraw && typeof body.rcon?.cmd === "function") await body.rcon.cmd(`tellraw @a ${tellrawJson(selfName, t)}`);
    else await body.send({ say: `[${selfName}] ${t}` });   // fallback: /say (works on any body)
    return t;
  }

  async function handleLine(line) {
    const c = parseChat(line);
    if (!c) return null;
    if (muted.has(c.player.toLowerCase())) return null;    // don't answer ourselves / muted speakers
    let reply;
    try { reply = await mouth(c.text, { player: c.player, source: "minecraft" }); }
    catch { return { heard: c, replied: false, error: true }; }   // a mouth failure is silent in-world, never a crash
    if (!reply) return { heard: c, replied: false };
    const spoken = await speak(reply);
    return { heard: c, replied: true, to: c.player, text: spoken };
  }

  return { handleLine, speak, parseChat };
}

// tailChatLog — poll a growing log file, emit each NEW line to onLine. fs + timer injected for testability; returns stop().
export function tailChatLog({ file, onLine, fs, intervalMs = 500, setInterval: si, clearInterval: ci } = {}) {
  const _si = si || (typeof setInterval !== "undefined" ? setInterval : null);
  const _ci = ci || (typeof clearInterval !== "undefined" ? clearInterval : null);
  if (!fs || !file || typeof onLine !== "function" || !_si) throw new Error("tailChatLog: need { file, onLine, fs } + a timer");
  let pos = (() => { try { return fs.statSync(file).size; } catch { return 0; } })();   // start at EOF — only NEW chat
  let carry = "";
  const poll = () => {
    let size; try { size = fs.statSync(file).size; } catch { return; }
    if (size < pos) { pos = 0; carry = ""; }                 // log rotated/truncated → re-sync
    if (size <= pos) return;
    let chunk = ""; try { const fd = fs.openSync(file, "r"); const buf = Buffer.alloc(size - pos); fs.readSync(fd, buf, 0, buf.length, pos); fs.closeSync(fd); chunk = buf.toString("utf8"); } catch { return; }
    pos = size;
    const lines = (carry + chunk).split(/\r?\n/); carry = lines.pop() || "";
    for (const ln of lines) { try { onLine(ln); } catch { /* one bad line never stops the tail */ } }
  };
  const h = _si(poll, intervalMs);
  return () => { if (_ci) _ci(h); };
}
