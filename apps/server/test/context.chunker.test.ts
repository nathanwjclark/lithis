import { describe, expect, test } from "bun:test";
import { CHUNK_TARGET_CHARS, chunkText } from "../src/context/chunker";

describe("chunkText", () => {
  test("empty and whitespace-only input produce no chunks", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("  \n\n   \n ")).toEqual([]);
  });

  test("short text is one chunk", () => {
    expect(chunkText("Hello world.")).toEqual(["Hello world."]);
  });

  test("is deterministic — same input, same chunks, every time", () => {
    const text = Array.from({ length: 40 }, (_, i) => `Paragraph ${i}. ${"x".repeat(90)}`).join(
      "\n\n",
    );
    const a = chunkText(text);
    const b = chunkText(text);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(1);
  });

  test("packs paragraphs up to the target and splits on paragraph boundaries", () => {
    const p1 = "a".repeat(700);
    const p2 = "b".repeat(700);
    const p3 = "c".repeat(700);
    const chunks = chunkText([p1, p2, p3].join("\n\n"));
    // p1+p2 fit in 1500 (700+2+700); p3 starts a new chunk
    expect(chunks).toEqual([`${p1}\n\n${p2}`, p3]);
  });

  test("every chunk respects the target size", () => {
    const text = Array.from(
      { length: 30 },
      (_, i) => `Sentence one of para ${i}. Sentence two is a bit longer. ${"y".repeat(200)}`,
    ).join("\n\n");
    for (const chunk of chunkText(text)) {
      expect(chunk.length).toBeLessThanOrEqual(CHUNK_TARGET_CHARS);
    }
  });

  test("hard-splits a single over-long paragraph, preferring sentence ends", () => {
    const sentence = "This is a fairly ordinary sentence about insurance losses. ";
    const long = sentence.repeat(60); // ~3500 chars, no blank lines
    const chunks = chunkText(long);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(CHUNK_TARGET_CHARS);
      // sentence-boundary preference: chunks end with a completed sentence
      expect(chunk.endsWith(".")).toBe(true);
    }
    // no text lost (modulo the whitespace trimmed at split points)
    expect(chunks.join(" ").replace(/\s+/g, " ").trim()).toBe(long.replace(/\s+/g, " ").trim());
  });

  test("splits an unbroken blob without any boundary at the hard limit", () => {
    const blob = "z".repeat(4000);
    const chunks = chunkText(blob);
    expect(chunks.map((c) => c.length)).toEqual([1500, 1500, 1000]);
  });

  test("normalizes CRLF paragraph breaks", () => {
    expect(chunkText("one\r\n\r\ntwo")).toEqual(["one\n\ntwo"]);
  });
});
