/**
 * The deterministic chunker — code, not LLM. Same text in, same chunks out,
 * always. Targets ~1500 characters per chunk, preferring paragraph boundaries
 * (blank lines); a single paragraph longer than the target is hard-split at
 * the latest sentence end / newline / space before the limit.
 */

export const CHUNK_TARGET_CHARS = 1500;

/** Split one over-long paragraph at sentence/newline/space boundaries. */
function splitLongParagraph(paragraph: string, target: number): string[] {
  const pieces: string[] = [];
  let rest = paragraph;
  while (rest.length > target) {
    const window = rest.slice(0, target);
    // Prefer the latest sentence end, then newline, then space — but never
    // split so early that chunks degenerate (keep at least half the target).
    const floor = Math.floor(target / 2);
    let cut = -1;
    for (const m of window.matchAll(/[.!?]["')\]]?\s/g)) {
      const end = (m.index ?? 0) + m[0].length;
      if (end > floor) cut = end;
    }
    if (cut === -1) {
      const nl = window.lastIndexOf("\n");
      if (nl > floor) cut = nl + 1;
    }
    if (cut === -1) {
      const sp = window.lastIndexOf(" ");
      if (sp > floor) cut = sp + 1;
    }
    if (cut === -1) cut = target; // no boundary at all: hard cut
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut);
  }
  const tail = rest.trim();
  if (tail.length > 0) pieces.push(tail);
  return pieces;
}

export function chunkText(text: string, target: number = CHUNK_TARGET_CHARS): string[] {
  const normalized = text.replace(/\r\n/g, "\n");
  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const chunks: string[] = [];
  let current = "";
  const flush = (): void => {
    if (current.length > 0) {
      chunks.push(current);
      current = "";
    }
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > target) {
      flush();
      chunks.push(...splitLongParagraph(paragraph, target));
      continue;
    }
    const joined = current.length === 0 ? paragraph : `${current}\n\n${paragraph}`;
    if (joined.length <= target) {
      current = joined;
    } else {
      flush();
      current = paragraph;
    }
  }
  flush();
  return chunks;
}
