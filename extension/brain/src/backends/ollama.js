// Primary backend: local Ollama via its native /api/chat. fetch is injectable for tests.
export function makeOllamaBackend({ url = "http://localhost:11434", model = "llama3", fetchImpl, temperature = null } = {}) {
  const doFetch = fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
  return {
    name: "ollama",
    async generate({ system, messages, options } = {}) {
      if (!doFetch) throw new Error("ollama: no fetch available");
      const body = {
        model,
        messages: [...(system ? [{ role: "system", content: system }] : []), ...(messages || [])],
        stream: false,
        ...(options || {}),
      };
      // Ollama sampling params live under `options`; a configured temperature (e.g. 0 for a deterministic
      // run) is nested there. Deterministic generation collapses the drift probe's noise floor -> real sensitivity.
      if (temperature != null) body.options = { ...(body.options || {}), temperature };
      const res = await doFetch(`${url}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`ollama: HTTP ${res.status}`);
      const data = await res.json();
      return data.message?.content ?? "";
    },
  };
}
