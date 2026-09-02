// ganglia/embodied.js — NORTH-STAR SKILL-GANGLIA, embodied set (scope #3 of the skill-ganglia mine).
// Fresh capabilities built from scratch on the ganglia contract (see ../ganglia.js for the 3 template examples):
//   • body-adapter (A2 online body-ID)      — retune actuator gain from commanded-vs-actual → grants "body_adapt"
//   • see2act      (B1 active perception)    — reposition to resolve an occlusion            → grants "see2act"
//   • frame-fill   (I2 delay-line WM)        — predictive fill-in of a dropped sensor frame   → grants "frame_fill"
//   • fatigue-gate (F2 fatigue-gated switch) — abandon a stalled pursuit when tired           → grants "fatigue_gate"
//
// All pure / deterministic / dependency-free (no Math.random, no Date.now — the caller supplies any clock/values),
// self-contained (install returns an api; no core reach), each carrying a LOAD-BEARING selfTest that genuinely
// exercises the capability so a broken implementation makes its OWN selfTest return false.

// A2 · BODY-ADAPTER — online body identification / gain retune. Watches commanded-vs-actual motion and estimates the
// multiplicative correction (EWMA of actual/commanded) so a weakened, relabeled, or re-geared actuator is compensated:
// if the body only delivers half of what's commanded, gain() → ~2.0 and the controller can pre-scale its commands.
export const bodyAdapter = {
  name: "body-adapter",
  description: "Online body-ID: estimate the actuator gain correction from commanded-vs-actual motion (EWMA) so a weakened/relabeled actuator is compensated.",
  grants: ["body_adapt"],
  plugsInto: "motor",
  install() {
    let est = 1;        // current gain estimate = commanded / actual (multiply a command by this to hit the target)
    let seen = false;
    const alpha = 0.2;  // EWMA weight on each new sample
    return {
      observe({ commanded, actual } = {}) {
        const c = +commanded, a = +actual;
        if (!isFinite(c) || !isFinite(a) || c === 0 || a === 0) return est; // ignore degenerate samples
        const ratio = c / a;                       // if actual is half of commanded → ratio 2
        est = seen ? est + alpha * (ratio - est) : ratio; // first real sample seeds; then EWMA
        seen = true;
        return est;
      },
      gain() { return +est.toFixed(4); },
      reset() { est = 1; seen = false; },
    };
  },
  selfTest({ api }) {
    api.reset();
    for (let i = 0; i < 60; i++) api.observe({ commanded: 4, actual: 2 }); // body delivers half → gain should climb to ~2
    const weak = Math.abs(api.gain() - 2) < 0.1;
    api.reset();
    for (let i = 0; i < 60; i++) api.observe({ commanded: 3, actual: 3 }); // faithful body → gain ~1
    const faithful = Math.abs(api.gain() - 1) < 0.05;
    api.reset();
    return weak && faithful;
  },
};

// B1 · SEE2ACT — active perception: when a target is hidden behind an occluder, compute the small viewpoint SHIFT that
// would slide the target out from behind it. Bearings in radians (0 = straight ahead, + = right). An occluder spans
// [bearing - width/2, bearing + width/2]; if the target bearing falls inside any span it's occluded, and we step
// toward whichever edge is nearer so the parallax reveals it fastest. If nothing covers the target → { clear:true }.
export const see2act = {
  name: "see2act",
  description: "Active perception: given a target bearing and occluder bearings/widths, return the viewpoint shift (step left/right + magnitude) that reveals a hidden target — or clear if already visible.",
  grants: ["see2act"],
  plugsInto: "perception",
  install() {
    return {
      resolve(target, occluders = []) {
        const t = +(target && target.bearing != null ? target.bearing : target); // accept {bearing} or a number
        let blocker = null;
        for (const o of occluders) {
          const b = +(o && o.bearing != null ? o.bearing : o);
          const w = +(o && o.width != null ? o.width : 0);
          const half = Math.abs(w) / 2;
          if (t >= b - half && t <= b + half) {                 // target falls within this occluder's angular span
            if (!blocker || Math.abs(b - t) < Math.abs(blocker.b - t)) blocker = { b, half };
          }
        }
        if (!blocker) return { clear: true };
        // distance to each edge of the blocker as seen from the target bearing; step toward the nearer edge to exit fastest
        const toLeft = t - (blocker.b - blocker.half);          // >0
        const toRight = (blocker.b + blocker.half) - t;         // >0
        // stepping the VIEWPOINT left shifts occluders' apparent bearing right (parallax): exit past whichever edge is closer
        const dir = toLeft <= toRight ? "left" : "right";
        const magnitude = +Math.min(toLeft, toRight).toFixed(4) || 0.001; // never zero when occluded
        return { clear: false, shift: dir, magnitude, direction: dir === "left" ? -1 : 1 };
      },
    };
  },
  selfTest({ api }) {
    // target dead ahead, a wide occluder centered on it → must return a non-zero directional shift
    const blocked = api.resolve({ bearing: 0 }, [{ bearing: 0, width: 0.6 }]);
    const okBlocked = blocked.clear === false && blocked.magnitude > 0 && (blocked.shift === "left" || blocked.shift === "right");
    // target off to the side, occluder elsewhere → already visible
    const open = api.resolve({ bearing: 1.0 }, [{ bearing: -0.5, width: 0.4 }]);
    const okOpen = open.clear === true;
    return okBlocked && okOpen;
  },
};

