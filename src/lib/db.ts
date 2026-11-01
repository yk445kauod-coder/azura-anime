import { Pool } from "pg";

declare global {
  // eslint-disable-next-line no-var
  var __ignisPool: Pool | undefined;
}

function connectionString(): string {
  const url =
    process.env.DATABASE_URL_POOLED ||
    process.env.DATABASE_URL ||
    "";
  if (!url) throw new Error("DATABASE_URL is not configured");
  return url;
}

export function pool(): Pool {
  if (!global.__ignisPool) {
    global.__ignisPool = new Pool({
      connectionString: connectionString(),
      max: 6,
      idleTimeoutMillis: 20_000,
      connectionTimeoutMillis: 15_000,
      ssl: { rejectUnauthorized: false },
    });
  }
  return global.__ignisPool;
}

export async function q<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await pool().query(sql, params);
  return res.rows as T[];
}

export async function one<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await q<T>(sql, params);
  return rows.length ? rows[0] : null;
}
