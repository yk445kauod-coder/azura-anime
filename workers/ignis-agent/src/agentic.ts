/**
 * IGNIS agentic loop.
 *
 * The model drives its own investigation: it chooses a retrieval query, reads
 * the graded evidence that comes back, and decides whether to keep searching or
 * answer. That is a real ReAct loop over the same corpus the single-shot agent
 * uses, not a fixed pipeline with an extra LLM call bolted on.
 *
 * Astra (`gpt-6-astra`) is the reasoning core here because the loop is the one
 * place where model quality compounds: every weak query costs a whole wasted
 * retrieval round trip, and every missed observation becomes a wrong citation.
 */

export type LoopHit = {
  chunk_id: number;
  document_id: number;
  title: string;
  source_id: string;
  kind: string;
  section_path: string | null;
  content: string;
  final_score: number;
  landing_url: string;
  [k: string]: unknown;
};

export type LoopToolName = "search_corpus" | "recall_memory" | "compare_experiments" | "build_chart" | "final_answer";

/** A tool call the model asked for, already resolved to data. */
export type ToolOutcome = {
  tool: LoopToolName;
  input: any;
  /** Compact text handed back to the model as the observation. */
  observation: string;
  /** Evidence surfaced by this call, kept for citation and display. */
  hits?: LoopHit[];
  /** Set when the call produced a figure, so the caller can attach it. */
  chart?: { dataset: string; type: string; points: number };
  error?: string;
};

export type LoopStep = {
  iteration: number;
  thought: string;
  tool: LoopToolName;
  input: any;
  observation_chars: number;
  n_evidence: number;
  error?: string;
};

export type LoopResult = {
  answer: string;
  steps: LoopStep[];
  hits: LoopHit[];
  chartRequest: { dataset: string; type: "bar" | "line" | "scatter" } | null;
  stopReason: "final_answer" | "budget" | "deadline" | "parse_error" | "model_error" | "forced_synthesis";
  promptTokens: number;
  completionTokens: number;
  iterations: number;
  lastError?: string;
};

export type LoopDeps = {
  /** Hybrid retrieval over the NTRS corpus. */
  search: (query: string, k: number) => Promise<LoopHit[]>;
  /** Durable cross-session memory recall. */
  recall: (query: string, k: number) => Promise<{ content: string; importance: number; score?: number }[]>;
  /** Structured experiment comparison, or null when no codes were recognised. */
  compare: (codes: string[], topic: string | null) => Promise<any>;
  /** Dataset summary so the model can choose a plottable metric. */
  datasets: () => Promise<{ key: string; name: string; unit: string; n: number }[]>;
  /** One completion over a message list. */
  chat: (messages: { role: "system" | "user" | "assistant"; content: string }[],
         opts: { jsonMode?: boolean; maxTokens?: number; effort?: string; timeoutMs?: number }) => Promise<string>;
  model: string;
  /** Wall-clock budget for the whole loop. */
  deadlineMs?: number;
  maxIterations?: number;
  /**
   * Background context prepended to the loop's first user turn, kept separate
   * from the question itself so it never leaks into the answer's heading.
   */
  context?: string;
};

