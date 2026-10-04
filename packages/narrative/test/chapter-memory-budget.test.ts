import {
  ContextBudgetError,
  ContextCompiler,
  estimateTokens,
  type ContextSource,
} from "@narralume/context";
import { describe, expect, it } from "vitest";
import {
  memoryManuscriptSources,
  validateMemoryCitations,
  type MemoryChapter,
} from "../src/chapter-memory.js";
import { ParagraphLocator } from "../src/paragraph-locator.js";

const reviewBudget = {
  contextWindow: 64_000,
  outputReserve: 16_000,
  fixedInstructionReserve: 1_000,
  schemaReserve: 1_000,
  toolReserve: 0,
};

function chapter(
  chapterNumber: number,
  content = "正文".repeat(1_500),
): MemoryChapter {
  const chapterId = `chapter-${chapterNumber}`;
  const locator = new ParagraphLocator(content, {
    documentVersionId: `version-${chapterNumber}`,
  });
  return {
    chapterId,
    chapterNumber,
    title: `Chapter ${chapterNumber}`,
    versionId: locator.documentVersionId!,
    sourceHash: locator.contentHash,
    content,
    summary: "A chapter retrieval index.",
    summaryPoints: [],
  };
}

function compile(sources: readonly ContextSource[], contextWindow?: number) {
  return new ContextCompiler().compile({
    projectId: "project",
    purpose: "arc-review",
    sources,
    budget:
      contextWindow === undefined
        ? reviewBudget
        : {
            contextWindow,
            outputReserve: 0,
            fixedInstructionReserve: 0,
            schemaReserve: 0,
            toolReserve: 0,
            safetyReserve: 0,
          },
  });
}

describe("review manuscript context budgets", () => {
  it.each([20, 40, 60])(
    "fits %i committed chapters in the default review budget with a 20-chapter window",
    (chapterCount) => {
      const chapters = Array.from({ length: chapterCount }, (_, index) =>
        chapter(index + 1),
      );
      const sources = memoryManuscriptSources(chapters, 20 * 2, "unmatched");
      const compiled = compile(sources);
      const latest = sources.at(-1)!;

      expect(sources).toHaveLength(Math.min(chapterCount, 40));
      expect(sources.filter((source) => source.required)).toEqual([latest]);
      expect(sources.every((source) => source.compressible === false)).toBe(
        true,
      );
      expect(
        sources.every((source) => JSON.parse(source.content).complete === true),
      ).toBe(true);
      expect(compiled.receipt.budget.available).toBe(42_800);
      expect(compiled.receipt.budget.used).toBeLessThanOrEqual(42_800);
      expect(
        sources.reduce(
          (total, source) => total + estimateTokens(source.content),
          0,
        ),
      ).toBeGreaterThan(compiled.receipt.budget.available);
      expect(
        compiled.sections.find((section) => section.id === latest.id),
      ).toMatchObject({
        content: latest.content,
        compressed: false,
      });
      expect(
        compiled.receipt.entries.find((entry) => entry.sourceId === latest.id),
      ).toMatchObject({ status: "included", reason: "Required source" });
      expect(
        compiled.receipt.entries.some((entry) => entry.status === "excluded"),
      ).toBe(true);

      const included = new Set(compiled.sections.map((section) => section.id));
      const includedChapters = sources.filter((source) =>
        included.has(source.id),
      );
      expect(includedChapters).toEqual(sources.slice(-includedChapters.length));
      expect(
        compiled.sections.every(
          (section) =>
            !section.compressed &&
            JSON.parse(section.content).complete === true,
        ),
      ).toBe(true);
    },
  );

  it("reserves the latest full chapter before considering any earlier prose", () => {
    const sources = memoryManuscriptSources(
      [chapter(1), chapter(2), chapter(3)],
      40,
      "",
    );
    const latest = sources.at(-1)!;
    const compiled = compile(sources, estimateTokens(latest.content));

    expect(compiled.sections).toHaveLength(1);
    expect(compiled.sections[0]).toMatchObject({
      id: latest.id,
      content: latest.content,
      compressed: false,
    });
    expect(compiled.receipt.budget.remaining).toBe(0);
  });

  it("still fails when the latest complete chapter cannot fit", () => {
    const sources = memoryManuscriptSources([chapter(1), chapter(2)], 40, "");
    const latest = sources.at(-1)!;

    expect(() => compile(sources, estimateTokens(latest.content) - 1)).toThrow(
      ContextBudgetError,
    );
    expect(() => compile(sources, estimateTokens(latest.content) - 1)).toThrow(
      expect.objectContaining({
        code: "context.budget.required_overflow",
        sourceId: latest.id,
      }),
    );
  });

  it("rejects citations to a recent complete chapter omitted from the model context", () => {
    const sources = memoryManuscriptSources([chapter(1), chapter(2)], 40, "");
    const latest = sources.at(-1)!;
    const compiled = compile(sources, estimateTokens(latest.content));
    const includedSources = sources.filter((source) =>
      compiled.sections.some((section) => section.id === source.id),
    );
    const excludedCitation = {
      chapterId: "chapter-1",
      paragraphOrdinal: 1,
      quote: "正文",
    };

    expect(validateMemoryCitations([excludedCitation], sources)).toEqual([]);
    expect(
      validateMemoryCitations([excludedCitation], includedSources),
    ).toEqual([
      "citations.0: Evidence chapter chapter-1 was not supplied as manuscript prose",
    ]);
    expect(
      validateMemoryCitations(
        [{ ...excludedCitation, chapterId: "chapter-2" }],
        includedSources,
      ),
    ).toEqual([]);
  });
});
