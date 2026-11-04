import { useState } from "react";
import { postSse } from "@/lib/sse";
import Markdown from "@/components/Markdown";
import { ErrorState } from "@/components/States";
import { useI18n } from "@/lib/i18n";

type Citation = {
  claim?: string; chunk_id?: number; document_id?: number; source_id?: string;
  title?: string; quote?: string; support_score?: number; landing_url?: string;
  section?: string;
};
type Finding = {
  question: string; answer: string; confidence: number; grounded: boolean;
  citations: Citation[]; evidence_count: number; provider: string; model: string;
  latency_ms: number;
};
type Evidence = {
  source_id: string; title: string; section: string; support_score: number;
  quote: string; landing_url: string;
};
type Experiment = { code?: string; name?: string; findings?: number };
type Report = {
  topic: string; generated_at: string;
  generator: { provider: string; model: string; chain: string[] };
  corpus: { documents: number; chunks: number; words: number };
  summary: string; key_findings: Finding[]; evidence: Evidence[];
  comparative: Experiment[]; limitations: string[]; recommendations: string[];
  references: { source_id: string; landing_url: string }[];
  metrics: {
    questions: number; grounded: number; citations: number; unique_sources: number;
    mean_confidence: number; latency_ms: number;
  };
};

const TOPICS = [
  "spacecraft fire safety in microgravity",
  "flame spread over solid fuels in microgravity",
  "fire suppression and extinguishing agents in microgravity",
  "smoke and soot detection for spacecraft fire safety",
  "limiting oxygen concentration for spacecraft atmospheres",
  "large-scale spacecraft fire experiments (SAFFIRE)",
];


