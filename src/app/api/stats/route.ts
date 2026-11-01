import { NextResponse } from "next/server";
import { q } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const stats = await q("SELECT * FROM ignis.document_stats");
    const byKind = await q(
      `SELECT kind, count(*)::int AS n FROM ignis.document
        GROUP BY kind ORDER BY n DESC`,
    );
    const byYear = await q(
      `SELECT extract(year FROM published_date)::int AS year, count(*)::int AS n
         FROM ignis.document
        WHERE published_date IS NOT NULL
        GROUP BY 1 ORDER BY 1`,
    );
    const topDocs = await q(
      `SELECT d.id, d.source_id, d.title, d.kind, d.word_count, d.quality_score,
              d.published_date, d.landing_url,
              (SELECT count(*)::int FROM ignis.chunk c WHERE c.document_id = d.id) AS chunks
         FROM ignis.document d
        ORDER BY d.quality_score DESC NULLS LAST
        LIMIT 12`,
    );
    const topMetrics = await q(
      `SELECT metric, count(*)::int AS n,
              round(min(value)::numeric, 3) AS min_value,
              round(max(value)::numeric, 3) AS max_value,
              mode() WITHIN GROUP (ORDER BY unit) AS unit
         FROM ignis.finding
        WHERE value IS NOT NULL
        GROUP BY metric HAVING count(*) >= 2
        ORDER BY n DESC LIMIT 12`,
    );
    const pipeline = await q(
      `SELECT stage, status, items_in, items_out, bytes_in, started_at, finished_at
         FROM ignis.pipeline_run ORDER BY id DESC LIMIT 10`,
    );

    return NextResponse.json({
      stats: stats[0] ?? {},
      byKind,
      byYear,
      topDocs,
      topMetrics,
      pipeline,
    });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
