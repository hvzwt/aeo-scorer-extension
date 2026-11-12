// Competitor analysis: find the pages AI answers cite for your questions,
// score them with the same rules, and explain why they rank higher.
import Anthropic from "@anthropic-ai/sdk";
import { MODELS } from "./claude.js";
import { askEngine, hostOf, cleanDomain } from "./visibility.js";
import { CATEGORIES } from "./rules.js";

export const COMP_KEY = (domain) => `comp:${domain}`;
const SEV = { critical: 10, major: 5, minor: 2, info: 0 };
const sameSite = (url, domain) => {
  const h = hostOf(url);
  const d = cleanDomain(domain);
  return !!d && (h === d || h.endsWith(`.${d}`));
};
// Skip pages that are not competitors: search engines, social, video and the AI apps themselves.
const NOT_COMPETITOR = /(^|\.)(google\.[a-z.]+|bing\.com|youtube\.com|youtu\.be|facebook\.com|instagram\.com|x\.com|twitter\.com|linkedin\.com|tiktok\.com|pinterest\.com|chatgpt\.com|openai\.com|perplexity\.ai|wikipedia\.org|wikimedia\.org)$/;

/** A question to start from, taken from the page itself. */
export function questionFromPage(snap, ai) {
  if (ai?.review?.primary_question) return ai.review.primary_question;
  const h1 = snap?.headings?.find((h) => h.level === 1)?.text;
  return (h1 || snap?.title || "").replace(/\s*[|–-]\s*[^|–-]+$/, "").trim();
}

/**
 * Ask each question with web search and rank the pages AI cites.
 * Returns { answers, candidates: [{url, host, cited, mentionedIn, sourcedIn, firstRank, questions}] }
 */
export async function discoverFromAI({ apiKey, model, questions, yourDomain, signal, onProgress }) {
  const answers = [];
  const byUrl = new Map();
  const bump = (url, field, q, rank) => {
    const key = url.split("#")[0];
    if (sameSite(key, yourDomain) || NOT_COMPETITOR.test(hostOf(key))) return;
    const c = byUrl.get(key) || { url: key, host: hostOf(key), cited: 0, sourcedIn: 0, questions: new Set(), firstRank: 99 };
    c[field]++;
    c.questions.add(q);
    c.firstRank = Math.min(c.firstRank, rank);
    byUrl.set(key, c);
  };
  for (let i = 0; i < questions.length; i++) {
    if (signal?.aborted) break;
    onProgress?.({ step: "ask", done: i, total: questions.length, text: questions[i] });
    try {
      const a = await askEngine({ apiKey, model, prompt: questions[i], signal });
      const youCited = a.citations.some((c) => sameSite(c.url, yourDomain));
      answers.push({ question: questions[i], answer: a.answer, citations: a.citations, youCited, usage: a.usage });
      a.citations.forEach((c, r) => bump(c.url, "cited", questions[i], r + 1));
      a.sources.forEach((u, r) => bump(u, "sourcedIn", questions[i], 20 + r));
    } catch (e) {
      if (signal?.aborted) break;
      answers.push({ question: questions[i], error: String(e?.message || e) });
    }
  }
  const candidates = [...byUrl.values()].map((c) => ({ ...c, questions: [...c.questions] })).sort((a, b) => b.cited - a.cited || b.questions.length - a.questions.length || a.firstRank - b.firstRank);
  return { answers, candidates };
}

/** Candidates from earlier tracker runs and captures, when there is no API key. */
export function candidatesFromTracker(runs, captures, yourDomain) {
  const byUrl = new Map();
  const results = [...(runs.at(-1)?.results || []), ...Object.values(captures || {})];
  for (const r of results) {
    (r.citations || []).forEach((c, i) => {
      const key = c.url.split("#")[0];
      if (sameSite(key, yourDomain) || NOT_COMPETITOR.test(hostOf(key))) return;
      const e = byUrl.get(key) || { url: key, host: hostOf(key), cited: 0, sourcedIn: 0, questions: new Set(), firstRank: 99 };
      e.cited++;
      e.questions.add(r.prompt);
      e.firstRank = Math.min(e.firstRank, i + 1);
      byUrl.set(key, e);
    });
  }
  return [...byUrl.values()].map((c) => ({ ...c, questions: [...c.questions] })).sort((a, b) => b.cited - a.cited);
}

/** Keep one page per site, so the comparison is across competitors, not one site's pages. */
export function pickCompetitors(candidates, manual, max) {
  const out = [];
  const hosts = new Set();
  for (const u of manual) {
    const h = hostOf(u);
    if (!h || hosts.has(h)) continue;
    hosts.add(h);
    out.push({ url: u, host: h, cited: 0, sourcedIn: 0, questions: [], manual: true });
  }
  for (const c of candidates) {
    if (out.length >= max + manual.length) break;
    if (hosts.has(c.host)) continue;
    hosts.add(c.host);
    out.push(c);
  }
  return out;
}

