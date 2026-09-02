// Durability / state sovereignty (Part V / V3; 005 Phase 3). A lifelong companion IS its accumulated
// state -- self-narrative, memories, learned weights. Right now that lives in one volatile browser store;
// a single IndexedDB clear and the "person" is gone. This is the versioned-backup spine: automatic,
// transactional snapshots of the FULL state (app.exportFile()) into a durable sink, a bounded version
// ring, and one-call restore -- "your companion is safe".
//
// Storage- and crypto-agnostic by design (zero-runtime): the core is testable in Node against a memory
// sink; the BROWSER adapter supplies a File System Access API sink (a user-chosen folder, off volatile
// IndexedDB) and a WebCrypto AES-GCM cipher (user-owned key). Sink + cipher may be async.
//
//   sink:  { write(version, payload, meta), read(version)->payload, list()->[meta], remove(version) }
//   cipher (optional): { encrypt(str)->str|Promise, decrypt(str)->str|Promise }

export function makeMemorySink() {
  const store = new Map(); // version -> { payload, meta }
  return {
    async write(version, payload, meta) { store.set(version, { payload, meta }); },
    async read(version) { const e = store.get(version); return e ? e.payload : null; },
    async list() { return [...store.values()].map((e) => e.meta).sort((a, b) => b.version - a.version); },
    async remove(version) { store.delete(version); },
  };
}

// NM4: default hash for the tamper-evident chain — a fast, dependency-free FNV-1a (hex). This gives
// tamper-EVIDENCE (detects corruption / naive edits / reordering), not cryptographic security. The browser
// adapter can inject a WebCrypto SHA-256 (`makeWebCryptoHash`) for real strength — same interface.
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0; }
  return ("00000000" + h.toString(16)).slice(-8);
}

export function makeBackup({ getState, sink, now = () => 0, keep = 10, everyTurns = 100, everyMs = 24 * 60 * 60 * 1000, cipher = null, hash = fnv1a, verifyOnRestore = true }) {
  let seq = null;            // monotonic version counter, seeded lazily from the sink
  let lastSecuredAt = null;  // ms timestamp of the last successful snapshot
  let lastTurns = 0;         // turn count at the last snapshot (auto-trigger cadence)

  async function nextVersion() {
    if (seq == null) { const v = await sink.list(); seq = v.reduce((m, r) => Math.max(m, r.version || 0), 0); }
    return ++seq;
  }
  const enc = async (s) => (cipher ? await cipher.encrypt(s) : s);
  const dec = async (s) => (cipher ? await cipher.decrypt(s) : s);

  async function prune() {
    const all = await sink.list();
    for (const meta of all.slice(keep)) await sink.remove(meta.version); // list() is newest-first
  }

  // Take a snapshot NOW. Transactional at the sink level (write the new version before pruning old ones,
  // so a mid-op failure never leaves you with zero backups). Returns the version meta.
  async function snapshot({ reason = "manual", turns = lastTurns } = {}) {
    const state = await getState();
    const payload = await enc(state);
    const version = await nextVersion();
    const at = now();
    // NM4: hash-chain the STORED payload; prevDigest links to the current newest snapshot, so any later
    // tampering (edit / delete / reorder / insert) breaks the chain and is detectable by verify().
    const prevDigest = (await sink.list())[0]?.digest || null; // list() is newest-first
    const digest = await hash(payload);
    const meta = { version, at, bytes: state.length, turns, reason, encrypted: !!cipher, digest, prevDigest };
    await sink.write(version, payload, meta);
    await prune();
    lastSecuredAt = at; lastTurns = turns;
    return meta;
  }

  // Auto-trigger policy: snapshot when enough turns have passed OR enough wall-clock time. Cheap to call
  // every turn -- it no-ops until a threshold trips. Returns the meta if it snapshotted, else null.
  async function maybeSnapshot({ turns = lastTurns } = {}) {
    const dueByTurns = everyTurns > 0 && turns - lastTurns >= everyTurns;
    const dueByTime = everyMs > 0 && lastSecuredAt != null && now() - lastSecuredAt >= everyMs;
    const first = lastSecuredAt == null;
    if (first || dueByTurns || dueByTime) return snapshot({ reason: first ? "initial" : dueByTurns ? "turns" : "time", turns });
    return null;
  }

  // NM4: audit the whole chain. Recompute each stored payload's hash (detects a mutated payload) and check
  // every prevDigest links to the actual prior digest (detects deletion/reorder/insertion). Returns
  // { ok, length, brokenAt?, reason? } — the "has anyone tampered with my backups?" check.
  async function verify() {
    const all = (await sink.list()).slice().sort((a, b) => a.version - b.version); // oldest -> newest
    let prev = null;
    for (const m of all) {
      const payload = await sink.read(m.version);
      if (payload == null || (await hash(payload)) !== m.digest) return { ok: false, brokenAt: m.version, reason: "payload digest mismatch" };
      if ((m.prevDigest || null) !== prev) return { ok: false, brokenAt: m.version, reason: "chain link broken" };
      prev = m.digest;
    }
    return { ok: true, length: all.length };
  }

  return {
    snapshot, maybeSnapshot, verify,
    async list() { return sink.list(); },
    // Return the decrypted state string for a version. NM4: fail-CLOSED — if the stored payload no longer
    // matches its recorded digest (tampered/corrupt), refuse to restore it (return null) rather than
    // re-hydrate the companion from poisoned state. Disable with verifyOnRestore:false.
    async restore(version) {
      const p = await sink.read(version);
      if (p == null) return null;
      if (verifyOnRestore) {
        const meta = (await sink.list()).find((m) => m.version === version);
        if (meta && meta.digest && (await hash(p)) !== meta.digest) return null; // tampered -> refuse
      }
      try { return await dec(p); } catch (e) { return null; } // fail-closed: a bad passphrase / corrupt cipher returns null, never crashes restore
    },
    // "Your companion is safe" card data. `chainOk` runs a full verify (reads every payload).
    async status({ audit = false } = {}) {
      const versions = await sink.list();
      const base = { lastSecuredAt, versionCount: versions.length, latest: versions[0] || null, healthy: versions.length > 0 };
      return audit ? { ...base, chain: await verify() } : base;
    },
  };
}
