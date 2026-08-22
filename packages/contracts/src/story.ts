import { z } from "zod";

const IdSchema = z.string().trim().min(1).max(200);
const TimestampSchema = z.string().min(1);
const JsonObjectSchema = z.record(z.string(), z.unknown());

export const ProjectPhaseSchema = z.enum([
  "idea",
  "foundation",
  "outlining",
  "writing",
  "revising",
  "complete",
]);

/** 作品创作语言：决定 AI 指令与产出的语言，与界面语言无关。 */
export const ProjectLanguageSchema = z.enum(["zh-CN", "en"]);
export type ProjectLanguage = z.infer<typeof ProjectLanguageSchema>;

export const ProjectSchema = z.object({
  id: IdSchema,
  title: z.string(),
  subtitle: z.string().nullable(),
  premise: z.string().nullable(),
  language: ProjectLanguageSchema,
  phase: ProjectPhaseSchema,
  archivedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type ProjectDto = z.infer<typeof ProjectSchema>;

export const ProjectCoverCropSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  zoom: z.number().min(1).max(3),
});

export const ProjectCoverSchema = z.object({
  projectId: IdSchema,
  mediaType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  byteSize: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  crop: ProjectCoverCropSchema,
  updatedAt: TimestampSchema,
});
export type ProjectCoverDto = z.infer<typeof ProjectCoverSchema>;

export const ProjectShelfItemSchema = ProjectSchema.extend({
  lastWritingAt: TimestampSchema.nullable(),
  wordCount: z.number().int().nonnegative(),
  committedChapters: z.number().int().nonnegative(),
  totalChapters: z.number().int().nonnegative(),
  cover: ProjectCoverSchema.nullable(),
});

export const RecycledProjectSchema = ProjectSchema.extend({
  deletedAt: TimestampSchema,
  deletionToken: z.string().uuid(),
  deleteAfter: TimestampSchema,
});
export type RecycledProjectDto = z.infer<typeof RecycledProjectSchema>;

export const RestoreProjectRequestSchema = z.object({
  deletionToken: z.string().uuid(),
});

export const PurgeProjectRequestSchema = RestoreProjectRequestSchema.extend({
  confirmationTitle: z.string().trim().min(1).max(200),
});

export const CreateProjectRequestSchema = z.object({
  requestId: IdSchema,
  title: z.string().trim().min(1).max(200),
  subtitle: z.string().trim().max(300).nullable().optional(),
  premise: z.string().trim().max(10_000).nullable().optional(),
  language: ProjectLanguageSchema.default("zh-CN"),
});
/**
 * 封面变更与书籍资料保存在同一个请求里提交，服务端在同一事务中应用，
 * 避免“封面已改、资料 409”的半提交（CR-83）。
 */
export const ProjectCoverMutationSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("put"),
    mediaType: z.enum(["image/jpeg", "image/png", "image/webp"]),
    imageBase64: z.string().min(4).max(11_200_000),
    width: z.number().int().min(1).max(12_000),
    height: z.number().int().min(1).max(12_000),
    crop: ProjectCoverCropSchema,
  }),
  z.object({
    action: z.literal("crop"),
    crop: ProjectCoverCropSchema,
  }),
  z.object({ action: z.literal("remove") }),
]);
export type ProjectCoverMutation = z.infer<typeof ProjectCoverMutationSchema>;

