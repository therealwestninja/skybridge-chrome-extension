// ueRemoteControl.js — the LIVE UE transport: speaks Unreal Engine's RemoteControl HTTP API (PUT /remote/object/call
// on :30010) so a real editor/PIE Chaos vehicle becomes a body Rook drives. Confirmed live 2026-08-04 against
// UE_5.8's Vehicle Template (read PlayerStart transform, enumerated actors).
//
// REUSE-FIRST — this is ONLY the protocol layer. It deliberately produces/consumes the shapes the existing UE stack
// already speaks, so NOTHING above it is new:
//   • read() returns the RAW UE shape {location,rotation,velocity,forwardHitDistance} that `normalizeUEState`
//     (vehicleRoamer.js) already converts cm→m / degrees. → `ueTransport({transport: this})` wraps it unchanged.
//   • send(cmd) PARSES the very command strings `carCommands()` already emits ("drive?throttle=..&steer=..","stop")
//     and translates them to RC input calls. → `ueVehicleRoamer` / `carAdapter` / `roamers` / `selfModel` sit on top,
//     untouched. The UE-specific surface is confined to this file (the endpoints + the two shape maps).
//
// FAIL-DEGRADED (this is capability, not safety): a network/HTTP error surfaces as a throw from read()/send(), which
// makeVehicleRoamer already catches into a FAULT salience — an unreachable editor reports a fault, never crashes the
// fleet. The safety-CLOSED decisions live upstream (motorGate / abilities blocking-tags), not in the transport.
//
// The default RC input functions target a Chaos vehicle movement component:
//   SetThrottleInput(Throttle) · SetSteeringInput(Steering) · SetBrakeInput(Brake) · SetHandbrakeInput(Handbrake)
// and read the body via the Actor functions K2_GetActorLocation · K2_GetActorRotation · GetVelocity.

const num = (x, d = 0) => (typeof x === "number" && isFinite(x) ? x : d);

// low-level: one RemoteControl function call. PUT /remote/object/call → { ReturnValue, ... } | { errorMessage }.
export function makeRcClient({ base = "http://127.0.0.1:30010", fetchImpl = null, passphrase = null } = {}) {
  const f = fetchImpl || (typeof fetch === "function" ? fetch : null);
  if (!f) throw new Error("ueRemoteControl: no fetch available (pass fetchImpl)");
  const headers = { "Content-Type": "application/json", ...(passphrase ? { Passphrase: passphrase } : {}) };

  async function call(objectPath, functionName, parameters = {}, { generateTransaction = false } = {}) {
    const r = await f(base + "/remote/object/call", { method: "PUT", headers, body: JSON.stringify({ objectPath, functionName, parameters, generateTransaction }) });
    if (!r.ok) throw new Error(`rc-call ${functionName} ${r.status}`);
    const j = await r.json().catch(() => ({}));
    if (j && j.errorMessage) throw new Error("rc:" + j.errorMessage);
    return j;
  }
  // batch several calls in ONE request (/remote/batch) — used for the 3-call telemetry read.
  async function batch(requests) {
    const body = { Requests: requests.map((rq, i) => ({ RequestId: i + 1, URL: "/remote/object/call", Verb: "PUT", Body: { objectPath: rq.objectPath, functionName: rq.functionName, parameters: rq.parameters || {}, generateTransaction: false } })) };
    const r = await f(base + "/remote/batch", { method: "PUT", headers, body: JSON.stringify(body) });
    if (!r.ok) throw new Error("rc-batch " + r.status);
    const j = await r.json().catch(() => ({}));
    return (j && j.Responses) ? j.Responses.map((x) => x.ResponseBody || x.Body || {}) : [];
  }
  // convenience: enumerate the level's actors (the editor-world helper used to FIND the vehicle pawn's path).
  async function listActors() {
    const j = await call("/Script/UnrealEd.Default__EditorActorSubsystem", "GetAllLevelActors");
    return Array.isArray(j.ReturnValue) ? j.ReturnValue : [];
  }
  // call a function EXPOSED ON A PRESET. Runs in the actor's OWN world → reaches the PIE-spawned pawn (unlike a raw
  // object call bound to the editor world) AND bypasses the function allow-list (exposure IS the authorization).
  async function presetCall(preset, func, parameters = {}, { generateTransaction = false } = {}) {
    const r = await f(`${base}/remote/preset/${encodeURIComponent(preset)}/function/${encodeURIComponent(func)}`, { method: "PUT", headers, body: JSON.stringify({ Parameters: parameters, GenerateTransaction: generateTransaction }) });
    if (!r.ok) throw new Error(`rc-preset ${func} ${r.status}`);
    const j = await r.json().catch(() => ({}));
    if (j && j.errorMessage) throw new Error("rc:" + j.errorMessage);
    return j;
  }
  return { call, batch, presetCall, listActors, base };
}

