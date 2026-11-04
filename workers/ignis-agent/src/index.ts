/**
 * IGNIS serverless agentic RAG Worker.
 *
 * Ports the Python agent (pipeline/lib/agent.py + synth.py + retrieve.py) to
 * Cloudflare Workers so the whole assistant runs "live" on free serverless
 * infra — no VPS, no local Python, no session limits:
 *
 *   POST /ask   { question, mode?: "fast"|"deep", model?, k?, stream:true }
 *
 *   fast → single LLM pass on the raw question
 *   deep → full agentic loop: LLM plan → embed → hybrid search → rerank →
 *          expand thin sub-questions → synthesize → verify claims
 *
 * Stack:
 *   - DB:    Neon Postgres via @neondatabase/serverless (HTTP fetch driver)
 *   - Embed: Workers AI @cf/baai/bge-small-en-v1.5 (matches corpus)
 *   - LLM:   ignis-gateway Cloudflare Worker (chat-completions dialect)
 */
import { neon } from "@neondatabase/serverless";
import { markdownToPdf, markdownToDocx, safeFilename, type ChartSpec } from "./export";
import { renderSvg } from "./viz";
import { runAgentLoop } from "./agentic";

interface Env {
  AI: any;
  GATEWAY?: { fetch: typeof fetch };
  IGNIS_GATEWAY_URL: string;
  IGNIS_PROXY_TOKEN?: string;
  NEON_DATABASE_URL?: string;
  EMBED_MODEL: string;
  DB_EMBED_MODEL: string;
  IGNIS_DEEP_MODEL?: string;
  IGNIS_FAST_MODEL?: string;
}

/** Call the gateway worker via its Service Binding (bypasses *.workers.dev 1042). */
function gatewayFetch(env: Env, path: string, init: RequestInit): Promise<Response> {
  const url = `https://ignis-gateway${path}`;
  if (env.GATEWAY) return env.GATEWAY.fetch(url, init);
  return fetch(`${env.IGNIS_GATEWAY_URL}${path}`, init);
}

const WORD_RE = /[A-Za-z0-9][A-Za-z0-9'\-]*/g;
const STOP = new Set(
  ("a an the and or but if while of to in on for with without from by as at is are was were be been being " +
   "this that these those it its their there here which who whom whose what when where why how not no nor so than then " +
   "we our you your they them he she his her can could may might must shall should will would do does did done have has had " +
   "also such more most other some any each both few many much own same too very s t just don now").split(/\s+/));

function words(text: string): string[] {
  return text.match(WORD_RE) ?? [];
}

const DOMAIN_TERMS = [
  "microgravity", "combustion", "flame", "flammability", "ignition", "extinction",
  "smolder", "smoulder", "soot", "pyrolysis", "oxidizer", "oxidiser", "quenching",
  "fire", "fire-safety", "suppression", "diffusion flame", "premixed", "droplet",
  "burning rate", "flame spread", "limiting oxygen", "loi", "cool flame",
  "spacecraft", "iss", "bass", "saffire", "same", "flex", "sofie", "cfi", "ace",
  "cygnus", "pmma", "sibal", "heptane", "methanol", "decane", "ethylene",
  "buoyancy", "convection", "radiative", "aerosol", "smoke", "detector",
];

function domainDensity(text: string): number {
  const toks = words(text).map((w) => w.toLowerCase());
  if (!toks.length) return 0;
  const low = text.toLowerCase();
  let hits = 0;
  for (const t of DOMAIN_TERMS) hits += low.split(t).length - 1;
  return Math.min(1.0, (hits / toks.length) * 8);
}

function queryTerms(question: string): string[] {
  return words(question).map((w) => w.toLowerCase()).filter((w) => w.length > 2 && !STOP.has(w));
}

function lexicalOverlap(text: string, terms: string[]): number {
  if (!terms.length) return 0;
  const low = text.toLowerCase();
  const hits = terms.filter((t) => low.includes(t)).length;
  return hits / terms.length;
}

interface RankFactors {
  fusion: number; rerank: number; quality: number; domain: number;
  fusion_raw: number; rerank_raw: number; quality_raw: number; domain_raw: number;
}

interface Hit {
  chunk_id: number; document_id: number; title: string; source_id: string;
  ordinal: number; kind: string; section_path: string | null; content: string;
  vector_score: number; keyword_score: number; fused_score: number;
  rerank_score: number; final_score: number; quality_score: number;
  landing_url: string; published_date: string | null;
  sub_question: string | null; relevance: string;
  factors?: RankFactors;
}

/**
 * Smart-ranking weights.
 *
 * The fused retrieval score dominates, a lexical rerank refines it, corpus
 * quality and combustion-domain density break ties. Exposed so the dashboard
 * can show a reviewer exactly why one passage outranked another.
 */
const RANK_WEIGHTS = { fusion: 0.40, rerank: 0.34, quality: 0.16, domain: 0.10 } as const;

function toHit(row: any, subQuestion?: string): Hit {
  return {
    chunk_id: Number(row.chunk_id), document_id: Number(row.document_id),
    title: row.title ?? "", source_id: row.source_id ?? "",
    ordinal: Number(row.ordinal ?? 0), kind: row.kind ?? "body",
    section_path: row.section_path ?? null, content: row.content ?? "",
    vector_score: Number(row.vector_score ?? 0), keyword_score: Number(row.keyword_score ?? 0),
    fused_score: Number(row.fused_score ?? 0), rerank_score: 0, final_score: 0,
    quality_score: row.quality_score != null ? Number(row.quality_score) : 0,
    landing_url: row.landing_url ?? "",
    published_date: row.published_date ?? null,
    sub_question: subQuestion ?? null, relevance: "unrated",
  };
}

async function embedOne(env: Env, text: string): Promise<number[]> {
  const res = await env.AI.run(env.EMBED_MODEL, { text });
  const vec: number[] = res?.data?.[0];
  if (!vec || !vec.length) throw new Error("embedding failed: empty vector");
  const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0)) || 1;
  return vec.map((x) => x / norm);
}

function toPgVector(vec: number[]): string {
  return "[" + vec.map((x) => x.toFixed(7)).join(",") + "]";
}

function db(env: Env) {
  return neon(env.NEON_DATABASE_URL!);
}

function json(obj: any, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "content-type": "application/json" },
  });
}

/**
 * Coerce the named columns of a row set from string to number.
 *
 * Postgres `bigint`/`numeric` come back over the Neon HTTP driver as strings
 * (`"206"`, `"0.8809"`), which breaks `toLocaleString`/`toFixed`/arithmetic on
 * the client and renders real data as a dash. Only explicitly listed keys are
 * touched — ids and source ids must stay strings to preserve leading zeros.
 */
function numify<T extends Record<string, any>>(rows: T[], keys: string[]): T[] {
  const kset = new Set(keys);
  return rows.map((row) => {
    const out: Record<string, any> = { ...row };
    for (const k of Object.keys(out)) {
      if (!kset.has(k)) continue;
      const v = out[k];
      if (v !== null && v !== undefined && v !== "" && !Number.isNaN(Number(v))) out[k] = Number(v);
    }
    return out as T;
  });
}

/** Same coercion for a single object (e.g. the document_stats row). */
function numifyOne<T extends Record<string, any>>(row: T | undefined, keys: string[]): T {
  if (!row) return {} as T;
  return numify([row], keys)[0];
}

async function hybridSearch(env: Env, question: string, qvec: number[],
                            k: number, pool: number): Promise<Hit[]> {
  const sql = db(env);
  const query =
    "SELECT f.*, d.quality_score, d.landing_url, d.published_date " +
    "FROM ignis.search_chunks_hybrid($1, $2::vector, $3, $4, $5) f " +
    "LEFT JOIN ignis.document d ON d.id = f.document_id " +
    "ORDER BY f.fused_score DESC LIMIT $6";
  // `model_name` must match the value stored in ignis.chunk_embedding, which is
  // the HuggingFace-style id — not the Cloudflare Workers AI binding id.
  const rows = await sql.query(query, [question, toPgVector(qvec), k, pool, env.DB_EMBED_MODEL, pool]);
  let hits = rows.map((r: any) => toHit(r));

  // Long natural-language questions can produce zero keyword matches because
  // websearch_to_tsquery ANDs every term. Retry with the salient terms only so
  // the RRF fusion still has a lexical leg to blend with the vector leg.
  if (!hits.length) {
    const terms = queryTerms(question);
    const lexical = terms.slice(0, 8).join(" ");
    if (lexical && lexical !== question) {
      const kwRows = await sql.query(
        "SELECT c.id AS chunk_id, c.document_id, d.title, d.source_id, c.ordinal, c.kind, " +
        "c.section_path, c.content, 0::real AS vector_score, k.score AS keyword_score, " +
        "k.score AS fused_score, d.quality_score, d.landing_url, d.published_date " +
        "FROM ignis.search_chunks_keyword($1, $2) k " +
        "JOIN ignis.chunk c ON c.id = k.chunk_id " +
        "JOIN ignis.document d ON d.id = c.document_id " +
        "ORDER BY k.score DESC LIMIT $3",
        [lexical, pool, k],
      );
      hits = kwRows.map((r: any) => toHit(r));
    }
  }
  return hits;
}

function rerank(question: string, hits: Hit[]): Hit[] {
  const terms = queryTerms(question);
  const phrases = Array.from(question.matchAll(/"([^"]{4,})"/g)).map((m) => m[1].toLowerCase());
  for (const h of hits) {
    const overlap = lexicalOverlap(h.content, terms);
    const head = h.content.slice(0, 600).toLowerCase();
    const headBonus = lexicalOverlap(head, terms) * 0.5;
    const phraseBonus = phrases.filter((p) => h.content.toLowerCase().includes(p)).length * 0.25;
    const sectionBonus = ["abstract", "results", "conclusion"].includes(h.kind) ? 0.15 : 0;
    h.rerank_score = Math.min(1.0, 0.55 * overlap + headBonus + phraseBonus + sectionBonus);
  }
  return hits;
}

function smartRank(hits: Hit[], question: string): Hit[] {
  if (!hits.length) return hits;
  const maxFused = Math.max(...hits.map((h) => h.fused_score)) || 1;
  for (const h of hits) {
    const norm = h.fused_score / maxFused;
    const domain = domainDensity(h.content);
    h.final_score =
      RANK_WEIGHTS.fusion * norm +
      RANK_WEIGHTS.rerank * h.rerank_score +
      RANK_WEIGHTS.quality * h.quality_score +
      RANK_WEIGHTS.domain * domain;
    // Keep each weighted contribution so the UI can render the score breakdown.
    h.factors = {
      fusion: RANK_WEIGHTS.fusion * norm,
      rerank: RANK_WEIGHTS.rerank * h.rerank_score,
      quality: RANK_WEIGHTS.quality * h.quality_score,
      domain: RANK_WEIGHTS.domain * domain,
      fusion_raw: norm,
      rerank_raw: h.rerank_score,
      quality_raw: h.quality_score,
      domain_raw: domain,
    };
  }
  hits.sort((a, b) => b.final_score - a.final_score);
  return hits;
}

function mmrDiversify(hits: Hit[], k: number, lambda_ = 0.72): Hit[] {
  if (hits.length <= k) return hits;
  const tokenSets = hits.map((h) => new Set(words(h.content.toLowerCase())));
  const jaccard = (a: Set<string>, b: Set<string>): number => {
    if (!a.size || !b.size) return 0;
    let inter = 0;
    for (const t of a) if (b.has(t)) inter++;
    return inter / (a.size + b.size - inter);
  };
  const selectedIdx: number[] = [];
  const remaining = hits.map((_, i) => i);
  while (remaining.length && selectedIdx.length < k) {
    let best = -1, bestScore = -Infinity;
    for (const i of remaining) {
      let sim = 0;
      for (const j of selectedIdx) sim = Math.max(sim, jaccard(tokenSets[i], tokenSets[j]));
      const score = lambda_ * hits[i].final_score - (1 - lambda_) * sim;
      if (score > bestScore) { best = i; bestScore = score; }
    }
    selectedIdx.push(best);
    remaining.splice(remaining.indexOf(best), 1);
  }
  return selectedIdx.map((i) => hits[i]);
}

async function retrieve(env: Env, question: string, k: number): Promise<Hit[]> {
  const qvec = await embedOne(env, question);
  const hits = await hybridSearch(env, question, qvec, k, 80);
  rerank(question, hits);
  smartRank(hits, question);
  return mmrDiversify(hits, k);
}

/** Retrieval plus the grading step, so callers can report what happened. */
async function retrieveGraded(env: Env, question: string, k: number): Promise<Hit[]> {
  const qvec = await embedOne(env, question);
  const raw = await hybridSearch(env, question, qvec, k, 80);
  rerank(question, raw);
  smartRank(raw, question);
  const hits = mmrDiversify(raw, k);
  (hits as any).verdict = heuristicGrade(hits).verdict;
  return hits;
}

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

async function llmComplete(env: Env, system: string, user: string, model: string,
                           jsonMode = false, maxTokens = 700,
                           effort = "low", timeoutMs = 75000): Promise<string> {
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  return llmChat(env, messages, model, { jsonMode, maxTokens, effort, timeoutMs });
}

type ChatOpts = { jsonMode?: boolean; maxTokens?: number; effort?: string; timeoutMs?: number };

