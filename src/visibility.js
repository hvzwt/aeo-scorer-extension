// AI visibility tracker: runs buyer prompts through Claude with live web
// search, then measures whether your brand is mentioned and your site cited,
// compared with competitors. Used by the side panel and the scheduled runner.
import Anthropic from "@anthropic-ai/sdk";
import { MODELS } from "./claude.js";

export const VIS_PROJECT = "vis:project";
export const VIS_RUNS = "vis:runs";
const MAX_RUNS = 60;

// Neutral system prompt: Claude must answer like a normal assistant, without
// knowing which brand we are tracking, or the measurement is biased.
const ANSWER_SYSTEM = `You are a helpful assistant answering a user's question. Search the web for current information and answer the way a well-informed assistant would: recommend specific products, companies, tools or sources where the question calls for it, and cite your sources. Keep the answer under 300 words.`;

function searchTool(model) {
  // Dynamic-filtering web search runs on Opus and Sonnet; Haiku uses the basic tool.
  return /haiku/.test(model) ? { type: "web_search_20250305", name: "web_search", max_uses: 5 } : { type: "web_search_20260209", name: "web_search", max_uses: 5 };
}

export const hostOf = (u) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
};

export function cleanDomain(d) {
  return String(d || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
}

const onDomain = (url, domain) => {
  const h = hostOf(url);
  const d = cleanDomain(domain);
  return !!d && (h === d || h.endsWith(`.${d}`));
};

function nameRegex(names) {
  const parts = names
    .map((n) => String(n || "").trim())
    .filter((n) => n.length >= 2)
    .sort((a, b) => b.length - a.length)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!parts.length) return null;
  return new RegExp(`(^|[^\\p{L}\\p{N}])(${parts.join("|")})(?=$|[^\\p{L}\\p{N}])`, "giu");
}

/** One Claude answer with web search. Returns { answer, citations, sources, usage, model }. */
export async function askEngine({ apiKey, model, prompt, signal }) {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 2 });
  const modelId = (MODELS.find((m) => m.id === model) || MODELS[0]).id;
  const messages = [{ role: "user", content: prompt }];
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, web_search_requests: 0 };
  let response;
  for (let i = 0; i < 4; i++) {
    response = await client.messages.create(
      {
        model: modelId,
        max_tokens: 16000,
        system: ANSWER_SYSTEM,
        output_config: { effort: "low" },
        tools: [searchTool(modelId)],
        messages,
      },
      { signal },
    );
    usage.input_tokens += response.usage?.input_tokens || 0;
    usage.output_tokens += response.usage?.output_tokens || 0;
    usage.cache_read_input_tokens += response.usage?.cache_read_input_tokens || 0;
    usage.web_search_requests += response.usage?.server_tool_use?.web_search_requests || 0;
    if (response.stop_reason !== "pause_turn") break;
    messages.splice(1, messages.length - 1, { role: "assistant", content: response.content });
  }
  if (response.stop_reason === "refusal") throw new Error("Claude declined to answer this prompt.");
  let answer = "";
  const citations = [];
  const sources = [];
  for (const block of response.content) {
    if (block.type === "text") {
      answer += block.text;
      for (const c of block.citations || []) {
        if (c.url && !citations.some((x) => x.url === c.url)) citations.push({ url: c.url, title: c.title || "" });
      }
    } else if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
      for (const r of block.content) if (r.url && !sources.includes(r.url)) sources.push(r.url);
    }
  }
  // Inline markdown links also count as citations.
  for (const m of answer.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)) if (!citations.some((x) => x.url === m[1])) citations.push({ url: m[1], title: "" });
  return { answer: answer.trim(), citations, sources, usage, model: response.model };
}

/** Mentions, positions and citations for the brand and each competitor. */
export function analyzeAnswer(project, { answer, citations = [], sources = [] }) {
  const entities = [{ key: "brand", name: project.brand, aliases: project.aliases || [], domain: project.domain }, ...(project.competitors || []).map((c, i) => ({ key: `c${i}`, name: c.name, aliases: c.aliases || [], domain: c.domain }))];
  const firstIndex = {};
  const out = {};
  for (const e of entities) {
    const re = nameRegex([e.name, ...e.aliases, cleanDomain(e.domain)].filter(Boolean));
    let count = 0;
    let first = -1;
    if (re) {
      for (const m of answer.matchAll(re)) {
        count++;
        if (first < 0) first = m.index;
      }
    }
    const cited = citations.filter((c) => onDomain(c.url, e.domain)).map((c) => c.url);
    const inSources = sources.filter((u) => onDomain(u, e.domain));
    // A citation of the site counts as a mention even if the name is not written out.
    const mentioned = count > 0 || cited.length > 0;
    if (mentioned) firstIndex[e.key] = first >= 0 ? first : answer.length;
    out[e.key] = { name: e.name, mentioned, count, cited, inSources };
  }
  const order = Object.entries(firstIndex)
    .sort((a, b) => a[1] - b[1])
    .map(([k]) => k);
  for (const [k, v] of Object.entries(out)) v.position = v.mentioned ? order.indexOf(k) + 1 : null;
  return out;
}

const SENTIMENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["sentiment", "reason"],
  properties: { sentiment: { type: "string", enum: ["positive", "neutral", "negative"] }, reason: { type: "string" } },
};

/** How the answer talks about the brand (cheap model). */
export async function judgeSentiment({ apiKey, brand, answer, signal }) {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 2 });
  const res = await client.messages.create(
    {
      model: "claude-haiku-5-5",
      max_tokens: 1000,
      output_config: { effort: "low", format: { type: "json_schema", schema: SENTIMENT_SCHEMA } },
      messages: [{ role: "user", content: `<answer>\n${answer.slice(0, 6000)}\n</answer>\n\nHow does this answer portray "${brand}"? positive = recommended or praised, negative = criticised or warned against, neutral = listed or described without judgement. Give a one-sentence reason.` }],
    },
    { signal },
  );
  const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  try {
    return { ...JSON.parse(text), usage: res.usage };
  } catch {
    return { sentiment: "neutral", reason: "", usage: res.usage };
  }
}

const PROMPTS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["prompts"],
  properties: {
    prompts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "intent"],
        properties: { text: { type: "string" }, intent: { type: "string", enum: ["informational", "comparison", "recommendation", "how-to", "brand"] } },
      },
    },
  },
};

/** Claude proposes buyer prompts from what the site is about. */
export async function suggestPrompts({ apiKey, model, project, siteContext, signal }) {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 2 });
  const res = await client.messages.create(
    {
      model: (MODELS.find((m) => m.id === model) || MODELS[0]).id,
      max_tokens: 8000,
      output_config: { effort: "low", format: { type: "json_schema", schema: PROMPTS_SCHEMA } },
      messages: [
        {
          role: "user",
          content: `Brand: ${project.brand}\nWebsite: ${project.domain}\nCompetitors: ${(project.competitors || []).map((c) => c.name).join(", ") || "unknown"}\n\n<site_context>\n${(siteContext || "").slice(0, 12000)}\n</site_context>\n\nWrite 15 realistic prompts that this brand's potential customers would type into ChatGPT, Perplexity or Google AI Mode while researching the problem this brand solves. Mix intents: mostly non-branded questions (recommendation, comparison, how-to, informational), plus 2–3 brand questions. Do not include the brand name in non-branded prompts. Write them in the site's language, the way people actually ask.`,
        },
      ],
    },
    { signal },
  );
  const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  return JSON.parse(text).prompts;
}

/** Aggregate one run (or any list of results) into tracker metrics. */
export function runMetrics(project, results) {
  const ok = results.filter((r) => !r.error && r.analysis);
  const n = ok.length;
  const entities = [{ key: "brand", name: project.brand, domain: project.domain }, ...(project.competitors || []).map((c, i) => ({ key: `c${i}`, name: c.name, domain: c.domain }))];
  const per = {};
  let totalMentions = 0;
  for (const e of entities) {
    const rows = ok.map((r) => r.analysis[e.key]).filter(Boolean);
    const mentioned = rows.filter((x) => x.mentioned);
    const positions = mentioned.map((x) => x.position).filter(Boolean);
    per[e.key] = {
      name: e.name,
      domain: e.domain,
      mentions: mentioned.length,
      mentionRate: n ? Math.round((mentioned.length / n) * 100) : 0,
      citations: rows.filter((x) => x.cited.length).length,
      citationRate: n ? Math.round((rows.filter((x) => x.cited.length).length / n) * 100) : 0,
      avgPosition: positions.length ? +(positions.reduce((a, b) => a + b, 0) / positions.length).toFixed(1) : null,
    };
    totalMentions += mentioned.length;
  }
  for (const v of Object.values(per)) v.shareOfVoice = totalMentions ? Math.round((v.mentions / totalMentions) * 100) : 0;
  const sentiments = { positive: 0, neutral: 0, negative: 0 };
  for (const r of ok) if (r.sentiment?.sentiment && r.analysis.brand?.mentioned) sentiments[r.sentiment.sentiment]++;
  const domains = new Map();
  for (const r of ok) for (const c of r.citations || []) domains.set(hostOf(c.url), (domains.get(hostOf(c.url)) || 0) + 1);
  const topDomains = [...domains.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([domain, count]) => ({ domain, count, yours: onDomain(`https://${domain}`, project.domain), competitor: (project.competitors || []).find((c) => onDomain(`https://${domain}`, c.domain))?.name || null }));
  const gaps = ok.filter((r) => !r.analysis.brand?.mentioned && Object.entries(r.analysis).some(([k, v]) => k !== "brand" && v.mentioned));
  return { prompts: n, errors: results.length - n, entities: per, brand: per.brand, sentiments, topDomains, gaps: gaps.map((g) => g.promptId) };
}

