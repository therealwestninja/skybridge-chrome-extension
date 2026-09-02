// Async key-value seam. In-memory backend for tests; IndexedDB backend for the browser.
export function makeMemoryStorage() {
  const m = new Map();
  return {
    async get(key) { return m.has(key) ? m.get(key) : null; },
    async set(key, value) { m.set(key, value); },
    async delete(key) { m.delete(key); },
    async keys() { return [...m.keys()]; },
  };
}

// Browser durability. Not unit-tested in Node (no indexedDB); exercised in the browser app.
export function makeIndexedDbStorage(dbName = "digital-brain", storeName = "kv") {
  let dbp = null;
  const open = () => {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(storeName);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  };
  const tx = (mode, fn) => open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const req = fn(t.objectStore(storeName));
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
  return {
    async get(key) { return (await tx("readonly", (s) => s.get(key))) ?? null; },
    async set(key, value) { await tx("readwrite", (s) => s.put(value, key)); },
    async delete(key) { await tx("readwrite", (s) => s.delete(key)); },
    async keys() { return (await tx("readonly", (s) => s.getAllKeys())) || []; },
  };
}
