import { NextResponse } from "next/server";
import { q } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const experiments = await q(
      `SELECT e.id, e.code, e.name, e.campaign, e.status, e.gravity_level,
              e.fuel_type, e.ambient_gas, e.o2_fraction, e.pressure_kpa,
              e.objective, e.summary, e.aliases,
              f.code AS facility, f.name AS facility_name, f.platform,
              (SELECT count(*)::int FROM ignis.experiment_document ed
                WHERE ed.experiment_id = e.id) AS documents,
              (SELECT count(*)::int FROM ignis.finding fi
                WHERE fi.experiment_id = e.id) AS findings
         FROM ignis.experiment e
         LEFT JOIN ignis.facility f ON f.id = e.facility_id
        ORDER BY documents DESC, e.code`,
    );
    const facilities = await q(
      `SELECT f.id, f.code, f.name, f.platform, f.agency, f.g_level, f.description,
              (SELECT count(*)::int FROM ignis.experiment e WHERE e.facility_id = f.id) AS experiments
         FROM ignis.facility f ORDER BY f.code`,
    );
    return NextResponse.json({ experiments, facilities });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
