/**
 * Markdown -> document model.
 *
 * Reports are authored as markdown, so the exporter parses that markdown into a
 * small block model that the PDF and DOCX writers both consume. Keeping one
 * parser means the two formats cannot disagree about the report's structure.
 *
 * Two extensions beyond plain markdown:
 *   ![caption](chart:N)  embeds the Nth chart from the report's chart list
 *   pipe tables          become real tables in both output formats
 */

import type { ChartSpec } from "./viz";

export type Block =
  | { kind: "h"; level: number; text: string }
  | { kind: "p"; text: string }
  | { kind: "li"; text: string }
  | { kind: "quote"; text: string }
  | { kind: "table"; header: string[]; rows: string[][] }
  | { kind: "chart"; spec: ChartSpec; caption: string }
  | { kind: "space" };

/** Strip inline markdown emphasis and links, keeping the visible text. */
export function stripInline(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[(.*?)\]\(.*?\)/g, "$1")
    .replace(/\[(.+?)\]\((.+?)\)/g, "$1 ($2)")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .trim();
}

function splitRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((c) => stripInline(c.trim()));
}

/** A separator row like |---|---| marks the preceding row as a header. */
function isSeparator(line: string): boolean {
  return /^\s*\|?[\s:-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes("-");
}

export function parseMarkdown(md: string, charts: ChartSpec[] = []): Block[] {
  const out: Block[] = [];
  const lines = md.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\s+$/, "");

    if (!line.trim()) { out.push({ kind: "space" }); continue; }

    // Chart reference: ![caption](chart:N)
    const chartRef = line.match(/^!\[(.*?)\]\(chart:(\d+)\)\s*$/);
    if (chartRef) {
      const spec = charts[Number(chartRef[2])];
      if (spec) out.push({ kind: "chart", spec, caption: chartRef[1] || spec.title });
      continue;
    }

    // Pipe table: header row followed by a separator row.
    if (line.trim().startsWith("|") && i + 1 < lines.length && isSeparator(lines[i + 1])) {
      const header = splitRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      i--;
      out.push({ kind: "table", header, rows });
      continue;
    }

    let m: RegExpMatchArray | null;
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) out.push({ kind: "h", level: m[1].length, text: stripInline(m[2]) });
    else if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) out.push({ kind: "li", text: stripInline(m[1]) });
    else if ((m = line.match(/^\s*>\s?(.*)$/))) out.push({ kind: "quote", text: stripInline(m[1]) });
    else if (/^\s*[-*_]{3,}\s*$/.test(line)) out.push({ kind: "space" });
    else out.push({ kind: "p", text: stripInline(line) });
  }
  return out;
}

/**
 * Estimate column widths in characters, used to lay out tables in a PDF where
 * we must decide column boundaries ourselves.
 */
export function columnWidths(header: string[], rows: string[][]): number[] {
  const cols = header.length;
  const widths = new Array(cols).fill(4);
  for (const row of [header, ...rows]) {
    for (let c = 0; c < cols; c++) {
      const len = (row[c] ?? "").length;
      if (len > widths[c]) widths[c] = len;
    }
  }
  // Cap runaway columns so one long cell cannot push the rest off the page.
  const total = widths.reduce((a, b) => a + b, 0);
  const MAX = 96;
  if (total > MAX) {
    const scale = MAX / total;
    for (let c = 0; c < cols; c++) widths[c] = Math.max(6, Math.floor(widths[c] * scale));
  }
  return widths;
}
