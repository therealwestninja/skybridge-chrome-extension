// WebGPU in-browser LLM backend (mined from the "Private Qwen Chat Agent" extension). Runs a quantized
// model FULLY LOCALLY via @mlc-ai/web-llm -- no Node, no Ollama, no server (solves the machine
// constraint: local generation with zero runtime). OpenAI-compatible. The engine loader is injectable
// so Node tests use a mock and never pull the multi-MB library.
export function makeWebLLMBackend({ model = "Qwen3-1.7B-q4f16_1-MLC", load, engineOptions = {} } = {}) {
  let engine = null;
  const loader = load || (async () => {
    const { CreateMLCEngine } = await import("https://esm.run/@mlc-ai/web-llm");
    return CreateMLCEngine(model, engineOptions);
  });
  const ensure = async () => (engine || (engine = await loader()));

  return {
    name: "webllm",
    private: true,                 // RM1: runs fully on-device -> the privacy router may send personal content verbatim
    ready: () => !!engine,         // sync gate: has the model finished loading? (router checks before routing local)
    ensureReady: ensure,           // warm at extension idle (cold load ~10-40s); never block a turn on it
    async available() { try { await ensure(); return true; } catch { return false; } },
    async generate({ system = "", messages = [], options = {} } = {}) {
      const eng = await ensure();
      const msgs = [...(system ? [{ role: "system", content: system }] : []), ...messages.map((m) => ({ role: m.role, content: m.content }))];
      const temperature = options.temperature ?? 0.7;
      // Streaming with per-chunk cooperative abort + token callback (mirrors the mined extension).
      if (options.onToken || options.stream) {
        const stream = await eng.chat.completions.create({ messages: msgs, stream: true, temperature });
        let text = "";
        for await (const chunk of stream) {
          if (options.abort && options.abort()) break;
          const delta = chunk.choices?.[0]?.delta?.content || "";
          if (delta) { text += delta; if (options.onToken) options.onToken(delta); }
        }
        return text;
      }
      const res = await eng.chat.completions.create({ messages: msgs, temperature });
      return res.choices?.[0]?.message?.content || "";
    },
  };
}
