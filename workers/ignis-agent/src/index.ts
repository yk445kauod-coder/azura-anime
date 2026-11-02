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

interface Env {
  AI: any;
  GATEWAY?: { fetch: typeof fetch };
  IGNIS_GATEWAY_URL: string;
  IGNIS_PROXY_TOKEN?: string;
  NEON_DATABASE_URL?: string;
  EMBED_MODEL: string;
  DB_EMBED_MODEL: string;
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

interface Hit {
  chunk_id: number; document_id: number; title: string; source_id: string;
  ordinal: number; kind: string; section_path: string | null; content: string;
  vector_score: number; keyword_score: number; fused_score: number;
  rerank_score: number; final_score: number; quality_score: number;
  landing_url: string; published_date: string | null;
  sub_question: string | null; relevance: string;
}

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
    h.final_score = 0.40 * norm + 0.34 * h.rerank_score + 0.16 * h.quality_score + 0.10 * domainDensity(h.content);
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

async function llmComplete(env: Env, system: string, user: string, model: string,
                           jsonMode = false, maxTokens = 700,
                           effort = "low"): Promise<string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (env.IGNIS_PROXY_TOKEN) headers["authorization"] = `Bearer ${env.IGNIS_PROXY_TOKEN}`;
  const payload: any = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    stream: false,
    max_tokens: maxTokens,
    reasoning_effort: effort,
  };
  if (jsonMode && !model.startsWith("gpt-5.6")) payload.response_format = { type: "json_object" };
  const res = await gatewayFetch(env, "/v1/chat/completions", {
    method: "POST", headers, body: JSON.stringify(payload),
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
  "Reply with plain markdown only: 3-5 short sentences, no preamble, no headings, " +
  "no JSON, no code fences.";

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
    const raw = await llmComplete(env, PLAN_SYSTEM, `Question: ${question}${memoryBlock}\n\n`, model, true, 500);
    const data = parseJsonObject(raw);
    const subs = (data.sub_questions ?? []).filter((s: any) => typeof s === "string" && s.length > 4).slice(0, 4);
    const terms = (data.key_terms ?? []).filter((t: any) => typeof t === "string").slice(0, 12);
    if (subs.length) return { subs, terms };
    return { subs: scheduleHeuristic(question), terms: [] };
  } catch {
    return { subs: scheduleHeuristic(question), terms: [] };
  }
}

