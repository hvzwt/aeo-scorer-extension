// Reading answers from AI assistant tabs. captureAnswer() is injected with
// chrome.scripting.executeScript({ func }) so it must be self-contained.

export const ENGINES = {
  claude: { label: "Claude + web search" },
  chatgpt: { label: "ChatGPT", ask: (q) => `https://chatgpt.com/?q=${encodeURIComponent(q)}&hints=search` },
  perplexity: { label: "Perplexity", ask: (q) => `https://www.perplexity.ai/search?q=${encodeURIComponent(q)}` },
  google: { label: "Google AI Mode", ask: (q) => `https://www.google.com/search?udm=50&q=${encodeURIComponent(q)}` },
  gemini: { label: "Gemini" },
  copilot: { label: "Copilot", ask: (q) => `https://copilot.microsoft.com/?q=${encodeURIComponent(q)}` },
};

export function engineForUrl(url) {
  let h = "";
  try {
    h = new URL(url).hostname;
  } catch {
    return null;
  }
  if (/(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/.test(h)) return "chatgpt";
  if (/(^|\.)perplexity\.ai$/.test(h)) return "perplexity";
  if (/^gemini\.google\.com$/.test(h)) return "gemini";
  if (/(^|\.)copilot\.microsoft\.com$|(^|\.)bing\.com$/.test(h)) return "copilot";
  if (/(^|\.)google\.[a-z.]+$/.test(h) && /\/search/.test(new URL(url).pathname)) return "google";
  return null;
}

/** Runs in the page. Returns { text, links, question, how } or { error }. */
export function captureAnswer(engine) {
  const clean = (s) => (s || "").replace(/\n{3,}/g, "\n\n").trim();
  const linksIn = (root) => {
    const seen = new Set();
    const out = [];
    for (const a of root.querySelectorAll("a[href]")) {
      let href;
      try {
        href = new URL(a.href, location.href);
      } catch {
        continue;
      }
      // unwrap Google redirect links
      if (/google\./.test(href.hostname) && href.pathname === "/url") {
        const q = href.searchParams.get("q") || href.searchParams.get("url");
        if (q) href = new URL(q);
      }
      if (!/^https?:$/.test(href.protocol) || href.hostname === location.hostname) continue;
      const key = href.href.split("#")[0];
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ href: key, text: (a.innerText || a.getAttribute("aria-label") || "").trim().slice(0, 120) });
    }
    return out;
  };
  const last = (sel) => {
    const all = document.querySelectorAll(sel);
    return all.length ? all[all.length - 1] : null;
  };

  // 1. The user's selection always wins.
  const sel = getSelection();
  if (sel && !sel.isCollapsed && sel.toString().trim().length > 40) {
    const range = sel.getRangeAt(0);
    const box = document.createElement("div");
    box.append(range.cloneContents());
    return { text: clean(sel.toString()), links: linksIn(box), question: "", how: "selection" };
  }

  // 2. Known answer containers per assistant.
  const pick = {
    chatgpt: { a: '[data-message-author-role="assistant"]', q: '[data-message-author-role="user"]' },
    perplexity: { a: '[id^="markdown-content"], .prose', q: 'h1, [class*="query"]' },
    gemini: { a: "message-content, .model-response-text", q: "user-query, .query-text" },
    copilot: { a: '[data-content="ai-message"]', q: '[data-content="user-message"]' },
    google: { a: '[data-subtree="aimc"], [data-attrid="wa:/description"], div[jsname][data-rl], #m-x-content', q: 'textarea[name="q"]' },
  }[engine];
  let node = pick ? last(pick.a) : null;
  let question = "";
  if (pick?.q) {
    const qn = last(pick.q);
    question = (qn?.value || qn?.innerText || "").trim();
  }
  if (!question && engine === "google") question = new URL(location.href).searchParams.get("q") || "";
  if (!question && engine === "perplexity") question = document.title.replace(/\s*[-|]\s*Perplexity.*$/i, "");

  // 3. Fallback: the largest block of text on the page.
  if (!node || (node.innerText || "").trim().length < 40) {
    let best = null;
    let bestLen = 0;
    for (const el of document.querySelectorAll("main, article, [role=main], section, div")) {
      const len = (el.innerText || "").length;
      if (len > bestLen && len < 40000 && el.querySelectorAll("p, li").length >= 2) {
        best = el;
        bestLen = len;
      }
    }
    node = best;
    if (!node) return { error: "Could not find an answer on this page. Select the answer text and try again." };
    var how = "largest-block";
  }
  // Perplexity and Google show sources outside the answer body; include the nearest container's links too.
  let links = linksIn(node);
  if (links.length < 2 && node.parentElement) links = linksIn(node.closest("main, [role=main]") || node.parentElement);
  return { text: clean(node.innerText).slice(0, 30000), links: links.slice(0, 60), question: question.slice(0, 500), how: how || "answer-container" };
}
