import { useEffect, useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n";

/**
 * Data Explorer.
 *
 * Every number on this screen comes from `ignis.dataset_row`, which is a view
 * over `ignis.finding` — values extracted from NTRS report text. Nothing here
 * is simulated, interpolated or smoothed. Because the extractor is a regex over
 * prose, the UI states that provenance plainly and shows the verbatim evidence
 * quote next to each value so a reader can judge it.
 *
 * Units in the corpus are heterogeneous (pressure appears in atm, kPa, psi,
 * torr and bar), so the API also returns a canonical-unit value. Charts plot the
 * canonical value and the table shows the recorded one.
 */

type DatasetMeta = {
  key: string;
  name: string;
  canonical_unit: string | null;
  value_count: number;
  document_count: number;
  recorded_unit_count: number;
  recorded_units: string[] | null;
  value_min: number | null;
  value_max: number | null;
  ranged_value_count: number;
  mean_confidence: number | null;
  extraction_methods: string[] | null;
};

type Row = {
  finding_id: number;
  value: number;
  unit: string | null;
  raw_value: number | null;
  raw_unit: string | null;
  value_max: number | null;
  statement: string | null;
  evidence_quote: string | null;
  confidence: number | null;
  extraction_method: string | null;
  document_id: number | null;
  document_source_id: string | null;
  document_title: string | null;
  landing_url: string | null;
  experiment_code: string | null;
  experiment_name: string | null;
};

type Stats = {
  n: number;
  min_value: number | null;
  max_value: number | null;
  mean_value: number | null;
  sd_value: number | null;
  median_value: number | null;
};

type Bucket = { bucket: number; n: number; lo: number | null; hi: number | null };

const num = (v: number | null | undefined, digits = 2) =>
  v === null || v === undefined || Number.isNaN(Number(v)) ? "—" : Number(v).toFixed(digits);

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/** Histogram over the real recorded values. Bars are counts, not density. */
function Histogram({ buckets, unit }: { buckets: Bucket[]; unit: string | null }) {
  const max = Math.max(1, ...buckets.map((b) => b.n));
  if (!buckets.length) return <div className="muted">no distribution available</div>;
  return (
    <div className="chart">
      <div className="bars">
        {buckets.map((b, i) => (
          <div className="bcol" key={i} title={`${b.n} value(s) between ${num(b.lo)} and ${num(b.hi)} ${unit ?? ""}`}>
            <span className="bval">{b.n}</span>
            <div className="bar-v" style={{ height: `${(b.n / max) * 100}%` }} />
            <span className="btick">{num(b.lo, 1)}</span>
          </div>
        ))}
      </div>
      <div className="chart-cap">
        Distribution of {buckets.reduce((n, b) => n + b.n, 0)} recorded values · x-axis: {unit ?? "value"} ·
        y-axis: number of measurements
      </div>
    </div>
  );
}

/**
 * Scatter of each measurement against its position in the sorted series, so
 * outliers and clusters are visible without implying a time ordering that the
 * data does not have.
 */
function Scatter({ rows, unit }: { rows: Row[]; unit: string | null }) {
  const pts = rows.filter((r) => Number.isFinite(Number(r.value)));
  if (pts.length < 2) return null;
  const W = 720, H = 240, PAD = 34;
  const vals = pts.map((r) => Number(r.value));
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const span = hi - lo || 1;
  const x = (i: number) => PAD + (i / (pts.length - 1)) * (W - PAD * 2);
  const y = (v: number) => H - PAD - ((v - lo) / span) * (H - PAD * 2);
  const ticks = [lo, lo + span / 2, hi];
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} className="scatter" role="img"
           aria-label={`Recorded values in ${unit ?? "canonical units"}`}>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={PAD} x2={W - PAD} y1={y(t)} y2={y(t)} stroke="#1e2c45" strokeWidth="1" />
            <text x={4} y={y(t) + 4} fill="#94A3B8" fontSize="10">{num(t, 0)}</text>
          </g>
        ))}
        {pts.map((r, i) => (
          <circle key={r.finding_id} cx={x(i)} cy={y(Number(r.value))} r="3.4" fill="#38BDF8" opacity="0.85">
            <title>{`${num(r.value)} ${unit ?? ""} — ${r.document_title ?? "source"}`}</title>
          </circle>
        ))}
        <line x1={PAD} x2={W - PAD} y1={H - PAD} y2={H - PAD} stroke="#2b3b5c" strokeWidth="1" />
      </svg>
      <div className="chart-cap">
        Each point is one extracted measurement, ordered by value · y-axis: {unit ?? "value"} · n = {pts.length}
      </div>
    </div>
  );
}

