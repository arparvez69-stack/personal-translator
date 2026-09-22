/* ============================================================
   Literary Translator PWA — app.js
   Offline-first storage (IndexedDB), literary translation engine,
   webpage extraction, project/part management, reading mode.
   ============================================================ */

(() => {
"use strict";

/* ---------------- IndexedDB layer ---------------- */

const DB_NAME = "literary-translator-db";
const DB_VERSION = 1;
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("projects")) {
        const s = db.createObjectStore("projects", { keyPath: "id" });
        s.createIndex("updatedAt", "updatedAt");
      }
      if (!db.objectStoreNames.contains("parts")) {
        const s = db.createObjectStore("parts", { keyPath: "id" });
        s.createIndex("projectId", "projectId");
        s.createIndex("projectId_partNumber", ["projectId", "partNumber"]);
      }
      if (!db.objectStoreNames.contains("tm")) {
        const s = db.createObjectStore("tm", { keyPath: "id" });
        s.createIndex("projectId", "projectId");
      }
      if (!db.objectStoreNames.contains("urlHistory")) {
        const s = db.createObjectStore("urlHistory", { keyPath: "id" });
        s.createIndex("visitedAt", "visitedAt");
      }
      if (!db.objectStoreNames.contains("kv")) {
        db.createObjectStore("kv", { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(storeName, mode) {
  return openDB().then((db) => db.transaction(storeName, mode).objectStore(storeName));
}

const DB = {
  put(store, value) {
    return tx(store, "readwrite").then((os) => new Promise((res, rej) => {
      const r = os.put(value);
      r.onsuccess = () => res(value);
      r.onerror = () => rej(r.error);
    }));
  },
  get(store, key) {
    return tx(store, "readonly").then((os) => new Promise((res, rej) => {
      const r = os.get(key);
      r.onsuccess = () => res(r.result || null);
      r.onerror = () => rej(r.error);
    }));
  },
  delete(store, key) {
    return tx(store, "readwrite").then((os) => new Promise((res, rej) => {
      const r = os.delete(key);
      r.onsuccess = () => res(true);
      r.onerror = () => rej(r.error);
    }));
  },
  getAll(store) {
    return tx(store, "readonly").then((os) => new Promise((res, rej) => {
      const r = os.getAll();
      r.onsuccess = () => res(r.result || []);
      r.onerror = () => rej(r.error);
    }));
  },
  getAllByIndex(store, indexName, value) {
    return tx(store, "readonly").then((os) => new Promise((res, rej) => {
      const idx = os.index(indexName);
      const r = idx.getAll(value);
      r.onsuccess = () => res(r.result || []);
      r.onerror = () => rej(r.error);
    }));
  },
  clearAll() {
    return openDB().then((db) => Promise.all(
      ["projects", "parts", "tm", "urlHistory", "kv"].map((name) => new Promise((res, rej) => {
        const r = db.transaction(name, "readwrite").objectStore(name).clear();
        r.onsuccess = () => res();
        r.onerror = () => rej(r.error);
      }))
    ));
  }
};

function uid() {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 9);
}

/* ---------------- Settings (localStorage — small, per spec §28) ---------------- */

const DEFAULT_SETTINGS = {
  targetLang: "Bangla",
  defaultMode: "literary",
  chunkSize: 2800,
  apiBase: "https://api.anthropic.com",
  apiModel: "claude-sonnet-4-6",
  apiKey: "",
  extractProxy: "",
  fontSize: 19,
  lineSpacing: 1.9,
  theme: "light",
  autosave: true,
  confirmDelete: true
};

const Settings = {
  get() {
    try {
      const raw = localStorage.getItem("lt-settings");
      return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
    } catch { return { ...DEFAULT_SETTINGS }; }
  },
  set(patch) {
    const cur = Settings.get();
    const next = { ...cur, ...patch };
    localStorage.setItem("lt-settings", JSON.stringify(next));
    applyTheme(next.theme);
    document.documentElement.style.setProperty("--reading-font-size", next.fontSize + "px");
    document.documentElement.style.setProperty("--reading-line-height", next.lineSpacing);
    return next;
  }
};

function applyTheme(theme) {
  document.body.setAttribute("data-theme", theme === "dark" ? "dark" : "light");
}

/* ---------------- Toast / Modal helpers ---------------- */

function toast(msg, ms = 2600) {
  const root = document.getElementById("toast-root");
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

function confirmModal(title, body, confirmLabel = "Confirm") {
  return new Promise((resolve) => {
    const root = document.getElementById("modal-root");
    root.innerHTML = `<div class="modal-sheet">
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(body)}</p>
      <div class="btn-row">
        <button class="ghost-btn" id="modal-cancel">Cancel</button>
        <button class="danger-btn" id="modal-confirm">${escapeHtml(confirmLabel)}</button>
      </div>
    </div>`;
    root.classList.add("open");
    root.querySelector("#modal-cancel").onclick = () => { root.classList.remove("open"); resolve(false); };
    root.querySelector("#modal-confirm").onclick = () => { root.classList.remove("open"); resolve(true); };
  });
}

function promptModal(title, placeholder = "", initial = "") {
  return new Promise((resolve) => {
    const root = document.getElementById("modal-root");
    root.innerHTML = `<div class="modal-sheet">
      <h3>${escapeHtml(title)}</h3>
      <input id="modal-input" placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(initial)}">
      <div class="btn-row">
        <button class="ghost-btn" id="modal-cancel">Cancel</button>
        <button class="primary-btn" id="modal-ok">OK</button>
      </div>
    </div>`;
    root.classList.add("open");
    const input = root.querySelector("#modal-input");
    input.focus();
    root.querySelector("#modal-cancel").onclick = () => { root.classList.remove("open"); resolve(null); };
    root.querySelector("#modal-ok").onclick = () => { root.classList.remove("open"); resolve(input.value.trim()); };
  });
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function countStats(text) {
  const chars = text.length;
  const words = (text.trim().match(/\S+/g) || []).length;
  return { chars, words };
}

window.LT = { DB, uid, Settings, toast, confirmModal, promptModal, escapeHtml, countStats, applyTheme };

})();
