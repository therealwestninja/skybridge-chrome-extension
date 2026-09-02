// modStat.js — the UNIFIED modifier primitive for Mindscape (Diablo-II ItemStatCost.txt analog). ONE stat registry +
// ONE deterministic resolver that EVERY future consumer folds its modifiers through: building affixes (affixEngine.js),
// agent/champion mods (MonUMod), skill effects/synergies, wonders. Author the schema ONCE; four consumers reuse it.
//
// DESIGN LINEAGE (see MEMORY [[mindscape-diablo2-mine]]):
//   • D2's ItemStatCost defines every stat ONCE {id, min, max, op, cap, stackRule}; items/skills/auras/gems/monster
//     mods/char-stats all resolve through that one table + one stacking model. modStat.js IS that table+model in JS.
//   • Reconciles the parked WoW-aura + DPS-multiplicative-bucket ideas ([[emotional-range-outward-register]]): those
//     needed a DATA SCHEMA to hang mods on. This is it. A WoW aura = a mod with source=auraId; a DPS "% increased" =
//     an op:"pct" mod; a "more" multiplier = op:"mult". The bucket-fold below is exactly their stacking math.
//
// STACKING MODEL (D2 / WoW order): within a stat, ADDITIVE bucket sums first ("+X" flat and "+X% increased" pct that
// stack additively among themselves), THEN MULTIPLICATIVE bucket multiplies the running value ("more"/"mult", each its
// own factor). Formula:  final = clampToCap( (base + Σadd) · Π(1 + pct_i) · Π(mult_j) ), optional soft-cap curve first.
//   op "add"  → flat additive        (goes in the additive bucket as +value)
//   op "pct"  → additive-percent      (goes in the additive-percent bucket; folded as base·(1+Σpct)) — D2 "increased"
//   op "mult" → separate multiplier   (each its own ·(1+value) OR ·value; see multMode) — D2 "more" / WoW "more"
//
// PURE + DETERMINISTIC: no Date / Math.random. Object key iteration is insertion-order stable; we sort where it matters.
// Same mods (any order) ⇒ same finalStats. resolve() is commutative within each bucket (sums/products), so mod order
// never changes the result — a hard requirement for the byte-identical snapshot.

const num = (x, d = 0) => (typeof x === "number" && isFinite(x) ? x : d);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ── the STARTER registry of cognition VISUAL stats (what building affixes drive today). Each: ──
//   id        stable stat key (the join key between a mod and its registry row)
//   base      the value when NO mods apply (the "unaffixed" building)
//   min,max   hard clamp AFTER folding (the cap; min is the floor)
//   op        the stat's NATURAL op — informational/default; a mod may override per-mod (mods carry their own op)
//   softCap   optional { at, k }: above `at`, excess is compressed by 1/(1+k·excess) (diminishing returns) BEFORE clamp
//   stackRule "fold" (default: bucket-fold add→pct→mult) | "max" (take the largest single mod) | "sum" (plain add, no pct/mult)
//   multMode  "factor" (mult value used as ·value, e.g. 1.5) | "increment" (·(1+value), e.g. 0.5 → ·1.5). Default "increment".
//   wrap      optional { mod }: wrap the final into [0, mod) instead of clamping (for HUE, which is circular 0..360)
const REGISTRY = {
  // tintHue — circular hue in degrees (0..360). Affixes NUDGE hue by add; wraps rather than clamps.
  tintHue:        { base: 210, min: 0, max: 360, op: "add",  stackRule: "fold", wrap: { mod: 360 } },
  // heightScale — multiplier on the base building height (1 = unchanged). "Towering" affixes push it up; capped so no
  // single landmark dwarfs the city. softCap tempers stacked height before the hard cap.
  heightScale:    { base: 1,   min: 0.5, max: 3.0, op: "mult", stackRule: "fold", softCap: { at: 1.8, k: 1.2 } },
  // glowIntensity — 0 (dark) .. 2 (blazing). Additive glow affixes ("Gleaming", "Luminous"); the renderer maps to emission.
  glowIntensity:  { base: 0,   min: 0, max: 2, op: "add", stackRule: "fold" },
  // salienceRadius — how far a building's presence reaches (nav/attention footprint), in voxels. base 6, up to 40.
  salienceRadius: { base: 6,   min: 2, max: 40, op: "add", stackRule: "fold", softCap: { at: 24, k: 0.5 } },
  // weathering — 0 (pristine) .. 1 (ancient ruin). "Ancient"/"Crumbling" affixes raise it; historical facts start high.
  weathering:     { base: 0,   min: 0, max: 1, op: "add", stackRule: "fold" },
  // tintSat — colour saturation 0..1 (grey → vivid). Rare/unique tiers push vividness so monuments read as special.
  tintSat:        { base: 0.6, min: 0, max: 1, op: "add", stackRule: "fold" },
};