export const UpdateProjectRequestSchema = z.object({
  title: z.string().trim().min(1).max(200),
  subtitle: z.string().trim().max(300).nullable(),
  premise: z.string().trim().max(10_000).nullable(),
  language: ProjectLanguageSchema.optional(),
  archived: z.boolean(),
  expectedUpdatedAt: TimestampSchema,
  cover: ProjectCoverMutationSchema.optional(),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;

export const AuthorIntentSchema = z.object({
  projectId: IdSchema,
  promise: z.string().nullable(),
  themes: z.array(z.string()),
  audience: z.string().nullable(),
  tone: z.string().nullable(),
  boundaries: z.array(z.string()),
  endingDirection: z.string().nullable(),
  currentFocus: z.string().nullable(),
  lockedFields: z.array(z.string()),
  updatedAt: TimestampSchema,
});
export type AuthorIntentDto = z.infer<typeof AuthorIntentSchema>;

export const UpdateAuthorIntentRequestSchema = AuthorIntentSchema.omit({
  projectId: true,
  updatedAt: true,
})
  .partial()
  .extend({
    /** null 断言作品中尚无作者意图记录。 */
    expectedUpdatedAt: TimestampSchema.nullable(),
  });

export const OutlineKindSchema = z.enum([
  "book",
  "volume",
  "arc",
  "chapter",
  "scene",
  "beat",
]);
export const OutlineStatusSchema = z.enum([
  "planned",
  "drafting",
  "review",
  "committed",
  "abandoned",
]);

const ProjectOverviewChapterSchema = z.object({
  outlineNodeId: IdSchema,
  title: z.string(),
  status: OutlineStatusSchema,
  documentId: IdSchema.nullable(),
  documentVersionId: IdSchema.nullable(),
});

export const ProjectOverviewSchema = z.object({
  project: ProjectSchema,
  progress: z.object({
    lastWritingAt: TimestampSchema.nullable(),
    wordCount: z.number().int().nonnegative(),
    committedChapters: z.number().int().nonnegative(),
    totalChapters: z.number().int().nonnegative(),
  }),
  currentChapter: ProjectOverviewChapterSchema.nullable(),
  activeTask: z
    .object({
      kind: z.enum(["quick_creation", "chapter", "foundation"]),
      id: IdSchema,
      status: z.string(),
      targetChapter: ProjectOverviewChapterSchema.nullable(),
      origin: JsonObjectSchema.nullable(),
      stopReason: z.string().nullable(),
      availableActions: z.array(z.string()),
    })
    .nullable(),
  pending: z.object({
    foundationCandidates: z.number().int().nonnegative(),
    reviewIssues: z.number().int().nonnegative(),
    revisionProposals: z.number().int().nonnegative(),
    canonChangeSets: z.number().int().nonnegative(),
    reviewDocumentId: IdSchema.nullable(),
  }),
  nextAction: z.object({
    kind: z.enum([
      "continue_task",
      "review_foundation",
      "resolve_story_changes",
      "review_writing",
      "write_chapter",
      "build_outline",
      "complete",
    ]),
    targetId: IdSchema.nullable(),
  }),
});
export const OutlineNodeSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  parentId: IdSchema.nullable(),
  kind: OutlineKindSchema,
  path: z.string(),
  depth: z.number().int().nonnegative(),
  ordinal: z.number().int().nonnegative(),
  title: z.string(),
  summary: z.string().nullable(),
  goal: z.string().nullable(),
  conflict: z.string().nullable(),
  outcome: z.string().nullable(),
  povEntityId: IdSchema.nullable(),
  storyTime: z.string().nullable(),
  status: OutlineStatusSchema,
  metadata: JsonObjectSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type OutlineNodeDto = z.infer<typeof OutlineNodeSchema>;

export const CreateOutlineNodeRequestSchema = z.object({
  parentId: IdSchema.nullable().default(null),
  kind: OutlineKindSchema,
  ordinal: z.number().int().nonnegative(),
  title: z.string().trim().min(1).max(300),
  summary: z.string().trim().max(20_000).nullable().optional(),
  goal: z.string().trim().max(10_000).nullable().optional(),
  conflict: z.string().trim().max(10_000).nullable().optional(),
  outcome: z.string().trim().max(10_000).nullable().optional(),
  povEntityId: IdSchema.nullable().optional(),
  storyTime: z.string().trim().max(200).nullable().optional(),
  metadata: JsonObjectSchema.default({}),
});
export const UpdateOutlineNodeRequestSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  summary: z.string().trim().max(20_000).nullable().optional(),
  goal: z.string().trim().max(10_000).nullable().optional(),
  conflict: z.string().trim().max(10_000).nullable().optional(),
  outcome: z.string().trim().max(10_000).nullable().optional(),
  povEntityId: IdSchema.nullable().optional(),
  storyTime: z.string().trim().max(200).nullable().optional(),
  status: OutlineStatusSchema.optional(),
  metadata: JsonObjectSchema.optional(),
  expectedUpdatedAt: TimestampSchema,
});

export const CanonEntityTypeSchema = z.enum([
  "character",
  "location",
  "organization",
  "item",
  "rule",
  "concept",
]);
export const CanonEntitySchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  type: CanonEntityTypeSchema,
  name: z.string(),
  aliases: z.array(z.string()),
  description: z.string().nullable(),
  attributes: JsonObjectSchema,
  status: z.enum(["active", "retired"]),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type CanonEntityDto = z.infer<typeof CanonEntitySchema>;

export const CreateCanonEntityRequestSchema = z.object({
  type: CanonEntityTypeSchema,
  name: z.string().trim().min(1).max(300),
  aliases: z.array(z.string().trim().min(1).max(300)).max(100).default([]),
  description: z.string().trim().max(30_000).nullable().optional(),
  attributes: JsonObjectSchema.default({}),
});
export const UpdateCanonEntityRequestSchema = z.object({
  name: z.string().trim().min(1).max(300),
  aliases: z.array(z.string().trim().min(1).max(300)).max(100),
  description: z.string().trim().max(30_000).nullable(),
  attributes: JsonObjectSchema,
  status: z.enum(["active", "retired"]),
  expectedUpdatedAt: TimestampSchema,
});

