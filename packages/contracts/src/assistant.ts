import { z } from "zod";

import {
  AgentSkillSchema as AgentSkillDtoSchema,
  ImportedAgentSkillSchema,
} from "./agent-skills.js";

const IdSchema = z.string().trim().min(1).max(300);
const TimestampSchema = z.string().min(1);
const JsonObjectSchema = z.record(z.string(), z.unknown());

export const AssistantCanonSpreadSchema = z.enum([
  "intent",
  "outline",
  "entities",
  "facts",
  "relations",
  "timeline",
  "foreshadows",
]);

export const AssistantContextSchema = z
  .object({
    surface: z.string().trim().min(1).max(100),
    documentId: IdSchema.nullable().default(null),
    outlineNodeId: IdSchema.nullable().default(null),
    canonSpread: AssistantCanonSpreadSchema.nullable().default(null),
    selection: z
      .object({
        start: z.number().int().nonnegative(),
        end: z.number().int().nonnegative(),
        text: z.string().max(40_000).nullable().default(null),
      })
      .nullable()
      .default(null),
  })
  .strict();
export type AssistantContext = z.infer<typeof AssistantContextSchema>;

/** 思考档位：off=不发送参数让模型自决，low 为助手默认。 */
export const AssistantReasoningEffortSchema = z.enum([
  "off",
  "low",
  "medium",
  "high",
]);
export type AssistantReasoningEffort = z.infer<
  typeof AssistantReasoningEffortSchema
>;

export const AssistantConversationSettingsSchema = z
  .object({
    /** 覆盖对话所用模型（models.id）；null=跟随全局 writing 分配。 */
    modelId: IdSchema.nullable(),
    reasoningEffort: AssistantReasoningEffortSchema.nullable(),
  })
  .strict();
export type AssistantConversationSettings = z.infer<
  typeof AssistantConversationSettingsSchema
>;

export const AssistantConversationSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  title: z.string().min(1).max(200),
  status: z.enum(["active", "archived"]),
  /** 对话级模型与思考档；字段为 null 表示跟随全局默认。 */
  settings: AssistantConversationSettingsSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type AssistantConversationDto = z.infer<
  typeof AssistantConversationSchema
>;

export const AssistantMessageSchema = z.object({
  id: IdSchema,
  conversationId: IdSchema,
  role: z.enum(["user", "assistant", "system"]),
  content: z.string().min(1).max(100_000),
  context: AssistantContextSchema.nullable(),
  sourceRunId: IdSchema.nullable(),
  replyToMessageId: IdSchema.nullable(),
  createdAt: TimestampSchema,
});
export type AssistantMessageDto = z.infer<typeof AssistantMessageSchema>;

export const AssistantToolNameSchema = z.enum([
  "story.inspect",
  "review.inspect",
  "foundation.start",
  "chapter.start",
  "autopilot.start",
  "outline.plan.start",
  "canon.candidate.start",
  "selection.edit.start",
  "long_goal.start",
  "task.control",
]);
export type AssistantToolName = z.infer<typeof AssistantToolNameSchema>;

export const AssistantToolCallSchema = z.discriminatedUnion("name", [
  z.object({
    name: z.literal("story.inspect"),
    arguments: z.object({}).strict(),
  }),
  z.object({
    name: z.literal("review.inspect"),
    arguments: z.object({}).strict(),
  }),
  z.object({
    name: z.literal("foundation.start"),
    arguments: z
      .object({
        braindump: z.string().trim().min(1).max(100_000),
      })
      .strict(),
  }),
  z.object({
    name: z.literal("chapter.start"),
    arguments: z.object({ targetOutlineNodeId: IdSchema }).strict(),
  }),
  z.object({
    name: z.literal("autopilot.start"),
    arguments: z
      .object({
        targetChapters: z.number().int().min(1).max(50),
        approvalMode: z.enum(["continuous", "per_chapter"]),
      })
      .strict(),
  }),
  z.object({
    name: z.literal("outline.plan.start"),
    arguments: z
      .object({
        targetChapters: z.number().int().min(1).max(20),
      })
      .strict(),
  }),
  z.object({
    name: z.literal("canon.candidate.start"),
    arguments: z
      .object({
        spread: AssistantCanonSpreadSchema,
        instruction: z.string().trim().min(1).max(20_000),
      })
      .strict(),
  }),
  z.object({
    name: z.literal("selection.edit.start"),
    arguments: z
      .object({
        documentId: IdSchema,
        selectionStart: z.number().int().nonnegative(),
        selectionEnd: z.number().int().nonnegative(),
        instruction: z.string().trim().min(1).max(20_000),
      })
      .strict(),
  }),
  z.object({
    name: z.literal("long_goal.start"),
    arguments: z
      .object({
        targetChapters: z.number().int().min(1).max(50),
        braindump: z
          .string()
          .trim()
          .min(1)
          .max(100_000)
          .nullable()
          .default(null),
      })
      .strict(),
  }),
  z.object({
    name: z.literal("task.control"),
    arguments: z
      .object({
        sourceType: z.enum(["run", "autopilot"]),
        sourceId: IdSchema,
        action: z.enum([
          "pause",
          "resume",
          "cancel",
          "retry-current",
          "skip-chapter",
          "replan",
          "stop",
        ]),
      })
      .strict(),
  }),
]);
export type AssistantToolCall = z.infer<typeof AssistantToolCallSchema>;

export const AssistantToolDescriptorSchema = z.object({
  name: AssistantToolNameSchema,
  label: z.string(),
  description: z.string(),
  access: z.enum(["read", "auto", "confirm"]),
});
export type AssistantToolDescriptorDto = z.infer<
  typeof AssistantToolDescriptorSchema
