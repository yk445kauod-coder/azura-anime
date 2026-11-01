import { NextResponse } from "next/server";
import { runPipeline } from "@/lib/pipeline";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * AI Research Assistant — agentic RAG endpoint.
 * Runs plan -> retrieve -> grade -> expand -> synthesize -> verify.
 */
export async function POST(req: Request) {
  let body: { question?: string; k?: number; use_llm?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const question = (body.question || "").trim();
  if (!question) {
    return NextResponse.json({ error: "missing 'question'" }, { status: 400 });
  }
  try {
    const result = await runPipeline({
      action: "ask",
      question,
      k: body.k ?? 8,
      use_llm: body.use_llm ?? true,
    });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
