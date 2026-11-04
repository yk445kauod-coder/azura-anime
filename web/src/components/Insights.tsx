import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { Icon } from "@/components/Icon";
import { clampPct, fmtInt, fmtNum, n, pct } from "@/lib/format";

type Insight = {
  id: number | string; slug: string; title: string; body: string; category: string;
  severity: string; confidence: number | string | null; supporting_documents: (number | string)[];
  generated_by: string; created_at: string;
};
type Metric = {
  metric: string; n: number | string; min_value: number | string | null;
  max_value: number | string | null; avg_value: number | string | null; unit: string | null;
};
type Coverage = { code: string; name: string; campaign: string | null; documents: number | string };

const SEV_ORDER = ["critical", "high", "medium", "low", "info"];

export default function Insights() {
  const { t } = useI18n();
  const [insights, setInsights] = useState<Insight[]>([]);
  const [metrics, setMetrics] = useState<Metric[]>([]);
  const [coverage, setCoverage] = useState<Coverage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [q, setQ] = useState("");

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
  const shown = insights.filter((i) => {
    if (filter && i.category !== filter) return false;
    if (q.trim()) {
      const hay = `${i.title} ${i.body}`.toLowerCase();
      if (!hay.includes(q.trim().toLowerCase())) return false;
    }
    return true;
  });

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const i of insights) c[i.severity] = (c[i.severity] ?? 0) + 1;
    return c;
  }, [insights]);

  const maxCoverage = Math.max(1, ...coverage.map((c) => n(c.documents) ?? 0));
  const sevTotal = insights.length || 1;

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="grid g4">
        <div className="card metric">
          <div className="k"><Icon name="ShieldAlert" size={13} /> {t("Insights")}</div>
          <div className="v">{fmtInt(insights.length)}</div>
          <div className="s">{t("evidence-backed findings")}</div>
        </div>
        <div className="card metric">
          <div className="k"><Icon name="Circle" size={13} /> {t("Critical")}</div>
          <div className="v" style={{ color: "var(--red)" }}>{fmtInt(counts.critical ?? 0)}</div>
          <div className="s">{t("immediate design impact")}</div>
        </div>
        <div className="card metric">
          <div className="k"><Icon name="Activity" size={13} /> {t("High severity")}</div>
          <div className="v" style={{ color: "var(--flame)" }}>{fmtInt(counts.high ?? 0)}</div>
          <div className="s">{t("material risk to missions")}</div>
        </div>
        <div className="card metric">
          <div className="k"><Icon name="Database" size={13} /> {t("Metrics tracked")}</div>
          <div className="v">{fmtInt(metrics.length)}</div>
          <div className="s">{t("extracted quantities")}</div>
        </div>
      </div>

      <div className="card">
        <div className="cardhead">
          <h3>{t("Fire Safety Insights")} <small>{t("evidence-backed findings for spacecraft fire-safety engineering")}</small></h3>
        </div>
        <div className="controls" style={{ marginTop: 0 }}>
          <input
            className="grow"
            placeholder={t("Search insights…")}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <div className="row" style={{ gap: 7, marginTop: 11 }}>
          <button className={`ghost ${!filter ? "on" : ""}`} onClick={() => setFilter("")}>
            {t("all")} ({insights.length})
          </button>
          {categories.map((c) => (
            <button
              key={c}
              className={`ghost ${filter === c ? "on" : ""}`}
              onClick={() => setFilter(c)}
            >
              {c.replace(/_/g, " ")} ({insights.filter((i) => i.category === c).length})
            </button>
          ))}
        </div>
      </div>

      {shown.map((ins) => {
        const conf = n(ins.confidence);
        const sources = ins.supporting_documents?.length ?? 0;
        return (
          <div className="card" key={ins.id}>
            <div className="row" style={{ marginBottom: 10, justifyContent: "space-between" }}>
              <strong style={{ fontSize: 15.5 }}>{ins.title}</strong>
              <div className="row" style={{ flex: "0 0 auto", gap: 7 }}>
                <span className={`tag sev-${ins.severity}`}>{ins.severity}</span>
                <span className="pill mono">{t("confidence")} {pct(conf)}</span>
                <span className="pill mono">{fmtInt(sources)} {t("sources")}</span>
                <span className="pill">{ins.generated_by}</span>
              </div>
            </div>
            <div className="answer" style={{ fontSize: 13.2 }}>{ins.body}</div>
            <div className="muted" style={{ marginTop: 10 }}>
              {t("Supporting documents:")}{" "}
              {(ins.supporting_documents ?? []).slice(0, 12).map(String).join(", ")}
              {sources > 12 ? " …" : ""}
            </div>
          </div>
        );
      })}

      {shown.length === 0 && insights.length > 0 && (
        <div className="card muted">{t("No insights match this filter.")}</div>
      )}

      {insights.length === 0 && (
        <div className="card muted">
          {t("No insights yet. Run")} <code>python3 pipeline/analyze.py</code> {t("after indexing the corpus.")}
        </div>
      )}

      <div className="grid g2">
        <div className="card">
          <div className="cardhead">
            <h3>{t("Quantitative corpus signals")} <small>{t("distributions of extracted metrics across all documents")}</small></h3>
          </div>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>{t("Metric")}</th><th className="num">n</th>
                  <th className="num">min</th><th className="num">mean</th>
                  <th className="num">max</th><th>unit</th>
                </tr>
              </thead>
              <tbody>
                {metrics.map((m) => (
                  <tr key={m.metric}>
                    <td>{m.metric}</td>
                    <td className="num">{fmtInt(m.n)}</td>
                    <td className="num">{fmtNum(m.min_value, 3)}</td>
                    <td className="num">{fmtNum(m.avg_value, 3)}</td>
                    <td className="num">{fmtNum(m.max_value, 3)}</td>
                    <td>{m.unit ?? "—"}</td>
                  </tr>
                ))}
                {metrics.length === 0 && (
                  <tr><td className="muted" colSpan={6}>no numeric findings extracted yet</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <div className="cardhead">
            <h3>{t("Data coverage per experiment")} <small>{t("evidence density — where the corpus is thin")}</small></h3>
          </div>
          <div className="scroll">
            {coverage.map((c) => {
              const docs = n(c.documents) ?? 0;
              const thin = docs / maxCoverage < 0.34;
              return (
                <div key={c.code} style={{ marginBottom: 11 }}>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <span style={{ fontSize: 12.8 }}>
                      {c.code} <span className="muted">{c.name}</span>
                    </span>
                    <span className="mono muted" style={{ fontSize: 11.5 }}>{fmtInt(docs)} {t("docs")}</span>
                  </div>
                  <div className={`bar ${thin ? "" : "gr"}`}>
                    <i style={{ width: `${clampPct((docs / maxCoverage) * 100)}%` }} />
                  </div>
                </div>
              );
            })}
            {coverage.length === 0 && <div className="muted">{t("no campaign coverage data")}</div>}
          </div>
          <div className="muted" style={{ marginTop: 10 }}>
            {t("Low-coverage campaigns are an explicit data limitation: IGNIS flags gaps rather than inferring results from insufficient evidence.")}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="cardhead">
          <h3>{t("Severity mix")} <small>{t("how the findings distribute across impact")}</small></h3>
        </div>
        <div className="bars" style={{ height: 120 }}>
          {SEV_ORDER.filter((sv) => counts[sv]).map((sv) => (
            <div className="bcol" key={sv} title={`${sv}: ${counts[sv]}`}>
              <span className="bval">{counts[sv]}</span>
              <div className="bar-v" style={{ height: `${Math.max(6, (counts[sv] / sevTotal) * 100)}%` }} />
              <span className="btick">{sv}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
