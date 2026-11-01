import { NextResponse } from "next/server";
import { runPipeline } from "@/lib/pipeline";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type SearchResult = {
  query: string;
  hits: Array<{
    chunk_id: number;
    document_id: number;
    title: string;
    source_id: string;
    kind: string;
    section_path: string | null;
    content: string;
    final_score: number;
    vector_score: number;
    keyword_score: number;
    rerank_score: number;
    quality_score: number;
    landing_url: string;
    published_date: string | null;
  }>;
};

export async function GET(req: Request) {
  const url = new URL(req.url);
  const query = (url.searchParams.get("q") || "").trim();
  const k = Math.min(Number(url.searchParams.get("k") || 12), 50);
  if (!query) {
    return NextResponse.json({ error: "missing query parameter q" }, { status: 400 });
  }
  try {
    const result = await runPipeline<SearchResult>({ action: "search", query, k });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