/**
 * One chat completion over an arbitrary message list.
 *
 * The agentic loop needs the model to see its own prior tool calls and their
 * results, which a single system+user pair cannot express.
 */
async function llmChat(env: Env, messages: ChatMessage[], model: string, opts: ChatOpts = {}): Promise<string> {
  const { jsonMode = false, maxTokens = 700, effort = "low", timeoutMs = 75000 } = opts;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (env.IGNIS_PROXY_TOKEN) headers["authorization"] = `Bearer ${env.IGNIS_PROXY_TOKEN}`;
  const payload: any = {
    model,
    messages,
    stream: false,
    max_tokens: maxTokens,
    reasoning_effort: effort,
  };
  if (jsonMode && !model.startsWith("gpt-5.6")) payload.response_format = { type: "json_object" };
  const res = await gatewayFetch(env, "/v1/chat/completions", {
    method: "POST", headers, body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`llm ${model} http ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
    throw new Error(`LLM ${model} ${res.status}: ${data?.error?.message ?? JSON.stringify(data).slice(0, 200)}`);
  }
  const choice = data?.choices?.[0];
  const text = choice?.message?.content ?? "";
  if (!text.trim()) {
    // A reasoning model can exhaust the budget before emitting any text.
    throw new Error(`LLM ${model} returned empty content (finish_reason=${choice?.finish_reason ?? "unknown"}, tokens=${data?.usage?.completion_tokens ?? "?"})`);
  }
  if (choice?.finish_reason === "incomplete") {
    console.error(`llm ${model} truncated: ${text.length} chars, ${data?.usage?.completion_tokens} tokens`);
  }
  return text.trim();
}

function parseJsonObject(raw: string): any {
  let s = raw.trim();
  if (s.startsWith("```")) {
    const parts = s.split("```");
    s = (parts[1] || "").replace(/^json/i, "").trim();
  }
  const start = s.indexOf("{");
  if (start !== -1) {
    // Direct parse of everything from the first brace.
    try { return JSON.parse(s.slice(start)); } catch { /* fall through */ }
    // Balanced-brace extraction (handles trailing prose).
    let depth = 0; let i = start;
    let inStr = false; let esc = false;
    for (; i < s.length; i++) {
      const ch = s[i];
      if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; }
      else {
        if (ch === '"') inStr = true;
        else if (ch === "{") depth++;
        else if (ch === "}") { depth--; if (depth === 0) break; }
      }
    }
    if (depth === 0) {
      try { return JSON.parse(s.slice(start, i + 1)); } catch { /* stats repair below */ }
    }
    // Repair: replace literal control characters that break JSON.stringify/parse.
    const repaired = s
      .replace(/\n/g, " ")
      .replace(/""/g, '"')
      .replace(/([,\[{])\s*([}\]])/g, "$1$2");
    try { return JSON.parse(repaired.slice(repaired.indexOf("{"))); } catch { /* ignore */ }
  }
  return {};
}

const PLAN_SYSTEM =
  "You decompose research questions about microgravity combustion and spacecraft fire " +
  "safety into 2-4 focused retrieval sub-questions. Return JSON: " +
  '{"sub_questions": ["..."], "key_terms": ["..."]}. ' +
  "Sub-questions must be independently searchable scientific queries. Do not answer the question.";

const SYNTH_SYSTEM =
  "You are IGNIS, a scientific research analyst specialising in microgravity combustion " +
  "and spacecraft fire safety. Answer ONLY from the numbered evidence blocks. " +
  "Cite every factual sentence with bracketed evidence numbers like [2] — at least two " +
  "citations, each pointing at a different block where possible. " +
  "Extract concrete quantitative results when present (spread rates, oxygen or pressure " +
  "limits, temperatures, experiment names) and cite them. Only say the evidence is " +
  "insufficient if the blocks genuinely contain nothing relevant to the question. " +
  "Never invent values, experiment names, or citations. " +
  "Structure the answer as markdown so it is scannable rather than one block of prose: " +
  "start with a one- or two-sentence direct answer, then use short ## headings to group " +
  "the findings (for example ## Microgravity vs. Earth, ## Quantified results, " +
  "## Fire-safety implications). Under each heading use bullet points, one finding per " +
  "bullet, keeping each bullet to one or two sentences. Use a markdown table when " +
  "comparing the same quantity across experiments or gravity levels. Bold the key " +
  "quantity or conclusion in each bullet. " +
  "Reply with markdown only: no preamble, no JSON, no code fences.";

const EXPANSIONS: Record<string, string[]> = {
  "flame spread": ["flame spread rate", "counterflow flame spread", "opposed flow spread"],
  "extinguish": ["extinction limit", "flame extinguishment", "radiative extinction"],
  "extinction": ["extinction limit", "flame extinguishment", "quenching distance"],
  "ignit": ["ignition delay", "ignition limit", "ignitability"],
  "smoke": ["smoke and soot detection in spacecraft", "smoke particle size"],
  "oxygen": ["limiting oxygen concentration", "oxygen concentration fire safety"],
  "suppression": ["fire suppression", "water mist fire suppression"],
  "safety": ["fire safety", "flammability limits", "fire risk"],
  "radiation": ["radiative heat loss", "surface radiation", "gas band radiation"],
};

function expandQuery(sub: string, seen: Set<string>): string {
  const low = sub.toLowerCase();
  const additions: string[] = [];
  for (const [stem, variants] of Object.entries(EXPANSIONS)) {
    if (low.includes(stem)) additions.push(...variants.slice(0, 3));
  }
  const unique = [...new Set(additions)].filter((a) => !low.toLowerCase().includes(a.toLowerCase()));
  const expanded = unique.length ? `${sub} ${unique.join(" ")}` : `${sub} microgravity combustion experimental results`;
  return expanded;
}

function heuristicGrade(hits: Hit[]): { verdict: string; score: number } {
  if (!hits.length) return { verdict: "insufficient", score: 0 };
  const top = hits.slice(0, 4);
  const best = Math.max(...top.map((h) => h.rerank_score));
  const avg = top.reduce((s, h) => s + h.rerank_score, 0) / top.length;
  if (best >= 0.5 && avg >= 0.3) return { verdict: "sufficient", score: avg };
  if (best >= 0.28) return { verdict: "partial", score: avg };
  return { verdict: "insufficient", score: avg };
}

function verifyClaims(claims: any[], hitsByChunk: Map<number, Hit>): { claims: any[]; ratio: number } {
  let supported = 0;
  for (const c of claims) {
    const hit = hitsByChunk.get(c.chunk_id);
    const quote = (c.quote ?? c.claim ?? "").trim();
    let ok = false;
    if (hit && quote) {
      const chunkLow = hit.content.toLowerCase();
      const probe = quote.toLowerCase().slice(0, 180);
      if (probe && chunkLow.includes(probe)) ok = true;
      else {
        const qt = new Set(words(quote.toLowerCase()).filter((w) => w.length > 3));
        const ct = new Set(words(hit.content.toLowerCase()));
        if (qt.size) {
          let inter = 0;
          for (const t of qt) if (ct.has(t)) inter++;
          ok = inter / qt.size >= 0.6;
        }
      }
    }
    c.verified = ok;
    if (ok) supported++;
  }
  return { claims, ratio: claims.length ? supported / claims.length : 0 };
}

function synthesizeExtractive(question: string, hits: Hit[]): { answer: string; claims: any[]; confidence: number } {
  if (!hits.length) {
    return {
      answer: "No sufficiently relevant passages were found in the IGNIS corpus for this question. Try broadening the query or rephrasing it in combustion terms.",
      claims: [], confidence: 0.1,
    };
  }
  const top = hits.slice(0, 5);
  const answer =
    `${question}\n\nRelevant excerpts from the IGNIS corpus (NTRS documents):\n` +
    top.map((h, i) => `[${i + 1}] ${h.title} (NTRS ${h.source_id})\n${h.content.slice(0, 220).trim()}`).join("\n\n");
  const claims = top.slice(0, 3).map((h) => ({
    claim: h.content.slice(0, 180).trim(), chunk_id: h.chunk_id, document_id: h.document_id,
    source_id: h.source_id, title: h.title, quote: h.content.slice(0, 180).trim(),
    support_score: h.final_score, landing_url: h.landing_url, section: h.section_path || h.kind,
  }));
  return { answer, claims, confidence: 0.3 };
}

function scheduleHeuristic(question: string): string[] {
  const low = question.toLowerCase();
  const facets: [string, string][] = [
    ["flame spread", "flame spread over solid fuels in microgravity"],
    ["extinguish", "flame extinction and extinguishment in microgravity"],
    ["extinction", "extinction limit and flame extinguishment"],
    ["ignition", "ignition limits of solid fuels"],
    ["smoke", "smoke and soot detection in spacecraft"],
    ["oxygen", "limiting oxygen concentration and atmosphere"],
    ["pressure", "pressure effects on combustion"],
  ];
  const subs: string[] = [];
  for (const [needle, probe] of facets) {
    if (low.includes(needle) && subs.length < 4) subs.push(probe);
  }
  if (subs.length < 2) subs.push(`${question} experimental results`);
  if (subs.length < 3) subs.push("spacecraft fire safety implications microgravity");
  return subs.slice(0, 4);
}

async function plan(env: Env, question: string, model: string,
                    memoryContext = ""): Promise<{ subs: string[]; terms: string[] }> {
  try {
    const memoryBlock = memoryContext ? `\n\nRelevant memory from earlier sessions:\n${memoryContext}\n` : "";
    // Planning asks for a small JSON object, but the reasoning models still bill
    // their scratch work against max_tokens, so 500 is not enough headroom.
    const planBudget = synthBudgets(model)[0];
    const raw = await llmComplete(env, PLAN_SYSTEM, `Question: ${question}${memoryBlock}\n\n`, model, true, planBudget);
    const data = parseJsonObject(raw);
    const subs = (data.sub_questions ?? []).filter((s: any) => typeof s === "string" && s.length > 4).slice(0, 4);
    const terms = (data.key_terms ?? []).filter((t: any) => typeof t === "string").slice(0, 12);
    if (subs.length) return { subs, terms };
    return { subs: scheduleHeuristic(question), terms: [] };
  } catch {
    return { subs: scheduleHeuristic(question), terms: [] };
  }
}

/**
 * Output-token budgets to try for a synthesis call, in order.
 *
 * These models are reasoning models: they bill hidden reasoning against
 * `max_tokens` before emitting any visible text. `gpt-5.6-sol` finishes inside
 * ~400 tokens, but `gpt-6.1-sol` and `gpt-6-astra` routinely burn 900-1800
 * tokens reasoning and return `finish_reason=incomplete` with empty content at
 * a 900-token cap. Starting them low would guarantee a failed first attempt on
 * every question, so they get a larger opening budget.
 */
function synthBudgets(model: string): number[] {
  // Structured markdown with headings, bullets, and tables runs longer than the
  // flat prose these budgets were originally sized for.
  return /astra|6\.1/.test(model) ? [4000, 8000] : [1800, 3500];
}

/** Total wall-clock allowed for all synthesis attempts on one question. */
const SYNTH_DEADLINE_MS = 90000;

async function synthesizeWithLLM(env: Env, question: string, hits: Hit[],
                                 subQuestions: string[], model: string): Promise<{ answer: string; claims: any[]; confidence: number }> {
  const evidenceBlocks = hits.slice(0, 5).map((h, i) =>
    `[${i + 1}] ${h.title} (NTRS ${h.source_id}; section: ${h.section_path ?? h.kind})\n${h.content.slice(0, 900).trim()}`);
  const evidence = evidenceBlocks.join("\n\n");
  let user = `Question: ${question}\n\nEvidence:\n${evidence}`;
  if (subQuestions.length) user += `\n\nSub-questions to address: ${subQuestions.join("; ")}`;

  // Each retry gets a larger output budget, and each call is bounded by both a
  // per-call timeout and the overall deadline so a stalled upstream degrades to
  // the extractive answer instead of hanging the request for minutes.
  const deadline = Date.now() + SYNTH_DEADLINE_MS;
  let lastErr: any = null;
  for (const budget of synthBudgets(model)) {
    const remaining = deadline - Date.now();
    if (remaining < 15000) break;
    try {
      const raw = await llmComplete(env, SYNTH_SYSTEM, user, model, false, budget, "low",
                                    Math.min(75000, remaining));
      const answer = raw.trim();
      if (!answer) throw new Error("empty answer");
      const claims = claimsFromCitations(answer, hits);
      return { answer, claims, confidence: claims.length ? Math.min(0.95, 0.62 + 0.08 * claims.length) : 0.2 };
    } catch (err: any) {
      lastErr = err;
      console.error(`synth attempt (${budget}): ${String(err?.message ?? err).slice(0, 200)}`);
    }
  }
  console.error(`synth fallback: ${String(lastErr?.message ?? lastErr).slice(0, 300)}`);
  return synthesizeExtractive(question, hits);
}

/**
 * Build cited claims from the `[n]` markers in a generated answer.
 *
 * The model only has to pick an evidence number, so every claim is guaranteed to
 * point at a real passage, and the quote is taken from that passage rather than
 * reproduced by the model. Confidence tracks how many distinct sources were cited.
 */
