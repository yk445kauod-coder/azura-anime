import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";

type Insight = {
  id: number; slug: string; title: string; body: string; category: string;
  severity: string; confidence: number; supporting_documents: number[];
  generated_by: string; created_at: string;
};
type Metric = {
  metric: string; n: number; min_value: number | null; max_value: number | null;
  avg_value: number | null; unit: string | null;
};
type Coverage = { code: string; name: string; campaign: string | null; documents: number };

export default function Insights() {
  const { t } = useI18n();
  const [insights, setInsights] = useState<Insight[]>([]);
  const [metrics, setMetrics] = useState<Metric[]>([]);
  const [coverage, setCoverage] = useState<Coverage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    fetch("/api/insights")
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setError(d.error);
        setInsights(d.insights ?? []);
        setMetrics(d.metrics ?? []);
        setCoverage(d.coverage ?? []);
      })
      .catch((e) => setError(String(e)));
  }, []);

  if (error) return <div className="card err">{error}</div>;

  const categories = Array.from(new Set(insights.map((i) => i.category)));
  const shown = filter ? insights.filter((i) => i.category === filter) : insights;
  const maxCoverage = Math.max(1, ...coverage.map((c) => c.documents));

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="card">
        <h3>
          Fire Safety Insights{" "}
          <small>evidence-backed findings for spacecraft fire-safety engineering</small>
        </h3>
        <div className="row" style={{ gap: 7 }}>
          <button
            className="ghost"
            style={{ borderColor: !filter ? "rgba(255,106,31,.65)" : undefined, color: !filter ? "#fff" : undefined }}
            onClick={() => setFilter("")}
          >
            all ({insights.length})
          </button>
          {categories.map((c) => (
            <button
              key={c}
              className="ghost"
              style={{ borderColor: filter === c ? "rgba(255,106,31,.65)" : undefined, color: filter === c ? "#fff" : undefined }}
              onClick={() => setFilter(c)}
            >
              {c.replace(/_/g, " ")} ({insights.filter((i) => i.category === c).length})
            </button>
          ))}
        </div>
      </div>

      {shown.map((ins) => (
        <div className="card" key={ins.id}>
          <div className="row" style={{ marginBottom: 9, justifyContent: "space-between" }}>
            <strong style={{ fontSize: 15.5 }}>{ins.title}</strong>
            <div className="row" style={{ flex: "0 0 auto", gap: 7 }}>
              <span className={`tag sev-${ins.severity}`}>{ins.severity}</span>
              <span className="pill">confidence {(ins.confidence * 100).toFixed(0)}%</span>
              <span className="pill">{ins.supporting_documents?.length ?? 0} sources</span>
              <span className="pill">{ins.generated_by}</span>
            </div>
          </div>
          <div className="answer" style={{ fontSize: 13.2 }}>{ins.body}</div>
          {ins.supporting_documents?.length > 0 && (
            <div className="muted" style={{ marginTop: 9 }}>
              Supporting document IDs: {ins.supporting_documents.slice(0, 12).join(", ")}
              {ins.supporting_documents.length > 12 ? " …" : ""}
            </div>
          )}
        </div>
      ))}

      {insights.length === 0 && (
        <div className="card muted">
          No insights yet. Run <code>python3 pipeline/analyze.py</code> after indexing the corpus.
        </div>
      )}

      <div className="grid g2">
        <div className="card">
          <h3>
            Quantitative corpus signals{" "}
            <small>distributions of extracted metrics across all documents</small>
          </h3>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>{t("Metric")}</th><th style={{ textAlign: "right" }}>n</th>
                  <th style={{ textAlign: "right" }}>min</th><th style={{ textAlign: "right" }}>mean</th>
                  <th style={{ textAlign: "right" }}>max</th><th>unit</th>
                </tr>
              </thead>
              <tbody>
                {metrics.map((m) => (
                  <tr key={m.metric}>
                    <td>{m.metric}</td>
                    <td style={{ textAlign: "right" }}>{m.n}</td>
                    <td style={{ textAlign: "right" }}>{m.min_value ?? "—"}</td>
                    <td style={{ textAlign: "right" }}>{m.avg_value ?? "—"}</td>
                    <td style={{ textAlign: "right" }}>{m.max_value ?? "—"}</td>
                    <td>{m.unit ?? "—"}</td>
                  </tr>
                ))}
                {metrics.length === 0 && (
                  <tr><td className="muted">no numeric findings extracted yet</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <h3>
            Data coverage per experiment{" "}
            <small>evidence density — where the corpus is thin</small>
          </h3>
          <div className="scroll">
            {coverage.map((c) => (
              <div key={c.code} style={{ marginBottom: 11 }}>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <span style={{ fontSize: 12.8 }}>{c.code} <span className="muted">{c.name}</span></span>
                  <span className="muted" style={{ fontSize: 11.5 }}>{c.documents} docs</span>
                </div>
                <div className="bar">
                  <i style={{ width: `${(c.documents / maxCoverage) * 100}%` }} />
                </div>
              </div>
            ))}
          </div>
          <div className="muted" style={{ marginTop: 10 }}>
            Low-coverage campaigns are an explicit data limitation: IGNIS flags gaps rather than
            inferring results from insufficient evidence.
          </div>
        </div>
      </div>
    </div>
  );
}
