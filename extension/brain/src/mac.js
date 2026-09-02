// mac.js — a dependency-free KEYED MAC primitive (SipHash-2-4).
//
// WHY THIS EXISTS (the flaw it replaces): the codebase authenticated peers with
//   sign = fnv(teamSecret + ":" + nonce)
// — a secret-PREFIX construction over 32-bit FNV-1a. FNV-1a is invertible: its whole
// state is a single 32-bit register, xor-then-multiply per byte, both reversible. A
// red-team proved that from ONE observed (nonce, answer) pair the attacker peels the
// public nonce bytes off the tail, recovers the interior 32-bit state that FNV had
// AFTER absorbing the secret, and can then re-run FNV forward over ANY future nonce —
// forging an answer for every challenge without ever learning the secret. Any
// secret-prefix hash whose interior state is fully exposed by the output is broken the
// same way (length-extension is the same family of attack).
//
// THE FIX — SipHash-2-4, a purpose-built keyed pseudo-random function (Aumasson &
// Bernstein, 2012), the standard short-input MAC (used by Python/Rust/Perl hash-table
// DoS hardening). Why the FNV attack cannot work against it:
//   1. KEYED, not prefix. The 128-bit key is mixed into the 256-bit (v0..v3) internal
//      state at INIT and is NEVER present in the output. The tag is a function of key
//      AND message; you cannot factor the key back out.
//   2. State is 4x wider than the tag. The tag is 64 bits; the internal state is 256
//      bits. The finalization collapses 256→64 bits, so an observed tag does not reveal
//      the interior state — there is no state to "recover and replay".
//   3. ARX rounds are non-invertible w.r.t. the key. Each SipRound is 2 (c=2) / 4 (d=4)
//      rounds of add-rotate-xor that diffuse every key bit across all 256 state bits.
//      There is no algebraic peel-off like FNV's single reversible multiply.
// Consequently: observing any number of (message, tag) pairs yields neither the key nor
// a tag for a NEW message. Forgery reduces to guessing a 64-bit tag (2^-64).
//
// KEY DERIVATION: SipHash needs a 128-bit key (two 64-bit words k0,k1). We accept an
// arbitrary-length STRING key and expand it deterministically to 128 bits by running
// SipHash itself twice under two fixed, distinct domain-separation constants over the
// UTF-8 key bytes:
//   k0 = SipHash(K_EXPAND_0, keyBytes),  k1 = SipHash(K_EXPAND_1, keyBytes)
// This is a keyed PRF expansion: because SipHash is a PRF, k0/k1 are indistinguishable
// from random and independent, and the string→128-bit map inherits SipHash's
// non-invertibility (you cannot recover the string key from k0,k1 either).
//
// EXPORTS:
//   mac(key, message) -> tag         key,message are strings; tag is a 16-char lowercase hex string (64-bit).
//   verify(key, message, tag) -> bool  full (non-early-exit) constant-timeish compare.
//
// Pure JS, deterministic, no Math.random / Date.now / Node crypto / external libs.
// Implemented with BigInt for 64-bit clarity; masked to 64 bits at every step.

const MASK64 = (1n << 64n) - 1n;

const rotl = (x, b) => ((x << b) | (x >> (64n - b))) & MASK64;

// UTF-8 encode a JS string to a byte array (dependency-free; handles surrogate pairs).
function utf8Bytes(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const c2 = str.charCodeAt(i + 1);
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        i++;
      }
    }
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c < 0x10000) {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    } else {
      out.push(
        0xf0 | (c >> 18),
        0x80 | ((c >> 12) & 0x3f),
        0x80 | ((c >> 6) & 0x3f),
        0x80 | (c & 0x3f)
      );
    }
  }
  return out;
}

// Read 8 little-endian bytes from arr at offset i as a BigInt.
function readLE64(arr, i) {
  let x = 0n;
  for (let j = 7; j >= 0; j--) x = (x << 8n) | BigInt(arr[i + j] & 0xff);
  return x;
}

