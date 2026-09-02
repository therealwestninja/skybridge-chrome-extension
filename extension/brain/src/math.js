// Clamp x into [lo, hi]. Defaults to the common [0, 1] case.
export const clamp = (x, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));
// Clamp to [0, 1] — the common case for levels/probabilities/pressures.
export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
// Safe number coercion: return x if it's a finite number, else the default.
export const num = (x, d = 0) => (typeof x === "number" && isFinite(x) ? x : d);

// --- the brain's regulatory primitives (named so the affect/homeostatic layer is self-documenting) ---
// Exponential moving average: pull `old` a fraction `alpha` of the way toward `target`.
export const ema = (old, target, alpha) => old * (1 - alpha) + target * alpha;
// Additive form of the same (some faculties phrase it as a rate on the gap).
export const relaxToward = (old, target, rate) => old + rate * (target - old);
// Homeostatic decay: pull `level` toward `setpoint` at rate `k` (the neuromodulation/drive pattern).
export const decayTowardSetpoint = (level, setpoint, k) => level - k * (level - setpoint);
