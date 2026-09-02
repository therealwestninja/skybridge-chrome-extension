// courier.js — a dependency-free MESSAGE + MEMORY-BLOB TRANSPORT for portable brains.
//
// CRIB (the Bobiverse): Bobs leave each other dead-drop notes, push memory
// snapshots to freshly-spun copies, and secret-share over channels only a team
// member can mint or open. This module is that transport for a portable AI brain:
//   (1) MESSAGE     — a note attached to another bot, read on startup (inbox / dead-drop).
//   (2) DIRECTIVE   — an urgent instruction ("dodge left!") or a structured action the
//                     recipient acts on immediately (an init-directive preempt).
//   (3) MEMORY-BLOB — a context bundle pushed into a fresh bot so it wakes up "knowing".
//
// EVERY transfer is AUTHENTICATED with the shared team MAC (SipHash-2-4, from ./mac.js):
//   - tamper-evident: any flipped byte (body / cipher / to / from / ts / nonce / kind)
//     changes the canonical bytes → the recomputed tag no longer matches → rejected.
//   - team-gated (= secret-sharing): only a holder of `teamSecret` can mint a valid
//     packet OR verify/open one. A stranger can neither forge nor read.
// A transfer is OPTIONALLY CONFIDENTIAL: the body is scrambled with a keystream so a
// non-team-secret holder sees only hex noise.
//
// PACKET (plain, JSON-serialisable object):
//   { v:1, kind, from, to, ts, nonce, enc, body|cipher, sig }
//     kind  ∈ "message" | "directive" | "memory-blob"
//     from  — sender bot id            to    — recipient bot id
//     ts    — caller LOGICAL clock (NO Date.now); used for inbox ordering + replay context
//     nonce — caller-supplied per-packet string; feeds the keystream + binds the packet
//     enc   — false → plaintext `body`; true → `cipher` (hex) and NO plaintext body
//     sig   — mac(teamSecret, canon(packet-without-sig)) covering ALL other fields, so
//             nothing can be altered and no packet can be replayed to a different `to`.
//
// ── CONFIDENTIALITY: HONEST CAVEAT ──────────────────────────────────────────────
// The `enc:true` path uses a DETERMINISTIC SipHash-KEYSTREAM cipher:
//     keystream(key, nonce, len) = concat( mac(key, `${nonce}:${i}`) bytes ) for i=0,1,2,…
//     cipher = utf8(JSON.stringify(body))  XOR  keystream        (stored as hex)
//     body   = utf8Decode( hexBytes(cipher) XOR keystream )      (XOR is its own inverse)
// This is OBFUSCATION-GRADE, NOT audited crypto. Specifically:
//   • It is a raw stream cipher: there is NO IV and NO nonce-reuse protection beyond the
//     caller varying `nonce`. Reusing the SAME (key, nonce) for two different bodies XORs
//     to leak (bodyA XOR bodyB). CALLERS MUST VARY `nonce` PER PACKET.
//   • Integrity/authenticity comes ONLY from the outer MAC (`sig`), not from an AEAD tag.
//     That does make tampering with the cipher detectable (the sig covers it).
//   • It keeps a body unreadable to anyone WITHOUT `teamSecret`, which is the goal here.
// A real-confidentiality deployment SHOULD swap this for WebCrypto AES-GCM (async, needs
// a random IV; available in BOTH browsers and Node ≥ globalThis.crypto.subtle). We do NOT
// use it as the default because it is async and non-deterministic (random IV), whereas the
// offline/deterministic brain core forbids Math.random / Date.now and wants byte-for-byte
// reproducibility. Hence this dep-free deterministic keystream is the default.
//
// CONSTRAINTS: deterministic · dependency-free (only ./mac.js) · browser-safe ·
// no Math.random · no Date.now · correct UTF-8 via TextEncoder/TextDecoder.

import { mac, verify } from "./mac.js";

const TE = new TextEncoder();
const TD = new TextDecoder("utf-8", { fatal: false });

// ── low-level byte/hex helpers ──────────────────────────────────────────────────
function bytesToHex(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}
function hexToBytes(hex) {
  const h = String(hex);
  const n = h.length >> 1;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

// ── canonical serialisation ─────────────────────────────────────────────────────
// A stable JSON stringify with recursively SORTED object keys, so the signed bytes are
// independent of key insertion order (a re-parsed packet signs identically to the original).
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const keys = Object.keys(value).sort();
  let out = "{";
  for (let i = 0; i < keys.length; i++) {
    if (i) out += ",";
    out += JSON.stringify(keys[i]) + ":" + stableStringify(value[keys[i]]);
  }
  return out + "}";
}

// canon(packet-without-sig): everything the signature must cover.
function canon(pkt) {
  const { sig, ...rest } = pkt; // exclude sig; sign everything else
  return stableStringify(rest);
}

// ── deterministic SipHash keystream cipher (see HONEST CAVEAT above) ─────────────
function keystream(key, nonce, len) {
  const out = new Uint8Array(len);
  let filled = 0;
  let i = 0;
  while (filled < len) {
    const block = hexToBytes(mac(key, `${nonce}:${i}`)); // 8 bytes per SipHash tag
    for (let j = 0; j < block.length && filled < len; j++) out[filled++] = block[j];
    i++;
  }
  return out;
}

function scramble(key, nonce, body) {
  const plain = TE.encode(JSON.stringify(body));
  const ks = keystream(key, nonce, plain.length);
  const ct = new Uint8Array(plain.length);
  for (let i = 0; i < plain.length; i++) ct[i] = plain[i] ^ ks[i];
  return bytesToHex(ct);
}