// makeRemoteControlTransport — a { read, send } transport (the shape makeVehicleRoamer/ueTransport expect), backed by
// RemoteControl. `pawnPath` is the vehicle actor's object path; `movementPath` its Chaos movement component (defaults
// to the template's "<pawn>.VehicleMovementComp"). read() assembles the RAW UE shape; send() translates carCommands().
// useBatch defaults FALSE: single /remote/object/call is LIVE-PROVEN (UE_5.8, 2026-08-04). /remote/batch's response
// envelope is NOT yet validated against a live editor (the server went down mid-check), so batch stays opt-in until
// proven — we do not default onto an unverified shape (the exactness line). Flip useBatch:true once validated live.
export function makeRemoteControlTransport({ base = "http://127.0.0.1:30010", pawnPath, movementPath = null, fetchImpl = null, passphrase = null, rc = null, useBatch = false, fns = {} } = {}) {
  if (!pawnPath) throw new Error("makeRemoteControlTransport: pawnPath (the vehicle actor) is required");
  const client = rc || makeRcClient({ base, fetchImpl, passphrase });
  const move = movementPath || `${pawnPath}.VehicleMovementComp`;
  // function/param names are overridable so a differently-authored pawn can be adapted without editing this file.
  const F = {
    location: "K2_GetActorLocation", rotation: "K2_GetActorRotation", velocity: "GetVelocity",
    throttle: "SetThrottleInput", steering: "SetSteeringInput", brake: "SetBrakeInput", handbrake: "SetHandbrakeInput",
    pThrottle: "Throttle", pSteering: "Steering", pBrake: "Brake", pHandbrake: "Handbrake", ...fns,
  };

  // issue N calls as one batch (opt-in) or as proven sequential singles (default). Returns the raw responses.
  async function many(reqs) {
    if (useBatch) return client.batch(reqs);
    const out = [];
    for (const rq of reqs) out.push(await client.call(rq.objectPath, rq.functionName, rq.parameters || {}));
    return out;
  }

  // RAW UE shape (cm / degrees / cm·s⁻¹) — normalizeUEState converts it. forwardHitDistance is omitted (no line-trace
  // over RC yet) ⇒ normalizeUEState treats it as ∞ = clear; an obstacle sense is a later add (a trace actor or depth).
  async function read() {
    const [rl, rr, rv] = await many([
      { objectPath: pawnPath, functionName: F.location },
      { objectPath: pawnPath, functionName: F.rotation },
      { objectPath: pawnPath, functionName: F.velocity },
    ]);
    const loc = (rl && rl.ReturnValue) || {}, rot = (rr && rr.ReturnValue) || {}, vel = (rv && rv.ReturnValue) || {};
    return {
      location: { x: num(loc.X), y: num(loc.Y), z: num(loc.Z) },
      rotation: { yaw: num(rot.Yaw), pitch: num(rot.Pitch), roll: num(rot.Roll) },
      velocity: { x: num(vel.X), y: num(vel.Y), z: num(vel.Z) },
    };
  }

  // send(cmd) — cmd is a carCommands() string. Translate to RC input calls on the movement component.
  async function send(cmd) {
    const s = String(cmd || "");
    const q = s.includes("?") ? Object.fromEntries(new URLSearchParams(s.slice(s.indexOf("?") + 1))) : {};
    if (s.startsWith("stop")) {                                     // full stop: cut throttle, full brake, wheels straight
      return many([
        { objectPath: move, functionName: F.throttle, parameters: { [F.pThrottle]: 0 } },
        { objectPath: move, functionName: F.brake, parameters: { [F.pBrake]: 1 } },
        { objectPath: move, functionName: F.steering, parameters: { [F.pSteering]: 0 } },
      ]);
    }
    if (s.startsWith("drive")) {                                    // drive?throttle=..&steer=..[&brake=..]
      return many([
        { objectPath: move, functionName: F.throttle, parameters: { [F.pThrottle]: num(+q.throttle) } },
        { objectPath: move, functionName: F.steering, parameters: { [F.pSteering]: num(+q.steer) } },
        { objectPath: move, functionName: F.brake, parameters: { [F.pBrake]: num(+q.brake, 0) } },
      ]);
    }
    // unknown command shape ⇒ no-op (do NOT guess an actuation).
    return null;
  }

  return { read, send, client, pawnPath, movementPath: move };
}

