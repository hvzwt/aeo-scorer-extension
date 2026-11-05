// Deterministic AEO / GEO rules, based on "AEO & GEO: A Developer's
// Implementation Guide" (Nov 2026). Pure functions: no DOM or chrome APIs, so
// the same code runs in the side panel and in Node tests.

export const CATEGORIES = {
  access: { label: "Crawler access", weight: 25 },
  head: { label: "Head & meta tags", weight: 15 },
  structure: { label: "Page structure", weight: 20 },
  answers: { label: "Answer-first content", weight: 20 },
  schema: { label: "Structured data", weight: 10 },
  trust: { label: "Trust & evidence", weight: 10 },
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
  const score = Math.round(Object.values(categories).reduce((s, c) => s + c.score * c.weight, 0) / wsum);
  return { score, grade: grade(score), categories, checks };
}

export function grade(score) {
  if (score >= 90) return "Excellent";
  if (score >= 75) return "Good";
  if (score >= 55) return "Needs work";
  return "Poor";
}

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