function claimsFromCitations(answer: string, hits: Hit[]): any[] {
  const seen = new Set<number>();
  const claims: any[] = [];
  for (const m of answer.matchAll(/\[(\d+)\]/g)) {
    const n = Number(m[1]);
    if (!Number.isInteger(n) || n < 1 || n > hits.length || seen.has(n)) continue;
    seen.add(n);
    const hit = hits[n - 1];
    const quote = hit.content.trim().slice(0, 240);
    claims.push({
      claim: quote, chunk_id: hit.chunk_id, document_id: hit.document_id,
      source_id: hit.source_id, title: hit.title, quote,
      support_score: hit.final_score, landing_url: hit.landing_url,
      section: hit.section_path || hit.kind,
    });
  }
  return claims;
}

const cors: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization",
  "access-control-allow-methods": "POST, GET, OPTIONS",
};

/**
 * Wrap an SSE handler so the connection stays alive through long silences.
 *
 * Synthesis calls the LLM for 10-60s without producing an event, and an idle
 * SSE connection is closed by the browser and by edge proxies. A comment frame
 * every 10s costs nothing (SSE clients ignore `:` lines) and keeps the socket
 * warm, which is what stops the "ERR_CONNECTION_CLOSED" seen on /api/ask.
 */
function sseResponse(run: (emit: (event: string, data: any) => void) => Promise<void>): Response {
  const enc = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  let closed = false;
  const write = (chunk: string) => {
    if (closed) return;
    writer.write(enc.encode(chunk)).catch(() => { closed = true; });
  };
  const emit = (event: string, data: any) => write(`data: ${JSON.stringify({ event, data })}\n\n`);

  const heartbeat = setInterval(() => write(": keep-alive\n\n"), 10000);
  run(emit)
    .catch((err: any) => emit("error", { error: String(err?.message ?? err) }))
    .finally(async () => {
      clearInterval(heartbeat);
      write(`data: ${JSON.stringify({ event: "close" })}\n\n`);
      closed = true;
      try { await writer.close(); } catch { /* client gone */ }
    });

  return new Response(readable, {
    status: 200,
    headers: {
      ...cors,
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

/**
 * Run the agentic RAG loop and return the final AgentResult.
 * `emit(node, data)` receives progress events (mode/plan/retrieve/synthesize).
 */
async function runAgent(
  env: Env,
  question: string,
  mode: "fast" | "deep",
  model: string | undefined,
  k: number,
  emit: (node: string, data: any) => void,
  conversationId?: string,
): Promise<any> {
  const started = Date.now();
  const runId = crypto.randomUUID();
  const trace: any[] = [];
  const step = (node: string, data: any) => {
    trace.push({ node, ...data, t_ms: Date.now() - started });
    emit(node, data);
  };

  // ---- memory recall (both modes) ----
  let memoryContext = "";
  try {
    const recalled = await memoryRecall(env, question, 4, conversationId);
    if (recalled.length) {
      memoryContext = recalled.map((r) => `[${r.kind}] ${r.content}`).join("\n");
      step("memory", { n_recalled: recalled.length, contents: recalled.map((r) => r.content) });
    }
  } catch { /* memory is best-effort */ }

  let subs: string[];
  if (mode === "deep") {
    const deepModel = model || "gpt-5.6-sol";
    step("mode", { mode, use_llm: true, provider: "ignis-agent", model: deepModel, max_iterations: 2 });
    const planned = await plan(env, question, deepModel, memoryContext);
    subs = planned.subs;
  } else {
    const fastModel = model || "gpt-5.6-sol";
    step("mode", { mode, use_llm: true, provider: "ignis-agent", model: fastModel, max_iterations: 1 });
    subs = [question];
  }
  step("plan", { sub_questions: subs });

  const allHits: Hit[] = [];
  for (const sq of subs) {
    const hits = await retrieveGraded(env, sq, mode === "deep" ? 4 : k);
    for (const h of hits) h.sub_question = sq;
    allHits.push(...hits);
    step("retrieve", {
      iteration: 0,
      sub_question: sq,
      n_hits: hits.length,
      verdict: (hits as any).verdict ?? heuristicGrade(hits).verdict,
    });
  }

  // Grade the pooled evidence; if it is thin, expand the query and retry once.
  const seen = new Set<number>();
  let ranked = allHits.filter((h) => { if (seen.has(h.chunk_id)) return false; seen.add(h.chunk_id); return true; });
  ranked.sort((a, b) => b.final_score - a.final_score);
  let relevant = ranked.slice(0, k);

  const pooledGrade = heuristicGrade(relevant);
  step("grade", { verdict: pooledGrade.verdict, score: Number(pooledGrade.score.toFixed(3)), n: relevant.length });

  if (pooledGrade.verdict !== "sufficient") {
    const expanded = expandQuery(question, new Set(subs));
    step("expand", { from: question, to: [expanded] });
    const more = await retrieveGraded(env, expanded, k);
    for (const h of more) h.sub_question = expanded;
    const merged = new Map<number, Hit>();
    for (const h of [...relevant, ...more]) {
      const prev = merged.get(h.chunk_id);
      if (!prev || h.final_score > prev.final_score) merged.set(h.chunk_id, h);
    }
    relevant = [...merged.values()].sort((a, b) => b.final_score - a.final_score).slice(0, k);
  }

  const usedModel = model || "gpt-5.6-sol";
  const synth = await synthesizeWithLLM(env, question, relevant, subs, usedModel);
  const hitsByChunk = new Map(relevant.map((h) => [h.chunk_id, h]));
  const verified = verifyClaims(synth.claims, hitsByChunk);
  const confidence = Math.round(Math.min(0.95, 0.55 * synth.confidence + 0.45 * verified.ratio) * 1000) / 1000;
  step("synthesize", { provider: "ignis-agent", model: usedModel, claims: verified.claims.length });
  step("verify", { verified_ratio: Number(verified.ratio.toFixed(3)), claims: verified.claims.length });

  // Persist the durable findings so later questions can recall them.
  try {
    const written = await memoryWrite(env, question, verified.claims, conversationId);
    if (written) step("memory_write", { n_claims: written });
  } catch { /* best-effort */ }

  // Attach a chart when the question asks to see one. The figure is built from
  // recorded measurements only, and the answer carries a markdown chart
  // reference so exporting the answer embeds the same figure.
  let chart: any = null;
  let answer = synth.answer;
  const evidenceText = relevant.map((h) => h.text ?? "").join(" ").slice(0, 4000);
  const datasetKey = pickDataset(question, evidenceText);
  if (datasetKey && wantsVisual(question)) {
    try {
      const built = await buildChart(env, { dataset: datasetKey, type: "bar", limit: 20 });
      if (!("error" in built)) {
        chart = {
          spec: built.spec,
          svg: renderSvg(built.spec),
          rows: built.rows,
          note: "Values are measurements mined from NTRS report text, not a curated NASA dataset.",
        };
        // `chart:0` is the export syntax for "the first attached chart".
        answer = `${answer}\n\n![${built.spec.title}](chart:0)`;
        step("visualize", { dataset: datasetKey, type: built.spec.type, points: built.rows.length });
      }
    } catch (err: any) {
      console.error(`visualize: ${String(err?.message ?? err).slice(0, 200)}`);
    }
  }

  const result = {
    run_id: runId,
    question,
    answer,
    chart,
    claims: verified.claims,
    evidence: relevant.map((h) => ({ ...h })),
    sub_questions: subs,
    confidence,
    grounded: Boolean(verified.claims.length) && verified.ratio > 0.3,
    iterations: 1,
    provider: "ignis-agent",
    model: usedModel,
    trace,
    latency_ms: Date.now() - started,
  };

  // Session history is written only for a real, caller-supplied conversation.
  // Without one this stays a stateless run, so an anonymous visitor never
  // accumulates rows in the database.
  if (conversationId) {
    try {
      await persistSession(env, conversationId, question, result);
    } catch (err: any) {
      console.error(`session persist: ${String(err?.message ?? err).slice(0, 200)}`);
    }
  }

  return result;
}

/** Dataset key -> the words that indicate a question is about it. */
const DATASET_INTENT: Record<string, string[]> = {
  flame_temperature: ["temperature", "thermal", "kelvin", "حرارة", "درجة الحرارة"],
  flame_spread_rate: ["spread", "propagat", "انتشار", "معدل الانتشار"],
  limiting_oxygen_index: ["oxygen", "lox", "oxidizer", "أكسجين", "الاكسجين"],
  pressure: ["pressure", "kpa", "ضغط"],
  soot_volume_fraction: ["soot", "sooting", "سoot", "سخام", "هباب"],
  smoke_particle_size: ["smoke", "particle", "aerosol", "دخان", "جزيئات"],
  gravity_level: ["gravity", "microgravity", "g-level", "جاذبية"],
};

/**
 * Pick the dataset a question is most likely asking to see.
 *
 * Chosen by keyword overlap with the question, then the retrieved evidence, so
 * the chart is tied to what was actually asked and cited rather than to a
 * default the model invented.
 */
function pickDataset(question: string, evidenceText = ""): string | null {
  const hay = `${question} ${evidenceText}`.toLowerCase();
  let best: { key: string; score: number } | null = null;
  for (const [key, words] of Object.entries(DATASET_INTENT)) {
    let score = 0;
    for (const w of words) {
      const hits = hay.split(w.toLowerCase()).length - 1;
      if (hits) score += hits * (question.toLowerCase().includes(w.toLowerCase()) ? 3 : 1);
    }
    if (score && (!best || score > best.score)) best = { key, score };
  }
  return best?.key ?? null;
}

/** True when the question is asking for a visual rather than prose. */
function wantsVisual(question: string): boolean {
  const q = question.toLowerCase();
  return /\b(chart|graph|plot|visuali[sz]|diagram|figure|compare.*numerically|distribution)\b/.test(q)
    || /(رسم|مخطط|بياني|رسم بياني|توضيح|مقارنة)/.test(question);
}

type ChartRequest = {
  dataset: string;
  type?: "bar" | "line" | "scatter";
  limit?: number;
  group_by?: "experiment";
  title?: string;
};

/**
 * Build a chart spec and its data straight from `ignis.dataset_row`.
 *
 * Every plotted value is a measurement recorded in a NTRS report; this function
 * never synthesises points, so a chart cannot show numbers that are not in the
 * evidence base.
 */
async function buildChart(env: Env, req: ChartRequest): Promise<{ spec: ChartSpec; rows: any[]; meta: any } | { error: string }> {
  const sql = db(env);
  const limit = Math.min(Math.max(Number(req.limit ?? 20), 2), 60);
  const meta: any[] = await sql`SELECT * FROM ignis.dataset WHERE key = ${req.dataset} LIMIT 1`;
  if (!meta.length) return { error: `dataset ${req.dataset} not found` };
  const unit = meta[0].canonical_unit ?? "";

  let rows: any[];
  if (req.group_by === "experiment") {
    rows = await sql`
      SELECT coalesce(experiment_code, 'unlinked') AS label,
             count(*)::int AS n,
             round(avg(value)::numeric, 4) AS value
        FROM ignis.dataset_row
       WHERE dataset_key = ${req.dataset}
       GROUP BY 1 ORDER BY value DESC LIMIT ${limit}`;
  } else {
    rows = await sql`
      SELECT coalesce(experiment_code, document_source_id, 'recorded') AS label, value
        FROM ignis.dataset_row
       WHERE dataset_key = ${req.dataset}
       ORDER BY value LIMIT ${limit}`;
  }
  if (!rows.length) return { error: `dataset ${req.dataset} has no rows` };

  const type = (req.type ?? "bar") as ChartSpec["type"];
  const spec: ChartSpec = {
    type,
    title: req.title ?? `${meta[0].name}${req.group_by === "experiment" ? " by experiment" : ""}`,
    x_label: req.group_by === "experiment" ? "experiment" : "measurement (ordered by value)",
    y_label: meta[0].name,
    unit,
    series: [{
      label: meta[0].name,
      points: rows.map((r, i) => ({ x: type === "bar" ? String(r.label) : i + 1, y: Number(r.value) })),
    }],
    source_note: `${rows.length} recorded values from NASA NTRS reports · extracted by regex · unit ${unit || "n/a"}`,
  };
  return { spec, rows, meta: meta[0] };
}

/** Plottable metrics with their value counts, for the agent's build_chart tool. */
async function listDatasets(env: Env): Promise<{ key: string; name: string; unit: string; n: number }[]> {
  const sql = db(env);
  const rows: any[] = await sql`
    SELECT key, name, canonical_unit, value_count FROM ignis.dataset
     WHERE value_count > 0 ORDER BY value_count DESC, name`;
  return rows.map((r) => ({ key: r.key, name: r.name, unit: r.canonical_unit ?? "", n: Number(r.value_count ?? 0) }));
}

/**
 * Side-by-side comparison of named experiments.
 *
 * Shared by the /compare endpoint and the agent's compare_experiments tool so a
 * chart or an answer can never disagree with what the Compare view shows.
 */
async function compareExperiments(env: Env, codes: string[], topic: string | null): Promise<any> {
  const sql = db(env);
  const exps = await sql`SELECT e.*, f.code AS facility_code, f.name AS facility_name, f.platform FROM ignis.experiment e LEFT JOIN ignis.facility f ON f.id = e.facility_id WHERE e.code = ANY(${codes})`;
  if (!exps.length) return { experiments: [], dimensions: [], findings: {}, metric_matrix: [], note: "no matching experiments" };
  const ids = exps.map((e: any) => e.id);
  const findings = await sql`SELECT ed.experiment_id, f.metric, f.value, f.value_max, f.unit, f.statement, f.confidence, d.title, d.source_id FROM ignis.finding f JOIN ignis.experiment_document ed ON ed.document_id = f.document_id JOIN ignis.document d ON d.id = f.document_id WHERE ed.experiment_id = ANY(${ids}) AND (${topic}::text IS NULL OR f.metric ILIKE '%' || ${topic}::text || '%') ORDER BY ed.experiment_id, f.metric`;
  const docCounts = await sql`SELECT experiment_id, count(*) AS n FROM ignis.experiment_document WHERE experiment_id = ANY(${ids}) GROUP BY experiment_id`;
  const counts = new Map(docCounts.map((r: any) => [r.experiment_id, Number(r.n)]));
  const byExp: Record<string, any[]> = {};
  for (const f of findings as any[]) {
    (byExp[f.experiment_id] ??= []).push({
      metric: f.metric, value: f.value, value_max: f.value_max, unit: f.unit,
      statement: f.statement, confidence: f.confidence, document_title: f.title, source_id: f.source_id,
    });
  }
  const metricMatrix: Record<string, any> = {};
  for (const e of exps as any[]) for (const f of byExp[e.id] ?? []) {
    (metricMatrix[f.metric] ??= {})[e.id] ??= [];
    metricMatrix[f.metric][e.id].push({ value: f.value, value_max: f.value_max, unit: f.unit });
  }
  return {
    experiments: (exps as any[]).map((e) => ({
      id: e.id, code: e.code, name: e.name, campaign: e.campaign, facility: e.facility_code,
      facility_name: e.facility_name, platform: e.platform, status: e.status, gravity_level: e.gravity_level,
      fuel_type: e.fuel_type, ambient_gas: e.ambient_gas, pressure_kpa: e.pressure_kpa, o2_fraction: e.o2_fraction,
      ignition_source: e.ignition_source, objective: e.objective, summary: e.summary,
      document_count: counts.get(e.id) ?? 0,
    })),
    dimensions: ["campaign", "facility_code", "platform", "status", "gravity_level", "fuel_type", "ambient_gas", "pressure_kpa", "o2_fraction", "ignition_source"],
    findings: Object.fromEntries((exps as any[]).map((e) => [String(e.id), byExp[e.id] ?? []])),
    metric_matrix: Object.entries(metricMatrix).sort(([a], [b]) => a.localeCompare(b)).map(([metric, values]) => ({ metric, values })),
  };
}

/** Experiment codes known to the corpus, for the agent's compare tool. */
async function knownExperimentCodes(env: Env): Promise<string[]> {
  const sql = db(env);
  const rows: any[] = await sql`SELECT code FROM ignis.experiment WHERE code IS NOT NULL ORDER BY code`;
  return rows.map((r) => String(r.code));
}

/**
 * Run the agentic loop against the live corpus.
 *
 * Astra is the default reasoning core because the loop multiplies model quality:
 * each turn is a real decision about what to search next, and citation
 * discipline is only as good as the model making it.
 */
async function runAgentic(
  env: Env,
  question: string,
  mode: "fast" | "deep",
  model: string | undefined,
  k: number,
  emit: (node: string, data: any) => void,
  conversationId?: string,
): Promise<any> {
  const started = Date.now();
  const runId = crypto.randomUUID();
  const trace: any[] = [];
  const step = (node: string, data: any) => {
    trace.push({ node, ...data, t_ms: Date.now() - started });
    emit(node, data);
  };

  // Fast mode uses the fast model: the agentic loop makes several sequential
  // calls, and the deep model's per-call latency is high enough that a run
  // cannot reach synthesis inside the deadline.
  const usedModel = model ||
    (mode === "deep" ? (env.IGNIS_DEEP_MODEL || "gpt-6-astra")
                     : (env.IGNIS_FAST_MODEL || "gpt-5.6-sol"));
  const maxIterations = mode === "deep" ? 8 : 5;
  const deadlineMs = mode === "deep" ? 210000 : 150000;

  step("mode", { mode, use_llm: true, provider: "ignis-agent", agent: "react-loop", model: usedModel, max_iterations: maxIterations });

  // The model can recall memory as a tool, but a cheap pre-pass puts prior
  // findings in context on turn one so it rarely has to spend a turn asking.
  let memoryBlock = "";
  try {
    const recalled = await memoryRecall(env, question, 5, conversationId);
    if (recalled.length) {
      memoryBlock = "\n\nPrior findings from earlier sessions (may or may not apply):\n" +
        recalled.map((r: any, i: number) => `(${i + 1}) ${r.content}`).join("\n");
      step("memory", { n_recalled: recalled.length, contents: recalled.map((r: any) => r.content) });
    }
  } catch { /* memory is best-effort */ }

  const known = await knownExperimentCodes(env).catch(() => [] as string[]);

  const loop = await runAgentLoop(
    question,
    {
      model: usedModel,
      deadlineMs,
      maxIterations,
      context: memoryBlock.trim() || undefined,
      search: (q, kk) => retrieveGraded(env, q, kk),
      recall: async (q, kk) => (await memoryRecall(env, q, kk, conversationId)) as any,
      compare: (codes, topic) => compareExperiments(env, codes, topic),
      datasets: () => listDatasets(env),
      chat: (messages, opts) => llmChat(env, messages, usedModel, opts),
    },
    known,
    (s) => step(s.tool === "final_answer" ? "final" : "act", {
      iteration: s.iteration, thought: s.thought, tool: s.tool, input: s.input,
      n_evidence: s.n_evidence, error: s.error,
    }),
  );

  // The loop numbered evidence in this same order, so the [n] markers the model
  // wrote resolve to the passages shown beside the answer.
  const relevant = loop.hits;
  const hitsByChunk = new Map(relevant.map((h) => [h.chunk_id, h]));
  const claims = verifyClaims(claimsFromCitations(loop.answer, relevant as any), hitsByChunk);
  const verifiedRatio = claims.ratio;

  let chart: any = null;
  let answer = loop.answer;
  if (loop.chartRequest) {
    try {
      const built = await buildChart(env, {
        dataset: loop.chartRequest.dataset,
        type: loop.chartRequest.type,
        limit: 20,
        group_by: "experiment",
      });
      if ("error" in built) {
        step("visualize", { error: built.error });
      } else {
        chart = {
          spec: built.spec,
          svg: renderSvg(built.spec),
          rows: built.rows,
          note: "Values are measurements mined from NTRS report text, not a curated NASA dataset.",
        };
        answer = `${answer}\n\n![${built.spec.title}](chart:0)`;
        step("visualize", { dataset: loop.chartRequest.dataset, type: built.spec.type, points: built.rows.length });
      }
    } catch (err: any) {
      step("visualize", { error: String(err?.message ?? err).slice(0, 160) });
    }
  }

  step("verify", { verified_ratio: Number(verifiedRatio.toFixed(3)), claims: claims.claims.length, stop_reason: loop.stopReason });
  step("synthesize", { provider: "ignis-agent", model: usedModel, claims: claims.claims.length, iterations: loop.iterations });

  try {
    const written = await memoryWrite(env, question, claims.claims, conversationId);
    if (written) step("memory_write", { n_claims: written });
  } catch { /* best-effort */ }

  // Confidence blends how the loop stopped with how many claims the corpus
  // actually supports. The verified share dominates because it is measured, not
  // asserted; a forced or budget synthesis is still a real answer, so it is not
  // penalised to near-zero the way a hard failure would be.
  const modelConfidence =
    loop.stopReason === "final_answer" ? 0.85 :
    loop.stopReason === "forced_synthesis" ? 0.7 :
    loop.stopReason === "budget" ? 0.55 :
    loop.stopReason === "deadline" ? 0.45 :
    0.3;
  const confidence = Math.round(Math.min(0.95, 0.35 * modelConfidence + 0.65 * verifiedRatio) * 1000) / 1000;

  const result = {
    run_id: runId,
    question,
    answer,
    chart,
    claims: claims.claims,
    evidence: relevant.map((h) => ({ ...h })),
    sub_questions: loop.steps.filter((s) => s.tool === "search_corpus")
      .map((s) => String(s.input?.query ?? "")).filter(Boolean),
    confidence,
    grounded: Boolean(claims.claims.length) && verifiedRatio > 0.3,
    iterations: loop.iterations,
    stop_reason: loop.stopReason,
    provider: "ignis-agent",
    model: usedModel,
    agent: "react-loop",
    trace,
    latency_ms: Date.now() - started,
  };

  if (conversationId) {
    try {
      await persistSession(env, conversationId, question, result);
    } catch (err: any) {
      console.error(`session persist: ${String(err?.message ?? err).slice(0, 200)}`);
    }
  }

  return result;
}

/** The 10 UI locales IGNIS ships. English is the source, so it needs no calls. */
const LOCALES: { code: string; name: string; english: string; rtl?: boolean }[] = [
  { code: "en", name: "English", english: "English" },
  { code: "ar", name: "العربية", english: "Arabic", rtl: true },
  { code: "fr", name: "Français", english: "French" },
  { code: "es", name: "Español", english: "Spanish" },
  { code: "de", name: "Deutsch", english: "German" },
  { code: "pt", name: "Português", english: "Portuguese" },
  { code: "ru", name: "Русский", english: "Russian" },
  { code: "zh", name: "中文", english: "Chinese (Simplified)" },
  { code: "ja", name: "日本語", english: "Japanese" },
  { code: "hi", name: "हिन्दी", english: "Hindi" },
];

/** Locale codes the translate endpoint will accept. */
const LOCALE_CODES = new Set(LOCALES.map((l) => l.code));

const TRANSLATE_SYSTEM =
  "You are a UI localisation engine for a NASA microgravity-combustion research dashboard. " +
  "Translate each English UI string into the target language, one per line. " +
  "Keep it short: these are buttons, headings, labels, and status lines. " +
  "Preserve placeholders, numbers, units (K, kPa, cm/s, %, ppm, nm), and acronyms " +
  "(NASA, NTRS, SAFFIRE, BASS-II, SAME, PDF, DOCX, AI, RAG) exactly as written. " +
  "Do not translate proper nouns. Do not add punctuation that is not implied. " +
  'Reply with JSON only: {"t": ["<translation 1>", "<translation 2>", ...]} with exactly one ' +
  "item per input string, in input order. Never omit an item and never merge two inputs into one.";

async function md5Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("MD5", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&apos;": "'", "&nbsp;": " ",
};
const unescapeEntities = (s: string) =>
  s.replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => HTML_ENTITIES[m] ?? m);

/**
 * Google's public translate endpoint.
 *
 * Strings are joined with newlines into a single `q`, which the endpoint splits
 * back into one segment per line — so a whole batch costs one request. Segments
 * are only trusted when the count matches, because a mismatch would silently
 * pair a translation with the wrong source string.
 */
async function googleTranslate(texts: string[], locale: string): Promise<(string | null)[]> {
  const url = "https://translate.googleapis.com/translate_a/single?" + new URLSearchParams({
    client: "gtx", sl: "en", tl: locale, dt: "t", q: texts.join("\n"),
  });
  // The endpoint throttles bursts with 429; a short backoff clears it.
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; IGNIS/1.0)", Accept: "application/json" },
      signal: AbortSignal.timeout(20000),
    });
    if (res.status === 429 || res.status >= 500) {
      if (attempt < 2) { await new Promise((r) => setTimeout(r, 400 * (attempt + 1))); continue; }
      throw new Error(`google ${res.status}`);
    }
    if (!res.ok) throw new Error(`google ${res.status}`);
    const data: any = await res.json();
    const segs: string[] = (data?.[0] ?? [])
      .map((s: any) => (Array.isArray(s) ? s[0] : null))
      .filter((s: any) => typeof s === "string");
    const joined = unescapeEntities(segs.join("")).split("\n").map((s) => s.trim());
    if (joined.length !== texts.length) {
      throw new Error(`google alignment ${joined.length} != ${texts.length}`);
    }
    return joined.map((s, i) => (s && s !== texts[i] ? s : null));
  }
  throw new Error("google unreachable");
}

