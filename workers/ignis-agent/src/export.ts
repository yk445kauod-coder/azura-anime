/**
 * Report export: PDF, DOCX and Markdown.
 *
 * Both binary writers are implemented in this package rather than pulled from a
 * dependency, because Arabic is a hard requirement: PDF has no complex-text
 * shaper, so a report in Arabic needs an embedded font, manual glyph selection
 * and a /ToUnicode map. See shaping.ts and pdf.ts.
 *
 * The input is the same markdown the dashboard renders, so the exported file and
 * the on-screen report cannot diverge. Charts referenced as `![caption](chart:N)`
 * are resolved against the report's own chart list, and every chart carries a
 * caption naming the measurements it plots.
 */

import { markdownToPdf } from "./pdf";
import { renderPng, CHART_SIZE } from "./viz";
import { parseMarkdown, columnWidths, type Block } from "./document";
import type { ChartSpec } from "./viz";

export { markdownToPdf };
export type { ChartSpec };

// --------------------------------------------------------------------- DOCX

const enc = new TextEncoder();

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Minimal ZIP writer with STORED entries. A DOCX is a ZIP of XML parts, and
 * Word accepts uncompressed entries, so no deflate implementation is needed.
 */
function zip(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  const u16 = (n: number) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff]);
  const u32 = (n: number) => new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
  const cat = (...parts: Uint8Array[]) => {
    const total = parts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  };

  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const head = cat(
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(f.data.length), u32(f.data.length), u16(name.length), u16(0), name,
    );
    local.push(cat(head, f.data));
    central.push(cat(
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(f.data.length), u32(f.data.length),
      u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name,
    ));
    offset += head.length + f.data.length;
  }

  const cd = cat(...central);
  const eocd = cat(
    u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(cd.length), u32(offset), u16(0),
  );
  return cat(...local, cd, eocd);
}

function xmlEsc(s: string): string {
  return s
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;")
    // Control characters are illegal in XML 1.0 and make Word reject the file.
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
}

function para(text: string, opts: { bold?: boolean; size?: number; style?: string; align?: string } = {}): string {
  const rpr = opts.bold || opts.size
    ? `<w:rPr>${opts.bold ? "<w:b/>" : ""}${opts.size ? `<w:sz w:val="${Math.round(opts.size * 2)}"/>` : ""}<w:rFonts w:ascii="Inter" w:hAnsi="Inter" w:cs="IBM Plex Sans Arabic"/></w:rPr>`
    : "";
  const ppr = opts.style || opts.align
    ? `<w:pPr>${opts.style ? `<w:pStyle w:val="${opts.style}"/>` : ""}${opts.align ? `<w:jc w:val="${opts.align}"/>` : ""}</w:pPr>`
    : "";
  return `<w:p>${ppr}<w:r>${rpr}<w:t xml:space="preserve">${xmlEsc(text)}</w:t></w:r></w:p>`;
}

/**
 * A table as real Word table markup. Borders are drawn explicitly because Word
 * has no default table style available in a minimal package.
 */
function tableXml(header: string[], rows: string[][]): string {
  const widths = columnWidths(header, rows);
  const total = widths.reduce((a, b) => a + b, 0) || 1;
  const gridCols = widths.map((w) => `<w:gridCol w:w="${Math.round((w / total) * 9000)}"/>`).join("");

  const border = `<w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"]
    .map((s) => `<w:${s} w:val="single" w:sz="4" w:color="D0D5DD"/>`).join("")}</w:tblBorders>`;

  const cell = (text: string, bold: boolean, shade: boolean) =>
    `<w:tc><w:tcPr>${shade ? '<w:shd w:val="clear" w:fill="F1F3F7"/>' : ""}` +
    `<w:tcBorders>${["top", "left", "bottom", "right"].map((s) => `<w:${s} w:val="single" w:sz="4" w:color="D0D5DD"/>`).join("")}</w:tcBorders>` +
    `</w:tcPr>${para(text, { bold, size: 8.5 })}</w:tc>`;

  const headerRow = `<w:tr><w:trPr><w:tblHeader/></w:trPr>${header.map((h) => cell(h, true, true)).join("")}</w:tr>`;
  const bodyRows = rows
    .map((r) => `<w:tr>${header.map((_, i) => cell(r[i] ?? "", false, false)).join("")}</w:tr>`)
    .join("");

  return `<w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/>${border}</w:tblPr><w:tblGrid>${gridCols}</w:tblGrid>${headerRow}${bodyRows}</w:tbl>${para("")}`;
}

export async function markdownToDocx(md: string, title: string, charts: ChartSpec[] = []): Promise<Uint8Array> {
  const blocks: Block[] = parseMarkdown(md, charts);
  const body: string[] = [para(title, { bold: true, size: 20 })];
  const media: { name: string; data: Uint8Array }[] = [];
  const rels: string[] = [];

  let chartIndex = 0;
  for (const b of blocks) {
    switch (b.kind) {
      case "h":
        body.push(para(b.text, { bold: true, size: b.level <= 1 ? 16 : b.level === 2 ? 13 : 11.5 }));
        break;
      case "li":
        body.push(para("• " + b.text));
        break;
      case "quote":
        body.push(para(b.text, { style: "Quote" }));
        break;
      case "space":
        body.push("<w:p/>");
        break;
      case "table":
        body.push(tableXml(b.header, b.rows));
        break;
      case "chart": {
        // Rendered at 2x and sized back down, so the image stays sharp in print.
        const png = await renderPng(b.spec, 2);
        const name = `chart${chartIndex}.png`;
        const relId = `rIdChart${chartIndex}`;
        media.push({ name: `word/media/${name}`, data: png });
        rels.push(
          `<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${name}"/>`
        );
        // 720x330 points at 96 dpi is roughly 540x248 px; scale to fit 6.25in.
        const cx = 5_760_000, cy = Math.round((CHART_SIZE.height / CHART_SIZE.width) * cx);
        body.push(
          `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:drawing>` +
          `<wp:inline distT="0" distB="0" distL="0" distR="0">` +
          `<wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${chartIndex + 1}" name="${xmlEsc(name)}"/>` +
          `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
          `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
          `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
          `<pic:nvPicPr><pic:cNvPr id="${chartIndex + 1}" name="${xmlEsc(name)}"/><pic:cNvPicPr/></pic:nvPicPr>` +
          `<pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
          `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
          `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
          `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
        );
        if (b.caption) body.push(para(b.caption, { size: 8.5, align: "center" }));
        chartIndex++;
        break;
      }
      default:
        body.push(para(b.text));
    }
  }

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
  xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"
  xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
<w:body>${body.join("")}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body>
</w:document>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
${rels.join("\n")}
</Relationships>`;

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Inter" w:hAnsi="Inter" w:cs="IBM Plex Sans Arabic"/><w:sz w:val="21"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:pPr><w:ind w:left="360"/></w:pPr><w:rPr><w:i/></w:rPr></w:style>
</w:styles>`;

  return zip([
    { name: "[Content_Types].xml", data: enc.encode(contentTypes) },
    { name: "_rels/.rels", data: enc.encode(rootRels) },
    { name: "word/document.xml", data: enc.encode(document) },
    { name: "word/_rels/document.xml.rels", data: enc.encode(docRels) },
    { name: "word/styles.xml", data: enc.encode(styles) },
    ...media,
  ]);
}

export function safeFilename(s: string): string {
  return s.replace(/[^\w\-. ]+/g, "").replace(/\s+/g, "-").slice(0, 70) || "ignis-report";
}
