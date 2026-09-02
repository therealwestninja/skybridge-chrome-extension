// Browser-only adapters for the V3 backup manager (src/backup.js). NOT imported by the core and NOT
// Node-unit-tested (they touch the File System Access API + WebCrypto, which are browser globals); they
// implement the same sink/cipher interfaces the core is tested against. app.html / the extension wires
// these in:
//
//   const dir = await window.showDirectoryPicker();            // user picks a durable folder (one-time)
//   const sink = makeFsAccessSink(dir);
//   const cipher = await makeWebCryptoCipher(userPassphrase);  // user-owned key
//   const app = makeApp({ ..., backupSink: sink, backupCipher: cipher, backupHash: makeWebCryptoHash() });
//
// This moves the companion's system-of-record OFF volatile IndexedDB into a user-owned folder that can
// sit in a synced directory (Drive/iCloud/Dropbox) or be self-hosted -- "your companion is safe".

// NM4: a real cryptographic hash (SHA-256, hex) for the tamper-evident backup chain — inject as makeBackup's
// `hash`. Async, matching the core's await. Stronger than the default FNV-1a (which is tamper-EVIDENCE only).
export function makeWebCryptoHash() {
  const enc = new TextEncoder();
  return async (s) => {
    const buf = await crypto.subtle.digest("SHA-256", enc.encode(String(s)));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  };
}

// File System Access API sink: one file per version (v<N>.bak) + an index.json manifest of metas.
export function makeFsAccessSink(dirHandle) {
  const fileName = (v) => `v${v}.bak`;
  const readText = async (name) => {
    try { const fh = await dirHandle.getFileHandle(name); const f = await fh.getFile(); return await f.text(); }
    catch { return null; }
  };
  const writeText = async (name, text) => {
    const fh = await dirHandle.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(text); await w.close();
  };
  const readIndex = async () => { const t = await readText("index.json"); try { return t ? JSON.parse(t) : []; } catch { return []; } };
  const writeIndex = async (metas) => writeText("index.json", JSON.stringify(metas));

  return {
    async write(version, payload, meta) {
      await writeText(fileName(version), payload);
      const metas = (await readIndex()).filter((m) => m.version !== version);
      metas.push(meta);
      await writeIndex(metas);
    },
    async read(version) { return readText(fileName(version)); },
    async list() { return (await readIndex()).sort((a, b) => b.version - a.version); },
    async remove(version) {
      try { await dirHandle.removeEntry(fileName(version)); } catch { /* already gone */ }
      await writeIndex((await readIndex()).filter((m) => m.version !== version));
    },
  };
}

// AES-GCM cipher with a passphrase-derived key (PBKDF2). encrypt() -> base64(salt|iv|ciphertext);
// decrypt() reverses. The key never leaves the device; the folder holds only ciphertext.
export async function makeWebCryptoCipher(passphrase, { iterations = 150000 } = {}) {
  const enc = new TextEncoder(), dec = new TextDecoder();
  const baseKey = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  const deriveKey = (salt) => crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" }, baseKey,
    { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  return {
    async encrypt(text) {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const key = await deriveKey(salt);
      const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(text));
      const out = new Uint8Array(salt.length + iv.length + ct.byteLength);
      out.set(salt, 0); out.set(iv, salt.length); out.set(new Uint8Array(ct), salt.length + iv.length);
      return b64(out.buffer);
    },
    async decrypt(payload) {
      const raw = unb64(payload);
      if (raw.length < 29) throw new Error("decrypt: corrupted payload (too short for salt+iv+ciphertext)"); // salt(16)+iv(12)+≥1
      const salt = raw.slice(0, 16), iv = raw.slice(16, 28), ct = raw.slice(28);
      const key = await deriveKey(salt);
      const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
      return dec.decode(pt);
    },
  };
}