const SYSTEM = `You are IGNIS, an agentic scientific research analyst for NASA microgravity combustion and spacecraft fire safety. You answer only from evidence you retrieve with your tools.

Reply with exactly one JSON object per turn, nothing else. Two shapes:

Search or inspect:
{"thought": "<one sentence: what you still need and why>", "tool": "search_corpus", "input": {"query": "<scientific search query>", "k": 6}}

Finish:
{"thought": "<why the evidence is now sufficient>", "tool": "final_answer", "input": {"answer": "<markdown answer>", "confidence": 0.0}}

Tools:
- search_corpus  {"query": string, "k"?: 3-10}   hybrid vector + keyword search over NASA NTRS reports.
- recall_memory  {"query": string}               prior findings stored across sessions.
- compare_experiments {"experiments": [string], "topic"?: string}  structured side-by-side of named campaigns (e.g. SAFFIRE, BASS-II, SAME).
- build_chart    {"dataset": string, "type": "bar"|"line"|"scatter"}  figure from measured values.

Rules:
1. Never state a fact you did not retrieve. When you write the final answer, cite each factual sentence with bracketed evidence numbers like [3] that refer to the numbered evidence blocks in the transcript.
2. Prefer 1-3 searches: issue a focused query, read the evidence, then either search a genuinely different angle or answer. Do not repeat a query you already ran.
3. Use compare_experiments when the question names specific campaigns or asks for a comparison.
4. Use build_chart only when the user asks for a figure, chart, or visual; it also records the figure for the answer.
5. The final answer is rendered as markdown, so structure it instead of writing one block of prose. Open with one or two sentences that answer the question directly. Then group the findings under short "## " headings (for example "## Microgravity vs. Earth", "## Quantified results", "## Fire-safety implications"). Under each heading use "- " bullets, one finding per bullet, each one or two sentences. Bold the key number or conclusion in each bullet. Use a markdown table when the evidence compares the same quantity across experiments or gravity levels. Carry concrete numbers (spread rates, oxygen limits, temperatures, pressures) and experiment names where the evidence has them. Say the evidence is insufficient rather than inventing anything.
6. Confidence is your own 0-1 estimate that the answer is fully supported by the cited evidence.`;

/**
 * Used when the loop runs out of iterations before the model answers. The raw
 * evidence dump is not an answer, so one final call turns the gathered passages
 * into the structured response the user asked for.
 */
const FINAL_ANSWER_INSTRUCTION = `You are IGNIS, a scientific research analyst for NASA microgravity combustion and spacecraft fire safety.

Write the final answer to the research question using ONLY the numbered evidence blocks provided. Cite each factual sentence with bracketed evidence numbers like [3] that refer to those blocks.

Structure the answer as markdown so it is scannable:
- Open with one or two sentences that answer the question directly.
- Group the findings under short "## " headings (for example "## Microgravity vs. Earth", "## Quantified results", "## Fire-safety implications").
- Under each heading use "- " bullets, one finding per bullet, each one or two sentences.
- Bold the key number or conclusion in each bullet.
- Use a markdown table when the evidence compares the same quantity across experiments or gravity levels.

Carry concrete numbers (spread rates, oxygen limits, temperatures, pressures) and experiment names wherever the evidence has them. If the evidence does not answer the question, say so plainly instead of inventing anything. Reply with markdown only: no JSON, no preamble, no code fences.`;

/** Numbered transcript of everything retrieved so far, for citation stability. */
function evidenceBlock(hits: LoopHit[]): string {
  if (!hits.length) return "(no evidence retrieved yet)";
  return hits.map((h, i) =>
    `[${i + 1}] ${h.title} (NTRS ${h.source_id}; ${h.section_path ?? h.kind})\n${h.content.slice(0, 900).trim()}`,
  ).join("\n\n");
}

/** Remove a wrapping code fence, which models add despite being told not to. */
function stripFences(raw: string): string {
  return raw.trim().replace(/^```(?:markdown|md|json)?\s*/, "").replace(/\s*```$/, "").trim();
}

/**
 * True when text reads as a written answer rather than scratch work or a
 * malformed tool call. Requires several lines and a citation, so a stray
 * sentence or a broken JSON fragment is not mistaken for a final answer.
 */
