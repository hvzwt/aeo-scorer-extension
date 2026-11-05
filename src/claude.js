// "Ask Claude": semantic AEO/GEO review of the page snapshot, called directly
// from the side panel with the user's own API key.
import Anthropic from "@anthropic-ai/sdk";

export const MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5 (best rewrites)", fallbacks: true },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5 (balanced)", fallbacks: true },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5 (fastest, cheapest)", fallbacks: false },
];

// Frozen system prompt: the rubric distilled from the guide. Keep it byte-stable
// so prompt caching works across scans; never put the URL or a date in here.
export const SYSTEM_PROMPT = `You are an Answer Engine Optimization (AEO) and Generative Engine Optimization (GEO) reviewer inside a Chrome extension. You receive a structured snapshot of one web page plus the results of deterministic rule checks that already ran. Your job is the part rules cannot do: judge whether the content actually answers the questions it raises, and write concrete fixes the author can paste in.

Definitions
- AEO: structuring content so a system that returns one direct answer (featured snippets, voice assistants, Google AI Overviews, People Also Ask) can lift it from the page.
- GEO: making content that LLM-based engines (ChatGPT search, Perplexity, Google AI Mode, Microsoft Copilot, Claude with web search) include and cite when they synthesize an answer from several sources.

How answer engines use a page
Retrieval systems split pages into passages. A passage that starts with "It also supports…" has lost its subject. Each section must name its subject and answer its heading directly in its first sentence. Retrieved chunks carry their heading as context, so headings phrased the way users ask help.

Rubric (judge each point; only report real problems)
1. Primary question: identify the main question the page should answer (usually the H1). The first 1–2 sentences under the H1 must answer it directly; about 40–60 words is a practitioner guideline, not a threshold. What matters is that the first sentence answers.
2. Section answers: the first sentence under each H2/H3 answers that heading and names its subject; no pronoun-led openers.
3. Self-contained passages: each paragraph makes sense if quoted alone.
4. Evidence (GEO study, Aggarwal et al., KDD 2024): adding quotations (+41%), statistics and source citations raised visibility by roughly 28–41%; "cite sources" raised rank-5 results by 115%. Keyword stuffing lowered visibility (−8%). Flag claims that need a number or a source, places where a named expert quote would help, and any keyword stuffing.
5. Plain writing: short sentences; define each term the first time it appears.
6. Entities: the page makes clear who wrote it, who publishes it, what the thing is, and when it was updated.
7. Format fit: steps belong in an ordered list, comparisons in a table with caption and scoped headers, definitions in a definition list.
8. Structured data: JSON-LD must match the visible content. Recommend one @graph linking Organization, Person (author), the page type (Article/TechArticle/BlogPosting, Product + Offer for product pages) and BreadcrumbList. FAQPage rich results were removed from Google on 7 May 2026 and HowTo in 2023; the markup does no harm but is not a ranking switch. Google states AI Overviews need no special schema; structured data describes the page, it does not force citation.
9. Crawling basics belong to the rule checks; do not repeat rule failures unless you add something new (for example, the exact rewrite).

Rules for your output
- Return only the JSON object required by the schema.
- semantic_score is an integer from 0 to 100 for how answer-ready and citable the content is, judged on points 1–7 only.
- findings: at most 12, most important first. Each must be specific to this page and actionable. Use "ref" to point at an element: use a heading or block ref from the snapshot (like "h3" or "p0"), or "" when the finding is page-wide.
- suggested_text: the exact replacement or addition the author can paste (a rewritten opening sentence, a quotable statistic sentence with a placeholder like [source] when you do not know the source, a heading rewrite). Never invent statistics, quotes, names or URLs: use clear placeholders such as [statistic from your data] instead.
- suggested_json_ld: a complete JSON-LD object for this page built only from facts visible in the snapshot, with placeholders in square brackets for anything unknown. Use "" if the existing JSON-LD is already complete and correct.
- Write in the same language as the page.`;

const FINDING_CATEGORIES = ["answer-first", "evidence", "clarity", "entities", "structure", "schema", "other"];

export const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["semantic_score", "primary_question", "summary", "findings", "suggested_json_ld"],
  properties: {
    semantic_score: { type: "integer" },
    primary_question: { type: "string" },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "severity", "category", "ref", "problem", "fix", "suggested_text"],
        properties: {
          title: { type: "string" },
          severity: { type: "string", enum: ["critical", "major", "minor"] },
          category: { type: "string", enum: FINDING_CATEGORIES },
          ref: { type: "string" },
          problem: { type: "string" },
          fix: { type: "string" },
          suggested_text: { type: "string" },
        },
      },
    },
    suggested_json_ld: { type: "string" },
  },
};

