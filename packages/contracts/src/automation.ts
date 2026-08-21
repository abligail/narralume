import { z } from "zod";

import {
  EffectivePolicySchema,
  ModelExecutionPolicySchema,
} from "./execution-policy.js";
import {
  BackgroundRunCreatedSchema,
  NarrativeRunSchema,
  RunModeSchema,
  RunOriginSchema,
} from "./run.js";
import { CreateProjectRequestSchema, ProjectSchema } from "./story.js";

const IdSchema = z.string().trim().min(1).max(300);
const TimestampSchema = z.string().min(1);
const JsonObjectSchema = z.record(z.string(), z.unknown());

export const AUTOMATION_LIMITS = {
  targetChapters: 500,
  planningWindow: 20,
  volumes: 20,
  revisionCycles: 5,
} as const;

export const AUTOMATION_DEFAULTS = {
  targetChapters: 12,
  wordsPerChapter: 3_000,
  volumes: 1,
} as const;

export const StoryCompassSchema = z.object({
  projectId: IdSchema,
  corePromise: z.string(),
  endingDirection: z.string().nullable(),
  longLines: z.array(
    z.object({ title: z.string(), promise: z.string(), status: z.string() }),
  ),
  themeQuestions: z.array(z.string()),
  target: z.object({
    chapters: z.number().int().positive(),
    wordsPerChapter: z.number().int().positive(),
    volumes: z.number().int().positive(),
  }),
  constraints: z.array(z.string()),
  version: z.number().int().positive(),
  updatedAt: TimestampSchema,
});

export const GenerateFoundationRequestSchema = z
  .object({
    requestId: IdSchema,
    braindump: z
      .string()
      .trim()
      .min(1, "Premise and braindump must not be empty"),
    policy: ModelExecutionPolicySchema.optional(),
    preferences: z
      .object({
        genre: z.string().trim().max(200).nullable().default(null),
        audience: z.string().trim().max(200).nullable().default(null),
        tone: z.string().trim().max(500).nullable().default(null),
        targetChapters: z
          .number()
          .int()
          .min(1)
          .max(AUTOMATION_LIMITS.targetChapters)
          .default(AUTOMATION_DEFAULTS.targetChapters),
        wordsPerChapter: z
          .number()
          .int()
          .positive()
          .default(AUTOMATION_DEFAULTS.wordsPerChapter),
        volumes: z
          .number()
          .int()
          .min(1)
          .max(AUTOMATION_LIMITS.volumes)
          .default(AUTOMATION_DEFAULTS.volumes),
      })
      .default({
        genre: null,
        audience: null,
        tone: null,
        ...AUTOMATION_DEFAULTS,
      }),
  })
  .strict();

export const CreateProjectWithFoundationRequestSchema =
  CreateProjectRequestSchema.extend({
    requestId: IdSchema,
    braindump: GenerateFoundationRequestSchema.shape.braindump,
    policy: GenerateFoundationRequestSchema.shape.policy,
    preferences: GenerateFoundationRequestSchema.shape.preferences,
  }).strict();

export const ProjectFoundationTaskCreatedSchema = z.object({
  project: ProjectSchema,
  task: BackgroundRunCreatedSchema,
  idempotentReplay: z.boolean(),
});

export const FoundationCandidateSchema = z.object({
  id: IdSchema,
  setId: IdSchema,
  projectId: IdSchema,
  kind: z.enum(["intent", "compass", "entity"]),
  label: z.string(),
  payload: JsonObjectSchema,
  editedPayload: JsonObjectSchema.nullable(),
  status: z.enum(["pending", "adopted", "discarded"]),
  adoptedRefType: z.string().nullable(),
  adoptedRefId: z.string().nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export const FoundationCandidateSetSchema = z.object({
  set: z.object({
    id: IdSchema,
    projectId: IdSchema,
    sourceRunId: IdSchema,
    title: z.string(),
    status: z.enum(["open", "partially_adopted", "adopted", "discarded"]),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  }),
  candidates: z.array(FoundationCandidateSchema),
});

export const CandidateActionRequestSchema = z.object({
  action: z.enum(["adopt", "discard"]),
  payload: JsonObjectSchema.optional(),
});

export const CandidateSetActionRequestSchema = z.object({
  action: z.enum(["adopt-all", "discard-all"]),
});

export const UpdateCompassRequestSchema = StoryCompassSchema.omit({
  projectId: true,
  version: true,
  updatedAt: true,
});

export const PutCompassRequestSchema = UpdateCompassRequestSchema.extend({
  /** null 断言作品中尚无故事指南针。 */
  expectedVersion: z.number().int().positive().nullable(),
});

export const AutopilotSessionStatusSchema = z.enum([
  "pending",
  "planning",
  "running",
  "paused",
  "awaiting_user",
  "failed",
  "cancelled",
  "completed",
]);

export const AutopilotSessionSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  mode: RunModeSchema.extract(["autopilot", "chapter-gate"]),
  approvalMode: z.enum(["continuous", "per_chapter"]),
  origin: RunOriginSchema.nullable(),
  status: AutopilotSessionStatusSchema,
  targetChapters: z.number().int().positive(),
  windowSize: z.number().int().positive(),
  maxRevisionCycles: z.number().int().min(0).max(5),
  // Fully-resolved effective policy persisted at session creation
  // (resolveEffectivePolicy); responses never return the raw partial input.
  chapterPolicy: EffectivePolicySchema,
  currentRunId: IdSchema.nullable(),
  currentOutlineNodeId: IdSchema.nullable(),
  completedChapters: z.number().int().nonnegative(),
  skippedChapters: z.number().int().nonnegative(),
  pauseRequested: z.boolean(),
  cancelRequested: z.boolean(),
  replanRequested: z.boolean(),
  activeNotes: z.array(z.string()),
  lastError: JsonObjectSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  finishedAt: TimestampSchema.nullable(),
  version: z.number().int().nonnegative(),
});

