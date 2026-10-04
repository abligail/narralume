import { ContextCompiler, estimateTokens } from "@narralume/context";
import type { NarrativeSummary } from "@narralume/domain";
import { describe, expect, it } from "vitest";
import {
  currentSummaryPoints,
  memoryManuscriptSources,
  memorySummarySources,
  validateMemoryCitations,
  bindMemoryCitations,
  type MemoryChapter,
} from "../src/chapter-memory.js";
import { ParagraphLocator } from "../src/paragraph-locator.js";
import { SettlementSchema } from "../src/schemas.js";

const content =
  "露娜说：“一年前我没能救起河坝边的孩子。”\n\n小柒怀疑护士拿过刀片，但没有证据确认。\n\n两人修好了共证页，回家的碎片仍没有确切解释。";
const locator = new ParagraphLocator(content, {
  documentVersionId: "version-15",
});
function chapter(id: string, text = content): MemoryChapter {
  const source = new ParagraphLocator(text, {
    documentVersionId: `version-${id}`,
  });
  return {
    chapterId: id,
    chapterNumber: 15,
    title: id,
    versionId: source.documentVersionId!,
    sourceHash: source.contentHash,
    content: text,
    summary: "露娜事故尚未揭示，共证页等待修复。",
    summaryPoints: [],
  };
}
function summary(): NarrativeSummary {
  return {
    id: "summary",
    projectId: "project",
    scopeType: "chapter",
    scopeId: "chapter",
    summary: "错误的自由摘要",
    sourceHash: locator.contentHash,
    createdAt: "2026-10-04T00:00:00Z",
    stateDelta: {
      summaryPoints: [
        {
          text: "露娜回忆河坝救人失败。",
          basis: "reported",
          evidenceParagraphs: [1],
          evidence: locator.locate([1]),
        },
      ],
    },
  };
}
describe("grounded chapter memory", () => {
  it("requires evidence-backed points instead of an unsupported free synopsis", () => {
    expect(
      SettlementSchema.safeParse({
        summary: "事故尚未揭示",
        stateDelta: [],
        factCandidates: [],
        timelineCandidates: [],
        relationshipCandidates: [],
        foreshadowCandidates: [],
      }).success,
    ).toBe(false);
  });
  it("retains a speaker account's evidence and epistemic level independently of a misleading synopsis", () => {
    expect(currentSummaryPoints(summary(), locator)).toMatchObject([
      {
        basis: "reported",
        text: "露娜回忆河坝救人失败。",
        evidence: [
          {
            quote: locator.paragraphs[0]!.quote,
            documentVersionId: "version-15",
          },
        ],
      },
    ]);
    const sources = memorySummarySources(
      [
        {
          ...chapter("15"),
          summaryPoints: currentSummaryPoints(summary(), locator),
        },
      ],
      "15",
    );
    const compiled = new ContextCompiler().compile({
      projectId: "project",
      purpose: "chapter-draft",
      budget: {
        contextWindow: 4_000,
        outputReserve: 1_000,
        fixedInstructionReserve: 200,
        toolReserve: 0,
        schemaReserve: 100,
        safetyReserve: 200,
      },
      sources,
    });
    expect(compiled.text).toContain('"basis":"reported"');
    expect(compiled.text).toContain("露娜说");
    expect(compiled.text).not.toContain("错误的自由摘要");
  });
  it("shares quoted paragraphs across points without losing their source bindings", () => {
    const value = summary();
    value.stateDelta.summaryPoints = [
      {
        text: "共证页已经修好。",
        basis: "observed",
        evidenceParagraphs: [3],
        evidence: locator.locate([3]),
      },
      {
        text: "露娜的说法与已完成的修复分别有原文证据。",
        basis: "reported",
        evidenceParagraphs: [1, 3],
        evidence: locator.locate([1, 3]),
      },
    ];
    const points = currentSummaryPoints(value, locator);
    const sources = memorySummarySources([
      { ...chapter("15"), summaryPoints: points },
    ]);
    const data = JSON.parse(sources[0]!.content);
    expect(data).toEqual({
      chapterId: "15",
      chapterNumber: 15,
      versionId: "version-15",
      sourceHash: locator.contentHash,
      summaryPoints: points.map(({ text, basis, evidenceParagraphs }) => ({
        text,
        basis,
        evidenceParagraphs,
      })),
      evidence: locator.locate([1, 3]),
    });
    for (const evidence of data.evidence) {
      expect(
        sources[0]!.content.split(JSON.stringify(evidence.quote)),
      ).toHaveLength(2);
      expect(content.slice(evidence.start, evidence.end)).toBe(evidence.quote);
    }
    expect(points[0]!.evidence).toEqual(locator.locate([3]));
    expect(points[1]!.evidence).toEqual(locator.locate([1, 3]));
  });
  it("fits the planning budget when many valid points cite one long paragraph", () => {
    const text = "正文".repeat(1_500);
    const source = new ParagraphLocator(text, {
      documentVersionId: "version-long",
    });
    const value = summary();
    value.sourceHash = source.contentHash;
    value.stateDelta.summaryPoints = Array.from({ length: 15 }, (_, index) => ({
      text: `关键进展 ${index + 1}`,
      basis: "observed",
      evidenceParagraphs: [1],
      evidence: source.locate([1]),
    }));
    const points = currentSummaryPoints(value, source);
    expect(points).toHaveLength(15);
    const sources = memorySummarySources(
      [{ ...chapter("long", text), summaryPoints: points }],
      "long",
    );
    const compiled = new ContextCompiler().compile({
      projectId: "project",
      purpose: "rolling-outline",
      budget: {
        contextWindow: 64_000,
        outputReserve: 16_000,
        fixedInstructionReserve: 1_500,
        toolReserve: 0,
        schemaReserve: 1_500,
      },
      sources,
    });
    const data = JSON.parse(compiled.sections[0]!.content);
    expect(data.summaryPoints).toHaveLength(15);
    expect(data.evidence).toEqual(source.locate([1]));
    expect(compiled.receipt.budget.used).toBeLessThan(5_000);
    expect(compiled.receipt.entries[0]).toMatchObject({
      status: "included",
      reason: "Required source",
    });
  });
  it.each([
    "sourceHash",
    "documentVersionId",
    "quote",
    "start",
    "paragraphOrdinal",
    "evidenceParagraphs",
  ])("rejects stale or fabricated %s on a point", (field) => {
    const value = summary();
    const points = value.stateDelta.summaryPoints as {
      evidenceParagraphs: number[];
      evidence: Record<string, unknown>[];
    }[];
    if (field === "sourceHash") value.sourceHash = "b".repeat(64);
    else if (field === "evidenceParagraphs")
      points[0]!.evidenceParagraphs = [3];
    else
      points[0]!.evidence[0]![field] = ["start", "paragraphOrdinal"].includes(
        field,
      )
        ? 99
        : "wrong";
    expect(currentSummaryPoints(value, locator)).toEqual([]);
  });
  it("supplies recent prose even when the summary omits revelations and claims completed work is pending", () => {
    const sources = memoryManuscriptSources([chapter("chapter-15")], 1, "露娜");
    const data = JSON.parse(sources[0]!.content);
    expect(data.complete).toBe(true);
    expect(data.paragraphs.map((p: { text: string }) => p.text)).toContain(
      locator.paragraphs[2]!.quote,
    );
    expect(sources[0]!.content).not.toContain("等待修复");
    expect(sources[0]!.required).toBe(true);
  });
  it("retrieves older relevant passages without renumbering or including every chapter", () => {
    const text = Array.from({ length: 60 }, (_, i) =>
      i === 30 ? "林砚身份已明确为母亲。" : "无关日常。",
    ).join("\r\n\r\n");
    const sources = memoryManuscriptSources(
      [
        chapter("old", text),
        chapter("unrelated", "完全无关。"),
        chapter("recent"),
      ],
      1,
      "林砚母亲",
    );
    const old = JSON.parse(sources.find((s) => s.sourceId === "old")!.content);
    expect(old.complete).toBe(false);
    expect(old.paragraphs).toContainEqual({
      ordinal: 31,
      text: "林砚身份已明确为母亲。",
    });
    expect(sources.some((s) => s.sourceId === "unrelated")).toBe(false);
    const citation = {
      chapterId: "old",
      paragraphOrdinal: 31,
      quote: "林砚身份已明确为母亲",
    };
    expect(validateMemoryCitations([citation], sources)).toEqual([]);
    const bound = bindMemoryCitations([citation], [chapter("old", text)])[0]!;
    expect(text.slice(bound.start, bound.end)).toBe(citation.quote);
  });
  it("spends the history budget on unique paragraphs and prefers recent evidence on equal matches", () => {
    const repeated = Array.from(
      { length: 21 },
      () => `露娜伙伴事故 ${"日常".repeat(500)}`,
    ).join("\n\n");
    const sources = memoryManuscriptSources(
      [
        chapter("early", "露娜曾提到事故，但没有说明。"),
        chapter("middle", repeated),
        chapter("disclosure", "露娜讲明事故：河坝塌了，孩子没救回来。"),
        chapter("recent", "准备下一阶段。"),
      ],
      1,
      "露娜伙伴事故",
    );
    expect(sources.find((s) => s.sourceId === "disclosure")?.content).toContain(
      "孩子没救回来",
    );
    expect(
      JSON.parse(sources.find((s) => s.sourceId === "middle")!.content)
        .paragraphs,
    ).toHaveLength(21);
    const olderLength = sources
      .filter((s) => s.sourceId !== "recent")
      .reduce(
        (size, s) =>
          size +
          JSON.parse(s.content).paragraphs.reduce(
            (n: number, p: { text: string }) => n + p.text.length,
            0,
          ),
        0,
      );
    expect(olderLength).toBeLessThanOrEqual(24_000);
  });
  it.each([
    { chapterId: "future", paragraphOrdinal: 1, quote: "露娜" },
    { chapterId: "current", paragraphOrdinal: 2, quote: "一年前" },
    { chapterId: "current", paragraphOrdinal: 1, quote: "一年前……河坝" },
    { chapterId: "current", paragraphOrdinal: 99, quote: "露娜" },
  ])(
    "rejects absent chapters, wrong paragraphs and invented quotes: %j",
    (citation) => {
      expect(
        validateMemoryCitations(
          [citation],
          memoryManuscriptSources([chapter("current")], 1, ""),
        ),
      ).toHaveLength(1);
    },
  );
  it("rejects citations to an older passage excluded by compilation", () => {
    const sources = memoryManuscriptSources(
      [chapter("old"), chapter("recent")],
      1,
      "露娜",
    );
    const compiled = new ContextCompiler().compile({
      projectId: "p",
      purpose: "review",
      sources,
      budget: {
        contextWindow:
          estimateTokens(
            sources.find((s) => s.sourceId === "recent")!.content,
          ) + 10,
        outputReserve: 0,
        fixedInstructionReserve: 0,
        schemaReserve: 0,
        toolReserve: 0,
        safetyReserve: 0,
      },
    });
    const included = sources.filter((source) =>
      compiled.sections.some((s) => s.id === source.id),
    );
    expect(included.some((s) => s.sourceId === "recent")).toBe(true);
    expect(included.some((s) => s.sourceId === "old")).toBe(false);
    expect(
      validateMemoryCitations(
        [{ chapterId: "old", paragraphOrdinal: 1, quote: "露娜" }],
        included,
      ),
    ).toHaveLength(1);
  });
});
