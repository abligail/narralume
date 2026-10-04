import type { JsonSchemaContract, StructuredValidator } from "@narralume/llm";
import { z } from "zod";

const EvidenceParagraphsSchema = z
  .array(z.number().int().positive())
  .min(1)
  .max(5)
  .refine((ordinals) => new Set(ordinals).size === ordinals.length, {
    message: "段号不得重复",
  });

const SceneSchema = z.object({
  title: z.string().min(1),
  goal: z.string().min(1),
  conflict: z.string().min(1),
  turn: z.string().min(1),
  outcome: z.string().min(1),
  locationId: z.string().nullable(),
  participants: z.array(z.string()),
  targetCharacters: z.number().int().min(200).max(20_000),
});
export const ScenePlanSchema = z.object({
  chapterGoal: z.string().min(1),
  povEntityId: z.string().nullable(),
  scenes: z.array(SceneSchema).min(1).max(12),
  continuityRisks: z.array(z.string()).max(20),
});
export type ScenePlan = z.infer<typeof ScenePlanSchema>;

const ReviewIssueSchema = z
  .object({
    category: z.enum([
      "continuity",
      "canon",
      "pov",
      "character",
      "agency",
      "causality",
      "pacing",
      "information",
      "prose",
      "style",
      "foreshadow",
      "goal",
      "safety",
    ]),
    severity: z.enum(["info", "minor", "major", "critical"]),
    message: z.string().min(1),
    evidenceParagraphs: EvidenceParagraphsSchema,
    suggestedDirection: z.string().nullable(),
    requiresAuthorDecision: z.boolean(),
  })
  .strict();
export const ReviewResultSchema = z
  .object({
    summary: z.string().min(1),
    scores: z.object({
      continuity: z.number().min(0).max(100),
      pacing: z.number().min(0).max(100),
      character: z.number().min(0).max(100),
      prose: z.number().min(0).max(100),
      goal: z.number().min(0).max(100),
    }),
    issues: z.array(ReviewIssueSchema).max(30),
  })
  .strict();
export type ReviewResult = z.infer<typeof ReviewResultSchema>;
export type DerivedReviewResult = ReviewResult & {
  verdict: "pass" | "revise" | "block";
};

const KnowledgeBeliefSchema = z.enum([
  "known",
  "believed",
  "suspected",
  "false_belief",
]);

const CandidateFactSchema = z
  .object({
    operation: z.enum(["assert", "supersede", "withdraw"]),
    factId: z.string().min(1).nullable(),
    subjectId: z.string().min(1),
    predicate: z.string().min(1),
    objectEntityId: z.string().nullable(),
    value: z.union([z.string(), z.number(), z.boolean()]).nullable(),
    knowledgeScope: z.enum([
      "omniscient",
      "reader",
      "character",
      "author_secret",
    ]),
    knowledgeSubjectId: z.string().min(1).nullable(),
    belief: KnowledgeBeliefSchema,
    evidenceParagraphs: EvidenceParagraphsSchema,
  })
  .superRefine((fact, context) => {
    if (fact.operation === "withdraw") {
      if (fact.objectEntityId !== null) {
        context.addIssue({
          code: "custom",
          path: ["objectEntityId"],
          message:
            "withdraw 通过 factId 指定目标事实，objectEntityId 必须为 null",
        });
      }
      if (fact.value !== null) {
        context.addIssue({
          code: "custom",
          path: ["value"],
          message: "withdraw 通过 factId 指定目标事实，value 必须为 null",
        });
      }
      return;
    }
    if (fact.objectEntityId !== null && fact.value !== null) {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message:
          "已填写 objectEntityId 时 value 必须为 null；不要额外填写布尔值或字符串 true 表示事实成立；需要同时记录实体与文本时请拆成两条事实",
      });
    }
    if (fact.objectEntityId === null && fact.value === null) {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message:
          "assert/supersede 必须填写 objectEntityId 或非 null value 其中之一",
      });
    }
  });
export const SummaryPointSchema = z
  .object({
    text: z.string().trim().min(1).max(2_000),
    basis: z.enum(["observed", "reported", "inferred", "unresolved"]),
    evidenceParagraphs: EvidenceParagraphsSchema,
  })
  .strict();

