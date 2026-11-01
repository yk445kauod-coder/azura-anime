import { NextResponse } from "next/server";
import { q } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Fire Safety Insights — curated, evidence-backed findings for the dashboard. */
export async function GET() {
  try {
    const insights = await q(
      `SELECT id, slug, title, body, category, severity, confidence,
              supporting_documents, generated_by, created_at
         FROM ignis.insight
        ORDER BY CASE severity
                   WHEN 'critical' THEN 0 WHEN 'high' THEN 1
                   WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
                 confidence DESC`,
    );
    const metrics = await q(
      `SELECT metric, count(*)::int AS n,
              round(min(value)::numeric, 3) AS min_value,
              round(max(value)::numeric, 3) AS max_value,
              round(avg(value)::numeric, 3) AS avg_value,
              mode() WITHIN GROUP (ORDER BY unit) AS unit
         FROM ignis.finding WHERE value IS NOT NULL
        GROUP BY metric HAVING count(*) >= 2 ORDER BY n DESC`,
    );
    const gaps = await q(
      `SELECT e.code, e.name, e.campaign,
              count(DISTINCT ed.document_id)::int AS documents
         FROM ignis.experiment e
         LEFT JOIN ignis.experiment_document ed ON ed.experiment_id = e.id
        GROUP BY e.code, e.name, e.campaign
        ORDER BY documents ASC`,
    );
    return NextResponse.json({ insights, metrics, coverage: gaps });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