export default function Reports() {
  const { t } = useI18n();
  const [topic, setTopic] = useState(TOPICS[0]);
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [progress, setProgress] = useState<{ question: string; ok: boolean }[]>([]);
  const [stage, setStage] = useState<"idle" | "retrieving" | "assembling" | "done">("idle");
  const [total, setTotal] = useState(0);

  async function generate() {
    setBusy(true);
    setError(null);
    setReport(null);
    setProgress([]);
    setTotal(0);
    setStage("retrieving");
    const t0 = Date.now();
    const tick = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 500);
    try {
      // Streamed: the worker emits one event per finished question, so the
      // report is assembled without holding a single long request open.
      await postSse("/api/report", { topic, stream: true }, (ev) => {
        const d = ev.data ?? {};
        if (ev.event === "report_progress") {
          if (d.total) setTotal(d.total);
          setProgress((p) => [...p, { question: d.question, ok: !d.failed }]);
        } else if (ev.event === "report_summary") {
          setStage("assembling");
        } else if (ev.event === "done") {
          setStage("done");
          setReport(d.report);
        } else if (ev.event === "error") {
          setError(d.error || "report failed");
        }
      });
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      clearInterval(tick);
      setBusy(false);
      setStage("idle");
    }
  }

  function download() {
    if (!report) return;
    const md = [
      `# IGNIS Research Report — ${report.topic}`,
      "", `*Generated ${report.generated_at}*`, "",
      "## Executive Summary", "", report.summary, "",
      "## Key Findings", "",
      ...report.key_findings.flatMap((f, i) => [
        `### ${i + 1}. ${f.question}`, "",
        `*Confidence ${f.confidence} · ${f.citations.length} citations*`, "",
        f.answer, "",
      ]),
      "## Data Limitations", "",
      ...report.limitations.map((l) => `- ${l}`), "",
      ...(report.recommendations.length
        ? ["## Recommendations", "", ...report.recommendations.map((r) => `- ${r}`), ""]
        : []),
      "## References", "",
      ...report.references.map((r) => `- [${r.source_id}](${r.landing_url})`), "",
    ].join("\n");
    const url = URL.createObjectURL(new Blob([md], { type: "text/markdown" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `ignis-report-${report.topic.replace(/\W+/g, "-").slice(0, 60)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="card">
        <h3>
          Research Reports{" "}
          <small>cited, evidence-backed documents assembled from the NASA NTRS corpus</small>
        </h3>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <input
            className="input"
            style={{ flex: "1 1 340px" }}
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !busy && topic.trim() && generate()}
            placeholder={t("Research topic…")}
          />
          <button className="primary" onClick={generate} disabled={busy || !topic.trim()}>
            {busy ? t("Generating…") : t("Generate report")}
          </button>
          {report && (
            <button className="ghost" onClick={download}>
              Download .md
            </button>
          )}
        </div>
        <div className="row" style={{ gap: 6, flexWrap: "wrap", marginTop: 10 }}>
          {TOPICS.map((t) => (
            <button
              key={t}
              className="ghost"
              style={{
                fontSize: 12,
                borderColor: topic === t ? "rgba(255,106,31,.65)" : undefined,
                color: topic === t ? "#fff" : undefined,
              }}
              onClick={() => setTopic(t)}
            >
              {t}
            </button>
          ))}
        </div>
        {busy && (
          <div style={{ marginTop: 14 }} role="status" aria-live="polite">
            <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
              <span className="state-row">
                <span className="spin" />
                <strong style={{ fontSize: 13 }}>
                  {stage === "assembling" ? t("Assembling the report…") : t("Researching the corpus…")}
                </strong>
              </span>
              <span className="muted" style={{ fontVariantNumeric: "tabular-nums" }}>
                {progress.length}{total ? `/${total}` : ""} · {elapsed}s
                {progress.length === 0 && elapsed > 8 ? " · usually 40–90s" : ""}
              </span>
            </div>
            <div className="bar" style={{ marginTop: 10 }}>
              <i
                style={{
                  width: `${total ? Math.round((progress.length / total) * 100) : Math.min(95, elapsed * 2)}%`,
                  background: "linear-gradient(90deg, var(--flame), #ffc46b)",
                }}
              />
            </div>
            <ol className="timeline" style={{ marginTop: 12 }}>
              {progress.map((p, i) => (
                <li key={i}>
                  <span className={`tag ${p.ok ? "" : "sev-high"}`}>{p.ok ? t("done") : t("failed")}</span>
                  <span>{p.question}</span>
                </li>
              ))}
              {progress.length === 0 && (
                <li className="muted">
                  {t("Retrieving passages, grading evidence, then synthesizing each question…")}
                </li>
              )}
            </ol>
          </div>
        )}
        {error && (
          <div style={{ marginTop: 12 }}>
            <ErrorState
              title="Report generation failed"
              message={error}
              onRetry={topic.trim() ? generate : undefined}
            />
          </div>
        )}
      </div>

      {report && (
        <>
          <div className="card">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h3 style={{ margin: 0 }}>{report.topic}</h3>
              <span className="tag">
                {report.generator.provider}/{report.generator.model}
              </span>
            </div>
            <div className="row" style={{ gap: 8, flexWrap: "wrap", marginTop: 12 }}>
              <span className="pill">{report.metrics.grounded}/{report.metrics.questions} grounded</span>
              <span className="pill">{report.metrics.citations} citations</span>
              <span className="pill">{report.metrics.unique_sources} sources</span>
              <span className="pill">conf {report.metrics.mean_confidence}</span>
              <span className="pill">{(report.metrics.latency_ms / 1000).toFixed(1)}s</span>
              <span className="pill">{report.corpus.documents} docs</span>
            </div>
          </div>

          <div className="card">
            <h3>{t("Executive Summary ")}<small>generated from the findings below</small></h3>
            <div className="answer">
              <Markdown text={report.summary} />
            </div>
          </div>

          <div className="card">
            <h3>{t("Key Findings ")}<small>{report.key_findings.length} researched questions</small></h3>
            {report.key_findings.map((f, i) => (
              <div key={i} className="hit" style={{ marginBottom: 14 }}>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <strong>{i + 1}. {f.question}</strong>
                  <span className="tag">
                    {f.grounded ? "grounded" : "partial"} · conf {f.confidence} ·{" "}
                    {f.citations.length} cites
                  </span>
                </div>
                <div className="answer" style={{ marginTop: 8 }}>
                  <Markdown text={f.answer} />
                </div>
              </div>
            ))}
          </div>

          {report.comparative.length > 0 && (
            <div className="card">
              <h3>{t("Comparative Experiment View")}</h3>
              {report.comparative.map((e, i) => (
                <div key={i} className="row" style={{ justifyContent: "space-between" }}>
                  <span>{e.code || e.name}</span>
                  <span className="tag">{e.findings ?? 0} findings</span>
                </div>
              ))}
            </div>
          )}

          <div className="card">
            <h3>{t("Evidence Table ")}<small>{report.evidence.length} ranked passages</small></h3>
            <div className="scroll" style={{ maxHeight: 460 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr className="muted">
                    <th style={{ textAlign: "left", padding: 6 }}>#</th>
                    <th style={{ textAlign: "left", padding: 6 }}>NTRS</th>
                    <th style={{ textAlign: "left", padding: 6 }}>{t("Section")}</th>
                    <th style={{ textAlign: "right", padding: 6 }}>{t("Score")}</th>
                    <th style={{ textAlign: "left", padding: 6 }}>{t("Quote")}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.evidence.map((e, i) => (
                    <tr key={i} style={{ borderTop: "1px solid rgba(255,255,255,.07)" }}>
                      <td style={{ padding: 6 }} className="muted">{i + 1}</td>
                      <td style={{ padding: 6 }}>
                        <a href={e.landing_url} target="_blank" rel="noreferrer">{e.source_id}</a>
                      </td>
                      <td style={{ padding: 6 }} className="muted">{e.section}</td>
                      <td style={{ padding: 6, textAlign: "right" }}>{e.support_score}</td>
                      <td style={{ padding: 6 }} className="quote">{e.quote}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card">
            <h3>{t("Data Limitations")}</h3>
            {report.limitations.map((l, i) => (
              <p key={i} className="muted">• {l}</p>
            ))}
            {report.recommendations.length > 0 && (
              <>
                <h3 style={{ marginTop: 16 }}>{t("Recommendations")}</h3>
                {report.recommendations.map((r, i) => (
                  <p key={i} className="muted">• {r}</p>
                ))}
              </>
            )}
          </div>

          <div className="card">
            <h3>{t("References ")}<small>{report.references.length} NTRS documents</small></h3>
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              {report.references.map((r) => (
                <a key={r.source_id} className="tag" href={r.landing_url} target="_blank" rel="noreferrer">
                  {r.source_id}
                </a>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
