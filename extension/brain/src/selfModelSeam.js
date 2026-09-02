// selfModelSeam.js — the reusable actuation seam around a predictive self-model (selfModel.js).
//
// The self-model is body-agnostic arithmetic. THIS is the thin glue that a real body ticks: it owns the parts every
// body shares — the Phase-0 observe-only latch, the half-rate predict-on-skip-frame cadence, the confidence→governor
// application, passport persistence, and a residual log — and it delegates the two body-specific things to an
// ADAPTER: how to read this body's state/command, and how to apply the governor to this body's controls. A new body
// is an adapter, not a new seam. (Spec: "the actuation seam is the only body-specific glue; everything else is pure
// arithmetic.")
//
// THE ADAPTER CONTRACT (all synchronous, all pure of the seam's concerns):
//   readState()            -> { x, z, heading, speed }     the body's measured pose+speed, in the organ's frame
//   readCommand()          -> { steer, accel, brake }      the command last issued, mapped to the organ's vocabulary
//   applyGovern(gov, out)  -> void                          scale this body's aggression/gain by gov (0..~1.2); optional
//   applyPredicted(pred)   -> void                          (optional) on a SKIP frame, drive the body from the dead-
//                                                            reckoned pose instead of a fresh reading — the half-rate win
//   ── OPTIONAL, for discontinuities ─────────────────────────────────────────────
//   setMode(reason)        -> void       set frame/route context FIRST; selects which anchor set to search
//   nearestAnchor(state)   -> pose|null  re-derive pose from the WORLD (nearest known anchor), not by integrating
//   replan(reason)         -> void       rebuild the plan against the re-derived pose
//   freeze()               -> void       stop the body before a reset
//   reseedMotion(minSpeed) -> void       re-seed motion NON-ZERO in the body's own frame
//   zeroActuation()        -> void       drop stale commands so none survives the discontinuity
//
// OBSERVE-BEFORE-IT-STEERS is a hard latch, not a suggestion. In observe mode the seam computes and LOGS the residual
// every frame but NEVER calls applyGovern — the spec's Phase 0, mandatory before the model touches control, because a
// model that cries wolf on every corner or misses real slides must be caught on a bench, not on a wall.
//
// Pure of I/O itself (the adapter does all reading/writing); no clock (the caller drives the tick). Deterministic.

import { makeSelfModel } from "./selfModel.js";
import { clamp01, num } from "./math.js";

// Why a body's continuity broke. The frame/route mode a body selects on re-localization usually depends on WHICH of
// these happened, so the reason is passed through rather than flattened to a boolean.
export const RESET_REASON = Object.freeze({
  Spawn: "Spawn",
  LostPath: "LostPath",
  NoContact: "NoContact",
  BodySwap: "BodySwap",
  WorldRebuild: "WorldRebuild",
  Resume: "Resume",
});

