// minecraftRcon.js — drive a MARKER body on a LIVE Minecraft server over RCON (PLAN §B9, the live end). No client, no
// mod: summon a tagged armor-stand marker, read its pos/heading + the block MEDIUM beneath it (via /execute if block),
// and move it by /tp. SAME roamers transport shape as minecraftMcpi (the mcpi/Pi dream seam) AND the same medium
// vocabulary as mcData — so the voxelDream navigator + selfModel drive this UNCHANGED, and what she learned in the dream
// transfers straight onto the real world. Verified against a live NeoForge 1.21.1 server (FTB Skies 2 mods).
//
// Source RCON protocol: TCP, little-endian packets [len][id][type][body\0\0]; auth=type3, command=type2, response
// arrives in order → a FIFO of resolvers. The rcon client is INJECTED into the body, so the body logic is unit-testable
// with a stub and the real socket is verified live.

import net from "node:net";

const num = (x, d = 0) => { const n = parseFloat(x); return Number.isFinite(n) ? n : d; };

// ── real RCON client over a socket. cmd(str) → Promise<responseText>; ready resolves after auth; end() closes. ──
export function makeRconClient({ host = "127.0.0.1", port = 25585, password = "rook" } = {}) {
  let sock, buf = Buffer.alloc(0), authed = false; const q = [];
  const pkt = (id, type, body) => { const b = Buffer.from(body + "\0", "ascii"); const p = Buffer.alloc(12 + b.length); p.writeInt32LE(b.length + 8, 0); p.writeInt32LE(id, 4); p.writeInt32LE(type, 8); b.copy(p, 12); return p; };
  const ready = new Promise((res, rej) => {
    sock = net.createConnection({ host, port });
    sock.on("connect", () => sock.write(pkt(1, 3, password)));
    sock.on("error", rej);
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4) { const len = buf.readInt32LE(0); if (buf.length < 4 + len) break; const rid = buf.readInt32LE(4); const body = buf.slice(12, 4 + len - 2).toString("ascii"); buf = buf.slice(4 + len);
        if (rid === 1 && !authed) { authed = true; res(); } else { const cb = q.shift(); if (cb) cb(body); } }
    });
  });
  return { ready, cmd: (c) => new Promise((res) => { q.push(res); sock.write(pkt(2, 2, c)); }), end: () => sock && sock.end() };
}

