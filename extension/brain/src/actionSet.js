// actionSet.js — back-port of Steam Input / OpenVR IVRInput ACTION-SETS (docs/MINE-steamworks.md §4, the install VDF
// schema, the OpenVR mine). The keystone of the embodiment refactor: decouple LOGICAL actions (steer/throttle/pitch…)
// from PHYSICAL inputs (a body's raw controls/telemetry), so adding a body or a morph MODE becomes a BINDING PROFILE,
// not a bespoke reconciler. selfModelAdapters' three hand-written maps and morphBody's modes both become action-sets.
//
// Four layers, each earned from a specific source:
//   1. VOCABULARY   — the shared logical actions {name,type:digital|analog|vector,default}. One vocab, many bodies.
//   2. ACTION-SET   — a body/mode's binding profile: raw input → logical action, through an ACTIVATOR (the gesture
//      layer from the Steam-install VDFs: Full/Soft/Double/Long press → different logical outputs). Each resolved
//      action carries a `bActive` validity bit (OpenVR) — a body that can't currently produce an action says so.
//   3. LAYERS       — stack an override set on top of a base (OpenVR ActivateActionSetLayer); a layer overrides only
//      the actions it binds. This is `motorGate`/`subsume`'s prioritised override, applied to the INPUT axis.
//   4. SWITCH       — the active set IS the morph: switching action-set = switching body/mode (ActivateActionSet).
//
// PURE: no clock/IO. `now`/edge-history are injected so activators (double/long press) stay testable and deterministic.

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const num = (x, d = 0) => (typeof x === "number" && isFinite(x) ? x : d);

// ── VOCABULARY: the shared logical action names + types (digital/analog/vector). One vocabulary, all bodies bind to it.
export function makeVocabulary(specs = []) {
  const map = new Map();
  for (const s of specs) map.set(s.name, { name: s.name, type: s.type || "analog", default: s.default != null ? s.default : (s.type === "digital" ? false : 0) });
  return {
    has: (n) => map.has(n),
    type: (n) => (map.has(n) ? map.get(n).type : null),
    names: () => [...map.keys()],
    blank() { const o = {}; for (const [n, s] of map) o[n] = { value: s.default, active: false, origin: null }; return o; },
    get: (n) => map.get(n) || null,
  };
}

// ── ACTIVATORS: turn a raw scalar/edge into a gesture-qualified value (the Steam-install VDF Full/Soft/Double/Long).
// An activator sees {raw, now, prev} and returns { fire:bool, value } or null (not firing). Analog passthrough default.
export const activators = {
  Full_Press: ({ raw }) => (raw >= 0.99 ? { fire: true, value: 1 } : { fire: false, value: 0 }),
  Soft_Press: ({ raw }, { lo = 0.15, hi = 0.99 } = {}) => (raw > lo && raw < hi ? { fire: true, value: raw } : { fire: false, value: raw > lo ? raw : 0 }),
  Analog: ({ raw }) => ({ fire: raw !== 0, value: raw }),
  Long_Press: ({ raw, now, prev }, { ms = 400 } = {}) => {
    const heldSince = raw > 0.5 ? (prev && prev.heldSince != null ? prev.heldSince : now) : null;
    const fire = heldSince != null && now - heldSince >= ms;
    return { fire, value: fire ? 1 : 0, state: { heldSince } };
  },
  Double_Press: ({ raw, now, prev }, { withinMs = 350 } = {}) => {
    const down = raw > 0.5, wasDown = prev && prev.down;
    const rising = down && !wasDown;
    const lastRise = prev && prev.lastRise != null ? prev.lastRise : -Infinity;
    const fire = rising && now - lastRise <= withinMs;
    return { fire, value: fire ? 1 : 0, state: { down, lastRise: rising ? now : lastRise } };
  },
};

