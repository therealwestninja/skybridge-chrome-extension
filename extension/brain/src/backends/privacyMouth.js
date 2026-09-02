// RM1: the privacy router — a wrapper "mouth" that owns the local-vs-cloud decision AND the redaction
// boundary in one testable place, resolving Rook's local-first contradiction (004 point #3: intimate memory
// shipping to a cloud mouth every turn).
//
// The policy is principled, with NO new heuristic to tune: SENSITIVITY = "redaction would fire." The RM2/V2
// redactor already knows what's personal (it mints placeholders for known PII/entities). So:
//   - personal turn + local mouth ready  -> LOCAL, VERBATIM (nothing leaves the machine)
//   - personal turn + no local mouth      -> CLOUD with the REDACTED prompt, then re-hydrate the reply
//   - nothing personal                    -> CLOUD verbatim (best quality, no privacy cost)
//
// It advertises `handlesRedaction: true` so mind.js does NOT double-redact (the router owns it end to end).
export function makePrivacyMouth({ local = null, cloud, redactor } = {}) {
  if (!cloud) throw new Error("privacyMouth: a cloud backend is required");
  const norm = (o) => (typeof o === "string" ? { text: o } : (o || { text: "" }));

  return {
    name: "privacy-mouth",
    handlesRedaction: true,
    // expose the parts for warming / diagnostics
    local, cloud,
    async generate(prompt) {
      // 1. Does this prompt carry personal content? (redactor.applyToPrompt reports `changed`.)
      const applied = redactor && redactor.applyToPrompt ? redactor.applyToPrompt(prompt) : { prompt, changed: false, rehydrate: (t) => t };
      // 2. Personal + a local mouth that's actually loaded -> keep it entirely on-device, verbatim.
      if (applied.changed && local && local.ready && local.ready()) {
        const o = norm(await local.generate(prompt));
        return { ...o, source: o.source || "webllm-local", private: true };
      }
      // 3. Personal but no local mouth -> cloud, but only the REDACTED (placeholdered) prompt leaves; the
      //    reply is re-hydrated so the user still sees the real nouns the provider never saw.
      if (applied.changed) {
        const o = norm(await cloud.generate(applied.prompt));
        return { ...o, text: applied.rehydrate(o.text), source: o.source || "cloud", redacted: true };
      }
      // 4. Nothing personal -> cloud verbatim, full quality.
      return cloud.generate(prompt);
    },
  };
}
