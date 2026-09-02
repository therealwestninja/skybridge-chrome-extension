// raceReactions.js — the VTuber's emotional REACTOR. Rook races Backseat Champions, picks cards, and reads chat; every
// meaningful event (she takes the lead, crashes, a card backfires, chat hypes, a viewer subs) bursts her REAL
// neurochemistry ([[neuromodulation]]) — the SAME 4-chem stack that drives her Live2D face ([[puppet-embodiment]]). So her
// expression is an HONEST readout of how the race + room are actually going, not a scripted animation. It also emits
// throttled COMMENTARY BEATS: hints for the mouth/say layer about what's worth voicing (not every event is spoken).
//
// Design: event(type,data) → apply chem bursts (mood ALWAYS updates) + optionally emit a beat (rate-limited, priority can
// jump the queue). PURE + injectable: a chems-like {burst,tick,readout} and a clock are injected, so the whole race→mood
// mapping is testable headless. A thin BC-telemetry adapter (bcTelemetryToEvents) maps BC's real fields onto these types.
//
// Chem semantics (setpoints da .2 / ne .3 / 5ht .5 / ach .3): dopamine=reward/engagement, norepinephrine=alarm/stress,
// serotonin=warmth/contentment, acetylcholine=focus/attention. Bursts are reactivity-scaled and decay per the chem's k.

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const B = (chem, mag) => ({ chem, mag });   // a burst

// EVENT TABLE — each type → (data) => { bursts, express?, beat?, priority }. express is an abstract puppet expression
// (neutral/happy/love/surprised/annoyed/sad); beat is a short commentary intent. priority 0..3 (3 = always voice).
const EVENTS = {
  // ── her own race ──
  lead_gained:   () => ({ bursts: [B("dopamine", 0.8), B("serotonin", 0.2)], express: "happy",     beat: "took the lead", priority: 2 }),
  lead_lost:     () => ({ bursts: [B("norepinephrine", 0.5), B("dopamine", -0.4)], express: "annoyed", beat: "lost the lead", priority: 2 }),
  overtake:      (d) => ({ bursts: [B("dopamine", 1.3), B("acetylcholine", 0.4)], express: "happy",   beat: `overtook ${d?.who || "a rival"}`, priority: 2 }),
  overtaken:     (d) => ({ bursts: [B("norepinephrine", 0.6), B("dopamine", -0.3)], express: "annoyed", beat: `${d?.who || "someone"} got past`, priority: 1 }),
  crash:         () => ({ bursts: [B("norepinephrine", 1.3), B("dopamine", -0.7), B("acetylcholine", 0.5)], express: "surprised", beat: "crashed", priority: 3 }),
  near_miss:     () => ({ bursts: [B("norepinephrine", 0.7), B("acetylcholine", 0.4)], express: "surprised", beat: "so close", priority: 1 }),
  spin:          () => ({ bursts: [B("norepinephrine", 1.0), B("dopamine", -0.5)], express: "surprised", beat: "spun it", priority: 2 }),
  recovery:      () => ({ bursts: [B("dopamine", 0.5), B("serotonin", 0.1)], express: "happy",     beat: "recovered", priority: 1 }),
  fast_lap:      () => ({ bursts: [B("dopamine", 1.0)], express: "happy",     beat: "fastest lap", priority: 2 }),
  final_lap:     () => ({ bursts: [B("acetylcholine", 0.5), B("norepinephrine", 0.3)], express: null, beat: "last lap", priority: 1 }),
  lap_complete:  (d) => ({ bursts: [B("dopamine", clamp((d?.delta ?? 0) < 0 ? 0.4 : -0.2, -0.4, 0.6))], express: null, beat: null, priority: 0 }),
  win:           () => ({ bursts: [B("dopamine", 1.5), B("serotonin", 0.5)], express: "love",      beat: "WON", priority: 3 }),
  finish:        (d) => { const p = d?.position ?? 5; const good = p <= 3; return { bursts: good ? [B("dopamine", 0.8), B("serotonin", 0.3)] : [B("serotonin", -0.2), B("norepinephrine", 0.2)], express: good ? "happy" : "sad", beat: `finished P${p}`, priority: 3 }; },
  // ── cards ──
  card_offered:  () => ({ bursts: [B("acetylcholine", 0.4)], express: null,   beat: "picking a card", priority: 1 }),
  card_good:     (d) => ({ bursts: [B("dopamine", 0.6), B("acetylcholine", 0.2)], express: "happy", beat: `played ${d?.card || "a card"}`, priority: 1 }),
  card_bad:      (d) => ({ bursts: [B("norepinephrine", 0.4), B("dopamine", -0.3)], express: "annoyed", beat: `${d?.card || "that card"} backfired`, priority: 2 }),
  // ── chat / room ──
  chat_hype:     () => ({ bursts: [B("dopamine", 0.5), B("serotonin", 0.15)], express: "happy",   beat: "chat's hyped", priority: 1 }),
  chat_positive: () => ({ bursts: [B("dopamine", 0.3), B("serotonin", 0.2)], express: null,        beat: null, priority: 0 }),
  chat_negative: () => ({ bursts: [B("serotonin", -0.2), B("norepinephrine", 0.2)], express: null, beat: null, priority: 0 }),
  chat_question: (d) => ({ bursts: [B("acetylcholine", 0.35)], express: null,  beat: d?.text ? `answer: ${d.text}` : "answering chat", priority: 2 }),
  viewer_sub:    (d) => ({ bursts: [B("dopamine", 0.5), B("serotonin", 0.35)], express: "love",    beat: `thank ${d?.who || "them"} for the sub`, priority: 3 }),
  viewer_doing_well: () => ({ bursts: [B("serotonin", 0.2), B("dopamine", 0.2)], express: "happy",  beat: "they're doing great", priority: 1 }),
  viewer_doing_badly: () => ({ bursts: [B("serotonin", -0.1)], express: "sad",  beat: "rooting for them", priority: 1 }),
};