/** Content facts that explain AI citations, from a page snapshot. */
export function pageFacts(snap, result) {
  const types = new Set();
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(walk);
    const t = n["@type"];
    (Array.isArray(t) ? t : t ? [t] : []).forEach((x) => types.add(String(x)));
    if (n["@graph"]) walk(n["@graph"]);
    for (const v of Object.values(n)) if (v && typeof v === "object") walk(v);
  };
  for (const j of snap.jsonLd || []) if (j.ok) walk(j.data);
  const dates = [snap.og?.modified, ...(snap.times || []).map((t) => t.datetime || t.text)].filter(Boolean).map((d) => Date.parse(d)).filter((d) => !Number.isNaN(d) && d < Date.now() + 864e5);
  const newest = dates.length ? Math.max(...dates) : null;
  const h = snap.headings || [];
  return {
    words: snap.wordCount || 0,
    questionHeadings: h.filter((x) => x.level > 1 && /\?\s*$/.test(x.text)).length,
    subheadings: h.filter((x) => x.level === 2 || x.level === 3).length,
    stats: snap.stats || 0,
    outboundLinks: snap.outboundLinks || 0,
    quotes: (snap.quotes || 0) + (snap.cites || 0),
    tables: (snap.tables || []).length,
    lists: (snap.lists?.ol || 0) + (snap.lists?.ul || 0),
    faqQuestions: snap.faq?.questions?.length || 0,
    author: !!snap.author,
    updatedDaysAgo: newest ? Math.max(0, Math.round((Date.now() - newest) / 864e5)) : null,
    schemaTypes: [...types].slice(0, 12),
    directAnswer: result.checks.find((c) => c.id === "direct-answer-h1")?.pass ?? null,
  };
}

export const FACTS = [
  { key: "words", label: "Words", better: "more" },
  { key: "subheadings", label: "H2/H3 sections", better: "more" },
  { key: "questionHeadings", label: "Question headings", better: "more" },
  { key: "faqQuestions", label: "FAQ questions", better: "more" },
  { key: "stats", label: "Statistics", better: "more" },
  { key: "outboundLinks", label: "Links to sources", better: "more" },
  { key: "quotes", label: "Quotes and citations", better: "more" },
  { key: "tables", label: "Tables", better: "more" },
  { key: "lists", label: "Lists", better: "more" },
  { key: "updatedDaysAgo", label: "Days since update", better: "less" },
];

const median = (xs) => {
  const s = xs.filter((x) => x != null).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
const genericId = (id) => id.replace(/:.*$/, "");
// How much each rule area tends to matter for being cited, used only to order the reasons.
const AREA_WEIGHT = { answers: 1.5, schema: 1.3, trust: 1.25, structure: 1.1, access: 1, head: 0.8, tech: 0.6 };

/** Everything the comparison view shows. you/competitors: { url, score, categories, checks, facts, a11yScore } */
export function compare(you, competitors) {
  const ok = competitors.filter((c) => !c.error);
  const n = ok.length;
  // per-page pass/fail for generic check ids (answer-first:<hash> → answer-first)
  const status = (page) => {
    const m = new Map();
    for (const c of page.checks) {
      const id = genericId(c.id);
      if (c.severity === "info") continue;
      const prev = m.get(id);
      m.set(id, { id, title: c.id.includes(":") ? "Answer-first under each section heading" : c.title, severity: prev && SEV[prev.severity] > SEV[c.severity] ? prev.severity : c.severity, category: c.category, fix: c.fix, pass: (prev ? prev.pass : true) && c.pass });
    }
    return m;
  };
  const yours = status(you);
  const theirs = ok.map((c) => ({ c, s: status(c) }));

  // Checks most competitors pass and you fail: the reasons they win on our rules.
  const reasons = [];
  const strengths = [];
  for (const [id, mine] of yours) {
    const passers = theirs.filter(({ s }) => s.get(id)?.pass).map(({ c }) => c.host);
    const judged = theirs.filter(({ s }) => s.has(id)).length;
    if (!judged) continue;
    if (!mine.pass && passers.length) reasons.push({ ...mine, passers, judged, weight: (passers.length / judged) * SEV[mine.severity] * (AREA_WEIGHT[mine.category] || 1) });
    if (mine.pass && passers.length < judged / 2) strengths.push({ ...mine, failers: judged - passers.length, judged });
  }
  reasons.sort((a, b) => b.weight - a.weight);
  strengths.sort((a, b) => SEV[b.severity] - SEV[a.severity] || b.failers - a.failers);

  const categories = Object.keys(CATEGORIES).map((key) => {
    const vals = ok.map((c) => c.categories?.[key]?.score).filter((x) => x != null);
    return { key, label: CATEGORIES[key].label, you: you.categories?.[key]?.score ?? null, median: median(vals), best: vals.length ? Math.max(...vals) : null };
  });

  const facts = FACTS.map((f) => {
    const med = median(ok.map((c) => c.facts?.[f.key]));
    const mine = you.facts?.[f.key];
    const behind = med != null && mine != null && (f.better === "more" ? mine < med * 0.6 : mine > med * 1.5 && mine - med > 30);
    return { ...f, you: mine, median: med, behind };
  });

  const schemaCount = new Map();
  for (const c of ok) for (const t of new Set(c.facts?.schemaTypes || [])) schemaCount.set(t, (schemaCount.get(t) || 0) + 1);
  const mySchema = new Set(you.facts?.schemaTypes || []);
  const schemaGaps = [...schemaCount.entries()].filter(([t, k]) => !mySchema.has(t) && k >= Math.max(1, Math.ceil(n / 3)) && !/^(WebPage|WebSite|ImageObject|ListItem|SiteNavigationElement|EntryPoint|SearchAction|ReadAction|Thing)$/.test(t)).sort((a, b) => b[1] - a[1]).map(([type, count]) => ({ type, count }));

  const ahead = ok.filter((c) => c.score > you.score).length;
  const citedAhead = ok.filter((c) => c.cited > 0).length;
  return { n, ahead, citedAhead, reasons: reasons.slice(0, 15), strengths: strengths.slice(0, 6), categories, facts, schemaGaps, medianScore: median(ok.map((c) => c.score)) };
}

// ---------------------------------------------------------------- Claude

const WHY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "reasons", "plan"],
  properties: {
    summary: { type: "string" },
    reasons: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "evidence", "competitors", "impact"],
        properties: { title: { type: "string" }, evidence: { type: "string" }, competitors: { type: "array", items: { type: "string" } }, impact: { type: "string", enum: ["high", "medium", "low"] } },
      },
    },
    plan: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["action", "detail", "effort"],
        properties: { action: { type: "string" }, detail: { type: "string" }, effort: { type: "string", enum: ["small", "medium", "large"] } },
      },
    },
  },
};

