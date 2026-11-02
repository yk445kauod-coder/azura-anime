/**
 * PDF writer.
 *
 * Written directly rather than via a library for one reason: Arabic. PDF has no
 * complex-text shaper, so an Arabic report needs a font embedded with a
 * /ToUnicode map plus manual glyph selection — see shaping.ts. A generic
 * markdown-to-PDF library would drop the Arabic entirely.
 *
 * Latin-only runs still use the base-14 Helvetica, so the embedded IBM Plex
 * Sans Arabic subset is only pulled in when a document actually contains
 * Arabic. That keeps most reports a few kilobytes instead of ~150 KB.
 */

import { FONTS, type FontTables } from "./fonts";
import { hasArabic, shapeLine, shapedWidth, type ShapedGlyph } from "./shaping";
import { parseMarkdown, columnWidths, type Block } from "./document";
import { CHART_SIZE, renderPdfOps, type ChartSpec } from "./viz";

const PAGE_W = 595.28; // A4 at 72 dpi
const PAGE_H = 841.89;
const MARGIN = 56;
const CONTENT_W = PAGE_W - MARGIN * 2;
const BODY = 10.5;

type Run = {
  font: "F1" | "F2" | "FA" | "FAB";
  size: number;
  glyphs?: ShapedGlyph[];
  text?: string;
  width: number;
};

type Item =
  | { kind: "text"; runs: Run[]; indent: number; gap: number }
  | { kind: "chart"; spec: ChartSpec; caption: string }
  | { kind: "table"; header: string[]; rows: string[][] };

/** A PDF indirect object: a plain dictionary, or a dictionary plus a stream. */
type PdfObject =
  | { kind: "text"; body: string }
  | { kind: "stream"; dict: string; data: Uint8Array };