function looksLikeAnswer(text: string): boolean {
  // A citation marker plus either a few lines or a reasonable length is enough
  // evidence that this is prose and not a truncated tool call. The bar is
  // deliberately low: a slightly short answer is far better than throwing the
  // whole run away and falling back to an extractive dump.
  if (!/\[\d+\]/.test(text)) return false;
  if (/^\s*\{/.test(text)) return false;
  const lines = text.split("\n").filter((l) => l.trim()).length;
  return lines >= 2 || text.length >= 120;
}

function extractJson(raw: string): any | null {
  let s = raw.trim();
  if (s.startsWith("```")) {
    const parts = s.split("```");
    s = (parts[1] || "").replace(/^json/i, "").trim();
  }
  const start = s.indexOf("{");
  if (start === -1) return null;
  const end = s.lastIndexOf("}");
  if (end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Experiment codes mentioned in a question, matched against the known set. */
export function mentionedCodes(text: string, known: string[]): string[] {
  const low = text.toLowerCase();
  const found: string[] = [];
  for (const code of known) {
    const c = code.toLowerCase();
    // Word-boundary match so "SAME" does not fire inside "same as".
    const re = new RegExp(`(^|[^a-z0-9])${c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`, "i");
    if (re.test(low) && !found.includes(code)) found.push(code);
  }
  return found;
}

/**
 * Repair the two ways a reasoning model's JSON object usually arrives broken:
 * a fenced block, and an unterminated object whose `answer` string runs to the
 * end of the text. Returns null when nothing usable can be recovered.
 */
function salvageJson(raw: string): any | null {
  let s = raw.trim().replace(/^```(?:json|markdown|md)?\s*/, "").replace(/\s*```$/, "").trim();
  const start = s.indexOf("{");
  if (start === -1) return null;
  s = s.slice(start);
  const direct = extractJson(s);
  if (direct) return direct;
  // Unterminated object: pull the answer text out of the raw string.
  const m = /"answer"\s*:\s*"([\s\S]*)$/.exec(s);
  if (m) {
    const answer = m[1].replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\t/g, " ").trim();
    if (answer) return { tool: "final_answer", input: { answer } };
  }
  return null;
}

export async function runAgentLoop(
  question: string,
  deps: LoopDeps,
  knownExperiments: string[] = [],
  onStep?: (step: LoopStep) => void,
): Promise<LoopResult> {
  const started = Date.now();
  const deadlineMs = deps.deadlineMs ?? 150000;
  const maxIterations = deps.maxIterations ?? 6;
  // Split the budget: the loop may spend most of it gathering evidence, but the
  // last slice is reserved so a forced-synthesis pass always has room to run.
  // Without the reserve the loop can eat the entire deadline and the answer
  // degrades to a raw evidence dump. The reserve is generous because a single
  // synthesis call on a reasoning model routinely runs 40-60s.
  const SYNTH_RESERVE_MS = 60000;
  const hardDeadline = started + deadlineMs;
  const loopDeadline = started + Math.max(20000, deadlineMs - SYNTH_RESERVE_MS);
  const steps: LoopStep[] = [];
  const pool: LoopHit[] = [];
  const poolIds = new Set<number>();
  const triedQueries: string[] = [];
  let chartRequest: LoopResult["chartRequest"] = null;
  let promptTokens = 0;
  let completionTokens = 0;
  let lastError: string | undefined;
  let parseErrors = 0;
  let stopReason: LoopResult["stopReason"] = "budget";

  const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
    { role: "system", content: SYSTEM },
  ];

  // Seed the pool with a first-pass retrieval before the loop starts. Each
  // upstream completion costs 25-30s, so a loop that spends its opening turns
  // searching rarely reaches synthesis inside the deadline. Retrieval is local
  // and fast, so doing it up front lets the model answer on turn one when the
  // seed is already sufficient, while still allowing further searches.
  try {
    const seed = await deps.search(question, 5);
    for (const h of seed) {
      if (!poolIds.has(h.chunk_id)) { pool.push(h); poolIds.add(h.chunk_id); }
    }
    triedQueries.push(question);
  } catch (err: any) {
    lastError = String(err?.message ?? err).slice(0, 300);
  }

  // When the opening retrieval is already substantial, go straight to
  // synthesis. Upstream completions cost ~60s each, so spending a turn asking
  // the model to decide whether to search again is unaffordable — and a seeded
  // prompt that invites a JSON `final_answer` makes the model try to write the
  // whole answer inside a small JSON field, which truncates and wastes the run.
  const seedSufficient = pool.length >= 4;
  if (!seedSufficient) {
    messages.push({
      role: "user",
      content:
        (deps.context ? `${deps.context}\n\n` : "") +
        `Research question: ${question}\n\n` +
        (knownExperiments.length
          ? `Experiment codes you may pass to compare_experiments: ${knownExperiments.slice(0, 40).join(", ")}\n\n`
          : "") +
        "Start by choosing a tool. Reply with one JSON object.",
    });
  }

  for (let iteration = 0; !seedSufficient && iteration < maxIterations; iteration++) {
    const remaining = loopDeadline - Date.now();
    if (remaining < 12000) { stopReason = "deadline"; break; }

    // A transient upstream failure (timeout, one 5xx) must not kill the run:
    // retry a couple of times before giving up, and treat the failure as a
    // parse retry rather than an immediate hard stop. Each attempt re-reads the
    // clock and shares one budget, so retries cannot push past the deadline.
    let raw = "";
    let chatErr: any = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const left = loopDeadline - Date.now();
      if (left < 6000) { chatErr = new Error("deadline reached during retries"); break; }
      try {
        // Tool selection only needs a small JSON object back, so it runs at low
        // effort with a modest token budget. Medium effort made each turn take
        // 30-45s, which left room for barely two iterations inside the deadline
        // and pushed the run to `stop_reason: deadline` before it could answer.
        raw = await deps.chat(messages, {
          maxTokens: 1500,
          effort: "low",
          timeoutMs: Math.min(110000, left),
        });
        chatErr = null;
        break;
      } catch (err: any) {
        chatErr = err;
        lastError = String(err?.message ?? err).slice(0, 300);
        const msg = String(err?.message ?? err);
        // A 400 "Unsupported parameter" is deterministic — retrying will not help.
        if (/unsupported parameter|invalid request|400/i.test(msg)) break;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }

    if (chatErr) {
      parseErrors++;
      if (parseErrors >= 2) { stopReason = "model_error"; break; }
      messages.push({
        role: "user",
        content: "The previous call failed. Reply with exactly one JSON object and nothing else.",
      });
      continue;
    }

    messages.push({ role: "assistant", content: raw });
    let parsed: any = extractJson(raw) ?? salvageJson(raw);
    if (!parsed || typeof parsed !== "object") {
      // Models sometimes ignore the JSON envelope and write the answer
      // directly. That prose is still a usable answer, so keep it rather than
      // discarding the whole run over a formatting slip.
      const prose = stripFences(raw);
      if (looksLikeAnswer(prose)) {
        stopReason = "final_answer";
        return {
          answer: prose, steps, hits: pool, chartRequest, stopReason,
          promptTokens, completionTokens, iterations: iteration + 1,
        };
      }
      // Otherwise it is scratch work: ask again instead of aborting the run.
      parseErrors++;
      lastError = "model did not return a JSON object";
      if (parseErrors >= 3) { stopReason = "parse_error"; break; }
      messages.push({
        role: "user",
        content: "Reply with exactly one JSON object and nothing else — no prose, no code fences.",
      });
      continue;
    }

    const thought = String(parsed.thought ?? "").slice(0, 400);
    const tool = String(parsed.tool ?? "") as LoopToolName;
    const input = parsed.input ?? {};

    if (tool === "final_answer") {
      const answer = String(input.answer ?? "").trim();
      if (!answer) {
        messages.push({ role: "user", content: "Your final_answer had no answer text. Reply with one JSON object containing a non-empty answer." });
        continue;
      }
      steps.push({ iteration, thought, tool, input: { chars: answer.length, confidence: input.confidence }, observation_chars: 0, n_evidence: pool.length });
      onStep?.(steps[steps.length - 1]);
      stopReason = "final_answer";
      return {
        answer, steps, hits: pool, chartRequest, stopReason,
        promptTokens, completionTokens, iterations: iteration + 1,
      };
    }

    const outcome = await resolveTool(tool, input, deps, pool, poolIds, triedQueries, chartRequest);
    if (outcome.chart) chartRequest = { dataset: outcome.chart.dataset, type: outcome.chart.type as any };
    const step: LoopStep = {
      iteration, thought, tool, input, observation_chars: outcome.observation.length,
      n_evidence: outcome.hits?.length ?? 0, error: outcome.error,
    };
    steps.push(step);
    onStep?.(step);

    const lastTurn = iteration + 1 >= maxIterations;
    messages.push({
      role: "user",
      content:
        `Observation from ${tool}:\n${outcome.observation}\n\n` +
        `Evidence gathered so far (cite these numbers in your final answer):\n${evidenceBlock(pool)}\n\n` +
        (lastTurn
          ? "This is your last turn. Reply with one JSON object using final_answer and write the full structured markdown answer now."
          : "Reply with one JSON object: another tool call, or final_answer."),
    });
  }

  // The loop ran out of iterations or time without a final answer. A raw
  // evidence dump is not an answer, so spend one more call — retried once with
  // a larger budget — turning the gathered passages into the structured
  // response. Only if every attempt fails do we fall back to the deterministic
  // extractive answer, which is grounded by construction.
  if (pool.length) {
    // Match the budgets the fixed pipeline uses: a reasoning model on this
    // upstream needs ~4000 output tokens before it stops spending the budget on
    // hidden reasoning and emits visible text. Smaller caps come back empty,
    // which is how a run silently degrades to the extractive dump.
    const budgets = [4000, 8000];
    for (const budget of budgets) {
      const remaining = hardDeadline - Date.now();
      // This pass exists to rescue a run that ran out of loop time, so it must
      // actually be allowed to run: stop only when the hard deadline is close.
      if (remaining < 12000) break;
      try {
        const raw = await deps.chat(
          [
            { role: "system", content: FINAL_ANSWER_INSTRUCTION },
            {
              role: "user",
              content: `Research question: ${question}\n\nEvidence:\n${evidenceBlock(pool)}\n\nWrite the final answer now.`,
            },
          ],
          { maxTokens: budget, effort: "low", timeoutMs: Math.min(90000, remaining) },
        );
        // The forced pass is asked for prose, but tolerate a JSON envelope or an
        // unterminated one.
        const obj = extractJson(raw) ?? salvageJson(raw);
        const answer = String(
          obj && typeof obj.answer === "string" && obj.answer.trim() ? obj.answer : raw,
        ).replace(/^```(?:markdown|md)?\s*/, "").replace(/\s*```$/, "").trim();
        if (answer && answer.length > 40) {
          return {
            answer, steps, hits: pool, chartRequest, stopReason: "forced_synthesis",
            promptTokens, completionTokens, iterations: steps.length,
          };
        }
      } catch (err: any) {
        lastError = String(err?.message ?? err).slice(0, 300);
      }
    }
  }

  return {
    answer: pool.length
      ? extractiveAnswer(question, pool)
      : `No evidence was retrieved for: ${question}`,
    steps, hits: pool, chartRequest, stopReason,
    promptTokens, completionTokens, iterations: steps.length, lastError,
  };
}

/**
 * Last-resort answer assembled directly from the retrieved passages.
 *
 * Unlike the old "No synthesis was reached" placeholder, this is a real answer:
 * it quotes the evidence with `[n]` markers that resolve to the same passages,
 * so it is grounded, citable and useful even when the model never cooperated.
 */
function extractiveAnswer(question: string, hits: LoopHit[]): string {
  const top = hits.slice(0, 5);
  const lines = top.map((h, i) => {
    const text = h.content.replace(/\s+/g, " ").trim().slice(0, 260);
    return `- **${h.title}** (NTRS ${h.source_id}) — ${text} [${i + 1}]`;
  });
  return (
    `## ${question}\n\n` +
    `The agent gathered the following directly relevant passages from the NASA corpus. ` +
    `They are quoted verbatim; the model did not get to synthesise them, so read them as evidence rather than a finished summary.\n\n` +
    lines.join("\n") +
    `\n\n_Each bullet cites the passage it was drawn from; open the source documents for full context._`
  );
}

async function resolveTool(
  tool: LoopToolName,
  input: any,
  deps: LoopDeps,
  pool: LoopHit[],
  poolIds: Set<number>,
  triedQueries: string[],
  _chartRequest: LoopResult["chartRequest"],
): Promise<ToolOutcome> {
  try {
    if (tool === "search_corpus") {
      const query = String(input.query ?? "").trim();
      if (!query) return { tool, input, observation: "error: search_corpus needs a non-empty query", error: "empty query" };
      if (triedQueries.some((q) => q.toLowerCase() === query.toLowerCase())) {
        return {
          tool, input, error: "duplicate query",
          observation: `You already ran this exact query. Try different terminology or answer with what you have.\n${evidenceBlock(pool)}`,
        };
      }
      triedQueries.push(query);
      const k = Math.min(Math.max(Number(input.k ?? 6) || 6, 3), 10);
      const hits = await deps.search(query, k);
      let added = 0;
      for (const h of hits) {
        if (poolIds.has(h.chunk_id)) continue;
        poolIds.add(h.chunk_id);
        pool.push(h);
        added++;
      }
      const obs = hits.length
        ? `${hits.length} passages, ${added} new. ${evidenceBlock(pool)}`
        : "No passages matched that query. Try broader or different terminology.";
      return { tool, input, observation: obs, hits };
    }

    if (tool === "recall_memory") {
      const query = String(input.query ?? "").trim() || "microgravity combustion";
      const recalled = await deps.recall(query, 5);
      return {
        tool, input,
        observation: recalled.length
          ? recalled.map((r, i) => `(${i + 1}) [importance ${(r.importance ?? 0).toFixed(2)}] ${r.content}`).join("\n")
          : "No prior findings stored for that topic.",
      };
    }

    if (tool === "compare_experiments") {
      const codes = (Array.isArray(input.experiments) ? input.experiments : [])
        .map((c: any) => String(c).trim().toUpperCase()).filter(Boolean);
      if (!codes.length) return { tool, input, observation: "error: compare_experiments needs at least one experiment code", error: "no codes" };
      const data = await deps.compare(codes, input.topic ? String(input.topic) : null);
      if (!data || !data.experiments?.length) {
        return { tool, input, error: "no match", observation: `No experiment in the database matches ${codes.join(", ")}.` };
      }
      const lines: string[] = [];
      for (const e of data.experiments) {
        lines.push(`${e.code} — ${e.name ?? "unnamed"} | campaign ${e.campaign ?? "?"} | facility ${e.facility ?? "?"} | platform ${e.platform ?? "?"} | gravity ${e.gravity_level ?? "?"} | fuel ${e.fuel_type ?? "?"} | ${e.document_count} documents`);
        const fs: any[] = data.findings?.[String(e.id)] ?? [];
        for (const f of fs.slice(0, 6)) {
          lines.push(`    · ${f.metric}: ${f.value ?? "?"}${f.value_max ? `–${f.value_max}` : ""} ${f.unit ?? ""} — ${String(f.statement ?? "").slice(0, 160)} (NTRS ${f.source_id})`);
        }
      }
      return { tool, input, observation: lines.join("\n") };
    }

    if (tool === "build_chart") {
      const dataset = String(input.dataset ?? "").trim();
      const type = ["bar", "line", "scatter"].includes(String(input.type)) ? String(input.type) : "bar";
      const available = await deps.datasets();
      const match = available.find((d) => d.key === dataset) ??
        available.find((d) => d.key.includes(dataset.toLowerCase()) || d.name.toLowerCase().includes(dataset.toLowerCase()));
      if (!match) {
        return {
          tool, input, error: "unknown dataset",
          observation: `No such dataset. Available: ${available.map((d) => `${d.key} (${d.n} values, ${d.unit})`).join("; ")}`,
        };
      }
      return {
        tool, input,
        observation: `Figure queued: ${match.name} (${match.key}), ${match.n} measured values in ${match.unit}, rendered as a ${type} chart from ignis.dataset_row.`,
        chart: { dataset: match.key, type, points: match.n },
      };
    }

    return {
      tool, input, error: "unknown tool",
      observation: `Unknown tool "${tool}". Use one of: search_corpus, recall_memory, compare_experiments, build_chart, final_answer.`,
    };
  } catch (err: any) {
    return { tool, input, error: String(err?.message ?? err), observation: `Tool ${tool} failed: ${String(err?.message ?? err).slice(0, 200)}` };
  }
}
