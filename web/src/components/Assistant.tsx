import { useCallback, useEffect, useRef, useState } from "react";
import { postSse } from "@/lib/sse";
import Markdown from "@/components/Markdown";
import Chart, { type ChartPayload } from "@/components/Chart";
import ExportBar from "@/components/ExportBar";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { Sparkles, ArrowUp } from "lucide-react";

type Claim = {
  claim: string; quote: string; title: string; source_id: string;
  section: string; support_score: number; landing_url: string; verified?: boolean;
};
type Hit = {
  chunk_id: number; document_id: number; title: string; source_id: string;
  kind: string; section_path: string | null; content: string;
  final_score: number; vector_score: number; keyword_score: number; rerank_score: number;
  quality_score: number; landing_url: string; relevance: string; sub_question: string | null;
};
type AskResult = {
  run_id: string; question: string; answer: string; chart?: ChartPayload | null;
  claims: Claim[]; evidence: Hit[];
  sub_questions: string[]; confidence: number; grounded: boolean; iterations: number;
  stop_reason?: string;
  trace: { node: string; [k: string]: unknown }[];
  latency_ms: number; provider: string; model: string;
};

// `stop_reason` is the contract for whether an answer is complete. Only these
// two mean the loop finished the job; anything else is a partial result and the
// UI has to say so rather than presenting it as final.
const COMPLETE = new Set(["final_answer", "forced_synthesis"]);
const STOP_LABEL: Record<string, string> = {
  budget: "hit the iteration budget before finishing",
  deadline: "ran out of time before finishing",
  parse_error: "the model's output could not be parsed",
  model_error: "the model call failed",
};
type Stage = { node: string; msg: string };

const EXAMPLES = [
  "How does flame spread over solid fuels differ in microgravity compared with Earth?",
  "What is the limiting oxygen concentration for spacecraft fire safety?",
  "How do smoke and soot particles behave in microgravity, and what does it mean for fire detection?",
  "Why is fire suppression harder in microgravity, and which agents were tested?",
  "What did SAFFIRE teach us about large-scale fire growth in spacecraft?",
];

// The gateway forwards these ids upstream; the label is what the UI shows.
const MODELS = [
  { id: "gpt-5.6-sol", name: "SI 1", note: "fast · balanced" },
  { id: "gpt-6.1-sol", name: "SI MAX", note: "stronger reasoning" },
  { id: "gpt-6-astra", name: "SI ULTRA", note: "best availability" },
];

const NODE_LABEL: Record<string, string> = {
  memory: "recall",
  mode: "setup",
  plan: "plan",
  retrieve: "retrieve",
  grade: "grade",
  expand: "expand",
  synthesize: "synthesize",
  verify: "verify",
  memory_write: "remember",
  visualize: "visualize",
  done: "done",
};

type MemoryItem = {
  id: number; kind: string; content: string;
  importance: number; score?: number; hit_count?: number; created_at: string;
};

/** Stable per-browser conversation id so session memory survives reloads. */
function useConversationId(): string {
  const ref = useRef<string>("");
  if (!ref.current) {
    let id = localStorage.getItem("ignis.conversation_id");
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem("ignis.conversation_id", id);
    }
    ref.current = id;
  }
  return ref.current;
}

