import { NextResponse } from "next/server";
import { runPipeline } from "@/lib/pipeline";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Research report endpoint — assembles a cited document from the corpus.
 * Runs the agentic RAG pipeline over each sub-question, then summarises.
 */
export async function POST(req: Request) {
  let body: {
    topic?: string;
    questions?: string[];
    k?: number;
    use_llm?: boolean;
    max_questions?: number;
  } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const topic = (body.topic || "").trim();
  if (!topic) {
    return NextResponse.json({ error: "missing 'topic'" }, { status: 400 });
  }
  try {
    const result = await runPipeline(
      {
        action: "report",
        topic,
        questions: body.questions,
        k: body.k ?? 8,
        use_llm: body.use_llm ?? true,
        max_questions: body.max_questions,
      },
      280_000,
    );
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
