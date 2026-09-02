// Fallback backend: the Perchance ai-text-plugin. Only functional inside a Perchance
// generator; a deployment shim adapts the real plugin to { generate(prompt, options) }.
export function makePerchanceBackend({ plugin } = {}) {
  return {
    name: "perchance",
    async generate({ system, messages, options } = {}) {
      if (!plugin || typeof plugin.generate !== "function") throw new Error("perchance: plugin unavailable");
      const prompt = [system, ...(messages || []).map((m) => `${m.role}: ${m.content}`)].filter(Boolean).join("\n");
      return await plugin.generate(prompt, options || {});
    },
  };
}