export function makeRaceReactor({ chems, onReact = null, beatCooldownMs = 4000, now = () => Date.now() } = {}) {
  if (!chems || typeof chems.burst !== "function") throw new Error("makeRaceReactor: inject a neuromodulation-like { burst, readout }");
  let lastBeatAt = -Infinity;

  // event(type, data) → burst her chemistry, decide an expression, and (rate-limited) surface a commentary beat.
  function event(type, data = {}) {
    const make = EVENTS[type];
    if (!make) return null;
    const r = make(data) || {};
    for (const b of r.bursts || []) chems.burst(b.chem, b.mag);
    const t = now();
    // beat gating: priority 3 always fires; else only if the cooldown has elapsed (don't narrate every micro-event).
    let beat = r.beat || null;
    if (beat && (r.priority >= 3 || t - lastBeatAt >= beatCooldownMs)) lastBeatAt = t;
    else beat = null;
    const out = { type, express: r.express || null, beat, priority: r.priority ?? 0, data };
    if (onReact) { try { onReact(out); } catch { /* a witness never breaks the reactor */ } }
    return out;
  }

  return { event, types: () => Object.keys(EVENTS) };
}

// bcTelemetryToEvents — thin adapter: fold a BC telemetry delta (prev vs now) into reactor event types. Field names are
// mapped conservatively; unknown fields are ignored. Returns an array of [type, data] to feed the reactor in order.
export function bcTelemetryToEvents(prev, now) {
  const evts = [];
  if (!prev || !now) return evts;
  const rank = (x) => (typeof x.position === "number" ? x.position : typeof x.rank === "number" ? x.rank : null);
  const pr = rank(prev), nr = rank(now);
  if (pr != null && nr != null && nr !== pr) {
    if (nr === 1 && pr > 1) evts.push(["lead_gained", {}]);
    else if (pr === 1 && nr > 1) evts.push(["lead_lost", {}]);
    else if (nr < pr) evts.push(["overtake", { who: now.passed }]);
    else evts.push(["overtaken", { who: now.passedBy }]);
  }
  if (!prev.crashed && now.crashed) evts.push(["crash", {}]);
  if (!prev.spun && now.spun) evts.push(["spin", {}]);
  if (now.lap != null && prev.lap != null && now.lap > prev.lap) evts.push(["lap_complete", { delta: now.lapDelta }]);
  if (!prev.finalLap && now.finalLap) evts.push(["final_lap", {}]);
  if (now.fastestLap && !prev.fastestLap) evts.push(["fast_lap", {}]);
  if (!prev.finished && now.finished) evts.push([now.position === 1 ? "win" : "finish", { position: now.position }]);
  if (now.cardPicked && now.cardPicked !== prev.cardPicked) evts.push([now.cardGood === false ? "card_bad" : "card_good", { card: now.cardPicked }]);
  return evts;
}