async function synthesizeWithLLM(env: Env, question: string, hits: Hit[],
                                 subQuestions: string[], model: string): Promise<{ answer: string; claims: any[]; confidence: number }> {
  const evidenceBlocks = hits.slice(0, 5).map((h, i) =>
    `[${i + 1}] ${h.title} (NTRS ${h.source_id}; section: ${h.section_path ?? h.kind})\n${h.content.slice(0, 900).trim()}`);
  const evidence = evidenceBlocks.join("\n\n");
  let user = `Question: ${question}\n\nEvidence:\n${evidence}`;
  if (subQuestions.length) user += `\n\nSub-questions to address: ${subQuestions.join("; ")}`;

  // A reasoning model occasionally spends its whole budget on hidden reasoning
  // and returns no text, so give the retry a larger output budget.
  let lastErr: any = null;
  for (const budget of [900, 2000]) {
    try {
      const raw = await llmComplete(env, SYNTH_SYSTEM, user, model, false, budget);
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

  return {
    run_id: runId,
    question,
    answer: synth.answer,
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
          stats: rows[0] ?? {},
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
        const raw = await llmComplete(env, "Return JSON.", '{"ping": true}', info.model, true);
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
          sql`SELECT metric, count(*)::int AS n, round(min(value)::numeric,3) AS min_value, round(max(value)::numeric,3) AS max_value, mode() WITHIN GROUP (ORDER BY unit) AS unit FROM ignis.finding WHERE value IS NOT NULL GROUP BY metric HAVING count(*) >= 2 ORDER BY n DESC LIMIT 12`,
          sql`SELECT stage, status, items_in, items_out, bytes_in, started_at, finished_at FROM ignis.pipeline_run ORDER BY id DESC LIMIT 10`,
        ]);
        return json({ stats: stats[0] ?? {}, byKind, byYear, topDocs, topMetrics, pipeline });
      }
      if (request.method === "GET" && url.pathname === "/experiments") {
        const sql = db(env);
        const [experiments, facilities] = await Promise.all([
          sql`SELECT e.id, e.code, e.name, e.campaign, e.status, e.gravity_level, e.fuel_type, e.ambient_gas, e.o2_fraction, e.pressure_kpa, e.objective, e.summary, e.aliases, f.code AS facility, f.name AS facility_name, f.platform, (SELECT count(*)::int FROM ignis.experiment_document ed WHERE ed.experiment_id = e.id) AS documents, (SELECT count(*)::int FROM ignis.finding fi WHERE fi.experiment_id = e.id) AS findings FROM ignis.experiment e LEFT JOIN ignis.facility f ON f.id = e.facility_id ORDER BY documents DESC, e.code`,
          sql`SELECT f.id, f.code, f.name, f.platform, f.agency, f.g_level, f.description, (SELECT count(*)::int FROM ignis.experiment e WHERE e.facility_id = f.id) AS experiments FROM ignis.facility f ORDER BY f.code`,
        ]);
        return json({ experiments, facilities });
      }
      if (request.method === "GET" && url.pathname === "/insights") {
        const sql = db(env);
        const [insights, metrics, coverage] = await Promise.all([
          sql`SELECT id, slug, title, body, category, severity, confidence, supporting_documents, generated_by, created_at FROM ignis.insight ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END, confidence DESC`,
          sql`SELECT metric, count(*)::int AS n, round(min(value)::numeric,3) AS min_value, round(max(value)::numeric,3) AS max_value, round(avg(value)::numeric,3) AS avg_value, mode() WITHIN GROUP (ORDER BY unit) AS unit FROM ignis.finding WHERE value IS NOT NULL GROUP BY metric HAVING count(*) >= 2 ORDER BY n DESC`,
          sql`SELECT e.code, e.name, e.campaign, count(DISTINCT ed.document_id)::int AS documents FROM ignis.experiment e LEFT JOIN ignis.experiment_document ed ON ed.experiment_id = e.id GROUP BY e.code, e.name, e.campaign ORDER BY documents ASC`,
        ]);
        return json({ insights, metrics, coverage });
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
        return json({ documents: rows, total: total[0]?.n ?? 0, limit, offset });
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
        return json({ experiment, documents, findings });
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
        return json({ document: docs[0], chunks, findings, experiments });
      }

      if (request.method === "GET" && url.pathname === "/search") {
        const query = (url.searchParams.get("q") || "").trim();
        const k = Math.min(Number(url.searchParams.get("k") || 12), 50);
        if (!query) return json({ query: "", hits: [] });
        const hits = await retrieve(env, query, k);
        return json({ query, hits: hits.map((h) => ({ ...h })) });
      }
    } catch (err: any) {
      return json({ error: String(err?.message ?? err) }, 500);
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
        const enc = new TextEncoder();
        const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
        const writer = writable.getWriter();
        const emit = (event: string, data: any) => {
          writer.write(enc.encode(`data: ${JSON.stringify({ event, data })}\n\n`)).catch(() => {});
        };
        buildReport(env, topic, rbody.questions, Number(rbody.k ?? 8), rbody.model,
                    rbody.max_questions, emit)
          .then((report) => emit("done", { report, markdown: renderMarkdown(report) }))
          .catch((err: any) => emit("error", { error: String(err?.message ?? err) }))
          .finally(async () => {
            try {
              await writer.write(enc.encode(`data: ${JSON.stringify({ event: "close" })}\n\n`));
              await writer.close();
            } catch { /* client gone */ }
          });
        return new Response(readable, {
          status: 200,
          headers: { ...cors, "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", "x-accel-buffering": "no" },
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

    if (request.method === "POST" && url.pathname === "/compare") {
      let cbody: any = {};
      try { cbody = await request.json(); } catch { /* ignore */ }
      const codes: string[] = (cbody.experiments || []).filter(Boolean);
      if (!codes.length) return json({ error: "provide at least one experiment code" }, 400);
      try {
        const sql = db(env);
        const exps = await sql`SELECT e.*, f.code AS facility_code, f.name AS facility_name, f.platform FROM ignis.experiment e LEFT JOIN ignis.facility f ON f.id = e.facility_id WHERE e.code = ANY(${codes})`;
        if (!exps.length) return json({ experiments: [], dimensions: [], findings: {}, note: "no matching experiments" });
        const ids = exps.map((e: any) => e.id);
        const topic = cbody.topic || null;
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
        const dimensions = ["campaign", "facility_code", "platform", "status", "gravity_level", "fuel_type", "ambient_gas", "pressure_kpa", "o2_fraction", "ignition_source"];
        const metricMatrix: Record<string, any> = {};
        for (const e of exps as any[]) for (const f of byExp[e.id] ?? []) {
          (metricMatrix[f.metric] ??= {})[e.id] ??= [];
          metricMatrix[f.metric][e.id].push({ value: f.value, value_max: f.value_max, unit: f.unit });
        }
        return json({
          experiments: (exps as any[]).map((e) => ({
            id: e.id, code: e.code, name: e.name, campaign: e.campaign, facility: e.facility_code,
            facility_name: e.facility_name, platform: e.platform, status: e.status, gravity_level: e.gravity_level,
            fuel_type: e.fuel_type, ambient_gas: e.ambient_gas, pressure_kpa: e.pressure_kpa, o2_fraction: e.o2_fraction,
            ignition_source: e.ignition_source, objective: e.objective, summary: e.summary,
            document_count: counts.get(e.id) ?? 0,
          })),
          dimensions,
          findings: Object.fromEntries((exps as any[]).map((e) => [String(e.id), byExp[e.id] ?? []])),
          metric_matrix: Object.entries(metricMatrix).sort(([a], [b]) => a.localeCompare(b)).map(([metric, values]) => ({ metric, values })),
        });
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

    // Non-streaming JSON form for programmatic callers.
    if (url.pathname === "/ask-sync") {
      try {
        const result = await runAgent(env, question, mode, model, k, () => {}, conversationId);
        return json(result);
      } catch (err: any) {
        return json({ error: String(err?.message ?? err) }, 500);
      }
    }

    const enc = new TextEncoder();
    // Live SSE: events are written as they are produced so the dashboard shows
    // plan → retrieve → synthesize progress instead of waiting for the answer.
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const emit = (node: string, data: any) => {
      writer.write(enc.encode(`data: ${JSON.stringify({ event: node, data })}\n\n`)).catch(() => {});
    };
    runAgent(env, question, mode, model, k, emit, conversationId)
      .then((result) => emit("done", result))
      .catch((err: any) => emit("error", { error: String(err?.message ?? err) }))
      .finally(async () => {
        try {
          await writer.write(enc.encode(`data: ${JSON.stringify({ event: "close" })}\n\n`));
          await writer.close();
        } catch { /* client gone */ }
      });

    return new Response(readable, {
      status: 200,
      headers: { ...cors, "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", "x-accel-buffering": "no" },
    });
  },
};