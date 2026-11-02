/**
 * Chart panel.
 *
 * Charts arrive from the worker as SVG strings built from real
 * `ignis.dataset_row` measurements, so the dashboard renders exactly what the
 * export endpoints embed in a PDF or DOCX. The source note is always shown
 * because these values are mined from report text by regex, not a curated
 * NASA dataset, and the reader needs to know that.
 */

export type ChartPayload = {
  spec: {
    type: "bar" | "line" | "scatter";
    title: string;
    x_label: string;
    y_label: string;
    unit: string;
    series: { label: string; points: { x: number | string; y: number }[] }[];
    source_note?: string;
  };
  svg: string;
  rows: Record<string, unknown>[];
  note?: string;
};

import { useI18n } from "@/lib/i18n";

export default function Chart({ chart }: { chart: ChartPayload }) {
  const { t } = useI18n();
  const points = chart.spec.series.reduce((n, s) => n + s.points.length, 0);

  return (
    <div className="card chartcard">
      <div className="cardhead">
        <h3>{chart.spec.title}</h3>
        <span className="muted">
          {chart.spec.type} · {points} measured values
          {chart.spec.unit ? ` · ${chart.spec.unit}` : ""}
        </span>
      </div>
      {/* The SVG comes from our own renderer, not user input, so it is safe to
          inject; a markdown renderer cannot display it otherwise. */}
      <div className="chartsvg" dangerouslySetInnerHTML={{ __html: chart.svg }} />
      <div className="chartfoot">
        <span className="muted">{chart.note ?? chart.spec.source_note}</span>
      </div>
      <details className="chartdata">
        <summary>{t("Underlying values")}</summary>
        <table className="datatable">
          <thead>
            <tr>
              <th>x</th>
              <th>{chart.spec.y_label}{chart.spec.unit ? ` (${chart.spec.unit})` : ""}</th>
            </tr>
          </thead>
          <tbody>
            {chart.spec.series[0].points.map((p, i) => (
              <tr key={i}>
                <td>{String(p.x)}</td>
                <td>{p.y}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
