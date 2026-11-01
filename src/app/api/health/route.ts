import { NextResponse } from "next/server";
import { one } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const started = Date.now();
  try {
    const row = await one<{ now: string }>("SELECT now()::text AS now");
    const stats = await one("SELECT * FROM ignis.document_stats");
    return NextResponse.json({
      status: "ok",
      database: "connected",
      server_time: row?.now,
      latency_ms: Date.now() - started,
      stats,
    });
  } catch (err) {
    return NextResponse.json(
      { status: "error", database: "unreachable", error: (err as Error).message },
      { status: 503 },
    );
  }
}
