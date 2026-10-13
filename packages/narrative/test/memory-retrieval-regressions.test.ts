import { describe, expect, it } from "vitest";
import { ContextCompiler, estimateTokens } from "@narralume/context";
import {
  bindMemoryCitations,
  memoryManuscriptSources,
  validateMemoryCitations,
  type MemoryChapter,
} from "../src/chapter-memory.js";
import { selectEditorialSources } from "../src/editorial-grounding.js";
import { ParagraphLocator } from "../src/paragraph-locator.js";

function chapter(chapterId: string, content: string): MemoryChapter {
  const locator = new ParagraphLocator(content, {
    documentVersionId: `version-${chapterId}`,
  });
  return {
    chapterId,
    chapterNumber: 1,
    title: chapterId,
    versionId: locator.documentVersionId!,
    sourceHash: locator.contentHash,
    content,
    summary: "",
    summaryPoints: [],
  };
}

describe("history retrieval regressions", () => {
  it("keeps topic evidence ahead of recent name-only chatter within the history budget", () => {
    const important = chapter(
      "important",
      "The key passed from Mira to the captain.",
    );
    const prefix = "Mira and Rowan discuss weather. ";
    const chatter = chapter(
      "chatter",
      Array.from(
        { length: 25 },
        () => `${prefix}${"x".repeat(1_000 - prefix.length)}`,
      ).join("\n\n"),
    );
    const recent = chapter("recent", "A new day starts.");
    const sources = memoryManuscriptSources(
      [important, chatter, recent],
      1,
      JSON.stringify([{ title: "Key custody", promise: "Track key." }]),
      ["Mira", "Rowan"],
    );

    expect(
      sources.find((source) => source.sourceId === "important")?.content,
    ).toContain(important.content);
    expect(
      sources.find((source) => source.sourceId === "chatter"),
    ).toBeDefined();
    const historyLength = sources
      .filter((source) => source.sourceId !== "recent")
      .reduce(
        (total, source) =>
          total +
          JSON.parse(source.content).paragraphs.reduce(
            (length: number, paragraph: { text: string }) =>
              length + paragraph.text.length,
            0,
          ),
        0,
      );
    expect(historyLength).toBeLessThanOrEqual(24_000);
    expect(sources.at(-1)).toMatchObject({
      sourceId: "recent",
      required: true,
    });
  });

  it("preserves caller order for equal topic matches without explicit entity names", () => {
    const sources = ["near", "far"].map((id) => ({
      id,
      kind: "manuscript" as const,
      version: id,
      content: "The key changed hands.",
    }));
    expect(
      selectEditorialSources(sources, "key", 1_000).map((source) => source.id),
    ).toEqual(["near:passage:0", "far:passage:0"]);
  });

  it("retains topic evidence when compilation cannot also fit more recent name-only chatter", () => {
    const chapters = [
      chapter("important", "The key passed from Mira to the captain."),
      chapter(
        "chatter",
        `Mira and Rowan discuss weather. ${"x".repeat(1_000)}`,
      ),
      chapter("recent", "A new day starts."),
    ];
    const sources = memoryManuscriptSources(chapters, 1, "key", [
      "Mira",
      "Rowan",
    ]);
    const contextWindow = sources
      .filter((source) => source.sourceId !== "important")
      .reduce((total, source) => total + estimateTokens(source.content), 0);
    const compiled = new ContextCompiler().compile({
      projectId: "project",
      purpose: "rolling-outline",
      sources,
      budget: {
        contextWindow,
        outputReserve: 0,
        fixedInstructionReserve: 0,
        schemaReserve: 0,
        toolReserve: 0,
        safetyReserve: 0,
      },
    });
    expect(compiled.sections.map((section) => section.id)).toEqual([
      "memory-manuscript:important",
      "memory-manuscript:recent",
    ]);
    expect(compiled.receipt.entries).toContainEqual(
      expect.objectContaining({
        sourceId: "memory-manuscript:chatter",
        status: "excluded",
      }),
    );
  });

  it("does not elevate a chapter whose topic paragraph was excluded from the actual history budget", () => {
    const mixed = chapter(
      "mixed",
      Array.from({ length: 10 }, (_, index) =>
        index === 0
          ? "Mira rested."
          : index === 8
            ? `The key changed hands. ${"x".repeat(24_000)}`
            : "An uneventful day passed.",
      ).join("\n\n"),
    );
    const sources = memoryManuscriptSources(
      [mixed, chapter("recent", "A new day starts.")],
      1,
      "key",
      ["Mira"],
    );
    const source = sources.find((entry) => entry.sourceId === "mixed")!;
    expect(source.content).toContain("Mira rested.");
    expect(source.content).not.toContain("key changed hands");
    expect(source.priority).toBe(94);
  });

  it.each(["岚", "Al", "Jo"])(
    "retrieves a short explicit name or alias %s without lowering general query thresholds",
    (name) => {
      const old = chapter("old", `${name} took the key.`);
      const recent = chapter("recent", "A new day starts.");
      expect(
        memoryManuscriptSources([old, recent], 1, "", [name]),
      ).toHaveLength(2);
      expect(memoryManuscriptSources([old, recent], 1, name)).toHaveLength(1);
    },
  );

  it("matches Latin names and aliases as words rather than unrelated word fragments", () => {
    const sources = memoryManuscriptSources(
      [
        chapter("unrelated", "She also admired the jovial captain."),
        chapter("matching", "AL passed the key to Jo."),
        chapter("recent", "A new day starts."),
      ],
      1,
      "",
      ["Al", "Jo"],
    );
    expect(sources.map((source) => source.sourceId)).toEqual([
      "matching",
      "recent",
    ]);
  });

  it.each(["\u3000", "\v"])(
    "keeps paragraph ordinals aligned when an internal blank line contains %j",
    (whitespace) => {
      const old = chapter(
        "old",
        `first\n${whitespace}\nsecond\n${whitespace}\nMira took the key.\n\nlast`,
      );
      const sources = memoryManuscriptSources(
        [old, chapter("recent", "A new day starts.")],
        1,
        "",
        ["Mira"],
      );
      const paragraphs = JSON.parse(
        sources.find((source) => source.sourceId === "old")!.content,
      ).paragraphs;
      expect(paragraphs).toContainEqual({
        ordinal: 1,
        text: new ParagraphLocator(old.content).paragraphs[0]!.quote,
      });
      const citation = {
        chapterId: "old",
        paragraphOrdinal: 1,
        quote: "Mira took the key.",
      };
      expect(validateMemoryCitations([citation], sources)).toEqual([]);
      const bound = bindMemoryCitations([citation], [old])[0]!;
      expect(old.content.slice(bound.start, bound.end)).toBe(citation.quote);
    },
  );
});