export const CanonAuthoritySchema = z.enum([
  "candidate",
  "inferred",
  "confirmed",
  "locked",
]);
export const KnowledgeScopeSchema = z.enum([
  "omniscient",
  "reader",
  "character",
  "author_secret",
]);
export const CanonFactSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  subjectId: IdSchema,
  predicate: z.string(),
  objectEntityId: IdSchema.nullable(),
  value: z.unknown(),
  validFromNodeId: IdSchema.nullable(),
  validToNodeId: IdSchema.nullable(),
  knowledgeScope: KnowledgeScopeSchema,
  knowledgeSubjectId: IdSchema.nullable(),
  authority: CanonAuthoritySchema,
  confidence: z.number().min(0).max(1),
  sourceType: z.string(),
  sourceId: IdSchema.nullable(),
  supersedesFactId: IdSchema.nullable(),
  createdAt: TimestampSchema,
});
export type CanonFactDto = z.infer<typeof CanonFactSchema>;

export const CanonFactWithdrawalSchema = z.object({
  factId: IdSchema,
  projectId: IdSchema,
  reason: z.string(),
  withdrawnAt: TimestampSchema,
});
export type CanonFactWithdrawalDto = z.infer<typeof CanonFactWithdrawalSchema>;

export const CreateCanonFactRequestSchema = z
  .object({
    subjectId: IdSchema,
    predicate: z.string().trim().min(1).max(300),
    objectEntityId: IdSchema.nullable().optional(),
    value: z.unknown().optional(),
    validFromNodeId: IdSchema.nullable().optional(),
    validToNodeId: IdSchema.nullable().optional(),
    knowledgeScope: KnowledgeScopeSchema.default("omniscient"),
    knowledgeSubjectId: IdSchema.nullable().optional(),
    authority: CanonAuthoritySchema.default("candidate"),
    confidence: z.number().min(0).max(1).optional(),
    sourceType: z.string().trim().min(1).max(100).default("manual"),
    sourceId: IdSchema.nullable().optional(),
  })
  .superRefine((value, context) => {
    const hasEntity = Boolean(value.objectEntityId);
    const hasValue = value.value !== undefined;
    if (hasEntity === hasValue) {
      context.addIssue({
        code: "custom",
        message: "Provide exactly one of objectEntityId or value",
      });
    }
  });

export const ReviseCanonFactRequestSchema = z
  .object({
    subjectId: IdSchema,
    predicate: z.string().trim().min(1).max(300),
    objectEntityId: IdSchema.nullable(),
    value: z.unknown().optional(),
    validFromNodeId: IdSchema.nullable(),
    validToNodeId: IdSchema.nullable(),
    knowledgeScope: KnowledgeScopeSchema,
    knowledgeSubjectId: IdSchema.nullable(),
    authority: CanonAuthoritySchema,
    confidence: z.number().min(0).max(1),
    confirmLockedRevision: z.boolean().default(false),
  })
  .superRefine((value, context) => {
    const hasEntity = Boolean(value.objectEntityId);
    const hasValue = value.value !== undefined;
    if (hasEntity === hasValue) {
      context.addIssue({
        code: "custom",
        message: "Provide exactly one of objectEntityId or value",
      });
    }
    if (value.knowledgeScope === "character" && !value.knowledgeSubjectId) {
      context.addIssue({
        code: "custom",
        message: "Character knowledge scope requires a knowledgeSubjectId",
      });
    }
  });

export const WithdrawCanonFactRequestSchema = z.object({
  reason: z.string().trim().min(1).max(2_000),
  confirmLockedWithdrawal: z.boolean().default(false),
});

export const RelationshipEventSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  fromEntityId: IdSchema,
  toEntityId: IdSchema,
  relation: z.string(),
  intensity: z.number().nullable(),
  state: JsonObjectSchema,
  outlineNodeId: IdSchema.nullable(),
  storyTime: z.string().nullable(),
  sourceId: IdSchema.nullable(),
  supersedesEventId: IdSchema.nullable().default(null),
  createdAt: TimestampSchema,
});
export const CreateRelationshipRequestSchema = RelationshipEventSchema.omit({
  id: true,
  projectId: true,
  createdAt: true,
});

export const TimelineEventSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  title: z.string(),
  description: z.string().nullable(),
  outlineNodeId: IdSchema.nullable(),
  storyTimeStart: z.string().nullable(),
  storyTimeEnd: z.string().nullable(),
  sequence: z.number().int(),
  participants: z.array(IdSchema),
  causes: z.array(IdSchema),
  visibility: z.enum(["omniscient", "reader", "author_secret"]),
  sourceId: IdSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export const CreateTimelineEventRequestSchema = TimelineEventSchema.omit({
  id: true,
  projectId: true,
  createdAt: true,
  updatedAt: true,
});
export const UpdateTimelineEventRequestSchema =
  CreateTimelineEventRequestSchema.extend({
    expectedUpdatedAt: TimestampSchema,
  });

