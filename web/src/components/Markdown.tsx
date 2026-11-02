/**
 * Minimal markdown renderer for agent output: headings, bullets, bold,
 * inline code, paragraphs, and [n] citation markers styled as superscripts.
 */
export default function Markdown({ text }: { text: string }) {
  const inline = (s: string) =>
    s
      .split(/(\*\*[^*]+\*\*|`[^`]+`|\[\d+\])/g)
      .filter(Boolean)
      .map((part, i) => {
        if (part.startsWith("**") && part.endsWith("**"))
          return <strong key={i}>{part.slice(2, -2)}</strong>;
        if (part.startsWith("`") && part.endsWith("`"))
          return <code key={i} className="code">{part.slice(1, -1)}</code>;
        if (/^\[\d+\]$/.test(part)) return <sup key={i} className="cite">{part}</sup>;
        return <span key={i}>{part}</span>;
      });

  return (
    <div className="md">
      {text.split("\n").map((line, i) => {
        const t = line.trim();
        if (!t) return <div key={i} style={{ height: 8 }} />;
        // Chart references are rendered by the Chart panel, so the placeholder
        // line must not also appear as text.
        if (/^!\[.*?\]\(chart:\d+\)$/.test(t)) return null;
        if (t.startsWith("### ")) return <h4 key={i}>{inline(t.slice(4))}</h4>;
        if (t.startsWith("## ")) return <h3 key={i}>{inline(t.slice(3))}</h3>;
        if (t.startsWith("# ")) return <h3 key={i}>{inline(t.slice(2))}</h3>;
        if (/^[-*] /.test(t)) return <li key={i}>{inline(t.slice(2))}</li>;
        if (/^\d+\. /.test(t)) return <li key={i}>{inline(t.replace(/^\d+\.\s/, ""))}</li>;
        return <p key={i}>{inline(t)}</p>;
      })}
    </div>
  );
}
