// contextGuard.js — TAMPER-EVIDENCE + ROLLBACK over the brain's own MUTABLE configuration between turns (Cluster J;
// from ElephantAgent 2607.01919 "contextual-state continuity"). Our memory-approval gate authorizes ADDITIONS, but
// nothing catches a SILENT MUTATION/poisoning of already-trusted state — a pinned memory fact quietly rewritten, a
// faculty/tool table swapped, a procedural routine altered OUT-OF-BAND between turns. This guard keeps a chained,
// tamper-evident digest of "protected regions" and flags any change that wasn't explicitly authorized, plus hands the
// caller the last-good baseline so it can freeze or roll back. It never mutates anyone's state and never blocks — it
// returns a verdict; the caller decides.
//
// MECHANISM (deterministic, dependency-free — no Math.random / Date.now):
//   • The caller passes "protected regions" as a plain object each check, e.g. { facultyTable, pinnedFacts, procedural }.
//     Each region value (string/array/object) is serialized DETERMINISTICALLY (object keys sorted) and hashed with a
//     small FNV-1a helper (mirrored from trust.js / governance style, NOT imported — this stays standalone).
//   • Per-region hashes are combined — in a stable key order — into ONE overall digest that is CHAINED to the previous
//     authorized digest (each checkpoint links the last → a tamper-evident chain; you can't rewrite a past checkpoint
//     without breaking every link after it).
//   • checkpoint(regions) → record the current regions as the authorized baseline; append a link to the chain; return digest.
//   • authorize() → mark that the NEXT observed change is legitimate, so a real edit followed by verify() is NOT flagged.
//   • verify(regions) → compare current per-region hashes to the last authorized baseline. If a region changed and no
//     authorization is pending, it's TAMPERING. Returns { ok, tampered:[names], changed:[names], digest, prevDigest, authorized }.
//   • lastGood() → the last authorized { digest, hashes } so a caller can detect/roll back to a clean state.
//   • chain() → the digest history (each link carries prev→digest), so the whole record is itself verifiable.
//   • snapshot()/restore() → persist/round-trip the guard's own state.

// FNV-1a over a string → 8-hex digest (mirrors trust.js's fnv; kept local so this module imports nothing).
const fnv = (s) => {
  let h = 0x811c9dc5;
  const t = String(s);
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
};

// Deterministic serialization: object keys sorted so {a,b} and {b,a} hash identically; arrays keep order; primitives
// stringify plainly. Recursive, cycle-free by contract (config regions are plain data). Typed with a tag so a string
// "1" and a number 1 never collide, and null/undefined are distinguished.
const ser = (v) => {
  if (v === null) return "n:";
  if (v === undefined) return "u:";
  const type = typeof v;
  if (type === "number" || type === "boolean") return type[0] + ":" + String(v);
  if (type === "string") return "s:" + v;
  if (Array.isArray(v)) return "a:[" + v.map(ser).join(",") + "]";
  if (type === "object") {
    const keys = Object.keys(v).sort();
    return "o:{" + keys.map((k) => "s:" + k + "=" + ser(v[k])).join(",") + "}";
  }
  return "x:" + String(v); // functions / symbols — hashed by their string form (identity-ish; config shouldn't carry these)
};

// Hash one region value.
const hashRegion = (v) => fnv(ser(v));

// Per-region hashes for a regions object, in a stable (sorted) key order.
const hashAll = (regions = {}) => {
  const out = {};
  for (const name of Object.keys(regions).sort()) out[name] = hashRegion(regions[name]);
  return out;
};

// Combine per-region hashes + the previous chain digest into one overall digest (the chain link).
const combine = (hashes, prevDigest) => {
  const body = Object.keys(hashes).sort().map((k) => k + ":" + hashes[k]).join("|");
  return fnv((prevDigest || "genesis") + "||" + body);
};

// Which region names differ between two hash maps (added / removed / changed all count as "changed").
const diffRegions = (a = {}, b = {}) => {
  const names = new Set([...Object.keys(a), ...Object.keys(b)]);
  const changed = [];
  for (const n of names) if (a[n] !== b[n]) changed.push(n);
  return changed.sort();
};