// ── ACTION-SET: a body/mode's binding profile. bindings: [{ action, input, activator?, opts?, gain?, invert?, group?,
// mode? }]. `input` names the raw field (or a fn(raw)->scalar). `group.mode` records how a cluster is interpreted
// (joystick_move/trigger/dpad…) — carried for introspection/telemetry, not enforced. Resolve maps raw → logical state.
export function makeActionSet({ id = "set", vocabulary, bindings = [], now = () => 0 } = {}) {
  if (!vocabulary) throw new Error("makeActionSet: inject a vocabulary");
  const binds = bindings.map((b) => ({ activator: "Analog", gain: 1, invert: false, opts: {}, ...b }));
  let prevState = new Map();                          // per-binding activator memory (for double/long press)

  function readRaw(raw, b) {
    if (typeof b.input === "function") return num(b.input(raw));
    let v = num(raw[b.input]);
    if (b.invert) v = -v;
    return v * (b.gain || 1);
  }

  // resolve(raw) → { [action]: {value, active, origin} }. Absent bindings keep the vocabulary default (active:false).
  function resolve(raw = {}) {
    const out = vocabulary.blank();
    const t = now();
    for (let i = 0; i < binds.length; i++) {
      const b = binds[i];
      if (!vocabulary.has(b.action)) continue;
      const rawVal = readRaw(raw, b);
      const act = activators[b.activator] || activators.Analog;
      const prev = prevState.get(i) || {};
      const r = act({ raw: rawVal, now: t, prev }, b.opts) || { fire: rawVal !== 0, value: rawVal };
      prevState.set(i, { ...prev, ...(r.state || {}), down: rawVal > 0.5, heldSince: r.state ? r.state.heldSince : prev.heldSince, lastRise: r.state ? r.state.lastRise : prev.lastRise });
      const type = vocabulary.type(b.action);
      const value = type === "digital" ? !!r.fire : (r.fire || r.value !== 0 ? r.value : out[b.action].value);
      out[b.action] = { value, active: true, origin: `${id}:${b.input}${b.activator !== "Analog" ? "/" + b.activator : ""}` };
    }
    return out;
  }
  return { id, resolve, bindings: () => binds, reset: () => { prevState = new Map(); } };
}

// ── ROUTER: a base action-set + stacked LAYERS (override only the actions they bind) + the active-set SWITCH.
// register named sets; activate one as the base (the body/mode = the morph); push/pop layers that override a subset.
export function makeActionRouter({ vocabulary, sets = {}, active = null } = {}) {
  const registry = new Map(Object.entries(sets));
  let baseId = active || (registry.size ? [...registry.keys()][0] : null);
  const layers = [];                                  // [{id, set}] stacked; later overrides earlier

  const define = (id, set) => { registry.set(id, set); if (!baseId) baseId = id; return id; };
  const activate = (id) => { if (registry.has(id)) baseId = id; return baseId; };   // ActivateActionSet = the morph
  const pushLayer = (id) => { if (registry.has(id)) layers.push({ id, set: registry.get(id) }); };
  const popLayer = (id) => { const i = id ? layers.findIndex((l) => l.id === id) : layers.length - 1; if (i >= 0) layers.splice(i, 1); };
  const clearLayers = () => { layers.length = 0; };

  // resolve(raw) → merged logical state: base, then each active layer overrides ONLY the actions it actually bound.
  function resolve(raw = {}) {
    const base = registry.has(baseId) ? registry.get(baseId).resolve(raw) : vocabulary.blank();
    const out = { ...base };
    for (const l of layers) {
      const r = l.set.resolve(raw);
      for (const name of vocabulary.names()) if (r[name] && r[name].active) out[name] = r[name];   // layer overrides bound actions only
    }
    return out;
  }
  // convenience: the plain {action: value} command the deciders/bodies consume (drops the active/origin metadata).
  const command = (raw) => { const s = resolve(raw); const o = {}; for (const n of vocabulary.names()) o[n] = s[n].value; return o; };

  return { define, activate, pushLayer, popLayer, clearLayers, resolve, command, active: () => baseId, layers: () => layers.map((l) => l.id), sets: () => [...registry.keys()] };
}
