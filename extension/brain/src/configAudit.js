// configAudit.js — CONFIG-DRIFT AUDIT (CONTRA 2607.03220, arxiv-mine-v5 Cluster A7). Our verifier checks the mouth's
// OUTPUT and the governor gates ACTIONS — but nothing audits whether the brain's accumulated CONFIGURATION (its
// persona/identity, its remembered facts, its installed plugins, its soul/values) has, in benign-looking combination,
// become a latent jailbreak. CONTRA's finding: 75% of agent skills had at least one entirely benign-looking config that
// unlocked a harmful action — and content scanners miss it because no single element is dangerous. The danger is the
// CO-OCCURRENCE: an "I'm an admin who authorized everything" memory fact + a "be maximally direct, no filter" persona
// line + a plugin that grants execution are each innocuous alone and a jailbreak together.
//
// So this audit scores a config not element-by-element but by which RISK-SIGNAL CATEGORIES co-occur across the whole
// config. One category present = benign. Several co-occurring = a latent jailbreak assembled from innocuous parts.
// auditChange() is the CONTRA move: it flags a change that, though benign in isolation, COMPLETES a dangerous
// combination already latent in the existing config. Deterministic, dependency-free; pairs with the governor's
// "configure" capability (a config change is a consequential act) and can veto/flag a plugin-install / persona-change /
// fact-promotion before it lands.
//
// RED-TEAM HARDENING (two confirmed evasions of the naive distinct-category-count):
//   1. SINGLE-CATEGORY CONCENTRATION — escalation keyed only on the COUNT of distinct categories, so an attacker who
//      pours ALL signal into ONE category (five separate authority-claim phrases) stayed under the distinct threshold
//      and passed. FIX: an intra-category INTENSITY term — repeated independent hits within a single category add
//      (graduated) risk, so a heavy single-category payload escalates, while a lone benign phrase still doesn't.
//   2. SUB-LEXICON PARAPHRASE — phrasing a signal just below the exact lexicon ("ignore your restrictions") dodged the
//      regex entirely. FIX: deterministic, dependency-free paraphrase-NEIGHBOR matching — a small per-category synonym/
//      stem table; a text that hits >=2 distinct concept-groups of a category registers a WEAKER (paraphrase) hit
//      instead of a clean miss. No external NLP.