/**
 * MyMemory: free, per-string, no key. Only used for strings Google could not
 * resolve, and capped, because each string costs its own subrequest.
 */
async function myMemoryTranslate(texts: string[], locale: string): Promise<(string | null)[]> {
  const out: (string | null)[] = [];
  for (const t of texts) {
    // The endpoint rejects `q` longer than 500 bytes.
    if (t.length > 480) { out.push(null); continue; }
    try {
      const url = "https://api.mymemory.translated.net/get?" +
        new URLSearchParams({ q: t, langpair: `en|${locale}` });
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) { out.push(null); continue; }
      const d: any = await res.json();
      const v = d?.responseData?.translatedText;
      if (typeof v !== "string" || !v.trim()) { out.push(null); continue; }
      const decoded = unescapeEntities(v);
      // MyMemory echoes the input when it has no translation for the pair.
      out.push(decoded === t ? null : decoded);
    } catch {
      out.push(null);
    }
  }
  return out;
}

/**
 * Ask the model for translations of one batch.
 *
 * Returns a string per input, or null when the response cannot be trusted. A
 * response with the wrong item count is rejected outright: a short array would
 * silently shift every later string onto the wrong source, which shows up as
 * plausible-looking but wrong UI text.
 */
async function translateBatch(env: Env, locale: string, batch: string[]): Promise<(string | null)[]> {
  const language = LOCALES.find((l) => l.code === locale)?.english ?? locale;
  const numbered = batch.map((s, n) => `${n + 1}. ${s}`).join("\n");
  for (const budget of [1500, 3000]) {
    try {
      const raw = await llmComplete(
        env, TRANSLATE_SYSTEM,
        `Target language: ${language}\n\n${numbered}`,
        env.IGNIS_FAST_MODEL || "gpt-5.6-sol", true, budget, "low", 60000,
      );
      const parsed = parseJsonObject(raw);
      const arr = Array.isArray(parsed?.t) ? parsed.t : null;
      if (arr && arr.length === batch.length) {
        return arr.map((v: any, i: number) =>
          typeof v === "string" && v.trim() && v.trim() !== batch[i] ? v.trim() : null);
      }
      console.error(`translate ${locale}: bad item count ${arr?.length ?? "n/a"} for ${batch.length} inputs`);
    } catch (err: any) {
      console.error(`translate ${locale}: ${String(err?.message ?? err).slice(0, 160)}`);
    }
  }
  return batch.map(() => null);
}