export const ForeshadowSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  title: z.string(),
  description: z.string(),
  status: z.enum(["planned", "planted", "developing", "resolved", "abandoned"]),
  importance: z.union([
    z.literal(1),
    z.literal(2),
    z.literal(3),
    z.literal(4),
    z.literal(5),
  ]),
  targetFromNodeId: IdSchema.nullable(),
  targetToNodeId: IdSchema.nullable(),
  dependencies: z.array(IdSchema),
  evidenceNodeIds: z.array(IdSchema),
  resolutionNodeId: IdSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export const CreateForeshadowRequestSchema = ForeshadowSchema.omit({
  id: true,
  projectId: true,
  createdAt: true,
  updatedAt: true,
});
export const UpdateForeshadowRequestSchema =
  CreateForeshadowRequestSchema.extend({
    expectedUpdatedAt: TimestampSchema,
  });

export const DocumentKindSchema = z.enum([
  "manuscript",
  "chapter",
  "scene",
  "outline",
  "synopsis",
  "note",
  "style-sample",
]);
export const DocumentSchema = z.object({
  id: IdSchema,
  projectId: IdSchema,
  kind: DocumentKindSchema,
  title: z.string(),
  outlineNodeId: IdSchema.nullable(),
  currentVersionId: IdSchema.nullable(),
  archivedAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export const DocumentVersionSchema = z.object({
  id: IdSchema,
  documentId: IdSchema,
  parentVersionId: IdSchema.nullable(),
  content: z.string(),
  contentHash: z.string(),
  source: z.string(),
  runId: IdSchema.nullable(),
  createdAt: TimestampSchema,
});
export const CreateDocumentRequestSchema = z.object({
  requestId: IdSchema,
  kind: DocumentKindSchema,
  title: z.string().trim().min(1).max(300),
  outlineNodeId: IdSchema.nullable().default(null),
});
export const AppendDocumentVersionRequestSchema = z.object({
  content: z.string().max(5_000_000),
  source: z.string().trim().min(1).max(100).default("manual"),
  expectedCurrentVersionId: IdSchema.nullable().optional(),
});
export const RestoreDocumentVersionRequestSchema = z.object({
  targetVersionId: IdSchema,
  expectedCurrentVersionId: IdSchema.nullable(),
});

export const RemoveStoryResourceRequestSchema = z.object({
  expectedUpdatedAt: TimestampSchema,
});
export const StoryResourceRemovalSchema = z.object({
  id: IdSchema,
  disposition: z.enum(["deleted", "abandoned", "retired", "voided"]),
  references: z.number().int().nonnegative(),
});
export type StoryResourceRemoval = z.infer<typeof StoryResourceRemovalSchema>;

export const ContextBudgetSchema = z.object({
  contextWindow: z.number().int().positive(),
  outputReserve: z.number().int().nonnegative(),
  fixedInstructionReserve: z.number().int().nonnegative(),
  toolReserve: z.number().int().nonnegative(),
  schemaReserve: z.number().int().nonnegative(),
  safetyReserve: z.number().int().nonnegative().optional(),
});
export const ContextPreviewRequestSchema = z.object({
  purpose: z.string().trim().min(1).max(200).default("preview"),
  task: z.string().trim().min(1).max(30_000),
  query: z.string().trim().max(10_000).default(""),
  entityIds: z.array(IdSchema).max(100).default([]),
  currentOutlineNodeId: IdSchema.nullable().default(null),
  access: z
    .object({
      audience: z.enum(["author", "reader", "character", "omniscient"]),
      characterId: IdSchema.optional(),
      includeCandidates: z.boolean().optional(),
    })
    .default({ audience: "author" }),
  budget: ContextBudgetSchema.default({
    contextWindow: 16_000,
    outputReserve: 4_000,
    fixedInstructionReserve: 1_000,
    toolReserve: 1_000,
    schemaReserve: 500,
  }),
});

export const StoryBibleSnapshotSchema = z.object({
  project: ProjectSchema,
  intent: AuthorIntentSchema.nullable(),
  outline: z.array(OutlineNodeSchema),
  entities: z.array(CanonEntitySchema),
  facts: z.array(CanonFactSchema),
  relationships: z.array(RelationshipEventSchema),
  timeline: z.array(TimelineEventSchema),
  foreshadows: z.array(ForeshadowSchema),
  documents: z.array(DocumentSchema),
  occupiedOutlineNodeIds: z.array(IdSchema),
});
export type StoryBibleSnapshot = z.infer<typeof StoryBibleSnapshotSchema>;