>;

export const AssistantActivityArtifactSchema = z.object({
  kind: z.string().trim().min(1).max(100),
  id: IdSchema,
  label: z.string().min(1).max(200),
});
export type AssistantActivityArtifactDto = z.infer<
  typeof AssistantActivityArtifactSchema
>;

export const AssistantActivityErrorSchema = z.object({
  code: z.string().min(1).max(200),
  message: z.string().min(1).max(2_000),
});

export const AssistantActivitySchema = z.object({
  id: IdSchema,
  conversationId: IdSchema.nullable(),
  kind: z.enum(["assistant_response", "task", "tool", "long_goal"]),
  layer: z.enum(["primary", "local", "assistant"]),
  status: z.enum([
    "proposed",
    "queued",
    "running",
    "waiting",
    "completed",
    "failed",
    "cancelled",
    "rejected",
  ]),
  goal: z.string(),
  stage: z.string(),
  summary: z.string().nullable(),
  /** 停泊/等待原因的机器码（如 chapter_commit_approval_required），
   *  展示文案由前端标签表统一渲染，服务端不再各自维护中文措辞。 */
  waitingReason: z.string().nullable(),
  availableActions: z.array(z.string()),
  sourceType: z.enum(["run", "autopilot", "assistant_tool", "long_goal"]),
  sourceId: IdSchema,
  origin: AssistantContextSchema.nullable(),
  result: JsonObjectSchema.nullable(),
  toolCall: AssistantToolCallSchema.nullable(),
  skillId: z.string().trim().min(1).max(300).nullable().default(null),
  skillLabel: z.string().max(200).nullable().default(null),
  phaseKey: z.string().trim().min(1).max(100).nullable().default(null),
  artifacts: z.array(AssistantActivityArtifactSchema).default([]),
  lastError: AssistantActivityErrorSchema.nullable().default(null),
  linkedSources: z
    .array(
      z.object({
        type: z.enum(["run", "autopilot", "long_goal"]),
        id: IdSchema,
      }),
    )
    .default([]),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type AssistantActivityDto = z.infer<typeof AssistantActivitySchema>;

export const AssistantConversationDetailSchema = z.object({
  conversation: AssistantConversationSchema,
  messages: z.array(AssistantMessageSchema),
  activities: z.array(AssistantActivitySchema),
  tools: z.array(AssistantToolDescriptorSchema),
  skills: z.array(AgentSkillDtoSchema).default([]),
  importedSkills: z.array(ImportedAgentSkillSchema).default([]),
});
export type AssistantConversationDetailDto = z.infer<
  typeof AssistantConversationDetailSchema
>;

export const CreateAssistantConversationRequestSchema = z
  .object({
    requestId: IdSchema,
    title: z.string().trim().min(1).max(200).default("项目协作"),
  })
  .strict();
export type CreateAssistantConversationRequest = z.infer<
  typeof CreateAssistantConversationRequestSchema
>;

export const ArchiveAssistantConversationRequestSchema = z
  .object({ action: z.literal("archive") })
  .strict();

export const RenameAssistantConversationRequestSchema = z
  .object({
    action: z.literal("rename"),
    title: z.string().trim().min(1).max(200),
  })
  .strict();
export type RenameAssistantConversationRequest = z.infer<
  typeof RenameAssistantConversationRequestSchema
>;

/** 至少携带一项要修改的设置；modelId=null 表示清除覆盖、回到全局默认。 */
export const ConfigureAssistantConversationRequestSchema = z
  .object({
    action: z.literal("configure"),
    modelId: IdSchema.nullable().optional(),
    reasoningEffort: AssistantReasoningEffortSchema.nullable().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.modelId !== undefined || value.reasoningEffort !== undefined,
    { message: "Provide a new model or reasoning effort" },
  );
export type ConfigureAssistantConversationRequest = z.infer<
  typeof ConfigureAssistantConversationRequestSchema
>;

/** 对话动作端点的联合请求体：归档、重命名或调整模型/思考档。 */
export const AssistantConversationActionRequestSchema = z.union([
  ArchiveAssistantConversationRequestSchema,
  RenameAssistantConversationRequestSchema,
  ConfigureAssistantConversationRequestSchema,
]);
export type AssistantConversationActionRequest = z.infer<
  typeof AssistantConversationActionRequestSchema
>;

export const CreateAssistantMessageRequestSchema = z
  .object({
    requestId: IdSchema,
    content: z.string().trim().min(1).max(100_000),
    context: AssistantContextSchema,
  })
  .strict();
export type CreateAssistantMessageRequest = z.infer<
  typeof CreateAssistantMessageRequestSchema
>;

export const AssistantMessageAcceptedSchema = z.object({
  message: AssistantMessageSchema,
  runId: IdSchema,
  idempotentReplay: z.boolean(),
});
export type AssistantMessageAcceptedDto = z.infer<
  typeof AssistantMessageAcceptedSchema
>;

export const AssistantActivityActionRequestSchema = z
  .object({
    action: z.enum(["confirm", "reject", "retry", "resume", "cancel"]),
  })
  .strict();

export const AssistantActivityActionResponseSchema = z.object({
  activity: AssistantActivitySchema,
  source: z
    .object({ type: z.enum(["run", "autopilot", "long_goal"]), id: IdSchema })
    .nullable(),
});
export type AssistantActivityActionResponseDto = z.infer<
  typeof AssistantActivityActionResponseSchema
>;