function descramble(key, nonce, cipherHex) {
  const ct = hexToBytes(cipherHex);
  const ks = keystream(key, nonce, ct.length);
  const pt = new Uint8Array(ct.length);
  for (let i = 0; i < ct.length; i++) pt[i] = ct[i] ^ ks[i];
  return JSON.parse(TD.decode(pt));
}

/**
 * makeCourier({ teamSecret, self }) — a transport bound to one bot identity + team secret.
 *   teamSecret: shared string secret; mints & opens packets (the secret-sharing gate).
 *   self:       this bot's id (string); `from` on seals, the address matched by deliver().
 */
export function makeCourier({ teamSecret, self } = {}) {
  if (teamSecret == null) throw new Error("makeCourier: teamSecret required");
  if (self == null) throw new Error("makeCourier: self id required");

  let queue = []; // per-recipient inbox (this instance = this bot)

  /**
   * seal({ kind, to, body, encrypt=false, ts=0, nonce="" }) -> packet
   * from = self. Signs the whole packet. If encrypt, scrambles body into `cipher`.
   * NOTE: vary `nonce` per packet (see caveat) — the default "" is deterministic and
   * unsafe to reuse across two different encrypted bodies.
   */
  function seal({ kind, to, body, encrypt = false, ts = 0, nonce = "" } = {}) {
    if (kind !== "message" && kind !== "directive" && kind !== "memory-blob" && kind !== "skill") {
      throw new Error(`seal: bad kind ${JSON.stringify(kind)}`);
    }
    const pkt = { v: 1, kind, from: self, to, ts, nonce, enc: !!encrypt };
    if (encrypt) pkt.cipher = scramble(teamSecret, nonce, body);
    else pkt.body = body;
    pkt.sig = mac(teamSecret, canon(pkt));
    return pkt;
  }

  /**
   * open(packet) -> { ok:true, kind, from, to, ts, body } | { ok:false, reason }
   * Verifies sig FIRST (rejects forged/tampered/wrong-secret), THEN descrambles cipher.
   */
  function open(packet) {
    if (!packet || typeof packet !== "object") return { ok: false, reason: "not-a-packet" };
    if (packet.v !== 1) return { ok: false, reason: "bad-version" };
    if (typeof packet.sig !== "string") return { ok: false, reason: "missing-sig" };
    if (!verify(teamSecret, canon(packet), packet.sig)) {
      return { ok: false, reason: "bad-signature" }; // forged, tampered, or wrong teamSecret
    }
    let body;
    if (packet.enc) {
      try {
        body = descramble(teamSecret, packet.nonce, packet.cipher);
      } catch {
        return { ok: false, reason: "decrypt-failed" };
      }
    } else {
      body = packet.body;
    }
    return { ok: true, kind: packet.kind, from: packet.from, to: packet.to, ts: packet.ts, body };
  }

  // ── convenience minters ──────────────────────────────────────────────────────
  function message(to, text, opts = {}) {
    return seal({ kind: "message", to, body: text, ...opts });
  }
  function directive(to, instruction, opts = {}) {
    return seal({ kind: "directive", to, body: instruction, ...opts });
  }
  function memoryBlob(to, bundle, opts = {}) {
    return seal({ kind: "memory-blob", to, body: bundle, ...opts });
  }
  // A SKILL REQUEST — "load this ganglion" (the Matrix "I know kung-fu"). Carries a skill NAME the receiver already has
  // pre-baked (NOT code — no remote execution), optionally urgent ("you're already falling, learn to fly NOW") + a note.
  // The receiver learns it from its OWN library on receipt / at wake.
  function skill(to, name, { urgent = false, note = "", ...opts } = {}) {
    return seal({ kind: "skill", to, body: { skill: name, urgent, note }, ...opts });
  }

  // ── INBOX (dead-drop queue held in this courier instance) ─────────────────────
  /**
   * deliver(packet) -> { ok:true } | { ok:false, reason }
   * Queues a packet iff it is addressed to `self` AND authentic. Rejects mis-addressed
   * or forged/tampered/wrong-secret packets (never queues them).
   */
  function deliver(packet) {
    if (!packet || typeof packet !== "object") return { ok: false, reason: "not-a-packet" };
    if (packet.to !== self) return { ok: false, reason: "mis-addressed" };
    if (!verify(teamSecret, canon(packet), packet.sig)) {
      return { ok: false, reason: "bad-signature" };
    }
    queue.push(packet);
    return { ok: true };
  }

  function inbox() {
    return queue.slice(); // peek (does not drain)
  }

  /**
   * readInbox() -> opened[] — drains the queue, returns OPENED entries
   * { kind, from, body, ts } ordered by ts (stable), then clears. Any packet that
   * fails to open (should not happen post-deliver) is skipped.
   */
  function readInbox() {
    const opened = [];
    for (const pkt of queue) {
      const r = open(pkt);
      if (r.ok) opened.push({ kind: r.kind, from: r.from, body: r.body, ts: r.ts });
    }
    opened.sort((a, b) => (a.ts - b.ts) || 0);
    queue = [];
    return opened;
  }

  function clearInbox() {
    queue = [];
  }

  return {
    self,
    seal,
    open,
    message,
    directive,
    memoryBlob,
    skill,
    deliver,
    inbox,
    readInbox,
    clearInbox,
  };
}

export default makeCourier;
