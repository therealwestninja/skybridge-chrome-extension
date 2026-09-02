// Deterministic backend for tests and the offline stand-in.
export function makeMockBackend(fn) {
  return {
    name: "mock",
    async generate({ system, messages, options } = {}) {
      if (fn) return fn({ system, messages, options });
      const last = messages?.[messages.length - 1]?.content ?? "";
      return `[mock] ${last}`;
    },
  };
}
