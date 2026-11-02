import { NextResponse } from "next/server";
import { runPipeline, runPipelineStream } from "@/lib/pipeline";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const encoder = new TextEncoder();
export const runtime = "nodejs";

function sse(data: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * AI Research Assistant — agentic RAG endpoint.
 * Runs plan -> retrieve -> grade -> expand -> synthesize -> verify.
 *
 * Returns a `text/event-stream` of stage events; the final `done` event carries
 * the full AgentResult. Clients stream progress live instead of blocking on one
 * JSON response.
 */
export async function POST(req: Request) {
  let body: { question?: string; k?: number; use_llm?: boolean; stream?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const question = (body.question || "").trim();
  if (!question) {
    return NextResponse.json({ error: "missing 'question'" }, { status: 400 });
  }

  const stream = body.stream !== false; // default to streaming

  if (!stream) {
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

  const stream2 = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(sse(obj));

      // Heartbeat keeps proxies from killing an idle quiet LLM stage.
      const heartbeat = setInterval(() => send({ event: "heartbeat" }), 9000);

      try {
        await runPipelineStream(
          {
            action: "ask",
            question,
            k: body.k ?? 8,
            use_llm: body.use_llm ?? true,
          },
          (ev) => send(ev),
        );
        send({ event: "close" });
      } catch (err) {
        send({ event: "error", data: { error: (err as Error).message } });
      } finally {
        clearInterval(heartbeat);
        controller.close();
      }
    },
  });

  return new Response(stream2, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
