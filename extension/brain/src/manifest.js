// manifest.js — the portable CAPABILITY PASSPORT + a radio-free BEACON codec. The north-star is "one self, any body":
// a brain is the same being whether it runs a Go2, a UAV, a submersible, or a text box. For that to matter socially,
// two brains must be able to answer "what are you, and what can you do?" WITHOUT a shared radio or network — think a
// disaster site with no comms. So each brain carries a manifest (a body-agnostic descriptor of its identity + abilities
// + reaction timescale), and can emit it as a BEACON: a short string of symbols from a tiny fixed alphabet that ANY
// body can render through the channel it happens to have — a Go2 chirps it, a UAV blinks it, a sub pings it, a text
// brain prints it — and any other brain decodes through its ordinary senses. No radio, no registry, no network.
//
// The capability vocabulary is a frozen shared contract so "fly" means the same bit to every brain; that's what lets a
// flyer (UAV) and a diver (sub) be coordinated by the SAME logic — they differ only in which capability bits are set
// and in their reaction TIMESCALE. Extends the GroundAct capability model (arxiv-mine-v6 Cluster I) into a shared,
// emittable language. Deterministic, dependency-free.

// The FROZEN capability contract. Order is the bit order — append only, never reorder or remove (it is a wire format).
export const CAPABILITY_VOCAB = [
  "speak", "listen", "text", "beacon", "relay",           // communication  (relay = can pass a message between two bots — a human-free comms bridge)
  "see", "range", "localize", "sense_heat", "sense_gas",  // perception     (heat/gas = disaster-relevant senses)
  "move_ground", "fly", "dive", "climb", "swim",          // locomotion     (fly=UAV, dive=sub — same coordination, different timescale)
  "grasp", "lift", "carry", "tow",                        // manipulation
  "map", "plan", "lead", "compute", "power_share",        // cognition / logistics
];
const CAP_INDEX = new Map(CAPABILITY_VOCAB.map((c, i) => [c, i]));

// Reaction-speed classes — the ONLY thing that really separates a UAV from a sub: how fast the control loop must close.
export const TIMESCALES = ["reflexive", "fast", "deliberate", "textual"]; // ~ms / ~100ms / ~seconds / turn-based

const fnv = (s) => { let h = 0x811c9dc5; const t = String(s); for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; };
const hex = (n, width) => (n >>> 0).toString(16).padStart(width, "0").slice(-width);
const capMask = (caps) => { let m = 0; for (const c of caps || []) { const i = CAP_INDEX.get(c); if (i != null) m |= (1 << i); } return m >>> 0; };
const maskCaps = (m) => CAPABILITY_VOCAB.filter((_, i) => (m >>> i) & 1);

// A portable passport. `kind` is the model/species ("sweetie-go2", "scout-uav", "text-brain"); `embodiment` a coarse
// class; `capabilities` a subset of the vocab; `capacities` graded numbers (e.g. {lift: 5} kg); `creed` an optional
// values/allegiance tag (so two DIFFERENT kinds can still recognize each other as aligned). kindCode/idCode/creedCode
// are precomputed hashes so a decoded beacon (which only carries the codes) compares directly against a full manifest.
export function makeManifest({ id, name = "", kind = "unknown", embodiment = "textual", capabilities = [], capacities = {}, timescale = "textual", creed = "" } = {}) {
  const caps = [...new Set(capabilities.filter((c) => CAP_INDEX.has(c)))];
  return {
    id: id ?? "brain-" + hex(fnv(name + kind + caps.join(",")), 8),
    name, kind, embodiment, capabilities: caps, capacities: { ...capacities }, timescale, creed,
    kindCode: fnv(kind) & 0xFFF, creedCode: creed ? (fnv(creed) & 0xFFF) : 0,
    get idCode() { return fnv(this.id) & 0xFF; },
  };
}

// Encode a manifest as a radio-free beacon: a versioned, dot-delimited string of hex symbols (alphabet = 16 symbols,
// renderable as chirps/blinks/pings/glyphs). Layout: B1.<kind:3>.<ts:1>.<caps:6>.<creed:3>.<id:2>  — ~16 symbols total.
export function encodeBeacon(manifest, interaction = 0) {
  const m = manifest;
  const ts = Math.max(0, TIMESCALES.indexOf(m.timescale));
  // PB-4: a 7th field carries the node's live INTERACTION signal (0..1 → 0..255), how much the user is bodily engaging
  // THIS device. It's the wake-arbitration term (electLead). Appended, so a 6-field decoder ignores it (backward-compat).
  const inter = Math.max(0, Math.min(255, Math.round((Number(interaction) || 0) * 255)));
  return ["B1", hex(m.kindCode ?? (fnv(m.kind) & 0xFFF), 3), hex(ts, 1), hex(capMask(m.capabilities), 6), hex(m.creedCode ?? 0, 3), hex((fnv(m.id) & 0xFF), 2), hex(inter, 2)].join(".");
}

// Decode a perceived beacon back into a peer descriptor. kind/id/creed survive only as CODES (the lossy radio-free
// broadcast), but capabilities + timescale decode exactly — which is all recognition and delegation actually need.
export function decodeBeacon(beacon) {
  const p = String(beacon || "").trim().split(".");
  if (p[0] !== "B1" || p.length < 6) return null;
  const kindCode = parseInt(p[1], 16), ts = parseInt(p[2], 16), mask = parseInt(p[3], 16), creedCode = parseInt(p[4], 16), idCode = parseInt(p[5], 16);
  if ([kindCode, ts, mask, creedCode, idCode].some((x) => Number.isNaN(x))) return null;
  const interaction = p.length >= 7 ? (parseInt(p[6], 16) || 0) / 255 : 0;   // PB-4: optional 7th field; absent on old 6-field beacons → 0
  return { fromBeacon: true, kindCode, timescale: TIMESCALES[ts] || "textual", capabilities: maskCaps(mask), creedCode, idCode, interaction };
}