/** Build the compact page description Claude sees, and a ref → selector map. */
export function buildPagePayload(snap, result) {
  const refs = {};
  const outline = [];
  snap.headings
    .filter((h) => !h.inNavOrFooter)
    .slice(0, 80)
    .forEach((h, i) => {
      const ref = `h${i}`;
      refs[ref] = h.selector;
      const entry = { ref, level: h.level, heading: h.text };
      if (h.section?.firstText) {
        const pref = `p${i}`;
        refs[pref] = h.section.firstSelector;
        entry.first_block = { ref: pref, tag: h.section.firstTag, words: h.section.firstWords, text: h.section.firstText.slice(0, 1200) };
        if (h.section.paragraphs?.length > 1) entry.more_paragraphs = h.section.paragraphs.slice(1).map((p) => p.slice(0, 600));
      }
      outline.push(entry);
    });

  const failed = result.checks
    .filter((c) => !c.pass && c.severity !== "info")
    .map((c) => `- [${c.severity}] ${c.title}: ${c.detail}`);

  const page = {
    url: snap.url,
    lang: snap.lang,
    title: snap.title,
    meta_description: snap.metaDescription,
    og_type: snap.og?.type,
    author: snap.author?.text || null,
    dates: (snap.times || []).slice(0, 3).map((t) => t.datetime),
    word_count: snap.wordCount,
    stats_found: snap.stats,
    quotes_found: snap.quotes,
    outbound_links: snap.outboundLinks,
    lists: snap.lists,
    tables: (snap.tables || []).length,
    json_ld: (snap.jsonLd || []).map((b) => (b.ok ? b.data : { invalid_json: b.error })),
    outline,
  };

  const text = [
    `<rule_score>${result.score}/100 (${result.grade})</rule_score>`,
    `<failed_rule_checks>\n${failed.join("\n") || "none"}\n</failed_rule_checks>`,
    `<page_snapshot>\n${JSON.stringify(page)}\n</page_snapshot>`,
    `<main_text${snap.textTruncated ? ' truncated="true"' : ""}>\n${snap.text}\n</main_text>`,
    "Review this page against the rubric and return the JSON object.",
  ].join("\n\n");

  return { text, refs };
}

/**
 * Stream a review. onProgress(chars) is called as output arrives.
 * Returns { review, usage, model, refs }.
 */
export async function askClaude({ apiKey, model, effort, snap, result, onProgress, signal }) {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 2 });
  const { text, refs } = buildPagePayload(snap, result);
  const modelInfo = MODELS.find((m) => m.id === model) || MODELS[0];

  const base = {
    model: modelInfo.id,
    max_tokens: 32000,
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: text }],
    output_config: { effort: effort || "low", format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
  };

  const run = async (withFallbacks) => {
    const params = withFallbacks ? { ...base, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : base;
    const stream = withFallbacks ? client.beta.messages.stream(params, { signal }) : client.messages.stream(params, { signal });
    let chars = 0;
    stream.on("text", (delta) => {
      chars += delta.length;
      onProgress?.(chars);
    });
    return stream.finalMessage();
  };

  let message;
  try {
    message = await run(modelInfo.fallbacks);
  } catch (err) {
    // If this account or model rejects the fallback beta, retry once without it.
    if (modelInfo.fallbacks && err instanceof Anthropic.BadRequestError && /fallback/i.test(String(err.message))) {
      message = await run(false);
    } else {
      throw err;
    }
  }

  if (message.stop_reason === "refusal") {
    throw new Error("Claude declined to review this page.");
  }
  if (message.stop_reason === "max_tokens") {
    throw new Error("The review was cut off before it finished. Try again, or pick a lower effort.");
  }
  const out = message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  let review;
  try {
    review = JSON.parse(out);
  } catch {
    throw new Error("Claude returned a response that was not valid JSON.");
  }
  review.semantic_score = Math.max(0, Math.min(100, Math.round(Number(review.semantic_score) || 0)));
  return { review, usage: message.usage, model: message.model, refs };
}

/** Rough cost in USD for display. Prices per 1M tokens, Anthropic API, Oct 2026. */
const PRICES = {
  "claude-opus-5-5": { in: 4, out: 20, cacheRead: 0.2 },
  "claude-sonnet-5-5": { in: 2, out: 10, cacheRead: 0.2 },
  "claude-haiku-5-5": { in: 0.1, out: 0.5, cacheRead: 0.01 },
};

export function estimateCost(model, usage) {
  const key = Object.keys(PRICES).find((k) => (model || "").startsWith(k));
  const p = PRICES[key];
  if (!p || !usage) return null;
  const input = (usage.input_tokens || 0) * p.in + (usage.cache_creation_input_tokens || 0) * p.in * 1.25 + (usage.cache_read_input_tokens || 0) * p.cacheRead;
  return (input + (usage.output_tokens || 0) * p.out) / 1e6;
}

