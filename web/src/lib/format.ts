/**
 * Number formatting helpers.
 *
 * Postgres `numeric`/`bigint` columns arrive over the Neon HTTP driver as
 * strings (e.g. `"206"`, `"0.8809"`), not numbers. Anything that assumes a
 * number — `toLocaleString`, `toFixed`, arithmetic — silently renders an
 * em-dash or `NaN` for real data. Every value that reaches the UI goes through
 * `n()` first so a string, a null and a genuine number are all handled.
 */

export function n(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? x : null;
}

export const DASH = "—";

/** Integer with thousands separators, or an em-dash when absent. */
export function fmtInt(v: unknown, dash = DASH): string {
  const x = n(v);
  return x === null ? dash : Math.round(x).toLocaleString("en-US");
}

/** Fixed-precision decimal, or an em-dash when absent. */
export function fmtNum(v: unknown, digits = 2, dash = DASH): string {
  const x = n(v);
  return x === null ? dash : x.toFixed(digits);
}

/** Compact magnitude for headline tiles: 1.2k, 3.4M. */
export function fmtCompact(v: unknown, dash = DASH): string {
  const x = n(v);
  if (x === null) return dash;
  const a = Math.abs(x);
  if (a >= 1e9) return `${(x / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${(x / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(x / 1e3).toFixed(1)}k`;
  return String(Math.round(x));
}

/** A 0-1 ratio rendered as a percentage. */
export function pct(v: unknown, digits = 0, dash = DASH): string {
  const x = n(v);
  return x === null ? dash : `${(x * 100).toFixed(digits)}%`;
}

/** Bytes → human-readable size. */
export function fmtBytes(v: unknown, dash = DASH): string {
  const x = n(v);
  if (x === null) return dash;
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let y = x;
  while (y >= 1024 && i < u.length - 1) { y /= 1024; i++; }
  return `${y.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

/** Clamp a value into a 0-100 percentage for bars and rings. */
export function clampPct(v: number): number {
  return Math.max(0, Math.min(100, v));
}