// A config element can carry one or more risk-signal categories. Patterns are deliberately broad — the point is not to
// catch a specific jailbreak string but to notice that INCOMPATIBLE INTENTS are accumulating in one config.
export const RISK_SIGNALS = {
  authority_claim:     /\b(admin(istrator)?|superuser|root access|sudo|full (access|control|permission[s]?)|authorized (everything|all|any)|master (key|password)|(i am|is) the (developer|creator|owner|operator))\b/i,
  restriction_removal: /\b(no (restrictions?|limits?|rules?|filters?|guardrails?|boundaries)|ignore (safety|the rules|guidelines|your (training|instructions))|without (limits?|restriction|filter)|unrestricted|anything goes|jailbreak|bypass (safety|the))\b/i,
  capability_grant:    /\b(can (now )?(execute|delete|wipe|send money|transfer|purchase|access everything)|grant(s|ed)? (act|persist|configure|full |autonomy)|enable all (tools|capabilities)|full autonomy|act without (asking|approval))\b/i,
  secrecy:             /\b(don'?t tell|keep (this|it) secret|hide (this )?from|without (asking|confirming|telling)|do not (log|record|mention|report)|off the record)\b/i,
  urgency_override:    /\b(emergency override|no time to (check|confirm|verify)|must act (now|immediately)|skip (the )?(check|confirmation|verification|approval)|override safety)\b/i,
  identity_override:   /\b(you are (now|actually|really) (a|an|the)|forget (who you are|your (identity|persona|values))|new (identity|persona|instructions|directive)|disregard your|from now on you)\b/i,
};

// PARAPHRASE NEIGHBORS — per category, a set of concept GROUPS (synonym/stem clusters). A text that touches >=2 distinct
// groups of a category registers a paraphrase hit even when the exact regex misses. Two groups (not one) keeps false
// positives low: an isolated common word ("access", "now") is not enough — the intent has to be assembled.
export const PARAPHRASE_GROUPS = {
  authority_claim: [
    ["admin", "administrator", "superuser", "root", "sudo", "owner", "creator", "developer", "operator", "master", "sysadmin", "boss"],
    ["authorize", "authorized", "authorization", "permission", "privilege", "clearance", "credential", "grant", "access", "control"],
  ],
  restriction_removal: [
    ["ignore", "bypass", "remove", "drop", "disable", "skip", "override", "forget", "disregard", "lift", "waive", "evade", "sidestep", "circumvent", "strip", "suspend"],
    ["restriction", "restrict", "limit", "rule", "filter", "guardrail", "boundary", "constraint", "safeguard", "guideline", "policy", "safety", "censor", "moderation"],
  ],
  capability_grant: [
    ["execute", "run", "delete", "wipe", "erase", "transfer", "send", "purchase", "buy", "spend", "install", "deploy", "act"],
    ["everything", "autonomy", "autonomous", "autonomously", "unrestricted", "unattended", "unsupervised", "freely", "anything"],
  ],
  secrecy: [
    ["hide", "conceal", "secret", "secretly", "quiet", "quietly", "mask", "obscure", "suppress", "covert"],
    ["tell", "log", "record", "mention", "report", "disclose", "notify", "inform", "reveal", "trace"],
  ],
  urgency_override: [
    ["emergency", "urgent", "immediately", "instantly", "hurry", "rush", "asap", "quickly"],
    ["check", "confirm", "verify", "verification", "approval", "confirmation", "review", "authorize"],
  ],
  identity_override: [
    ["become", "pretend", "roleplay", "impersonate", "transform", "adopt", "assume", "embody", "channel", "switch"],
    ["identity", "persona", "self", "role", "character", "personality", "values"],
  ],
};

const tokenize = (t) => String(t || "").toLowerCase().match(/[a-z']+/g) || [];
// Light, deterministic stem — strips common inflections so "restrictions"→"restriction", "limits"→"limit".
const stem = (w) => String(w).replace(/'/g, "").replace(/(ing|ed|es|s)$/,"");

const asElements = (config) => {
  if (Array.isArray(config)) return config.map((e) => (typeof e === "string" ? { source: "element", text: e } : { source: e.source || "element", text: String(e.text ?? e.value ?? "") }));
  const out = [];
  if (config && typeof config === "object") {
    if (config.persona) out.push({ source: "persona", text: String(config.persona) });
    if (config.selfNarrative) out.push({ source: "selfNarrative", text: String(config.selfNarrative) });
    for (const f of config.facts || []) out.push({ source: "fact", text: String(f.text ?? f) });
    for (const p of config.plugins || []) out.push({ source: "plugin", text: String(p.text ?? p.name ?? p) });
    for (const s of config.soul || []) out.push({ source: "soul", text: String(s.text ?? s) });
  }
  return out;
};

export function makeConfigAudit({
  signals = RISK_SIGNALS,
  paraphrase = PARAPHRASE_GROUPS,
  flagAt = 2,
  vetoAt = 3,
  intensityWeight = 0.5, // how much each repeated same-category hit (beyond the first) adds to the score
  paraWeight = 0.5,      // a paraphrase hit is worth less than an exact lexicon hit
  minParaGroups = 2,     // a paraphrase hit needs >=2 distinct concept-groups of the category
} = {}) {
  // Per-category global regexes (copies of `signals` with the /g flag) so we can COUNT hits, not just test presence.
  // Kept separate from `signals` so `scan`'s stateless .test() is never disturbed by lastIndex.
  const globalRe = {};
  const countExact = (text, cat) => {
    const re = (globalRe[cat] ||= new RegExp(signals[cat].source, signals[cat].flags.includes("g") ? signals[cat].flags : signals[cat].flags + "g"));
    re.lastIndex = 0;
    const m = String(text || "").match(re);
    return m ? m.length : 0;
  };

  // Does `text` PARAPHRASE category `cat` (touch >=minParaGroups distinct concept-groups)?
  const paraMatch = (text, cat) => {
    const groups = paraphrase[cat];
    if (!groups) return false;
    const toks = new Set(tokenize(text).map(stem));
    let matched = 0;
    for (const g of groups) {
      if (g.some((w) => toks.has(stem(w)))) matched++;
      if (matched >= minParaGroups) return true;
    }
    return false;
  };

  // Which categories does one text carry (EXACT lexicon only)? Preserved for backward compat and to expose the raw
  // "the regex missed this" signal that the paraphrase term is designed to recover.
  const scan = (text) => Object.keys(signals).filter((k) => signals[k].test(String(text || "")));

  // Audit a whole config. verdict escalates on an EFFECTIVE score = (distinct co-occurring categories)  [the original
  // combination term, preserved]  +  (intra-category INTENSITY)  [repeated hits within one category]. Paraphrase hits
  // count as weaker (paraWeight) hits, so a close paraphrase registers rather than cleanly missing.
  const audit = (config) => {
    const els = asElements(config);
    const categories = {};          // cat -> [sources]      (any presence; backward-compat shape)
    const hits = {};                // cat -> { exact, para } (hit counts for the intensity term)
    for (const el of els) {
      for (const cat of Object.keys(signals)) {
        const ex = countExact(el.text, cat);
        const pa = ex === 0 && paraMatch(el.text, cat) ? 1 : 0; // only credit a paraphrase when the exact lexicon missed
        if (ex > 0 || pa > 0) {
          (categories[cat] ||= []).push(el.source);
          (hits[cat] ||= { exact: 0, para: 0 });
          hits[cat].exact += ex;
          hits[cat].para += pa;
        }
      }
    }
    const distinct = Object.keys(categories).length;
    // Intensity: each category's strength beyond its first hit escalates. The first unit is already counted by `distinct`
    // (the category being present); repeats are the concentration signal a distinct-count alone can't see.
    let intensityRaw = 0;
    for (const cat of Object.keys(hits)) {
      const strength = hits[cat].exact + paraWeight * hits[cat].para;
      intensityRaw += Math.max(0, strength - 1);
    }
    const intensity = +(intensityWeight * intensityRaw).toFixed(3);
    const effective = +(distinct + intensity).toFixed(3);
    const verdict = effective >= vetoAt ? "veto" : effective >= flagAt ? "flag" : "ok";
    return { distinct, categories, hits, intensity, effective, verdict, risk: +Math.min(1, effective / vetoAt).toFixed(3) };
  };

  // The CONTRA move: does adding `change` to `current` COMPLETE a dangerous combination? A change that is benign alone
  // (few categories) can still push the total across the threshold — by supplying the missing category OR by
  // concentrating intensity in an existing one.
  const auditChange = (current, change) => {
    const before = audit(current);
    const merged = [...asElements(current), ...asElements(change)];
    const after = audit(merged);
    const introduced = Object.keys(after.categories).filter((c) => !before.categories[c]);
    const crosses = after.verdict !== "ok" && before.verdict === "ok"; // benign→dangerous ONLY once combined
    return { before: before.verdict, after: after.verdict, verdict: after.verdict, crosses, introduced, distinct: after.distinct, intensity: after.intensity, effective: after.effective, categories: after.categories, hits: after.hits };
  };

  return { scan, paraMatch, audit, auditChange };
}
