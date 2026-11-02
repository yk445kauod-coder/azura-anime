/**
 * Arabic text shaping and bidi ordering for PDF output.
 *
 * PDF has no complex-text engine: a PDF viewer draws glyphs in the order you
 * list them and never joins Arabic letters. So before writing a string we must
 * (a) choose the isolated/initial/medial/final form of every letter and (b)
 * reverse right-to-left runs. This module does both, plus the lam-alef
 * ligature, which is a single glyph rather than two.
 *
 * The shaping tables come from the embedded font (see tools/build_fonts.py) so
 * the shaper never guesses at a glyph the font might not have.
 */

import { FONTS, type FontTables } from "./fonts";

// Arabic block, Arabic supplement/extended, and the presentation-form blocks.
const RTL_RANGES: [number, number][] = [
  [0x0600, 0x06ff],
  [0x0750, 0x077f],
  [0x08a0, 0x08ff],
  [0xfb1d, 0xfb4f],
  [0xfb50, 0xfdff],
  [0xfe70, 0xfeff],
];

/** Marks that attach to a letter and must not break a joining run. */
function isTransparent(cp: number): boolean {
  return (cp >= 0x064b && cp <= 0x065f) || cp === 0x0670 || cp === 0x0640;
}

export function isArabic(cp: number): boolean {
  return RTL_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
}

export function hasArabic(s: string): boolean {
  for (const ch of s) if (isArabic(ch.codePointAt(0)!)) return true;
  return false;
}

/** Neutral characters take the direction of surrounding text. */
function isNeutral(cp: number): boolean {
  return (
    cp === 0x20 || cp === 0x09 ||
    (cp >= 0x21 && cp <= 0x2f) || (cp >= 0x3a && cp <= 0x40) ||
    (cp >= 0x5b && cp <= 0x60) || (cp >= 0x7b && cp <= 0x7e)
  );
}

type Direction = "rtl" | "ltr" | "neutral";

function charDirection(cp: number): Direction {
  if (isArabic(cp)) return "rtl";
  if (isTransparent(cp)) return "neutral";
  if (isNeutral(cp)) return "neutral";
  return "ltr";
}

/**
 * Split into directional runs and resolve neutral runs to their surroundings.
 * This is the practical subset of UAX#9 that report text needs: it handles
 * Arabic sentences containing Latin terms and numbers, which is exactly what
 * IGNIS reports contain.
 */
export function bidiRuns(text: string): { text: string; rtl: boolean }[] {
  const cps = [...text];
  const dirs = cps.map((c) => charDirection(c.codePointAt(0)!));

  // Resolve neutrals to the preceding strong direction, defaulting to the
  // paragraph's first strong direction.
  const firstStrong = dirs.find((d) => d !== "neutral") ?? "ltr";
  let prev: Direction = firstStrong;
  for (let i = 0; i < dirs.length; i++) {
    if (dirs[i] === "neutral") dirs[i] = prev;
    else prev = dirs[i];
  }
  // Any leading neutrals take the first strong direction.
  for (let i = 0; i < dirs.length && dirs[i] === "neutral"; i++) dirs[i] = firstStrong;

  const runs: { text: string; rtl: boolean }[] = [];
  for (let i = 0; i < cps.length; i++) {
    const rtl = dirs[i] === "rtl";
    if (runs.length && runs[runs.length - 1].rtl === rtl) runs[runs.length - 1].text += cps[i];
    else runs.push({ text: cps[i], rtl });
  }
  return runs;
}

/** True when the text contains any character the embedded font can render. */
export function needsEmbeddedFont(s: string): boolean {
  return hasArabic(s);
}

export type ShapedGlyph = { gid: number; charCode: number };

/**
 * Shape and reorder a string into the glyph sequence to draw, in visual order.
 * `charCode` is the source code point, kept so the writer can build a
 * /ToUnicode map and the extracted text stays readable.
 */
export function shapeLine(text: string, font: FontTables): ShapedGlyph[] {
  const out: ShapedGlyph[] = [];

  for (const run of bidiRuns(text)) {
    const cps = [...run.text].map((c) => c.codePointAt(0)!);
    const shaped = run.rtl ? shapeArabic(cps, font) : cps.map((cp) => glyphFor(cp, font));
    // Right-to-left runs are laid out in reverse visual order.
    if (run.rtl) shaped.reverse();
    out.push(...shaped);
  }
  return out;
}

/** Map one code point to a glyph, falling back to the font's .notdef. */
function glyphFor(cp: number, font: FontTables): ShapedGlyph {
  const gid = font.cmap[cp];
  if (gid !== undefined) return { gid, charCode: cp };
  return { gid: 0, charCode: cp };
}

