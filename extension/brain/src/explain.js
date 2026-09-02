// Decision interpretability: a human-readable "why did I do that" attribution for a turn -- which
// action population won (the vote), the deliberation demand + intent that shaped it, and the mood.
// Fits the auditable "git-for-the-brain" thesis and makes live behaviour debuggable.
export function explainAction({ action, confidence = 0, source = "", intent = "", deliberate = 0, rates = {}, mood = {} } = {}) {
  const ranked = Object.entries(rates).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const parts = [`chose ${action} (conf ${Number(confidence).toFixed(2)}${source ? ", via " + source : ""})`];
  if (action === "QUIET" || ranked.length === 0) {
    parts.push("decision stayed below the action threshold");
  } else {
    const [tn, tv] = ranked[0];
    const rest = ranked[1] ? `${ranked[1][0]} (${ranked[1][1].toFixed(1)})` : "the rest";
    parts.push(`${tn} (${tv.toFixed(1)}) over ${rest}`);
  }
  parts.push(`deliberation ${Number(deliberate).toFixed(2)} [intent: ${intent || "?"}]`);
  if (mood && mood.valence !== undefined) parts.push(`mood v${mood.valence.toFixed(2)}/a${mood.arousal.toFixed(2)}`);
  return parts.join("; ");
}
