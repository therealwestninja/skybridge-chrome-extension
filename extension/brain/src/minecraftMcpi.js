// minecraftMcpi.js — a Minecraft body SEAM via the classic mcpi socket protocol (PLAN §B9; the Minecraft mine). Same
// role as ueRemoteControl.js (UE) / vehicleRoamer transports (BC/Liftoff): a pluggable transport a `roamers` body
// drives — read {pos,heading,medium,heightAt} + send {move/goto/place/say}. mcpi is a line-based TCP text protocol on
// :4711 (Minecraft Pi / RaspberryJuice): getters return one response line, setters return nothing; strictly ordered,
// so a FIFO of pending resolvers correlates responses. The CONNECTION is INJECTED (a line-duplex) so this is testable
// against a stub with no server; the default is a node:net socket. PURE protocol layer.
//
// Minecraft-native niceties vs our flat sim: `medium` comes from the BLOCK at the player's feet (a water block ⇒
// 'water'), which is more accurate than heightAt<=0; `world.getHeight(x,z)` IS our heightAt. So a Minecraft morph body
// reads `medium` directly for splash/beach instead of inferring it.

import { mediumOf } from "./mcData.js";   // shared real-Minecraft block→medium vocabulary (also used by the dream sim)
const num = (x, d = 0) => { const n = parseFloat(x); return Number.isFinite(n) ? n : d; };

// ── low-level client: send (fire-and-forget setters) + sendReceive (await the next response line, FIFO). ──
// connImpl(host,port) → { write(str), close(), onLine(cb) }. Default: a node:net line-buffered socket.
export function makeMcpiClient({ host = "127.0.0.1", port = 4711, connImpl = null } = {}) {
  const pending = [];                              // FIFO of resolvers awaiting a response line
  const make = connImpl || defaultConn;
  const conn = make(host, port);
  conn.onLine((line) => { const r = pending.shift(); if (r) r.resolve(line.replace(/\r?\n$/, "")); });

  const send = (cmd) => conn.write(cmd.endsWith("\n") ? cmd : cmd + "\n");
  function sendReceive(cmd) {
    return new Promise((resolve, reject) => { pending.push({ resolve, reject }); send(cmd); });
  }
  return { send, sendReceive, close: () => conn.close(), _pending: pending };
}

// default node:net connection (only constructed if you don't inject one — keeps the module importable without a socket).
function defaultConn(host, port) {
  let net; try { net = require("node:net"); } catch { throw new Error("minecraftMcpi: node:net unavailable; inject connImpl"); }
  const sock = net.createConnection({ host, port });
  sock.setEncoding("utf8");
  let buf = "";
  const listeners = [];
  sock.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i + 1); buf = buf.slice(i + 1); for (const cb of listeners) cb(line); } });
  return { write: (s) => sock.write(s), close: () => sock.end(), onLine: (cb) => listeners.push(cb) };
}

// ── the transport (roamers/vehicleRoamer shape): read() + send(). `client` = a makeMcpiClient (or a stub with the same
// send/sendReceive). Positions are Minecraft world coords (blocks); heading = player yaw (degrees, mcpi convention).
export function makeMinecraftTransport({ client } = {}) {
  if (!client || typeof client.sendReceive !== "function") throw new Error("makeMinecraftTransport: inject an mcpi client");
  const parseVec = (s) => { const [x, y, z] = String(s).split(","); return { x: num(x), y: num(y), z: num(z) }; };

  async function read() {
    const pos = parseVec(await client.sendReceive("player.getPos()"));
    let heading = 0;
    try { const r = await client.sendReceive("player.getRotation()"); const h = num(r, NaN); if (Number.isFinite(h)) heading = h; } catch { /* some servers lack getRotation */ }
    // medium from the block at/under the player's feet, via the shared mcData vocabulary (handles Pi numeric ids AND
    // modern named blocks, and distinguishes water / LAVA / hazard / air — not just water). Hazard beats water beats air.
    let medium = "ground";
    try {
      const feet = mediumOf(await client.sendReceive(`world.getBlock(${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)})`));
      const below = mediumOf(await client.sendReceive(`world.getBlock(${Math.floor(pos.x)},${Math.floor(pos.y) - 1},${Math.floor(pos.z)})`));
      if (feet === "lava" || below === "lava") medium = "lava";
      else if (feet === "hazard") medium = "hazard";
      else if (feet === "water" || below === "water") medium = "water";
      else if (feet === "air" && below === "air") medium = "air";   // standing in air over air = falling
    } catch { /* leave 'ground' */ }
    return { pos, heading, medium, heightAt: (x, z) => heightAt(x, z) };
  }

  // heightAt(x,z) → surface y (mcpi world.getHeight) — the same primitive our morph body's terrain uses.
  async function heightAt(x, z) { const r = await client.sendReceive(`world.getHeight(${Math.floor(x)},${Math.floor(z)})`); return num(r); }

  // send(cmd) — cmd is a structured object OR a "goto?x=..&y=..&z=.." string (carCommands-ish). Setters, no response.
  async function send(cmd) {
    const o = typeof cmd === "string" ? parseCmd(cmd) : (cmd || {});
    if (o.goto && o.goto.x != null) client.send(`player.setPos(${num(o.goto.x)},${num(o.goto.y)},${num(o.goto.z)})`);
    if (o.move) client.send(`player.setPos(${num(o.move.x)},${num(o.move.y)},${num(o.move.z)})`);   // caller precomputes target
    if (o.place && o.place.x != null) client.send(`world.setBlock(${num(o.place.x)},${num(o.place.y)},${num(o.place.z)},${num(o.place.id, 1)})`);
    if (o.say) client.send(`chat.post(${String(o.say).slice(0, 200)})`);
    return { sent: o };
  }
  const parseCmd = (s) => { if (!s.includes("?")) return { [s]: true }; const q = Object.fromEntries(new URLSearchParams(s.slice(s.indexOf("?") + 1))); const verb = s.slice(0, s.indexOf("?")); if (verb === "goto") return { goto: { x: q.x, y: q.y, z: q.z } }; if (verb === "place") return { place: { x: q.x, y: q.y, z: q.z, id: q.id } }; if (verb === "say") return { say: q.msg }; return {}; };

  return { read, send, heightAt, client };
}