/** register(id, spec) — add/override a stat definition (later consumers extend the registry: agent power, skill dials). */
export function register(id, spec) { REGISTRY[String(id)] = { base: 0, min: -Infinity, max: Infinity, op: "add", stackRule: "fold", ...spec }; return REGISTRY[id]; }
/** statDef(id) — read a stat's definition (or undefined). */
export function statDef(id) { return REGISTRY[id]; }
/** registry() — the whole map (read-only view; callers must not mutate). */
export function registry() { return REGISTRY; }

// soft-cap curve: values above `at` are compressed — excess/(1+k·excess) — so stacking yields diminishing returns
// without a hard wall. Below `at` the value is untouched. Applied BEFORE the hard [min,max] clamp.
function applySoftCap(v, softCap) {
  if (!softCap) return v;
  const { at, k } = softCap;
  if (v <= at) return v;
  const excess = v - at;
  return at + excess / (1 + num(k, 1) * excess);
}

/**
 * resolve(mods, opts?) → finalStats  — THE one resolver.
 *   mods : [{ stat, value, op?, source? }]  — op defaults to the stat's registry op. Unknown stats are ignored (safe).
 *   opts.only : optional array of stat ids to compute (else every stat that has a base in the registry OR a mod).
 * Returns a plain object { statId: number } with EVERY touched stat folded + clamped. Deterministic + commutative.
 */
export function resolve(mods = [], opts = {}) {
  const list = Array.isArray(mods) ? mods : [];
  // bucket mods by stat id
  const byStat = new Map();
  for (const m of list) {
    if (!m || typeof m.stat !== "string") continue;
    const id = m.stat;
    if (!byStat.has(id)) byStat.set(id, []);
    byStat.get(id).push(m);
  }
  // which stats to output: the explicit `only`, else every registered stat plus any stat a mod touched.
  const only = Array.isArray(opts.only) ? opts.only : null;
  const ids = new Set(only || [...Object.keys(REGISTRY), ...byStat.keys()]);

  const out = {};
  for (const id of ids) {
    const def = REGISTRY[id] || { base: 0, min: -Infinity, max: Infinity, op: "add", stackRule: "fold" };
    const ms = byStat.get(id) || [];
    let v;
    if (def.stackRule === "max") {
      // take the single largest contribution over base (e.g. "highest aura wins" semantics)
      let best = 0; for (const m of ms) best = Math.max(best, num(m.value));
      v = num(def.base) + best;
    } else if (def.stackRule === "sum") {
      // plain additive, ignore op distinctions
      let s = 0; for (const m of ms) s += num(m.value);
      v = num(def.base) + s;
    } else {
      // "fold" (default): additive bucket, then additive-percent bucket, then separate multipliers (D2/WoW order)
      let add = 0, pct = 0; const mults = [];
      for (const m of ms) {
        const op = m.op || def.op || "add";
        const val = num(m.value);
        if (op === "add") add += val;
        else if (op === "pct") pct += val;                 // additive-percent: sum, applied as base·(1+Σpct)
        else if (op === "mult") mults.push(val);           // separate multiplier
        else add += val;                                    // unknown op → treat as flat add (safe)
      }
      v = (num(def.base) + add) * (1 + pct);
      const incMode = def.multMode !== "factor";            // default "increment": val 0.5 ⇒ ·1.5
      for (const f of mults) v *= incMode ? (1 + f) : f;
    }
    v = applySoftCap(v, def.softCap);
    if (def.wrap && isFinite(def.wrap.mod)) {
      const mod = def.wrap.mod; v = ((v % mod) + mod) % mod;  // circular wrap (hue)
    } else {
      v = clamp(v, num(def.min, -Infinity), num(def.max, Infinity));
    }
    out[id] = v;
  }
  return out;
}

export default { register, statDef, registry, resolve };
