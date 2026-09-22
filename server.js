import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { GoogleGenAI } from "@google/genai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

app.use(express.json({ limit: "10mb" }));
app.use(express.static(__dirname));

let genAiClient = null;
function getGenAI() {
  if (!genAiClient && process.env.GEMINI_API_KEY) {
    genAiClient = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build"
        }
      }
    });
  }
  return genAiClient;
}

// Check server capabilities
app.get("/api/status", (req, res) => {
  res.json({
    ok: true,
    hasGeminiKey: !!process.env.GEMINI_API_KEY
  });
});

// Translation endpoint supporting Gemini server-side or custom provider fallback
app.post("/api/translate", async (req, res) => {
  try {
    const { text, systemPrompt, customApiKey, customApiBase, customModel } = req.body || {};
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: { message: "Source text is required." } });
    }

    // 1. If user provided their own custom API key in Settings, use it
    if (customApiKey && customApiKey.trim()) {
      const base = (customApiBase || "").trim().replace(/\/+$/, "");
      const isGoogle = customApiKey.startsWith("AIzaSy") || base.includes("generativelanguage.googleapis.com");
      const isAnthropic = base.includes("anthropic.com") || (!base && customApiKey.startsWith("sk-ant"));

      if (isGoogle) {
        const customAi = new GoogleGenAI({
          apiKey: customApiKey.trim(),
          httpOptions: { headers: { "User-Agent": "aistudio-build" } }
        });
        const response = await customAi.models.generateContent({
          model: customModel || "gemini-3.8-flash",
          contents: text,
          config: { systemInstruction: systemPrompt }
        });
        const translatedText = response.text ? response.text.trim() : "";
        return res.json({ text: translatedText, provider: "custom-gemini" });
      }

      if (isAnthropic) {
        const anthropicRes = await fetch(`${base || "https://api.anthropic.com"}/v1/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": customApiKey.trim(),
            "anthropic-version": "2023-06-01"
          },
          body: JSON.stringify({
            model: customModel || "claude-sonnet-4-6",
            max_tokens: 4096,
            system: systemPrompt,
            messages: [{ role: "user", content: text }]
          })
        });

        if (!anthropicRes.ok) {
          let errDetail = `Anthropic API error (${anthropicRes.status})`;
          try {
            const errData = await anthropicRes.json();
            if (errData?.error?.message) errDetail = errData.error.message;
          } catch { /* ignore */ }
          return res.status(anthropicRes.status).json({ error: { message: errDetail } });
        }

        const data = await anthropicRes.json();
        const translated = (data.content || [])
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        return res.json({ text: translated, provider: "anthropic" });
      }

      // OpenAI-compatible endpoint (e.g. OpenRouter, Groq, Ollama, OpenAI)
      const openAiEndpoint = base.endsWith("/chat/completions") ? base : `${base || "https://api.openai.com/v1"}/chat/completions`;
      const openAiRes = await fetch(openAiEndpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${customApiKey.trim()}`
        },
        body: JSON.stringify({
          model: customModel || "gpt-4o",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: text }
          ]
        })
      });

      if (!openAiRes.ok) {
        let errDetail = `API provider error (${openAiRes.status})`;
        try {
          const errData = await openAiRes.json();
          if (errData?.error?.message) errDetail = errData.error.message;
        } catch {}
        return res.status(openAiRes.status).json({ error: { message: errDetail } });
      }

      const openAiData = await openAiRes.json();
      const openAiText = openAiData.choices?.[0]?.message?.content?.trim() || "";
      return res.json({ text: openAiText, provider: "custom-openai" });
    }

    // 2. Default & Recommended: Use server-side Gemini
    const ai = getGenAI();
    if (!ai) {
      return res.status(500).json({
        error: {
          message: "No Gemini API key available on the server. Please configure your key in Settings."
        }
      });
    }

    try {
      const response = await ai.models.generateContent({
        model: "gemini-3.8-flash",
        contents: text,
        config: {
          systemInstruction: systemPrompt
        }
      });

      const translatedText = response.text ? response.text.trim() : "";
      return res.json({ text: translatedText, provider: "gemini" });
    } catch (modelErr) {
      let msg = modelErr?.message || "Failed to generate translation.";
      try {
        const parsed = JSON.parse(msg);
        if (parsed?.error?.message) msg = parsed.error.message;
      } catch {}
      return res.status(500).json({
        error: {
          message: `Gemini translation error: ${msg}. You can also supply a custom API key in Settings.`
        }
      });
    }
  } catch (err) {
    console.error("Translation error:", err);
    return res.status(500).json({
      error: {
        message: err?.message || "Failed to generate translation."
      }
    });
  }
});

// Webpage extraction proxy to bypass browser CORS securely for novel/fiction reading
app.post("/api/extract", async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url || typeof url !== "string") {
      return res.status(400).json({ error: "Valid URL is required." });
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(url);
      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        return res.status(400).json({ error: "Only http and https URLs are allowed." });
      }
    } catch {
      return res.status(400).json({ error: "Invalid URL format." });
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);

    const pageRes = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9,bn;q=0.8"
      }
    });
    clearTimeout(timeoutId);

    if (!pageRes.ok) {
      return res.status(pageRes.status).json({
        error: `Target page returned HTTP status ${pageRes.status} (${pageRes.statusText}).`
      });
    }

    const html = await pageRes.text();
    return res.json({ html, url: pageRes.url || url });
  } catch (err) {
    const isTimeout = err.name === "AbortError";
    return res.status(502).json({
      error: isTimeout ? "Request to the webpage timed out." : (err.message || "Failed to fetch webpage.")
    });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Literary Translator server listening at http://0.0.0.0:${PORT}`);
});
