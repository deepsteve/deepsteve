// IndexedDB-backed undo history for Steveonardo. One database per tab,
// keyed by tab instance ID, single object store of canvas blobs.

const HISTORY_CAP = 10;

let _dsDepth = 0;
try {
  let w = window;
  while (w !== w.parent) { w = w.parent; _dsDepth++; }
} catch { /* cross-origin parent — assume top */ }

const DB_PREFIX = (_dsDepth > 0 ? `ds${_dsDepth}-` : '') + 'steveonardo-undo-';

function openDb(tabId) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_PREFIX + tabId, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('history', { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode) {
  return db.transaction('history', mode).objectStore('history');
}

export async function createUndoStore(tabId) {
  const db = await openDb(tabId);

  function count() {
    return new Promise((resolve, reject) => {
      const req = tx(db, 'readonly').count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function getAllKeys() {
    return new Promise((resolve, reject) => {
      const req = tx(db, 'readonly').getAllKeys();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function push(blob) {
    const keys = await getAllKeys();
    const store = tx(db, 'readwrite');
    // Trim oldest entries so that after the push we still have ≤ HISTORY_CAP.
    const overflow = keys.length + 1 - HISTORY_CAP;
    for (let i = 0; i < overflow; i++) store.delete(keys[i]);
    store.add({ ts: Date.now(), blob });
    return new Promise((resolve, reject) => {
      store.transaction.oncomplete = () => resolve();
      store.transaction.onerror = () => reject(store.transaction.error);
    });
  }

  async function pop() {
    const keys = await getAllKeys();
    if (keys.length === 0) return null;
    const lastKey = keys[keys.length - 1];
    return new Promise((resolve, reject) => {
      const store = tx(db, 'readwrite');
      const getReq = store.get(lastKey);
      getReq.onsuccess = () => {
        const entry = getReq.result;
        store.delete(lastKey);
        store.transaction.oncomplete = () => resolve(entry ? entry.blob : null);
        store.transaction.onerror = () => reject(store.transaction.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  function clear() {
    return new Promise((resolve, reject) => {
      const req = tx(db, 'readwrite').clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  return { push, pop, clear, count, cap: HISTORY_CAP };
}
