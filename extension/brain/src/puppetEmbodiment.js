// puppetEmbodiment.js — the Live2D PUPPET's decider: turn real sensor input (pointer/touch, the user's FACE from the
// camera, mic level, device tilt, taps/pokes/pats) into an avatar DRIVE frame (look-at, lip-sync, body lean, expression,
// affect). This is the "phone as an embodiment SOURCE, beyond a text interface" core ([[own-avatar-project]],
// [[phone-as-go2-analog]]): the same standard Web sensor APIs exist on desktop (mouse/webcam) and in the phone webview
// (touch/phone-camera/motion), so ONE decider drives the puppet from whatever body it's running on.
//
// PURE + portable (brain-side, like selfModel): no DOM, no Cubism — it emits ABSTRACT drive intents (lookX/Y in [-1,1],
// mouthOpen 0..1, bodyLean, a named expression + one-shot motion, an affect vector). The viewer maps those to the actual
// model's params (ParamAngleX/Y, ParamEyeBallX/Y, ParamMouthOpenY, ParamBodyAngleX/Z, ParamBreath) + its expressions/
// motions. So the interaction MODEL is testable headless and reused by every avatar we ever load.

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;

export function makePuppetEmbodiment({
  lookSmoothing = 0.15, micToMouth = 1.2, idleAfterMs = 4000, lonelyAfterMs = 15000,
  affectDecay = 0.01, valenceDecay = 0.006, exprHoldMs = 1400,
  now = () => Date.now(),
} = {}) {
  // raw inputs
  let ptr = { x: 0, y: 0, down: false, active: false };
  let face = { x: 0, y: 0, present: false };
  let mic = 0, tilt = { beta: 0, gamma: 0 };
  let lastInputAt = now();
  // smoothed drive
  let look = { x: 0, y: 0 }, mouth = 0, lean = { x: 0, z: 0 };
  // affect: valence (unhappy↔happy), arousal (calm↔excited), affection (bond, only grows via gentle care)
  let valence = 0, arousal = 0.2, affection = 0;
  // external MOOD baseline — Rook's real neurochemistry readout ([[neuromodulation]] readout(): valence∈(-1,1),
  // arousal∈(0,1)). The live affect eases toward THIS (not a hardcoded 0/0.2), so at rest her face shows her true chem
  // mood; touch gives fast transients on top. No setMood() call → baseVal 0 / baseAro 0.2 (backward compatible).
  let baseVal = 0, baseAro = 0.2, seekTone = 0;
  // transient expression / one-shot motion
  let expr = null, exprUntil = 0, motion = null, motionUntil = 0;
  let patCount = 0, lastPatAt = 0, lastTapAt = 0;

  const mark = () => { lastInputAt = now(); };
  const queue = (e, m, eMs = exprHoldMs, mMs = 800) => { const t = now(); if (e) { expr = e; exprUntil = t + eMs; } if (m) { motion = m; motionUntil = t + mMs; } };

  // ── sensor ingest (each is optional; a body wires only what it has) ──
  function pointer(x, y, down = false) { ptr = { x: clamp(x, -1, 1), y: clamp(y, -1, 1), down: !!down, active: true }; mark(); }
  function pointerOut() { ptr.active = false; ptr.down = false; }
  function faceAt(x, y, present = true) { face = { x: clamp(x, -1, 1), y: clamp(y, -1, 1), present: !!present }; if (present) mark(); }
  function micLevel(level) { mic = clamp(level, 0, 1); if (mic > 0.15) mark(); }
  function tiltTo(beta, gamma) { tilt = { beta: +beta || 0, gamma: +gamma || 0 }; mark(); }
  // setMood — the wire into Rook's 4-chem stack: feed neuromod.readout() so her resting face reflects her true mood.
  function setMood({ valence: v, arousal: a, seeking: s } = {}) {
    if (typeof v === "number" && isFinite(v)) baseVal = clamp(v, -1, 1);
    if (typeof a === "number" && isFinite(a)) baseAro = clamp(a, 0, 1);
    if (typeof s === "number" && isFinite(s)) seekTone = clamp(s, 0, 1);
  }

  // ── discrete interactions (the user touching the puppet) ──
  // tap/poke a hit AREA ("head"/"face" vs "body"). Repeated gentle head taps in quick succession = PATS → affection.
  function tap({ x = 0, y = 0, area = "body" } = {}) {
    mark(); const t = now();
    if (area === "head" || area === "face") {
      arousal = clamp(arousal + 0.35, 0, 1); valence = clamp(valence + 0.08, -1, 1);
      queue("giggle", "flick_head");
      if (t - lastPatAt < 1400) { patCount++; if (patCount >= 2) { affection = clamp(affection + 0.14, 0, 1); valence = clamp(valence + 0.18, -1, 1); queue("happy", null, 1600); } }
      else patCount = 1;
      lastPatAt = t;
    } else {
      arousal = clamp(arousal + 0.18, 0, 1); queue(null, "tap_body");
    }
    // a rapid flurry of taps reads as being prodded → mild annoyance
    if (t - lastTapAt < 250) { valence = clamp(valence - 0.12, -1, 1); queue("annoyed", null); }
    lastTapAt = t;
  }
  // shake/jostle (from device motion or a hard drag) → startle
  function shake(intensity = 1) { mark(); arousal = clamp(arousal + 0.5 * intensity, 0, 1); valence = clamp(valence - 0.18 * intensity, -1, 1); queue("surprised", "startle", 900, 900); }

  // ── the per-frame drive ──
  function tick(/* dt unused: uses wall-clock via now() */) {
    const t = now();
    const idle = t - lastInputAt > idleAfterMs;
    // look target: the user's FACE wins (she looks at YOU), else the pointer, else a slow autonomous idle glance.
    let tx = 0, ty = 0, attending = "present";
    const lonely = t - lastInputAt > lonelyAfterMs;
    if (face.present) { tx = face.x; ty = face.y; attending = "watching-you"; }
    else if (ptr.active) { tx = ptr.x; ty = ptr.y; attending = ptr.down ? "held" : "attentive"; }
    else if (idle) { tx = Math.sin(t * 0.0004) * 0.4; ty = Math.sin(t * 0.00031) * 0.18; attending = lonely ? "lonely" : "idle"; }
    look.x = lerp(look.x, tx, lookSmoothing); look.y = lerp(look.y, ty, lookSmoothing);
    if (ptr.down && ptr.active) arousal = clamp(arousal + 0.006, 0, 1);   // being grabbed keeps her a touch keyed-up

    mouth = lerp(mouth, mic * micToMouth, 0.5);
    lean.x = lerp(lean.x, clamp(tilt.gamma / 30, -1, 1), 0.1);
    lean.z = lerp(lean.z, clamp(-tilt.gamma / 45, -1, 1), 0.1);

    // affect eases back toward baseline (affection does NOT decay — a bond persists). When LONELY (long unattended), she
    // slowly SADDENS: valence drifts negative while arousal settles low — the affect quadrant that reads as wistful, not
    // angry. Any interaction (mark()) resets lastInputAt, so attention lifts her back out of it.
    // eases toward the chem-mood baseline; loneliness pulls valence BELOW the baseline (ignored → wistful, relative to
    // however she already feels), and settles arousal low (sadness is calm, not agitated).
    arousal = lerp(arousal, lonely ? 0.12 : baseAro, affectDecay);
    valence = lonely ? lerp(valence, clamp(baseVal - 0.5, -1, 1), 0.004) : lerp(valence, baseVal, valenceDecay);

    // expression: a live transient wins; otherwise the affect QUADRANT selects across the full range. valence×arousal:
    // +val→happy/love; −val & high arousal→annoyed (hot); −val & low arousal→sad (cold/lonely); arousal spike→surprised.
    let expression = (expr && t < exprUntil) ? expr : null;
    if (!expression) {
      if (affection > 0.6 && valence > 0.12) expression = "love";
      else if (valence > 0.4) expression = "happy";
      else if (valence < -0.28 && arousal >= 0.45) expression = "annoyed";
      else if (valence < -0.2 && arousal < 0.4) expression = "sad";
      else if (arousal > 0.72) expression = "surprised";
      else expression = "neutral";
    }
    const mot = t < motionUntil ? motion : null;

    return {
      lookX: look.x, lookY: look.y,
      mouthOpen: clamp(mouth, 0, 1),
      bodyLeanX: lean.x, bodyLeanZ: lean.z,
      breath: (Math.sin(t * 0.0018) + 1) / 2,
      expression, motion: mot,
      affect: { valence: +valence.toFixed(3), arousal: +arousal.toFixed(3), affection: +affection.toFixed(3), seeking: +seekTone.toFixed(3) },
      attending,
    };
  }

  return { pointer, pointerOut, faceAt, micLevel, tiltTo, setMood, tap, shake, tick, affect: () => ({ valence, arousal, affection, seeking: seekTone }) };
}
