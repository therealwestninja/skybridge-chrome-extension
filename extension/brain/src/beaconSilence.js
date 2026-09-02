// beaconSilence.js — EMISSION DISCIPLINE / "go dark" (Cluster J). The wartime complement to our radio-free
// capability beacon (kinship.js). Provenance: Bobiverse — the Others HOME ON your transmissions ("Food always
// thus announces itself"), and a hunted Bob shuts down every active system to vanish. Where kinship.js makes a body
// ANNOUNCE its capabilities so kin can find it, this module decides WHEN to stop announcing, because the same signal
// that recruits an ally also draws a hunter.
//
// MECHANISM (deterministic, dependency-free):
//   • assess(signals) — a "being-hunted" detector. Fuses { threat, trackedDetected, pursuit, addressedByHostile }
//     into a hunted scalar in [0,1]. When SUSTAINED high (p-consecutive debounce, like guard.js) it enters SILENT
//     mode; when SUSTAINED calm it exits — with hysteresis (enter bar > exit bar) so a signal hovering near the line
//     doesn't chatter, and a debounce so one blip never toggles.
//   • emit(kind) — the GATE the beacon broadcaster calls before any active emission. In SILENT mode, non-essential
//     ACTIVE emissions (beacon, ping, s016 active SUDDAR sweeps) are suppressed; ESSENTIAL safety emissions
//     (halt/estop/distress) ALWAYS pass — going dark must never cost you the ability to scream that you're stopping.
//   • sensingMode() — "active" when open, "passive" when silent: perception must stop illuminating the dark to
//     listen in it.
//   • setMode() — manual override (open|silent|auto); "auto" hands control back to assess().
//
// Style matches guard.js (p-consecutive debounce) and governor.js (clamp01, snapshot/restore, no Math.random/Date.now).
const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0));

// Essential emissions that must fire even when dark — safety/liability signals, not capability advertising.
const ESSENTIAL = new Set(["halt", "estop", "e-stop", "distress", "mayday", "sos"]);

export function makeBeaconSilence({
  enterThreshold = 0.6,   // hunted scalar at/above this counts as a "hunted" tick
  exitThreshold = 0.3,    // hunted scalar at/below this counts as a "calm" tick (< enter ⇒ hysteresis band)
  enterP = 2,             // consecutive hunted ticks required to GO DARK (debounce — one blip never trips it)
  exitP = 3,              // consecutive calm ticks required to COME BACK (slower to re-emit than to hide)
  essential = ESSENTIAL,  // kinds that always emit, even in silent mode
} = {}) {
  const isEssential = (kind) => essential.has(String(kind || "").toLowerCase());

  let mode = "open";          // effective mode: "open" | "silent"
  let control = "auto";       // "auto" (assess() drives) | "open" | "silent" (manual pin)
  let huntedStreak = 0;       // consecutive hunted ticks (debounce state)
  let calmStreak = 0;         // consecutive calm ticks

  // Fuse the being-hunted cues into one [0,1] scalar. Discrete "I am observed / addressed by a hostile" facts are
  // strong evidence and floor the score; graded threat/pursuit add on top.
  const huntedScore = (signals = {}) => {
    const threat = clamp01(signals.threat);
    const pursuit = clamp01(signals.pursuit);
    const tracked = signals.trackedDetected ? 1 : 0;
    const addressed = signals.addressedByHostile ? 1 : 0;
    // Graded evidence, averaged; discrete "you have been SEEN" facts each floor the result high.
    const graded = (threat + pursuit) / 2;
    let score = graded;
    if (tracked) score = Math.max(score, 0.7);
    if (addressed) score = Math.max(score, 0.85);
    // A body that is both graded-threatened AND confirmed-tracked is unambiguously hunted.
    if (tracked && graded >= 0.3) score = Math.max(score, 0.9);
    return clamp01(score);
  };

  const applyDebounce = (hunted) => {
    if (hunted >= enterThreshold) { huntedStreak += 1; calmStreak = 0; }
    else if (hunted <= exitThreshold) { calmStreak += 1; huntedStreak = 0; }
    else { huntedStreak = 0; calmStreak = 0; } // in the hysteresis band: neither confirms — hold state, decay streaks
    if (control === "auto") {
      if (mode === "open" && huntedStreak >= enterP) mode = "silent";
      else if (mode === "silent" && calmStreak >= exitP) mode = "open";
    }
  };

  return {
    // The being-hunted detector. `signals`: { threat 0-1, trackedDetected bool, pursuit 0-1, addressedByHostile bool }.
    // Updates the debounce streaks and (in auto control) may flip mode. Returns the full read for tracing.
    assess(signals = {}) {
      const hunted = huntedScore(signals);
      applyDebounce(hunted);
      return {
        mode,
        silent: mode === "silent",
        hunted: +hunted.toFixed(3),
        huntedStreak,
        calmStreak,
        sensing: mode === "silent" ? "passive" : "active",
      };
    },

    // The GATE. Wire this into the beacon broadcaster / active pinger BEFORE any transmission. In silent mode all
    // non-essential ACTIVE emissions are suppressed; essential safety emissions always pass. Returns {allow, reason}.
    emit(kind = "beacon") {
      if (mode !== "silent") return { allow: true, reason: "open" };
      if (isEssential(kind)) return { allow: true, reason: "essential-override" };
      return { allow: false, reason: "silent" };
    },

    // Perception discipline: illuminate-the-dark active sensing in the open; passive listen-only when dark.
    sensingMode() { return mode === "silent" ? "passive" : "active"; },

    // Manual override. "open"/"silent" PIN the mode (assess() no longer flips it); "auto" hands control back and
    // resets the debounce so the next few assess() ticks re-decide cleanly.
    setMode(m) {
      if (m === "open" || m === "silent") { control = m; mode = m; huntedStreak = 0; calmStreak = 0; }
      else if (m === "auto") { control = "auto"; huntedStreak = 0; calmStreak = 0; }
      return mode;
    },

    // Read-only helpers.
    mode() { return mode; },
    silent() { return mode === "silent"; },
    control() { return control; },

    snapshot() { return { mode, control, huntedStreak, calmStreak }; },
    restore(s) {
      if (!s) return;
      if (s.mode === "open" || s.mode === "silent") mode = s.mode;
      if (s.control === "auto" || s.control === "open" || s.control === "silent") control = s.control;
      huntedStreak = Math.max(0, s.huntedStreak | 0);
      calmStreak = Math.max(0, s.calmStreak | 0);
    },
  };
}
