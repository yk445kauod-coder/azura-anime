# IGNIS frontend developer guide

How to build UI on this platform without breaking its guarantees. Read this before adding
a view.

- Stack: React 19 + TypeScript, Vite, plain CSS in `web/src/globals.css`. No UI framework.
- Data: the `ignis-agent` worker behind `/api/*`, same origin.
- Detail on the API: [`API.md`](./API.md). On the data: [`SCHEMA.md`](./SCHEMA.md).

---

## The design language

IGNIS is a dark mission-control console. The palette is deliberately narrow: a dark navy
base, a flame-orange accent for anything about fire or primary action, and cyan for
evidence and links.

```css
:root {
  --bg: #080D18;      --bg-2: #0b1220;
  --panel: #101A2B;   --panel-2: #14203a;
  --line: #1e2c45;
  --text: #F8FAFC;    --muted: #94A3B8;
  --flame: #F97316;   --flame-2: #fba33f;   /* fire, primary action */
  --cyan: #38BDF8;    /* evidence, links, citations */
  --green: #22C55E;   --red: #ef4444;       /* status only */
  --violet: #a06bff;
  --font-head: "Space Grotesk", ui-sans-serif, system-ui, sans-serif;
  --font-body: "Inter", ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
}
```

**Always use the tokens.** A hard-coded `#0a0f1a` will not track a theme change. If you
need a shade between two tokens, add the token rather than inlining a hex value.

### Colour carries meaning — keep it consistent

| Colour | Means | Do not use it for |
|---|---|---|
| `--flame` | Fire, heat, primary action, bullet markers | Success, general emphasis |
| `--cyan` | Evidence, citations, links, source data | Primary buttons |
| `--green` | Nominal status only | Anything else |
| `--red` | Error, high severity | Destructive-looking decoration |

Reusing `--flame` for a generic "on" state dilutes it, and the flame colour is the one
signal that ties the UI to the subject matter.

### Typography

`Space Grotesk` for headings, `Inter` for body. Sizes are small and dense on purpose —
this is an instrument panel, not a marketing page.

| Element | Size | Weight |
|---|---|---|
| Page heading | 25px | 700 |
| Card heading (`h3`) | 14–15px | 650 |
| Body | 13.5–14px | 400 |
| Metadata | 11–12.3px, `--muted` | 400 |
| Numbers, ids, scores | `--font-body` with `font-variant-numeric: tabular-nums` |

Use `.mono` (ui-monospace) for identifiers, run ids and raw scores. Use tabular numerals
wherever digits stack in a column, or the column will visibly jitter.

### Layout primitives

Reuse these instead of writing new containers:

| Class | Purpose |
|---|---|
| `.wrap` | Page width, max 1400px, generous bottom padding |
| `.card` | The one panel style. Border, 11–12px radius, `#0a0f1a` fill |
| `.cardhead` | Heading row: title left, metadata right, wraps on narrow screens |
| `.grid.g2` / `.g3` | Responsive column grid |
| `.stack` | Vertical flow with a 16px gap |
| `.scroll` / `.scroll.short` | Bounded scroll area, 430px / 240px |
| `.pillrow` / `.pill` | Status chips |
| `.tag` | Inline label inside dense rows |
| `.sectionhead` / `.subhead` | Section and subsection titles |
| `.muted` | Secondary text |
| `.mono` | Monospace |
| `.bar` | Score bar |
| `.spin` | Loading spinner |

Nesting a `.card` inside a `.card` reads as a mistake. Use `.subhead` plus a `.scroll`
inside the parent card instead — that is what the Agent memory panel does.

---

## The five UX rules this project holds to

### 1. Never show a number without its provenance

Every quantitative value comes from `finding`, which was regex-extracted from report text.
Some are wrong. `pressure` ranges to 827 atm because a caption was misread.

So: show the `evidence_quote`, the NTRS `source_id` and the confidence together. A bare
number in a big font is the one thing this UI must not do.

```tsx
<div className="hit">
  <div className="meta">
    NTRS {f.source_id} · {f.metric} · confidence {(f.confidence * 100).toFixed(0)}%
  </div>
  <div className="body"><strong>{f.value} {f.unit}</strong></div>
  <blockquote className="quote">{f.evidence_quote}</blockquote>
</div>
```

### 2. Null means "not reported", never zero

`o2_fraction` and `pressure_kpa` are null for most campaigns. Rendering null as `0`
fabricates a measurement. Render "not reported" in `.muted`.

```tsx
{o2 == null ? <span className="muted">not reported</span> : `${o2}%`}
```

### 3. Show the gaps

`/api/insights` returns `coverage` including campaigns with `documents: 0`. Those are
findings, not errors. A platform that claims to summarise a corpus should say where the
corpus is thin.

### 4. Long work needs visible progress

A deep agent run takes 20–40 s and sometimes 90 s. Never show a bare spinner for that
long. Stream the run and render the stage timeline as it arrives — the `act` events exist
for exactly this. Show elapsed seconds next to the spinner.

### 5. Degraded answers must be labelled

Check `stop_reason`. `final_answer` and `forced_synthesis` are complete. `budget`,
`deadline`, `parse_error` and `model_error` mean the answer is partial, and the UI must
say so rather than presenting it as a finished result.

---

## Talking to the API

All requests are same-origin `/api/*`. There is no base URL to configure and no CORS
handling to write.

### Plain GET

```tsx
const [stats, setStats] = useState<Stats | null>(null);
useEffect(() => {
  let alive = true;
  fetch("/api/stats")
    .then((r) => r.json())
    .then((d) => { if (alive) setStats(d); })
    .catch(() => { /* the panel degrades to its empty state */ });
  return () => { alive = false; };
}, []);
```

