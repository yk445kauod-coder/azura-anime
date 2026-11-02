import { NextRequest, NextResponse } from "next/server";
import { runPipeline } from "@/lib/pipeline";

export const dynamic = "force-dynamic";

type MemoryItem = {
  id: number;
  kind: string;
  content: string;
  importance: number;
  score?: number;
  confidence?: number;
  hit_count?: number;
  created_at: string;
};

type MemoryResponse = {
  recalled: MemoryItem[];
  recent: MemoryItem[];
  session: MemoryItem[];
  stats: { long_term: number; short_term: number };
};

/**
 * GET /api/memory?conversation_id=...&query=...
 *
 * Surfaces the agent's vector memory:
 *  - `recalled`: memories semantically relevant to `query` (vector recall)
 *  - `recent`:   most valuable long-term memories (importance × reinforcement)
 *  - `session`:  short-term memories for this conversation
 *  - `stats`:    memory store sizes
 */
export async function GET(req: NextRequest) {
  const conversationId = req.nextUrl.searchParams.get("conversation_id");
  const query = req.nextUrl.searchParams.get("query") ?? "";

  try {
    const result = await runPipeline<MemoryResponse>({
      action: "memory",
      conversation_id: conversationId,
      query,
    });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}

/**
 * POST /api/memory — explicitly write a memory entry.
 * Body: { conversation_id?, content, kind?, importance?, long_term? }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const content = String(body.content ?? "").trim();
    if (!content) {
      return NextResponse.json({ error: "content is required" }, { status: 400 });
    }
    const conversationId = body.conversation_id || null;
    const kind = String(body.kind ?? "fact");
    const importance = Number(body.importance ?? 0.6);
    const longTerm = Boolean(body.long_term);

    if (longTerm) {
      const result = await runPipeline<{ id?: number; stored?: boolean }>({
        action: "memory_write",
        content,
        kind,
        importance,
      });
      return NextResponse.json(result);
    }

    // Short-term writes need the local embedder too; delegate to the pipeline.
    const result = await runPipeline<{ id?: number; stored?: boolean }>({
      action: "memory_write",
      content,
      kind,
      importance,
      conversation_id: conversationId,
      long_term: false,
    });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}