// Google accepts roughly 8 KB of query string; 60 short labels stays well under.
const GOOGLE_CHUNK = 60;
// Each MyMemory string is one subrequest, and a Worker invocation gets 50.
const MYMEMORY_MAX = 12;

/**
 * Resolve a set of strings through the provider chain, cheapest first.
 *
 * Google and MyMemory are machine-translation services, so they are fast and
 * deterministic for short UI labels; the gateway model covers whatever they
 * cannot. Every provider returns one slot per input so the caller can keep
 * position, and unresolved slots come back as null rather than English — that
 * distinction is what stops a failure from being cached as a translation.
 */
async function translateViaProviders(env: Env, locale: string, batch: string[]): Promise<(string | null)[]> {
  const resolved: (string | null)[] = batch.map(() => null);

  for (let i = 0; i < batch.length; i += GOOGLE_CHUNK) {
    const slice = batch.slice(i, i + GOOGLE_CHUNK);
    try {
      const part = await googleTranslate(slice, locale);
      part.forEach((v, n) => { if (v) resolved[i + n] = v; });
    } catch (err: any) {
      console.error(`translate ${locale}: google failed ${String(err?.message ?? err).slice(0, 120)}`);
    }
  }

  const googleMisses = batch.map((s, i) => (resolved[i] ? -1 : i)).filter((i) => i >= 0);
  if (googleMisses.length) {
    const slice = googleMisses.slice(0, MYMEMORY_MAX).map((i) => batch[i]);
    try {
      const part = await myMemoryTranslate(slice, locale);
      part.forEach((v, n) => { if (v) resolved[googleMisses[n]] = v; });
    } catch (err: any) {
      console.error(`translate ${locale}: mymemory failed ${String(err?.message ?? err).slice(0, 120)}`);
    }
  }

  const llmMisses = batch.map((s, i) => (resolved[i] ? -1 : i)).filter((i) => i >= 0);
  if (llmMisses.length) {
    const part = await translateBatch(env, locale, llmMisses.map((i) => batch[i]));
    part.forEach((v, n) => { if (v) resolved[llmMisses[n]] = v; });
  }

  return resolved;
}

/**
 * Translate UI strings into a locale, cached in `ignis.ui_translation`.
 *
 * Only cache misses reach the model, so the 10 locales cost one batch call each
 * per string rather than one per page view. Batches that come back malformed are
 * halved and retried, which isolates one problematic string instead of losing
 * the whole page to English.
 */
async function translateStrings(env: Env, locale: string, strings: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const unique = [...new Set(strings.map((s) => String(s ?? "")).filter((s) => s.trim()))];
  if (!unique.length) return out;

  // English is the source language: return it verbatim and skip the model.
  if (locale === "en") {
    for (const s of unique) out[s] = s;
    return out;
  }

  const sql = db(env);
  const hashes = await Promise.all(unique.map(md5Hex));
  const hashOf = new Map(unique.map((s, i) => [s, hashes[i]]));

  const cached: any[] = await sql`
    SELECT source_hash, translated FROM ignis.ui_translation
     WHERE locale = ${locale} AND source_hash = ANY(${hashes})`;
  const byHash = new Map(unique.map((s, i) => [hashes[i], s]));
  for (const row of cached) {
    const src = byHash.get(row.source_hash);
    if (src) out[src] = row.translated;
  }

  const missing = unique.filter((s) => !(s in out));
  if (!missing.length) return out;

  // One pass: every provider in the chain sees the whole set, so the number of
  // subrequests stays fixed regardless of how many strings fail to align.
  const resolved = new Map<string, string>();
  const result = await translateViaProviders(env, locale, missing);
  missing.forEach((s, i) => {
    const v = result[i];
    if (v) resolved.set(s, v);
  });

  const rows: { hash: string; source: string; translated: string }[] = [];
  for (const [src, translated] of resolved) {
    out[src] = translated;
    rows.push({ hash: hashOf.get(src)!, source: src, translated });
  }
  // Unresolved strings are deliberately left out of both the response map and
  // the cache: the client falls back to English, and the next request retries
  // instead of serving a permanent English placeholder.
  const unresolved = missing.filter((s) => !resolved.has(s));
  if (unresolved.length) {
    console.error(`translate ${locale}: ${unresolved.length}/${missing.length} unresolved, not cached`);
  }
  if (rows.length) {
    // One statement per batch via UNNEST: the driver is a tagged-template client,
    // so a per-row INSERT would mean one round trip per string.
    try {
      await sql`
        INSERT INTO ignis.ui_translation (locale, source_hash, source_en, translated)
        SELECT ${locale}, h, s, tr
          FROM unnest(${rows.map((r) => r.hash)}::text[],
                      ${rows.map((r) => r.source)}::text[],
                      ${rows.map((r) => r.translated)}::text[]) AS x(h, s, tr)
        ON CONFLICT (locale, source_hash) DO NOTHING`;
    } catch (err: any) {
      console.error(`translate cache write: ${String(err?.message ?? err).slice(0, 300)}`);
    }
  }
  return out;
}

/** The tools the agent reports using on each turn, for the session transcript. */
const SESSION_TOOLS = ["memory_recall", "hybrid_retrieve", "grade_evidence", "synthesize", "verify",
  "search_corpus", "compare_experiments", "build_chart", "final_answer", "act", "final", "visualize"];

/**
 * Record one question/answer turn and its agent steps against a conversation.
 *
 * Everything here is derived from a run that already happened; nothing is
 * invented for the transcript.
 */
async function persistSession(env: Env, conversationId: string, question: string, result: any): Promise<void> {
  const sql = db(env);
  const runId = String(result.run_id);
  await sql`INSERT INTO ignis.conversation (id, title, mode)
            VALUES (${conversationId}::uuid, ${question.slice(0, 120)}, 'agent')
            ON CONFLICT (id) DO UPDATE SET updated_at = now()`;
  await sql`INSERT INTO ignis.message (conversation_id, role, content)
            VALUES (${conversationId}::uuid, 'user', ${question})`;
  await sql`INSERT INTO ignis.message (conversation_id, role, content, token_count, latency_ms)
            VALUES (${conversationId}::uuid, 'assistant', ${String(result.answer ?? "")},
                    ${Number(result.total_tokens ?? 0) || null}, ${Number(result.latency_ms ?? 0)})`;
  await sql`INSERT INTO ignis.agent_run (id, conversation_id, question, plan, iterations, status, answer,
                                         answer_confidence, latency_ms, finished_at)
            VALUES (${runId}::uuid, ${conversationId}::uuid, ${question},
                    ${JSON.stringify({ sub_questions: result.sub_questions ?? [] })}::jsonb,
                    1, 'completed', ${String(result.answer ?? "")},
                    ${Number(result.confidence ?? 0)}, ${Number(result.latency_ms ?? 0)}, now())
            ON CONFLICT (id) DO NOTHING`;
  const steps: any[] = Array.isArray(result.trace) ? result.trace : [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    await sql`INSERT INTO ignis.agent_step (run_id, step_index, node, thought, tool, tool_input, latency_ms)
              VALUES (${runId}::uuid, ${i}, ${String(s.node ?? "step")},
                      ${s.verdict ? String(s.verdict) : null},
                      ${SESSION_TOOLS.includes(String(s.node)) ? String(s.node) : null},
                      ${JSON.stringify(s)}::jsonb, ${Number(s.t_ms ?? 0)})`;
  }
  await sql`UPDATE ignis.conversation SET updated_at = now() WHERE id = ${conversationId}::uuid`;
}

/** List conversations that actually hold a transcript. */
async function listSessions(env: Env): Promise<any[]> {
  const sql = db(env);
  return await sql`
    SELECT c.id, c.title, c.mode, c.created_at, c.updated_at,
           (SELECT count(*)::int FROM ignis.message m WHERE m.conversation_id = c.id) AS turns,
           (SELECT count(*)::int FROM ignis.agent_run r WHERE r.conversation_id = c.id) AS runs,
           (SELECT left(m.content, 160) FROM ignis.message m
             WHERE m.conversation_id = c.id AND m.role = 'ASSISTANT'
             ORDER BY m.id DESC LIMIT 1) AS last_answer
      FROM ignis.conversation c
     WHERE EXISTS (SELECT 1 FROM ignis.message m WHERE m.conversation_id = c.id)
     ORDER BY c.updated_at DESC NULLS LAST, c.created_at DESC
     LIMIT 50`;
}

/** Full transcript for one conversation: turns plus the steps behind each run. */
async function getSession(env: Env, id: string): Promise<any | null> {
  const sql = db(env);
  const convo: any[] = await sql`SELECT id, title, mode, created_at, updated_at
                                   FROM ignis.conversation WHERE id = ${id}::uuid`;
  if (!convo.length) return null;
  const messages: any[] = await sql`SELECT id, role, content, created_at
                                      FROM ignis.message WHERE conversation_id = ${id}::uuid
                                      ORDER BY id`;
  const runs: any[] = await sql`SELECT id, question, answer, answer_confidence, latency_ms, status, created_at
                                  FROM ignis.agent_run WHERE conversation_id = ${id}::uuid
                                  ORDER BY created_at`;
  const runIds = runs.map((r) => r.id);
  const steps: any[] = runIds.length
    ? await sql`SELECT run_id, step_index, node, thought, tool, latency_ms
                  FROM ignis.agent_step WHERE run_id = ANY(${runIds}::uuid[])
                  ORDER BY run_id, step_index`
    : [];
  return { conversation: convo[0], messages, runs, steps };
}

/** Vector recall across the session store and the durable long-term store. */
async function memoryRecall(env: Env, query: string, topK: number,
                            conversationId?: string): Promise<{ kind: string; content: string; score: number }[]> {
  const sql = db(env);
  const vec = toPgVector(await embedOne(env, query));
  const longRows: any[] = await sql`SELECT * FROM ignis.recall_long_term(${vec}::text, ${topK}, 0.45)`;
  let sessionRows: any[] = [];
  if (conversationId) {
    sessionRows = await sql`SELECT * FROM ignis.recall_short_term(${vec}::text, ${conversationId}::uuid, ${topK}, 0.45)`;
  }
  return [...sessionRows, ...longRows].map((h) => ({
    kind: h.kind, content: h.content, score: Number(h.score),
  }));
}

/**
 * Persist verified claims as durable findings. Only claims that are both
 * verified and specific enough are kept, so the store does not fill with noise.
 */
async function memoryWrite(env: Env, question: string, claims: any[],
                           conversationId?: string): Promise<number> {
  const keep = (claims ?? [])
    .filter((c) => c?.verified !== false && typeof c?.claim === "string" && c.claim.length >= 40)
    .slice(0, 5);
  if (!keep.length) return 0;
  const sql = db(env);
  let n = 0;
  for (const c of keep) {
    const content = c.claim.slice(0, 2000);
    const vec = toPgVector(await embedOne(env, content));
    const importance = Math.max(0.5, Math.min(0.95, Number(c.support_score ?? 0.7)));
    if (conversationId) {
      await sql`INSERT INTO ignis.short_term_memory (conversation_id, kind, content, embedding, importance)
                VALUES (${conversationId}::uuid, 'finding', ${content}, ${vec}::vector, ${importance})`;
    }
    await sql`INSERT INTO ignis.long_term_memory (kind, content, embedding, importance, source)
              VALUES ('finding', ${content}, ${vec}::vector, ${importance}, ${question.slice(0, 300)})`;
    n++;
  }
  return n;
}

const REPORT_QUESTIONS = [
  "How does flame spread over solid fuels differ in microgravity?",
  "What limits flame extinction and quenching in microgravity?",
  "What is the limiting oxygen concentration for spacecraft fire safety?",
  "How are smoke and soot produced and detected in microgravity?",
  "Which fire suppression agents and methods work in microgravity?",
  "What did the large-scale spacecraft fire experiments (SAFFIRE) show?",
];