export const SettlementSchema = z.object({
  summaryPoints: z.array(SummaryPointSchema).min(1).max(20),
  stateDelta: z
    .array(
      z.object({
        key: z.string().min(1),
        before: z.string().nullable(),
        after: z.string().min(1),
        evidenceParagraphs: EvidenceParagraphsSchema,
      }),
    )
    .max(100),
  factCandidates: z.array(CandidateFactSchema).max(100),
  timelineCandidates: z
    .array(
      z.object({
        title: z.string().min(1),
        description: z.string().nullable(),
        storyTime: z.string().nullable(),
        participantIds: z.array(z.string()),
        causeEventIds: z.array(z.string()),
        visibility: z.enum(["omniscient", "reader", "author_secret"]),
        knownBy: z.array(
          z.object({
            entityId: z.string().min(1),
            belief: KnowledgeBeliefSchema,
          }),
        ),
        evidenceParagraphs: EvidenceParagraphsSchema,
      }),
    )
    .max(50),
  relationshipCandidates: z
    .array(
      z.object({
        action: z.enum(["start", "update", "end"]),
        relationshipId: z.string().min(1).nullable(),
        fromEntityId: z.string().min(1),
        toEntityId: z.string().min(1),
        relation: z.string().min(1),
        change: z.string().min(1),
        evidenceParagraphs: EvidenceParagraphsSchema,
      }),
    )
    .max(50),
  foreshadowCandidates: z
    .array(
      z.object({
        foreshadowId: z.string().min(1).nullable(),
        title: z.string().min(1),
        action: z.enum(["plant", "develop", "resolve"]),
        expectedStatus: z
          .enum(["planned", "planted", "developing", "resolved", "abandoned"])
          .nullable(),
        importance: z.union([
          z.literal(1),
          z.literal(2),
          z.literal(3),
          z.literal(4),
          z.literal(5),
        ]),
        targetFromNodeId: z.string().min(1).nullable(),
        targetToNodeId: z.string().min(1).nullable(),
        evidenceParagraphs: EvidenceParagraphsSchema,
      }),
    )
    .max(50),
});
export type Settlement = z.infer<typeof SettlementSchema>;

export const GroundedParagraphEvidenceSchema = z.object({
  quote: z.string(),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  documentVersionId: z.string().nullable(),
  contentHash: z.string().length(64),
  paragraphOrdinal: z.number().int().positive(),
});

export const GroundedSettlementSchema = SettlementSchema.extend({
  summary: z.string().min(1),
  summaryPoints: z
    .array(
      SummaryPointSchema.extend({
        evidence: z.array(GroundedParagraphEvidenceSchema).min(1).max(5),
      }),
    )
    .min(1)
    .max(20),
  stateDelta: z.array(
    SettlementSchema.shape.stateDelta.element.extend({
      evidence: z.array(GroundedParagraphEvidenceSchema).min(1).max(5),
    }),
  ),
  factCandidates: z.array(
    SettlementSchema.shape.factCandidates.element.safeExtend({
      evidence: z.array(GroundedParagraphEvidenceSchema).min(1).max(5),
    }),
  ),
  timelineCandidates: z.array(
    SettlementSchema.shape.timelineCandidates.element.extend({
      evidence: z.array(GroundedParagraphEvidenceSchema).min(1).max(5),
    }),
  ),
  relationshipCandidates: z.array(
    SettlementSchema.shape.relationshipCandidates.element.extend({
      evidence: z.array(GroundedParagraphEvidenceSchema).min(1).max(5),
    }),
  ),
  foreshadowCandidates: z.array(
    SettlementSchema.shape.foreshadowCandidates.element.extend({
      evidence: z.array(GroundedParagraphEvidenceSchema).min(1).max(5),
    }),
  ),
});
export type GroundedSettlement = z.infer<typeof GroundedSettlementSchema>;

