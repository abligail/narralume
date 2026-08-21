import { createCanonEntity, createCanonFact } from "@narralume/domain";
import { describe, expect, it } from "vitest";

import {
  ContextBudgetError,
  ContextCompiler,
  canonContextSources,
  estimateTokens,
  type ContextSource,
} from "../src/index.js";

describe("token estimator", () => {
  it("accounts for CJK characters and long ASCII words without returning zero", () => {
    expect(estimateTokens("灯塔")).toBeGreaterThanOrEqual(2);
    expect(estimateTokens("supercalifragilistic")).toBeGreaterThan(1);
    expect(estimateTokens("")).toBe(0);
  });
});

describe("ContextCompiler", () => {
  const budget = {
    contextWindow: 180,
    outputReserve: 20,
    fixedInstructionReserve: 10,
    toolReserve: 10,
    schemaReserve: 10,
    safetyReserve: 0,
  };

  it("keeps required facts, compresses with existing summaries, excludes low priority, and emits a receipt", () => {
    const sources: ContextSource[] = [
      {
        id: "task",
        kind: "task",
        label: "当前任务",
        content: "写出林昭抵达雾港的场景。",
        authority: "system",
        priority: 100,
        required: true,
        compressible: false,
        sourceType: "task",
      },
      {
        id: "history",
        kind: "recent-text",
        label: "长历史",
        content: "潮".repeat(180),
        summary: "此前，林昭决定独自前往雾港。",
        authority: "confirmed",
        priority: 70,
        sourceType: "chapter",
        sourceId: "chapter-0",
      },
      {
        id: "style",
        kind: "style",
        label: "低优先风格",
        content: "避免连续使用形容词。".repeat(20),
        authority: "reference",
        priority: 1,
        sourceType: "style",
      },
    ];
    const compiled = new ContextCompiler(
      () => new Date("2026-08-10T00:00:00Z"),
    ).compile({
      projectId: "p1",
      purpose: "scene.write",
      budget,
      sources,
    });
    expect(compiled.sections.map((section) => section.id)).toEqual([
      "task",
      "history",
    ]);
    expect(compiled.sections[1]?.compressed).toBe(true);
    expect(compiled.receipt.entries).toEqual([
      expect.objectContaining({
        sourceId: "task",
        status: "included",
        reason: "Required source",
      }),
      expect.objectContaining({ sourceId: "history", status: "compressed" }),
      expect.objectContaining({ sourceId: "style", status: "excluded" }),
    ]);
    expect(compiled.receipt.compiledHash).toMatch(/^[a-f0-9]{64}$/);
    expect(
      compiled.receipt.budget.used + compiled.receipt.budget.remaining,
    ).toBe(compiled.receipt.budget.available);
  });

  it("fails instead of silently cutting a required source", () => {
    expect(() =>
      new ContextCompiler().compile({
        projectId: "p1",
        purpose: "chapter.write",
        budget: { ...budget, contextWindow: 60 },
        sources: [
          {
            id: "locked",
            kind: "system",
            label: "不可变协议",
            content: "规则".repeat(100),
            authority: "system",
            priority: 100,
            required: true,
            compressible: false,
            sourceType: "protocol",
          },
        ],
      }),
    ).toThrow(ContextBudgetError);
  });
});

describe("canon context access", () => {
  it("never injects author secrets or another character's private knowledge", () => {
    const now = "2026-08-10T00:00:00Z";
    const hero = createCanonEntity({
      id: "hero",
      projectId: "p1",
      type: "character",
      name: "林昭",
      now,
    });
    const other = createCanonEntity({
      id: "other",
      projectId: "p1",
      type: "character",
      name: "船长",
      now,
    });
    const facts = [
      createCanonFact({
        id: "public",
        projectId: "p1",
        subjectId: hero.id,
        predicate: "职业",
        value: "守灯人",
        knowledgeScope: "reader",
        authority: "confirmed",
        sourceType: "manual",
        now,
      }),
      createCanonFact({
        id: "secret",
        projectId: "p1",
        subjectId: hero.id,
        predicate: "真实身份",
        value: "王储",
        knowledgeScope: "author_secret",
        authority: "locked",
        sourceType: "manual",
        now,
      }),
      createCanonFact({
        id: "other-belief",
        projectId: "p1",
        subjectId: hero.id,
        predicate: "怀疑",
        value: "林昭说谎",
        knowledgeScope: "character",
        knowledgeSubjectId: other.id,
        authority: "confirmed",
        sourceType: "chapter",
        now,
      }),
    ];
    const sources = canonContextSources([hero, other], facts, {
      audience: "reader",
    });
    expect(sources[0]?.content).toContain("守灯人");
    expect(sources[0]?.content).not.toContain("王储");
    expect(sources[0]?.content).not.toContain("说谎");
  });
});
