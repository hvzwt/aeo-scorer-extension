# AEO Scorer (Chrome extension)

A Chrome side panel that scores the current page for Answer Engine Optimization (AEO) and Generative Engine Optimization (GEO), highlights the problems on the page, and re-checks them after you fix them. The rules follow "AEO & GEO: A Developer's Implementation Guide" (Nov 2026).

## Install (load unpacked)

1. Unzip `aeo-scorer-0.1.0.zip` (or run `npm install && npm run build` and use `dist/`).
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick the unzipped folder.
3. Pin the extension and click its icon. The panel opens on the right and stays open while you reload or navigate.

## How it works

- **Score (free, instant, no AI).** The panel reads a snapshot of the page and runs about 35 checks in six weighted groups: crawler access 25% (meta robots, robots.txt for Googlebot, Bingbot, OAI-SearchBot, PerplexityBot and Claude-SearchBot, server-rendered content), page structure 20%, answer-first content 20%, head tags 15%, structured data 10%, trust and evidence 10%. Each issue cites the guide section and how solid the evidence is (Documented, Practice or Study).
- **Fix loop.** Click **Show on page** to scroll to and outline an element, or turn on **Highlight issues on page**. After you change the page, click **Mark fixed**, then reload the tab. The panel re-scans automatically and tells you which issues are verified fixed and which are still failing.
- **Claude review (optional).** Add your Anthropic API key in Settings and click **Ask Claude**. Claude judges what rules cannot, such as whether the opening actually answers the main question, and returns findings with paste-ready text and a suggested JSON-LD block. Findings appear in the same list with a Claude chip.

## Claude details

- Called from the panel with the official `@anthropic-ai/sdk`, streaming, structured JSON output, effort `low` by default.
- Models: Claude Opus 5.5 (default), Sonnet 5.5 or Haiku 5.5. About $0.04–0.07 per review on Opus 5.5 at low effort; under $0.01 on Haiku 5.5.
- The rubric is a frozen, cached system prompt, so repeat reviews read it from the prompt cache.
- Server-side refusal fallbacks (`fallbacks: "default"`) are on for Opus and Sonnet; if your account rejects that beta, the call retries once without it.
- The key is stored in `chrome.storage.local` and sent only to `api.anthropic.com`. Anyone with access to this Chrome profile can read it, so this mode is for you and your team. Before a public release, move calls behind a backend proxy (see the integration plan).

## Develop

```
npm install
npm run build      # bundles src/ into dist/
npm test           # builds, then runs test/e2e.cjs in Chromium (needs Playwright and test pages on :8765)
```

Serve the test pages first: `cd test/site && python3 -m http.server 8765`. The test loads the extension, scores a good and a bad page, checks highlights, the mark-fixed and reload re-check, and runs Ask Claude against a mocked API.

## Files

- `src/manifest.json` – Manifest V3, side panel, permissions
- `src/background.js` – opens the side panel from the toolbar icon
- `src/content.js` – page snapshot and highlight overlay (injected on demand)
- `src/rules.js` – the scoring rules (pure functions)
- `src/claude.js` – the Claude prompt, output schema and API call
- `src/sidepanel.*` – the panel UI, re-scan on reload, saved fix state per URL
