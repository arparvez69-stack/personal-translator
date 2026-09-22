# Literary Translator — Offline-First Bangla Novel Translator PWA

A private, offline-first Progressive Web App for translating fiction (English,
Malayalam, and other languages) into natural, emotionally faithful Bangla —
built for iPhone 13 mini + Safari, but works in any modern browser.

No native app, no App Store, no Apple Developer account, no Firebase required.

---

## 1. File structure

```
bangla-translator-pwa/
├── index.html          # App shell + all view templates
├── styles.css           # Mobile-first styling, light/dark theme, safe-area support
├── app.js                # IndexedDB layer, settings, toast/modal helpers
├── translation.js        # Chunking + literary translation engine (AI calls)
├── extraction.js         # Webpage reading/extraction (DOM-based, CORS-respecting)
├── data.js               # Projects / Parts / Translation Memory / URL history CRUD
├── ui.js                 # Router + all view rendering + event wiring
├── main.js               # Bootstrap: theme, online/offline status, service worker
├── manifest.json         # PWA manifest (Add to Home Screen)
├── service-worker.js     # Offline app-shell caching
├── icons/icon-192.png, icon-512.png
└── README.md             # This file
```

No build step, no bundler, no dependencies. It's plain HTML/CSS/JS.

## 2. Run it locally

You need any static file server (browsers block some features like the
service worker and IndexedDB when opening `index.html` directly via
`file://`). Easiest option, from inside the folder:

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080/` in your browser.

Alternatives: `npx serve`, VS Code's "Live Server" extension, or `php -S
localhost:8080`.

## 3. Deploy it for free (static hosting)

Any static host works since there's no backend. Two easy free options:

**GitHub Pages**
1. Push this folder to a GitHub repo.
2. Repo Settings → Pages → set source to the branch/root.
3. Your app is live at `https://<username>.github.io/<repo>/`.

**Cloudflare Pages / Netlify / Vercel**
1. Drag-and-drop the folder into their web dashboard (all three support a
   "deploy a static folder" flow with no config), or connect the GitHub repo.
2. You get an HTTPS URL immediately.

HTTPS is required for service workers and for Add to Home Screen to install
correctly (localhost is exempt during local testing).

## 4. Install on iPhone 13 mini (Safari)

1. Open your deployed URL in **Safari** (not Chrome — iOS requires Safari
   for installable web apps).
2. Tap the **Share** icon (square with an arrow) in the toolbar.
3. Tap **Add to Home Screen**.
4. Confirm the name and tap **Add**.

The app now opens full-screen from your Home Screen, with the app shell
cached for offline use.

## 5. AI / API setup

Open **Settings** inside the app:

- **API base URL** — defaults to `https://api.anthropic.com`.
- **Model** — e.g. `claude-sonnet-4-6`, or another Claude model.
- **API key** — your own Anthropic API key.

The key is stored **only** in this browser's local storage on your device.
It is never bundled into the app, never sent to any third party, and never
leaves your device except in direct requests to the API endpoint you
configured. Each translation request goes straight from your phone's
browser to the API — there is no server of ours in between.

This uses Anthropic's `anthropic-dangerous-direct-browser-access` header to
permit a direct browser→API call. If you'd rather not expose an API key in
client-side JavaScript at all (e.g. before sharing this app with someone
else), you can instead put a small proxy server in front of it that holds
the key server-side and forwards requests — just point **API base URL** at
your proxy.

## 6. Offline vs. online capabilities — what actually works without internet

**Works offline** (once the app shell has loaded once):
- Opening the app itself
- Opening, reading, and editing existing projects and parts
- Search, reorder, merge, discard on saved content
- Translation memory management
- Export / Import (JSON, TXT, MD, HTML)

**Requires internet:**
- Loading/extracting a new webpage
- Any new AI translation (cloud API call)

The app will never claim cloud translation or fresh webpage loading works
offline — it shows a clear ONLINE/OFFLINE indicator in the top bar and will
tell you plainly when an action needs a connection.

## 7. Webpage extraction — what it can and can't do, honestly

This is the part of the spec worth being upfront about:

- The app fetches a URL directly from **your browser**, then parses the
  HTML to find the main readable content (looking for `<article>`, `<main>`,
  common content selectors, and falling back to a paragraph-density scan),
  stripping navigation, ads, cookie banners, comments, and similar chrome.
- **Copy-protection alone (disabled selection/right-click/long-press) does
  not block this** — those are just JavaScript/CSS tricks on top of HTML
  that's already sitting in the page source, so the app can still read it.
- **What *does* block it: CORS.** Browsers refuse to let a webpage's
  JavaScript read the *contents* of a response from another origin unless
  that origin's server explicitly opts in with CORS headers. Most
  novel/fiction sites do not opt in. This is a fundamental browser security
  mechanism, not a bug, and this app makes no attempt to get around it —
  per your spec, it must never try to bypass paywalls, logins, CAPTCHAs,
  DRM, or anti-bot/anti-scraping protections, and CORS is exactly the kind
  of access control that exists to enforce those boundaries.
- When direct extraction fails, the app clearly reports why and offers a
  **[Use Paste Mode]** button — it never fails silently, and it never
  fakes a result.
- **Optional Layer 3:** in Settings you can point "Extraction proxy URL" at
  a server-side extraction endpoint you run and are authorized to use. The
  app will try it as a fallback if direct browser access fails. Building
  and hosting that proxy is outside the scope of this static, backend-free
  app — but the integration point is there if you set one up.
- Next-chapter detection looks for links whose text matches common patterns
  ("Next Chapter", "Next Page", »/›, etc.) and shows you the detected URL
  for **confirmation before loading** — it never auto-advances.

## 8. Translation quality behavior

Three modes (set per project, in Project view): **Literary**, **Faithful**,
**Immersive Dialogue**. The underlying prompt instructs the model to
preserve emotional tone, character voice, slang and profanity where present
in dialogue, and to avoid unnecessary sanitization of ordinary fictional
content — while never generating sexual content involving minors, which is
a hard rule regardless of settings. The exact output still depends on the
selected AI provider/model's own safety behavior, which this app cannot
override.

Each project has its own **Translation Memory** (Translation Memory view) —
add character names, places, and recurring terms with your preferred Bangla
spelling, and the app includes them as a glossary in every subsequent
translation request for that project.

## 9. Known simplifications vs. the full spec

Built for genuine functionality over a long feature checklist. These are
simplified rather than fully built out:

- **Reordering** uses Move Up / Move Down buttons rather than native
  drag-and-drop (works identically on touch and desktop, just less flashy).
- **Export formats**: JSON (full restorable project), TXT, Markdown, HTML.
  DOCX was left out — reliable client-side DOCX generation is a much heavier
  dependency than fits a zero-build static app; HTML export opens cleanly in
  Word if you need a `.docx` starting point.
- **Undo** after merge/discard isn't a dedicated undo stack — instead,
  Export is one tap away before any destructive action, and confirmation
  dialogs guard merge/discard/clear-all.
- The **paragraph-density fallback** extractor is a heuristic, not a full
  Readability-grade algorithm — it works well on typical blog/chapter
  layouts but won't be perfect on every site design.

## 10. Testing performed

Before delivery this was smoke-tested end-to-end in a headless browser
(390×844 viewport, matching iPhone 13 mini): navigating every view, creating
a project, pasting text, running a translation (mocked API), saving a part,
merging two parts in order, reading the merged result in Reading Mode, and
adding a Translation Memory entry — all with zero console errors. Real
webpage extraction against a live site and a real API key are worth
verifying once in your own deployment, since those depend on network
conditions and your API credentials.
