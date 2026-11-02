/** A single frame from an IGNIS SSE endpoint. */
export type SseEvent = { event: string; data: any };

/**
 * Read a `text/event-stream` response frame by frame.
 *
 * Frames are separated by a blank line and carry one `data: <json>` line, which
 * is the shape both the /ask and /report worker endpoints emit.
 */
export async function readSse(
  body: ReadableStream<Uint8Array>,
  onEvent: (ev: SseEvent) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let cut: number;
      while ((cut = buf.indexOf("\n\n")) !== -1) {
        const raw = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        const line = /^data: (.*)$/m.exec(raw.trim());
        if (!line) continue;
        try {
          onEvent(JSON.parse(line[1]));
        } catch {
          // A malformed frame is not worth failing the whole run over.
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** POST JSON and stream the SSE frames back. Throws on a non-2xx response. */
export async function postSse(
  url: string,
  payload: unknown,
  onEvent: (ev: SseEvent) => void,
): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok || !res.body) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.error || `HTTP ${res.status}`);
  }
  await readSse(res.body, onEvent);
}
