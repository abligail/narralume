import { describe, expect, it } from "vitest";

import {
  GroundedSettlementSchema,
  SETTLEMENT_CONTRACT,
  SettlementSchema,
  zodValidator,
} from "../src/schemas.js";

const baseFact = {
  operation: "assert" as const,
  factId: null,
  subjectId: "hero",
  predicate: "目击",
  knowledgeScope: "character" as const,
  knowledgeSubjectId: "hero",
  belief: "known" as const,
  evidenceParagraphs: [1],
};

describe("chapter settlement fact object contract", () => {
  it("accepts entity objects, scalar values, and object-free withdrawals", () => {
    const result = SettlementSchema.safeParse(
      settlement([
        { ...baseFact, objectEntityId: "witness", value: null },
        {
          ...baseFact,
          predicate: "记忆状态",
          objectEntityId: null,
          value: "模糊",
        },
        {
          ...baseFact,
          operation: "withdraw",
          factId: "fact-1",
          objectEntityId: null,
          value: null,
        },
      ]),
    );

    expect(result.success).toBe(true);
  });

  it("rejects an entity object combined with a scalar value", () => {
    const result = zodValidator(SettlementSchema)(
      settlement([{ ...baseFact, objectEntityId: "witness", value: true }]),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toContain(
      "factCandidates.0.value: 已填写 objectEntityId 时 value 必须为 null",
    );
    expect(result.issues[0]).toContain("不要额外填写布尔值或字符串 true");
  });

  it("requires assert and supersede to provide one non-null object", () => {
    const result = SettlementSchema.safeParse(
      settlement([{ ...baseFact, objectEntityId: null, value: null }]),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]).toMatchObject({
      path: ["factCandidates", 0, "value"],
      message: expect.stringContaining(
        "必须填写 objectEntityId 或非 null value",
      ),
    });
  });

  it("rejects payload fields on withdrawals, including grounded artifacts", () => {
    const invalidFacts = [
      {
        ...baseFact,
        operation: "withdraw" as const,
        factId: "fact-1",
        objectEntityId: "witness",
        value: null,
      },
      {
        ...baseFact,
        operation: "withdraw" as const,
        factId: "fact-1",
        objectEntityId: null,
        value: "旧值",
      },
    ];
    const groundedResult = GroundedSettlementSchema.safeParse(
      settlement([
        {
          ...invalidFacts[0],
          evidence: [groundedEvidence("撤回旧事实")],
        },
      ]),
    );

    for (const fact of invalidFacts) {
      expect(SettlementSchema.safeParse(settlement([fact])).success).toBe(
        false,
      );
    }
    expect(groundedResult.success).toBe(false);
  });

  it("publishes the same three object variants in the model JSON schema", () => {
    const schema = SETTLEMENT_CONTRACT.schema as {
      properties: {
        factCandidates: {
          items: {
            anyOf: Array<{
              additionalProperties: boolean;
              required: string[];
              properties: {
                operation: { enum: string[] };
                objectEntityId: { type: string | string[] };
                value: { type: string | string[] };
              };
            }>;
          };
        };
      };
    };
    const branches = schema.properties.factCandidates.items.anyOf;

    expect(branches).toHaveLength(3);
    expect(
      branches.every(
        (branch) =>
          branch.additionalProperties === false &&
          branch.required.includes("objectEntityId") &&
          branch.required.includes("value"),
      ),
    ).toBe(true);
    expect(branches.map((branch) => branch.properties.operation.enum)).toEqual([
      ["assert", "supersede"],
      ["assert", "supersede"],
      ["withdraw"],
    ]);
    expect(branches[0]?.properties).toMatchObject({
      objectEntityId: { type: "string" },
      value: { type: "null" },
    });
    expect(branches[1]?.properties).toMatchObject({
      objectEntityId: { type: "null" },
      value: { type: ["string", "number", "boolean"] },
    });
    expect(branches[2]?.properties).toMatchObject({
      objectEntityId: { type: "null" },
      value: { type: "null" },
    });
  });
});

function settlement(factCandidates: unknown[]) {
  return {
    summary: "结算摘要",
    summaryPoints: [
      { text: "结算摘要", basis: "observed", evidenceParagraphs: [1] },
    ],
    stateDelta: [],
    factCandidates,
    timelineCandidates: [],
    relationshipCandidates: [],
    foreshadowCandidates: [],
  };
}

function groundedEvidence(quote: string) {
  return {
    quote,
    start: 0,
    end: quote.length,
    documentVersionId: null,
    contentHash: "a".repeat(64),
    paragraphOrdinal: 1,
  };
}