export const SCENE_PLAN_CONTRACT: JsonSchemaContract = {
  name: "chapter_scene_plan",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["chapterGoal", "povEntityId", "scenes", "continuityRisks"],
    properties: {
      chapterGoal: { type: "string" },
      povEntityId: { type: ["string", "null"] },
      continuityRisks: { type: "array", items: { type: "string" } },
      scenes: {
        type: "array",
        minItems: 1,
        maxItems: 12,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "title",
            "goal",
            "conflict",
            "turn",
            "outcome",
            "locationId",
            "participants",
            "targetCharacters",
          ],
          properties: {
            title: { type: "string" },
            goal: { type: "string" },
            conflict: { type: "string" },
            turn: { type: "string" },
            outcome: { type: "string" },
            locationId: { type: ["string", "null"] },
            participants: { type: "array", items: { type: "string" } },
            targetCharacters: { type: "integer", minimum: 200, maximum: 20000 },
          },
        },
      },
    },
  },
};

export const REVIEW_CONTRACT: JsonSchemaContract = {
  name: "evidence_grounded_chapter_review",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["summary", "scores", "issues"],
    properties: {
      summary: { type: "string" },
      scores: {
        type: "object",
        additionalProperties: false,
        required: ["continuity", "pacing", "character", "prose", "goal"],
        properties: Object.fromEntries(
          ["continuity", "pacing", "character", "prose", "goal"].map((name) => [
            name,
            { type: "number", minimum: 0, maximum: 100 },
          ]),
        ),
      },
      issues: {
        type: "array",
        maxItems: 30,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "category",
            "severity",
            "message",
            "evidenceParagraphs",
            "suggestedDirection",
            "requiresAuthorDecision",
          ],
          properties: {
            category: {
              type: "string",
              enum: [
                "continuity",
                "canon",
                "pov",
                "character",
                "agency",
                "causality",
                "pacing",
                "information",
                "prose",
                "style",
                "foreshadow",
                "goal",
                "safety",
              ],
            },
            severity: {
              type: "string",
              enum: ["info", "minor", "major", "critical"],
            },
            message: { type: "string" },
            evidenceParagraphs: {
              type: "array",
              minItems: 1,
              maxItems: 5,
              uniqueItems: true,
              items: { type: "integer", minimum: 1 },
            },
            suggestedDirection: { type: ["string", "null"] },
            requiresAuthorDecision: { type: "boolean" },
          },
        },
      },
    },
  },
};

export const SETTLEMENT_CONTRACT: JsonSchemaContract = {
  name: "chapter_settlement_candidates",
  description:
    "从章节正文提取带证据的候选变化。事实的实体宾语与普通值互斥，复杂语义应拆成多条事实。",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "summaryPoints",
      "stateDelta",
      "factCandidates",
      "timelineCandidates",
      "relationshipCandidates",
      "foreshadowCandidates",
    ],
    properties: {
      summaryPoints: z.toJSONSchema(z.array(SummaryPointSchema).min(1).max(20)),
      stateDelta: {
        type: "array",
        maxItems: 100,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["key", "before", "after", "evidenceParagraphs"],
          properties: {
            key: { type: "string" },
            before: { type: ["string", "null"] },
            after: { type: "string" },
            evidenceParagraphs: evidenceParagraphContract(),
          },
        },
      },
      factCandidates: {
        type: "array",
        maxItems: 100,
        items: factCandidateContract(),
      },
      timelineCandidates: {
        type: "array",
        maxItems: 50,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "title",
            "description",
            "storyTime",
            "participantIds",
            "causeEventIds",
            "visibility",
            "knownBy",
            "evidenceParagraphs",
          ],
          properties: {
            title: { type: "string" },
            description: { type: ["string", "null"] },
            storyTime: { type: ["string", "null"] },
            participantIds: { type: "array", items: { type: "string" } },
            causeEventIds: { type: "array", items: { type: "string" } },
            visibility: {
              type: "string",
              enum: ["omniscient", "reader", "author_secret"],
            },
            knownBy: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["entityId", "belief"],
                properties: {
                  entityId: { type: "string" },
                  belief: {
                    type: "string",
                    enum: ["known", "believed", "suspected", "false_belief"],
                  },
                },
              },
            },
            evidenceParagraphs: evidenceParagraphContract(),
          },
        },
      },
      relationshipCandidates: {
        type: "array",
        maxItems: 50,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "action",
            "relationshipId",
            "fromEntityId",
            "toEntityId",
            "relation",
            "change",
            "evidenceParagraphs",
          ],
          properties: {
            action: {
              type: "string",
              enum: ["start", "update", "end"],
            },
            relationshipId: { type: ["string", "null"] },
            fromEntityId: { type: "string" },
            toEntityId: { type: "string" },
            relation: { type: "string" },
            change: { type: "string" },
            evidenceParagraphs: evidenceParagraphContract(),
          },
        },
      },
      foreshadowCandidates: {
        type: "array",
        maxItems: 50,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "foreshadowId",
            "title",
            "action",
            "expectedStatus",
            "importance",
            "targetFromNodeId",
            "targetToNodeId",
            "evidenceParagraphs",
          ],
          properties: {
            foreshadowId: { type: ["string", "null"] },
            title: { type: "string" },
            action: {
              type: "string",
              enum: ["plant", "develop", "resolve"],
            },
            expectedStatus: {
              type: ["string", "null"],
              description:
                "该伏笔当前所处的状态（乐观并发检查用，非目标状态；新状态由 action 决定）",
              enum: [
                "planned",
                "planted",
                "developing",
                "resolved",
                "abandoned",
                null,
              ],
            },
            importance: { type: "integer", minimum: 1, maximum: 5 },
            targetFromNodeId: { type: ["string", "null"] },
            targetToNodeId: { type: ["string", "null"] },
            evidenceParagraphs: evidenceParagraphContract(),
          },
        },
      },
    },
  },
};

