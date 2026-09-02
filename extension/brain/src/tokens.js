// Client-side llama-approximate token estimator (mined from Luminara). Cheap, dependency-free, and
// "good enough" for budgeting/telemetry against an LLM -- charges 1 token for short pieces, else
// ceil(len/3.8), with a char-based fallback.
export function estimateTokens(text) {
  const s = String(text || "");
  if (!s) return 0;
  const pieces = s.match(/[A-Za-z0-9']+|[^\sA-Za-z0-9']/g) || [];
  if (!pieces.length) return Math.ceil(s.length / 4.1);
  let n = 0;
  for (const p of pieces) n += p.length <= 4 ? 1 : Math.ceil(p.length / 3.8);
  return n;
}
