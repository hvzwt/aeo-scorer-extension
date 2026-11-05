// Injected into the page on demand by the side panel. It reads the page into a
// compact snapshot and draws highlights. It never changes page content.
(() => {
  if (window.__aeoScorerLoaded) return;
  window.__aeoScorerLoaded = true;

  const OVERLAY_ID = "__aeo-scorer-overlay";
  const PRONOUN_START = /^(it|this|that|these|those|they|he|she|its|their|also|however|but|and|so)\b/i;

  // ---------- helpers ----------

  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  const words = (s) => (clean(s).match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []);

  function cssPath(el) {
    if (!(el instanceof Element)) return "";
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id) && document.querySelectorAll(`#${el.id}`).length === 1) {
      return `#${el.id}`;
    }
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      if (node.id && /^[A-Za-z][\w-]*$/.test(node.id) && document.querySelectorAll(`#${node.id}`).length === 1) {
        parts.unshift(`#${node.id}`);
        break;
      }
      const tag = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (!parent) {
        parts.unshift(tag);
        break;
      }
      const same = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
      parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(node) + 1})` : tag);
      node = parent;
    }
    return parts.join(" > ");
  }

  function isVisible(el) {
    if (!el.getClientRects().length) return false;
    const st = getComputedStyle(el);
    return st.visibility !== "hidden" && st.display !== "none";
  }

  function meta(selector, attr = "content") {
    const el = document.querySelector(selector);
    return el ? clean(el.getAttribute(attr)) : null;
  }

  // Text that follows a heading until the next heading of the same or higher level.
  function sectionAfter(heading) {
    const level = Number(heading.tagName[1]);
    const paras = [];
    let firstBlock = null;
    let text = "";
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    walker.currentNode = heading;
    let el = walker.nextNode();
    // skip descendants of the heading itself
    while (el && heading.contains(el)) el = walker.nextNode();
    let subheadingSeen = false;
    while (el) {
      if (/^H[1-6]$/.test(el.tagName) && isVisible(el)) {
        if (Number(el.tagName[1]) <= level) break; // next sibling section
        subheadingSeen = true; // the direct-answer zone ends at the first subheading
      }
      if (["P", "LI", "DD", "BLOCKQUOTE", "TD", "SUMMARY"].includes(el.tagName) && isVisible(el)) {
        const t = clean(el.innerText);
        // A byline ("By Priya · Updated 5 Nov") is page furniture, not the answer.
        const byline = words(t).length < 25 && (el.querySelector('a[rel~="author"], time') || /^(by|written by|updated|published|posted)\b/i.test(t));
        if (t && !byline) {
          if (!firstBlock && !subheadingSeen) firstBlock = el;
          if (el.tagName === "P" && paras.length < 3) paras.push(t);
          text += " " + t;
          if (text.length > 4000) break;
        }
      }
      el = walker.nextNode();
    }
    const first = firstBlock ? clean(firstBlock.innerText) : "";
    return {
      firstText: first,
      firstTag: firstBlock ? firstBlock.tagName.toLowerCase() : null,
      firstSelector: firstBlock ? cssPath(firstBlock) : null,
      firstWords: words(first).length,
      firstStartsWithPronoun: PRONOUN_START.test(first),
      paragraphs: paras,
      words: words(text).length,
    };
  }

  // ---------- snapshot ----------

  function snapshot() {
    const url = location.href;
    const host = location.hostname.replace(/^www\./, "");
    const root = document.querySelector("main") || document.querySelector("article") || document.body;
    const bodyText = clean(root.innerText || "");

    const headings = Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6"))
      .filter(isVisible)
      .map((h, i) => ({
        ref: `h${i}`,
        level: Number(h.tagName[1]),
        text: clean(h.innerText).slice(0, 300),
        selector: cssPath(h),
        inNavOrFooter: !!h.closest("nav, footer, aside"),
        section: Number(h.tagName[1]) <= 3 ? sectionAfter(h) : null,
      }));

    const jsonLd = Array.from(document.querySelectorAll('script[type="application/ld+json"]')).map((s) => {
      const raw = s.textContent || "";
      try {
        return { ok: true, data: JSON.parse(raw), size: raw.length };
      } catch (e) {
        return { ok: false, error: String(e.message || e), size: raw.length, sample: raw.slice(0, 200) };
      }
    });

    const images = Array.from(document.images)
      .filter((img) => img.naturalWidth > 32 || img.width > 32)
      .slice(0, 300)
      .map((img) => ({
        selector: cssPath(img),
        src: img.currentSrc || img.src,
        hasAlt: img.hasAttribute("alt"),
        alt: clean(img.getAttribute("alt")),
        decorative: img.getAttribute("role") === "presentation" || img.getAttribute("aria-hidden") === "true",
        hasSize: img.hasAttribute("width") && img.hasAttribute("height"),
      }));

    const GENERIC = /^(click here|here|read more|more|learn more|this|link|this link|go|details|continue|see more)$/i;
    const anchors = Array.from(document.querySelectorAll("a[href]"));
    const genericLinks = anchors
      .filter((a) => isVisible(a) && GENERIC.test(clean(a.innerText)) && !a.getAttribute("aria-label"))
      .slice(0, 50)
      .map((a) => ({ selector: cssPath(a), text: clean(a.innerText), href: a.href }));
    const contentAnchors = Array.from(root.querySelectorAll("a[href]")).filter((a) => !a.closest("nav, header, footer"));
    const outbound = contentAnchors.filter((a) => {
      try {
        const u = new URL(a.href);
        return /^https?:$/.test(u.protocol) && u.hostname.replace(/^www\./, "") !== host;
      } catch {
        return false;
      }
    });

    const tables = Array.from(root.querySelectorAll("table"))
      .filter(isVisible)
      .map((t) => ({
        selector: cssPath(t),
        hasCaption: !!t.querySelector("caption"),
        th: t.querySelectorAll("th").length,
        thScoped: t.querySelectorAll("th[scope]").length,
        rows: t.rows.length,
      }));

    const authorLink = document.querySelector('a[rel~="author"], [itemprop="author"], .author, [class*="byline"]');
    const times = Array.from(document.querySelectorAll("time[datetime]")).map((t) => ({
      selector: cssPath(t),
      datetime: t.getAttribute("datetime"),
      text: clean(t.innerText),
    }));

    const stats = (bodyText.match(/\b\d[\d,.]*\s?(%|percent|per cent|million|billion|x\b)|\$\s?\d[\d,.]*/gi) || []).length;
    const yearsAndNumbers = (bodyText.match(/\b\d{2,}[\d,.]*\b/g) || []).length;

    const hreflang = Array.from(document.querySelectorAll('link[rel="alternate"][hreflang]')).map((l) => ({
      lang: l.getAttribute("hreflang"),
      href: l.getAttribute("href"),
    }));

    const allWords = words(bodyText.toLowerCase());

    // Same-site links, for the site crawler.
    const internalLinks = [];
    const seen = new Set();
    for (const a of anchors) {
      try {
        const u = new URL(a.href, location.href);
        if (!/^https?:$/.test(u.protocol) || u.hostname.replace(/^www\./, "") !== host) continue;
        u.hash = "";
        const k = u.href;
        if (!seen.has(k)) {
          seen.add(k);
          internalLinks.push(k);
        }
      } catch {}
      if (internalLinks.length >= 500) break;
    }

    // Visible FAQ: a heading that says FAQ, or question headings / <summary> elements.
    const faqHeading = Array.from(document.querySelectorAll("h2, h3")).find((h) => /\bfaq|frequently asked|common questions/i.test(h.innerText || ""));
    const questionNodes = Array.from(document.querySelectorAll("summary, h3, h4, dt, button[aria-expanded]"))
      .filter((n) => isVisible(n) || n.tagName === "SUMMARY")
      .map((n) => clean(n.innerText || n.textContent))
      .filter((t) => t.length > 8 && t.length < 200 && /\?$/.test(t));
    const text = bodyText.slice(0, 60000);

    return {
      url,
      host,
      capturedAt: new Date().toISOString(),
      lang: document.documentElement.getAttribute("lang"),
      title: clean(document.title),
      metaDescription: meta('meta[name="description"]'),
      canonical: document.querySelector('link[rel="canonical"]')?.getAttribute("href") || null,
      robotsMeta: [meta('meta[name="robots"]'), meta('meta[name="googlebot"]')].filter(Boolean).join(", ") || null,
      og: {
        title: meta('meta[property="og:title"]'),
        type: meta('meta[property="og:type"]'),
        description: meta('meta[property="og:description"]'),
        modified: meta('meta[property="article:modified_time"]'),
      },
      hreflang,
      landmarks: {
        main: document.querySelectorAll("main, [role=main]").length,
        article: document.querySelectorAll("article").length,
        section: document.querySelectorAll("section").length,
      },
      headings,
      jsonLd,
      images,
      genericLinks,
      outboundLinks: outbound.length,
      outboundSample: outbound.slice(0, 15).map((a) => a.href),
      tables,
      lists: { ol: root.querySelectorAll("ol").length, ul: root.querySelectorAll("ul").length, dl: root.querySelectorAll("dl").length },
      quotes: root.querySelectorAll("blockquote, q").length,
      cites: root.querySelectorAll("cite, blockquote[cite]").length,
      author: authorLink ? { selector: cssPath(authorLink), text: clean(authorLink.innerText).slice(0, 120), relAuthor: authorLink.matches('a[rel~="author"]') } : null,
      times,
      dataNosnippet: document.querySelectorAll("[data-nosnippet]").length,
      stats,
      numbers: yearsAndNumbers,
      wordCount: allWords.length,
      wordsLower: allWords.slice(0, 20000),
      text,
      textTruncated: bodyText.length > text.length,
      faqLike: Array.from(document.querySelectorAll("details > summary")).length,
      faq: { heading: faqHeading ? clean(faqHeading.innerText) : null, headingSelector: faqHeading ? cssPath(faqHeading) : null, questions: questionNodes.slice(0, 50) },
      viewport: meta('meta[name="viewport"]'),
      charset: !!document.querySelector("meta[charset]") || /charset/i.test(meta('meta[http-equiv="Content-Type" i]') || ""),
      canonicalCount: document.querySelectorAll('link[rel="canonical"]').length,
      ogImage: meta('meta[property="og:image"]'),
      twitterCard: meta('meta[name="twitter:card"]'),
      internalLinks,
    };
  }

  // ---------- highlighting ----------

  const COLORS = { critical: "#d93025", major: "#e8710a", minor: "#c9a400", info: "#1a73e8", ai: "#7b3fe4" };

  function overlay() {
    let o = document.getElementById(OVERLAY_ID);
    if (!o) {
      o = document.createElement("div");
      o.id = OVERLAY_ID;
      o.style.cssText = "position:absolute;left:0;top:0;width:0;height:0;z-index:2147483646;pointer-events:none;";
      document.documentElement.appendChild(o);
    }
    return o;
  }

  function clearHighlights() {
    document.getElementById(OVERLAY_ID)?.remove();
  }

  function drawBox(el, { color, label, pulse }) {
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return false;
    const box = document.createElement("div");
    box.style.cssText = `position:absolute;left:${r.left + scrollX - 4}px;top:${r.top + scrollY - 4}px;width:${r.width + 8}px;height:${r.height + 8}px;border:2px solid ${color};border-radius:6px;background:${color}14;box-sizing:border-box;transition:box-shadow .3s;`;
    if (pulse) box.style.boxShadow = `0 0 0 6px ${color}55`;
    if (label) {
      const tag = document.createElement("div");
      tag.textContent = label;
      tag.style.cssText = `position:absolute;left:-2px;top:-22px;background:${color};color:#fff;font:600 11px/1.6 system-ui,sans-serif;padding:0 6px;border-radius:4px;white-space:nowrap;max-width:360px;overflow:hidden;text-overflow:ellipsis;`;
      box.appendChild(tag);
    }
    overlay().appendChild(box);
    if (pulse) setTimeout(() => (box.style.boxShadow = "none"), 900);
    return true;
  }

  function highlight(items, focusSelector) {
    clearHighlights();
    let found = 0;
    let focusEl = null;
    for (const it of items) {
      let el = null;
      try {
        el = it.selector ? document.querySelector(it.selector) : null;
      } catch {
        el = null;
      }
      if (!el) continue;
      const isFocus = focusSelector && it.selector === focusSelector;
      if (drawBox(el, { color: COLORS[it.severity] || COLORS.info, label: it.label, pulse: isFocus })) found++;
      if (isFocus) focusEl = el;
    }
    if (focusEl) focusEl.scrollIntoView({ behavior: "smooth", block: "center" });
    return { found };
  }

  async function runAxe() {
    if (!window.axe) return { ok: false, error: "Accessibility engine not loaded." };
    const res = await window.axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] },
      resultTypes: ["violations"],
      elementRef: false,
    });
    const slim = (r) => ({ id: r.id, impact: r.impact, tags: r.tags, help: r.help, description: r.description, helpUrl: r.helpUrl });
    return {
      ok: true,
      violations: res.violations.map((r) => ({
        ...slim(r),
        nodes: r.nodes.slice(0, 25).map((n) => ({ selector: Array.isArray(n.target?.[0]) ? n.target[0].join(" ") : String(n.target?.[0] || ""), html: (n.html || "").slice(0, 200), summary: (n.failureSummary || "").slice(0, 300) })),
        nodeCount: r.nodes.length,
      })),
      passes: res.passes.map((r) => ({ id: r.id, impact: r.impact, tags: r.tags })),
    };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "aeo:axe") {
      runAxe().then(sendResponse, (e) => sendResponse({ ok: false, error: String(e?.message || e) }));
      return true;
    }
    try {
      if (msg?.type === "aeo:snapshot") sendResponse({ ok: true, snapshot: snapshot() });
      else if (msg?.type === "aeo:highlight") sendResponse({ ok: true, ...highlight(msg.items || [], msg.focus) });
      else if (msg?.type === "aeo:clear") {
        clearHighlights();
        sendResponse({ ok: true });
      } else if (msg?.type === "aeo:ping") sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
    return false;
  });
})();
