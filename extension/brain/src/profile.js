// The end-user's self-authored profile -- a "Hero Profile" / "Dating Profile" / character sheet the
// PERSON fills in, which Rook reads for context. Generic and flexible (any labeled fields), and
// privacy-friendly (the user chooses what to share; nothing is inferred). Rendered into the system
// prompt as "who you're talking with". This is the mirror of persona.js, which is ROOK's identity.
const LABELS = {
  name: "Name", pronouns: "Pronouns", about: "About them", interests: "Interests",
  goals: "Goals", style: "Preferred style", boundaries: "Boundaries",
};

// Suggested fields for a UI form; the store accepts any keys, so a "Hero"/"Dating"/etc. sheet works.
export const PROFILE_FIELDS = Object.keys(LABELS);

export function renderProfile(profile = {}) {
  const lines = [];
  for (const [k, v] of Object.entries(profile)) {
    const val = (v == null ? "" : String(v)).trim();
    if (!val) continue;
    const label = LABELS[k] || (k.charAt(0).toUpperCase() + k.slice(1));
    lines.push(`- ${label}: ${val}`);
  }
  return lines.length ? "About the person you're talking with:\n" + lines.join("\n") : "";
}
