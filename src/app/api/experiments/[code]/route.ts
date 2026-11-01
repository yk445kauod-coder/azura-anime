import { NextResponse } from "next/server";
import { one, q } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ code: string }> },
) {
  const { code } = await params;
  try {
    const experiment = await one(
      `SELECT e.*, f.code AS facility, f.name AS facility_name, f.platform, f.g_level
         FROM ignis.experiment e
         LEFT JOIN ignis.facility f ON f.id = e.facility_id
        WHERE lower(e.code) = lower($1) OR $1 = ANY(e.aliases)`,
      [code],
    );
    if (!experiment) {
      return NextResponse.json({ error: `experiment ${code} not found` }, { status: 404 });
    }
    const id = (experiment as { id: number }).id;
    const documents = await q(
      `SELECT d.id, d.source_id, d.title, d.kind, d.published_date, d.word_count,
              d.quality_score, d.landing_url, ed.relation
         FROM ignis.experiment_document ed
         JOIN ignis.document d ON d.id = ed.document_id
        WHERE ed.experiment_id = $1
        ORDER BY d.quality_score DESC NULLS LAST LIMIT 50`,
      [id],
    );
    const findings = await q(
      `SELECT f.id, f.metric, f.value, f.value_max, f.unit, f.statement,
              f.confidence, f.evidence_quote, f.document_id
         FROM ignis.finding f
         JOIN ignis.experiment_document ed ON ed.document_id = f.document_id
        WHERE ed.experiment_id = $1
        ORDER BY f.metric, f.value LIMIT 200`,
      [id],
    );
    return NextResponse.json({ experiment, documents, findings });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
