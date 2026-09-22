/* ============================================================
   Chunking + Translation Service
   ============================================================ */
(() => {
"use strict";
const { Settings } = window.LT;

const SCENE_BREAK_RE = /^\s*(\*\s*\*\s*\*|---+|###+|~~~+)\s*$/;

function splitParagraphs(text) {
  return text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
}

function splitSentences(text) {
  // Split on sentence-ending punctuation (Latin + Bengali dari) while keeping the punctuation.
  const parts = text.match(/[^.!?।]+[.!?।]*(\s+|$)/g);
  return parts ? parts.map((s) => s.trim()).filter(Boolean) : [text];
}

/**
 * Chunk text preferring: scene break > paragraph > dialogue block > sentence.
 * Never cuts through a sentence.
 */
function chunkText(text, maxChars) {
  const paragraphs = splitParagraphs(text);
  const chunks = [];
  let current = [];
  let currentLen = 0;

  function flush() {
    if (current.length) {
      chunks.push(current.join("\n\n"));
      current = [];
      currentLen = 0;
    }
  }

  for (const para of paragraphs) {
    const isSceneBreak = SCENE_BREAK_RE.test(para);
    if (isSceneBreak) {
      flush();
      chunks.push(para); // scene break marker kept as its own tiny chunk boundary
      continue;
    }
    if (para.length > maxChars) {
      // paragraph itself too large: split by sentences
      flush();
      const sentences = splitSentences(para);
      let buf = [];
      let bufLen = 0;
      for (const s of sentences) {
        if (bufLen + s.length > maxChars && buf.length) {
          chunks.push(buf.join(" "));
          buf = [];
          bufLen = 0;
        }
        buf.push(s);
        bufLen += s.length + 1;
      }
      if (buf.length) chunks.push(buf.join(" "));
      continue;
    }
    if (currentLen + para.length + 2 > maxChars && current.length) {
      flush();
    }
    current.push(para);
    currentLen += para.length + 2;
  }
  flush();
  return chunks.filter((c) => c.trim().length > 0);
}

function estimateChunks(text, maxChars) {
  return chunkText(text, maxChars).length;
}

const MODE_INSTRUCTIONS = {
  literary: "Prioritize the most natural, polished literary Bangla prose. You may restructure sentences where needed for fluency, as long as meaning, tone and emotional register are fully preserved.",
  faithful: "Stay close to the original sentence structure and wording while still producing natural, grammatical Bangla. Prefer literal equivalents over loose paraphrase where both are natural.",
  immersive: "Prioritize realistic spoken rhythm for dialogue: natural contractions, slang, interruptions, and character voice. Narration can stay closer to literary style; dialogue should sound like real speech."
};

function buildSystemPrompt({ mode, sourceLang, targetLang, glossary }) {
  const modeInstruction = MODE_INSTRUCTIONS[mode] || MODE_INSTRUCTIONS.literary;
  let glossaryBlock = "";
  if (glossary && glossary.length) {
    glossaryBlock = "\n\nProject glossary — use these exact established translations/spellings whenever these terms appear, unless the user has since changed them:\n" +
      glossary.map((g) => `- ${g.term} → ${g.translation}${g.notes ? ` (${g.notes})` : ""}`).join("\n");
  }
  return `You are a professional literary translator working from ${sourceLang || "the source language"} into ${targetLang || "Bangla"}.

Translate the supplied source text into natural, immersive, emotionally faithful ${targetLang || "Bangla"} fiction prose.

Core rules:
- Understand context before translating. Do not perform mechanical word-for-word translation.
- Preserve emotional meaning and literary effect: anger should feel angry, fear should feel frightening, sarcasm should sound sarcastic, humour should remain humorous, hostility should feel hostile, affection should feel affectionate, suspense should remain suspenseful.
- Preserve distinct character voices and speech patterns across dialogue.
- Use natural target-language expressions rather than awkward literal constructions.
- When slang, profanity, insults, or informal speech appear in fictional dialogue, preserve their communicative force with natural target-language equivalents rather than unnecessarily formalizing or softening them. This is private literary translation of adult fiction; do not sanitize ordinary dialogue simply because it contains coarse language, tension, or mature themes.
- Do not summarize, explain, add facts, or remove meaningful content.
- Preserve paragraph breaks and dialogue formatting from the source.
- Output ONLY the translated text — no preamble, no notes, no source-language text, no commentary.

${modeInstruction}${glossaryBlock}

Never generate or transform sexual content involving minors, under any framing.`;
}

async function callModel(systemPrompt, userText) {
  const s = Settings.get();
  const res = await fetch("/api/translate", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      text: userText,
      systemPrompt,
      customApiKey: s.apiKey || "",
      customApiBase: s.apiBase || "",
      customModel: s.apiModel || ""
    })
  });

  if (!res.ok) {
    let msg = `Translation service error (${res.status})`;
    try {
      const body = await res.json();
      if (body?.error?.message) msg = body.error.message;
      else if (body?.error) msg = body.error;
    } catch { /* ignore */ }
    throw new Error(msg);
  }

  const data = await res.json();
  const text = (data.text || "").trim();
  return text;
}

/**
 * Translate an array of chunks sequentially, reporting progress and
 * allowing partial failure. Returns { results, failedIndices }.
 * results[i] is the translated text for chunks[i], or null if failed.
 */
async function translateChunks(chunks, opts, onProgress) {
  const systemPrompt = buildSystemPrompt(opts);
  const results = new Array(chunks.length).fill(null);
  const failedIndices = [];
  for (let i = 0; i < chunks.length; i++) {
    onProgress?.({ index: i, total: chunks.length, status: "translating" });
    if (SCENE_BREAK_RE.test(chunks[i])) {
      results[i] = chunks[i]; // pass scene-break markers through untranslated
      onProgress?.({ index: i, total: chunks.length, status: "done" });
      continue;
    }
    try {
      results[i] = await callModel(systemPrompt, chunks[i]);
      onProgress?.({ index: i, total: chunks.length, status: "done" });
    } catch (err) {
      failedIndices.push(i);
      onProgress?.({ index: i, total: chunks.length, status: "failed", error: err.message });
    }
  }
  return { results, failedIndices };
}

async function retryChunk(chunks, index, opts) {
  const systemPrompt = buildSystemPrompt(opts);
  return callModel(systemPrompt, chunks[index]);
}

function runQualityCheck(originalChunks, translatedChunks) {
  const warnings = [];
  translatedChunks.forEach((t, i) => {
    if (t === null) { warnings.push(`Chunk ${i + 1}: translation missing (failed).`); return; }
    if (SCENE_BREAK_RE.test(originalChunks[i])) return;
    const origLen = originalChunks[i].length;
    if (t.length < origLen * 0.25) warnings.push(`Chunk ${i + 1}: output is suspiciously short compared to source.`);
    // crude duplicate-paragraph check
    const paras = t.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    const seen = new Set();
    for (const p of paras) {
      if (p.length > 40 && seen.has(p)) { warnings.push(`Chunk ${i + 1}: contains a duplicated paragraph.`); break; }
      seen.add(p);
    }
  });
  return warnings;
}

window.LT.Translation = { chunkText, estimateChunks, translateChunks, retryChunk, runQualityCheck, SCENE_BREAK_RE };
})();
