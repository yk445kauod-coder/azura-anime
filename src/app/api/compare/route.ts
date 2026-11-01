import { NextResponse } from "next/server";
import { runPipeline } from "@/lib/pipeline";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Comparative Analysis — side-by-side experiment conditions + findings. */
export async function POST(req: Request) {
  let body: { experiments?: string[]; topic?: string } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const experiments = (body.experiments || []).filter(Boolean);
  if (experiments.length < 1) {
    return NextResponse.json(
      { error: "provide at least one experiment code in 'experiments'" },
      { status: 400 },
    );
  }
  try {
    const result = await runPipeline({
      action: "compare",
      experiments,
      topic: body.topic || null,
    });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