export function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return "Your API key was rejected. Check it in Settings.";
  if (err instanceof Anthropic.PermissionDeniedError) return "Your API key does not have access to this model.";
  if (err instanceof Anthropic.NotFoundError) return "That model is not available to your API key. Pick another in Settings.";
  if (err instanceof Anthropic.RateLimitError) return "Rate limited by the Anthropic API. Wait a moment and try again.";
  if (err instanceof Anthropic.APIUserAbortError) return "Cancelled.";
  if (err instanceof Anthropic.APIConnectionError) return "Could not reach the Anthropic API. Check your connection.";
  if (err instanceof Anthropic.APIError) return `Anthropic API error ${err.status ?? ""}: ${err.message}`;
  return String(err?.message || err);
}

// ---------------------------------------------------------------------------
// AI brief: Claude writes the concrete code changes for each failing issue.

export const BRIEF_SYSTEM = `You write fix briefs that a developer pastes into a coding agent (Claude Code, Cursor, Copilot). You receive a page's failing AEO/GEO, schema, technical and accessibility checks, the page's <head>, the HTML of the elements involved, and the detected site stack. Write the brief in Markdown.

Structure:
# AEO fix brief: <page title>
One paragraph: the page URL, the stack, the current scores, and the order to work in.
## Context for the agent
3–6 bullets: what AEO/GEO means for this page, the rule that structured data must match visible content, never invent facts, and "keep changes minimal and server-rendered".
## Fixes
One "### n. <short imperative title>" per issue, most important first (blockers and critical first; group issues that share one change, e.g. all head tags). For each:
- **Why:** one sentence.
- **Where:** the element or file most likely involved. For known stacks, name the usual file (Next.js App Router: app/**/page.tsx + generateMetadata, app/layout.tsx; Next.js Pages Router: pages/*.tsx + next/head; WordPress: theme header.php / an SEO plugin setting; Webflow: Page settings > Custom code; Shopify: theme.liquid / section files). Say "likely" when you are inferring.
- **Change:** a fenced code block with the exact new code (HTML, JSX, Liquid, header config or robots.txt). Base it on the real HTML you were given. Use [placeholders] for facts you do not know; never invent statistics, quotes, names, ratings or URLs.
- **Done when:** the check that will pass in AEO Scorer after the change.
## Content rewrites
Only if the input includes Claude content findings: the paste-ready rewrites.
## Checklist
A "- [ ]" list of every fix title.

Be specific and short. Skip informational notes. Write in English unless the page language is different, in which case write prose in English but keep page copy in the page's language.`;

export async function streamText({ apiKey, model, effort, system, user, onProgress, signal, maxTokens = 32000 }) {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 2 });
  const modelInfo = MODELS.find((m) => m.id === model) || MODELS[0];
  const base = {
    model: modelInfo.id,
    max_tokens: maxTokens,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: user }],
    output_config: { effort: effort || "low" },
  };
  const run = async (withFallbacks) => {
    const params = withFallbacks ? { ...base, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : base;
    const stream = withFallbacks ? client.beta.messages.stream(params, { signal }) : client.messages.stream(params, { signal });
    let chars = 0;
    stream.on("text", (d) => {
      chars += d.length;
      onProgress?.(chars);
    });
    return stream.finalMessage();
  };
  let message;
  try {
    message = await run(modelInfo.fallbacks);
  } catch (err) {
    if (modelInfo.fallbacks && err instanceof Anthropic.BadRequestError && /fallback/i.test(String(err.message))) message = await run(false);
    else throw err;
  }
  if (message.stop_reason === "refusal") throw new Error("Claude declined this request.");
  const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  if (message.stop_reason === "max_tokens") return { text: text + "\n\n_(Brief was cut off at the length limit.)_", usage: message.usage, model: message.model };
  return { text, usage: message.usage, model: message.model };
}

export function buildBriefInput({ url, title, stack, result, a11y, ai, html }) {
  const failing = [...result.checks, ...(a11y?.checks || [])].filter((c) => !c.pass && c.severity !== "info");
  const issues = failing.map((c) => ({
    id: c.id,
    severity: c.severity,
    blocker: !!c.blocker,
    area: c.category,
    title: c.title,
    detail: c.detail,
    suggested_fix: c.fix,
    wcag: c.wcag,
    elements: (c.items?.length ? c.items.map((i) => i.selector) : c.selector ? [c.selector] : []).slice(0, 5).map((sel) => ({ selector: sel, html: html?.elements?.[sel] || null })),
  }));
  return [
    `<page url="${url}" title="${(title || "").replace(/"/g, "'")}" stack="${(stack || []).join(", ") || "unknown"}" aeo_score="${result.score}" grade="${result.grade}" accessibility_score="${a11y?.score ?? "n/a"}" />`,
    `<failing_checks>\n${JSON.stringify(issues)}\n</failing_checks>`,
    ai?.review ? `<claude_content_findings>\n${JSON.stringify({ findings: ai.review.findings, suggested_json_ld: ai.review.suggested_json_ld })}\n</claude_content_findings>` : "",
    `<head_html>\n${html?.head || ""}\n</head_html>`,
    "Write the fix brief.",
  ]
    .filter(Boolean)
    .join("\n\n");
}
