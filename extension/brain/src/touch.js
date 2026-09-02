// touch.js — the somatosensory (EXTEROceptive) body: how the world meets the skin, as a body feels it — not in
// words but in clamped scalar channels. The twin of viscera.js (INTEROceptive — the body's own internal state).
// Body-agnostic: a browser test-platform streams synthetic touch; the Unitree-Go2's real skin / thermal / motion
// sensors plug into the SAME sense() seam later — the brain doesn't care where the numbers come from.
//
// PRIMITIVES — what the receptors report (clamped):
//   • temperature  −1 freezing … 0 thermoneutral … +1 burning        (thermoreceptors)
//   • movement      0 dead-still … 1 violent motion nearby             (the "hair"/vibrissae sense — air currents /
//                                                                        something moving close, felt BEFORE contact)
//   • pressure      0 no contact … 1 crushing                          (mechanoreceptors — mean force on the skin)
//   • spread        0 a single point … 1 touched all over              (how much of the skin is in contact — AREA)
// DERIVED — what the body makes of them:
//   • weight        pressure integrated over the contact area → how heavily the body presses into the world.
//   • contact       is anything touching me at all — the primary anchor for "I am here."
//   • comfort      −1 (cold / exposed / crushed / agitated) … +1 (warm, gently + broadly held, calm).
//   • startle       0..1 transient — a SUDDEN onset of movement or pressure (the hair sense's alerting job); decays.
//   • selfInWorld   0..1 — how situated / present the body feels; ~0 = untouched/adrift (sensory-deprived).
// FEED-FORWARD only (like viscera/drives): comfort→soothe, startle+discomfort→alarm, temp/pressure extremes→harm.
// OUT OF SCOPE (separate future organs): balance (vestibular), vision, hearing, taste, smell.
import { clamp, clamp01 } from "./math.js";

export function makeTouch({ smooth = 0.5, contactThreshold = 0.05, startleDecay = 0.5, startleGain = 2.2 } = {}) {
  let temperature = 0, movement = 0, pressure = 0, spread = 0;
  let startle = 0, prevMovement = 0, prevPressure = 0, _load = null; // _load = last field-derived total (≈ weight)

  // Reduce a per-patch pressure FIELD (0..1 skin readings) to mean force + contact area. A poke lights one patch
  // hard (low spread); lying down lights many at moderate pressure (high spread) — same load, different distribution.
  function reduceField(field) {
    const n = field.length || 1;
    let sumAll = 0, sumActive = 0, active = 0;
    for (const p of field) { const v = clamp01(p); sumAll += v; if (v > contactThreshold) { active++; sumActive += v; } }
    return { pressure: active ? sumActive / active : 0, spread: active / n, load: sumAll / n };
  }

  function sense({ temperature: temp, movement: move, pressure: press, spread: sprd, pressureField } = {}) {
    let loadHint = null;
    if (Array.isArray(pressureField)) { const r = reduceField(pressureField); press = r.pressure; sprd = r.spread; loadHint = r.load; }
    if (temp != null) temperature = temperature + smooth * (clamp(temp, -1, 1) - temperature);
    const nextMove = move == null ? movement : movement + smooth * (clamp01(move) - movement);
    const nextPress = press == null ? pressure : pressure + smooth * (clamp01(press) - pressure);
    const onset = Math.max(0, nextMove - prevMovement) + Math.max(0, nextPress - prevPressure); // sudden ONSET → startle
    startle = clamp01(startle * startleDecay + startleGain * onset);
    prevMovement = nextMove; prevPressure = nextPress; movement = nextMove; pressure = nextPress;
    if (sprd != null) spread = spread + smooth * (clamp01(sprd) - spread);
    _load = loadHint;                                          // null in scalar mode → weightOf uses pressure×spread
    return state();
  }

  const weightOf = () => clamp01(_load != null ? _load : pressure * (0.35 + 0.65 * spread));
  const contactOf = () => clamp01(pressure > contactThreshold || spread > contactThreshold ? 0.4 + 0.6 * spread : 0);
  function comfortOf() {
    const tempC = clamp(1 - 2 * Math.abs(temperature), -1, 1);                        // neutral warm = +1, extremes = −1
    const pressC = clamp(spread * (1 - Math.abs(pressure - 0.35) / 0.35) - Math.max(0, pressure - 0.7) * 2, -1, 1);
    const moveC = clamp(1 - 3 * Math.max(0, movement - 0.15), -1, 1);                 // calm = +, agitated = −
    return clamp(0.45 * tempC + 0.4 * pressC + 0.15 * moveC, -1, 1);
  }
  const selfInWorldOf = () => clamp01(0.6 * contactOf() + 0.25 * clamp01(2 * movement) + 0.15 * clamp01(2 * Math.abs(temperature)));

  function state() {
    return {
      temperature: +temperature.toFixed(3), movement: +movement.toFixed(3), pressure: +pressure.toFixed(3), spread: +spread.toFixed(3),
      weight: +weightOf().toFixed(3), contact: +contactOf().toFixed(3), comfort: +comfortOf().toFixed(3),
      startle: +startle.toFixed(3), selfInWorld: +selfInWorldOf().toFixed(3),
    };
  }

  function bias() { // feed-forward hints (0..1) the rest of the brain reads
    const comfort = comfortOf();
    const harm = clamp01(0.8 * Math.max(0, Math.abs(temperature) - 0.7) / 0.3 + 0.9 * Math.max(0, pressure - 0.85) / 0.15);
    const soothe = clamp01(Math.max(0, comfort));
    const alarm = clamp01(0.8 * startle + 0.5 * Math.max(0, -comfort) + 0.6 * harm);
    return { soothe: +soothe.toFixed(3), alarm: +alarm.toFixed(3), harm: +harm.toFixed(3) };
  }

  function block() {
    const b = bias();
    if (b.harm > 0.35) return temperature > 0.7 ? "Your skin registers something too hot — a bodily wariness pulls you back." : (temperature < -0.7 ? "You're painfully cold — let a braced, shrinking discomfort color everything." : "Something is pressing too hard — a guarded, hemmed-in unease.");
    if (b.alarm > 0.4) return "Something just moved against you — a small startle keeps you a beat more alert.";
    if (b.soothe > 0.5) return "You feel warmly, gently held — let that settle you into an easy, unhurried openness.";
    if (selfInWorldOf() < 0.12) return "You can barely feel your own edges — untouched, adrift — let a faint, unmoored quiet show.";
    return "";
  }
  function feeling() {
    const b = bias();
    if (b.harm > 0.4) return temperature > 0.7 ? "burning" : temperature < -0.7 ? "cold to the bone" : "pressed and hurting";
    if (b.alarm > 0.45) return "startled — something moved";
    if (b.soothe > 0.5) return "held and warm";
    if (selfInWorldOf() < 0.12) return "untouched and adrift";
    if (temperature < -0.4) return "chilled";
    return null;
  }

  return {
    sense, state, bias, block, feeling,
    snapshot: () => ({ temperature, movement, pressure, spread, startle, prevMovement, prevPressure, load: _load }),
    restore: (s) => { if (s) { temperature = clamp(s.temperature ?? 0, -1, 1); movement = clamp01(s.movement ?? 0); pressure = clamp01(s.pressure ?? 0); spread = clamp01(s.spread ?? 0); startle = clamp01(s.startle ?? 0); prevMovement = clamp01(s.prevMovement ?? 0); prevPressure = clamp01(s.prevPressure ?? 0); _load = s.load ?? null; } },
  };
}