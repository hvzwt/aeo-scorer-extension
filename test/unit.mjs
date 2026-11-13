// Unit checks for the rules added in 0.7: Core Web Vitals, llms.txt format,
// Twitter card, brand consistency, extra bots, and PageSpeed parsing.
import assert from "node:assert/strict";
import { scorePage } from "../src/rules.js";
import { pageSpeed } from "../src/tech.js";

const snap = {
  url: "https://acme.test/guide", host: "acme.test", lang: "en", title: "Guide | Acme", metaDescription: "A guide.", canonical: "https://acme.test/guide",
  robotsMeta: null, og: { title: "Guide", type: "article", siteName: "Acme" }, hreflang: [], landmarks: { main: 1 }, headings: [{ level: 1, text: "Guide", selector: "h1" }],
  jsonLd: [{ ok: true, data: { "@context": "https://schema.org", "@type": "Organization", name: "Acme Inc", url: "https://acme.test" } }],
  images: [], genericLinks: [], outboundLinks: 0, tables: [], lists: { ol: 0, ul: 0, dl: 0 }, quotes: 0, cites: 0, times: [], stats: 0, numbers: 0, wordCount: 300, wordsLower: [], text: "Guide",
  faq: { questions: [] }, viewport: "width=device-width", stack: [], twitterCard: null, internalLinks: [],
};
const robots = { status: 200, text: "User-agent: *\nAllow: /\nUser-agent: Applebot\nDisallow: /\n" };
const psi = { field: true, metrics: { lcp: 3100, inp: 150, cls: 0.02 }, performance: 61 };
const r = scorePage(snap, { robots, llmsTxt: true, llmsText: "# Acme\n\n- [Docs](https://acme.test/docs)\n", psi });
const by = (id) => r.checks.find((c) => c.id === id);

assert.equal(by("cwv-lcp").pass, false, "LCP 3.1s fails");
assert.equal(by("cwv-inp").pass, true);
assert.equal(by("cwv-cls").pass, true);
assert.match(by("cwv-lcp").detail, /real-user/);
assert.equal(by("psi-performance").severity, "info");
assert.equal(by("llms-txt-format").pass, false);
assert.match(by("llms-txt-format").detail, /summary/);
assert.equal(by("twitter-card").pass, false);
assert.equal(by("brand-consistency").pass, false, "Acme Inc vs og:site_name Acme");
assert.equal(by("robots-allow-applebot").pass, false);
assert.equal(by("robots-allow-applebot").severity, "minor");
assert.ok(!r.blockers.length, "Applebot blocked is not a blocker");
assert.match(by("robots-training-info").detail, /CCBot: allowed/);

// PageSpeed parsing: lab fallback when there is no field data
globalThis.fetch = async () => ({ ok: true, json: async () => ({ loadingExperience: {}, lighthouseResult: { categories: { performance: { score: 0.88 } }, audits: { "largest-contentful-paint": { numericValue: 1900 }, "total-blocking-time": { numericValue: 320 }, "cumulative-layout-shift": { numericValue: 0.15 } } } }) });
const lab = await pageSpeed("https://acme.test/");
assert.deepEqual({ field: lab.field, perf: lab.performance, lcp: lab.metrics.lcp, inp: lab.metrics.inp, cls: lab.metrics.cls }, { field: false, perf: 88, lcp: 1900, inp: 320, cls: 0.15 });
globalThis.fetch = async () => ({ ok: false, status: 429, json: async () => ({ error: { message: "Quota exceeded" } }) });
assert.equal((await pageSpeed("https://acme.test/")).error, "Quota exceeded");
const noPsi = scorePage(snap, { robots });
assert.ok(!noPsi.checks.some((c) => c.id.startsWith("cwv-")), "no CWV checks without PageSpeed data");
console.log("unit: all checks passed");