// I2 · FRAME-FILL — a short delay-line working memory that predicts a DROPPED sensor frame by linear extrapolation of the
// last few readings. Keeps a small ring of recent values; fill() fits the local trend (slope from the last two, anchored
// on the last value) so a smooth stream survives a missing sample without a stale hold or a hard glitch.
export const frameFill = {
  name: "frame-fill",
  description: "Delay-line working memory: predict a dropped sensor frame by linear extrapolation of the last few numeric readings.",
  grants: ["frame_fill"],
  plugsInto: "perception",
  install() {
    const buf = [];
    const N = 4; // delay-line depth
    return {
      push(value) {
        const v = +value;
        if (!isFinite(v)) return buf.length;
        buf.push(v);
        if (buf.length > N) buf.shift();
        return buf.length;
      },
      fill() {
        if (buf.length === 0) return 0;
        if (buf.length === 1) return buf[0];                 // no trend yet → hold
        // average consecutive slope over the window, then extrapolate one step past the last value
        let slope = 0;
        for (let i = 1; i < buf.length; i++) slope += buf[i] - buf[i - 1];
        slope /= (buf.length - 1);
        return +(buf[buf.length - 1] + slope).toFixed(6);
      },
      reset() { buf.length = 0; },
    };
  },
  selfTest({ api }) {
    api.reset();
    for (const v of [1, 2, 3, 4]) api.push(v);   // linear ramp → next should be ~5
    const ramp = Math.abs(api.fill() - 5) < 1e-6;
    api.reset();
    for (const v of [7, 7, 7]) api.push(v);      // constant → next should be ~7
    const flat = Math.abs(api.fill() - 7) < 1e-6;
    api.reset();
    return ramp && flat;
  },
};

// F2 · FATIGUE-GATE — a fatigue-gated intent switch. effort(cost) accrues fatigue as effort is spent; rest() lets it
// recover. shouldSwitch({progress}) says "abandon this pursuit" only when fatigue is HIGH and progress is LOW — you
// don't quit while fresh, and you don't quit while winning. Time to cut a stalled chase before it drains the body.
export const fatigueGate = {
  name: "fatigue-gate",
  description: "Fatigue-gated intent switch: accrue fatigue on effort / recover on rest → abandon a stalled pursuit only when tired AND not making progress.",
  grants: ["fatigue_gate"],
  plugsInto: "volition",
  install() {
    let fatigue = 0; // 0 = fresh … 1 = spent
    const clamp = (x) => Math.max(0, Math.min(1, x));
    return {
      effort(cost = 0.1) { fatigue = clamp(fatigue + Math.max(0, +cost)); return fatigue; },
      rest(amount = 0.1) { fatigue = clamp(fatigue - Math.max(0, +amount)); return fatigue; },
      fatigue() { return +fatigue.toFixed(4); },
      shouldSwitch({ progress = 0, fatigueThresh = 0.6, progressThresh = 0.2 } = {}) {
        return fatigue >= fatigueThresh && (+progress) < progressThresh;
      },
      reset() { fatigue = 0; },
    };
  },
  selfTest({ api }) {
    api.reset();
    for (let i = 0; i < 10; i++) api.effort(0.15);          // pile up fatigue → spent
    const tiredStalled = api.shouldSwitch({ progress: 0.05 }) === true;   // tired + stalled → switch
    const tiredWinning = api.shouldSwitch({ progress: 0.9 }) === false;   // tired but winning → stay
    api.reset();
    const freshStalled = api.shouldSwitch({ progress: 0.05 }) === false;  // fresh + stalled → don't quit yet
    return tiredStalled && tiredWinning && freshStalled;
  },
};

// The embodied north-star ganglia set.
export const EMBODIED_GANGLIA = [bodyAdapter, see2act, frameFill, fatigueGate];