function factCandidateContract(): Record<string, unknown> {
  const required = [
    "operation",
    "factId",
    "subjectId",
    "predicate",
    "objectEntityId",
    "value",
    "knowledgeScope",
    "knowledgeSubjectId",
    "belief",
    "evidenceParagraphs",
  ];
  const commonProperties = {
    factId: { type: ["string", "null"] },
    subjectId: { type: "string" },
    predicate: { type: "string" },
    knowledgeScope: {
      type: "string",
      enum: ["omniscient", "reader", "character", "author_secret"],
    },
    knowledgeSubjectId: { type: ["string", "null"] },
    belief: {
      type: "string",
      enum: ["known", "believed", "suspected", "false_belief"],
    },
    evidenceParagraphs: evidenceParagraphContract(),
  };
  const branch = (
    operations: readonly string[],
    objectEntityId: Record<string, unknown>,
    value: Record<string, unknown>,
  ): Record<string, unknown> => ({
    type: "object",
    additionalProperties: false,
    required,
    properties: {
      operation: { type: "string", enum: operations },
      ...commonProperties,
      objectEntityId,
      value,
    },
  });
  return {
    anyOf: [
      branch(
        ["assert", "supersede"],
        {
          type: "string",
          description: "实体宾语 ID；使用该字段时 value 必须为 null。",
        },
        { type: "null" },
      ),
      branch(
        ["assert", "supersede"],
        { type: "null" },
        {
          type: ["string", "number", "boolean"],
          description:
            "普通标量宾语；使用该字段时 objectEntityId 必须为 null。不要额外填写布尔值或字符串 true 表示事实成立。",
        },
      ),
      branch(
        ["withdraw"],
        {
          type: "null",
          description: "withdraw 通过 factId 指定目标事实，不提供宾语。",
        },
        {
          type: "null",
          description: "withdraw 通过 factId 指定目标事实，不提供宾语。",
        },
      ),
    ],
  };
}

function evidenceParagraphContract(): Record<string, unknown> {
  return {
    type: "array",
    minItems: 1,
    maxItems: 5,
    uniqueItems: true,
    items: { type: "integer", minimum: 1 },
  };
}

export function zodValidator<T>(
  schema: z.ZodType<T>,
  semantic?: (value: T) => readonly string[],
): StructuredValidator<T> {
  return (value) => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      return {
        success: false,
        issues: parsed.error.issues.map(
          (issue) => `${issue.path.join(".")}: ${issue.message}`,
        ),
      };
    }
    const issues = semantic?.(parsed.data) ?? [];
    return issues.length
      ? { success: false, issues }
      : { success: true, data: parsed.data };
  };
}
