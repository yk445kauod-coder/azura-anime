/**
 * Markdown renderer for agent output.
 *
 * Agent answers arrive as real markdown — headings, bullet lists, numbered
 * lists, tables, blockquotes, and [n] citation markers. Lists must be grouped
 * into their own <ul>/<ol> element: emitting bare <li> nodes is invalid HTML
 * and browsers strip the markers, which flattens a structured answer into a
 * wall of text.
 */

import { Fragment, useMemo, type ReactNode } from "react";

/** Bold, italic, inline code, links, and citation runs like [5][6]. */
function inline(source: string, keyPrefix: string): ReactNode[] {
  // The link pattern precedes the bare-citation pattern so that an NTRS id in
  // brackets, e.g. [20220005205](https://...), is not consumed as a citation.
  const parts = source
    .split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*|\[[^\]]+\]\([^)]+\)|\[\d+\](?:\[\d+\])*)/g)
    .filter(Boolean);

  return parts.map((part, i) => {
    const key = `${keyPrefix}-${i}`;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return <code key={key} className="code">{part.slice(1, -1)}</code>;
    }
    if (/^\*[^*]+\*$/.test(part) && part.length > 2) {
      return <em key={key}>{part.slice(1, -1)}</em>;
    }
    if (/^\[\d+\](\[\d+\])*$/.test(part)) {
      const nums = part.match(/\d+/g) ?? [];
      return (
        <sup key={key} className="cite">
          {nums.map((n, j) => (
            <Fragment key={j}>{j > 0 ? "," : ""}[{n}]</Fragment>
          ))}
        </sup>
      );
    }
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    if (link) {
      return <a key={key} href={link[2]} target="_blank" rel="noreferrer">{link[1]}</a>;
    }
    return <span key={key}>{part}</span>;
  });
}

type Block =
  | { kind: "p"; text: string }
  | { kind: "h"; level: number; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "table"; head: string[]; rows: string[][] }
  | { kind: "hr" };

const isUl = (l: string) => /^[-*+]\s+/.test(l);
const isOl = (l: string) => /^\d+[.)]\s+/.test(l);
const isHeading = (l: string) => /^#{1,6}\s+/.test(l);
const isFence = (l: string) => /^```/.test(l);
const isSeparator = (l: string) => /^[\s|:-]+$/.test(l) && l.includes("-");

/** Split the answer into block-level elements, consuming lines until each ends. */
function parse(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  const cells = (l: string) => l.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line) { i++; continue; }

    // Chart placeholders are rendered by the Chart panel, not as text.
    if (/^!\[.*?\]\(chart:\d+\)$/.test(line)) { i++; continue; }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) { blocks.push({ kind: "hr" }); i++; continue; }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: "h", level: heading[1].length, text: heading[2].trim() });
      i++;
      continue;
    }

    // Fenced code: keep it verbatim so indentation and symbols survive.
    if (isFence(line)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !isFence(lines[i].trim())) { buf.push(lines[i]); i++; }
      i++;
      blocks.push({ kind: "quote", text: buf.join("\n") });
      continue;
    }

    if (line.startsWith(">")) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        buf.push(lines[i].trim().replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({ kind: "quote", text: buf.join(" ") });
      continue;
    }

    // A pipe row followed by a separator row is a table header.
    if (line.includes("|") && i + 1 < lines.length && isSeparator(lines[i + 1].trim())) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
        rows.push(cells(lines[i].trim()));
        i++;
      }
      blocks.push({ kind: "table", head, rows });
      continue;
    }

    if (isUl(line)) {
      const items: string[] = [];
      while (i < lines.length && isUl(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*+]\s+/, ""));
        i++;
      }
      blocks.push({ kind: "ul", items });
      continue;
    }

    if (isOl(line)) {
      const items: string[] = [];
      while (i < lines.length && isOl(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+[.)]\s+/, ""));
        i++;
      }
      blocks.push({ kind: "ol", items });
      continue;
    }

    // Paragraph: join consecutive lines until a blank line or a new block starts.
    const buf: string[] = [];
    while (i < lines.length) {
      const l = lines[i].trim();
      if (!l || isHeading(l) || isUl(l) || isOl(l) || l.startsWith(">") || isFence(l)) break;
      buf.push(l);
      i++;
    }
    blocks.push({ kind: "p", text: buf.join(" ") });
  }
  return blocks;
}

export default function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parse(text), [text]);

  return (
    <div className="md">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case "h": {
            const Tag = b.level <= 2 ? "h3" : "h4";
            return <Tag key={i}>{inline(b.text, `h${i}`)}</Tag>;
          }
          case "ul":
            return (
              <ul key={i}>
                {b.items.map((it, j) => <li key={j}>{inline(it, `u${i}-${j}`)}</li>)}
              </ul>
            );
          case "ol":
            return (
              <ol key={i}>
                {b.items.map((it, j) => <li key={j}>{inline(it, `o${i}-${j}`)}</li>)}
              </ol>
            );
          case "quote":
            return <blockquote key={i} className="quote">{inline(b.text, `q${i}`)}</blockquote>;
          case "hr":
            return <hr key={i} />;
          case "table":
            return (
              <div className="tablewrap" key={i}>
                <table>
                  <thead>
                    <tr>{b.head.map((c, j) => <th key={j}>{inline(c, `th${i}-${j}`)}</th>)}</tr>
                  </thead>
                  <tbody>
                    {b.rows.map((row, j) => (
                      <tr key={j}>
                        {row.map((c, k) => <td key={k}>{inline(c, `td${i}-${j}-${k}`)}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          default:
            return <p key={i}>{inline(b.text, `p${i}`)}</p>;
        }
      })}
    </div>
  );
}