// makeRcPresetTransport — the RECOMMENDED live transport (Option A). Speaks a RemoteControl PRESET that exposes two
// functions on a placed BRIDGE actor: a STATE getter and a DRIVE setter. Why this over a raw object call: a preset
// function runs in the BRIDGE ACTOR'S world, so during PIE it reaches the runtime-spawned player pawn (a raw
// /remote/object/call binds to the EDITOR world and can't see it); and exposure bypasses the function allow-list.
//
// MAXIMUM-REUSE BY DESIGN: the bridge's two verbs ARE the universal contract every other body already speaks
// (BC :8799, Liftoff :8788 — a `state` read + a `drive` command). So read() returns the SAME raw UE shape
// normalizeUEState converts, and send() parses the SAME carCommands() strings — `ueTransport`→`ueVehicleRoamer`→
// `carAdapter`→`roamers`/`selfModel` sit on top UNCHANGED. UE becomes a peer body in the fleet; an RC car / drone is
// the same integration again with a different transport URL.
//
// The bridge's RookState is expected to output Location(Vector,cm) / Rotation(Rotator,deg) / Velocity(Vector,cm·s⁻¹),
// and RookDrive to take Throttle/Steer/Brake floats. Function/output names are overridable via `map`.
//
// ENVELOPE NOT-YET-LIVE-VALIDATED: the preset function RESPONSE shape is parsed leniently (top-level keys, or a nested
// ReturnedValues[0]) and will be LOCKED once validated against the real actor — same exactness discipline as /batch.
export function makeRcPresetTransport({ base = "http://127.0.0.1:30010", preset, fetchImpl = null, passphrase = null, rc = null, map = {} } = {}) {
  if (!preset) throw new Error("makeRcPresetTransport: preset name is required");
  const client = rc || makeRcClient({ base, fetchImpl, passphrase });
  const M = {
    stateFn: "RookState", driveFn: "RookDrive",
    oLocation: "Location", oRotation: "Rotation", oVelocity: "Velocity",
    pThrottle: "Throttle", pSteer: "Steer", pBrake: "Brake", ...map,
  };
  const num = (x, d = 0) => (typeof x === "number" && isFinite(x) ? x : d);
  // pull the function outputs from whatever envelope RC uses (top-level keys, or ReturnedValues[0]) — LOCKED to
  // ReturnedValues[0] as seen live (UE_5.8, 2026-08-04), top-level kept as a fallback. Keys are TRIMMED because UE
  // preset output pins can carry trailing spaces ("Rotation ") — an exact-match lookup would silently miss them.
  const outputs = (j) => {
    const raw = (j && j.ReturnedValues && j.ReturnedValues[0]) ? j.ReturnedValues[0] : (j || {});
    const out = {};
    for (const k of Object.keys(raw)) out[String(k).trim()] = raw[k];
    return out;
  };

  async function read() {
    const o = outputs(await client.presetCall(preset, M.stateFn));
    const loc = o[M.oLocation] || {}, rot = o[M.oRotation] || {}, vel = o[M.oVelocity] || {};
    return {
      location: { x: num(loc.X), y: num(loc.Y), z: num(loc.Z) },
      rotation: { yaw: num(rot.Yaw), pitch: num(rot.Pitch), roll: num(rot.Roll) },
      velocity: { x: num(vel.X), y: num(vel.Y), z: num(vel.Z) },
    };
  }

  async function send(cmd) {
    const s = String(cmd || "");
    const q = s.includes("?") ? Object.fromEntries(new URLSearchParams(s.slice(s.indexOf("?") + 1))) : {};
    if (s.startsWith("stop")) return client.presetCall(preset, M.driveFn, { [M.pThrottle]: 0, [M.pSteer]: 0, [M.pBrake]: 1 });
    if (s.startsWith("drive")) return client.presetCall(preset, M.driveFn, { [M.pThrottle]: num(+q.throttle), [M.pSteer]: num(+q.steer), [M.pBrake]: num(+q.brake, 0) });
    return null;   // unknown command ⇒ no-op, never guess an actuation
  }

  return { read, send, client, preset };
}

// ueVehiclePresetRoamer — the one-liner: a UE Chaos vehicle (behind the bridge preset) as a car body in the fleet.
// Reuses ueVehicleRoamer entirely; only the transport differs. This is what joins UE to BC/Liftoff/RC/drone as a peer.
export function ueVehiclePresetRoamer({ id = "ue", base = "http://127.0.0.1:30010", preset = "RookBridge", fetchImpl = null, cm = 100, map = {}, onFault = null } = {}) {
  const transport = makeRcPresetTransport({ base, preset, fetchImpl, map });
  return { transport };   // caller wraps via ueVehicleRoamer({ id, transport, cm, onFault }) — kept explicit to avoid a circular import
}
