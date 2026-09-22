/* ============================================================
   UI: router + view rendering + event wiring
   ============================================================ */
(() => {
"use strict";
const { DB, uid, Settings, toast, confirmModal, promptModal, escapeHtml, countStats, applyTheme } = window.LT;
const { Projects, Parts, TM, UrlHistory, exportProjectJSON, importProjectJSON, exportAllData, importAllData,
        partsToPlainText, partsToMarkdown, partsToHtml, downloadFile } = window.LT.Data;
const { chunkText, estimateChunks, translateChunks, retryChunk, runQualityCheck } = window.LT.Translation;
const { extractFromUrl } = window.LT.Extraction;

const viewRoot = document.getElementById("view-root");
const viewTitle = document.getElementById("view-title");
const backBtn = document.getElementById("btn-back");
const history_ = [];
let currentView = null, currentParams = null;

function fmtDate(ts) {
  return new Date(ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formModal(title, fields) {
  // fields: [{key, label, placeholder, value, options}]
  return new Promise((resolve) => {
    const root = document.getElementById("modal-root");
    root.innerHTML = `<div class="modal-sheet">
      <h3>${escapeHtml(title)}</h3>
      ${fields.map((f) => {
        const lbl = `<label style="display:block;font-size:12px;color:var(--ink-soft);margin:10px 0 4px;">${escapeHtml(f.label)}</label>`;
        if (f.options && f.options.length) {
          const opts = f.options.map((o) => {
            const val = typeof o === "object" ? o.value : o;
            const label = typeof o === "object" ? o.label : o;
            const sel = val === f.value ? " selected" : "";
            return `<option value="${escapeHtml(val)}"${sel}>${escapeHtml(label)}</option>`;
          }).join("");
          return `${lbl}<select data-key="${f.key}" style="width:100%;padding:10px 12px;border-radius:var(--radius);border:1px solid var(--line);background:var(--paper-raised);color:var(--ink);">${opts}</select>`;
        }
        return `${lbl}<input data-key="${f.key}" placeholder="${escapeHtml(f.placeholder || "")}" value="${escapeHtml(f.value || "")}">`;
      }).join("")}
      <div class="btn-row">
        <button class="ghost-btn" id="modal-cancel">Cancel</button>
        <button class="primary-btn" id="modal-ok">Save</button>
      </div>
    </div>`;
    root.classList.add("open");

    function close(val) {
      root.classList.remove("open");
      root.removeEventListener("click", onBackdrop);
      window.removeEventListener("keydown", onKey);
      resolve(val);
    }
    function onBackdrop(e) {
      if (e.target === root) close(null);
    }
    function onKey(e) {
      if (e.key === "Escape") close(null);
    }

    root.addEventListener("click", onBackdrop);
    window.addEventListener("keydown", onKey);

    root.querySelector("#modal-cancel").onclick = () => close(null);
    root.querySelector("#modal-ok").onclick = () => {
      const out = {};
      fields.forEach((f) => {
        const inputEl = root.querySelector(`[data-key="${f.key}"]`);
        out[f.key] = inputEl ? inputEl.value.trim() : "";
      });
      close(out);
    };
  });
}

function nav(view, params = {}, push = true) {
  if (push && currentView) history_.push({ view: currentView, params: currentParams });
  currentView = view; currentParams = params;
  backBtn.hidden = history_.length === 0;
  render(view, params);
}
backBtn.onclick = () => {
  const prev = history_.pop();
  backBtn.hidden = history_.length === 0;
  if (prev) { currentView = prev.view; currentParams = prev.params; render(prev.view, prev.params); }
  else nav("home", {}, false);
};

const TITLES = {
  home: "Literary Translator", paste: "Paste Text", url: "Translate Webpage", projects: "My Projects",
  "project-detail": "Project", reading: "Reading Mode", memory: "Translation Memory", settings: "Settings"
};

async function render(view, params) {
  viewTitle.textContent = TITLES[view] || "Literary Translator";
  const tpl = document.getElementById(`tpl-${view}`);
  viewRoot.innerHTML = "";
  viewRoot.appendChild(tpl.content.cloneNode(true));
  const fn = RENDERERS[view];
  if (fn) await fn(params);
  document.querySelectorAll("[data-nav]").forEach((el) => {
    el.onclick = () => nav(el.getAttribute("data-nav"));
  });
}

/* ---------------- Home ---------------- */

async function renderHome() {
  const projects = (await Projects.all()).slice(0, 5);
  const pList = document.getElementById("home-recent-projects");
  pList.innerHTML = projects.length ? "" : `<div class="empty-note">No projects yet. Start with Paste Text or Translate Webpage.</div>`;
  for (const p of projects) {
    const parts = await Parts.listByProject(p.id);
    const div = document.createElement("div");
    div.className = "list-item";
    div.innerHTML = `<div class="li-title">${escapeHtml(p.name)}</div><div class="li-sub">${parts.length} part(s) · updated ${fmtDate(p.updatedAt)}</div>`;
    div.onclick = () => nav("project-detail", { projectId: p.id });
    pList.appendChild(div);
  }

  const pages = await UrlHistory.recent(5);
  const pgList = document.getElementById("home-recent-pages");
  pgList.innerHTML = pages.length ? "" : `<div class="empty-note">No pages translated yet.</div>`;
  for (const h of pages) {
    const div = document.createElement("div");
    div.className = "list-item";
    div.innerHTML = `<div class="li-title">${escapeHtml(h.title || h.url)}</div><div class="li-sub">${escapeHtml(h.url)}</div>`;
    div.onclick = () => nav("url", { prefillUrl: h.url });
    pgList.appendChild(div);
  }

  try {
    if (navigator.storage?.estimate) {
      const { usage, quota } = await navigator.storage.estimate();
      document.getElementById("storage-usage").textContent =
        `Storage: ${(usage / 1048576).toFixed(1)} MB used of ${(quota / 1048576).toFixed(0)} MB`;
    }
  } catch { /* not available */ }
}

/* ---------------- Shared: project selector fill ---------------- */

async function fillProjectSelect(selectEl, selectedId) {
  const projects = await Projects.all();
  selectEl.innerHTML = projects.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("");
  if (selectedId) selectEl.value = selectedId;
  return projects;
}

async function ensureAtLeastOneProject() {
  const projects = await Projects.all();
  if (projects.length) return projects[0].id;
  const p = await Projects.create("My Novel Project");
  return p.id;
}

/* ---------------- Paste view ---------------- */

let pasteState = { chunks: [], results: [], failedIndices: [], mode: "literary", sourceLang: "", targetLang: "" };

async function renderPaste() {
  const select = document.getElementById("paste-project");
  const defaultId = await ensureAtLeastOneProject();
  await fillProjectSelect(select, defaultId);

  document.getElementById("paste-new-project").onclick = async () => {
    const name = await promptModal("New project name");
    if (!name) return;
    const p = await Projects.create(name);
    await fillProjectSelect(select, p.id);
  };

  const input = document.getElementById("paste-input");
  const stats = document.getElementById("paste-stats");
  const s = Settings.get();

  function updateStats() {
    const { chars, words } = countStats(input.value);
    const chunks = input.value ? estimateChunks(input.value, s.chunkSize) : 0;
    stats.textContent = `${chars} characters · ${words} words · ~${chunks} chunk(s)`;
  }
  input.oninput = updateStats;
  updateStats();

  document.getElementById("paste-btn").onclick = async () => {
    try {
      const text = await navigator.clipboard.readText();
      input.value = text; updateStats();
    } catch { toast("Couldn't read clipboard — paste manually instead."); }
  };
  document.getElementById("paste-clear-btn").onclick = () => { input.value = ""; updateStats(); };

  const langSelect = document.getElementById("paste-source-lang");
  const customLangInput = document.getElementById("paste-source-lang-custom");
  if (langSelect && customLangInput) {
    langSelect.onchange = () => {
      customLangInput.style.display = langSelect.value === "custom" ? "block" : "none";
      if (langSelect.value === "custom") customLangInput.focus();
    };
  }

  document.getElementById("paste-translate-btn").onclick = async () => {
    const text = input.value.trim();
    if (!text) { toast("Paste some text first."); return; }
    if (!select.value) { toast("Choose or create a project first."); return; }
    const project = await Projects.get(select.value);

    let sourceLang = langSelect ? langSelect.value : "English";
    if (sourceLang === "custom" && customLangInput) {
      sourceLang = customLangInput.value.trim() || "English";
    }

    const currentKey = Settings.get().apiKey;
    if (!currentKey) {
      const openSettings = await confirmModal(
        "Gemini API Key Required (100% Free)",
        "Translation requires a Gemini API key. Google provides free Gemini keys at aistudio.google.com with no payment or credit card required.\n\nWould you like to open Settings now to paste your key?",
        "Open Settings"
      );
      if (openSettings) {
        nav("settings");
        return;
      }
    }

    await runTranslation({
      text, projectId: project.id, sourceLang, targetLang: project.targetLang, mode: project.mode,
      progressWrap: "paste-progress", progressFill: "paste-progress-fill", progressText: "paste-progress-text",
      resultWrap: "paste-result", originalView: "paste-original-view", translationView: "paste-translation-view",
      dualPane: "paste-dual-pane", stateKey: "paste"
    });
  };

  wireResultTabs("paste");
  wireCopyButtons("paste");

  document.getElementById("paste-save-separate").onclick = () => saveResultAsPart("paste", select.value, { title: null });
  document.getElementById("paste-merge-prev").onclick = () => mergeResultWithPrevious("paste", select.value);
  document.getElementById("paste-discard").onclick = async () => {
    if (await confirmModal("Discard translation?", "This will discard the unsaved translation. This cannot be undone.", "Discard")) {
      resetResultBlock("paste");
    }
  };
}

/* ---------------- URL view ---------------- */

let urlState = { extracted: null, url: "", nextChapter: null };

async function renderUrl(params) {
  const select = document.getElementById("url-project");
  const defaultId = await ensureAtLeastOneProject();
  await fillProjectSelect(select, defaultId);
  document.getElementById("url-new-project").onclick = async () => {
    const name = await promptModal("New project name");
    if (!name) return;
    const p = await Projects.create(name);
    await fillProjectSelect(select, p.id);
  };

  const urlInput = document.getElementById("url-input");
  if (params?.prefillUrl) urlInput.value = params.prefillUrl;

  await renderRecentPages();

  document.getElementById("url-load-btn").onclick = () => loadUrl(urlInput.value.trim(), select.value);
  document.getElementById("url-cancel-btn").onclick = () => {
    document.getElementById("url-preview").hidden = true;
  };
  document.getElementById("url-translate-btn").onclick = async () => {
    const text = document.getElementById("url-extracted-text").value.trim();
    if (!text) { toast("No extracted text to translate."); return; }
    const project = await Projects.get(select.value);

    const currentKey = Settings.get().apiKey;
    if (!currentKey) {
      const openSettings = await confirmModal(
        "Gemini API Key Required (100% Free)",
        "Translation requires a Gemini API key. Google provides free Gemini keys at aistudio.google.com with no payment or credit card required.\n\nWould you like to open Settings now to paste your key?",
        "Open Settings"
      );
      if (openSettings) {
        nav("settings");
        return;
      }
    }

    const urlLangSelect = document.getElementById("url-source-lang");
    const sourceLang = (urlLangSelect && urlLangSelect.value !== "Auto-detect")
      ? urlLangSelect.value
      : (urlState.extracted?.language || "English");

    document.getElementById("url-preview").hidden = true;
    await runTranslation({
      text, projectId: project.id, sourceLang,
      targetLang: project.targetLang, mode: project.mode,
      progressWrap: "url-progress", progressFill: "url-progress-fill", progressText: "url-progress-text",
      resultWrap: "url-result", originalView: "url-original-view", translationView: "url-translation-view",
      dualPane: "url-dual-pane", stateKey: "url", sourceUrl: urlState.url, title: urlState.extracted?.title
    });
    const nc = document.getElementById("url-next-chapter");
    if (urlState.nextChapter) {
      nc.hidden = false;
      nc.innerHTML = `Detected a possible next chapter: <b>${escapeHtml(urlState.nextChapter.label)}</b><br>
        <span style="word-break:break-all;font-size:12px;color:var(--ink-soft)">${escapeHtml(urlState.nextChapter.url)}</span>
        <div class="btn-row"><button class="ghost-btn" id="go-next-chapter">Load Next Chapter</button></div>`;
      document.getElementById("go-next-chapter").onclick = () => {
        urlInput.value = urlState.nextChapter.url;
        document.getElementById("url-result").hidden = true;
        nc.hidden = true;
        loadUrl(urlState.nextChapter.url, select.value);
      };
    } else nc.hidden = true;
  };

  wireResultTabs("url");
  wireCopyButtons("url");
  document.getElementById("url-read-now").onclick = () => {
    openReadNow(urlState.extracted?.title || "Untitled page", document.getElementById("url-translation-view").textContent);
  };
  document.getElementById("url-save-separate").onclick = () =>
    saveResultAsPart("url", select.value, { title: urlState.extracted?.title, sourceUrl: urlState.url });
  document.getElementById("url-merge-prev").onclick = () => mergeResultWithPrevious("url", select.value);
  document.getElementById("url-discard").onclick = async () => {
    if (await confirmModal("Discard translation?", "This will discard the unsaved translation.", "Discard")) resetResultBlock("url");
  };
}

async function loadUrl(url, projectId) {
  if (!url) { toast("Enter a URL first."); return; }
  const statusEl = document.getElementById("url-status");
  statusEl.hidden = false; statusEl.className = "status-msg";
  statusEl.textContent = "Loading page…";
  document.getElementById("url-preview").hidden = true;
  document.getElementById("url-result").hidden = true;

  const existing = await UrlHistory.findByUrlInProject(url, projectId);
  if (existing) {
    const proceed = await confirmModal("Page already in this project", "This page already exists in this project. Add it again anyway?", "Add Anyway");
    if (!proceed) { statusEl.hidden = true; return; }
  }

  try {
    const extracted = await extractFromUrl(url);
    urlState = { extracted, url, nextChapter: extracted.nextChapter };
    statusEl.hidden = true;
    const prev = document.getElementById("url-preview");
    prev.hidden = false;
    document.getElementById("url-meta-title").textContent = extracted.title;
    document.getElementById("url-meta-source").textContent = new URL(url).hostname;
    document.getElementById("url-meta-lang").textContent = extracted.language;
    const { chars, words } = countStats(extracted.text);
    document.getElementById("url-meta-chars").textContent = chars;
    document.getElementById("url-meta-words").textContent = words;
    document.getElementById("url-meta-chunks").textContent = estimateChunks(extracted.text, Settings.get().chunkSize);
    document.getElementById("url-extracted-text").value = extracted.text;
    await UrlHistory.record({ url, title: extracted.title, projectId, status: "extracted" });
    await renderRecentPages();
  } catch (err) {
    statusEl.className = "status-msg error";
    statusEl.textContent = err.message + "  ";
    const btn = document.createElement("button");
    btn.className = "small-btn"; btn.textContent = "Use Paste Mode";
    btn.style.marginLeft = "6px";
    btn.onclick = () => nav("paste");
    statusEl.appendChild(btn);
  }
}

async function renderRecentPages() {
  const list = document.getElementById("url-recent-list");
  if (!list) return;
  const pages = await UrlHistory.recent(10);
  list.innerHTML = pages.length ? "" : `<div class="empty-note">No pages yet.</div>`;
  for (const h of pages) {
    const div = document.createElement("div");
    div.className = "list-item";
    div.innerHTML = `<div class="li-title">${escapeHtml(h.title || h.url)}</div>
      <div class="li-sub">${escapeHtml(h.url)} · ${fmtDate(h.visitedAt)}</div>
      <div class="li-actions">
        <button class="small-btn" data-act="open">Translate Again</button>
        <button class="small-btn" data-act="delete">Delete</button>
      </div>`;
    div.querySelector('[data-act="open"]').onclick = () => {
      document.getElementById("url-input").value = h.url;
      loadUrl(h.url, document.getElementById("url-project").value);
    };
    div.querySelector('[data-act="delete"]').onclick = async () => {
      await UrlHistory.remove(h.id);
      renderRecentPages();
    };
    list.appendChild(div);
  }
}

/* ---------------- Shared translation runner ---------------- */

async function runTranslation({ text, projectId, sourceLang, targetLang, mode, progressWrap, progressFill, progressText, resultWrap, originalView, translationView, dualPane, stateKey, sourceUrl, title }) {
  const s = Settings.get();
  const glossary = (await TM.listByProject(projectId)).map((t) => ({ term: t.term, translation: t.translation, notes: t.notes }));
  const chunks = chunkText(text, s.chunkSize);

  const resWrapEl = document.getElementById(resultWrap);
  // Clear any previous error/retry messages
  resWrapEl.querySelectorAll(".status-msg.error").forEach((el) => el.remove());

  const { results, failedIndices, lastError } = await translateChunks(chunks, { mode, sourceLang, targetLang, glossary }, (p) => {
    const pct = Math.round(((p.index + (p.status === "done" || p.status === "failed" ? 1 : 0)) / p.total) * 100);
    fill.style.width = pct + "%";
    txt.textContent = p.status === "failed"
      ? `Chunk ${p.index + 1} of ${p.total} failed: ${p.error}`
      : `Translating chunk ${p.index + 1} of ${p.total}…`;
  });

  wrap.hidden = true;

  if (failedIndices.length === chunks.length) {
    const errText = lastError || "Translation failed";
    const isKeyIssue = /key|denied|permission|403|unauthorized/i.test(errText);
    const goSettings = await confirmModal(
      "Translation Failed",
      `${errText}\n\n${isKeyIssue ? "A Gemini API key is needed. You can get one 100% free with no credit card required at aistudio.google.com." : "Please check your network and try again."}`,
      isKeyIssue ? "Open Settings" : "OK"
    );
    if (goSettings && isKeyIssue) {
      nav("settings");
    }
    return;
  }

  if (failedIndices.length) {
    const proceed = await confirmModal(
      "Some chunks failed",
      `${failedIndices.length} of ${chunks.length} chunk(s) failed to translate (${lastError || ""}). Continue with the partial result for now?`,
      "Continue"
    );
    if (!proceed) return;
  }

  const warnings = runQualityCheck(chunks, results);
  if (warnings.length) toast(warnings[0]);

  const state = window.LT._resultState = window.LT._resultState || {};
  state[stateKey] = { chunks, results, failedIndices, sourceText: text, projectId, mode, sourceLang, targetLang, sourceUrl: sourceUrl || "", title: title || "" };

  const joinedTranslation = results.map((r) => r ?? "[chunk failed — retry needed]").join("\n\n");
  document.getElementById(originalView).textContent = text;
  document.getElementById(translationView).textContent = joinedTranslation;
  document.getElementById(dualPane).dataset.mode = "both";
  resWrapEl.hidden = false;

  if (failedIndices.length) {
    const retryBar = document.createElement("div");
    retryBar.className = "status-msg error";
    retryBar.style.display = "flex";
    retryBar.style.alignItems = "center";
    retryBar.style.justifyContent = "space-between";
    retryBar.style.flexWrap = "wrap";
    retryBar.style.gap = "8px";
    retryBar.innerHTML = `<span><b>${failedIndices.length} chunk(s) failed:</b> ${escapeHtml(lastError || "Could not complete translation")}</span>`;

    const actions = document.createElement("div");
    actions.style.display = "flex";
    actions.style.gap = "6px";

    const retryBtn = document.createElement("button");
    retryBtn.className = "small-btn";
    retryBtn.textContent = "Retry Failed Chunk(s)";
    retryBtn.onclick = async () => {
      for (const idx of [...failedIndices]) {
        try {
          const r = await retryChunk(chunks, idx, { mode, sourceLang, targetLang, glossary });
          results[idx] = r;
          failedIndices.splice(failedIndices.indexOf(idx), 1);
        } catch (err) { toast(`Retry failed: ${err.message}`); }
      }
      document.getElementById(translationView).textContent = results.map((r) => r ?? "[chunk failed — retry needed]").join("\n\n");
      if (!failedIndices.length) { retryBar.remove(); toast("All chunks translated."); }
    };
    actions.appendChild(retryBtn);

    const setBtn = document.createElement("button");
    setBtn.className = "small-btn";
    setBtn.textContent = "Settings (⚙️)";
    setBtn.onclick = () => nav("settings");
    actions.appendChild(setBtn);

    retryBar.appendChild(actions);
    resWrapEl.prepend(retryBar);
  }
}

function wireResultTabs(prefix) {
  document.querySelectorAll(`#${prefix}-result .tab-btn`).forEach((btn) => {
    btn.onclick = () => {
      document.querySelectorAll(`#${prefix}-result .tab-btn`).forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(`${prefix}-dual-pane`).dataset.mode = btn.dataset.tab;
    };
  });
}

function wireCopyButtons(prefix) {
  document.querySelectorAll(`#${prefix}-result [data-copy]`).forEach((btn) => {
    btn.onclick = async () => {
      const which = btn.getAttribute("data-copy");
      const el = document.getElementById(`${prefix}-${which}-view`);
      try { await navigator.clipboard.writeText(el.textContent); toast("Copied."); }
      catch { toast("Couldn't copy — select text manually."); }
    };
  });
}

async function saveResultAsPart(stateKey, projectId, { title, sourceUrl }) {
  const state = (window.LT._resultState || {})[stateKey];
  if (!state) { toast("Nothing to save."); return; }
  const translatedText = state.results.map((r) => r ?? "").join("\n\n");
  const part = await Parts.create(projectId, {
    title: title || undefined,
    sourceText: state.sourceText,
    translatedText,
    sourceUrl: sourceUrl || "",
    sourceLanguage: state.sourceLang,
    targetLanguage: state.targetLang,
    mode: state.mode
  });
  toast(`Saved as ${part.title}.`);
  resetResultBlock(stateKey);
}

async function mergeResultWithPrevious(stateKey, projectId) {
  const state = (window.LT._resultState || {})[stateKey];
  if (!state) { toast("Nothing to merge."); return; }
  const parts = await Parts.listByProject(projectId);
  if (!parts.length) { toast("No existing part to merge with — save as separate first."); return; }
  const last = parts[parts.length - 1];
  const translatedText = state.results.map((r) => r ?? "").join("\n\n");
  const ok = await confirmModal("Merge with previous?", `This will append the new translation onto "${last.title}", in order. This cannot be undone.`, "Merge");
  if (!ok) return;
  await Parts.update(last.id, {
    sourceText: (last.sourceText || "") + "\n\n" + state.sourceText,
    translatedText: (last.translatedText || "") + "\n\n" + translatedText
  });
  toast(`Merged into ${last.title}.`);
  resetResultBlock(stateKey);
}

function resetResultBlock(stateKey) {
  document.getElementById(`${stateKey}-result`).hidden = true;
  if (stateKey === "paste") document.getElementById("paste-input").value = "";
  if (stateKey === "url") document.getElementById("url-extracted-text").value = "";
  if (window.LT._resultState) delete window.LT._resultState[stateKey];
}

function openReadNow(title, translatedText) {
  const root = document.getElementById("modal-root");
  root.innerHTML = `<div class="modal-sheet" style="max-height:85vh;overflow-y:auto;">
    <h3>${escapeHtml(title)}</h3>
    <div class="reading-content" style="font-size:18px;">${escapeHtml(translatedText)}</div>
    <div class="btn-row"><button class="primary-btn" id="modal-close">Close</button></div>
  </div>`;
  root.classList.add("open");

  function close() {
    root.classList.remove("open");
    root.removeEventListener("click", onBackdrop);
    window.removeEventListener("keydown", onKey);
  }
  function onBackdrop(e) {
    if (e.target === root) close();
  }
  function onKey(e) {
    if (e.key === "Escape") close();
  }
  root.addEventListener("click", onBackdrop);
  window.addEventListener("keydown", onKey);
  root.querySelector("#modal-close").onclick = close;
}

/* ---------------- Projects list + detail ---------------- */

async function renderProjects() {
  const listEl = document.getElementById("projects-list");
  const searchEl = document.getElementById("project-search");

  async function draw(filter = "") {
    const projects = await Projects.all();
    listEl.innerHTML = "";
    for (const p of projects) {
      const parts = await Parts.listByProject(p.id);
      const haystack = (p.name + " " + parts.map((x) => x.title + x.sourceText + x.translatedText).join(" ")).toLowerCase();
      if (filter && !haystack.includes(filter.toLowerCase())) continue;
      const div = document.createElement("div");
      div.className = "list-item";
      div.innerHTML = `<div class="li-title">${escapeHtml(p.name)}</div>
        <div class="li-sub">${parts.length} part(s) · ${p.sourceLang} → ${p.targetLang} · ${p.mode} · updated ${fmtDate(p.updatedAt)}</div>`;
      div.onclick = () => nav("project-detail", { projectId: p.id });
      listEl.appendChild(div);
    }
    if (!listEl.children.length) listEl.innerHTML = `<div class="empty-note">No matching projects.</div>`;
  }
  searchEl.oninput = () => draw(searchEl.value);
  document.getElementById("project-create-btn").onclick = async () => {
    const name = await promptModal("New project name");
    if (!name) return;
    const p = await Projects.create(name);
    nav("project-detail", { projectId: p.id });
  };
  draw();
}

async function renderProjectDetail(params) {
  const project = await Projects.get(params.projectId);
  if (!project) { toast("Project not found."); nav("projects", {}, false); return; }
  document.getElementById("pd-name").textContent = project.name;
  document.getElementById("pd-name").onclick = async () => {
    const name = await promptModal("Rename project", "", project.name);
    if (name) { await Projects.update(project.id, { name }); renderProjectDetail(params); }
  };
  const modeSel = document.getElementById("pd-mode-select");
  modeSel.value = project.mode;
  modeSel.onchange = () => Projects.update(project.id, { mode: modeSel.value });

  document.getElementById("pd-export-btn").onclick = async () => {
    const choice = await formModal("Export project", [{
      key: "format",
      label: "Export Format",
      value: "json",
      options: [
        { label: "JSON (Complete Project & Glossary)", value: "json" },
        { label: "TXT (Clean Plain Text)", value: "txt" },
        { label: "Markdown (.md Chapters)", value: "md" },
        { label: "HTML (Formatted Bengali eBook)", value: "html" }
      ]
    }]);
    if (!choice) return;
    const parts = await Parts.listByProject(project.id);
    const fmt = (choice.format || "json").toLowerCase();
    if (fmt === "json") downloadFile(`${project.name}.json`, await exportProjectJSON(project.id), "application/json");
    else if (fmt === "txt") downloadFile(`${project.name}.txt`, partsToPlainText(parts), "text/plain");
    else if (fmt === "md") downloadFile(`${project.name}.md`, partsToMarkdown(parts), "text/markdown");
    else if (fmt === "html") downloadFile(`${project.name}.html`, partsToHtml(project.name, parts), "text/html");
    else toast("Unknown format.");
  };
  document.getElementById("pd-import-btn").onclick = () => {
    const inp = document.getElementById("hidden-file-input");
    inp.onchange = async () => {
      const file = inp.files[0]; if (!file) return;
      const text = await file.text();
      try { const newId = await importProjectJSON(text); toast("Project imported."); nav("project-detail", { projectId: newId }); }
      catch (err) { toast("Import failed: " + err.message); }
      inp.value = "";
    };
    inp.click();
  };
  document.getElementById("pd-delete-btn").onclick = async () => {
    const ok = await confirmModal("Delete project?", `This permanently deletes "${project.name}" and all its parts. This cannot be undone.`, "Delete");
    if (!ok) return;
    await Projects.remove(project.id);
    toast("Project deleted.");
    nav("projects", {}, false);
  };

  const listEl = document.getElementById("pd-parts-list");
  const parts = await Parts.listByProject(project.id);
  listEl.innerHTML = parts.length ? "" : `<div class="empty-note">No parts yet.</div>`;
  parts.forEach((part, i) => {
    const div = document.createElement("div");
    div.className = "list-item";
    div.innerHTML = `<div class="li-title">Part ${String(part.partNumber).padStart(3, "0")} — ${escapeHtml(part.title)}</div>
      <div class="li-sub">${part.wordCount} words · ${part.sourceLanguage || "?"} → ${part.targetLanguage} · ${fmtDate(part.updatedAt)}${part.sourceUrl ? " · from URL" : ""}</div>
      <div class="li-actions">
        <button class="small-btn" data-act="read">Read</button>
        <button class="small-btn" data-act="edit">Edit</button>
        <button class="small-btn" data-act="up">Move Up</button>
        <button class="small-btn" data-act="down">Move Down</button>
        <button class="small-btn" data-act="merge">Merge ↑ Previous</button>
        <button class="small-btn" data-act="discard">Discard</button>
      </div>`;
    div.querySelector('[data-act="read"]').onclick = () => nav("reading", { projectId: project.id, partId: part.id });
    div.querySelector('[data-act="edit"]').onclick = () => editPart(part, () => renderProjectDetail(params));
    div.querySelector('[data-act="up"]').onclick = async () => { await Parts.moveUp(part.id); renderProjectDetail(params); };
    div.querySelector('[data-act="down"]').onclick = async () => { await Parts.moveDown(part.id); renderProjectDetail(params); };
    div.querySelector('[data-act="merge"]').onclick = async () => {
      if (i === 0) { toast("This is already the first part."); return; }
      const ok = await confirmModal("Merge with previous part?", "This appends this part onto the previous one, in order, and removes this part. This cannot be undone (use Export first if unsure).", "Merge");
      if (!ok) return;
      try { await Parts.mergeWithPrevious(part.id); toast("Merged."); renderProjectDetail(params); }
      catch (err) { toast(err.message); }
    };
    div.querySelector('[data-act="discard"]').onclick = async () => {
      const s = Settings.get();
      if (s.confirmDelete) {
        const ok = await confirmModal("Discard this part?", `Delete "${part.title}"? This cannot be undone.`, "Discard");
        if (!ok) return;
      }
      await Parts.remove(part.id);
      toast("Part discarded.");
      renderProjectDetail(params);
    };
    listEl.appendChild(div);
  });
}

async function editPart(part, onDone) {
  const root = document.getElementById("modal-root");
  root.innerHTML = `<div class="modal-sheet" style="max-height:85vh;overflow-y:auto;">
    <h3>Edit ${escapeHtml(part.title)}</h3>
    <label style="font-size:12px;color:var(--ink-soft);">Title</label>
    <input id="ep-title" value="${escapeHtml(part.title)}">
    <label style="font-size:12px;color:var(--ink-soft);margin-top:8px;display:block;">Translation</label>
    <textarea id="ep-text" style="min-height:240px;width:100%;">${escapeHtml(part.translatedText)}</textarea>
    <div class="btn-row">
      <button class="ghost-btn" id="ep-cancel">Cancel</button>
      <button class="primary-btn" id="ep-save">Save</button>
    </div>
  </div>`;
  root.classList.add("open");

  function close() {
    root.classList.remove("open");
    root.removeEventListener("click", onBackdrop);
    window.removeEventListener("keydown", onKey);
  }
  function onBackdrop(e) {
    if (e.target === root) close();
  }
  function onKey(e) {
    if (e.key === "Escape") close();
  }
  root.addEventListener("click", onBackdrop);
  window.addEventListener("keydown", onKey);

  root.querySelector("#ep-cancel").onclick = close;
  root.querySelector("#ep-save").onclick = async () => {
    await Parts.update(part.id, { title: root.querySelector("#ep-title").value.trim() || part.title, translatedText: root.querySelector("#ep-text").value });
    close();
    toast("Saved.");
    onDone?.();
  };
}

/* ---------------- Reading Mode ---------------- */

async function renderReading(params) {
  const projSel = document.getElementById("reading-project");
  const partSel = document.getElementById("reading-part");
  const content = document.getElementById("reading-content");

  await fillProjectSelect(projSel, params?.projectId);

  async function loadParts(selectedPartId) {
    const parts = await Parts.listByProject(projSel.value);
    partSel.innerHTML = parts.map((p) => `<option value="${p.id}">${String(p.partNumber).padStart(3, "0")} — ${escapeHtml(p.title)}</option>`).join("");
    if (selectedPartId) partSel.value = selectedPartId;
    showPart();
  }
  async function showPart() {
    if (!partSel.value) { content.textContent = "No parts in this project yet."; return; }
    const part = await Parts.get(partSel.value);
    content.textContent = part?.translatedText || "";
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  projSel.onchange = () => loadParts();
  partSel.onchange = showPart;
  await loadParts(params?.partId);

  document.getElementById("reading-font-minus").onclick = () => { Settings.set({ fontSize: Math.max(14, Settings.get().fontSize - 1) }); };
  document.getElementById("reading-font-plus").onclick = () => { Settings.set({ fontSize: Math.min(32, Settings.get().fontSize + 1) }); };
  document.getElementById("reading-line-minus").onclick = () => { Settings.set({ lineSpacing: Math.max(1.2, +(Settings.get().lineSpacing - 0.1).toFixed(1)) }); };
  document.getElementById("reading-line-plus").onclick = () => { Settings.set({ lineSpacing: Math.min(2.4, +(Settings.get().lineSpacing + 0.1).toFixed(1)) }); };
  document.getElementById("reading-theme-toggle").onclick = () => { const cur = Settings.get().theme; Settings.set({ theme: cur === "dark" ? "light" : "dark" }); };

  document.getElementById("reading-prev").onclick = async () => {
    const idx = [...partSel.options].findIndex((o) => o.value === partSel.value);
    if (idx > 0) { partSel.selectedIndex = idx - 1; showPart(); }
  };
  document.getElementById("reading-next").onclick = async () => {
    const idx = [...partSel.options].findIndex((o) => o.value === partSel.value);
    if (idx < partSel.options.length - 1) { partSel.selectedIndex = idx + 1; showPart(); }
  };
}

/* ---------------- Translation Memory ---------------- */

async function renderMemory(params) {
  const projSel = document.getElementById("tm-project");
  await fillProjectSelect(projSel, params?.projectId);

  async function draw() {
    const list = document.getElementById("tm-list");
    if (!projSel.value) { list.innerHTML = `<div class="empty-note">Create a project first.</div>`; return; }
    const entries = await TM.listByProject(projSel.value);
    list.innerHTML = entries.length ? "" : `<div class="empty-note">No glossary entries yet. Add character names, places, or recurring terms so translations stay consistent.</div>`;
    for (const e of entries) {
      const div = document.createElement("div");
      div.className = "list-item";
      div.innerHTML = `<div class="li-title">${escapeHtml(e.term)} → ${escapeHtml(e.translation)}</div>
        <div class="li-sub">${escapeHtml(e.type)}${e.notes ? " · " + escapeHtml(e.notes) : ""}</div>
        <div class="li-actions"><button class="small-btn" data-act="edit">Edit</button><button class="small-btn" data-act="delete">Delete</button></div>`;
      div.querySelector('[data-act="edit"]').onclick = async () => {
        const vals = await formModal("Edit term", [
          { key: "term", label: "Source term", value: e.term },
          { key: "translation", label: "Bangla translation", value: e.translation },
          { key: "notes", label: "Notes (relationship, style, etc.)", value: e.notes }
        ]);
        if (!vals) return;
        await TM.update(e.id, vals);
        draw();
      };
      div.querySelector('[data-act="delete"]').onclick = async () => { await TM.remove(e.id); draw(); };
      list.appendChild(div);
    }
  }
  projSel.onchange = draw;
  document.getElementById("tm-add-btn").onclick = async () => {
    if (!projSel.value) { toast("Create a project first."); return; }
    const vals = await formModal("Add glossary term", [
      { key: "term", label: "Source term (name, place, object…)", placeholder: "e.g. Ravi" },
      { key: "translation", label: "Bangla translation", placeholder: "e.g. রবি" },
      { key: "notes", label: "Notes (optional)", placeholder: "e.g. informal, protagonist's brother" }
    ]);
    if (!vals || !vals.term || !vals.translation) return;
    await TM.add(projSel.value, vals.term, vals.translation, vals.notes);
    draw();
  };
  draw();
}

/* ---------------- Settings ---------------- */

async function renderSettings() {
  const s = Settings.get();
  document.getElementById("set-target-lang").value = s.targetLang;
  document.getElementById("set-default-mode").value = s.defaultMode;
  document.getElementById("set-chunk-size").value = s.chunkSize;
  document.getElementById("set-api-base").value = s.apiBase;
  document.getElementById("set-api-model").value = s.apiModel;
  document.getElementById("set-api-key").value = s.apiKey;
  document.getElementById("set-extract-proxy").value = s.extractProxy;
  document.getElementById("set-font-size").value = s.fontSize;
  document.getElementById("set-line-spacing").value = s.lineSpacing;
  document.getElementById("set-theme").value = s.theme;
  document.getElementById("set-autosave").checked = s.autosave;
  document.getElementById("set-confirm-delete").checked = s.confirmDelete;

  document.getElementById("set-save-btn").onclick = () => {
    Settings.set({
      targetLang: document.getElementById("set-target-lang").value.trim() || "Bangla",
      defaultMode: document.getElementById("set-default-mode").value,
      chunkSize: Math.max(500, Math.min(8000, +document.getElementById("set-chunk-size").value || 2800)),
      apiBase: document.getElementById("set-api-base").value.trim(),
      apiModel: document.getElementById("set-api-model").value.trim(),
      apiKey: document.getElementById("set-api-key").value.trim(),
      extractProxy: document.getElementById("set-extract-proxy").value.trim(),
      fontSize: +document.getElementById("set-font-size").value || 19,
      lineSpacing: +document.getElementById("set-line-spacing").value || 1.9,
      theme: document.getElementById("set-theme").value,
      autosave: document.getElementById("set-autosave").checked,
      confirmDelete: document.getElementById("set-confirm-delete").checked
    });
    toast("Settings saved.");
  };

  document.getElementById("set-export-all").onclick = async () => {
    downloadFile("literary-translator-backup.json", await exportAllData(), "application/json");
  };
  document.getElementById("set-import-all").onclick = () => {
    const inp = document.getElementById("hidden-file-input");
    inp.onchange = async () => {
      const file = inp.files[0]; if (!file) return;
      try { await importAllData(await file.text()); toast("Data imported."); renderSettings(); }
      catch (err) { toast("Import failed: " + err.message); }
      inp.value = "";
    };
    inp.click();
  };
  document.getElementById("set-clear-all").onclick = async () => {
    const ok = await confirmModal("Clear all local data?", "This permanently deletes every project, part, translation memory entry, and URL history on this device. Export a backup first if you're unsure. This cannot be undone.", "Clear Everything");
    if (!ok) return;
    const ok2 = await confirmModal("Are you absolutely sure?", "There is no undo. Type nothing needed — just confirm again to proceed.", "Yes, delete everything");
    if (!ok2) return;
    await DB.clearAll();
    toast("All local data cleared.");
    nav("home", {}, false);
  };
}

const RENDERERS = {
  home: renderHome, paste: renderPaste, url: renderUrl, projects: renderProjects,
  "project-detail": renderProjectDetail, reading: renderReading, memory: renderMemory, settings: renderSettings
};

window.LT.UI = { nav, render };
})();
