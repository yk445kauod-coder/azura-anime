import { NextResponse } from "next/server";
import { one, q } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const documentId = Number(id);
  if (!Number.isFinite(documentId)) {
    return NextResponse.json({ error: "invalid document id" }, { status: 400 });
  }
  try {
    const document = await one(
      `SELECT id, source, source_id, kind, title, abstract, authors, report_numbers,
              center, distribution, keywords, subject_categories, published_date,
              word_count, char_count, quality_score, landing_url
         FROM ignis.document WHERE id = $1`,
      [documentId],
    );
    if (!document) {
      return NextResponse.json({ error: "document not found" }, { status: 404 });
    }
    const chunks = await q(
      `SELECT c.id, c.ordinal, c.kind, c.section_path, c.token_count,
              left(c.content, 600) AS preview,
              EXISTS (SELECT 1 FROM ignis.chunk_embedding e WHERE e.chunk_id = c.id) AS embedded
         FROM ignis.chunk c WHERE c.document_id = $1 ORDER BY c.ordinal`,
      [documentId],
    );
    const findings = await q(
      `SELECT id, metric, value, value_max, unit, statement, confidence, evidence_quote
         FROM ignis.finding WHERE document_id = $1 ORDER BY metric LIMIT 100`,
      [documentId],
    );
    const experiments = await q(
      `SELECT e.code, e.name, ed.relation
         FROM ignis.experiment_document ed
         JOIN ignis.experiment e ON e.id = ed.experiment_id
        WHERE ed.document_id = $1`,
      [documentId],
    );
    return NextResponse.json({ document, chunks, findings, experiments });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