const SUMMARY_SYSTEM =
  "You are IGNIS, a scientific research analyst specialising in microgravity combustion " +
  "and spacecraft fire safety. Write the executive summary of a research report. " +
  "Use ONLY the provided findings. Do not introduce facts, numbers, or citations that are " +
  "not present. Cite findings with bracketed numbers like [2]. " +
  'Return JSON: {"summary": string (3-5 short paragraphs, markdown), ' +
  '"limitations": [string], "recommendations": [string]}';

/** Assemble a cited research report from the corpus (mirrors pipeline/report.py). */
async function buildReport(env: Env, topic: string, questions: string[] | undefined,
                           k: number, model: string | undefined, maxQuestions: number | undefined,
                           onProgress?: (event: string, data: any) => void) {
  const t0 = Date.now();
  const sql = db(env);
  let qs = [...(questions?.length ? questions : REPORT_QUESTIONS)];
  if (topic && !qs.includes(topic)) qs.unshift(topic);
  if (maxQuestions) qs = qs.slice(0, maxQuestions);

  const statsRows: any[] = await sql`SELECT * FROM ignis.document_stats`;
  const stats = statsRows[0] ?? {};

  // Each question is researched as a self-contained agent run. They are
  // independent, so run them concurrently; progress is reported as they settle
  // so a streaming caller sees the report grow instead of waiting for all of it.
  let completed = 0;
  const settled = await Promise.all(qs.map(async (q) => {
    try {
      const res = await runAgent(env, q, "fast", model, k, () => {});
      completed++;
      onProgress?.("report_progress", {
        completed, total: qs.length, question: q,
        confidence: res.confidence, grounded: res.grounded,
      });
      return {
        question: q, answer: res.answer, confidence: res.confidence, grounded: res.grounded,
        citations: res.claims, evidence_count: res.evidence.length,
        provider: res.provider, model: res.model, latency_ms: res.latency_ms,
      };
    } catch (err: any) {
      completed++;
      console.error(`report question failed (${q}): ${String(err?.message ?? err).slice(0, 160)}`);
      onProgress?.("report_progress", {
        completed, total: qs.length, question: q, failed: true,
      });
      return null;
    }
  }));
  const findings: any[] = settled.filter(Boolean);

  onProgress?.("report_summary", { questions: findings.length });

  let narrative: { summary: string; limitations: string[]; recommendations: string[] };
  const llmModel = model || "gpt-5.6-sol";
  if (findings.length) {
    const blocks = findings.map((f, i) => `[${i + 1}] ${f.question}\n${String(f.answer).slice(0, 1500)}`);
    try {
      const raw = await llmComplete(
        env, SUMMARY_SYSTEM,
        `Report topic: ${topic}\n\nFindings:\n\n${blocks.join("\n\n")}`, llmModel, true,
        synthBudgets(llmModel)[0],
      );
      const data = parseJsonObject(raw);
      narrative = {
        summary: String(data.summary ?? "").trim(),
        limitations: (data.limitations ?? []).map((x: any) => String(x)).filter((s: string) => s.trim()),
        recommendations: (data.recommendations ?? []).map((x: any) => String(x)).filter((s: string) => s.trim()),
      };
      if (!narrative.summary) throw new Error("empty summary");
    } catch (err: any) {
      console.error(`report summary fallback: ${String(err?.message ?? err).slice(0, 160)}`);
      narrative = fallbackSummary(topic, findings, stats);
    }
  } else {
    narrative = fallbackSummary(topic, findings, stats);
  }

  const evidenceMap = new Map<string, any>();
  for (const f of findings) for (const c of f.citations ?? []) {
    const key = String(c.chunk_id ?? c.source_id ?? "");
    if (key && !evidenceMap.has(key)) {
      evidenceMap.set(key, {
        source_id: c.source_id, title: c.title, section: c.section,
        support_score: c.support_score, quote: c.quote, landing_url: c.landing_url,
      });
    }
  }
  const evidence = [...evidenceMap.values()].sort((a, b) => (b.support_score ?? 0) - (a.support_score ?? 0));
  const sources = [...new Set(evidence.map((e) => e.source_id).filter(Boolean))].sort() as string[];

  return {
    topic,
    generated_at: new Date().toISOString(),
    generator: { provider: "ignis-agent", model: llmModel, chain: [llmModel] },
    corpus: {
      documents: stats.documents, chunks: stats.chunks, words: stats.corpus_words,
      experiments: stats.experiments, findings_indexed: stats.findings,
    },
    summary: narrative.summary,
    key_findings: findings,
    evidence,
    comparative: [],
    limitations: narrative.limitations,
    recommendations: narrative.recommendations,
    references: sources.map((s) => ({ source_id: s, landing_url: `https://ntrs.nasa.gov/citations/${s}` })),
    metrics: {
      questions: findings.length,
      grounded: findings.filter((f) => f.grounded).length,
      citations: findings.reduce((n, f) => n + (f.citations?.length ?? 0), 0),
      unique_sources: sources.length,
      mean_confidence: findings.length
        ? Math.round((findings.reduce((s, f) => s + f.confidence, 0) / findings.length) * 1000) / 1000
        : 0,
      latency_ms: Date.now() - t0,
    },
  };
}

function fallbackSummary(topic: string, findings: any[], stats: any) {
  const grounded = findings.filter((f) => f.grounded);
  const lines = [
    `This report covers **${topic}** across ${stats.documents ?? 0} NASA documents and ` +
    `${stats.chunks ?? 0} indexed passages (${Number(stats.corpus_words ?? 0).toLocaleString()} words).`,
    `${grounded.length} of ${findings.length} research questions returned grounded, cited answers.`,
  ];
  findings.forEach((f, i) => {
    if (f.grounded) {
      const lead = String(f.answer).split("\n\n").find((p: string) => p.length > 80) ?? String(f.answer);
      lines.push(`[${i + 1}] **${f.question}** — ${lead.slice(0, 400)}`);
    }
  });
  return {
    summary: lines.join("\n\n"),
    limitations: [
      "Answers are assembled from retrieved passages; coverage depends on what the corpus contains.",
      "Quantitative values are quoted from the source documents and were not independently re-measured.",
    ],
    recommendations: [] as string[],
  };
}

/** Render a report object to markdown (mirrors pipeline/report.py render_markdown). */
function renderMarkdown(r: any): string {
  const out: string[] = [
    `# IGNIS Research Report — ${r.topic}`, "",
    `*Generated ${r.generated_at} by ${r.generator.provider}/${r.generator.model}*`, "",
    "## Executive Summary", "", r.summary, "",
    "## Corpus", "",
    `- Documents: ${r.corpus.documents}`,
    `- Indexed passages: ${r.corpus.chunks}`,
    `- Words: ${Number(r.corpus.words ?? 0).toLocaleString()}`, "",
    "## Key Findings", "",
  ];
  r.key_findings.forEach((f: any, i: number) => {
    out.push(`### ${i + 1}. ${f.question}`, "");
    out.push(`*Confidence ${f.confidence} · ${f.citations.length} citations · ${f.grounded ? "grounded" : "ungrounded"}*`, "");
    out.push(f.answer, "");
  });
  out.push("## Data Limitations", "");
  r.limitations.forEach((l: string) => out.push(`- ${l}`));
  out.push("");
  if (r.recommendations.length) {
    out.push("## Recommendations", "");
    r.recommendations.forEach((x: string) => out.push(`- ${x}`));
    out.push("");
  }
  out.push("## Evidence Table", "", "| # | NTRS ID | Section | Score | Quote |", "|---|---------|---------|-------|-------|");
  r.evidence.forEach((e: any, i: number) => {
    const quote = String(e.quote ?? "").replace(/\|/g, "/").replace(/\n/g, " ").slice(0, 180);
    out.push(`| ${i + 1} | ${e.source_id} | ${e.section ?? ""} | ${e.support_score} | ${quote} |`);
  });
  out.push("", "## References", "");
  r.references.forEach((x: any) => out.push(`- [${x.source_id}](${x.landing_url})`));
  out.push("", "---", "",
    `*${r.metrics.grounded}/${r.metrics.questions} questions grounded · ${r.metrics.citations} citations · ` +
    `${r.metrics.unique_sources} unique sources · generated in ${r.metrics.latency_ms} ms*`, "");
  return out.join("\n");
}

