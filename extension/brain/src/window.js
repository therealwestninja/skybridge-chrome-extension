// Token-budget context windowing ("treadmill"): keep the newest conversation turns whole within a
// token budget and drop older ones. Safe because the executive's orientation preserves "where we
// started" even after old turns are trimmed. Token count is a cheap chars/4 estimate.
export function countTokens(text) {
  return Math.ceil(String(text == null ? "" : text).length / 4);
}

export function windowHistory(history, { maxTokens = 1500, keepMin = 2 } = {}) {
  const msgs = history || [];
  const kept = [];
  let sum = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const t = countTokens(msgs[i].content);
    if (kept.length >= keepMin && sum + t > maxTokens) break;
    kept.push(msgs[i]);
    sum += t;
  }
  const win = kept.reverse();
  // Don't begin mid-pair: if the trim left a leading assistant turn (its user turn was dropped),
  // drop it so the window starts on a user turn and user->assistant pairs stay coherent.
  if (win.length > 1 && win[0].role === "assistant") win.shift();
  return win;
}