export const CreateAutopilotSessionRequestSchema = z
  .object({
    requestId: IdSchema,
    approvalMode: z.enum(["continuous", "per_chapter"]).default("continuous"),
    planningMode: z.enum(["auto", "confirm"]).default("auto"),
    origin: RunOriginSchema.nullable().default(null),
    targetChapters: z
      .number()
      .int()
      .min(1)
      .max(AUTOMATION_LIMITS.targetChapters)
      .default(5),
    windowSize: z
      .number()
      .int()
      .min(1)
      .max(AUTOMATION_LIMITS.planningWindow)
      .default(5),
    maxRevisionCycles: z
      .number()
      .int()
      .min(0)
      .max(AUTOMATION_LIMITS.revisionCycles)
      .default(2),
    chapterPolicy: ModelExecutionPolicySchema.default({}),
  })
  .strict();

export const AutopilotSessionCreatedSchema = AutopilotSessionSchema.extend({
  idempotentReplay: z.boolean(),
});

export const AutopilotRunLinkSchema = z.object({
  sessionId: IdSchema,
  runId: IdSchema,
  role: z.enum(["rolling-plan", "chapter", "closing-review"]),
  outlineNodeId: IdSchema.nullable(),
  sequence: z.number().int().nonnegative(),
  createdAt: TimestampSchema,
  processedAt: TimestampSchema.nullable(),
  outcome: z.string().nullable(),
});

export const StorySteerSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  sessionId: IdSchema.nullable(),
  targetRunId: IdSchema.nullable(),
  content: z.string(),
  classification: z
    .enum([
      "immediate_current",
      "next_scene",
      "future_plan",
      "canon_change",
      "rewrite_existing",
      "temporary_director_note",
    ])
    .nullable(),
  status: z.enum([
    "pending",
    "classifying",
    "classified",
    "applied",
    "awaiting_confirmation",
    "rejected",
  ]),
  effectiveBoundary: z.enum([
    "immediate",
    "next_scene",
    "next_chapter",
    "future",
  ]),
  rationale: z.string().nullable(),
  risk: z.enum(["low", "medium", "high"]).nullable(),
  classificationRunId: IdSchema.nullable(),
  appliedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export const CreateSteerRequestSchema = z.object({
  requestId: IdSchema,
  content: z.string().trim().min(1).max(20_000),
});

export const SteerDecisionRequestSchema = z
  .object({
    action: z.enum(["apply", "reject"]),
  })
  .strict();

export const SessionActionRequestSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.enum(["pause", "resume", "cancel"]),
    })
    .strict(),
  z
    .object({
      action: z.enum(["accept_plan", "accept_manuscript"]),
      requestId: IdSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("request_revision"),
      requestId: IdSchema,
      instruction: z
        .string()
        .trim()
        .min(1)
        .max(20_000)
        .default("请在保持既有优点的前提下，重新修订并提升这一版正文。"),
    })
    .strict(),
]);

export const SessionResolutionRequestSchema = z.object({
  action: z.enum(["retry-current", "skip-chapter", "replan", "stop"]),
});

export const PlanningReviewSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  sessionId: IdSchema,
  runId: IdSchema,
  scopeType: z.enum(["arc", "volume"]),
  outlineNodeId: IdSchema,
  summary: z.string(),
  scores: z.record(z.string(), z.number()),
  recommendations: z.array(z.string()),
  sourceHash: z.string(),
  createdAt: TimestampSchema,
});

export const AutopilotSessionDetailSchema = z.object({
  session: AutopilotSessionSchema,
  links: z.array(AutopilotRunLinkSchema),
  runs: z.array(NarrativeRunSchema),
  steers: z.array(StorySteerSchema),
  reviews: z.array(PlanningReviewSchema),
  origin: RunOriginSchema.nullable(),
  approvalMode: z.enum(["continuous", "per_chapter"]),
  currentChapter: z
    .object({ id: IdSchema, title: z.string(), runId: IdSchema.nullable() })
    .nullable(),
  stopReason: z.string().nullable(),
  availableActions: z.array(
    z.enum([
      "pause",
      "resume",
      "cancel",
      "accept_plan",
      "accept_manuscript",
      "request_revision",
      "retry-current",
      "skip-chapter",
      "replan",
      "stop",
    ]),
  ),
});

export type StoryCompassDto = z.infer<typeof StoryCompassSchema>;
export type FoundationCandidateSetDto = z.infer<
  typeof FoundationCandidateSetSchema
>;
export type AutopilotSessionDto = z.infer<typeof AutopilotSessionSchema>;
export type AutopilotSessionDetailDto = z.infer<
  typeof AutopilotSessionDetailSchema
>;
export type StorySteerDto = z.infer<typeof StorySteerSchema>;