export default function Assistant() {
  const { t } = useI18n();
  const conversationId = useConversationId();
  const [question, setQuestion] = useState(EXAMPLES[0]);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AskResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showTrace, setShowTrace] = useState(false);
  const [mode, setMode] = useState<"fast" | "deep">("fast");
  const [model, setModel] = useState<string>(MODELS[0].id);
  const [stages, setStages] = useState<Stage[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [recalled, setRecalled] = useState<MemoryItem[]>([]);
  const [memory, setMemory] = useState<{
    recent: MemoryItem[]; session: MemoryItem[]; stats: { long_term: number; short_term: number };
  } | null>(null);
  const [memQuery, setMemQuery] = useState("");
  const [memLoading, setMemLoading] = useState(false);

  const loadMemory = useCallback(async (query = "") => {
    setMemLoading(true);
    try {
      const params = new URLSearchParams({ conversation_id: conversationId });
      if (query.trim()) params.set("query", query.trim());
      const d = await (await fetch(`/api/memory?${params}`)).json();
      if (d.recalled?.length) setRecalled(d.recalled);
      if (d.recent || d.session) {
        setMemory({
          recent: d.recent ?? [],
          session: d.session ?? [],
          stats: d.stats ?? { long_term: 0, short_term: 0 },
        });
      }
    } catch {
      // memory panel is non-critical
    } finally {
      setMemLoading(false);
    }
  }, [conversationId]);

  useEffect(() => { loadMemory(""); }, [loadMemory]);

  // Tick a timer while a run is in flight so the wait is visible.
  useEffect(() => {
    if (!loading) return;
    const started = Date.now();
    const t = setInterval(() => setElapsed((Date.now() - started) / 1000), 250);
    return () => clearInterval(t);
  }, [loading]);

  const push = (node: string, msg: string) => setStages((s) => [...s, { node, msg }]);

  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const threadEndRef = useRef<HTMLDivElement | null>(null);

  // Grow the island textarea with its content, up to the CSS max-height.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }, [question]);

  // Keep the newest turn in view as the agent streams stages and answers.
  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [result, loading, stages.length]);

  async function ask(q: string) {
    setLoading(true); setError(null); setResult(null); setStages([]); setElapsed(0);
    try {
      await postSse("/api/ask", {
        question: q, k: 8, stream: true, mode, model, conversation_id: conversationId,
      }, (ev) => {
        const d = ev.data ?? {};
        switch (ev.event) {
          case "memory":
            push("memory", `recalled ${d.n_recalled} memor${d.n_recalled === 1 ? "y" : "ies"} from vector store`);
            if (d.contents?.length) {
              setRecalled(d.contents.map((c: string) => ({
                id: -1, kind: "recalled", content: c, importance: 0, score: 0,
                created_at: new Date().toISOString(),
              })));
            }
            break;
          case "mode":
            push("mode", `${d.mode === "deep" ? "deep" : "fast"} path · ${d.model ?? "model"}${d.max_iterations > 1 ? ` · ≤${d.max_iterations} passes` : ""}`);
            break;
          case "plan":
            push("plan", `split into ${d.sub_questions?.length ?? 0} sub-question(s)`);
            break;
          case "retrieve":
            push("retrieve", `"${d.sub_question}" → ${d.n_hits} passage(s) · ${d.verdict}`);
            break;
          case "grade":
            push("grade", `evidence ${d.verdict} (score ${d.score})`);
            break;
          case "expand":
            push("expand", `rewrote the query: ${(d.to ?? []).join("; ")}`);
            break;
          case "synthesize":
            push("synthesize", `${d.model} drafted ${d.claims} cited claim(s)`);
            break;
          case "verify":
            push("verify", `${Math.round((d.verified_ratio ?? 0) * 100)}% of claims traced to a passage`);
            break;
          case "memory_write":
            push("memory_write", `${d.n_claims} finding(s) saved to long-term memory`);
            loadMemory();
            break;
          case "error":
            setError(d.error || "agent error");
            break;
          case "done":
            // The worker sends the result inline in `data`.
            setResult(d as AskResult);
            push("done", `${Math.round((d.confidence ?? 0) * 100)}% confidence · ${d.latency_ms} ms`);
            break;
        }
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  const activeModel = MODELS.find((m) => m.id === model) ?? MODELS[0];

  return (
    <div className="stack agent">
      {/* Agent chat surface — a single conversation shell with a dynamic-island
          composer docked at the bottom, modelled on modern agent UIs
          (prompt-kit / AI Elements / assistant-ui) and rebranded to IGNIS. */}
      <div className="agent-shell">
        <div className="agent-thread">
          {!result && !loading && !error && (
            <div className="agent-hero">
              <div className="agent-orb" aria-hidden="true" />
              <h2>{t("IGNIS Intelligence")}</h2>
              <p className="muted">
                {t("Grounded answers over the NASA NTRS combustion-in-microgravity corpus — every claim traced to a passage.")}
              </p>
              <div className="agent-suggest">
                {EXAMPLES.slice(0, 3).map((e, i) => (
                  <button key={i} className="suggest" onClick={() => { setQuestion(e); ask(e); }}>
                    <Sparkles className="size-3.5" />
                    <span>{e}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {loading && (
            <div className="agent-turn">
              <div className="bubble user">{question}</div>
              <div className="bubble agent working">
                <div className="agent-thinking">
                  <span className="agent-orb sm" aria-hidden="true" />
                  <span>{t("Working")}</span>
                  <span className="muted mono">{elapsed.toFixed(1)}s</span>
                </div>
                <ol className="timeline">
                  {stages.map((st, i) => (
                    <li key={i}>
                      <span className="tag">{t(NODE_LABEL[st.node] ?? st.node)}</span>
                      <span>{st.msg}</span>
                    </li>
                  ))}
                  {stages.length === 0 && <li className="muted">{t("contacting the agent…")}</li>}
                </ol>
              </div>
            </div>
          )}

          {error && (
            <div className="agent-turn">
              <div className="bubble user">{question}</div>
              <div className="bubble agent error">
                <strong>{t("Agent error.")}</strong> {error}
                <div style={{ marginTop: 10 }}>
                  <button className="ghost" onClick={() => ask(question)}>{t("Try again")}</button>
                </div>
              </div>
            </div>
          )}

          {result && (
            <>
              <div className="agent-turn">
                <div className="bubble user">{result.question}</div>
                <div className="bubble agent">
                  <div className="pillrow">
                    <span className="pill">
                      <span className={`dot ${result.grounded ? "" : "warn"}`} />
                      {result.grounded ? t("grounded in sources") : t("low grounding")}
                    </span>
                    {result.stop_reason && !COMPLETE.has(result.stop_reason) && (
                      <span className="pill warnpill">
                        {t("partial")} · {t(STOP_LABEL[result.stop_reason] ?? result.stop_reason)}
                      </span>
                    )}
                    <span className="pill">{t("confidence")} {(result.confidence * 100).toFixed(0)}%</span>
                    <span className="pill">{result.claims.length} {t("cited claims")}</span>
                    <span className="pill">{result.evidence.length} {t("passages")}</span>
                    <span className="pill">{(result.latency_ms / 1000).toFixed(1)}s</span>
                    <span className="pill mono">{result.model}</span>
                  </div>
                  <div className="answer">
                    <Markdown text={result.answer} />
                  </div>
                  <ExportBar
                    markdown={result.answer}
                    charts={result.chart ? [result.chart] : []}
                    title={result.question}
                    filename={`ignis-${result.run_id.slice(0, 8)}`}
                  />
                  {result.chart && <Chart chart={result.chart} />}
                  {result.sub_questions.length > 0 && (
                    <details className="agent-details">
                      <summary>{t("Sub-questions")} ({result.sub_questions.length})</summary>
                      <ol className="sublist">
                        {result.sub_questions.map((s, i) => <li key={i}>{s}</li>)}
                      </ol>
                    </details>
                  )}
                </div>
              </div>

              <div className="grid g2">
                <div className="card">
                  <div className="cardhead">
                    <h3>{t("Evidence & sources")}</h3>
                    <span className="muted">{t("each claim traced to a passage")}</span>
                  </div>
                  <div className="scroll">
                    {result.claims.map((c, i) => (
                      <div key={i} className="hit">
                        <div className="hittitle">
                          <sup className="cite">[{i + 1}]</sup> {c.title}
                          {c.verified === false && <span className="tag sev-high">{t("unverified")}</span>}
                        </div>
                        <div className="meta">
                          NTRS {c.source_id} · {c.section} · support {c.support_score?.toFixed(3)}
                        </div>
                        <blockquote className="quote">{c.quote}</blockquote>
                        {c.landing_url && (
                          <a href={c.landing_url} target="_blank" rel="noreferrer">{t("open source document ↗")}</a>
                        )}
                      </div>
                    ))}
                    {result.claims.length === 0 && (
                      <div className="muted">{t("No grounded claims were extracted for this question.")}</div>
                    )}
                  </div>
                </div>

                <div className="card">
                  <div className="cardhead">
                    <h3>{t("Ranked passages")}</h3>
                    <span className="muted">{t("hybrid RRF + smart ranking")}</span>
                  </div>
                  <div className="scroll">
                    {result.evidence.map((h, i) => (
                      <div key={h.chunk_id} className="hit">
                        <div className="hittitle"><sup className="cite">[{i + 1}]</sup> {h.title}</div>
                        <div className="meta">
                          NTRS {h.source_id} · {h.kind}
                          {h.section_path ? ` · ${h.section_path}` : ""} · {h.relevance}
                        </div>
                        <div className="body">{h.content.slice(0, 420)}…</div>
                        <div className="bar"><i style={{ width: `${Math.min(100, h.final_score * 100)}%` }} /></div>
                        <div className="meta">
                          fused {h.final_score.toFixed(3)} · vector {h.vector_score.toFixed(3)} ·
                          keyword {h.keyword_score.toFixed(3)} · rerank {h.rerank_score.toFixed(3)}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div className="row" style={{ justifyContent: "center" }}>
                <button className="ghost" onClick={() => setShowTrace((v) => !v)}>
                  {showTrace ? t("Hide") : t("Show")} {t("reasoning trace")}
                </button>
              </div>
              {showTrace && (
                <div className="card">
                  <div className="cardhead">
                    <h3>{t("Reasoning trace")}</h3>
                    <span className="muted">run {result.run_id.slice(0, 8)}</span>
                  </div>
                  <ol className="timeline">
                    {result.trace.map((tr, i) => (
                      <li key={i}>
                        <span className="tag">{t(NODE_LABEL[tr.node] ?? tr.node)}</span>
                        <code className="code">
                          {JSON.stringify(
                            Object.fromEntries(Object.entries(tr).filter(([k]) => k !== "node")),
                          ).slice(0, 260)}
                        </code>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </>
          )}

          {!result && !loading && (
            <div className="card">
              <div className="cardhead">
                <h3>{t("Agent memory")}</h3>
                <span className="muted">{t("session + cross-session vector memory")}</span>
              </div>
              {memory && (
                <div className="pillrow">
                  <span className="pill">{memory.stats.long_term} {t("long-term")}</span>
                  <span className="pill">{memory.stats.short_term} {t("short-term")}</span>
                </div>
              )}
              <div className="controls">
                <input
                  className="grow"
                  placeholder={t("Recall memory by topic — e.g. 'flame spread rate'")}
                  value={memQuery}
                  onChange={(e) => setMemQuery(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") loadMemory(memQuery); }}
                />
                <button className="ghost" onClick={() => loadMemory(memQuery)} disabled={memLoading}>
                  {memLoading ? t("recalling…") : t("Recall")}
                </button>
              </div>
              {recalled.length > 0 && (
                <div className="hit">
                  <div className="hittitle">{t("Vector recall")}</div>
                  <div className="scroll short">
                    {recalled.map((m, i) => (
                      <div key={i} className="meta">
                        <span className="tag">{m.kind}</span> {m.content}
                        {m.score ? ` · ${(m.score * 100).toFixed(0)}% ${t("similar")}` : ""}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div className="grid g2">
                <div>
                  <div className="subhead">{t("Long-term store")}</div>
                  <div className="scroll short">
                    {(memory?.recent ?? []).map((m) => (
                      <div key={m.id} className="hit">
                        <div className="meta">
                          <span className="tag">{m.kind}</span> {t("importance")} {(m.importance * 100).toFixed(0)}%
                          {m.hit_count ? ` · ${t("recalled")} ${m.hit_count}×` : ""}
                        </div>
                        <div className="body">{m.content}</div>
                      </div>
                    ))}
                    {(memory?.recent ?? []).length === 0 && (
                      <div className="muted">{t("Empty \u2014 ask a question to seed the store.")}</div>
                    )}
                  </div>
                </div>
                <div>
                  <div className="subhead">{t("This session")}</div>
                  <div className="scroll short">
                    {(memory?.session ?? []).map((m) => (
                      <div key={m.id} className="hit">
                        <div className="meta"><span className="tag">{m.kind}</span></div>
                        <div className="body">{m.content}</div>
                      </div>
                    ))}
                    {(memory?.session ?? []).length === 0 && (
                      <div className="muted">{t("Session memory appears after your first question.")}</div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
          <div ref={threadEndRef} />
        </div>

        {/* Dynamic-island composer: expands to a full input while focused,
            collapses to a compact pill when idle. */}
        <div className="island-wrap">
          <div className={cn("island", loading && "busy")}>
            <textarea
              ref={inputRef}
              className="island-input"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && question.trim() && !loading) ask(question);
              }}
              placeholder={t("Ask about flame spread, extinction, smoke detection, suppression, oxygen limits…")}
              rows={1}
            />
            <div className="island-bar">
              <div className="seg" role="group" aria-label={t("reasoning mode")}>
                <button
                  className={mode === "fast" ? "seg-on" : ""}
                  onClick={() => setMode("fast")}
                  disabled={loading}
                  title={t("Single retrieval pass — fastest")}
                >
                  {t("Fast")}
                </button>
                <button
                  className={mode === "deep" ? "seg-on" : ""}
                  onClick={() => setMode("deep")}
                  disabled={loading}
                  title={t("LLM plans sub-questions, then synthesizes")}
                >
                  {t("Deep")}
                </button>
              </div>
              <select
                className="select island-model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                disabled={loading}
                title={activeModel.note}
                aria-label={t("model")}
              >
                {MODELS.map((m) => (
                  <option key={m.id} value={m.id}>{m.name} — {t(m.note)}</option>
                ))}
              </select>
              <button
                className="island-send"
                disabled={loading || !question.trim()}
                onClick={() => ask(question)}
                aria-label={t("Run research")}
              >
                {loading ? <span className="spin" /> : <ArrowUp className="size-4" />}
              </button>
            </div>
          </div>
          <div className="island-hint muted">
            {t("⌘/Ctrl + Enter to run · answers are grounded in NASA NTRS sources")}
          </div>
        </div>
      </div>
    </div>
  );
}
