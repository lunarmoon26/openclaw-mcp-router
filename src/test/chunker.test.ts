import { describe, it, expect } from "vitest";
import { chunkText } from "../chunker.js";

const defaultConfig = { maxChunkChars: 100, overlapChars: 20 };

describe("chunkText", () => {
  it("returns single chunk for short text", () => {
    const chunks = chunkText("read_file: Read a file from disk", "read_file", defaultConfig);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({ index: 0, total: 1, text: "read_file: Read a file from disk" });
  });

  it("returns single chunk when text exactly equals maxChunkChars", () => {
    const text = "x".repeat(100);
    const chunks = chunkText(text, "tool", { maxChunkChars: 100, overlapChars: 10 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe(text);
  });

  it("splits on paragraph boundaries (\\n\\n)", () => {
    const para1 = "a".repeat(60);
    const para2 = "b".repeat(60);
    const text = `${para1}\n\n${para2}`;
    const chunks = chunkText(text, "tool", defaultConfig);
    expect(chunks.length).toBeGreaterThan(1);
    // First chunk should contain para1 with the separator
    expect(chunks[0].text).toContain(para1);
  });

  it("splits on line boundaries (\\n)", () => {
    const line1 = "a".repeat(60);
    const line2 = "b".repeat(60);
    const text = `${line1}\n${line2}`;
    const chunks = chunkText(text, "tool", defaultConfig);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].text).toContain(line1);
  });

  it("splits on sentence boundaries ('. ')", () => {
    const sent1 = "a".repeat(60);
    const sent2 = "b".repeat(60);
    const text = `${sent1}. ${sent2}`;
    const chunks = chunkText(text, "tool", defaultConfig);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].text).toContain(sent1);
  });

  it("hard-splits text with no semantic boundaries", () => {
    const text = "x".repeat(250);
    const chunks = chunkText(text, "tool", defaultConfig);
    expect(chunks.length).toBeGreaterThan(1);
    // All text should be recoverable (accounting for overlap and prefix)
  });

  it("includes overlap between adjacent chunks", () => {
    const line1 = "a".repeat(60);
    const line2 = "b".repeat(60);
    const text = `${line1}\n${line2}`;
    const chunks = chunkText(text, "tool", { maxChunkChars: 70, overlapChars: 15 });
    expect(chunks.length).toBeGreaterThan(1);
    // Second chunk should contain overlap from end of first chunk
    const firstTail = chunks[0].text.slice(-15);
    expect(chunks[1].text).toContain(firstTail);
  });

  it("prefixes tool name on chunks with index > 0", () => {
    const line1 = "a".repeat(60);
    const line2 = "b".repeat(60);
    const text = `${line1}\n${line2}`;
    const chunks = chunkText(text, "my_tool", { maxChunkChars: 70, overlapChars: 10 });
    expect(chunks.length).toBeGreaterThan(1);
    // First chunk should NOT have the continuation prefix
    expect(chunks[0].text).not.toMatch(/^my_tool: \.\.\. /);
    // Subsequent chunks should have the prefix
    expect(chunks[1].text).toMatch(/^my_tool: \.\.\. /);
  });

  it("disables chunking when maxChunkChars is 0", () => {
    const text = "x".repeat(5000);
    const chunks = chunkText(text, "tool", { maxChunkChars: 0, overlapChars: 200 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe(text);
  });

  it("handles empty text", () => {
    const chunks = chunkText("", "tool", defaultConfig);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({ index: 0, total: 1, text: "" });
  });

  it("sets correct index and total on all chunks", () => {
    const text = "a".repeat(50) + "\n" + "b".repeat(50) + "\n" + "c".repeat(50);
    const chunks = chunkText(text, "tool", { maxChunkChars: 60, overlapChars: 10 });
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].index).toBe(i);
      expect(chunks[i].total).toBe(chunks.length);
    }
  });
});