export default function DataExplorer({ focusKey }: { focusKey?: string }) {
  const { t } = useI18n();
  const [datasets, setDatasets] = useState<DatasetMeta[]>([]);
  const [total, setTotal] = useState(0);
  const [key, setKey] = useState("");
  const [data, setData] = useState<{ dataset: DatasetMeta; rows: Row[]; stats: Stats; histogram: Bucket[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [minC, setMinC] = useState(0);
  const [expFilter, setExpFilter] = useState("");
  const [q, setQ] = useState("");

  useEffect(() => {
    fetch("/api/datasets")
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setError(d.error);
        setDatasets(d.datasets ?? []);
        setTotal(d.total_measurements ?? 0);
        if ((d.datasets ?? []).length) setKey((k) => k || d.datasets[0].key);
      })
      .catch((e) => setError(String(e)));
  }, []);

  // Deep link from search: jump straight to the named dataset.
  useEffect(() => {
    if (focusKey) setKey(focusKey);
  }, [focusKey]);

  useEffect(() => {
    if (!key) return;
    setLoading(true);
    setError(null);
    fetch(`/api/datasets/${encodeURIComponent(key)}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setError(d.error);
        setData(d.dataset ? d : null);
        setLoading(false);
      })
      .catch((e) => {
        setError(String(e));
        setLoading(false);
      });
  }, [key]);

  const experiments = useMemo(
    () => Array.from(new Set((data?.rows ?? []).map((r) => r.experiment_code).filter(Boolean) as string[])).sort(),
    [data]
  );

  // Client-side filtering only narrows the already-real rows; it never
  // recomputes or alters a measured value.
  const rows = useMemo(() => {
    let rs = data?.rows ?? [];
    if (minC > 0) rs = rs.filter((r) => (r.confidence ?? 0) >= minC);
    if (expFilter) rs = rs.filter((r) => r.experiment_code === expFilter);
    const needle = q.trim().toLowerCase();
    if (needle)
      rs = rs.filter(
        (r) =>
          (r.document_title ?? "").toLowerCase().includes(needle) ||
          (r.statement ?? "").toLowerCase().includes(needle) ||
          (r.evidence_quote ?? "").toLowerCase().includes(needle)
      );
    return rs;
  }, [data, minC, expFilter, q]);

  const unit = data?.dataset.canonical_unit ?? null;

  function exportCsv() {
    if (!data) return;
    const head = ["finding_id", "value", "unit", "raw_value", "raw_unit", "confidence", "experiment", "document_source_id", "document_title", "landing_url", "evidence_quote"];
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const body = rows.map((r) =>
      [r.finding_id, r.value, r.unit, r.raw_value, r.raw_unit, r.confidence, r.experiment_code, r.document_source_id, r.document_title, r.landing_url, r.evidence_quote].map(esc).join(",")
    );
    download(`ignis-${key}.csv`, [head.join(","), ...body].join("\n"));
  }

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="card">
        <h3>
          {t("Data Explorer")} <small>{t("measured values extracted from NASA NTRS microgravity combustion reports")}</small>
        </h3>
        <div className="muted">
          {datasets.length} variables · {total} recorded measurements across the corpus. Values are
          extracted automatically from report text by regular expression, then unit-normalised for
          plotting. Each row links back to the exact passage it came from. This is mined evidence,
          not a NASA-curated machine-readable dataset — treat single values with caution.
        </div>
      </div>

      {error && <div className="card err">{error}</div>}

      <div className="card">
        <div className="row">
          <label style={{ flex: "2 1 320px" }}>
            <span className="muted">{t("Variable")}</span>
            <select className="input" value={key} onChange={(e) => { setKey(e.target.value); setExpFilter(""); }}>
              {datasets.map((d) => (
                <option key={d.key} value={d.key}>
                  {d.name} — {d.value_count} values ({d.canonical_unit ?? "no unit"})
                </option>
              ))}
            </select>
          </label>
          <label style={{ flex: "1 1 170px" }}>
            <span className="muted">{t("Min. extractor confidence")}</span>
            <select className="input" value={minC} onChange={(e) => setMinC(Number(e.target.value))}>
              <option value={0}>any</option>
              <option value={0.5}>≥ 0.50</option>
              <option value={0.7}>≥ 0.70</option>
              <option value={0.8}>≥ 0.80</option>
            </select>
          </label>
          <label style={{ flex: "1 1 170px" }}>
            <span className="muted">{t("Experiment")}</span>
            <select className="input" value={expFilter} onChange={(e) => setExpFilter(e.target.value)}>
              <option value="">all linked experiments</option>
              {experiments.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
          </label>
          <label style={{ flex: "2 1 220px" }}>
            <span className="muted">{t("Filter rows by text")}</span>
            <input className="input" value={q} onChange={(e) => setQ(e.target.value)}
                   placeholder="search title, statement or evidence…" />
          </label>
        </div>
        {data && (
          <div className="row" style={{ marginTop: 12, gap: 8 }}>
            <span className="pill">n = {rows.length}{rows.length !== data.stats.n ? ` of ${data.stats.n}` : ""}</span>
            <span className="pill">unit {unit ?? "—"}</span>
            {data.dataset.recorded_unit_count > 1 && (
              <span className="pill warnpill">
                {data.dataset.recorded_unit_count} recorded units: {(data.dataset.recorded_units ?? []).join(", ")}
              </span>
            )}
            <button className="ghost" style={{ flex: "0 0 auto" }} onClick={exportCsv} disabled={!rows.length}>
              Export CSV
            </button>
          </div>
        )}
      </div>

      {data && (
        <>
          <div className="grid g4">
            <div className="card metric">
              <div className="k">{t("Measurements")}</div>
              <div className="v">{data.stats.n}</div>
              <div className="s">across {data.dataset.document_count} source documents</div>
            </div>
            <div className="card metric">
              <div className="k">{t("Range")}</div>
              <div className="v" style={{ fontSize: 21 }}>
                {num(data.stats.min_value, 1)} – {num(data.stats.max_value, 1)}
              </div>
              <div className="s">{unit ?? "canonical units"}</div>
            </div>
            <div className="card metric">
              <div className="k">{t("Median")}</div>
              <div className="v">{num(data.stats.median_value, 1)}</div>
              <div className="s">mean {num(data.stats.mean_value, 1)} · sd {num(data.stats.sd_value, 1)}</div>
            </div>
            <div className="card metric">
              <div className="k">{t("Extractor confidence")}</div>
              <div className="v">{num(data.dataset.mean_confidence, 2)}</div>
              <div className="s">
                {data.dataset.ranged_value_count} value(s) recorded as a range
              </div>
            </div>
          </div>

          <div className="grid g2">
            <div className="card">
              <h3>{t("Distribution ")}<small>{data.dataset.name} · {unit ?? "—"}</small></h3>
              <Histogram buckets={data.histogram} unit={unit} />
            </div>
            <div className="card">
              <h3>{t("Values by rank ")}<small>outliers and clustering</small></h3>
              <Scatter rows={rows} unit={unit} />
            </div>
          </div>

          <div className="card">
            <h3>
              Recorded values and evidence{" "}
              <small>every row carries its source passage</small>
            </h3>
            <div className="scroll">
              <table>
                <thead>
                  <tr>
                    <th style={{ textAlign: "right" }}>{t("Value")}</th>
                    <th>{t("Unit")}</th>
                    <th>{t("As recorded")}</th>
                    <th style={{ textAlign: "right" }}>{t("Conf.")}</th>
                    <th>{t("Experiment")}</th>
                    <th>{t("Source document")}</th>
                    <th>{t("Evidence passage")}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.finding_id}>
                      <td style={{ textAlign: "right" }}>{num(r.value, 3)}</td>
                      <td>{r.unit ?? "—"}</td>
                      <td className="muted">{num(r.raw_value, 3)} {r.raw_unit ?? ""}</td>
                      <td style={{ textAlign: "right" }}>{num(r.confidence, 2)}</td>
                      <td>{r.experiment_code ?? <span className="muted">—</span>}</td>
                      <td style={{ maxWidth: 260 }}>
                        {r.landing_url ? (
                          <a href={r.landing_url} target="_blank" rel="noreferrer">
                            {r.document_title ?? r.document_source_id} ↗
                          </a>
                        ) : (
                          r.document_title ?? "—"
                        )}
                      </td>
                      <td style={{ maxWidth: 380 }} className="muted">
                        {r.evidence_quote ? `“${r.evidence_quote.slice(0, 180)}${r.evidence_quote.length > 180 ? "…" : ""}”` : "—"}
                      </td>
                    </tr>
                  ))}
                  {rows.length === 0 && (
                    <tr><td className="muted" colSpan={7}>{t("No values match the current filters.")}</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card muted">
            <strong style={{ color: "var(--text)" }}>{t("Data limitations.")}</strong> These measurements are
            mined from the prose of {data.dataset.document_count} NTRS report
            {data.dataset.document_count === 1 ? "" : "s"} by pattern matching
            ({data.dataset.extraction_methods?.join(", ") ?? "regex"}), not transcribed from a curated
            dataset. Context such as ambient pressure, oxygen fraction and sample geometry is often
            stated in the surrounding text rather than attached to the number, so values from
            different experiments are not always directly comparable. The confidence column reflects
            how cleanly the pattern matched, not how scientifically reliable the figure is.
          </div>
        </>
      )}

      {loading && !data && <div className="card"><span className="spin" /> loading dataset…</div>}
    </div>
  );
}