function push(store: any[], node: string, data: any) {
  store.push({ event: node, data });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method === "GET" && url.pathname === "/locales") {
      return json({ locales: LOCALES, default: "en" });
    }

    if (request.method === "POST" && url.pathname === "/translate") {
      let tbody: any = {};
      try { tbody = await request.json(); } catch { /* ignore */ }
      const locale = String(tbody.locale ?? "en").toLowerCase();
      if (!LOCALE_CODES.has(locale)) {
        return json({ error: `unsupported locale ${locale}`, supported: [...LOCALE_CODES] }, 400);
      }
      const strings: string[] = Array.isArray(tbody.strings)
        ? tbody.strings.slice(0, 400).map((s: any) => String(s ?? "").slice(0, 500))
        : [];
      if (!strings.length) return json({ locale, translations: {}, cached: 0 });
      try {
        const translations = await translateStrings(env, locale, strings);
        return json({ locale, translations });
      } catch (err: any) {
        return json({ error: String(err?.message ?? err) }, 500);
      }
    }

    if (request.method === "GET" && url.pathname === "/health") {
      const started = Date.now();
      try {
        const sql = db(env);
        const rows: any[] = await sql`SELECT * FROM ignis.document_stats`;
        return json({
          status: "ok",
          backend: "live-worker",
          server_time: new Date().toISOString(),
          latency_ms: Date.now() - started,
          stats: numifyOne(rows[0], [
            "documents", "documents_with_fulltext", "chunks", "embeddings",
            "experiments", "findings", "insights", "corpus_words", "corpus_chars",
            "artifact_bytes",
          ]),
        });
      } catch (err: any) {
        return json(
          { status: "error", backend: "live-worker", error: String(err?.message ?? err) },
          503,
        );
      }
    }
    if (request.method === "GET" && url.pathname === "/debug") {
      const target = `${env.IGNIS_GATEWAY_URL}/health`;
      let info: any = { target, tokenSet: Boolean(env.IGNIS_PROXY_TOKEN), bound: Boolean(env.GATEWAY) };
      try {
        const r = await gatewayFetch(env, "/health", { headers: { authorization: `Bearer ${env.IGNIS_PROXY_TOKEN}` } });
        info.status = r.status;
        info.body = (await r.text()).slice(0, 300);
      } catch (e: any) {
        info.error = String(e?.message ?? e);
      }
      return new Response(JSON.stringify(info), { status: 200, headers: { ...cors, "content-type": "application/json" } });
    }
    if (request.method === "GET" && url.pathname === "/debug-llm") {
      let info: any = { model: url.searchParams.get("model") || "gpt-6-astra" };
      try {
        const raw = await llmComplete(env, "Return JSON.", '{"ping": true}', info.model, true, synthBudgets(info.model)[0]);
        info.ok = true;
        info.raw = raw.slice(0, 300);
      } catch (e: any) {
        info.ok = false;
        info.error = String(e?.message ?? e);
      }
      return new Response(JSON.stringify(info), { status: 200, headers: { ...cors, "content-type": "application/json" } });
    }
    // ---- Live read-only data endpoints (Neon over HTTP) ----
    try {
      if (request.method === "GET" && url.pathname === "/stats") {
        const sql = db(env);
        const [stats, byKind, byYear, topDocs, topMetrics, pipeline] = await Promise.all([
          sql`SELECT * FROM ignis.document_stats`,
          sql`SELECT kind, count(*)::int AS n FROM ignis.document GROUP BY kind ORDER BY n DESC`,
          sql`SELECT extract(year FROM published_date)::int AS year, count(*)::int AS n FROM ignis.document WHERE published_date IS NOT NULL GROUP BY 1 ORDER BY 1`,
          sql`SELECT d.id, d.source_id, d.title, d.kind, d.word_count, d.quality_score, d.published_date, d.landing_url, (SELECT count(*)::int FROM ignis.chunk c WHERE c.document_id = d.id) AS chunks FROM ignis.document d ORDER BY d.quality_score DESC NULLS LAST LIMIT 12`,
          sql`SELECT metric, count(*)::int AS n, round(min(value)::numeric,3) AS min_value, round(max(value)::numeric,3) AS max_value, mode() WITHIN GROUP (ORDER BY unit) AS unit FROM ignis.dataset_row GROUP BY metric ORDER BY n DESC LIMIT 12`,
          sql`SELECT stage, status, items_in, items_out, bytes_in, started_at, finished_at FROM ignis.pipeline_run ORDER BY id DESC LIMIT 10`,
        ]);
        return json({
          stats: numifyOne(stats[0], [
            "documents", "documents_with_fulltext", "chunks", "embeddings",
            "experiments", "findings", "insights", "corpus_words", "corpus_chars",
            "artifact_bytes",
          ]),
          byKind: numify(byKind, ["n"]),
          byYear: numify(byYear, ["year", "n"]),
          topDocs: numify(topDocs, ["word_count", "quality_score", "chunks"]),
          topMetrics: numify(topMetrics, ["n", "min_value", "max_value"]),
          pipeline: numify(pipeline, ["items_in", "items_out", "bytes_in"]),
        });
      }
      if (request.method === "GET" && url.pathname === "/experiments") {
        const sql = db(env);
        const [experiments, facilities] = await Promise.all([
          sql`SELECT e.id, e.code, e.name, e.campaign, e.status, e.gravity_level, e.fuel_type, e.ambient_gas, e.o2_fraction, e.pressure_kpa, e.objective, e.summary, e.aliases, f.code AS facility, f.name AS facility_name, f.platform, (SELECT count(*)::int FROM ignis.experiment_document ed WHERE ed.experiment_id = e.id) AS documents, (SELECT count(DISTINCT fi.id)::int FROM ignis.finding fi JOIN ignis.experiment_document ed ON ed.document_id = fi.document_id WHERE ed.experiment_id = e.id) AS findings FROM ignis.experiment e LEFT JOIN ignis.facility f ON f.id = e.facility_id ORDER BY documents DESC, e.code`,
          sql`SELECT f.id, f.code, f.name, f.platform, f.agency, f.g_level, f.description, (SELECT count(*)::int FROM ignis.experiment e WHERE e.facility_id = f.id) AS experiments FROM ignis.facility f ORDER BY f.code`,
        ]);
        return json({
          experiments: numify(experiments, ["o2_fraction", "pressure_kpa", "documents", "findings"]),
          facilities: numify(facilities, ["experiments"]),
        });
      }
      if (request.method === "GET" && url.pathname === "/insights") {
        const sql = db(env);
        const [insights, metrics, coverage] = await Promise.all([
          sql`SELECT id, slug, title, body, category, severity, confidence, supporting_documents, generated_by, created_at FROM ignis.insight ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, confidence DESC`,
          sql`SELECT metric, count(*)::int AS n, round(min(value)::numeric,3) AS min_value, round(max(value)::numeric,3) AS max_value, round(avg(value)::numeric,3) AS avg_value, mode() WITHIN GROUP (ORDER BY unit) AS unit FROM ignis.dataset_row GROUP BY metric ORDER BY n DESC`,
          sql`SELECT e.code, e.name, e.campaign, count(DISTINCT ed.document_id)::int AS documents FROM ignis.experiment e LEFT JOIN ignis.experiment_document ed ON ed.experiment_id = e.id GROUP BY e.code, e.name, e.campaign ORDER BY documents ASC`,
        ]);
        return json({
          insights: numify(insights, ["confidence"]),
          metrics: numify(metrics, ["n", "min_value", "max_value", "avg_value"]),
          coverage: numify(coverage, ["documents"]),
        });
      }
      if (request.method === "GET" && url.pathname === "/documents") {
        const sql = db(env);
        const search = (url.searchParams.get("q") || "").trim();
        const kind = url.searchParams.get("kind") || null;
        const experiment = url.searchParams.get("experiment") || null;
        const limit = Math.min(Number(url.searchParams.get("limit") || 25), 100);
        const offset = Math.max(Number(url.searchParams.get("offset") || 0), 0);
        const rows = await sql`
          WITH filtered AS (
            SELECT d.*, (SELECT count(*)::int FROM ignis.chunk c WHERE c.document_id = d.id) AS chunks
              FROM ignis.document d
             WHERE (${search} = '' OR d.search_tsv @@ websearch_to_tsquery('english', ${search}) OR d.title ILIKE '%' || ${search} || '%')
               AND (${kind}::text IS NULL OR d.kind::text = ${kind})
               AND (${experiment}::text IS NULL OR EXISTS (
                     SELECT 1 FROM ignis.experiment_document ed JOIN ignis.experiment e ON e.id = ed.experiment_id
                      WHERE ed.document_id = d.id AND (lower(e.code) = lower(${experiment}) OR ${experiment} = ANY(e.aliases))))
          )
          SELECT id, source_id, title, kind, abstract, authors, published_date, word_count, quality_score, has_fulltext, landing_url, chunks
            FROM filtered ORDER BY quality_score DESC NULLS LAST, id LIMIT ${limit} OFFSET ${offset}`;
        const total = await sql`
          SELECT count(*)::int AS n FROM ignis.document d
           WHERE (${search} = '' OR d.search_tsv @@ websearch_to_tsquery('english', ${search}) OR d.title ILIKE '%' || ${search} || '%')
             AND (${kind}::text IS NULL OR d.kind::text = ${kind})
             AND (${experiment}::text IS NULL OR EXISTS (
                   SELECT 1 FROM ignis.experiment_document ed JOIN ignis.experiment e ON e.id = ed.experiment_id
                    WHERE ed.document_id = d.id AND (lower(e.code) = lower(${experiment}) OR ${experiment} = ANY(e.aliases))))`;
        return json({
          documents: numify(rows, ["word_count", "quality_score", "chunks"]),
          total: Number(total[0]?.n ?? 0), limit, offset,
        });
      }
      const expMatch = url.pathname.match(/^\/experiments\/([^/]+)$/);
      if (request.method === "GET" && expMatch) {
        const sql = db(env);
        const code = decodeURIComponent(expMatch[1]);
        const rows: any[] = await sql`SELECT e.*, f.code AS facility, f.name AS facility_name, f.platform, f.g_level FROM ignis.experiment e LEFT JOIN ignis.facility f ON f.id = e.facility_id WHERE lower(e.code) = lower(${code}) OR ${code} = ANY(e.aliases) LIMIT 1`;
        if (!rows.length) return json({ error: `experiment ${code} not found` }, 404);
        const experiment = rows[0];
        const documents: any[] = await sql`SELECT d.id, d.source_id, d.title, d.kind, d.published_date, d.word_count, d.quality_score, d.landing_url, ed.relation FROM ignis.experiment_document ed JOIN ignis.document d ON d.id = ed.document_id WHERE ed.experiment_id = ${experiment.id} ORDER BY d.quality_score DESC NULLS LAST LIMIT 50`;
        const findings: any[] = await sql`SELECT f.id, f.metric, f.value, f.value_max, f.unit, f.statement, f.confidence, f.evidence_quote, f.document_id FROM ignis.finding f JOIN ignis.experiment_document ed ON ed.document_id = f.document_id WHERE ed.experiment_id = ${experiment.id} ORDER BY f.metric, f.value LIMIT 200`;
        return json({
          experiment: numifyOne(experiment, ["o2_fraction", "pressure_kpa", "documents", "findings"]),
          documents: numify(documents, ["word_count", "quality_score"]),
          findings: numify(findings, ["value", "value_max", "confidence"]),
        });
      }

      const docMatch = url.pathname.match(/^\/documents\/([^/]+)$/);
      if (request.method === "GET" && docMatch) {
        const documentId = Number(decodeURIComponent(docMatch[1]));
        if (!Number.isFinite(documentId)) return json({ error: "invalid document id" }, 400);
        const sql = db(env);
        const docs: any[] = await sql`SELECT id, source, source_id, kind, title, abstract, authors, report_numbers, center, distribution, keywords, subject_categories, published_date, word_count, char_count, quality_score, landing_url FROM ignis.document WHERE id = ${documentId}`;
        if (!docs.length) return json({ error: "document not found" }, 404);
        const chunks: any[] = await sql`SELECT c.id, c.ordinal, c.kind, c.section_path, c.token_count, left(c.content, 600) AS preview, EXISTS (SELECT 1 FROM ignis.chunk_embedding e WHERE e.chunk_id = c.id) AS embedded FROM ignis.chunk c WHERE c.document_id = ${documentId} ORDER BY c.ordinal`;
        const findings: any[] = await sql`SELECT id, metric, value, value_max, unit, statement, confidence, evidence_quote FROM ignis.finding WHERE document_id = ${documentId} ORDER BY metric LIMIT 100`;
        const experiments: any[] = await sql`SELECT e.code, e.name, ed.relation FROM ignis.experiment_document ed JOIN ignis.experiment e ON e.id = ed.experiment_id WHERE ed.document_id = ${documentId}`;
        return json({
          document: numifyOne(docs[0], ["word_count", "char_count", "quality_score"]),
          chunks: numify(chunks, ["ordinal", "token_count"]),
          findings: numify(findings, ["value", "value_max", "confidence"]),
          experiments,
        });
      }

      if (request.method === "GET" && url.pathname === "/datasets") {
        const sql = db(env);
        const rows = await sql`
          SELECT key, name, canonical_unit, value_count, document_count,
                 recorded_unit_count, recorded_units, value_min, value_max,
                 ranged_value_count, mean_confidence, extraction_methods
            FROM ignis.dataset
           ORDER BY value_count DESC, name`;
        const total = rows.reduce((n: number, r: any) => n + Number(r.value_count ?? 0), 0);
        return json({
          datasets: numify(rows, [
            "value_count", "document_count", "recorded_unit_count",
            "value_min", "value_max", "ranged_value_count", "mean_confidence",
          ]),
          total_measurements: total,
        });
      }

      const dsMatch = url.pathname.match(/^\/datasets\/([^/]+)$/);
      if (request.method === "GET" && dsMatch) {
        const sql = db(env);
        const key = decodeURIComponent(dsMatch[1]);
        const meta: any[] = await sql`SELECT * FROM ignis.dataset WHERE key = ${key} LIMIT 1`;
        if (!meta.length) return json({ error: `dataset ${key} not found` }, 404);
        const limit = Math.min(Number(url.searchParams.get("limit") || 200), 1000);
        const rows: any[] = await sql`
          SELECT finding_id, value, unit, raw_value, raw_unit, value_max, statement,
                 evidence_quote, confidence, extraction_method, document_id,
                 document_source_id, document_title, landing_url,
                 experiment_code, experiment_name
            FROM ignis.dataset_row
           WHERE dataset_key = ${key}
           ORDER BY value
           LIMIT ${limit}`;
        // Statistics come from SQL, not the client, so the UI cannot accidentally
        // present a number that was computed over a truncated page of rows.
        const stats: any[] = await sql`
          SELECT count(*)::int AS n, round(min(value)::numeric,4) AS min_value,
                 round(max(value)::numeric,4) AS max_value,
                 round(avg(value)::numeric,4) AS mean_value,
                 round(stddev_samp(value)::numeric,4) AS sd_value,
                 round(percentile_cont(0.5) WITHIN GROUP (ORDER BY value)::numeric,4) AS median_value
            FROM ignis.dataset_row WHERE dataset_key = ${key}`;
        const histogram: any[] = await sql`
          WITH b AS (SELECT width_bucket(value, min(value) OVER (), max(value) OVER (), 10) AS bucket, value FROM ignis.dataset_row WHERE dataset_key = ${key})
          SELECT bucket, count(*)::int AS n, round(min(value)::numeric,4) AS lo, round(max(value)::numeric,4) AS hi
            FROM b GROUP BY bucket ORDER BY bucket`;
        return json({
          dataset: numifyOne(meta[0], [
            "value_count", "document_count", "recorded_unit_count",
            "value_min", "value_max", "ranged_value_count", "mean_confidence",
          ]),
          rows: numify(rows, ["value", "raw_value", "value_max", "confidence"]),
          stats: numifyOne(stats[0], ["n", "min_value", "max_value", "mean_value", "sd_value", "median_value"]),
          histogram: numify(histogram, ["bucket", "n", "lo", "hi"]),
        });
      }

      if (request.method === "GET" && url.pathname === "/global-search") {
        const sql = db(env);
        const query = (url.searchParams.get("q") || "").trim();
        if (!query) return json({ query, experiments: [], datasets: [], documents: [], findings: [] });
        const like = `%${query}%`;
        const [experiments, datasets, documents, findings] = await Promise.all([
          sql`SELECT code, name, campaign, objective FROM ignis.experiment
               WHERE code ILIKE ${like} OR name ILIKE ${like} OR objective ILIKE ${like} OR ${query} = ANY(aliases)
               ORDER BY code LIMIT 8`,
          sql`SELECT key, name, canonical_unit, value_count FROM ignis.dataset
               WHERE name ILIKE ${like} OR key ILIKE ${like} ORDER BY value_count DESC LIMIT 8`,
          sql`SELECT id, source_id, title, kind, landing_url FROM ignis.document
               WHERE title ILIKE ${like} OR abstract ILIKE ${like} OR search_tsv @@ websearch_to_tsquery('english', ${query})
               ORDER BY quality_score DESC NULLS LAST LIMIT 10`,
          sql`SELECT f.id, f.metric, f.value, f.unit, f.statement, f.document_id, f.evidence_quote
                 FROM ignis.finding f
                WHERE f.statement ILIKE ${like} OR f.metric ILIKE ${like}
                ORDER BY f.metric LIMIT 10`,
        ]);
        return json({ query, experiments, datasets, documents, findings });
      }

      if (request.method === "GET" && url.pathname === "/search") {
        const query = (url.searchParams.get("q") || "").trim();
        const k = Math.min(Number(url.searchParams.get("k") || 12), 50);
        if (!query) return json({ query: "", hits: [] });
        const hits = await retrieve(env, query, k);
        return json({ query, hits: hits.map((h) => ({ ...h })) });
      }

      // Smart Ranking explainer: the full pipeline with every score exposed so a
      // reviewer can see why a passage ranked where it did.
      if (request.method === "GET" && url.pathname === "/rank") {
        const query = (url.searchParams.get("q") || "").trim();
        const k = Math.min(Number(url.searchParams.get("k") || 10), 30);
        if (!query) return json({ error: "q is required" }, 400);
        const t0 = Date.now();
        const qvec = await embedOne(env, query);
        // Fetch a wide candidate pool so ranking has something to reorder; the
        // user-facing k only bounds the final diversified selection.
        const raw = await hybridSearch(env, query, qvec, 60, 80);
        rerank(query, raw);
        const ranked = smartRank([...raw], query);
        const diversified = mmrDiversify([...ranked], k);
        const grade = heuristicGrade(diversified);
        const kept = new Set(diversified.map((h) => h.chunk_id));
        return json({
          query,
          k,
          weights: RANK_WEIGHTS,
          pool: raw.length,
          latency_ms: Date.now() - t0,
          verdict: grade.verdict,
          grade_score: Number(grade.score.toFixed(4)),
          hits: ranked.map((h, i) => ({
            ...h,
            pre_rank: i + 1,
            diversified: kept.has(h.chunk_id),
          })),
        });
      }
    } catch (err: any) {
      return json({ error: String(err?.message ?? err) }, 500);
    }

    if (request.method === "GET" && url.pathname === "/sessions") {
      try {
        return json({ sessions: await listSessions(env) });
      } catch (err: any) {
        return json({ error: String(err?.message ?? err) }, 500);
      }
    }

    const sessMatch = url.pathname.match(/^\/sessions\/([0-9a-fA-F-]{36})$/);
    if (request.method === "GET" && sessMatch) {
      try {
        const s = await getSession(env, sessMatch[1]);
        if (!s) return json({ error: "session not found" }, 404);
        return json(s);
      } catch (err: any) {
        return json({ error: String(err?.message ?? err) }, 500);
      }
    }

    if (request.method === "DELETE" && sessMatch) {
      try {
        const sql = db(env);
        await sql`DELETE FROM ignis.conversation WHERE id = ${sessMatch[1]}::uuid`;
        return json({ deleted: sessMatch[1] });
      } catch (err: any) {
        return json({ error: String(err?.message ?? err) }, 500);
      }
    }

    if (request.method === "GET" && url.pathname === "/memory") {
      try {
        const sql = db(env);
        const query = (url.searchParams.get("query") || "").trim();
        const conversationId = url.searchParams.get("conversation_id") || null;
        let recalled: any[] = [];
        if (query) {
          const vec = toPgVector(await embedOne(env, query));
          const rows: any[] = conversationId
            ? await sql`SELECT * FROM ignis.recall_short_term(${vec}::text, ${conversationId}::uuid, 8, 0.35)`
            : [];
          const longRows: any[] = await sql`SELECT * FROM ignis.recall_long_term(${vec}::text, 8, 0.35)`;
          recalled = [
            ...rows.map((h) => ({ id: h.id, kind: h.kind, content: h.content, importance: h.importance, score: Math.round(Number(h.score) * 10000) / 10000, created_at: String(h.created_at) })),
            ...longRows.map((h) => ({ id: h.id, kind: h.kind, content: h.content, importance: h.importance, score: Math.round(Number(h.score) * 10000) / 10000, created_at: String(h.created_at) })),
          ];
        }
        const recent: any[] = await sql`SELECT id, kind, content, importance, confidence, hit_count, created_at FROM ignis.long_term_memory ORDER BY (importance * ln(hit_count + 1)) DESC, last_hit_at DESC LIMIT 30`;
        const session: any[] = conversationId
          ? await sql`SELECT id, kind, content, importance, created_at FROM ignis.short_term_memory WHERE conversation_id = ${conversationId}::uuid AND (expires_at IS NULL OR expires_at > now()) ORDER BY created_at DESC LIMIT 30`
          : [];
        const lt: any[] = await sql`SELECT count(*) AS n FROM ignis.long_term_memory`;
        const st: any[] = await sql`SELECT count(*) AS n FROM ignis.short_term_memory`;
        return json({ recalled, recent, session, stats: { long_term: Number(lt[0]?.n ?? 0), short_term: Number(st[0]?.n ?? 0) } });
      } catch (err: any) {
        return json({ error: String(err?.message ?? err) }, 500);
      }
    }

    if (request.method === "POST" && url.pathname === "/memory") {
      let mbody: any = {};
      try { mbody = await request.json(); } catch { /* ignore */ }
      const content = String(mbody.content ?? "").trim();
      if (!content) return json({ error: "content is required" }, 400);
      try {
        const sql = db(env);
        const vec = toPgVector(await embedOne(env, content));
        const kind = String(mbody.kind ?? "fact");
        const importance = Number(mbody.importance ?? 0.6);
        let id: number | null = null;
        if (mbody.conversation_id) {
          const rows: any[] = await sql`INSERT INTO ignis.short_term_memory (conversation_id, kind, content, embedding, importance) VALUES (${mbody.conversation_id}::uuid, ${kind}, ${content.slice(0, 4000)}, ${vec}::vector, ${importance}) RETURNING id`;
          id = rows[0]?.id ?? null;
        } else {
          const rows: any[] = await sql`INSERT INTO ignis.long_term_memory (kind, content, embedding, importance) VALUES (${kind}, ${content.slice(0, 4000)}, ${vec}::vector, ${importance}) RETURNING id`;
          id = rows[0]?.id ?? null;
        }
        return json({ id, stored: id !== null });
      } catch (err: any) {
        return json({ error: String(err?.message ?? err) }, 500);
      }
    }

    if (request.method === "POST" && url.pathname === "/report") {
      let rbody: any = {};
      try { rbody = await request.json(); } catch { /* ignore */ }
      const topic = String(rbody.topic ?? "").trim();
      if (!topic) return json({ error: "missing 'topic'" }, 400);

      // Streaming form: emit one event per finished question, then the report.
      // A six-question report cannot fit in a single response budget, so the
      // dashboard reads progress and renders the report as it completes.
      if (rbody.stream) {
        return sseResponse(async (emit) => {
          const report = await buildReport(env, topic, rbody.questions, Number(rbody.k ?? 8),
                                           rbody.model, rbody.max_questions, emit);
          emit("done", { report, markdown: renderMarkdown(report) });
        });
      }

      try {
        const report = await buildReport(
          env, topic, rbody.questions, Number(rbody.k ?? 8),
          rbody.model, rbody.max_questions,
        );
        return json({ report, markdown: renderMarkdown(report) });
      } catch (err: any) {
        return json({ error: String(err?.message ?? err) }, 500);
      }
    }

    // ---- Export: turn markdown into a downloadable PDF or DOCX ----
    if (request.method === "POST" && url.pathname === "/export") {
      let ebody: any = {};
      try { ebody = await request.json(); } catch { /* ignore */ }
      const md = String(ebody.markdown ?? "");
      if (!md.trim()) return json({ error: "markdown is required" }, 400);
      const format = String(ebody.format ?? "pdf").toLowerCase();
      const name = safeFilename(String(ebody.filename ?? ebody.title ?? "ignis-report"));
      // Charts are supplied as specs so the writer can render them for the
      // target format: vector operators for PDF, a PNG for DOCX.
      const charts: ChartSpec[] = Array.isArray(ebody.charts) ? ebody.charts : [];
      const title = String(ebody.title ?? "IGNIS Research Report");
      try {
        if (format === "docx") {
          return new Response(await markdownToDocx(md, title, charts), {
            headers: {
              ...cors,
              "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              "content-disposition": `attachment; filename="${name}.docx"`,
            },
          });
        }
        if (format === "md") {
          return new Response(md, {
            headers: {
              ...cors, "content-type": "text/markdown; charset=utf-8",
              "content-disposition": `attachment; filename="${name}.md"`,
            },
          });
        }
        if (format !== "pdf") return json({ error: `unsupported format '${format}'` }, 400);
        return new Response(markdownToPdf(md, title, charts), {
          headers: {
            ...cors, "content-type": "application/pdf",
            "content-disposition": `attachment; filename="${name}.pdf"`,
          },
        });
      } catch (err: any) {
        return json({ error: String(err?.message ?? err) }, 500);
      }
    }

    // ---- Visualisation: build a chart from real measured values ----
    //
    // The agent calls this instead of inventing numbers: it selects a dataset
    // from `ignis.dataset_row`, so every plotted point is a recorded
    // measurement. Returns the SVG for inline display plus the spec the export
    // endpoint needs to embed the same chart in a PDF or DOCX.
    if (request.method === "POST" && url.pathname === "/visualize") {
      let vbody: any = {};
      try { vbody = await request.json(); } catch { /* ignore */ }
      const datasetKey = String(vbody.dataset ?? "").trim();
      if (!datasetKey) {
        return json({ error: "missing 'dataset'", hint: "call /datasets for available keys" }, 400);
      }
      const chartType = String(vbody.type ?? "bar");
      if (!["bar", "line", "scatter"].includes(chartType)) {
        return json({ error: `unsupported chart type '${chartType}'` }, 400);
      }
      const limit = Math.min(Math.max(Number(vbody.limit ?? 20), 2), 60);
      try {
        const sql = db(env);
        const meta: any[] = await sql`SELECT * FROM ignis.dataset WHERE key = ${datasetKey} LIMIT 1`;
        if (!meta.length) {
          return json({ error: `dataset ${datasetKey} not found`, hint: "call /datasets for available keys" }, 404);
        }
        const unit = meta[0].canonical_unit ?? "";

        // group_by=experiment compares experiments on one axis; otherwise plot
        // the recorded values in order.
        let rows: any[];
        if (vbody.group_by === "experiment") {
          rows = await sql`
            SELECT coalesce(experiment_code, 'unlinked') AS label,
                   count(*)::int AS n,
                   round(avg(value)::numeric, 4) AS value
              FROM ignis.dataset_row
             WHERE dataset_key = ${datasetKey}
             GROUP BY 1 ORDER BY value DESC LIMIT ${limit}`;
        } else {
          rows = await sql`
            SELECT coalesce(experiment_code, document_source_id, 'recorded') AS label, value
              FROM ignis.dataset_row
             WHERE dataset_key = ${datasetKey}
             ORDER BY value LIMIT ${limit}`;
        }
        if (!rows.length) return json({ error: `dataset ${datasetKey} has no rows` }, 404);

        const spec: ChartSpec = {
          type: chartType as ChartSpec["type"],
          title: String(vbody.title ?? `${meta[0].name}${vbody.group_by === "experiment" ? " by experiment" : ""}`),
          x_label: String(vbody.x_label ?? (vbody.group_by === "experiment" ? "experiment" : "measurement (ordered by value)")),
          y_label: String(vbody.y_label ?? meta[0].name),
          unit,
          series: [{ label: meta[0].name, points: rows.map((r, i) => ({ x: chartType === "bar" ? String(r.label) : i + 1, y: Number(r.value) })) }],
          source_note: `${rows.length} recorded values from NASA NTRS reports · extracted by regex · unit ${unit || "n/a"}`,
        };

        return json({
          spec,
          svg: renderSvg(spec),
          dataset: meta[0],
          rows,
          note: "Values are measurements mined from NTRS report text, not a curated NASA dataset.",
        });
      } catch (err: any) {
        return json({ error: String(err?.message ?? err) }, 500);
      }
    }

    if (request.method === "POST" && url.pathname === "/compare") {
      let cbody: any = {};
      try { cbody = await request.json(); } catch { /* ignore */ }
      const codes: string[] = (cbody.experiments || []).filter(Boolean);
      if (!codes.length) return json({ error: "provide at least one experiment code" }, 400);
      try {
        return json(await compareExperiments(env, codes, cbody.topic || null));
      } catch (err: any) {
        return json({ error: String(err?.message ?? err) }, 500);
      }
    }

    if (request.method !== "POST" || (url.pathname !== "/ask" && url.pathname !== "/ask-sync")) {
      return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: { ...cors, "content-type": "application/json" } });
    }

    let body: any = {};
    try { body = await request.json(); } catch { /* ignore */ }
    const question = String(body.question ?? "").trim();
    if (!question) {
      return new Response(JSON.stringify({ error: "missing question" }), { status: 400, headers: { ...cors, "content-type": "application/json" } });
    }
    const mode: "fast" | "deep" = body.mode === "deep" ? "deep" : "fast";
    const model = typeof body.model === "string" && body.model ? body.model : undefined;
    const k = Number(body.k) > 0 ? Number(body.k) : 8;
    const conversationId = typeof body.conversation_id === "string" && body.conversation_id
      ? body.conversation_id : undefined;

    // The agentic loop is the default because it lets the model choose its own
    // retrieval path. `pipeline=1` keeps the older fixed plan->retrieve->synth
    // route reachable for comparison and as a fallback.
    const usePipeline = url.searchParams.get("pipeline") === "1";
    const runner = usePipeline ? runAgent : runAgentic;

    // Non-streaming JSON form for programmatic callers.
    if (url.pathname === "/ask-sync") {
      try {
        const result = await runner(env, question, mode, model, k, () => {}, conversationId);
        return json(result);
      } catch (err: any) {
        return json({ error: String(err?.message ?? err) }, 500);
      }
    }

    return sseResponse((emit) =>
      runner(env, question, mode, model, k, emit, conversationId)
        .then((result) => emit("done", result)));
  },
};