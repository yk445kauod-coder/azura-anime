import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { Icon } from "@/components/Icon";
import IssPanel from "@/components/IssPanel";
import type { Health } from "@/App";
import { fmtBytes, fmtInt, fmtNum, n } from "@/lib/format";

type Stats = {
  stats: Record<string, number | string>;
  byKind: { kind: string; n: number | string }[];
  byYear: { year: number | string; n: number | string }[];
  topDocs: {
    id: number | string;
    source_id: string;
    title: string;
    kind: string;
    word_count: number | string;
    quality_score: number | string;
    published_date: string | null;
    landing_url: string;
    chunks: number | string;
  }[];
  topMetrics: {
    metric: string;
    n: number | string;
    min_value: number | string | null;
    max_value: number | string | null;
    unit: string | null;
  }[];
  pipeline: {
    stage: string;
    status: string;
    items_in: number | string;
    items_out: number | string;
    bytes_in: number | string;
    started_at: string;
    finished_at: string | null;
  }[];
};

export default function Overview({
  health,
  onNavigate,
}: {
  health?: Health | null;
  onNavigate?: (tab: string) => void;
}) {
  const { t } = useI18n();
  const [data, setData] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/stats")
      .then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : setData(d)))
      .catch((e) => setError(String(e)));
  }, []);

  if (error) return <div className="err">Failed to load stats: {error}</div>;
  if (!data) return <div className="muted"><span className="spin" /> loading corpus statistics…</div>;

  const s = data.stats ?? {};
  const byYear = [...data.byYear].sort((a, b) => n(a.year)! - n(b.year)!);
  const maxYear = Math.max(1, ...byYear.map((y) => n(y.n) ?? 0));
  const recent = byYear.slice(-12);
  const maxKind = Math.max(1, ...data.byKind.map((k) => n(k.n) ?? 0));

  // Every card links to the view that holds its records, so a headline number is
  // one click from the evidence behind it.
  const cards = [
    { k: t("Documents"), v: fmtInt(s.documents), s: `${fmtInt(s.documents_with_fulltext)} ${t("with full text")}`, go: "explorer", icon: "BookOpen", spark: recent.map((y) => n(y.n) ?? 0) },
    { k: t("Text chunks"), v: fmtInt(s.chunks), s: `${fmtInt(s.embeddings)} ${t("embedded vectors")}`, go: "explorer", icon: "Database" },
    { k: t("Corpus words"), v: fmtInt(s.corpus_words), s: `${((n(s.corpus_chars) ?? 0) / 1e6).toFixed(1)} M ${t("characters")}`, icon: "FileText" },
    { k: t("Artifacts stored"), v: fmtBytes(s.artifact_bytes), s: t("PDF + fulltext in Neon S3"), icon: "Database" },
    { k: t("Experiments"), v: fmtInt(s.experiments), s: t("catalogued campaigns"), go: "experiments", icon: "FlaskConical" },
    { k: t("Extracted findings"), v: fmtInt(s.findings), s: t("metric / value / unit"), go: "data", icon: "Table2" },
    { k: t("Fire-safety insights"), v: fmtInt(s.insights), s: t("evidence-backed"), go: "insights", icon: "ShieldAlert" },
    { k: t("Indexed vectors"), v: fmtInt(s.embeddings), s: t("384-dim, bge-small-en"), icon: "Activity" },
  ];

  return (
    <div className="grid" style={{ gap: 18 }}>
      {/* Status strip — environment, source and the corpus itself, read live. */}
      <section className="fade-in-up grid g3" style={{ gap: 16 }}>
        <div className="card metric status-card">
          <span className="status-ico"><Icon name="Globe" size={22} /></span>
          <div>
            <div className="k">{t("Environment")}</div>
            <div className="v">0.00 g</div>
            <div className="status-badge"><span className="dot" /> {t("Microgravity")}</div>
          </div>
        </div>
        <div className="card metric status-card">
          <span className="status-ico"><Icon name="Database" size={22} /></span>
          <div>
            <div className="k">{t("Data source")}</div>
            <div className="v">NASA NTRS</div>
            <div className="status-badge"><span className="dot" /> {t("Official data")}</div>
          </div>
        </div>
        <button
          className="card metric status-card status-card-btn"
          onClick={() => onNavigate?.("experiments")}
        >
          <span className="status-ico flame"><Icon name="FlaskConical" size={24} /></span>
          <div style={{ minWidth: 0, textAlign: "start" }}>
            <div className="k">{t("Catalogued campaigns")}</div>
            <div className="v">{fmtInt(s.experiments)}</div>
          </div>
          <Icon name="ArrowRight" size={18} />
        </button>
      </section>

      <section className="hero">
        <div className="eyebrow">{t("Mission Control · Live corpus")}</div>
        <h2>{t("Microgravity combustion & spacecraft fire safety")}</h2>
        <p className="lead">
          {t("IGNIS turns NASA's microgravity combustion literature into a queryable, evidence-linked knowledge base. Every figure below is read live from the corpus; every answer is traced to the passage it came from.")}
        </p>
        <div className="hero-stats">
          <div className="hero-stat">
            <div className="v">{fmtInt(s.documents)}</div>
            <div className="k">{t("Documents")}</div>
          </div>
          <div className="hero-stat">
            <div className="v">{fmtInt(s.chunks)}</div>
            <div className="k">{t("Passages")}</div>
          </div>
          <div className="hero-stat">
            <div className="v">{fmtInt(s.experiments)}</div>
            <div className="k">{t("Campaigns")}</div>
          </div>
          <div className="hero-stat">
            <div className="v">{fmtInt(s.findings)}</div>
            <div className="k">{t("Findings")}</div>
          </div>
          <div className="hero-stat">
            <div className="v">{health?.latency_ms ? `${health.latency_ms} ms` : "—"}</div>
            <div className="k">{t("API latency")}</div>
          </div>
        </div>
      </section>

      <div className="grid g4">
        {cards.map((c) => (
          <div
            className={`card metric${c.go && onNavigate ? " clickable" : ""}`}
            key={c.k}
            role={c.go && onNavigate ? "button" : undefined}
            tabIndex={c.go && onNavigate ? 0 : undefined}
            onClick={c.go && onNavigate ? () => onNavigate(c.go!) : undefined}
            onKeyDown={c.go && onNavigate ? (e) => { if (e.key === "Enter") onNavigate(c.go!); } : undefined}
          >
            <div className="k"><Icon name={c.icon} size={13} /> {c.k}</div>
            <div className="v">{c.v}</div>
            <div className="s">{c.s}</div>
            {c.spark && c.spark.length > 1 && (
              <div className="spark" title={t("documents per year")}>
                {c.spark.map((v, i) => (
                  <i key={i} style={{ height: `${Math.max(8, (v / Math.max(...c.spark!)) * 100)}%` }} />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="grid g2">
        <div className="card">
          <div className="cardhead">
            <h3>{t("Publication timeline")} <small>{t("documents per year in corpus")}</small></h3>
            <span className="pill mono">{byYear.length} {t("years")}</span>
          </div>
          <div className="bars">
            {recent.map((y) => {
              const cnt = n(y.n) ?? 0;
              return (
                <div className="bcol" key={String(y.year)} title={`${y.year}: ${cnt}`}>
                  <span className="bval">{cnt}</span>
                  <div className="bar-v" style={{ height: `${Math.max(3, (cnt / maxYear) * 100)}%` }} />
                  <span className="btick">{String(y.year).slice(2)}</span>
                </div>
              );
            })}
            {recent.length === 0 && <div className="muted">no dated documents yet</div>}
          </div>
        </div>

        <div className="card">
          <div className="cardhead">
            <h3>{t("Document types")} <small>{t("by classification")}</small></h3>
          </div>
          {data.byKind.map((k) => {
            const cnt = n(k.n) ?? 0;
            return (
              <div key={k.kind} style={{ marginBottom: 12 }}>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <span style={{ fontSize: 12.8, textTransform: "capitalize" }}>{k.kind.replace(/_/g, " ")}</span>
                  <span className="mono muted" style={{ fontSize: 11.5 }}>{fmtInt(cnt)}</span>
                </div>
                <div className="bar cy"><i style={{ width: `${(cnt / maxKind) * 100}%` }} /></div>
              </div>
            );
          })}
          {data.byKind.length === 0 && <div className="muted">no documents ingested yet</div>}
        </div>
      </div>

      <div className="grid g2">
        <div className="card">
          <div className="cardhead">
            <h3>{t("Extracted quantitative findings")} <small>{t("regex-extracted metrics")}</small></h3>
            <span className="pill mono">{data.topMetrics.length} {t("metrics")}</span>
          </div>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>{t("Metric")}</th>
                  <th className="num">n</th>
                  <th className="num">min</th>
                  <th className="num">max</th>
                  <th>unit</th>
                </tr>
              </thead>
              <tbody>
                {data.topMetrics.map((m) => (
                  <tr key={m.metric}>
                    <td>{m.metric}</td>
                    <td className="num">{fmtInt(m.n)}</td>
                    <td className="num">{fmtNum(m.min_value, 3)}</td>
                    <td className="num">{fmtNum(m.max_value, 3)}</td>
                    <td>{m.unit ?? "—"}</td>
                  </tr>
                ))}
                {data.topMetrics.length === 0 && (
                  <tr><td className="muted" colSpan={5}>no findings extracted yet</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <div className="cardhead">
            <h3>{t("Pipeline activity")} <small>{t("collection → cleaning → indexing → analysis")}</small></h3>
          </div>
          <div className="scroll">
            <table>
              <thead>
                <tr><th>{t("Stage")}</th><th>{t("Status")}</th><th className="num">In</th><th className="num">Out</th><th className="num">MB</th></tr>
              </thead>
              <tbody>
                {data.pipeline.map((p, i) => (
                  <tr key={i}>
                    <td>{p.stage}</td>
                    <td><span className={`tag ${p.status === "done" ? "" : "sev-high"}`}>{p.status}</span></td>
                    <td className="num">{fmtInt(p.items_in)}</td>
                    <td className="num">{fmtInt(p.items_out)}</td>
                    <td className="num">{n(p.bytes_in) === null ? "—" : ((n(p.bytes_in) as number) / 1e6).toFixed(1)}</td>
                  </tr>
                ))}
                {data.pipeline.length === 0 && (
                  <tr><td className="muted" colSpan={5}>no pipeline runs recorded yet</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="grid g2">
        <div className="card" style={{ padding: 0, overflow: "hidden", border: 0, background: "transparent", boxShadow: "none" }}>
          <IssPanel height={320} />
        </div>
        <div className="mission-panel flame-panel" style={{ minHeight: 320 }}>
          <img
            src="/assets/nasa-flame-flex.jpg"
            alt={t("Spherical flame burning in microgravity — NASA SoFIE experiment on the ISS")}
            loading="lazy"
          />
          <div className="scanlines" aria-hidden />
          <span className="fp-rec"><span className="dot bad live" /> {t("Rec")}</span>
          <span className="fp-credit">{t("NASA · Fire in Space")}</span>
          <div className="flame-caption">
            <div className="flame-caption-title">{t("Spherical flame in microgravity")}</div>
            <p>
              {t("Without buoyancy the flame forms a rounded, soot-quiet envelope instead of Earth's upward plume — NASA's SoFIE experiment on the ISS. Illustrative, not measured corpus data.")}
            </p>
          </div>
        </div>
      </div>

      <div className="grid g2">
        <div className="card">
          <div className="cardhead">
            <h3>{t("Highest-quality documents")} <small>{t("ranked by corpus usefulness score")}</small></h3>
          </div>
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>{t("Title")}</th><th>{t("Type")}</th><th>{t("Year")}</th>
                  <th className="num">{t("Words")}</th>
                  <th className="num">{t("Chunks")}</th>
                  <th className="num">{t("Quality")}</th>
                </tr>
              </thead>
              <tbody>
                {data.topDocs.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <a href={d.landing_url} target="_blank" rel="noreferrer">{d.title}</a>
                      <div className="muted" style={{ fontSize: 10.5 }}>NTRS {d.source_id}</div>
                    </td>
                    <td style={{ textTransform: "capitalize" }}>{d.kind.replace(/_/g, " ")}</td>
                    <td>{d.published_date ? String(d.published_date).slice(0, 4) : "—"}</td>
                    <td className="num">{fmtInt(d.word_count)}</td>
                    <td className="num">{fmtInt(d.chunks)}</td>
                    <td className="num">{fmtNum(d.quality_score, 3)}</td>
                  </tr>
                ))}
                {data.topDocs.length === 0 && (
                  <tr><td className="muted" colSpan={6}>run <code>npm run pipeline:all</code> to populate the corpus</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
