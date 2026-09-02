// vehicleRoamer.js — turn a REMOTE VEHICLE (a piloted drone or RC car) into a ROAMer body for the fleet-attention hub
// ([[roamers.js]]). Bob's ROAMers are "one self, MANY bodies"; this is the concrete bridge for VEHICLES. Each vehicle
// exposes the roamer contract — sense() -> {salience, percept, tags}, act(decision), autopilot(percept) — over a pluggable
// TRANSPORT (read telemetry + send commands). The Liftoff drone (its localhost control server, 127.0.0.1:8788) is the first
// real body; RC cars and real drones (HTTP / MSP / MAVLink) drop in the same way. The mind FOCUSES whichever body's feed is
// most salient (a GPWS scrape, a landing to supervise, a vehicle drifting off-course, a fault) and lets the rest hold on
// their own onboard controllers (autopilot). SALIENCE is the whole point: it decides which body earns the self's attention.
//
// A transport is { read() -> Promise<state>, send(cmd:string) -> Promise<any> }. A decision (from the pilot) is a small
// object like { goto:{x,z}, agl, mode } (drone) or { drive:{throttle,steer} } / { goto:{x,y} } (car); toCommand() maps it
// to the transport's command strings. Everything degrades safely: an unreachable body reports a FAULT salience, not a throw.

const num = (x, d = 0) => (typeof x === "number" && isFinite(x) ? x : d);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const parseD = (status) => { const m = /(?:^|\s)d=([\d.]+)/.exec(status || ""); return m ? parseFloat(m[1]) : 0; };