export function makeSelfModelSeam({
  adapter,                       // REQUIRED — the body-specific glue (contract above)
  model = null,                  // pass a pre-configured makeSelfModel(), else one is made from `modelOpts`
  modelOpts = {},
  observeOnly = true,            // PHASE-0 LATCH. Defaults SAFE: the seam observes and never steers until told otherwise.
  halfRate = false,              // sample real state every other tick; dead-reckon the skip tick from the forward model
  logSize = 240,                 // residual ring for the Phase-0 "does it track reality?" proof (≈4 s at 60 Hz)
} = {}) {
  if (!adapter || typeof adapter.readState !== "function" || typeof adapter.readCommand !== "function")
    throw new Error("selfModelSeam: adapter must provide readState() and readCommand()");
  const m = model || makeSelfModel(modelOpts);
  let observe = !!observeOnly;
  let n = 0;                     // tick counter, for the half-rate cadence
  const log = [];                // ring of { residual, confidence, grip, event, steered }

  const record = (out, steered) => {
    log.push({ residual: out.residual, confidence: out.confidence, grip: out.grip, event: out.event, steered });
    if (log.length > logSize) log.shift();
  };

  // Re-localization after a discontinuity: DISCARD the old estimate and re-derive from the world, in order —
  //   1. set frame/mode context (selects which anchor set is valid)
  //   2. re-derive pose from world anchors, not by integrating
  //   3. invalidate memos keyed on the old estimate
  //   4. replan against the new pose
  //   5. suppress residual accumulation for the next real step (else a teleport poisons online system-ID)
  const relocalize = (reason = RESET_REASON.Spawn) => {
    if (typeof adapter.setMode === "function") adapter.setMode(reason);

    let anchored = null;
    if (typeof adapter.nearestAnchor === "function") {
      let probe = null;
      try { probe = adapter.readState(); } catch { probe = null; }
      anchored = adapter.nearestAnchor(probe) || null;
    }

    delete adapter.readState.__last;
    delete adapter.readCommand.__last;

    if (typeof adapter.replan === "function") adapter.replan(reason);

    m.suppressNext();
    n = 0;                     // restart the half-rate cadence on a real sample, not a skip frame
    return { reason, anchored, suppressed: true };
  };

  // A body reset is a TRANSACTION over the whole body, in dependency order — not a pose assignment. Every stage is
  // optional (an adapter implements what its body has), but the ORDER is not.
  //
  // Two stages are easy to omit and both bite:
  //   • reseedMotion(minSpeed) re-seeds motion at a small NON-ZERO value in the body's own frame. A body reset to
  //     exactly zero reads as "not making progress" to a progress watchdog, which instantly re-arms the failsafe
  //     that just fired.
  //   • the trouble watch is suppressed across the reset, for the same reason. The CALLER releases it
  //     (troubleWatch.suppress(false)) when recovery actually completes — we do not guess when that is.
  //
  // The learned passport is deliberately NOT cleared: a discontinuity changes where a body is, not what it is.
  const resetBody = (reason = RESET_REASON.Spawn, { supervisor = null, bodyId = null, troubleWatch = null, minSpeed = 0.5 } = {}) => {
    const stages = [];

    if (supervisor && bodyId != null && typeof supervisor.clearCap === "function") {
      supervisor.clearCap(bodyId);
      stages.push("supervisorReleased");
    }
    if (troubleWatch && typeof troubleWatch.suppress === "function") {
      troubleWatch.suppress(true);
      stages.push("troubleSuppressed");
    }
    if (typeof adapter.freeze === "function") { adapter.freeze(); stages.push("frozen"); }
    if (typeof adapter.reseedMotion === "function") {
      adapter.reseedMotion(Math.max(1e-6, num(minSpeed, 0.5)));
      stages.push("motionReseeded");
    }
    if (typeof adapter.zeroActuation === "function") { adapter.zeroActuation(); stages.push("actuationZeroed"); }
    const rl = relocalize(reason);
    stages.push("relocalized");

    return { reason, stages, anchored: rl.anchored, suppressed: true };
  };

  return {
    // One control tick. Returns the model's output (predicted/residual/confidence/aggression/grip/event) plus
    // `steered` — whether the governor was actually applied (false in observe mode, always, by design).
    tick() {
      n++;
      const skip = halfRate && (n % 2 === 0);
      if (skip) {
        // SKIP FRAME — no fresh perception. Roll the forward model on the last real state+command and, if the body
        // wants it, drive from that dead-reckoned pose. This is the half-the-sampling-still-responsive win, and the
        // exact mechanism that later hides a laggy wire: the body keeps moving smoothly between sparse real updates.
        const pred = m.predict(adapter.readState.__last || { x: 0, z: 0, heading: 0, speed: 0 }, adapter.readCommand.__last || {});
        if (!observe && typeof adapter.applyPredicted === "function") adapter.applyPredicted(pred);
        return { skipped: true, predicted: pred, steered: false };
      }
      const state = adapter.readState();
      const command = adapter.readCommand();
      adapter.readState.__last = state;               // stash for the next skip frame's dead-reckoning
      adapter.readCommand.__last = command;
      const out = m.step(state, command);
      let steered = false;
      if (!observe && typeof adapter.applyGovern === "function") { adapter.applyGovern(out.aggression, out); steered = true; }
      record(out, steered);
      return { ...out, steered };
    },

    // Phase-0 proof surface: did the residual stay small on clean stretches and spike on the bad ones?
    report() {
      const withR = log.filter((e) => e.residual);
      if (!withR.length) return { samples: log.length, ready: false };
      const mags = withR.map((e) => e.residual.mag);
      const mean = mags.reduce((a, b) => a + b, 0) / mags.length;
      const max = Math.max(...mags);
      const events = log.filter((e) => e.event).map((e) => e.event.kind);
      return {
        samples: log.length, ready: withR.length > 10,
        residualMean: +mean.toFixed(5), residualMax: +max.toFixed(5),
        confidence: m.confidence(), grip: m.grip(),
        steeredFraction: +(log.filter((e) => e.steered).length / log.length).toFixed(3),
        events: events.reduce((acc, k) => ((acc[k] = (acc[k] || 0) + 1), acc), {}),
        observeOnly: observe,
      };
    },

    // Lift the Phase-0 latch — ONLY after report() shows the residual tracks reality. The caller owns this decision.
    enableControl() { observe = false; },
    observeOnly: () => observe,
    passport: () => m.passport(),
    load: (p) => m.load(p),
    model: () => m,
    reset() { m.reset(); n = 0; log.length = 0; delete adapter.readState.__last; delete adapter.readCommand.__last; },
    relocalize,
    resetBody,
  };
}