// Core SipHash-2-4 over raw byte arrays with an explicit 128-bit key (k0,k1 BigInt).
function sipHash24(k0, k1, data) {
  k0 &= MASK64;
  k1 &= MASK64;
  let v0 = 0x736f6d6570736575n ^ k0;
  let v1 = 0x646f72616e646f6dn ^ k1;
  let v2 = 0x6c7967656e657261n ^ k0;
  let v3 = 0x7465646279746573n ^ k1;

  const sipRound = () => {
    v0 = (v0 + v1) & MASK64; v1 = rotl(v1, 13n); v1 ^= v0; v0 = rotl(v0, 32n);
    v2 = (v2 + v3) & MASK64; v3 = rotl(v3, 16n); v3 ^= v2;
    v0 = (v0 + v3) & MASK64; v3 = rotl(v3, 21n); v3 ^= v0;
    v2 = (v2 + v1) & MASK64; v1 = rotl(v1, 17n); v1 ^= v2; v2 = rotl(v2, 32n);
  };

  const len = data.length;
  const end = len - (len % 8);
  for (let i = 0; i < end; i += 8) {
    const m = readLE64(data, i);
    v3 ^= m;
    sipRound(); sipRound();       // c = 2 compression rounds
    v0 ^= m;
  }

  // Final block: remaining (len % 8) bytes, then the length byte in the top position.
  let b = BigInt(len & 0xff) << 56n;
  for (let i = end, shift = 0n; i < len; i++, shift += 8n) {
    b |= BigInt(data[i] & 0xff) << shift;
  }
  v3 ^= b;
  sipRound(); sipRound();
  v0 ^= b;

  v2 ^= 0xffn;
  sipRound(); sipRound(); sipRound(); sipRound(); // d = 4 finalization rounds

  return (v0 ^ v1 ^ v2 ^ v3) & MASK64;
}

// Domain-separation constants for string-key → 128-bit expansion (arbitrary distinct fixed keys).
const K_EXPAND_0 = { k0: 0x0706050403020100n, k1: 0x0f0e0d0c0b0a0908n }; // canonical SipHash test key
const K_EXPAND_1 = { k0: 0x1112131415161718n, k1: 0x191a1b1c1d1e1f20n };

// Derive the 128-bit SipHash key (two 64-bit words) from an arbitrary string key.
function deriveKey(keyStr) {
  const kb = utf8Bytes(String(keyStr));
  const k0 = sipHash24(K_EXPAND_0.k0, K_EXPAND_0.k1, kb);
  const k1 = sipHash24(K_EXPAND_1.k0, K_EXPAND_1.k1, kb);
  return { k0, k1 };
}

function toHex64(x) {
  return (x & MASK64).toString(16).padStart(16, "0");
}

/**
 * mac(key, message) -> hex tag string (16 lowercase hex chars = 64-bit SipHash-2-4).
 * key and message are strings.
 */
export function mac(key, message) {
  const { k0, k1 } = deriveKey(key);
  const tag = sipHash24(k0, k1, utf8Bytes(String(message)));
  return toHex64(tag);
}

/**
 * verify(key, message, tag) -> bool. Recomputes the tag and does a full-length
 * (non-early-exit) constant-timeish compare against the provided hex tag.
 */
export function verify(key, message, tag) {
  const expected = mac(key, message);
  const got = String(tag == null ? "" : tag).toLowerCase();
  // Full compare: accumulate differences over max length, never short-circuit.
  const n = Math.max(expected.length, got.length);
  let diff = expected.length ^ got.length;
  for (let i = 0; i < n; i++) {
    const a = i < expected.length ? expected.charCodeAt(i) : 0;
    const b = i < got.length ? got.charCodeAt(i) : 0;
    diff |= a ^ b;
  }
  return diff === 0;
}

// Low-level export for callers that already hold a 128-bit key / raw bytes.
export function sipHash24Hex(k0, k1, bytes) {
  return toHex64(sipHash24(BigInt(k0), BigInt(k1), bytes));
}
