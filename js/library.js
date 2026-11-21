/* =========================================================
   最近開いたファイル（IndexedDB）
   - 内容・最後に読んでいた位置（元ファイルの行番号）を保存する
   - データはこの端末のブラウザ内だけに保存され、外部には送信しない
   ========================================================= */
(() => {
  'use strict';

  const DB_NAME = 'md-viewer';
  const STORE = 'docs';
  const MAX_DOCS = 15;
  const MAX_CONTENT_CHARS = 2000000; // これより大きいファイルは内容を保存しない（位置のみ）

  let dbPromise = null;

  function openDb() {
    if (!('indexedDB' in window)) return Promise.reject(new Error('IndexedDB unavailable'));
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          const store = req.result.createObjectStore(STORE, { keyPath: 'key' });
          store.createIndex('opened', 'opened');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  async function run(mode, fn) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  /** 内容から短いハッシュを作る（FNV-1a 32bit）。クリップボード等のキーに使う */
  function hash(text) {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  const MdLibrary = {
    hash,

    /** 文書のキー。ファイルは名前、URL は URL、それ以外は内容のハッシュ */
    keyFor({ kind, name, url, content }) {
      if (kind === 'url' && url) return 'url:' + url;
      if (kind === 'file' && name) return 'file:' + name;
      return 'text:' + hash(content || '');
    },

    async get(key) {
      try { return await run('readonly', (s) => s.get(key)); } catch (e) { return undefined; }
    },

    async list() {
      try {
        const all = await run('readonly', (s) => s.getAll());
        return (all || []).sort((a, b) => b.opened - a.opened);
      } catch (e) { return []; }
    },

    async save(doc) {
      try {
        const record = { ...doc };
        if (record.content && record.content.length > MAX_CONTENT_CHARS) record.content = null;
        await run('readwrite', (s) => s.put(record));
        await this.prune();
      } catch (e) { /* 保存できなくても閲覧には影響させない */ }
    },

    async updatePosition(key, position) {
      try {
        const doc = await this.get(key);
        if (!doc) return;
        doc.position = position;
        await run('readwrite', (s) => s.put(doc));
      } catch (e) { /* noop */ }
    },

    async setField(key, field, value) {
      try {
        const doc = await this.get(key);
        if (!doc) return;
        doc[field] = value;
        await run('readwrite', (s) => s.put(doc));
      } catch (e) { /* noop */ }
    },

    async remove(key) {
      try { await run('readwrite', (s) => s.delete(key)); } catch (e) { /* noop */ }
    },

    async prune() {
      const all = await this.list();
      const extra = all.slice(MAX_DOCS);
      if (extra.length === 0) return;
      await run('readwrite', (s) => { extra.forEach((d) => s.delete(d.key)); return null; });
    }
  };

  window.MdLibrary = MdLibrary;
})();