// ---- HTTP transport (the Liftoff harness server; also any vehicle exposing GET /state + GET /<cmd>?query) ----
export function httpTransport(base = "http://127.0.0.1:8788", { statePath = "/state", fetchImpl = null } = {}) {
  const f = fetchImpl || (typeof fetch === "function" ? fetch : null);
  if (!f) throw new Error("vehicleRoamer.httpTransport: no fetch available (pass fetchImpl)");
  return {
    async read() { const r = await f(base + statePath); if (!r.ok) throw new Error("read " + r.status); return await r.json(); },
    async send(cmd) { const r = await f(base + "/" + String(cmd).replace(/^\//, "")); return r.ok ? await r.json().catch(() => ({})) : null; },
  };
}

// ================= SALIENCE (per kind): how badly does this body need the mind right now? =================

// Drone salience from the Liftoff /state shape: { engaged, seamOk, droneLocked, mode, status, obs:{agl,spd,vsFpm,...} }.
export function droneSalience(st) {
  if (!st) return { salience: 0.7, percept: "drone: no telemetry", tags: ["drone", "fault"] };
  if (st.droneLocked === false) return { salience: 0.75, percept: "drone: no body locked", tags: ["drone", "fault"] };
  const o = st.obs || {};
  const agl = num(o.agl), vs = num(o.vsFpm), spd = num(o.spd);
  const mode = String(st.mode || "-").toLowerCase();
  const d = parseD(st.status);
  let s = 0.05, why = "hovering, nominal"; const tags = ["drone"];

  if (st.engaged === false) { s = Math.max(s, 0.35); why = "disengaged (pilot-in-command)"; tags.push("idle"); }
  if (o.agl != null && agl < 3 && vs < -120) { s = Math.max(s, 0.9); why = "GPWS — low + sinking"; tags.push("hazard"); }
  if (mode.includes("land") || mode.includes("rtl")) { s = Math.max(s, 0.5); why = "auto " + mode.toUpperCase() + " — supervise"; tags.push("supervise"); }
  if (d > 3) { s = Math.max(s, clamp01(0.2 + d / 120)); why = `transiting (${Math.round(d)} m to go)`; tags.push("moving"); }
  if (o.agl != null && agl < 0.6 && spd < 0.6) tags.push("grounded");
  return { salience: clamp01(s), percept: `drone[${mode}] ${why}: agl=${agl.toFixed(0)}m spd=${spd.toFixed(1)}`, tags };
}

// RC car / ground vehicle salience from a generic ground-telemetry shape:
//   { pos:{x,y}, heading, speed, throttle?, obstacle:{front,left,right}, tilt?, battery?, target?, mode? }
export function carSalience(st) {
  if (!st) return { salience: 0.7, percept: "car: no telemetry", tags: ["car", "fault"] };
  const spd = num(st.speed), thr = num(st.throttle);
  const ob = st.obstacle || {};
  const front = num(ob.front, Infinity);
  const tilt = Math.abs(num(st.tilt));
  const batt = st.battery == null ? 1 : num(st.battery, 1);
  const d = st.target ? Math.hypot(num(st.target.x) - num(st.pos && st.pos.x), num(st.target.y) - num(st.pos && st.pos.y)) : 0;
  let s = 0.05, why = "cruising, clear"; const tags = ["car"];

  if (tilt > 35) { s = Math.max(s, 0.95); why = "rollover risk"; tags.push("hazard"); }
  if (front < 1.0) { s = Math.max(s, clamp01(1 - front)); why = `obstacle ahead (${front.toFixed(1)} m)`; tags.push("hazard"); }
  if (Math.abs(thr) > 0.15 && spd < 0.1) { s = Math.max(s, 0.7); why = "stuck (throttle, no motion)"; tags.push("stuck"); }
  if (batt < 0.2) { s = Math.max(s, 0.6); why = `low battery (${Math.round(batt * 100)}%)`; tags.push("low-battery"); }
  if (d > 2) { s = Math.max(s, clamp01(0.2 + d / 60)); why = `en route (${d.toFixed(0)} m)`; tags.push("moving"); }
  return { salience: clamp01(s), percept: `car ${why}: spd=${spd.toFixed(1)} front=${front === Infinity ? "∞" : front.toFixed(1)}`, tags };
}

// ================= COMMAND MAPPING (decision -> transport command strings) =================
export function droneCommands(decision) {
  const d = decision; const cmds = [];
  if (!d || typeof d !== "object") return cmds;
  if (d.recover) cmds.push("recover");
  if (d.goto && d.goto.x != null) cmds.push(`goto?x=${d.goto.x}&z=${d.goto.z}`);
  if (d.agl != null) cmds.push(`climb?agl=${d.agl}`);
  if (d.mode) cmds.push(`mode?m=${d.mode}`);
  if (d.gain) cmds.push(`gain?name=${d.gain.name}&v=${d.gain.v}`);
  return cmds;
}
export function carCommands(decision) {
  const d = decision; const cmds = [];
  if (!d || typeof d !== "object") return cmds;
  if (d.stop) cmds.push("stop");
  if (d.drive) cmds.push(`drive?throttle=${num(d.drive.throttle)}&steer=${num(d.drive.steer)}`);
  if (d.goto && d.goto.x != null) cmds.push(`goto?x=${d.goto.x}&y=${d.goto.y}`);
  return cmds;
}

// ROV / underwater vehicle salience from a submersible-telemetry shape (subROV — Underwater Discoveries and the like):
//   { depth, heading, speed, thrust?, sonar:{front,down}, o2?, battery?, tether?, tilt?, target?, mode?, discovery? }
// The hazards are a submersible's, not a drone's: the SEAFLOOR below (not the ground you land on), a snagged TETHER, an
// over-depth crush limit, and O2/battery on a long dive. A `discovery` cue (something worth logging on the bottom) raises
// salience the POSITIVE way — the reason the ROV is down there at all.
export function rovSalience(st) {
  if (!st) return { salience: 0.7, percept: "rov: no telemetry", tags: ["rov", "fault"] };
  const spd = num(st.speed), depth = num(st.depth);
  const son = st.sonar || {};
  const front = num(son.front, Infinity), down = num(son.down, Infinity);
  const o2 = st.o2 == null ? 1 : num(st.o2, 1);
  const batt = st.battery == null ? 1 : num(st.battery, 1);
  const tether = num(st.tether);                         // 0..1 tension; high = snagging
  const maxDepth = num(st.maxDepth, 300);
  let s = 0.05, why = "holding, clear"; const tags = ["rov"];

  if (tether > 0.8) { s = Math.max(s, 0.92); why = "tether snagging"; tags.push("hazard", "tether"); }
  if (front < 2.0) { s = Math.max(s, clamp01(1 - front / 2)); why = `obstacle ahead (${front.toFixed(1)} m)`; tags.push("hazard"); }
  if (down < 1.5) { s = Math.max(s, clamp01(1 - down / 1.5)); why = `seafloor close (${down.toFixed(1)} m)`; tags.push("hazard", "bottom"); }
  if (depth > maxDepth * 0.95) { s = Math.max(s, 0.9); why = `near crush depth (${depth.toFixed(0)}/${maxDepth} m)`; tags.push("hazard", "depth"); }
  if (o2 < 0.2) { s = Math.max(s, 0.7); why = `low O2 (${Math.round(o2 * 100)}%)`; tags.push("low-o2"); }
  if (batt < 0.2) { s = Math.max(s, 0.6); why = `low battery (${Math.round(batt * 100)}%)`; tags.push("low-battery"); }
  if (st.discovery) { s = Math.max(s, 0.75); why = `discovery: ${String(st.discovery).slice(0, 40)}`; tags.push("discovery"); }
  return { salience: clamp01(s), percept: `rov ${why}: depth=${depth.toFixed(0)}m spd=${spd.toFixed(1)}`, tags };
}
export function rovCommands(decision) {
  const d = decision; const cmds = [];
  if (!d || typeof d !== "object") return cmds;
  if (d.surface) cmds.push("surface");
  if (d.dive && d.dive.depth != null) cmds.push(`dive?depth=${num(d.dive.depth)}`);
  if (d.goto && d.goto.x != null) cmds.push(`goto?x=${d.goto.x}&y=${d.goto.y}&depth=${num(d.goto.depth)}`);
  if (d.scan) cmds.push("scan");
  if (d.hold) cmds.push("hold");
  if (d.recover) cmds.push("recover");
  return cmds;
}

// ---- UE transport (Unreal Engine as an optional external testbed; [[ue5-embodiment]]) ----
// UE is an OPTIONAL external env Rook drives over a socket — exactly like Liftoff (:8788) or BC (:8799), never bundled
// ([[design-optional-capabilities]]). A thin UE-side actor (RemoteControl preset / small Blueprint web actor) exposes
// the SAME contract as the Liftoff harness: GET /state telemetry + GET /<cmd> control. The ONLY thing that differs is
// UNITS — UE is centimetres + degrees + world velocity, the roamer's car model is metres + m/s + a headingInDegrees
// flag. This normalizer pays that unit tax ONCE, at the boundary, so it does not compound downstream (the exactness
// line: a borrowed shape that is off by a scale factor is not "apt", it is wrong). UE raw shape we expect from the actor:
//   { location:{x,y,z}(cm), rotation:{yaw,pitch,roll}(deg), velocity:{x,y,z}(cm/s) | speed(cm/s), forwardHitDistance(cm|<0=none), battery?, target?, mode? }
// Normalised OUT = the generic ground-telemetry shape carSalience/carAdapter already read (metres, m/s, degrees kept).
export function normalizeUEState(raw, { cm = 100 } = {}) {
  if (!raw || typeof raw !== "object") return raw;
  const loc = raw.location || {};
  const rot = raw.rotation || {};
  const vel = raw.velocity || null;
  const speedCm = raw.speed != null ? num(raw.speed) : (vel ? Math.hypot(num(vel.x), num(vel.y)) : 0);
  const hit = raw.forwardHitDistance;
  const front = (hit == null || num(hit, -1) < 0) ? Infinity : num(hit) / cm;      // <0 / missing = no hit = clear (∞)
  const out = {
    pos: { x: num(loc.x) / cm, y: num(loc.y) / cm },
    heading: num(rot.yaw),                                                          // degrees — carAdapter uses headingInDegrees
    speed: speedCm / cm,
    obstacle: { front },
    tilt: Math.max(Math.abs(num(rot.pitch)), Math.abs(num(rot.roll))),
  };
  if (raw.battery != null) out.battery = num(raw.battery, 1);
  if (raw.throttle != null) out.throttle = num(raw.throttle);
  if (raw.target) out.target = raw.target;
  if (raw.mode) out.mode = raw.mode;
  return out;
}

// ueTransport — wrap an underlying transport (default: the RemoteControl HTTP actor) and normalize its telemetry into
// the car shape. send() passes through unchanged (the UE actor speaks the same /<cmd> control strings). Default port
// 30010 is UE RemoteControl's HTTP default — deliberately NOT the Moot ports (8790/8791).
export function ueTransport(base = "http://127.0.0.1:30010", { statePath = "/state", fetchImpl = null, cm = 100, transport = null } = {}) {
  const inner = transport || httpTransport(base, { statePath, fetchImpl });
  return {
    async read() { return normalizeUEState(await inner.read(), { cm }); },
    send: (cmd) => inner.send(cmd),
  };
}

// ================= the roamer factory =================
const KINDS = {
  drone: { salience: droneSalience, toCommand: droneCommands },
  car: { salience: carSalience, toCommand: carCommands },
  rov: { salience: rovSalience, toCommand: rovCommands },
};

// makeVehicleRoamer — wrap a transport into a roamer body. Returns { sense, act, autopilot, meta }.
export function makeVehicleRoamer({ id = "vehicle", kind = "drone", transport, salience, toCommand, autopilot, onFault = null } = {}) {
  if (!transport || typeof transport.read !== "function") throw new Error("makeVehicleRoamer: needs a transport with read()");
  const preset = KINDS[kind] || KINDS.drone;
  const salF = salience || preset.salience;
  const cmdF = toCommand || preset.toCommand;
  let lastState = null;

  return {
    meta: { id, kind },
    async sense() {
      try { lastState = await transport.read(); return salF(lastState); }
      catch (e) { if (onFault) onFault(`vehicleRoamer.${id}.sense`, e); return { salience: 0.8, percept: `${kind}[${id}]: unreachable`, tags: [kind, "fault", "offline"] }; }
    },
    async act(decision) {
      const cmds = cmdF(decision) || [];
      const sent = [];
      for (const c of cmds) { try { await transport.send(c); sent.push(c); } catch (e) { if (onFault) onFault(`vehicleRoamer.${id}.act`, e); } }
      return { id, sent, decision };
    },
    // autopilot: by default the vehicle holds on its OWN onboard controller (the harness keeps station / continues its
    // mission), so the unfocused body needs no command. Override for bodies that must be actively nudged each cycle.
    autopilot: autopilot || (async () => ({ id, held: true })),
    state: () => lastState,
  };
}

// Convenience constructors for the two scaffolded bodies.
export function liftoffDroneRoamer({ id = "drone", base = "http://127.0.0.1:8788", fetchImpl = null, onFault = null } = {}) {
  return makeVehicleRoamer({ id, kind: "drone", transport: httpTransport(base, { fetchImpl }), onFault });
}
export function rcCarRoamer({ id = "car", transport, base = null, fetchImpl = null, onFault = null } = {}) {
  const t = transport || httpTransport(base || "http://127.0.0.1:8799", { fetchImpl });
  return makeVehicleRoamer({ id, kind: "car", transport: t, onFault });
}
// ueVehicleRoamer — a UE Chaos vehicle (TP_VehicleAdv on PCG terrain) as a roamer body. It IS a car body — the same
// salience + command mapping — over a UE transport that normalizes units. This is Track-2 B1: embody Rook in UE by
// reusing the whole car seam; the only UE-specific code is the unit normalizer above. selfModel drives it via
// carAdapter({headingInDegrees:true}); rolloutSearch/vehicleModel plan against its live world-query.
export function ueVehicleRoamer({ id = "ue", base = "http://127.0.0.1:30010", transport = null, fetchImpl = null, cm = 100, onFault = null } = {}) {
  const t = transport ? ueTransport(base, { fetchImpl, cm, transport }) : ueTransport(base, { fetchImpl, cm });
  return makeVehicleRoamer({ id, kind: "car", transport: t, onFault });
}