// ── the marker BODY: summon / read / send over an injected rcon ({ cmd(str)->Promise<string> }). ──
// Medium vocabulary (water/lava/air/ground) matches mcData, so the dream navigator's `medium === "water"` checks apply.
// walk:true summons a VISIBLE, terrain-standing body (a driven mob) instead of the invisible floating marker — the first
// step on the body-upgrade path (marker → driven mob → CC-turtle → fake-player). NoAI so it doesn't wander off our drive;
// gravity so it stands ON the ground; the runner feeds it surfaceY + a facing yaw so it reads as walking, not teleporting.
export function makeRconBody({ rcon, tag = "rook", block, walk = false, entity = "minecraft:allay" } = {}) {
  if (!rcon || typeof rcon.cmd !== "function") throw new Error("makeRconBody: inject an rcon client with cmd()");
  const sel = `@e[tag=${tag},limit=1]`;
  const parseVec = (s) => { const m = /\[\s*(-?[\d.]+)d,\s*(-?[\d.]+)d,\s*(-?[\d.]+)d\s*\]/.exec(s || ""); return m ? { x: +m[1], y: +m[2], z: +m[3] } : { x: 0, y: 0, z: 0 }; };
  const parseYaw = (s) => { const m = /\[\s*(-?[\d.]+)f/.exec(s || ""); return m ? +m[1] : 0; };
  const passed = (s) => /Test passed/i.test(s || "");
  const at = (dy, blk) => rcon.cmd(`execute positioned as ${sel} if block ~ ${dy} ~ ${blk}`);   // ~ ~dy ~ relative to the marker
  // classify the block medium at ABSOLUTE (x,y,z) + the block below it — the same vocab as read(), for hazard-probing
  // ahead of the marker (the navigator needs to know the ground it's about to walk onto).
  const atAbs = (x, y, z, blk) => rcon.cmd(`execute positioned ${x} ${y} ${z} if block ~ ~ ~ ${blk}`);
  async function classifyAt(x, y, z) {
    if (passed(await atAbs(x, y, z, "minecraft:lava")) || passed(await atAbs(x, y - 1, z, "minecraft:lava"))) return "lava";
    if (passed(await atAbs(x, y, z, "minecraft:water")) || passed(await atAbs(x, y - 1, z, "minecraft:water"))) return "water";
    if (passed(await atAbs(x, y, z, "minecraft:air")) && passed(await atAbs(x, y - 1, z, "minecraft:air"))) return "air";
    return "ground";
  }
  // mediumAt(x,z) — scan a column DOWN from topY to find the surface medium at (x,z): the first non-air layer decides
  // water/lava/ground; nothing solid within `depth` ⇒ "void" (a fall). Used by the live navigator to probe ahead.
  async function mediumAt(x, z, { topY = 100, depth = 24, step = 4 } = {}) {
    for (let y = topY; y >= topY - depth; y -= step) {
      const m = await classifyAt(x, y, z);
      if (m !== "air") return m;
    }
    return "void";
  }
  // surfaceY(x,z) — the y of the first non-air block scanning DOWN (the standable surface). null if none within depth.
  // Lets a WALKING body hug the terrain (stand on the ground) instead of floating at a fixed altitude like the marker.
  async function surfaceY(x, z, { topY = 120, depth = 80, step = 2 } = {}) {
    for (let y = topY; y >= topY - depth; y -= step) {
      if (!passed(await atAbs(x, y, z, "minecraft:air"))) return y;
    }
    return null;
  }

  // summon (or re-summon) the body. Kills any prior one with the tag so read() has exactly one.
  // walk=false: invisible no-gravity armor-stand MARKER (a floating presence). walk=true: a visible NoAI mob that stands
  // on the ground (gravity) and faces where it moves — the driven-mob upgrade.
  const kind = block || (walk ? entity : "minecraft:armor_stand");
  async function summon({ x = 0, y = 100, z = 0 } = {}) {
    await rcon.cmd(`kill ${sel}`);
    const nbt = walk
      ? `{Tags:["${tag}"],NoAI:1b,Silent:1b,PersistenceRequired:1b}`
      : `{Tags:["${tag}"],Marker:1b,NoGravity:1b,Invisible:1b}`;
    return rcon.cmd(`summon ${kind} ${x} ${y} ${z} ${nbt}`);
  }

  // read() → { pos, heading, medium } in the roamers/minecraftMcpi shape. medium from block tests at feet + below.
  async function read() {
    const pos = parseVec(await rcon.cmd(`data get entity ${sel} Pos`));
    const heading = parseYaw(await rcon.cmd(`data get entity ${sel} Rotation`));
    let medium = "ground";
    if (passed(await at("~-1", "minecraft:lava")) || passed(await at("~", "minecraft:lava"))) medium = "lava";
    else if (passed(await at("~-1", "minecraft:water")) || passed(await at("~", "minecraft:water"))) medium = "water";
    else if (passed(await at("~-1", "minecraft:air")) && passed(await at("~", "minecraft:air"))) medium = "air";   // over the void
    return { pos, heading, medium };
  }

  // send(cmd) — structured {goto|move|say|place} OR a "goto?x=..&y=..&z=.." string. Moves the marker by /tp.
  async function send(cmd) {
    const o = typeof cmd === "string" ? parseCmd(cmd) : (cmd || {});
    const t = o.goto || o.move;
    if (t && t.x != null) await rcon.cmd(`tp ${sel} ${num(t.x)} ${num(t.y, 100)} ${num(t.z)}${t.yaw != null ? ` ${num(t.yaw)} 0` : ""}`);
    if (o.say) await rcon.cmd(`say ${String(o.say).slice(0, 200)}`);
    if (o.place && o.place.x != null) await rcon.cmd(`setblock ${num(o.place.x)} ${num(o.place.y)} ${num(o.place.z)} ${o.place.block || "minecraft:stone"}`);
    return { sent: o };
  }
  const parseCmd = (s) => { if (!s.includes("?")) return { [s]: true }; const q = Object.fromEntries(new URLSearchParams(s.slice(s.indexOf("?") + 1))); const v = s.slice(0, s.indexOf("?")); if (v === "goto") return { goto: { x: q.x, y: q.y, z: q.z } }; if (v === "say") return { say: q.msg }; if (v === "place") return { place: { x: q.x, y: q.y, z: q.z, block: q.block } }; return {}; };

  return { summon, read, send, mediumAt, surfaceY, tag, walk };
}

// convenience: connect + a body in one call (for a live run).
export function minecraftRconBody({ host, port, password, tag = "rook" } = {}) {
  const rcon = makeRconClient({ host, port, password });
  return { rcon, body: makeRconBody({ rcon, tag }) };
}
