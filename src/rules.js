// Deterministic AEO / GEO rules, based on "AEO & GEO: A Developer's
// Implementation Guide" (Nov 2026). Pure functions: no DOM or chrome APIs, so
// the same code runs in the side panel and in Node tests.

export const CATEGORIES = {
  access: { label: "Crawler access", weight: 20 },
  head: { label: "Head & meta tags", weight: 10 },
  structure: { label: "Page structure", weight: 15 },
  answers: { label: "Answer-first content", weight: 20 },
  schema: { label: "Structured data", weight: 15 },
  trust: { label: "Trust & evidence", weight: 10 },
  tech: { label: "Technical & security", weight: 10 },
};

const SEVERITY_POINTS = { critical: 10, major: 5, minor: 2, info: 0 };

export const SEARCH_BOTS = [
  { token: "Googlebot", company: "Google", use: "Google Search, AI Overviews and AI Mode" },
  { token: "Bingbot", company: "Microsoft", use: "Bing index, which feeds Copilot" },
  { token: "OAI-SearchBot", company: "OpenAI", use: "ChatGPT search" },
  { token: "PerplexityBot", company: "Perplexity", use: "Perplexity answers" },
  { token: "Claude-SearchBot", company: "Anthropic", use: "Claude web search" },
];

export const TRAINING_BOTS = [
  { token: "GPTBot", company: "OpenAI" },
  { token: "ClaudeBot", company: "Anthropic" },
  { token: "Google-Extended", company: "Google" },
];

// ---------------------------------------------------------------------------
// robots.txt (RFC 9309: group by user agent, longest matching rule wins, Allow
// wins ties, fall back to the "*" group)

export function parseRobots(text) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  const sitemaps = [];
  for (const rawLine of (text || "").split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (key === "allow" || key === "disallow") {
      if (current) current.rules.push({ allow: key === "allow", path: value });
      lastWasAgent = false;
    } else if (key === "sitemap") {
      sitemaps.push(value);
    } else {
      lastWasAgent = false;
    }
  }
  return { groups, sitemaps };
}

function ruleMatches(pattern, path) {
  if (pattern === "") return false;
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const re = new RegExp("^" + body.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + (anchored ? "$" : ""));
  return re.test(path);
}

export function robotsVerdict(parsed, token, path) {
  const t = token.toLowerCase();
  let groups = parsed.groups.filter((g) => g.agents.includes(t));
  let matchedAgent = token;
  if (!groups.length) {
    groups = parsed.groups.filter((g) => g.agents.includes("*"));
    matchedAgent = "*";
  }
  if (!groups.length) return { allowed: true, matchedAgent: null, rule: null };
  const rules = groups.flatMap((g) => g.rules);
  let best = null;
  for (const r of rules) {
    if (!ruleMatches(r.path, path)) continue;
    const len = r.path.replace(/\$$/, "").length;
    if (!best || len > best.len || (len === best.len && r.allow && !best.rule.allow)) best = { len, rule: r };
  }
  return { allowed: !best || best.rule.allow, matchedAgent, rule: best ? `${best.rule.allow ? "Allow" : "Disallow"}: ${best.rule.path}` : null };
}

// ---------------------------------------------------------------------------
// JSON-LD helpers

function flattenLd(node, out = []) {
  if (Array.isArray(node)) node.forEach((n) => flattenLd(n, out));
  else if (node && typeof node === "object") {
    if (node["@type"]) out.push(node);
    if (node["@graph"]) flattenLd(node["@graph"], out);
    for (const [k, v] of Object.entries(node)) {
      if (k !== "@graph" && v && typeof v === "object") flattenLd(v, out);
    }
  }
  return out;
}

function typesOf(node) {
  const t = node["@type"];
  return (Array.isArray(t) ? t : [t]).filter(Boolean).map(String);
}

const ARTICLE_TYPES = ["Article", "TechArticle", "BlogPosting", "NewsArticle", "Report", "ScholarlyArticle"];

// ---------------------------------------------------------------------------
// text helpers

const STOP = new Set("the a an and or of to in on for with is are be by as at it this that from your you our we how what why when which who can do does not".split(" "));

function similarity(a, b) {
  const ta = new Set((a || "").toLowerCase().match(/[\p{L}\p{N}]+/gu)?.filter((w) => !STOP.has(w)) || []);
  const tb = new Set((b || "").toLowerCase().match(/[\p{L}\p{N}]+/gu)?.filter((w) => !STOP.has(w)) || []);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  ta.forEach((w) => tb.has(w) && inter++);
  return inter / Math.min(ta.size, tb.size);
}