// ── a Minecraft ROAMER body (roamers.js "one self, many bodies") ──────────────────────────────────────────────────
import { makeVehicleRoamer } from "./vehicleRoamer.js";
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// salience from the Minecraft read shape { pos, heading, medium, target? }: FALLING/void screams, WATER is moderate,
// a distant target draws the self toward it, telemetry loss is a fault. This is when a voxel body earns the mind.
export function minecraftSalience(st) {
  if (!st || !st.pos) return { salience: 0.7, percept: "minecraft: no telemetry", tags: ["minecraft", "fault"] };
  const m = st.medium || "ground";
  let s = 0.05, why = "on the ground"; const tags = ["minecraft"];
  if (m === "lava") { s = 0.95; why = "in LAVA — burning"; tags.push("hazard", "lava"); }
  else if (m === "hazard") { s = 0.8; why = "on a hazard block"; tags.push("hazard"); }
  else if (m === "air") { s = 0.7; why = "falling / over a void"; tags.push("hazard", "falling"); }
  else if (m === "water") { s = 0.4; why = "in water"; tags.push("water"); }
  if (st.target && st.target.x != null) { const d = Math.hypot(st.target.x - st.pos.x, st.target.z - st.pos.z); if (d > 2) { s = Math.max(s, clamp01(0.2 + d / 100)); why = `en route (${Math.round(d)}m)`; tags.push("moving"); } }
  return { salience: clamp01(s), percept: `minecraft[${m}] ${why}: (${Math.round(st.pos.x)},${Math.round(st.pos.y)},${Math.round(st.pos.z)})`, tags };
}
// map a decision → the mcpi command strings the transport already parses.
export function minecraftCommands(decision) {
  const d = decision, cmds = [];
  if (!d || typeof d !== "object") return cmds;
  if (d.goto && d.goto.x != null) cmds.push(`goto?x=${d.goto.x}&y=${d.goto.y}&z=${d.goto.z}`);
  if (d.place && d.place.x != null) cmds.push(`place?x=${d.place.x}&y=${d.place.y}&z=${d.place.z}&id=${d.place.id != null ? d.place.id : 1}`);
  if (d.say) cmds.push(`say?msg=${encodeURIComponent(String(d.say))}`);
  return cmds;
}
// minecraftRoamer — a first-class fleet body: the roamer hub focuses it when it's falling / in water / en route, and
// pilots ONLY the focused body. Reuses makeVehicleRoamer (the same seam as the drone/car/RC/UE bodies) over the mcpi transport.
export function minecraftRoamer({ id = "voxel", transport, host = "127.0.0.1", port = 4711, connImpl = null, onFault = null } = {}) {
  const t = transport || makeMinecraftTransport({ client: makeMcpiClient({ host, port, connImpl }) });
  return makeVehicleRoamer({ id, kind: "minecraft", transport: t, salience: minecraftSalience, toCommand: minecraftCommands, onFault });
}

// convenience: just the transport (no fleet salience) — for a single-body driver.
export function minecraftBody({ host = "127.0.0.1", port = 4711, connImpl = null, client = null } = {}) {
  const c = client || makeMcpiClient({ host, port, connImpl });
  return { transport: makeMinecraftTransport({ client: c }), client: c };
}