The `alive` flag matters: React 19 StrictMode double-invokes effects in development, and
without it a late response writes to an unmounted component.

### Streaming a run

Use `postSse` from `@/lib/sse` — do not hand-parse the stream.

```tsx
await postSse("/api/ask", { question, k: 8, stream: true, mode, model, conversation_id },
  (ev) => {
    switch (ev.event) {
      case "act":    push(ev.data.tool, ev.data.thought); break;
      case "verify": setVerified(ev.data.verified_ratio); break;
      case "error":  setError(ev.data.error); break;
      case "done":   setResult(ev.data as AskResult); break;
    }
  });
```

Events arrive in a fixed order (`mode` → `memory` → `act`* → `verify` → `synthesize` →
`done` → `close`). Do not assume `done` is last — `close` follows it — and do not assume
`done` arrives at all: on failure you get `error` and the stream ends.

### Rendering the answer

`result.answer` is markdown. Pass it to the `Markdown` component:

```tsx
<div className="answer"><Markdown text={result.answer} /></div>
```

The component handles headings, bullet and numbered lists, tables, blockquotes, rules,
bold, italics, inline code, links, and `[n]` citation runs (including adjacent markers like
`[5][6]`, which collapse into one superscript).

Two things that will break it:

- **Do not add `white-space: pre-wrap` to the container.** The renderer emits real block
  elements; pre-wrap then doubles the spacing. This bug shipped once already.
- **Do not render list items yourself.** A bare `<li>` with no `<ul>` parent is invalid
  HTML and browsers drop the marker, flattening the answer. This was the cause of the
  "answers look like a wall of text" bug.

### Citations resolve positionally

`[3]` in the answer means `result.evidence[2]`. Render `evidence` in the order received. If
you filter or sort it, the numbers in the prose will point at the wrong passages.

---

## Component inventory

| Component | Renders | Notes |
|---|---|---|
| `App.tsx` | Tab shell and header | Owns the active tab |
| `Overview.tsx` | Mission Control | `/api/stats` |
| `Assistant.tsx` | IGNIS Intelligence | `/api/ask`, `/api/memory` |
| `Explorer.tsx` | Data Explorer | `/api/documents`, `/api/stats` |
| `Experiments.tsx` | Flame Lab | `/api/experiments` |
| `Compare.tsx` | Comparative Analysis | `/api/compare` |
| `Insights.tsx` | Fire Safety Insights | `/api/insights` |
| `Reports.tsx` | Research Reports | `/api/report`, `/api/export` |
| `Markdown.tsx` | Markdown → React | See above |
| `Chart.tsx` | Inline SVG figures | From `result.chart` |
| `ExportBar.tsx` | Download controls | PDF / DOCX / Markdown |

---

## Internationalisation

Nine locales ship as a generated dictionary in `web/src/lib/locales.generated.ts`, seeded
synchronously so switching language never flashes English.

```tsx
const { t } = useI18n();
<h3>{t("Evidence & sources")}</h3>
```

Rules:

- **The English string is the key.** `t("Evidence & sources")` looks up that exact text.
- **Wrap every user-visible string**, including headings, button labels, placeholders,
  `title` attributes and `aria-label`s. A raw literal renders in English forever.
- **Do not translate identifiers.** NTRS ids, campaign codes, metric keys and model names
  stay as they are.
- **RTL is automatic.** The provider sets `dir="rtl"` on `<html>` for Arabic. Do not add
  directional CSS — use logical properties (`margin-inline-start`, not `margin-left`) so
  both directions work.

Adding UI text:

```bash
# 1. add the English literal in the component, wrapped in t()
# 2. regenerate the dictionary
cd web && npm run i18n:sync
# 3. if a term is mistranslated, add it to scripts/i18n_glossary.py and re-run
```

Machine translation reads short scientific labels badly — "Long-term store" came back as
a retail shop, "Pipeline activity" as plumbing, "Conf." as an Egyptian city. The glossary
in `scripts/i18n_glossary.py` overrides those terms per locale and always wins over the
machine pass. Add an entry there rather than editing the generated file, which is
overwritten on every run.

---

## Accessibility

- Every control needs an accessible name. Icon-only buttons need `aria-label`.
- The segmented control carries `role="group"` with an `aria-label`.
- Do not signal state with colour alone — pair `--red` with text like "high severity".
- Keep focus visible; do not remove the outline.
- Mark streaming regions `aria-live="polite"` so a screen reader hears progress without
  being interrupted on every token.

---

## Performance

- The bundle is ~360 KB (107 KB gzip). Keep it there — no charting or component library.
- `Overview` and `Explorer` load in parallel; do not chain them.
- Long lists (the long-term store can hold hundreds of rows) go inside `.scroll`. Do not
  render an unbounded list into the page flow.
- Cache the `/api/stats` response; it changes only when the pipeline runs.
- Charts arrive as ready-made SVG. Do not re-render them with a library.

---

## Common mistakes

| Symptom | Cause |
|---|---|
| Bullets render as flat lines | A `<li>` without a `<ul>`/`<ol>` parent |
| Doubled spacing in answers | `white-space: pre-wrap` on a container holding block elements |
| Citation numbers point at the wrong passage | `evidence` reordered or filtered |
| `500 invalid input syntax for type uuid` | `conversation_id` is not a UUID |
| A metric shows `0` where the source said nothing | Null rendered as zero |
| A translated label still shows English | String not wrapped in `t()` |
| A number is displayed with no quote or source | Missing provenance — see rule 1 |
| Text overlaps in Arabic | Physical CSS (`margin-left`) instead of logical properties |