/**
 * Choose the positional form of each Arabic letter in a run.
 *
 * A letter joins to the previous one if it has a final/medial form, and to the
 * next if it has an initial/medial form. Transparent marks are skipped when
 * looking for neighbours so a diacritic does not break a joining pair.
 */
function shapeArabic(cps: number[], font: FontTables): ShapedGlyph[] {
  const result: ShapedGlyph[] = [];

  const isJoiner = (cp: number) => font.shaping[cp] !== undefined;
  const joinsNext = (cp: number) => font.shaping[cp]?.joins_next === "true";
  const joinsPrev = (cp: number) => font.shaping[cp]?.joins_prev === "true";

  /** Next significant code point index (skips marks) within the run. */
  function nextSignificant(i: number): number {
    for (let j = i + 1; j < cps.length; j++) {
      if (!isTransparent(cps[j])) return j;
      if (isJoiner(cps[j])) return j;
    }
    return -1;
  }
  function prevSignificant(i: number): number {
    for (let j = i - 1; j >= 0; j--) {
      if (!isTransparent(cps[j])) return j;
      if (isJoiner(cps[j])) return j;
    }
    return -1;
  }

  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i];

    // Lam followed by an alef collapses into one ligature glyph.
    if (cp === 0x0644) {
      const n = nextSignificant(i);
      if (n >= 0 && (cps[n] === 0x0622 || cps[n] === 0x0623 || cps[n] === 0x0625 || cps[n] === 0x0627)) {
        const p = prevSignificant(i);
        const prevJoins = p >= 0 && joinsNext(cps[p]);
        const key = `${cp.toString(16).toUpperCase().padStart(4, "0")}:${cps[n].toString(16).toUpperCase().padStart(4, "0")}:${prevJoins ? "final" : "isolated"}`;
        const gname = font.lamAlef[key];
        const gid = gname !== undefined ? font.cmap[glyphIdForName(font, gname)] : undefined;
        const resolved = gid ?? font.cmap[0xfefb] ?? font.cmap[0xfef5];
        if (resolved !== undefined) {
          // One ligature glyph replaces both letters. Emitting a glyph per
          // letter here would draw it twice, since the ligature already carries
          // the alef in its ToUnicode mapping.
          result.push({ gid: resolved, charCode: cp });
        } else {
          result.push(glyphFor(cp, font));
          result.push(glyphFor(cps[n], font));
        }
        i = n; // consume the alef
        continue;
      }
    }

    const forms = font.shaping[cp];
    if (!forms) {
      result.push(glyphFor(cp, font));
      continue;
    }

    const p = prevSignificant(i);
    const n = nextSignificant(i);
    const prevJoins = p >= 0 && isArabic(cps[p]) && joinsNext(cps[p]);
    const nextJoins = n >= 0 && isArabic(cps[n]) && joinsPrev(cps[n]);

    const form = prevJoins && nextJoins ? "medial" : prevJoins ? "final" : nextJoins ? "initial" : "isolated";
    const gname = forms[form as "isolated" | "final" | "initial" | "medial"] ?? forms.isolated;
    const gid = gname !== undefined ? glyphIdForName(font, gname) : undefined;
    result.push({ gid: gid !== undefined ? gid : (font.cmap[cp] ?? 0), charCode: cp });
  }

  return result;
}

/**
 * Reverse lookup from glyph name to glyph id.
 *
 * The shaping table from the build step names glyphs ("uniFE8E"), while the
 * font's glyph ids are positional, so the subset's glyph order is the index.
 * Cached per font because it is built once and read for every character.
 */
const nameIndexCache = new WeakMap<FontTables, Map<string, number>>();

function glyphIdForName(font: FontTables, name: string): number | undefined {
  let idx = nameIndexCache.get(font);
  if (!idx) {
    idx = new Map<string, number>();
    font.glyphOrder.forEach((n, i) => idx!.set(n, i));
    nameIndexCache.set(font, idx);
  }
  return idx.get(name);
}

/** Advance width in 1000-unit em space for a glyph id. */
export function glyphWidth(font: FontTables, gid: number): number {
  const name = font.glyphOrder[gid];
  const w = name !== undefined ? font.widths[name] : undefined;
  return w ?? 1000;
}

/** Measure a shaped line in em-space units at the font's own scale. */
export function shapedWidth(font: FontTables, glyphs: ShapedGlyph[]): number {
  let total = 0;
  for (const g of glyphs) total += glyphWidth(font, g.gid);
  return total / 1000;
}

export { FONTS };