/** Run every prompt once. onResult is called as each finishes. */
export async function runTracker({ apiKey, model, project, onProgress, signal }) {
  const results = [];
  const prompts = project.prompts || [];
  let cost = { input: 0, output: 0, searches: 0, haikuIn: 0, haikuOut: 0 };
  for (let i = 0; i < prompts.length; i++) {
    if (signal?.aborted) break;
    const p = prompts[i];
    onProgress?.({ done: i, total: prompts.length, prompt: p.text });
    try {
      const a = await askEngine({ apiKey, model, prompt: p.text, signal });
      const analysis = analyzeAnswer(project, a);
      let sentiment = null;
      if (analysis.brand.mentioned) {
        try {
          const s = await judgeSentiment({ apiKey, brand: project.brand, answer: a.answer, signal });
          sentiment = { sentiment: s.sentiment, reason: s.reason };
          cost.haikuIn += s.usage?.input_tokens || 0;
          cost.haikuOut += s.usage?.output_tokens || 0;
        } catch {}
      }
      cost.input += a.usage.input_tokens;
      cost.output += a.usage.output_tokens;
      cost.searches += a.usage.web_search_requests;
      results.push({ promptId: p.id, prompt: p.text, engine: "claude", answer: a.answer, citations: a.citations, sources: a.sources.slice(0, 20), analysis, sentiment, model: a.model, at: Date.now() });
    } catch (e) {
      if (signal?.aborted) break;
      results.push({ promptId: p.id, prompt: p.text, engine: "claude", error: String(e?.message || e), at: Date.now() });
    }
  }
  onProgress?.({ done: results.length, total: prompts.length });
  return { results, cost: estimateRunCost(model, cost) };
}

const PRICES = { "claude-opus-5-5": [4, 20], "claude-sonnet-5-5": [2, 10], "claude-haiku-5-5": [0.1, 0.5] };
function estimateRunCost(model, c) {
  const [pin, pout] = PRICES[model] || PRICES["claude-opus-5-5"];
  // Web search is billed per search ($10 per 1,000 searches) on top of tokens.
  return (c.input * pin + c.output * pout + c.haikuIn * 0.1 + c.haikuOut * 0.5) / 1e6 + c.searches * 0.01;
}

/** Turn a manual capture from an AI app tab into a result. */
export function captureToResult(project, { promptId, prompt, engine, text, links, url }) {
  const citations = (links || []).map((l) => ({ url: l.href, title: l.text || "" }));
  const answer = String(text || "");
  return { promptId, prompt, engine, answer, citations, sources: [], analysis: analyzeAnswer(project, { answer, citations }), sentiment: null, captured: true, pageUrl: url, at: Date.now() };
}

export async function loadVis() {
  const got = await chrome.storage.local.get([VIS_PROJECT, VIS_RUNS]);
  return { project: got[VIS_PROJECT] || null, runs: got[VIS_RUNS] || [] };
}

export async function saveRun(run) {
  const { runs } = await loadVis();
  runs.push(run);
  // keep full answers for the latest 15 runs, metrics only for older ones
  const trimmed = runs.slice(-MAX_RUNS).map((r, i, a) => (i < a.length - 15 ? { ...r, results: r.results.map(({ answer, sources, ...rest }) => rest) } : r));
  await chrome.storage.local.set({ [VIS_RUNS]: trimmed });
  return trimmed;
}
