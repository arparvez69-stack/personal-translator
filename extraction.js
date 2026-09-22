/* ============================================================
   Webpage Extraction
   Only ever reads content the browser can already access via a
   normal, unauthenticated fetch(). Never attempts to bypass
   paywalls, logins, CAPTCHAs, DRM, or anti-bot protections.
   ============================================================ */
(() => {
"use strict";
const { Settings } = window.LT;

const STRIP_SELECTORS = [
  "script", "style", "noscript", "iframe", "svg", "form", "button", "nav", "header", "footer",
  "[role='navigation']", "[role='banner']", "[role='contentinfo']", "[aria-hidden='true']"
];

const STRIP_KEYWORD_RE = /(nav|menu|sidebar|footer|header|advert|ads?-|banner|cookie|consent|newsletter|subscribe|share|social|comment|related|popup|modal|widget|breadcrumb|pagination|tag-list|masthead)/i;

const CONTENT_SELECTORS = [
  "article", "main", "[itemprop='articleBody']", ".chapter-content", ".chapter-body",
  ".story-content", ".novel-content", ".entry-content", ".post-content", ".post-body",
  ".reading-content", "#content article", "#chapter-content"
];

const NEXT_CHAPTER_RE = /(next\s*chapter|next\s*part|next\s*page|continue\s*reading|পরবর্তী\s*অধ্যায়|»|›|→)/i;

function cleanClone(root) {
  const clone = root.cloneNode(true);
  STRIP_SELECTORS.forEach((sel) => clone.querySelectorAll(sel).forEach((el) => el.remove()));
  clone.querySelectorAll("*").forEach((el) => {
    const id = el.id || "";
    const cls = (el.className && typeof el.className === "string") ? el.className : "";
    if (STRIP_KEYWORD_RE.test(id) || STRIP_KEYWORD_RE.test(cls)) {
      // Only strip if it doesn't look like it holds most of the page's text
      const textLen = (el.textContent || "").trim().length;
      const totalLen = (root.textContent || "").trim().length || 1;
      if (textLen / totalLen < 0.5) el.remove();
    }
  });
  return clone;
}

function textDensity(el) {
  const text = (el.textContent || "").trim();
  const pCount = el.querySelectorAll("p").length;
  return text.length + pCount * 50; // favor elements with many paragraphs
}

function findBestContentNode(doc) {
  const cleanedBody = cleanClone(doc.body);

  for (const sel of CONTENT_SELECTORS) {
    const el = cleanedBody.querySelector(sel);
    if (el && (el.textContent || "").trim().length > 200) return el;
  }

  // Fallback: score candidate containers by paragraph density.
  let best = null, bestScore = 0;
  cleanedBody.querySelectorAll("div, section").forEach((el) => {
    const score = textDensity(el);
    if (score > bestScore) { bestScore = score; best = el; }
  });
  return best || cleanedBody;
}

function extractTitle(doc) {
  const og = doc.querySelector("meta[property='og:title']");
  if (og?.content) return og.content.trim();
  const h1 = doc.querySelector("h1");
  if (h1?.textContent?.trim()) return h1.textContent.trim();
  if (doc.title) return doc.title.trim();
  return "Untitled page";
}

function nodeToText(node) {
  // Preserve paragraph breaks and headings; collapse inline whitespace.
  const blocks = [];
  const blockTags = new Set(["P", "H1", "H2", "H3", "H4", "H5", "H6", "LI", "BLOCKQUOTE", "DIV", "BR"]);
  function walk(el) {
    if (el.nodeType === Node.TEXT_NODE) return;
    if (el.tagName === "BR") { blocks.push(""); return; }
    if (blockTags.has(el.tagName)) {
      const t = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (t) blocks.push(t);
      return; // don't descend further into block-level text we've already captured
    }
    for (const child of el.children) walk(child);
  }
  if (node.children.length === 0) {
    return (node.textContent || "").trim();
  }
  for (const child of node.children) walk(child);
  if (blocks.length === 0) return (node.textContent || "").replace(/[ \t]+/g, " ").trim();
  return blocks.join("\n\n");
}

function findNextChapterLink(doc, baseUrl) {
  const links = Array.from(doc.querySelectorAll("a[href]"));
  for (const a of links) {
    const label = (a.textContent || "").trim();
    if (label && NEXT_CHAPTER_RE.test(label)) {
      try {
        return { url: new URL(a.getAttribute("href"), baseUrl).href, label };
      } catch { /* ignore malformed href */ }
    }
  }
  return null;
}

function detectLanguage(text) {
  const sample = text.slice(0, 2000);
  if (/[\u0980-\u09FF]/.test(sample)) return "Bangla";
  if (/[\u0D00-\u0D7F]/.test(sample)) return "Malayalam";
  if (/[\u0900-\u097F]/.test(sample)) return "Hindi";
  if (/[a-zA-Z]/.test(sample)) return "English";
  return "Unknown";
}

/**
 * Attempt Layer 1/2 (direct browser fetch + DOM extraction). Throws on failure
 * (CORS block, network error, non-OK response) — callers must catch and fall
 * back to Paste Mode; this function never attempts to bypass access controls.
 */
async function extractFromUrlDirect(url) {
  const res = await fetch(url, { credentials: "omit", mode: "cors" });
  if (!res.ok) throw new Error(`Page responded with status ${res.status}.`);
  const html = await res.text();
  const doc = new DOMParser().parseFromString(html, "text/html");
  const contentNode = findBestContentNode(doc);
  const text = nodeToText(contentNode);
  if (!text || text.length < 50) throw new Error("No substantial readable content found on this page.");
  return {
    title: extractTitle(doc),
    text,
    language: detectLanguage(text),
    nextChapter: findNextChapterLink(doc, url)
  };
}

/** Layer 3: optional user-configured extraction proxy (must be one the user is authorized to use). */
async function extractFromUrlViaProxy(url) {
  const s = Settings.get();
  if (!s.extractProxy) throw new Error("No extraction proxy configured.");
  const res = await fetch(s.extractProxy, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url })
  });
  if (!res.ok) throw new Error(`Extraction proxy responded with status ${res.status}.`);
  const data = await res.json();
  if (!data.text) throw new Error("Extraction proxy did not return any text.");
  return {
    title: data.title || "Untitled page",
    text: data.text,
    language: detectLanguage(data.text),
    nextChapter: data.nextChapterUrl ? { url: data.nextChapterUrl, label: "Next" } : null
  };
}

/**
 * Full extraction pipeline: try direct browser access first, then the
 * optional proxy if configured. Never attempts anything beyond ordinary,
 * unauthenticated, browser-accessible content.
 */
async function extractFromUrl(url) {
  try {
    return await extractFromUrlDirect(url);
  } catch (directErr) {
    const s = Settings.get();
    if (s.extractProxy) {
      try {
        return await extractFromUrlViaProxy(url);
      } catch (proxyErr) {
        throw new Error(
          `Automatic page reading was not possible. The website may restrict browser access (${directErr.message}). ` +
          `The configured extraction proxy also failed: ${proxyErr.message}. Please use Paste Mode.`
        );
      }
    }
    throw new Error(
      `Automatic page reading was not possible. The website may restrict direct browser access to its content ` +
      `(reason: ${directErr.message}). This is a browser security restriction (CORS) that this app will not attempt ` +
      `to bypass. Please use Paste Mode instead.`
    );
  }
}

window.LT.Extraction = { extractFromUrl, detectLanguage };
})();
