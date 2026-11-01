import { NextResponse } from "next/server";
import { q } from "@/lib/db";

export const dynamic = "force-dynamic";

/** Document explorer with keyword + trigram search and filters. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const search = (url.searchParams.get("q") || "").trim();
  const kind = url.searchParams.get("kind") || null;
  const experiment = url.searchParams.get("experiment") || null;
  const limit = Math.min(Number(url.searchParams.get("limit") || 25), 100);
  const offset = Math.max(Number(url.searchParams.get("offset") || 0), 0);

  try {
    const rows = await q(
      `WITH filtered AS (
         SELECT d.*,
                (SELECT count(*)::int FROM ignis.chunk c WHERE c.document_id = d.id) AS chunks
           FROM ignis.document d
          WHERE ($1 = '' OR d.search_tsv @@ websearch_to_tsquery('english', $1)
                        OR d.title ILIKE '%' || $1 || '%')
            AND ($2::text IS NULL OR d.kind::text = $2)
            AND ($3::text IS NULL OR EXISTS (
                  SELECT 1 FROM ignis.experiment_document ed
                    JOIN ignis.experiment e ON e.id = ed.experiment_id
                   WHERE ed.document_id = d.id
                     AND (lower(e.code) = lower($3) OR $3 = ANY(e.aliases))))
       )
       SELECT id, source_id, title, kind, abstract, authors, published_date,
              word_count, quality_score, has_fulltext, landing_url, chunks
         FROM filtered
        ORDER BY quality_score DESC NULLS LAST, id
        LIMIT $4 OFFSET $5`,
      [search, kind, experiment, limit, offset],
    );
    const total = await q(
      `SELECT count(*)::int AS n FROM ignis.document d
        WHERE ($1 = '' OR d.search_tsv @@ websearch_to_tsquery('english', $1)
                      OR d.title ILIKE '%' || $1 || '%')
          AND ($2::text IS NULL OR d.kind::text = $2)
          AND ($3::text IS NULL OR EXISTS (
                SELECT 1 FROM ignis.experiment_document ed
                  JOIN ignis.experiment e ON e.id = ed.experiment_id
                 WHERE ed.document_id = d.id
                   AND (lower(e.code) = lower($3) OR $3 = ANY(e.aliases))))`,
      [search, kind, experiment],
    );
    return NextResponse.json({ documents: rows, total: total[0]?.n ?? 0, limit, offset });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