const WHY_SYSTEM = `You are an AEO and GEO strategist. You compare one page with the competitor pages that AI assistants (ChatGPT, Perplexity, Google AI Overviews, Claude) cite for the same questions, and explain why the competitors are cited and ranked higher. Base every reason on the evidence given: rule-check results, content facts, schema types, AI citations and the text excerpts. Name the competitors each reason applies to. Do not invent numbers. Then write an ordered action plan for the page owner, most impactful first, specific enough to act on (what to add, where, in what form). Keep the summary to 2–3 sentences.`;

function excerpt(text, n = 1800) {
  return String(text || "").replace(/\s+/g, " ").slice(0, n);
}

export function buildWhyInput({ questions, you, competitors, cmp, answers }) {
  const page = (p, label) =>
    `<page label="${label}" url="${p.url}" aeo_score="${p.score}" ai_citations="${p.cited ?? 0}" cited_for="${(p.questions || []).join(" | ")}">\nTitle: ${p.title}\nFacts: ${JSON.stringify(p.facts)}\nCategory scores: ${Object.entries(p.categories || {}).map(([k, v]) => `${k} ${v.score}`).join(", ")}\nOpening text: ${excerpt(p.excerpt)}\n</page>`;
  return [
    `<questions>\n${questions.join("\n")}\n</questions>`,
    answers?.length ? `<ai_answers>\n${answers.filter((a) => !a.error).map((a) => `Q: ${a.question}\nYour site cited: ${a.youCited ? "yes" : "no"}\nCited: ${a.citations.map((c) => c.url).slice(0, 8).join(", ")}\nAnswer: ${excerpt(a.answer, 900)}`).join("\n\n")}\n</ai_answers>` : "",
    page(you, "yours"),
    ...competitors.filter((c) => !c.error).map((c, i) => page(c, `competitor ${i + 1}`)),
    `<rule_gaps>\n${cmp.reasons.map((r) => `- ${r.title} (${r.severity}): ${r.passers.length}/${r.judged} competitors pass, you fail`).join("\n")}\n</rule_gaps>`,
    `<schema_gaps>${cmp.schemaGaps.map((s) => `${s.type} (${s.count} competitors)`).join(", ") || "none"}</schema_gaps>`,
    `<content_gaps>\n${cmp.facts.map((f) => `${f.label}: you ${f.you ?? "–"}, competitor median ${f.median ?? "–"}`).join("\n")}\n</content_gaps>`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export async function explainWhy({ apiKey, model, effort, input, signal }) {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 2 });
  const res = await client.messages
    .stream(
      {
        model: (MODELS.find((m) => m.id === model) || MODELS[0]).id,
        max_tokens: 16000,
        system: WHY_SYSTEM,
        output_config: { effort: effort || "low", format: { type: "json_schema", schema: WHY_SCHEMA } },
        messages: [{ role: "user", content: input }],
      },
      { signal },
    )
    .finalMessage();
  const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  return { why: JSON.parse(text), usage: res.usage, model: res.model };
}
