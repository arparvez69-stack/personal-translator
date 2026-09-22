/* ============================================================
   Project / Part / Translation-Memory / URL-History data layer
   ============================================================ */
(() => {
"use strict";
const { DB, uid, Settings, countStats } = window.LT;

const Projects = {
  async create(name, opts = {}) {
    const now = Date.now();
    const project = {
      id: uid(),
      name: name || "Untitled Project",
      mode: opts.mode || Settings.get().defaultMode,
      sourceLang: opts.sourceLang || "English",
      targetLang: opts.targetLang || Settings.get().targetLang,
      createdAt: now,
      updatedAt: now
    };
    await DB.put("projects", project);
    return project;
  },
  async all() {
    const list = await DB.getAll("projects");
    return list.sort((a, b) => b.updatedAt - a.updatedAt);
  },
  async get(id) { return DB.get("projects", id); },
  async update(id, patch) {
    const p = await DB.get("projects", id);
    if (!p) return null;
    const next = { ...p, ...patch, updatedAt: Date.now() };
    await DB.put("projects", next);
    return next;
  },
  async touch(id) { return Projects.update(id, {}); },
  async remove(id) {
    const parts = await DB.getAllByIndex("parts", "projectId", id);
    for (const part of parts) await DB.delete("parts", part.id);
    const tms = await DB.getAllByIndex("tm", "projectId", id);
    for (const t of tms) await DB.delete("tm", t.id);
    await DB.delete("projects", id);
  }
};

const Parts = {
  async listByProject(projectId) {
    const list = await DB.getAllByIndex("parts", "projectId", projectId);
    return list.sort((a, b) => a.partNumber - b.partNumber);
  },
  async nextPartNumber(projectId) {
    const list = await Parts.listByProject(projectId);
    return list.length ? Math.max(...list.map((p) => p.partNumber)) + 1 : 1;
  },
  async create(projectId, data) {
    const partNumber = await Parts.nextPartNumber(projectId);
    const now = Date.now();
    const stats = countStats(data.translatedText || "");
    const part = {
      id: uid(),
      projectId,
      partNumber,
      title: data.title || `Part ${String(partNumber).padStart(3, "0")}`,
      sourceText: data.sourceText || "",
      translatedText: data.translatedText || "",
      sourceUrl: data.sourceUrl || "",
      sourceLanguage: data.sourceLanguage || "",
      targetLanguage: data.targetLanguage || "Bangla",
      mode: data.mode || "literary",
      createdAt: now,
      updatedAt: now,
      charCount: stats.chars,
      wordCount: stats.words,
      notes: data.notes || ""
    };
    await DB.put("parts", part);
    await Projects.touch(projectId);
    return part;
  },
  async get(id) { return DB.get("parts", id); },
  async update(id, patch) {
    const part = await DB.get("parts", id);
    if (!part) return null;
    const merged = { ...part, ...patch, updatedAt: Date.now() };
    if (patch.translatedText !== undefined) {
      const stats = countStats(patch.translatedText);
      merged.charCount = stats.chars;
      merged.wordCount = stats.words;
    }
    await DB.put("parts", merged);
    return merged;
  },
  async remove(id) {
    const part = await DB.get("parts", id);
    if (part) await Projects.touch(part.projectId);
    return DB.delete("parts", id);
  },
  /** Merge `part` into the part immediately before it (lower partNumber). Never reverses order, never duplicates. */
  async mergeWithPrevious(partId) {
    const part = await DB.get("parts", partId);
    if (!part) throw new Error("Part not found.");
    const siblings = await Parts.listByProject(part.projectId);
    const idx = siblings.findIndex((p) => p.id === partId);
    if (idx <= 0) throw new Error("No previous part to merge with.");
    const prev = siblings[idx - 1];
    const mergedSource = (prev.sourceText || "") + "\n\n" + (part.sourceText || "");
    const mergedTranslation = (prev.translatedText || "") + "\n\n" + (part.translatedText || "");
    const updatedPrev = await Parts.update(prev.id, {
      sourceText: mergedSource,
      translatedText: mergedTranslation,
      notes: [prev.notes, part.notes].filter(Boolean).join(" | ")
    });
    await Parts.remove(part.id);
    return updatedPrev;
  },
  async moveUp(partId) {
    const part = await DB.get("parts", partId);
    const siblings = await Parts.listByProject(part.projectId);
    const idx = siblings.findIndex((p) => p.id === partId);
    if (idx <= 0) return;
    const other = siblings[idx - 1];
    await DB.put("parts", { ...part, partNumber: other.partNumber });
    await DB.put("parts", { ...other, partNumber: part.partNumber });
  },
  async moveDown(partId) {
    const part = await DB.get("parts", partId);
    const siblings = await Parts.listByProject(part.projectId);
    const idx = siblings.findIndex((p) => p.id === partId);
    if (idx === -1 || idx >= siblings.length - 1) return;
    const other = siblings[idx + 1];
    await DB.put("parts", { ...part, partNumber: other.partNumber });
    await DB.put("parts", { ...other, partNumber: part.partNumber });
  }
};

const TM = {
  async listByProject(projectId) {
    return DB.getAllByIndex("tm", "projectId", projectId);
  },
  async add(projectId, term, translation, notes = "", type = "term") {
    const entry = { id: uid(), projectId, term, translation, notes, type, createdAt: Date.now() };
    await DB.put("tm", entry);
    return entry;
  },
  async update(id, patch) {
    const t = await DB.get("tm", id);
    if (!t) return null;
    const next = { ...t, ...patch };
    await DB.put("tm", next);
    return next;
  },
  async remove(id) { return DB.delete("tm", id); }
};

const UrlHistory = {
  async record(entry) {
    const rec = { id: uid(), visitedAt: Date.now(), ...entry };
    await DB.put("urlHistory", rec);
    return rec;
  },
  async recent(limit = 20) {
    const list = await DB.getAll("urlHistory");
    return list.sort((a, b) => b.visitedAt - a.visitedAt).slice(0, limit);
  },
  async remove(id) { return DB.delete("urlHistory", id); },
  async findByUrlInProject(url, projectId) {
    const list = await DB.getAll("urlHistory");
    return list.find((h) => h.url === url && h.projectId === projectId) || null;
  }
};

async function exportProjectJSON(projectId) {
  const project = await Projects.get(projectId);
  const parts = await Parts.listByProject(projectId);
  const tm = await TM.listByProject(projectId);
  return JSON.stringify({ formatVersion: 1, exportedAt: Date.now(), project, parts, tm }, null, 2);
}

async function importProjectJSON(jsonText) {
  const data = JSON.parse(jsonText);
  if (!data.project) throw new Error("Invalid project file.");
  const newProjectId = uid();
  const now = Date.now();
  await DB.put("projects", { ...data.project, id: newProjectId, updatedAt: now });
  for (const part of data.parts || []) {
    await DB.put("parts", { ...part, id: uid(), projectId: newProjectId });
  }
  for (const t of data.tm || []) {
    await DB.put("tm", { ...t, id: uid(), projectId: newProjectId });
  }
  return newProjectId;
}

async function exportAllData() {
  const [projects, parts, tm, urlHistory] = await Promise.all([
    DB.getAll("projects"), DB.getAll("parts"), DB.getAll("tm"), DB.getAll("urlHistory")
  ]);
  return JSON.stringify({ formatVersion: 1, exportedAt: Date.now(), projects, parts, tm, urlHistory, settings: Settings.get() }, null, 2);
}

async function importAllData(jsonText) {
  const data = JSON.parse(jsonText);
  for (const p of data.projects || []) await DB.put("projects", p);
  for (const p of data.parts || []) await DB.put("parts", p);
  for (const t of data.tm || []) await DB.put("tm", t);
  for (const h of data.urlHistory || []) await DB.put("urlHistory", h);
  if (data.settings) Settings.set(data.settings);
}

function partsToPlainText(parts) {
  return parts.map((p) => `${p.title}\n\n${p.translatedText}`).join("\n\n\n");
}
function partsToMarkdown(parts) {
  return parts.map((p) => `## ${p.title}\n\n${p.translatedText}`).join("\n\n");
}
function partsToHtml(projectName, parts) {
  const body = parts.map((p) => `<h2>${escHtml(p.title)}</h2>\n<div>${escHtml(p.translatedText).replace(/\n\n/g, "</div><div>").replace(/\n/g, "<br>")}</div>`).join("\n");
  return `<!DOCTYPE html><html lang="bn"><head><meta charset="utf-8"><title>${escHtml(projectName)}</title>
<style>body{font-family:Georgia,'Noto Serif Bengali',serif;max-width:700px;margin:40px auto;padding:0 20px;line-height:1.9;font-size:19px;} h2{margin-top:2.5em;}</style>
</head><body><h1>${escHtml(projectName)}</h1>${body}</body></html>`;
}
function escHtml(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

function downloadFile(filename, content, mime = "text/plain") {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

window.LT.Data = {
  Projects, Parts, TM, UrlHistory,
  exportProjectJSON, importProjectJSON, exportAllData, importAllData,
  partsToPlainText, partsToMarkdown, partsToHtml, downloadFile
};
})();