export function hashKey(s) {
  let h = 2166136261;
  for (const ch of String(s)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

const QUESTION_HEADING = /\?\s*$|^(how|what|why|when|where|which|who|can|does|do|is|are|should|will)\b/i;

function keywordStuffing(wordsLower) {
  if (!wordsLower || wordsLower.length < 150) return null;
  const counts = new Map();
  for (let i = 0; i < wordsLower.length - 1; i++) {
    const a = wordsLower[i];
    const b = wordsLower[i + 1];
    if (STOP.has(a) || STOP.has(b) || a.length < 3 || b.length < 3) continue;
    const k = `${a} ${b}`;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  let top = null;
  counts.forEach((c, k) => {
    if (!top || c > top.count) top = { phrase: k, count: c };
  });
  if (!top) return null;
  const per1000 = (top.count / wordsLower.length) * 1000;
  return { ...top, per1000 };
}

// ---------------------------------------------------------------------------
// the scorer

/**
 * @param {object} snap  page snapshot from content.js
 * @param {object} site  { robots: {status, text} | null, llmsTxt: boolean | null,
 *                         rawHtml: {status, text} | null }
 */
export function scorePage(snap, site = {}) {
  const checks = [];
  const add = (c) => checks.push({ severity: "minor", pass: false, ...c });

  let pathname = "/";
  try {
    const u = new URL(snap.url);
    pathname = u.pathname + u.search;
  } catch {}

  // ---------------- crawler access ----------------
  const robotsMeta = (snap.robotsMeta || "").toLowerCase();
  add({
    id: "robots-noindex",
    category: "access",
    severity: "critical",
    title: "Page is indexable",
    pass: !/\bnoindex\b|\bnone\b/.test(robotsMeta),
    detail: robotsMeta ? `meta robots: "${snap.robotsMeta}"` : "No noindex directive.",
    fix: 'Remove "noindex" from the meta robots tag. A page that is not indexed cannot be cited (guide §1, §5.3).',
    evidence: "Documented",
    section: "5.3",
  });
  add({
    id: "robots-nosnippet",
    category: "access",
    severity: "critical",
    title: "Snippets are allowed",
    pass: !/\bnosnippet\b/.test(robotsMeta),
    detail: /\bnosnippet\b/.test(robotsMeta) ? "nosnippet keeps this page's text out of snippets and AI Overviews." : "No nosnippet directive.",
    fix: 'Remove "nosnippet". To hide a single passage, put data-nosnippet on that element instead.',
    evidence: "Documented",
    section: "5.3",
  });
  const maxSnippet = robotsMeta.match(/max-snippet\s*:\s*(-?\d+)/);
  add({
    id: "robots-max-snippet",
    category: "access",
    severity: maxSnippet && Number(maxSnippet[1]) >= 0 && Number(maxSnippet[1]) < 160 ? "major" : "minor",
    title: "Full-length snippets allowed (max-snippet:-1)",
    pass: !!maxSnippet && Number(maxSnippet[1]) === -1,
    detail: maxSnippet ? `max-snippet is ${maxSnippet[1]}.` : "max-snippet is not set.",
    fix: 'Add <meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large">.',
    evidence: "Documented",
    section: "5.3",
  });

  if (site.robots && site.robots.status === 200) {
    const parsed = parseRobots(site.robots.text);
    for (const bot of SEARCH_BOTS) {
      const v = robotsVerdict(parsed, bot.token, pathname);
      add({
        id: `robots-allow-${bot.token.toLowerCase()}`,
        category: "access",
        severity: bot.token === "Googlebot" || bot.token === "Bingbot" ? "critical" : "major",
        title: `robots.txt allows ${bot.token}`,
        pass: v.allowed,
        detail: v.allowed
          ? `Allowed (${bot.use}).`
          : `Blocked by "${v.rule}" in the ${v.matchedAgent === "*" ? "User-agent: *" : `User-agent: ${bot.token}`} group. ${bot.company}'s ${bot.use} cannot fetch this page.`,
        fix: `Add "User-agent: ${bot.token}\\nAllow: /" to robots.txt, and check that your CDN or WAF bot protection does not block it (guide §6.1).`,
        evidence: "Documented",
        section: "6.1",
      });
    }
    const aiBots = SEARCH_BOTS.filter((b) => !["Googlebot", "Bingbot"].includes(b.token));
    const allAiBlocked = aiBots.every((b) => !robotsVerdict(parsed, b.token, pathname).allowed);
    if (allAiBlocked) {
      add({
        id: "ai-bots-all-blocked",
        category: "access",
        severity: "critical",
        title: "At least one AI search crawler is allowed",
        pass: false,
        detail: "robots.txt blocks OAI-SearchBot, PerplexityBot and Claude-SearchBot. ChatGPT search, Perplexity and Claude cannot cite this page.",
        fix: "Allow the AI search bots. Blocking training bots (GPTBot, ClaudeBot, Google-Extended) is a separate choice (guide §6.1).",
        evidence: "Documented",
        section: "6.1",
      });
    }
    const training = TRAINING_BOTS.map((b) => `${b.token}: ${robotsVerdict(parsed, b.token, pathname).allowed ? "allowed" : "blocked"}`);
    add({
      id: "robots-training-info",
      category: "access",
      severity: "info",
      title: "Training crawlers (your choice, not scored)",
      pass: true,
      detail: training.join(" · "),
      fix: "Blocking training bots does not affect being cited. Decide this separately (guide §6.1).",
      section: "6.1",
    });
    add({
      id: "robots-sitemap",
      category: "access",
      severity: "minor",
      title: "robots.txt lists a sitemap",
      pass: parsed.sitemaps.length > 0,
      detail: parsed.sitemaps.length ? parsed.sitemaps.slice(0, 3).join(", ") : "No Sitemap: line found.",
      fix: "Add \"Sitemap: https://your-site/sitemap.xml\" to robots.txt and keep <lastmod> accurate (guide §6.5).",
      evidence: "Documented",
      section: "6.5",
    });
  } else {
    add({
      id: "robots-missing",
      category: "access",
      severity: "info",
      title: "robots.txt not found",
      pass: true,
      detail: site.robots ? `robots.txt returned HTTP ${site.robots.status}. All crawlers are allowed by default.` : "robots.txt could not be fetched.",
      fix: "Optional: add a robots.txt that explicitly allows the AI search bots and lists your sitemap (guide §6.1).",
      section: "6.1",
    });
  }

  if (site.rawHtml && site.rawHtml.status >= 400) {
    add({
      id: "http-status",
      category: "access",
      severity: "critical",
      title: "Page returns HTTP 200",
      pass: false,
      detail: `The server answered HTTP ${site.rawHtml.status}. Crawlers will drop this URL.`,
      fix: "Return 200 for real pages, 301 for moved ones and 404/410 only for pages that should disappear.",
      evidence: "Documented",
      section: "6.2",
    });
  }
  if (site.rawHtml && site.rawHtml.status === 200 && typeof site.rawHtml.text === "string") {
    const raw = site.rawHtml.text.toLowerCase().replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/g, " ").replace(/\s+/g, " ");
    const h1 = snap.headings.find((h) => h.level === 1);
    const answer = h1?.section?.firstText || "";
    const probe = (s) => s && raw.includes(s.toLowerCase().replace(/\s+/g, " ").slice(0, 60));
    const h1InRaw = h1 ? probe(h1.text) : false;
    const answerInRaw = answer ? probe(answer) : true;
    add({
      id: "server-rendered",
      category: "access",
      severity: "major",
      title: "Main content is in the server HTML",
      pass: (!h1 || h1InRaw) && answerInRaw,
      detail: !h1
        ? "No H1 to test."
        : h1InRaw && answerInRaw
          ? "The H1 and first answer appear in the raw HTML response."
          : `${h1InRaw ? "" : "The H1 is missing from the raw HTML. "}${answerInRaw ? "" : "The first answer paragraph is missing from the raw HTML. "}Crawlers that do not run JavaScript will not see it.`,
      fix: "Render content pages on the server (SSR or static generation). Test with: curl -s URL | grep '<h1' (guide §6.2).",
      selector: h1?.selector,
      evidence: "Documented",
      section: "6.2",
    });
  }

  add({
    id: "llms-txt",
    category: "access",
    severity: "info",
    title: "/llms.txt (optional)",
    pass: true,
    detail: site.llmsTxt === true ? "Found /llms.txt." : site.llmsTxt === false ? "No /llms.txt. Optional: Google says AI features do not need it." : "Not checked.",
    fix: "Optional. A Markdown list of your most useful pages can help coding agents and doc tools (guide §6.6).",
    section: "6.6",
  });

  // ---------------- head & meta ----------------
  add({
    id: "html-lang",
    category: "head",
    severity: "major",
    title: "<html lang> is set",
    pass: !!snap.lang,
    detail: snap.lang ? `lang="${snap.lang}"` : "The <html> element has no lang attribute.",
    fix: 'Add lang="en" (or your language, e.g. en-IN) to <html>.',
    evidence: "Documented",
    section: "5.3",
  });
  const tlen = (snap.title || "").length;
  add({
    id: "title-present",
    category: "head",
    severity: "critical",
    title: "Page has a <title>",
    pass: tlen > 0,
    detail: tlen ? `"${snap.title}"` : "No title.",
    fix: "Add a unique, descriptive title of about 50–60 characters with the topic first.",
    evidence: "Documented",
    section: "5.3",
  });
  if (tlen) {
    add({
      id: "title-length",
      category: "head",
      severity: "minor",
      title: "Title is about 50–60 characters",
      pass: tlen >= 30 && tlen <= 65,
      detail: `${tlen} characters.`,
      fix: tlen < 30 ? "Make the title more descriptive; state the topic and the question it answers." : "Shorten the title so it is not cut off in citations; put the topic first.",
      evidence: "Documented",
      section: "5.3",
    });
  }
  const dlen = (snap.metaDescription || "").length;
  add({
    id: "meta-description",
    category: "head",
    severity: "major",
    title: "Meta description summarises the answer",
    pass: dlen >= 50 && dlen <= 180,
    detail: dlen ? `${dlen} characters: "${snap.metaDescription}"` : "No meta description.",
    fix: "Write one sentence that states the answer, about 120–160 characters.",
    evidence: "Documented",
    section: "5.3",
  });
  let canonicalOk = false;
  try {
    canonicalOk = !!snap.canonical && /^https?:\/\//.test(snap.canonical) && !!new URL(snap.canonical);
  } catch {}
  add({
    id: "canonical",
    category: "head",
    severity: "major",
    title: "Absolute canonical URL",
    pass: canonicalOk,
    detail: snap.canonical ? `canonical: ${snap.canonical}` : "No <link rel=\"canonical\">.",
    fix: 'Add <link rel="canonical" href="https://…"> with an absolute URL, one per piece of content.',
    evidence: "Documented",
    section: "5.3",
  });
  add({
    id: "open-graph",
    category: "head",
    severity: "minor",
    title: "Open Graph title and type",
    pass: !!(snap.og?.title && snap.og?.type),
    detail: `og:title ${snap.og?.title ? "set" : "missing"}, og:type ${snap.og?.type ? `"${snap.og.type}"` : "missing"}.`,
    fix: 'Add <meta property="og:title"> and <meta property="og:type" content="article">, plus article:modified_time on articles.',
    evidence: "Practice",
    section: "5.2",
  });
  add({
    id: "meta-viewport",
    category: "head",
    severity: "major",
    title: "Mobile viewport meta tag",
    pass: !!snap.viewport,
    detail: snap.viewport ? `viewport: "${snap.viewport}"` : "No <meta name=\"viewport\">. Mobile-first indexing renders the page on a phone.",
    fix: 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.',
    evidence: "Documented",
    section: "5.2",
  });
  add({
    id: "meta-charset",
    category: "head",
    severity: "minor",
    title: "Character encoding declared",
    pass: snap.charset !== false,
    detail: snap.charset === false ? "No <meta charset>." : "Charset declared.",
    fix: 'Add <meta charset="utf-8"> as the first element in <head>.',
    evidence: "Practice",
    section: "5.2",
  });
  if ((snap.canonicalCount || 0) > 1) {
    add({
      id: "canonical-duplicate",
      category: "head",
      severity: "major",
      title: "Only one canonical tag",
      pass: false,
      detail: `${snap.canonicalCount} <link rel="canonical"> tags. Engines may ignore all of them.`,
      fix: "Keep exactly one canonical tag per page.",
      evidence: "Documented",
      section: "5.3",
    });
  }
  if (canonicalOk) {
    let self = true;
    try {
      const a = new URL(snap.canonical);
      const b = new URL(snap.url);
      self = a.host.replace(/^www\./, "") === b.host.replace(/^www\./, "") && a.pathname.replace(/\/$/, "") === b.pathname.replace(/\/$/, "");
    } catch {}
    if (!self) {
      add({
        id: "canonical-elsewhere",
        category: "head",
        severity: "info",
        title: "Canonical points to another URL",
        pass: true,
        detail: `This page says the main version is ${snap.canonical}. Engines will usually cite that URL instead.`,
        fix: "Fine for duplicates. If this page should be cited itself, make the canonical self-referencing.",
        section: "5.3",
      });
    }
  }
  add({
    id: "og-image",
    category: "head",
    severity: "minor",
    title: "Social preview image (og:image)",
    pass: !!snap.ogImage,
    detail: snap.ogImage ? snap.ogImage : "No og:image.",
    fix: 'Add <meta property="og:image" content="https://…/preview.png"> (1200×630). Many assistants show it next to citations.',
    evidence: "Practice",
    section: "5.2",
  });
  if (snap.metaDescription && snap.title && snap.metaDescription.trim().toLowerCase() === snap.title.trim().toLowerCase()) {
    add({
      id: "description-equals-title",
      category: "head",
      severity: "minor",
      title: "Description is different from the title",
      pass: false,
      detail: "The meta description repeats the title.",
      fix: "Make the description a one-sentence answer, not a copy of the title.",
      evidence: "Documented",
      section: "5.3",
    });
  }
  if (snap.hreflang?.length) {
    add({
      id: "hreflang-xdefault",
      category: "head",
      severity: "minor",
      title: "hreflang includes x-default",
      pass: snap.hreflang.some((h) => (h.lang || "").toLowerCase() === "x-default"),
      detail: `${snap.hreflang.length} hreflang links: ${snap.hreflang.map((h) => h.lang).join(", ")}`,
      fix: 'Add <link rel="alternate" hreflang="x-default" href="…"> next to the per-language links.',
      evidence: "Documented",
      section: "5.3",
    });
  }

  // ---------------- structure ----------------
  const content = snap.headings.filter((h) => !h.inNavOrFooter);
  const h1s = snap.headings.filter((h) => h.level === 1);
  add({
    id: "single-h1",
    category: "structure",
    severity: h1s.length === 0 ? "critical" : "major",
    title: "Exactly one H1",
    pass: h1s.length === 1,
    detail: h1s.length === 0 ? "No visible H1." : `${h1s.length} H1s: ${h1s.map((h) => `"${h.text}"`).join(", ")}`,
    fix: "Use one H1 that states the page's main question or topic.",
    selector: h1s[1]?.selector || h1s[0]?.selector,
    items: h1s.map((h) => ({ selector: h.selector, label: "H1" })),
    evidence: "Practice",
    section: "5.3",
  });
  const skips = [];
  for (let i = 1; i < content.length; i++) {
    if (content[i].level > content[i - 1].level + 1) skips.push(content[i]);
  }
  add({
    id: "heading-order",
    category: "structure",
    severity: "minor",
    title: "Heading levels are in order",
    pass: skips.length === 0,
    detail: skips.length ? `${skips.length} skipped level(s), e.g. H${skips[0].level} "${skips[0].text}".` : "No skipped levels.",
    fix: "Do not jump from H2 to H4. Retrieved chunks carry their heading as context.",
    selector: skips[0]?.selector,
    items: skips.map((h) => ({ selector: h.selector, label: `H${h.level} skips a level` })),
    evidence: "Practice",
    section: "5.3",
  });
  const h2s = content.filter((h) => h.level === 2);
  const questionH2 = h2s.filter((h) => QUESTION_HEADING.test(h.text));
  if (h2s.length >= 2) {
    add({
      id: "question-headings",
      category: "structure",
      severity: "minor",
      title: "Some H2s are phrased as questions",
      pass: questionH2.length >= Math.ceil(h2s.length / 3),
      detail: `${questionH2.length} of ${h2s.length} H2s read as questions.`,
      fix: 'Phrase headings the way users ask, e.g. "How do you add the JSON-LD?" instead of "Implementation".',
      evidence: "Practice",
      section: "5.1",
    });
  }
  add({
    id: "landmarks",
    category: "structure",
    severity: "minor",
    title: "Main content wrapped in <main> / <article>",
    pass: snap.landmarks.main > 0 && (snap.landmarks.article > 0 || snap.landmarks.section > 0),
    detail: `<main>: ${snap.landmarks.main}, <article>: ${snap.landmarks.article}, <section>: ${snap.landmarks.section}`,
    fix: "Wrap the content in <main><article>, with one <section> per topic, so it separates from nav and footer.",
    evidence: "Practice",
    section: "5.3",
  });
  const badTables = (snap.tables || []).filter((t) => t.rows > 1 && (!t.hasCaption || t.thScoped < Math.min(t.th, 1)));
  if (snap.tables?.length) {
    add({
      id: "table-semantics",
      category: "structure",
      severity: "minor",
      title: "Tables have <caption> and <th scope>",
      pass: badTables.length === 0,
      detail: badTables.length ? `${badTables.length} of ${snap.tables.length} tables lack a caption or scoped headers.` : "All tables have captions and scoped headers.",
      fix: 'Add <caption> and use <th scope="col"> so row/column meaning survives extraction.',
      selector: badTables[0]?.selector,
      items: badTables.map((t) => ({ selector: t.selector, label: "Table" })),
      evidence: "Practice",
      section: "5.3",
    });
  }
  add({
    id: "lists-used",
    category: "structure",
    severity: "info",
    title: "Lists and tables for steps and comparisons",
    pass: true,
    detail: `${snap.lists.ol} ordered, ${snap.lists.ul} unordered lists, ${snap.lists.dl} definition lists, ${snap.tables?.length || 0} tables.`,
    fix: "Use <ol> for steps, <table> for comparisons and <dl> for definitions.",
    section: "5.3",
  });

  // ---------------- answer-first ----------------
  const h1 = h1s[0];
  if (h1) {
    const s = h1.section || {};
    const ok = s.firstWords >= 15 && s.firstWords <= 90 && !s.firstStartsWithPronoun;
    add({
      id: "direct-answer-h1",
      category: "answers",
      severity: "critical",
      title: "Direct answer right under the H1",
      pass: ok,
      detail: !s.firstText
        ? "No paragraph follows the H1 before the next heading."
        : `First block is ${s.firstWords} words${s.firstStartsWithPronoun ? " and starts with a pronoun, so it loses its subject when quoted alone" : ""}: "${s.firstText.slice(0, 160)}${s.firstText.length > 160 ? "…" : ""}"`,
      fix: "Open with 1–2 sentences (roughly 40–60 words) that answer the H1 directly and name the subject.",
      selector: s.firstSelector || h1.selector,
      evidence: "Practice",
      section: "5.1",
    });
  }
  for (const h of content.filter((x) => x.level === 2 || x.level === 3)) {
    const s = h.section || {};
    if (/^(sources|references|related|share|comments|table of contents|contents|footnotes)/i.test(h.text)) continue;
    const empty = !s.firstText;
    const pronoun = !!s.firstStartsWithPronoun;
    const tooShort = !empty && s.firstWords < 8 && s.firstTag === "p";
    add({
      id: `answer-first:${hashKey(h.text)}`,
      category: "answers",
      severity: h.level === 2 ? "major" : "minor",
      title: `Answer-first under "${h.text.slice(0, 70)}"`,
      pass: !empty && !pronoun && !tooShort,
      detail: empty
        ? "No text directly under this heading before the next subheading."
        : pronoun
          ? `Starts with "${s.firstText.split(" ")[0]}". Passages are retrieved on their own, so name the subject.`
          : tooShort
            ? `First paragraph is only ${s.firstWords} words.`
            : "Starts with a direct statement.",
      fix: "Start the section with a sentence that answers the heading and names its subject.",
      selector: s.firstSelector || h.selector,
      group: "answers-sections",
      evidence: "Practice",
      section: "5.1",
    });
  }
  const stuffing = keywordStuffing(snap.wordsLower);
  if (stuffing) {
    add({
      id: "keyword-stuffing",
      category: "answers",
      severity: "major",
      title: "No keyword stuffing",
      pass: !(stuffing.per1000 > 12 && stuffing.count >= 6),
      detail: `Most repeated phrase: "${stuffing.phrase}" ${stuffing.count}× (${stuffing.per1000.toFixed(1)} per 1,000 words).`,
      fix: "Keyword stuffing was the only tactic that lowered visibility in the GEO study (−8%). Write naturally.",
      evidence: "Study",
      section: "6.4",
    });
  }
  add({
    id: "content-length",
    category: "answers",
    severity: "minor",
    title: "Enough content to answer from",
    pass: snap.wordCount >= 250,
    detail: `${snap.wordCount} words in the main content.`,
    fix: "Thin pages give engines little to quote. Cover the question fully with facts, steps and examples.",
    evidence: "Practice",
    section: "6.4",
  });

  // ---------------- structured data ----------------
  const ldBlocks = snap.jsonLd || [];
  const ldNodes = ldBlocks.filter((b) => b.ok).flatMap((b) => flattenLd(b.data));
  const types = new Set(ldNodes.flatMap(typesOf));
  const broken = ldBlocks.filter((b) => !b.ok);
  add({
    id: "jsonld-present",
    category: "schema",
    severity: "major",
    title: "JSON-LD structured data present",
    pass: ldNodes.length > 0,
    detail: ldNodes.length ? `Types: ${[...types].join(", ")}` : "No JSON-LD found.",
    fix: "Add one <script type=\"application/ld+json\"> with an @graph linking Organization, Person, the page type and BreadcrumbList (guide §6.3).",
    evidence: "Documented",
    section: "6.3",
  });
  if (broken.length) {
    add({
      id: "jsonld-valid",
      category: "schema",
      severity: "critical",
      title: "JSON-LD parses",
      pass: false,
      detail: `${broken.length} block(s) are invalid JSON: ${broken[0].error}`,
      fix: "Fix the JSON syntax, and escape < as \\u003c when you render it from code.",
      evidence: "Documented",
      section: "6.3",
    });
  }
  const isArticleLike = snap.og?.type === "article" || snap.landmarks.article > 0 || [...types].some((t) => ARTICLE_TYPES.includes(t));
  const article = ldNodes.find((n) => typesOf(n).some((t) => ARTICLE_TYPES.includes(t)));
  if (isArticleLike) {
    add({
      id: "jsonld-article",
      category: "schema",
      severity: "major",
      title: "Article / TechArticle / BlogPosting schema",
      pass: !!article,
      detail: article ? `Found ${typesOf(article).join(", ")}.` : "This looks like an article but has no Article-type schema.",
      fix: "Add an Article (or TechArticle / BlogPosting) node with headline, author, publisher, datePublished and dateModified.",
      evidence: "Documented",
      section: "6.3",
    });
    if (article) {
      const missing = ["headline", "author", "datePublished", "dateModified"].filter((k) => !article[k]);
      add({
        id: "jsonld-article-fields",
        category: "schema",
        severity: "minor",
        title: "Article schema has headline, author and dates",
        pass: missing.length === 0,
        detail: missing.length ? `Missing: ${missing.join(", ")}.` : "All key fields present.",
        fix: "Fill these from the same data the page displays; dateModified should match the visible <time>.",
        evidence: "Documented",
        section: "6.3",
      });
      const headline = String(article.headline || article.name || "");
      if (headline) {
        const sim = Math.max(similarity(headline, h1?.text), similarity(headline, snap.title));
        add({
          id: "jsonld-matches-visible",
          category: "schema",
          severity: "major",
          title: "Schema matches the visible content",
          pass: sim >= 0.5,
          detail: `Schema headline "${headline}" vs H1 "${h1?.text || "—"}".`,
          fix: "Every structured-data value must match what the page shows (guide §6.3).",
          evidence: "Documented",
          section: "6.3",
        });
      }
    }
  }
  add({
    id: "jsonld-organization",
    category: "schema",
    severity: "minor",
    title: "Organization entity",
    pass: types.has("Organization") || [...types].some((t) => /Organization|Corporation|LocalBusiness/.test(t)),
    detail: types.has("Organization") ? "Organization found." : "No Organization node.",
    fix: "Add an Organization with name, url, logo and sameAs links, and reference it as publisher.",
    evidence: "Documented",
    section: "6.3",
  });
  const depth = pathname.split("?")[0].split("/").filter(Boolean).length;
  if (depth > 0) {
    add({
      id: "jsonld-breadcrumb",
      category: "schema",
      severity: "minor",
      title: "BreadcrumbList on inner pages",
      pass: types.has("BreadcrumbList"),
      detail: types.has("BreadcrumbList") ? "BreadcrumbList found." : "No BreadcrumbList.",
      fix: "Add a BreadcrumbList matching the visible breadcrumb trail.",
      evidence: "Documented",
      section: "6.3",
    });
  }
  if (types.has("FAQPage") || types.has("HowTo")) {
    add({
      id: "jsonld-deprecated-rich",
      category: "schema",
      severity: "info",
      title: "FAQPage / HowTo rich results are retired",
      pass: true,
      detail: `${types.has("FAQPage") ? "FAQPage rich results were removed from Google on 7 May 2026. " : ""}${types.has("HowTo") ? "HowTo rich results were removed in 2023; use a plain <ol>." : ""}`,
      fix: "The markup does no harm, but do not expect a rich result from it.",
      section: "6.3",
    });
  }

  // deeper schema checks
  const missingContext = ldBlocks.filter((b) => b.ok && !JSON.stringify(b.data).includes("schema.org"));
  if (missingContext.length) {
    add({
      id: "jsonld-context",
      category: "schema",
      severity: "major",
      title: 'JSON-LD declares "@context": "https://schema.org"',
      pass: false,
      detail: `${missingContext.length} JSON-LD block(s) have no schema.org @context, so parsers cannot read them.`,
      fix: 'Start every block with "@context": "https://schema.org".',
      evidence: "Documented",
      section: "6.3",
    });
  }
  const org = ldNodes.find((n) => typesOf(n).some((t) => /Organization|Corporation|LocalBusiness/.test(t)) && (n.name || n.url));
  if (org) {
    const miss = ["name", "url", "logo"].filter((k) => !org[k]);
    add({
      id: "jsonld-organization-fields",
      category: "schema",
      severity: "minor",
      title: "Organization has name, url, logo and sameAs",
      pass: miss.length === 0 && !!org.sameAs,
      detail: miss.length || !org.sameAs ? `Missing: ${[...miss, ...(org.sameAs ? [] : ["sameAs"])].join(", ")}.` : "Complete.",
      fix: "sameAs links (LinkedIn, GitHub, Wikipedia, Crunchbase) help engines tie mentions elsewhere to your brand.",
      evidence: "Documented",
      section: "6.3",
    });
  }
  if (article) {
    add({
      id: "jsonld-article-image",
      category: "schema",
      severity: "minor",
      title: "Article schema has an image",
      pass: !!article.image,
      detail: article.image ? "Image set." : "No image property.",
      fix: "Add an image (URL of a representative image at least 1200px wide).",
      evidence: "Documented",
      section: "6.3",
    });
    const visibleDates = (snap.times || []).map((t) => String(t.datetime || "").slice(0, 10));
    const dm = String(article.dateModified || "").slice(0, 10);
    if (dm && visibleDates.length) {
      add({
        id: "jsonld-date-matches",
        category: "schema",
        severity: "minor",
        title: "dateModified matches the visible date",
        pass: visibleDates.includes(dm) || visibleDates.includes(String(article.datePublished || "").slice(0, 10)),
        detail: `Schema dateModified ${dm}; visible dates ${visibleDates.join(", ")}.`,
        fix: "Fill both from the same field so they never drift apart.",
        evidence: "Practice",
        section: "5.3",
      });
    }
  }
  const crumbs = ldNodes.find((n) => typesOf(n).includes("BreadcrumbList"));
  if (crumbs) {
    const items = Array.isArray(crumbs.itemListElement) ? crumbs.itemListElement : [];
    const bad = items.some((it, i) => Number(it.position) !== i + 1 || !(it.name || it.item?.name)) || items.slice(0, -1).some((it) => !it.item);
    add({
      id: "jsonld-breadcrumb-valid",
      category: "schema",
      severity: "minor",
      title: "BreadcrumbList items are complete",
      pass: items.length > 0 && !bad,
      detail: items.length ? `${items.length} items${bad ? "; positions must run 1, 2, 3… and every item except the last needs name and item URL" : ""}.` : "itemListElement is empty.",
      fix: "Give each ListItem a position, a name and an item URL (the last one may omit item).",
      evidence: "Documented",
      section: "6.3",
    });
  }
  const product = ldNodes.find((n) => typesOf(n).includes("Product"));
  if (product) {
    const offer = Array.isArray(product.offers) ? product.offers[0] : product.offers;
    const miss = [!product.name && "name", !offer && "offers", offer && !offer.price && !offer.lowPrice && "offers.price", offer && !offer.priceCurrency && "offers.priceCurrency", offer && !offer.availability && "offers.availability"].filter(Boolean);
    add({
      id: "jsonld-product-fields",
      category: "schema",
      severity: "major",
      title: "Product schema has name, price, currency and availability",
      pass: miss.length === 0,
      detail: miss.length ? `Missing: ${miss.join(", ")}.` : "Complete.",
      fix: "Add an Offer with price, priceCurrency and availability that match the page.",
      evidence: "Documented",
      section: "6.3",
    });
    const rating = product.aggregateRating;
    if (rating?.ratingValue) {
      const shown = (snap.text || "").includes(String(rating.ratingValue));
      add({
        id: "jsonld-rating-visible",
        category: "schema",
        severity: "major",
        title: "Rating in schema is shown on the page",
        pass: shown,
        detail: shown ? `Rating ${rating.ratingValue} is visible.` : `Schema says rating ${rating.ratingValue}, but that value is not visible on the page.`,
        fix: "Only include ratings you actually display (guide §6.3).",
        evidence: "Documented",
        section: "6.3",
      });
    }
  }
  const dupTypes = [...types].filter((t) => ARTICLE_TYPES.includes(t) || t === "Product" || t === "FAQPage").filter((t) => ldNodes.filter((n) => typesOf(n).includes(t)).length > 1);
  if (dupTypes.length) {
    add({
      id: "jsonld-duplicates",
      category: "schema",
      severity: "minor",
      title: "No duplicate main entities",
      pass: false,
      detail: `More than one ${dupTypes.join(", ")} node. Often a theme and a plugin both output schema.`,
      fix: "Keep one main entity per page; remove the duplicate source.",
      evidence: "Practice",
      section: "6.3",
    });
  }

  // FAQ
  const faqNode = ldNodes.find((n) => typesOf(n).includes("FAQPage"));
  const visibleQs = snap.faq?.questions || [];
  const hasVisibleFaq = !!snap.faq?.heading || visibleQs.length >= 3;
  if (faqNode) {
    const qs = (Array.isArray(faqNode.mainEntity) ? faqNode.mainEntity : faqNode.mainEntity ? [faqNode.mainEntity] : []).filter(Boolean);
    const incomplete = qs.filter((q) => !q.name || !(q.acceptedAnswer?.text));
    add({
      id: "faq-schema-complete",
      category: "schema",
      severity: "major",
      title: "FAQPage questions have name and acceptedAnswer",
      pass: qs.length > 0 && incomplete.length === 0,
      detail: qs.length ? `${qs.length} questions${incomplete.length ? `, ${incomplete.length} missing a name or acceptedAnswer.text` : ""}.` : "FAQPage has no mainEntity questions.",
      fix: 'Each item: {"@type":"Question","name":"…","acceptedAnswer":{"@type":"Answer","text":"…"}}.',
      evidence: "Documented",
      section: "6.3",
    });
    const pageText = (snap.text || "").toLowerCase();
    const hidden = qs.filter((q) => q.name && !pageText.includes(String(q.name).toLowerCase().slice(0, 50)));
    add({
      id: "faq-schema-visible",
      category: "schema",
      severity: "major",
      title: "FAQ schema matches visible questions",
      pass: hidden.length === 0,
      detail: hidden.length ? `${hidden.length} of ${qs.length} questions in the schema are not visible on the page, e.g. "${hidden[0].name}".` : "Every schema question appears on the page.",
      fix: "Structured data must match visible content. Show these questions on the page or remove them from the markup.",
      evidence: "Documented",
      section: "6.3",
    });
  } else if (hasVisibleFaq) {
    add({
      id: "faq-no-schema",
      category: "schema",
      severity: "info",
      title: "Visible FAQ without FAQPage markup",
      pass: true,
      detail: `Found an FAQ${snap.faq?.heading ? ` ("${snap.faq.heading}")` : ""} with ${visibleQs.length} questions. FAQ rich results were retired on 7 May 2026, so markup is optional.`,
      fix: "Optional: FAQPage markup still describes Q&A to other parsers. Make sure each answer starts with a direct sentence.",
      selector: snap.faq?.headingSelector,
      section: "6.3",
    });
  }
  if (hasVisibleFaq) {
    const asQuestions = visibleQs.length;
    add({
      id: "faq-questions-phrased",
      category: "answers",
      severity: "minor",
      title: "FAQ items are written as real questions",
      pass: asQuestions >= 2,
      detail: `${asQuestions} FAQ items end with a question mark.`,
      fix: "Write each FAQ item the way a user would ask it, then answer it in the first sentence.",
      selector: snap.faq?.headingSelector,
      evidence: "Practice",
      section: "5.1",
    });
  }

  // more schema types
  if (depth === 0) {
    const website = ldNodes.find((n) => typesOf(n).includes("WebSite"));
    add({
      id: "jsonld-website",
      category: "schema",
      severity: "minor",
      title: "WebSite schema on the home page",
      pass: !!(website && website.name && website.url),
      detail: website ? `WebSite: ${website.name || "no name"}${website.potentialAction ? " with SearchAction" : ""}.` : "No WebSite node.",
      fix: 'Add {"@type":"WebSite","name":"…","url":"https://…"} on the home page; it gives engines your site name.',
      evidence: "Documented",
      section: "6.3",
    });
  }
  const persons = ldNodes.filter((n) => typesOf(n).includes("Person") && n.name);
  if (persons.length) {
    const thin = persons.filter((p) => !p.url && !p.sameAs);
    add({
      id: "jsonld-person-fields",
      category: "schema",
      severity: "minor",
      title: "Person entities link to a profile",
      pass: thin.length === 0,
      detail: thin.length ? `${thin.length} Person node(s) without url or sameAs, e.g. ${thin[0].name}.` : "Every Person has url or sameAs.",
      fix: "Add url (author page) and sameAs (LinkedIn, GitHub) so engines can identify the author.",
      evidence: "Practice",
      section: "6.3",
    });
  }
  const reviews = ldNodes.filter((n) => typesOf(n).includes("Review"));
  if (reviews.length) {
    const bad = reviews.filter((r) => !r.reviewRating || !r.author || (!r.itemReviewed && !ldNodes.some((n) => n.review)));
    add({
      id: "jsonld-review-fields",
      category: "schema",
      severity: "minor",
      title: "Review schema has rating, author and item reviewed",
      pass: bad.length === 0,
      detail: bad.length ? `${bad.length} of ${reviews.length} Review nodes are incomplete.` : "Complete.",
      fix: "Each Review needs reviewRating, author and itemReviewed (or must sit inside the item's review property).",
      evidence: "Documented",
      section: "6.3",
    });
  }
  const events = ldNodes.filter((n) => typesOf(n).some((t) => /Event$/.test(t)));
  if (events.length) {
    const bad = events.filter((e) => !e.name || !e.startDate || !e.location);
    add({
      id: "jsonld-event-fields",
      category: "schema",
      severity: "minor",
      title: "Event schema has name, startDate and location",
      pass: bad.length === 0,
      detail: bad.length ? `${bad.length} of ${events.length} Event nodes are missing name, startDate or location.` : "Complete.",
      fix: "Add name, startDate (ISO 8601) and location (Place or VirtualLocation).",
      evidence: "Documented",
      section: "6.3",
    });
  }
  const videoNodes = ldNodes.filter((n) => typesOf(n).includes("VideoObject"));
  if (videoNodes.length || snap.videos > 0) {
    const bad = videoNodes.filter((v) => !v.name || !v.thumbnailUrl || !v.uploadDate);
    add({
      id: "jsonld-video",
      category: "schema",
      severity: "minor",
      title: "Videos have complete VideoObject schema",
      pass: videoNodes.length > 0 && bad.length === 0,
      detail: !videoNodes.length ? `${snap.videos} embedded video(s) but no VideoObject.` : bad.length ? `${bad.length} VideoObject node(s) missing name, thumbnailUrl or uploadDate.` : "Complete.",
      fix: "Describe each video with VideoObject: name, description, thumbnailUrl, uploadDate, and contentUrl or embedUrl.",
      evidence: "Documented",
      section: "6.3",
    });
  }

  // ---------------- technical & security ----------------
  const isHttps = /^https:/i.test(snap.url);
  const hdr = site.rawHtml?.headers || {};
  add({
    id: "https",
    category: "tech",
    severity: "critical",
    title: "Served over HTTPS",
    pass: isHttps || /^http:\/\/(localhost|127\.)/.test(snap.url),
    detail: isHttps ? "HTTPS." : "This page is served over plain HTTP.",
    fix: "Serve every page over HTTPS and redirect HTTP to HTTPS.",
    evidence: "Documented",
    section: "6.2",
  });
  if (/noindex|none/i.test(hdr["x-robots-tag"] || "")) {
    add({
      id: "header-noindex",
      category: "access",
      severity: "critical",
      title: "No noindex in the X-Robots-Tag header",
      pass: false,
      detail: `X-Robots-Tag: ${hdr["x-robots-tag"]}`,
      fix: "Remove noindex from the X-Robots-Tag response header (often set by a CDN or staging config).",
      evidence: "Documented",
      section: "5.3",
    });
  }
  const t = site.tech;
  if (isHttps && t) {
    if (t.httpRedirectsToHttps !== null) {
      add({
        id: "http-to-https",
        category: "tech",
        severity: "major",
        title: "HTTP redirects to HTTPS",
        pass: t.httpRedirectsToHttps,
        detail: t.httpRedirectsToHttps ? "http:// redirects to https://." : "The http:// version does not redirect to https://.",
        fix: "Add a permanent (301) redirect from HTTP to HTTPS for every URL.",
        evidence: "Documented",
        section: "6.2",
      });
    }
    add({
      id: "hsts",
      category: "tech",
      severity: "minor",
      title: "Strict-Transport-Security header",
      pass: !!hdr["strict-transport-security"],
      detail: hdr["strict-transport-security"] || "No HSTS header.",
      fix: "Send Strict-Transport-Security: max-age=31536000; includeSubDomains.",
      evidence: "Practice",
      section: "6.2",
    });
  }
  if (site.rawHtml?.headers) {
    const sec = ["content-security-policy", "x-content-type-options", "referrer-policy", "permissions-policy"];
    const frame = !!hdr["x-frame-options"] || /frame-ancestors/i.test(hdr["content-security-policy"] || "");
    const missing = sec.filter((k) => !hdr[k]).concat(frame ? [] : ["x-frame-options / frame-ancestors"]);
    add({
      id: "security-headers",
      category: "tech",
      severity: "minor",
      title: "Security headers",
      pass: missing.length <= 1,
      detail: missing.length ? `Missing: ${missing.join(", ")}.` : "All common security headers present.",
      fix: "Add Content-Security-Policy, X-Content-Type-Options: nosniff, Referrer-Policy, Permissions-Policy and frame-ancestors (or X-Frame-Options).",
      evidence: "Practice",
      section: "6.2",
    });
    add({
      id: "cache-headers",
      category: "tech",
      severity: "minor",
      title: "Caching headers",
      pass: !!(hdr["cache-control"] || hdr.etag || hdr["last-modified"]) && !/no-store/i.test(hdr["cache-control"] || ""),
      detail: hdr["cache-control"] ? `Cache-Control: ${hdr["cache-control"]}` : hdr.etag || hdr["last-modified"] ? "ETag / Last-Modified set, no Cache-Control." : "No Cache-Control, ETag or Last-Modified.",
      fix: "Send Cache-Control (e.g. public, max-age=300, stale-while-revalidate) and ETag so crawlers can revalidate cheaply.",
      evidence: "Practice",
      section: "6.2",
    });
    const ms = site.rawHtml.ms;
    const kb = Math.round((site.rawHtml.bytes || 0) / 1024);
    add({
      id: "response-time",
      category: "tech",
      severity: "minor",
      title: "Fast server response",
      pass: ms != null && ms < 800,
      detail: `HTML served in ${ms ?? "?"} ms, ${kb} KB${hdr["content-encoding"] ? `, ${hdr["content-encoding"]} compressed` : ""}.`,
      fix: "Keep time to first byte under about 0.8 s: cache HTML at the edge and render statically where you can. Slow pages may be skipped by AI fetchers that answer in real time.",
      evidence: "Practice",
      section: "6.2",
    });
    const cdn = hdr["cf-ray"] ? "Cloudflare" : hdr["x-sucuri-id"] ? "Sucuri" : hdr["x-akamai-transformed"] ? "Akamai" : hdr["x-amz-cf-id"] ? "CloudFront" : hdr["x-vercel-id"] ? "Vercel" : /fastly/i.test(hdr["x-served-by"] || hdr.via || "") ? "Fastly" : null;
    if (cdn) {
      add({
        id: "waf-detected",
        category: "tech",
        severity: "info",
        title: `CDN / firewall detected: ${cdn}`,
        pass: true,
        detail: `${cdn} can block AI crawlers even when robots.txt allows them.`,
        fix: `Check ${cdn}'s bot settings (for example Cloudflare's "Block AI bots") and allow OAI-SearchBot, PerplexityBot and Claude-SearchBot (guide §6.1).`,
        section: "6.1",
      });
    }
  }
  if (t) {
    if (t.notFoundStatus != null) {
      add({
        id: "soft-404",
        category: "tech",
        severity: "major",
        title: "Missing pages return 404",
        pass: t.notFoundStatus === 404 || t.notFoundStatus === 410,
        detail: `A made-up URL returned HTTP ${t.notFoundStatus}.${t.notFoundStatus === 200 ? " That is a soft 404: engines may index error pages." : ""}`,
        fix: "Return a real 404 (or 410) status for URLs that do not exist.",
        evidence: "Documented",
        section: "6.2",
      });
    }
    add({
      id: "sitemap-xml",
      category: "tech",
      severity: "minor",
      title: "sitemap.xml is reachable",
      pass: t.sitemapStatus === 200 || !!(site.robots?.text && /sitemap:/i.test(site.robots.text)),
      detail: t.sitemapStatus === 200 ? "/sitemap.xml is valid XML." : `/sitemap.xml returned ${t.sitemapStatus ?? "no response"}${t.sitemapStatus === 415 ? " (not XML)" : ""}.`,
      fix: "Publish a sitemap with accurate <lastmod> and list it in robots.txt (guide §6.5).",
      evidence: "Documented",
      section: "6.5",
    });
    add({
      id: "security-txt",
      category: "tech",
      severity: "info",
      title: "security.txt",
      pass: true,
      detail: t.securityTxt ? "/.well-known/security.txt found." : "No /.well-known/security.txt.",
      fix: "Optional trust signal: publish a security.txt with a Contact line.",
      section: null,
    });
    const e = t.email;
    if (e && !e.skipped && !e.error && e.mx > 0) {
      add({
        id: "email-spf",
        category: "tech",
        severity: "minor",
        title: `SPF record for ${e.domain}`,
        pass: !!e.spf,
        detail: e.spf || "No SPF record.",
        fix: "Publish a TXT record starting v=spf1 listing the services that send your mail.",
        evidence: "Practice",
        section: null,
      });
      add({
        id: "email-dmarc",
        category: "tech",
        severity: "minor",
        title: `DMARC record for ${e.domain}`,
        pass: !!e.dmarc,
        detail: e.dmarc || "No _dmarc TXT record.",
        fix: "Publish _dmarc TXT: v=DMARC1; p=quarantine; rua=mailto:… (start with p=none to monitor).",
        evidence: "Practice",
        section: null,
      });
      add({
        id: "email-dkim",
        category: "tech",
        severity: "info",
        title: "DKIM",
        pass: true,
        detail: e.dkimSelector ? `DKIM key found at selector "${e.dkimSelector}".` : "No DKIM key at common selectors (google, selector1, default…). Your provider may use another selector.",
        fix: "Turn on DKIM signing with your email provider.",
        section: null,
      });
      add({
        id: "email-mta-sts",
        category: "tech",
        severity: "info",
        title: "MTA-STS",
        pass: true,
        detail: e.mtaSts ? "MTA-STS enabled." : "No MTA-STS policy.",
        fix: "Optional: MTA-STS enforces TLS for mail sent to your domain.",
        section: null,
      });
    }
  }
  if (snap.mixedContent?.length) {
    add({
      id: "mixed-content",
      category: "tech",
      severity: "major",
      title: "No insecure (http://) resources",
      pass: false,
      detail: `${snap.mixedContent.length} resource(s) load over http://, e.g. ${snap.mixedContent[0].url}.`,
      fix: "Load every image, script and stylesheet over https://.",
      selector: snap.mixedContent[0].selector,
      items: snap.mixedContent.map((m) => ({ selector: m.selector, label: "http:// resource" })),
      evidence: "Documented",
      section: "6.2",
    });
  }
  const imf = snap.imageFormats;
  if (imf && imf.large >= 2) {
    add({
      id: "image-formats",
      category: "tech",
      severity: "minor",
      title: "Images use modern formats and lazy loading",
      pass: imf.modern >= imf.large / 2 && imf.belowFoldLazy >= imf.belowFold / 2 && !imf.oversized.length,
      detail: `${imf.modern}/${imf.large} large images are WebP/AVIF; ${imf.belowFoldLazy}/${imf.belowFold} below-the-fold images lazy-load${imf.oversized.length ? `; ${imf.oversized.length} served at over twice their display size` : ""}.`,
      fix: 'Serve WebP or AVIF, add loading="lazy" below the fold, and size images to how they are shown.',
      selector: imf.oversized[0]?.selector,
      items: imf.oversized.map((o) => ({ selector: o.selector, label: `${o.natural}px shown at ${o.shown}px` })),
      evidence: "Documented",
      section: "5.3",
    });
  }
  const noSize = (snap.images || []).filter((i) => !i.hasSize);
  if (snap.images?.length) {
    add({
      id: "img-dimensions",
      category: "tech",
      severity: "minor",
      title: "Images have width and height",
      pass: noSize.length === 0,
      detail: noSize.length ? `${noSize.length} of ${snap.images.length} images have no width/height attributes (layout shift).` : "All images sized.",
      fix: "Add width and height attributes to every <img>.",
      selector: noSize[0]?.selector,
      items: noSize.slice(0, 20).map((i) => ({ selector: i.selector, label: "No width/height" })),
      evidence: "Documented",
      section: "5.3",
    });
  }
  if (snap.consent || snap.gtagConsent) {
    add({
      id: "consent-mode",
      category: "tech",
      severity: "info",
      title: "Cookie consent",
      pass: true,
      detail: `${snap.consent ? "A consent banner/tool is present." : ""} ${snap.gtagConsent ? "Google Consent Mode is configured." : "Google Consent Mode not detected."}`.trim(),
      fix: "Make sure the consent banner does not hide the main content from crawlers or block it until a click.",
      section: null,
    });
  }
  try {
    const u = new URL(snap.url);
    const problems = [];
    if (/[A-Z]/.test(u.pathname)) problems.push("uppercase letters");
    if (/_/.test(u.pathname)) problems.push("underscores");
    if (u.href.length > 115) problems.push(`${u.href.length} characters long`);
    if ([...u.searchParams.keys()].length > 2) problems.push(`${[...u.searchParams.keys()].length} query parameters`);
    if (u.pathname.split("/").filter(Boolean).length > 4) problems.push("deeply nested");
    add({
      id: "url-structure",
      category: "tech",
      severity: "minor",
      title: "Clean, readable URL",
      pass: problems.length === 0,
      detail: problems.length ? `URL has ${problems.join(", ")}.` : "Short, lowercase, hyphenated.",
      fix: "Use short lowercase URLs with hyphens that name the topic, e.g. /guides/nextjs-schema.",
      evidence: "Documented",
      section: "5.3",
    });
  } catch {}

  // ---------------- trust & evidence ----------------
  const personAuthor = ldNodes.some((n) => typesOf(n).includes("Person"));
  add({
    id: "author",
    category: "trust",
    severity: "major",
    title: "Named author, linked to a bio",
    pass: !!(snap.author?.relAuthor || (snap.author && personAuthor)),
    detail: snap.author ? `Byline: "${snap.author.text}"${snap.author.relAuthor ? ' with rel="author"' : ""}.` : "No visible author found.",
    fix: 'Show the author and link to their bio with <a rel="author">; add a Person node in JSON-LD.',
    selector: snap.author?.selector,
    evidence: "Practice",
    section: "5.2",
  });
  add({
    id: "updated-date",
    category: "trust",
    severity: "minor",
    title: "Visible date in <time datetime>",
    pass: (snap.times || []).length > 0,
    detail: snap.times?.length ? `${snap.times[0].text || snap.times[0].datetime} (${snap.times[0].datetime})` : "No <time datetime> element.",
    fix: 'Show "Updated <time datetime="2026-11-05">5 Nov 2026</time>" and keep it equal to dateModified.',
    selector: snap.times?.[0]?.selector,
    evidence: "Practice",
    section: "5.3",
  });
  add({
    id: "citations",
    category: "trust",
    severity: "major",
    title: "Cites primary sources",
    pass: snap.outboundLinks >= 2,
    detail: `${snap.outboundLinks} outbound links in the content.`,
    fix: 'Link to standards, docs and papers that back your claims. "Cite sources" raised visibility up to 115% for lower-ranked pages in the GEO study.',
    evidence: "Study",
    section: "6.4",
  });
  add({
    id: "statistics",
    category: "trust",
    severity: "minor",
    title: "Includes statistics",
    pass: snap.stats >= 2,
    detail: `${snap.stats} statistic-like figures (%, money, millions) found.`,
    fix: "Add real numbers with their source, e.g. \"organic CTR fell 61% (Seer Interactive, 2025)\". Never invent numbers.",
    evidence: "Study",
    section: "6.4",
  });
  add({
    id: "quotations",
    category: "trust",
    severity: "minor",
    title: "Quotes a named expert",
    pass: snap.quotes > 0,
    detail: `${snap.quotes} <blockquote>/<q> elements.`,
    fix: "Quote a named person in a <blockquote cite>. Quotation addition did best in the GEO study (+41%).",
    evidence: "Study",
    section: "5.3",
  });
  const noAlt = (snap.images || []).filter((i) => !i.hasAlt && !i.decorative);
  if (snap.images?.length) {
    add({
      id: "img-alt",
      category: "trust",
      severity: "minor",
      title: "Images have alt text",
      pass: noAlt.length === 0,
      detail: noAlt.length ? `${noAlt.length} of ${snap.images.length} images have no alt attribute.` : "All images have alt.",
      fix: 'Describe each image in alt; use alt="" only for decorative images. Add width and height to prevent layout shift.',
      selector: noAlt[0]?.selector,
      items: noAlt.map((i) => ({ selector: i.selector, label: "Missing alt" })),
      evidence: "Documented",
      section: "5.3",
    });
  }
  if (snap.genericLinks?.length) {
    add({
      id: "link-text",
      category: "trust",
      severity: "minor",
      title: "Descriptive link text",
      pass: false,
      detail: `${snap.genericLinks.length} links say things like "${snap.genericLinks[0].text}".`,
      fix: 'Replace "click here" with text that describes the target page.',
      selector: snap.genericLinks[0].selector,
      items: snap.genericLinks.map((l) => ({ selector: l.selector, label: `"${l.text}"` })),
      evidence: "Documented",
      section: "5.3",
    });
  }

  return summarize(checks);
}

export function summarize(checks) {
  const categories = {};
  for (const [key, cat] of Object.entries(CATEGORIES)) {
    const cs = checks.filter((c) => c.category === key && c.severity !== "info");
    const total = cs.reduce((s, c) => s + SEVERITY_POINTS[c.severity], 0);
    const got = cs.filter((c) => c.pass).reduce((s, c) => s + SEVERITY_POINTS[c.severity], 0);
    categories[key] = { ...cat, score: total ? Math.round((got / total) * 100) : 100, passed: cs.filter((c) => c.pass).length, total: cs.length };
  }
  const wsum = Object.values(categories).reduce((s, c) => s + c.weight, 0);
  const raw = Math.round(Object.values(categories).reduce((s, c) => s + c.score * c.weight, 0) / wsum);
  const blockers = checks.filter((c) => BLOCKERS.has(c.id) && !c.pass);
  for (const b of blockers) b.blocker = true;
  const score = blockers.length ? Math.min(raw, 59) : raw;
  return { score, rawScore: raw, grade: grade(score), categories, checks, blockers: blockers.map((b) => b.title) };
}

export function grade(score) {
  if (score >= 90) return "A · Excellent";
  if (score >= 75) return "B · Good";
  if (score >= 60) return "C · Fair";
  if (score >= 40) return "D · Needs work";
  return "F · Poor";
}

// Failing any of these caps the AEO score at 59 (grade D): the page can't be cited however good the rest is.
const BLOCKERS = new Set(["robots-noindex", "robots-nosnippet", "header-noindex", "http-status", "robots-allow-googlebot", "robots-allow-bingbot", "ai-bots-all-blocked", "server-rendered"]);

/**
 * Compare a new run with the previous one for the same URL.
 * marked: { [checkId]: true } issues the user marked as fixed.
 */
export function diffRuns(prevChecks, nextChecks, marked = {}) {
  const prevFailed = new Map((prevChecks || []).filter((c) => !c.pass && c.severity !== "info").map((c) => [c.id, c]));
  const nextById = new Map(nextChecks.map((c) => [c.id, c]));
  const verified = [];
  const stillFailing = [];
  for (const [id, c] of prevFailed) {
    const now = nextById.get(id);
    if (!now || now.pass) verified.push({ ...c, wasMarked: !!marked[id] });
    else if (marked[id]) stillFailing.push(now);
  }
  return { verified, stillFailing };
}

// ---------------------------------------------------------------------------
// areas used for filtering and reports

export const AREAS = {
  aeo: "AEO & GEO",
  schema: "Schema & tags",
  tech: "Technical & security",
  a11y: "Accessibility",
};

export function areaOf(category) {
  if (category === "schema" || category === "head") return "schema";
  if (category === "a11y") return "a11y";
  if (category === "tech") return "tech";
  return "aeo";
}

// ---------------------------------------------------------------------------
// Accessibility (axe-core results → issues grouped by who they affect)

export const A11Y_GROUPS = {
  "screen-reader": "Blind & screen-reader users",
  vision: "Low vision & colour blindness",
  keyboard: "Keyboard & motor",
  hearing: "Deaf & hard of hearing",
  cognitive: "Cognitive & reading",
};

const A11Y_GROUP_BY_CAT = {
  "cat.text-alternatives": "screen-reader",
  "cat.aria": "screen-reader",
  "cat.name-role-value": "screen-reader",
  "cat.forms": "screen-reader",
  "cat.tables": "screen-reader",
  "cat.parsing": "screen-reader",
  "cat.semantics": "cognitive",
  "cat.structure": "cognitive",
  "cat.language": "cognitive",
  "cat.color": "vision",
  "cat.sensory-and-visual-cues": "vision",
  "cat.keyboard": "keyboard",
  "cat.time-and-media": "hearing",
};
const A11Y_GROUP_BY_RULE = { "meta-viewport": "vision", "meta-viewport-large": "vision", "link-name": "screen-reader", "button-name": "screen-reader", "image-alt": "screen-reader", "video-caption": "hearing", "audio-caption": "hearing", "bypass": "keyboard", "region": "screen-reader", "landmark-one-main": "screen-reader", "heading-order": "cognitive", "page-has-heading-one": "cognitive", "html-has-lang": "cognitive", "document-title": "cognitive" };

const IMPACT_SEVERITY = { critical: "critical", serious: "major", moderate: "minor", minor: "minor" };
const IMPACT_WEIGHT = { critical: 10, serious: 7, moderate: 3, minor: 1 };

function wcagRefs(tags) {
  return (tags || [])
    .map((t) => t.match(/^wcag(\d)(\d)(\d+)$/))
    .filter(Boolean)
    .map((m) => `${m[1]}.${m[2]}.${m[3]}`);
}

function wcagLevel(tags) {
  if ((tags || []).some((t) => /^wcag2(1|2)?aa$/.test(t))) return "AA";
  if ((tags || []).some((t) => /^wcag2(1|2)?a$/.test(t))) return "A";
  return "Best practice";
}

export function a11yGroupOf(rule) {
  if (A11Y_GROUP_BY_RULE[rule.id]) return A11Y_GROUP_BY_RULE[rule.id];
  const cat = (rule.tags || []).find((t) => t.startsWith("cat."));
  return A11Y_GROUP_BY_CAT[cat] || "screen-reader";
}

/** axe results → { score, groups, checks } with checks shaped like the AEO checks. */
export function scoreAccessibility(axe) {
  if (!axe?.ok) return null;
  const checks = axe.violations.map((v) => {
    const refs = wcagRefs(v.tags);
    const group = a11yGroupOf(v);
    return {
      id: `a11y:${v.id}`,
      category: "a11y",
      group,
      severity: IMPACT_SEVERITY[v.impact] || "minor",
      impact: v.impact,
      title: v.help,
      pass: false,
      detail: `${v.nodeCount} element${v.nodeCount === 1 ? "" : "s"}. ${v.description}`,
      fix: v.nodes[0]?.summary || v.description,
      wcag: refs,
      level: wcagLevel(v.tags),
      helpUrl: v.helpUrl,
      evidence: refs.length ? `WCAG ${refs.join(", ")} (${wcagLevel(v.tags)})` : "Best practice",
      selector: v.nodes[0]?.selector || null,
      items: v.nodes.map((n) => ({ selector: n.selector, label: v.id })),
      nodeCount: v.nodeCount,
    };
  });
  const passedW = axe.passes.reduce((s, r) => s + (IMPACT_WEIGHT[r.impact] || 3), 0);
  const failedW = axe.violations.reduce((s, r) => s + (IMPACT_WEIGHT[r.impact] || 3), 0);
  const score = passedW + failedW ? Math.round((passedW / (passedW + failedW)) * 100) : 100;
  const groups = {};
  for (const [key, label] of Object.entries(A11Y_GROUPS)) {
    const cs = checks.filter((c) => c.group === key);
    groups[key] = { label, count: cs.length, critical: cs.filter((c) => c.severity === "critical").length };
  }
  return { score, grade: grade(score), groups, checks, passedRules: axe.passes.length };
}

// ---------------------------------------------------------------------------
// Site-wide checks across crawled pages

/**
 * pages: [{ url, meta: { title, description, canonical, hreflang: [{lang, href}] } }]
 * Returns issues shaped like checks, each with a `pages` list.
 */
export function siteWideChecks(pages) {
  const ok = pages.filter((p) => p.meta);
  const out = [];
  const norm = (u) => {
    try {
      const x = new URL(u);
      x.hash = "";
      return x.href.replace(/\/$/, "");
    } catch {
      return u;
    }
  };
  const dupes = (field, id, label, severity, fix) => {
    const groups = new Map();
    for (const p of ok) {
      const v = (p.meta[field] || "").trim().toLowerCase();
      if (!v) continue;
      // pages that canonicalise to the same URL are not duplicates
      const key = v;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }
    const dup = [...groups.entries()].filter(([, ps]) => new Set(ps.map((p) => norm(p.meta.canonical || p.url))).size > 1);
    if (!dup.length) return;
    out.push({
      id,
      category: "head",
      severity,
      title: label,
      pass: false,
      detail: `${dup.length} ${field === "title" ? "titles" : "descriptions"} are shared by more than one page, e.g. "${dup[0][1][0].meta[field]}" on ${dup[0][1].length} pages.`,
      fix,
      evidence: "Documented",
      section: "5.3",
      pages: dup.flatMap(([, ps]) => ps.map((p) => p.url)),
    });
  };
  dupes("title", "site-duplicate-titles", "Duplicate page titles", "major", "Give every page a unique title that names its own topic. Engines use the title as the citation link text.");
  dupes("description", "site-duplicate-descriptions", "Duplicate meta descriptions", "minor", "Write a one-sentence answer summary per page instead of a shared template description.");

  // hreflang reciprocity: if A says B is its "fr" version, B must link back to A.
  const byUrl = new Map(ok.map((p) => [norm(p.url), p]));
  const broken = [];
  for (const p of ok) {
    for (const h of p.meta.hreflang || []) {
      if (!h.href || (h.lang || "").toLowerCase() === "x-default") continue;
      let target;
      try {
        target = norm(new URL(h.href, p.url).href);
      } catch {
        continue;
      }
      if (target === norm(p.url)) continue;
      const other = byUrl.get(target);
      if (!other) continue; // not crawled, cannot judge
      const back = (other.meta.hreflang || []).some((x) => {
        try {
          return norm(new URL(x.href, other.url).href) === norm(p.url);
        } catch {
          return false;
        }
      });
      if (!back) broken.push({ from: p.url, to: target, lang: h.lang });
    }
  }
  if (broken.length) {
    out.push({
      id: "site-hreflang-reciprocal",
      category: "head",
      severity: "major",
      title: "hreflang links are reciprocal",
      pass: false,
      detail: `${broken.length} hreflang link(s) are not returned, e.g. ${broken[0].from} → ${broken[0].to} (${broken[0].lang}) has no link back.`,
      fix: "Every language version must list all the others, including itself. Search engines ignore one-way hreflang.",
      evidence: "Documented",
      section: "5.3",
      pages: [...new Set(broken.map((b) => b.from))],
    });
  }
  // canonical pointing at pages that were not reachable
  const canonTargets = ok.filter((p) => p.meta.canonical && norm(p.meta.canonical) !== norm(p.url));
  const errored = new Set(pages.filter((p) => p.error).map((p) => norm(p.url)));
  const badCanon = canonTargets.filter((p) => errored.has(norm(p.meta.canonical)));
  if (badCanon.length) {
    out.push({
      id: "site-canonical-broken",
      category: "head",
      severity: "major",
      title: "Canonicals point to working pages",
      pass: false,
      detail: `${badCanon.length} page(s) name a canonical URL that returned an error.`,
      fix: "Point canonical tags at live, indexable pages.",
      evidence: "Documented",
      section: "5.3",
      pages: badCanon.map((p) => p.url),
    });
  }
  return out;
}
