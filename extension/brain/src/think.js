// Reasoning-model chain-of-thought handling (mined from the WebGPU Qwen3 extension). Separates the
// model's <think>...</think> inner monologue from the spoken answer, and (opt-in) steers thinking
// on/off per turn -- which ties naturally to Rook's two-speed routing (deliberate -> /think).
const THINK_RE = /^\s*<think>([\s\S]*?)(<\/think>|$)/;

// Returns { thinking, answer }. Whitespace-robust and safe on a still-streaming, unterminated <think>.
export function splitThink(text) {
  const s = String(text);
  const m = s.match(THINK_RE);
  if (!m) return { thinking: "", answer: s.trim() };
  return { thinking: m[1].trim(), answer: s.slice(m[0].length).trim() };
}

// Prepend /think or /no_think to steer a Qwen-style reasoning model, gated on the deliberation demand.
export function steerThink(message, deliberate, { threshold = 0.4 } = {}) {
  return `${deliberate >= threshold ? "/think" : "/no_think"} ${message}`;
}