export function makeContextGuard(opts = {}) {
  const { genesis = "genesis" } = opts;

  // The authorized baseline: hashes of each protected region + the overall digest, as of the last checkpoint (or the
  // last verify() that was covered by an authorize()).
  let baseHashes = {};
  let baseDigest = genesis;

  // The tamper-evident chain of authorized digests. Each link: { prev, digest, hashes }.
  let links = [];

  // One-shot flag: the next observed change (at the next verify) is legitimate.
  let pendingAuth = false;

  // Adopt `regions` (with their computed hashes/digest) as the new authorized baseline and append a chain link.
  const adopt = (hashes) => {
    const prev = baseDigest;
    const digest = combine(hashes, prev);
    baseHashes = hashes;
    baseDigest = digest;
    links.push({ prev, digest, hashes: { ...hashes } });
    return digest;
  };

  return {
    // Record the current regions as the AUTHORIZED baseline and append to the chain. Returns the new overall digest.
    checkpoint(regions = {}) {
      const digest = adopt(hashAll(regions));
      pendingAuth = false; // a fresh checkpoint IS the authorization; nothing pending afterwards
      return digest;
    },

    // Mark that the NEXT observed change is legitimate, so a real edit followed by verify() is NOT flagged as tampering.
    authorize() { pendingAuth = true; return true; },

    // Was an authorization primed but not yet consumed?
    pending() { return pendingAuth; },

    // Compare current regions to the last authorized baseline.
    //   • No change            → ok:true, tampered:[].
    //   • Change + authorized   → ok:true, tampered:[], baseline ADVANCED to the new state (auth consumed).
    //   • Change + unauthorized → ok:false, tampered:[names]; baseline is NOT advanced (so lastGood stays clean to roll back to).
    // Returns { ok, tampered, changed, digest, prevDigest, authorized }.
    verify(regions = {}) {
      const cur = hashAll(regions);
      const changed = diffRegions(baseHashes, cur);
      const prevDigest = baseDigest;

      if (changed.length === 0) {
        // Nothing moved. Any pending authorization for an edit that never happened simply stands (it's harmless).
        return { ok: true, tampered: [], changed: [], digest: baseDigest, prevDigest, authorized: false };
      }

      if (pendingAuth) {
        // A legitimate edit — advance the authorized baseline + chain, consume the one-shot.
        pendingAuth = false;
        const digest = adopt(cur);
        return { ok: true, tampered: [], changed, digest, prevDigest, authorized: true };
      }

      // Unauthorized change → tampering. Do NOT advance the baseline; the caller can freeze / roll back to lastGood().
      return { ok: false, tampered: changed, changed, digest: combine(cur, baseDigest), prevDigest, authorized: false };
    },

    // The last authorized clean state — { digest, hashes } — for detecting drift or rolling back to it.
    lastGood() { return { digest: baseDigest, hashes: { ...baseHashes } }; },

    // The tamper-evident chain of authorized digests. Each link { prev, digest, hashes }.
    chain() { return links.map((l) => ({ prev: l.prev, digest: l.digest, hashes: { ...l.hashes } })); },

    // Independently re-verify the chain's integrity: each link's digest must equal combine(its hashes, its prev), and
    // each link's prev must equal the previous link's digest (or genesis for the first). Returns { ok, brokenAt }.
    verifyChain() {
      let prev = genesis;
      for (let i = 0; i < links.length; i++) {
        const l = links[i];
        if (l.prev !== prev) return { ok: false, brokenAt: i, reason: "prev-mismatch" };
        if (combine(l.hashes, l.prev) !== l.digest) return { ok: false, brokenAt: i, reason: "digest-mismatch" };
        prev = l.digest;
      }
      return { ok: true, brokenAt: -1 };
    },

    // Current overall digest (== lastGood().digest).
    digest() { return baseDigest; },

    snapshot() {
      return {
        baseHashes: { ...baseHashes },
        baseDigest,
        pendingAuth,
        links: links.map((l) => ({ prev: l.prev, digest: l.digest, hashes: { ...l.hashes } })),
      };
    },
    restore(s) {
      if (!s) return;
      baseHashes = s.baseHashes ? { ...s.baseHashes } : {};
      baseDigest = s.baseDigest ?? genesis;
      pendingAuth = !!s.pendingAuth;
      links = Array.isArray(s.links) ? s.links.map((l) => ({ prev: l.prev, digest: l.digest, hashes: { ...l.hashes } })) : [];
    },
  };
}