function latin1(s: string): Uint8Array {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
  return b;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hex4(n: number): string {
  return n.toString(16).toUpperCase().padStart(4, "0");
}

/** Escape a base-14 text string for a PDF literal. */
function pdfLit(s: string): string {
  const latin = s
    .replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-").replace(/\u2026/g, "...")
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, "?");
  return latin.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/** Wrap text into runs that fit `maxWidth`, shaping Arabic where present. */
function wrapRuns(text: string, size: number, bold: boolean, maxWidth: number): Run[] {
  const words = text.split(/\s+/).filter(Boolean);
  const out: Run[] = [];
  let cur = "";

  const measure = (s: string): { width: number; glyphs?: ShapedGlyph[] } => {
    if (hasArabic(s)) {
      const f = bold ? FONTS.bold : FONTS.regular;
      const glyphs = shapeLine(s, f);
      return { width: shapedWidth(f, glyphs) * size, glyphs };
    }
    // Helvetica's average advance is close to 0.5 em for mixed text.
    return { width: s.length * size * 0.5 };
  };

  const flush = () => {
    if (!cur) return;
    const m = measure(cur);
    out.push({
      font: m.glyphs ? (bold ? "FAB" : "FA") : bold ? "F2" : "F1",
      size,
      glyphs: m.glyphs,
      text: m.glyphs ? undefined : cur,
      width: m.width,
    });
    cur = "";
  };

  for (const w of words) {
    const candidate = cur ? cur + " " + w : w;
    if (!cur || measure(candidate).width <= maxWidth) cur = candidate;
    else { flush(); cur = w; }
  }
  flush();
  return out;
}

function toItems(blocks: Block[]): Item[] {
  const out: Item[] = [];
  for (const b of blocks) {
    switch (b.kind) {
      case "h": {
        const size = b.level <= 1 ? 17 : b.level === 2 ? 13.5 : 11.5;
        for (const r of wrapRuns(b.text, size, true, CONTENT_W))
          out.push({ kind: "text", runs: [r], indent: 0, gap: 4 });
        out.push({ kind: "text", runs: [], indent: 0, gap: 6 });
        break;
      }
      case "li":
        for (const [i, r] of wrapRuns(b.text, BODY, false, CONTENT_W - 16).entries())
          out.push({
            kind: "text",
            runs: i === 0 ? [{ ...r, text: r.text ? "- " + r.text : r.text, width: r.width + BODY * 1.2 }] : [r],
            indent: 16,
            gap: 1.5,
          });
        break;
      case "quote":
        for (const r of wrapRuns(b.text, BODY, false, CONTENT_W - 18))
          out.push({ kind: "text", runs: [r], indent: 18, gap: 1.5 });
        break;
      case "table":
        out.push({ kind: "table", header: b.header, rows: b.rows });
        out.push({ kind: "text", runs: [], indent: 0, gap: 6 });
        break;
      case "chart":
        out.push({ kind: "chart", spec: b.spec, caption: b.caption });
        out.push({ kind: "text", runs: [], indent: 0, gap: 6 });
        break;
      case "space":
        out.push({ kind: "text", runs: [], indent: 0, gap: 5 });
        break;
      default:
        for (const r of wrapRuns(b.text, BODY, false, CONTENT_W))
          out.push({ kind: "text", runs: [r], indent: 0, gap: 1.5 });
    }
  }
  return out;
}

export function markdownToPdf(md: string, title: string, charts: ChartSpec[] = []): Uint8Array {
  const stream = toItems(parseMarkdown(md, charts));
  const needsArabic = hasArabic(md);

  // ---- paginate ----
  const pages: string[] = [];
  let ops = "";
  let y = PAGE_H - MARGIN;

  const newPage = () => { pages.push(ops); ops = ""; y = PAGE_H - MARGIN; };
  const ensure = (needed: number) => { if (y - needed < MARGIN) newPage(); };

  const drawRun = (r: Run, x: number, baseline: number) => {
    if (r.glyphs) {
      ops += `BT /${r.font} ${r.size} Tf 0.06 0.09 0.14 rg 1 0 0 1 ${x.toFixed(2)} ${baseline.toFixed(2)} Tm <${r.glyphs.map((g) => hex4(g.gid)).join("")}> Tj ET\n`;
    } else if (r.text) {
      ops += `BT /${r.font} ${r.size} Tf 0.06 0.09 0.14 rg 1 0 0 1 ${x.toFixed(2)} ${baseline.toFixed(2)} Tm (${pdfLit(r.text)}) Tj ET\n`;
    }
  };

  for (const it of stream) {
    if (it.kind === "text") {
      const lead = it.runs.length ? it.runs[0].size * 1.45 : BODY * 1.2;
      ensure(lead + it.gap);
      let x = MARGIN + it.indent;
      for (const r of it.runs) {
        drawRun(r, x, y);
        x += r.width;
      }
      y -= lead + it.gap;
    } else if (it.kind === "table") {
      const widths = columnWidths(it.header, it.rows);
      const totalChars = widths.reduce((a, b) => a + b, 0) || 1;
      const colW = widths.map((w) => (w / totalChars) * CONTENT_W);
      const rowH = 15;

      const drawRow = (cells: string[], bold: boolean, fill: boolean) => {
        if (fill) ops += `0.94 0.95 0.97 rg ${MARGIN} ${(y - rowH + 4).toFixed(2)} ${CONTENT_W.toFixed(2)} ${rowH} re f\n`;
        let x = MARGIN + 3;
        for (let c = 0; c < widths.length; c++) {
          const cell = (cells[c] ?? "").slice(0, widths[c]);
          for (const r of wrapRuns(cell, 8.2, bold, colW[c] - 5)) drawRun(r, x, y - 7);
          x += colW[c];
        }
        ops += `0.82 0.85 0.9 RG 0.4 w ${MARGIN} ${(y - rowH + 4).toFixed(2)} m ${(MARGIN + CONTENT_W).toFixed(2)} ${(y - rowH + 4).toFixed(2)} l S\n`;
        y -= rowH;
      };

      ensure(rowH * 2 + 8);
      drawRow(it.header, true, true);
      for (const row of it.rows) {
        if (y - rowH < MARGIN) newPage();
        drawRow(row, false, false);
      }
      y -= 4;
    } else {
      const scale = Math.min(1, CONTENT_W / CHART_SIZE.width);
      const h = CHART_SIZE.height * scale;
      ensure(h + 22);
      const { ops: chartOps } = renderPdfOps(it.spec);
      // The chart's operators are written in a 720x330 space; `cm` maps that
      // space onto the page, so one renderer serves any page width.
      ops += `q ${scale.toFixed(4)} 0 0 ${scale.toFixed(4)} ${MARGIN.toFixed(2)} ${(y - h).toFixed(2)} cm\n${chartOps}Q\n`;
      y -= h + 4;
      for (const r of wrapRuns(it.caption, 8.2, false, CONTENT_W)) {
        drawRun(r, MARGIN, y);
        y -= 11;
      }
      y -= 6;
    }
  }
  pages.push(ops);

  // ---- objects ----
  const objects: PdfObject[] = [];
  const addObj = (o: PdfObject) => { objects.push(o); return objects.length; };
  const addText = (body: string) => addObj({ kind: "text", body });

  const catalogId = addText("");
  const pagesId = addText("");
  const helvId = addText("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const helvBoldId = addText("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");

  let faId = 0, fabId = 0;
  if (needsArabic) {
    faId = addArabicFont(FONTS.regular, "IBMPlexSansArabic");
    fabId = addArabicFont(FONTS.bold, "IBMPlexSansArabic-Bold");
  }

  const fontRes = [
    `/F1 ${helvId} 0 R`, `/F2 ${helvBoldId} 0 R`,
    faId ? `/FA ${faId} 0 R` : "", fabId ? `/FAB ${fabId} 0 R` : "",
  ].filter(Boolean).join(" ");

  const pageIds: number[] = [];
  for (const p of pages) {
    const contentId = addObj({ kind: "stream", dict: `<< /Length ${latin1(p).length} >>`, data: latin1(p) });
    pageIds.push(addText(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      `/Resources << /Font << ${fontRes} >> >> /Contents ${contentId} 0 R >>`
    ));
  }
  objects[catalogId - 1] = { kind: "text", body: `<< /Type /Catalog /Pages ${pagesId} 0 R >>` };
  objects[pagesId - 1] = { kind: "text", body: `<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(" ")}] /Count ${pageIds.length} >>` };

  return serialise(objects, catalogId);

  /**
   * Embed the subset as a Type0 / Identity-H font.
   *
   * Identity-H puts glyph ids straight into the content stream, which is what
   * the shaper produces. /W carries advance widths and /ToUnicode lets a reader
   * copy the Arabic back out as ordinary text.
   */
  function addArabicFont(f: FontTables, name: string): number {
    const fontBytes = base64ToBytes(f.data);
    const descriptorId = addText("");
    const fontFileId = addObj({
      kind: "stream",
      dict: `<< /Length ${fontBytes.length} /Length1 ${fontBytes.length} >>`,
      data: fontBytes,
    });
    const cidFontId = addText("");
    const toUnicodeBody = buildToUnicode(f);
    const toUnicodeId = addObj({
      kind: "stream",
      dict: `<< /Length ${latin1(toUnicodeBody).length} >>`,
      data: latin1(toUnicodeBody),
    });
    const type0Id = addText("");

    objects[descriptorId - 1] = {
      kind: "text",
      body: `<< /Type /FontDescriptor /FontName /${name} ` +
            `/Flags ${f.italicAngle ? 96 : 32} /FontBBox [${f.bbox.join(" ")}] ` +
            `/ItalicAngle ${f.italicAngle} /Ascent ${f.ascent} /Descent ${f.descent} ` +
            `/CapHeight ${f.capHeight} /StemV 80 /FontFile2 ${fontFileId} 0 R >>`,
    };
    objects[cidFontId - 1] = {
      kind: "text",
      body: `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${name} ` +
            `/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> ` +
            `/FontDescriptor ${descriptorId} 0 R /DW 1000 /W [${buildWidths(f)}] ` +
            `/CIDToGIDMap /Identity >>`,
    };
    objects[type0Id - 1] = {
      kind: "text",
      body: `<< /Type /Font /Subtype /Type0 /BaseFont /${name} ` +
            `/Encoding /Identity-H /DescendantFonts [${cidFontId} 0 R] ` +
            `/ToUnicode ${toUnicodeId} 0 R >>`,
    };
    return type0Id;
  }
}

/** /W array: advance width per glyph id, in 1000-unit em space. */
function buildWidths(f: FontTables): string {
  const parts: string[] = [];
  for (let gid = 0; gid < f.numGlyphs; gid++) {
    const w = f.widths[f.glyphOrder[gid]] ?? 1000;
    parts.push(`${gid} [${w}]`);
  }
  return parts.join(" ");
}

/** /ToUnicode CMap so extracted text reads as normal Arabic. */
function buildToUnicode(f: FontTables): string {
  const entries: string[] = [];
  for (let gid = 0; gid < f.numGlyphs; gid++) {
    const lig = f.ligatureToUni[gid];
    if (lig && lig.length) {
      // One ligature glyph stands for two letters, so it maps to a two-code-point
      // UTF-16BE string; otherwise copying text out would drop the alef.
      entries.push(`<${hex4(gid)}> <${lig.map((u) => hex4(u)).join("")}>`);
      continue;
    }
    const uni = f.gidToUni[gid];
    if (!uni) continue;
    entries.push(`<${hex4(gid)}> <${hex4(uni)}>`);
  }
  // bfchar blocks hold at most 100 entries each.
  const chunks: string[] = [];
  for (let i = 0; i < entries.length; i += 100) {
    const slice = entries.slice(i, i + 100);
    chunks.push(`${slice.length} beginbfchar\n${slice.join("\n")}\nendbfchar`);
  }
  return `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
${chunks.join("\n")}
endcmap
CMapName currentdict /CMap defineresource pop
end
end`;
}

/** Write the objects out with a byte-accurate cross-reference table. */
function serialise(objects: PdfObject[], rootId: number): Uint8Array {
  const parts: Uint8Array[] = [];
  let length = 0;
  const push = (s: string | Uint8Array) => {
    const bytes = typeof s === "string" ? latin1(s) : s;
    parts.push(bytes);
    length += bytes.length;
  };

  push("%PDF-1.5\n");
  const offsets: number[] = [];
  for (let i = 0; i < objects.length; i++) {
    const o = objects[i];
    offsets.push(length);
    if (o.kind === "text") {
      push(`${i + 1} 0 obj\n${o.body}\nendobj\n`);
    } else {
      push(`${i + 1} 0 obj\n${o.dict}\nstream\n`);
      push(o.data);
      push("\nendstream\nendobj\n");
    }
  }
  const xref = length;
  push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
  for (const o of offsets) push(`${String(o).padStart(10, "0")} 00000 n \n`);
  push(`trailer\n<< /Size ${objects.length + 1} /Root ${rootId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(length);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}
