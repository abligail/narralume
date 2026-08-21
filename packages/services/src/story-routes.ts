import {
  AppendDocumentVersionRequestSchema,
  AuthorIntentSchema,
  CanonEntitySchema,
  CanonFactSchema,
  CanonFactWithdrawalSchema,
  CreateCanonEntityRequestSchema,
  CreateCanonFactRequestSchema,
  CreateDocumentRequestSchema,
  CreateForeshadowRequestSchema,
  CreateOutlineNodeRequestSchema,
  CreateProjectRequestSchema,
  CreateRelationshipRequestSchema,
  CreateTimelineEventRequestSchema,
  DocumentSchema,
  DocumentVersionSchema,
  ForeshadowSchema,
  OutlineNodeSchema,
  ProjectSchema,
  ProjectOverviewSchema,
  ProjectShelfItemSchema,
  PurgeProjectRequestSchema,
  RecycledProjectSchema,
  RelationshipEventSchema,
  RemoveStoryResourceRequestSchema,
  RestoreDocumentVersionRequestSchema,
  RestoreProjectRequestSchema,
  ReviseCanonFactRequestSchema,
  StoryBibleSnapshotSchema,
  StoryResourceRemovalSchema,
  TimelineEventSchema,
  UpdateAuthorIntentRequestSchema,
  UpdateCanonEntityRequestSchema,
  UpdateOutlineNodeRequestSchema,
  UpdateProjectRequestSchema,
  UpdateForeshadowRequestSchema,
  UpdateTimelineEventRequestSchema,
  WithdrawCanonFactRequestSchema,
} from "@narralume/contracts";
import {
  createCanonEntity,
  createCanonFact,
  createDocument,
  createOutlineNode,
  randomUuid,
} from "@narralume/domain";
import {
  SqliteCanonRepository,
  SqliteDocumentRepository,
  SqliteNarrativeStateRepository,
  SqliteProjectCoverRepository,
  SqliteProjectStatisticsRepository,
  SqliteProjectRepository,
  SqliteRequestReplayRepository,
  SqliteStoryRepository,
  type NarrativeDatabase,
} from "@narralume/persistence";
import { z } from "zod";

import type { RunCoordinator, RouteApp } from "@narralume/services";
import { StoryContextPreviewService } from "@narralume/services";
import { DeliveryService } from "@narralume/services";
import { ContextPreviewRequestSchema } from "@narralume/contracts";
import { bootstrapProject } from "@narralume/services";
import { ProjectOverviewService } from "@narralume/services";
import {
  applyCoverMutation,
  commitDocumentVersion,
  hashRequest,
  promoteCanonFact,
  reviseCanonFact,
  softDeleteProject,
  StoryServiceError,
  withdrawCanonFact,
} from "@narralume/services";

const ProjectParamsSchema = z.object({ projectId: z.string().min(1) });

const ProjectListQuerySchema = z.object({
  includeArchived: z.coerce.boolean().default(false),
  limit: z.coerce.number().int().min(1).max(100).default(100),
  offset: z.coerce.number().int().nonnegative().default(0),
});
const DuplicateProjectRequestSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
});
const DeleteProjectRequestSchema = z.object({
  confirmationTitle: z.string().min(1).max(200),
  expectedUpdatedAt: z.string().min(1),
});
const EntityQuerySchema = z.object({
  q: z.string().default(""),
  type: z
    .enum(["character", "location", "organization", "item", "rule", "concept"])
    .optional(),
  includeRetired: z.coerce.boolean().default(false),
});
const FactPromotionSchema = z.object({
  authority: z.enum(["inferred", "confirmed", "locked"]),
});
const OutlineParamsSchema = z.object({
  projectId: z.string().min(1),
  nodeId: z.string().min(1),
});
const EntityParamsSchema = z.object({
  projectId: z.string().min(1),
  entityId: z.string().min(1),
});
const FactParamsSchema = z.object({
  projectId: z.string().min(1),
  factId: z.string().min(1),
});
const TimelineParamsSchema = z.object({
  projectId: z.string().min(1),
  eventId: z.string().min(1),
});
const ForeshadowParamsSchema = z.object({
  projectId: z.string().min(1),
  foreshadowId: z.string().min(1),
});
const RelationshipParamsSchema = z.object({
  projectId: z.string().min(1),
  relationshipId: z.string().min(1),
});

export function registerStoryRoutes(
  app: RouteApp,
  database: NarrativeDatabase,
  options: {
    coordinator: RunCoordinator;
    enableBackgroundWorker: boolean;
    environment: Readonly<Record<string, string | undefined>>;
  },
): void {
  const projects = new SqliteProjectRepository(database);
  const requestReplays = new SqliteRequestReplayRepository(database);
  const covers = new SqliteProjectCoverRepository(database);
  const projectStatistics = new SqliteProjectStatisticsRepository(database);
  const story = new SqliteStoryRepository(database);
  const canon = new SqliteCanonRepository(database);
  const state = new SqliteNarrativeStateRepository(database, canon, story);
  const documents = new SqliteDocumentRepository(database);
  const delivery = new DeliveryService(database);
  const context = new StoryContextPreviewService(database);
  const overview = new ProjectOverviewService(database);

  app.route("GET", "/api/projects", async (request) => {
    const query = ProjectListQuerySchema.parse(request.query);
    const listedProjects = projects.list({
      includeArchived: query.includeArchived,
      limit: query.limit,
      offset: query.offset,
    });
    const coverDescriptors = covers.listDescriptors();
    const statistics = projectStatistics.list(
      listedProjects.map((project) => project.id),
    );
    return listedProjects.map((project) => {
      const stats = statistics.get(project.id)!;
      return ProjectShelfItemSchema.parse({
        ...project,
        ...stats,
        cover: coverDescriptors.get(project.id) ?? null,
      });
    });
  });

  app.route("GET", "/api/projects/:projectId/overview", async (request) => {
    const { projectId } = ProjectParamsSchema.parse(request.params);
    const result = overview.get(projectId);
    if (!result) {
      throw new StoryRouteError("project.not_found", "Project not found", 404);
    }
    return ProjectOverviewSchema.parse(result);
  });

  app.route("POST", "/api/projects", async (request) => {
    const input = CreateProjectRequestSchema.parse(request.body);
    const project = database.transaction(() => {
      const scope = "projects:create";
      const requestHash = hashRequest({
        title: input.title,
        language: input.language,
        subtitle: input.subtitle ?? null,
        premise: input.premise ?? null,
      });
      const replay = requestReplays.get(scope, input.requestId);
      if (replay) {
        if (replay.requestHash !== requestHash) {
          throw new StoryRouteError(
            "project.create.idempotency_conflict",
            "The same requestId was already used for a different blank-book creation request",
            409,
          );
        }
        return ProjectSchema.parse(replay.result);
      }

      const now = new Date().toISOString();
      const created = bootstrapProject(database, {
        projectId: randomUuid(),
        rootOutlineNodeId: randomUuid(),
        title: input.title,
        language: input.language,
        subtitle: input.subtitle ?? null,
        premise: input.premise ?? null,
        now,
      });
      requestReplays.insert({
        scope,
        requestId: input.requestId,
        requestHash,
        result: created,
        createdAt: now,
      });
      return created;
    });
    return { status: 201, body: ProjectSchema.parse(project) };
  });

  app.route("GET", "/api/projects/recycle-bin", async () =>
    projects
      .listDeleted()
      .filter(
        (project) =>
          project.deletedAt && project.deletionToken && project.deleteAfter,
      )
      .map((project) => RecycledProjectSchema.parse(project)),
  );

  app.route(
    "PUT",
    "/api/projects/:projectId",
    async (request) => {
      const { projectId } = ProjectParamsSchema.parse(request.params);
      const input = UpdateProjectRequestSchema.parse(request.body);
      const current = projects.get(projectId);
      if (!current)
        throw new StoryRouteError(
          "project.not_found",
          "Project not found",
          404,
        );
      // 资料与封面在同一事务中提交：版本前提失败时封面也不会被改动（CR-83）。
      const updated = database.transaction(() => {
        const latest = projects.get(projectId);
        if (!latest || latest.updatedAt !== input.expectedUpdatedAt)
          throw new StoryRouteError(
            "project.version.conflict",
            "The project details have changed; refresh before editing again",
            409,
          );
        const updatedAt = nextUpdatedAt(latest.updatedAt);
        if (input.cover)
          applyCoverMutation(database, projectId, input.cover, updatedAt);
        return projects.update({
          ...latest,
          title: input.title,
          subtitle: input.subtitle,
          premise: input.premise,
          archivedAt: input.archived ? (latest.archivedAt ?? updatedAt) : null,
          updatedAt,
        });
      });
      return ProjectSchema.parse(updated);
    },
    { bodyLimit: 12_000_000 },
  );

  app.route("POST", "/api/projects/:projectId/duplicate", async (request) => {
    const { projectId } = ProjectParamsSchema.parse(request.params);
    requireProject(projects, projectId);
    const input = DuplicateProjectRequestSchema.parse(request.body ?? {});
    const now = new Date().toISOString();
    const duplicatedProjectId = delivery.duplicateProject(
      projectId,
      input.title,
      now,
    );
    const sourceCover = covers.get(projectId);
    if (sourceCover)
      covers.upsert({
        projectId: duplicatedProjectId,
        mediaType: sourceCover.mediaType,
        data: sourceCover.data,
        width: sourceCover.width,
        height: sourceCover.height,
        crop: sourceCover.crop,
        now,
      });
    return {
      status: 201,
      body: ProjectSchema.parse(projects.get(duplicatedProjectId)),
    };
  });

  app.route("DELETE", "/api/projects/:projectId", async (request) => {
    const { projectId } = ProjectParamsSchema.parse(request.params);
    const input = DeleteProjectRequestSchema.parse(request.body);
    // 前置校验、软删除与级联取消（活动 Run 与自动驾驶会话）都在服务层。
    const { recycled, activeRunIds } = softDeleteProject(database, {
      projectId,
      expectedUpdatedAt: input.expectedUpdatedAt,
      confirmationTitle: input.confirmationTitle,
      now: new Date().toISOString(),
    });
    for (const runId of activeRunIds) options.coordinator.interrupt(runId);
    return { status: 202, body: RecycledProjectSchema.parse(recycled) };
  });

  app.route("POST", "/api/projects/:projectId/restore", async (request) => {
    const { projectId } = ProjectParamsSchema.parse(request.params);
    const input = RestoreProjectRequestSchema.parse(request.body);
    return ProjectSchema.parse(
      projects.restoreDeleted(
        projectId,
        input.deletionToken,
        new Date().toISOString(),
      ),
    );
  });

  app.route("DELETE", "/api/projects/:projectId/purge", async (request) => {
    const { projectId } = ProjectParamsSchema.parse(request.params);
    const input = PurgeProjectRequestSchema.parse(request.body);
    const project = projects.getIncludingDeleted(projectId);
    if (!project?.deletedAt)
      throw new StoryRouteError(
        "project.recycle.not_found",
        "The project is not in the recycle bin",
        404,
      );
    if (project.title !== input.confirmationTitle)
      throw new StoryRouteError(
        "project.purge.confirmation_mismatch",
        "The confirmation title does not match the project title",
        422,
      );
    if (!projects.purge(projectId, input.deletionToken))
      throw new StoryRouteError(
        "project.purge.token_mismatch",
        "The deletion token is invalid; refresh the recycle bin and try again",
        409,
      );
    return { status: 204 };
  });

  app.route("GET", "/api/projects/:projectId/story-bible", async (request) => {
    const { projectId } = ProjectParamsSchema.parse(request.params);
    const project = projects.get(projectId);
    if (!project) return notFound("project.not_found", "Project not found");
    return StoryBibleSnapshotSchema.parse({
      project,
      intent: story.getAuthorIntent(projectId),
      outline: story.listOutline(projectId),
      entities: canon.listEntities(projectId, { includeRetired: true }),
      facts: canon.listEffectiveFacts(projectId, { includeCandidates: true }),
      relationships: state.listCurrentRelationships(projectId),
      timeline: state.listTimeline(projectId),
      foreshadows: state.listForeshadows(projectId),
      documents: documents.list(projectId),
      occupiedOutlineNodeIds: documents
        .list(projectId, undefined, true)
        .flatMap((document) =>
          document.outlineNodeId ? [document.outlineNodeId] : [],
        ),
    });
  });

  app.route("PUT", "/api/projects/:projectId/intent", async (request) => {
    const { projectId } = ProjectParamsSchema.parse(request.params);
    if (!projects.get(projectId))
      return notFound("project.not_found", "Project not found");
    const input = UpdateAuthorIntentRequestSchema.parse(request.body);
    const current = story.getAuthorIntent(projectId);
    if ((current?.updatedAt ?? null) !== input.expectedUpdatedAt) {
      throw new StoryRouteError(
        "intent.version.conflict",
        "The author intent was updated by another process; refresh before editing",
        409,
      );
    }
    const base = current ?? emptyIntent(projectId, new Date().toISOString());
    const updated = {
      ...base,
      promise: input.promise === undefined ? base.promise : input.promise,
      themes: input.themes === undefined ? base.themes : input.themes,
      audience: input.audience === undefined ? base.audience : input.audience,
      tone: input.tone === undefined ? base.tone : input.tone,
      boundaries:
        input.boundaries === undefined ? base.boundaries : input.boundaries,
      endingDirection:
        input.endingDirection === undefined
          ? base.endingDirection
          : input.endingDirection,
      currentFocus:
        input.currentFocus === undefined
          ? base.currentFocus
          : input.currentFocus,
      lockedFields:
        input.lockedFields === undefined
          ? base.lockedFields
          : input.lockedFields,
      projectId,
      updatedAt: current
        ? nextUpdatedAt(current.updatedAt)
        : new Date().toISOString(),
    };
    return AuthorIntentSchema.parse(story.upsertAuthorIntent(updated));
  });

  app.route("POST", "/api/projects/:projectId/outline", async (request) => {
    const { projectId } = ProjectParamsSchema.parse(request.params);
    requireProject(projects, projectId);
    const input = CreateOutlineNodeRequestSchema.parse(request.body);
    const parent = input.parentId
      ? story.requireOutlineNode(projectId, input.parentId)
      : null;
    const node = createOutlineNode({
      id: randomUuid(),
      projectId,
      parent,
      now: new Date().toISOString(),
      kind: input.kind,
      ordinal: input.ordinal,
      title: input.title,
      summary: input.summary ?? null,
      goal: input.goal ?? null,
      conflict: input.conflict ?? null,
      outcome: input.outcome ?? null,
      povEntityId: input.povEntityId ?? null,
      storyTime: input.storyTime ?? null,
      metadata: input.metadata,
    });
    return {
      status: 201,
      body: OutlineNodeSchema.parse(story.insertOutlineNode(node)),
    };
  });

  app.route(
    "PUT",
    "/api/projects/:projectId/outline/:nodeId",
    async (request) => {
      const { projectId, nodeId } = OutlineParamsSchema.parse(request.params);
      const input = UpdateOutlineNodeRequestSchema.parse(request.body);
      const current = story.requireOutlineNode(projectId, nodeId);
      if (current.updatedAt !== input.expectedUpdatedAt) {
        throw new StoryRouteError(
          "outline.version.conflict",
          "The outline node was updated by another process; refresh before editing",
          409,
        );
      }
      const now = nextUpdatedAt(current.updatedAt);
      return OutlineNodeSchema.parse(
        database.transaction(() => {
          const details = story.updateOutlineDetails(
            projectId,
            nodeId,
            {
              ...(input.title === undefined ? {} : { title: input.title }),
              ...(input.summary === undefined
                ? {}
                : { summary: input.summary }),
              ...(input.goal === undefined ? {} : { goal: input.goal }),
              ...(input.conflict === undefined
                ? {}
                : { conflict: input.conflict }),
              ...(input.outcome === undefined
                ? {}
                : { outcome: input.outcome }),
              ...(input.povEntityId === undefined
                ? {}
                : { povEntityId: input.povEntityId }),
              ...(input.storyTime === undefined
                ? {}
                : { storyTime: input.storyTime }),
              ...(input.metadata === undefined
                ? {}
                : { metadata: input.metadata }),
            },
            now,
          );
          return input.status && input.status !== details.status
            ? story.updateOutlineStatus(projectId, nodeId, input.status, now)
            : details;
        }),
      );
    },
  );

  app.route(
    "DELETE",
    "/api/projects/:projectId/outline/:nodeId",
    async (request) => {
      const { projectId, nodeId } = OutlineParamsSchema.parse(request.params);
      const input = RemoveStoryResourceRequestSchema.parse(request.body);
      const current = story.requireOutlineNode(projectId, nodeId);
      if (current.updatedAt !== input.expectedUpdatedAt)
        throw new StoryRouteError(
          "outline.version.conflict",
          "The outline node has changed; refresh before removing it",
          409,
        );
      if (current.kind === "book")
        throw new StoryRouteError(
          "outline.root.protected",
          "The book root node cannot be removed",
          409,
        );
      const references = story.countOutlineReferences(nodeId);
      const disposition = database.transaction(() => {
        if (references > 0) {
          story.updateOutlineStatus(
            projectId,
            nodeId,
            "abandoned",
            nextUpdatedAt(current.updatedAt),
          );
          return "abandoned" as const;
        }
        story.deleteOutlineNode(projectId, nodeId);
        return "deleted" as const;
      });
      return StoryResourceRemovalSchema.parse({
        id: nodeId,
        disposition,
        references,
      });
    },
  );

  app.route(
    "DELETE",
    "/api/projects/:projectId/entities/:entityId",
    async (request) => {
      const { projectId, entityId } = EntityParamsSchema.parse(request.params);
      const input = RemoveStoryResourceRequestSchema.parse(request.body);
      const current = canon.requireEntity(projectId, entityId);
      if (current.updatedAt !== input.expectedUpdatedAt)
        throw new StoryRouteError(
          "canon.entity.version.conflict",
          "The entity has changed; refresh before removing it",
          409,
        );
      const references = canon.countEntityReferences(entityId);
      const disposition = database.transaction(() => {
        if (references > 0) {
          canon.updateEntity({
            ...current,
            status: "retired",
            updatedAt: nextUpdatedAt(current.updatedAt),
          });
          return "retired" as const;
        }
        canon.deleteEntity(projectId, entityId);
        return "deleted" as const;
      });
      return StoryResourceRemovalSchema.parse({
        id: entityId,
        disposition,
        references,
      });
    },
  );

  app.route("GET", "/api/projects/:projectId/entities", async (request) => {
    const { projectId } = ProjectParamsSchema.parse(request.params);
    const query = EntityQuerySchema.parse(request.query);
    const entities = query.q
      ? canon.searchEntities(projectId, query.q)
      : canon.listEntities(projectId, {
          ...(query.type ? { type: query.type } : {}),
          includeRetired: query.includeRetired,
        });
    return entities.map((entity) => CanonEntitySchema.parse(entity));
  });

  app.route("POST", "/api/projects/:projectId/entities", async (request) => {
    const { projectId } = ProjectParamsSchema.parse(request.params);
    requireProject(projects, projectId);
    const input = CreateCanonEntityRequestSchema.parse(request.body);
    const entity = createCanonEntity({
      id: randomUuid(),
      projectId,
      now: new Date().toISOString(),
      type: input.type,
      name: input.name,
      aliases: input.aliases,
      description: input.description ?? null,
      attributes: input.attributes,
    });
    return {
      status: 201,
      body: CanonEntitySchema.parse(canon.insertEntity(entity)),
    };
  });

  app.route(
    "PUT",
    "/api/projects/:projectId/entities/:entityId",
    async (request) => {
      const { projectId, entityId } = EntityParamsSchema.parse(request.params);
      const input = UpdateCanonEntityRequestSchema.parse(request.body);
      const current = canon.requireEntity(projectId, entityId);
      if (current.updatedAt !== input.expectedUpdatedAt) {
        throw new StoryRouteError(
          "canon.entity.version.conflict",
          "The entity was updated by another process; refresh before editing",
          409,
        );
      }
      return CanonEntitySchema.parse(
        canon.updateEntity({
          ...current,
          name: input.name,
          aliases: input.aliases,
          description: input.description,
          attributes: input.attributes,
          status: input.status,
          updatedAt: nextUpdatedAt(current.updatedAt),
        }),
      );
    },
  );

  app.route("POST", "/api/projects/:projectId/facts", async (request) => {
    const { projectId } = ProjectParamsSchema.parse(request.params);
    requireProject(projects, projectId);
    const input = CreateCanonFactRequestSchema.parse(request.body);
    const fact = createCanonFact({
      id: randomUuid(),
      projectId,
      now: new Date().toISOString(),
      subjectId: input.subjectId,
      predicate: input.predicate,
      knowledgeScope: input.knowledgeScope,
      authority: input.authority,
      sourceType: input.sourceType,
      ...(input.objectEntityId === undefined
        ? {}
        : { objectEntityId: input.objectEntityId }),
      ...(input.value === undefined ? {} : { value: input.value }),
      ...(input.validFromNodeId === undefined
        ? {}
        : { validFromNodeId: input.validFromNodeId }),
      ...(input.validToNodeId === undefined
        ? {}
        : { validToNodeId: input.validToNodeId }),
      ...(input.knowledgeSubjectId === undefined
        ? {}
        : { knowledgeSubjectId: input.knowledgeSubjectId }),
      ...(input.confidence === undefined
        ? {}
        : { confidence: input.confidence }),
      ...(input.sourceId === undefined ? {} : { sourceId: input.sourceId }),
    });
    const conflicts = canon.findConflicts(fact);
    canon.insertFact(fact);
    return {
      status: 201,
      body: {
        fact: CanonFactSchema.parse(fact),
        conflicts: conflicts.map((conflict) => ({
          reason: conflict.reason,
          fact: CanonFactSchema.parse(conflict.fact),
        })),
      },
    };
  });

  app.route(
    "POST",
    "/api/projects/:projectId/facts/:factId/promote",
    async (request) => {
      const { projectId, factId } = z
        .object({ projectId: z.string().min(1), factId: z.string().min(1) })
        .parse(request.params);
      const input = FactPromotionSchema.parse(request.body);
      return {
        status: 201,
        body: CanonFactSchema.parse(
          promoteCanonFact(database, {
            projectId,
            factId,
            authority: input.authority,
          }),
        ),
      };
    },
  );

  app.route(
    "DELETE",
    "/api/projects/:projectId/relationships/:relationshipId",
    async (request) => {
      const { projectId, relationshipId } = RelationshipParamsSchema.parse(
        request.params,
      );
      const input = RemoveStoryResourceRequestSchema.parse(request.body);
      const current = state.getRelationship(projectId, relationshipId);
      if (!current)
        throw new StoryRouteError(
          "relationship.not_found",
          "Relationship not found",
          404,
        );
      if (current.createdAt !== input.expectedUpdatedAt)
        throw new StoryRouteError(
          "relationship.version.conflict",
          "The relationship has changed; refresh before removing it",
          409,
        );
      const removed = state.removeRelationship(projectId, relationshipId, {
        ...current,
        id: randomUuid(),
        state: { ...current.state, lifecycle: "voided" },
        outlineNodeId: null,
        sourceId: null,
        supersedesEventId: current.id,
        createdAt: new Date().toISOString(),
      });
      return StoryResourceRemovalSchema.parse({
        id: relationshipId,
        ...removed,
      });
    },
  );

  app.route(
    "PUT",
    "/api/projects/:projectId/facts/:factId",
    async (request) => {
      const { projectId, factId } = FactParamsSchema.parse(request.params);
      const input = ReviseCanonFactRequestSchema.parse(request.body);
      // 生效前提与 locked 确认的规则在服务层。
      const { revised, conflicts } = reviseCanonFact(database, {
        projectId,
        factId,
        subjectId: input.subjectId,
        predicate: input.predicate,
        objectEntityId: input.objectEntityId,
        value: input.value,
        validFromNodeId: input.validFromNodeId,
        validToNodeId: input.validToNodeId,
        knowledgeScope: input.knowledgeScope,
        knowledgeSubjectId: input.knowledgeSubjectId,
        authority: input.authority,
        confidence: input.confidence,
        confirmLockedRevision: input.confirmLockedRevision,
      });
      return {
        status: 201,
        body: {
          fact: CanonFactSchema.parse(revised),
          conflicts: conflicts.map((conflict) => ({
            reason: conflict.reason,
            fact: CanonFactSchema.parse(conflict.fact),
          })),
        },
      };
    },
  );

  app.route(
    "DELETE",
    "/api/projects/:projectId/timeline/:eventId",
    async (request) => {
      const { projectId, eventId } = TimelineParamsSchema.parse(request.params);
      const input = RemoveStoryResourceRequestSchema.parse(request.body);
      const current = state
        .listTimeline(projectId)
        .find((event) => event.id === eventId);
      if (!current)
        throw new StoryRouteError(
          "timeline.not_found",
          "Timeline event not found",
          404,
        );
      if (current.updatedAt !== input.expectedUpdatedAt)
        throw new StoryRouteError(
          "timeline.version.conflict",
          "The timeline event has changed; refresh before removing it",
          409,
        );
      const removed = state.removeTimelineEvent(
        projectId,
        eventId,
        nextUpdatedAt(current.updatedAt),
      );
      return StoryResourceRemovalSchema.parse({ id: eventId, ...removed });
    },
  );

  app.route(
    "POST",
    "/api/projects/:projectId/facts/:factId/withdraw",
    async (request) => {
      const { projectId, factId } = FactParamsSchema.parse(request.params);
      const input = WithdrawCanonFactRequestSchema.parse(request.body);
      const withdrawal = withdrawCanonFact(database, {
        projectId,
        factId,
        reason: input.reason,
        confirmLockedWithdrawal: input.confirmLockedWithdrawal,
      });
      return { status: 201, body: CanonFactWithdrawalSchema.parse(withdrawal) };
    },
  );

  app.route(
    "POST",
    "/api/projects/:projectId/relationships",
    async (request) => {
      const { projectId } = ProjectParamsSchema.parse(request.params);
      const input = CreateRelationshipRequestSchema.parse(request.body);
      const event = {
        id: randomUuid(),
        projectId,
        createdAt: new Date().toISOString(),
        ...input,
      };
      return {
        status: 201,
        body: RelationshipEventSchema.parse(state.insertRelationship(event)),
      };
    },
  );

  app.route("POST", "/api/projects/:projectId/timeline", async (request) => {
    const { projectId } = ProjectParamsSchema.parse(request.params);
    const input = CreateTimelineEventRequestSchema.parse(request.body);
    const now = new Date().toISOString();
    const event = {
      id: randomUuid(),
      projectId,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    return {
      status: 201,
      body: TimelineEventSchema.parse(state.insertTimelineEvent(event)),
    };
  });

  app.route(
    "PUT",
    "/api/projects/:projectId/timeline/:eventId",
    async (request) => {
      const { projectId, eventId } = TimelineParamsSchema.parse(request.params);
      const input = UpdateTimelineEventRequestSchema.parse(request.body);
      const current = state
        .listTimeline(projectId)
        .find((event) => event.id === eventId);
      if (!current)
        throw new StoryRouteError(
          "timeline.not_found",
          "Timeline event not found",
          404,
        );
      if (current.updatedAt !== input.expectedUpdatedAt)
        throw new StoryRouteError(
          "timeline.version.conflict",
          "The timeline event has changed; refresh before editing",
          409,
        );
      const { expectedUpdatedAt, ...fields } = input;
      void expectedUpdatedAt;
      return TimelineEventSchema.parse(
        state.updateTimelineEvent({
          ...current,
          ...fields,
          id: eventId,
          projectId,
          createdAt: current.createdAt,
          updatedAt: nextUpdatedAt(current.updatedAt),
        }),
      );
    },
  );

  app.route(
    "DELETE",
    "/api/projects/:projectId/foreshadows/:foreshadowId",
    async (request) => {
      const { projectId, foreshadowId } = ForeshadowParamsSchema.parse(
        request.params,
      );
      const input = RemoveStoryResourceRequestSchema.parse(request.body);
      const current = state
        .listForeshadows(projectId)
        .find((item) => item.id === foreshadowId);
      if (!current)
        throw new StoryRouteError(
          "foreshadow.not_found",
          "Foreshadow not found",
          404,
        );
      if (current.updatedAt !== input.expectedUpdatedAt)
        throw new StoryRouteError(
          "foreshadow.version.conflict",
          "The foreshadow has changed; refresh before removing it",
          409,
        );
      const removed = state.removeForeshadow(
        projectId,
        foreshadowId,
        nextUpdatedAt(current.updatedAt),
      );
      return StoryResourceRemovalSchema.parse({ id: foreshadowId, ...removed });
    },
  );

  app.route("POST", "/api/projects/:projectId/foreshadows", async (request) => {
    const { projectId } = ProjectParamsSchema.parse(request.params);
    const input = CreateForeshadowRequestSchema.parse(request.body);
    const now = new Date().toISOString();
    const foreshadow = {
      id: randomUuid(),
      projectId,
      createdAt: now,
      updatedAt: now,
      ...input,
    };
    return {
      status: 201,
      body: ForeshadowSchema.parse(state.insertForeshadow(foreshadow)),
    };
  });

  app.route(
    "PUT",
    "/api/projects/:projectId/foreshadows/:foreshadowId",
    async (request) => {
      const { projectId, foreshadowId } = ForeshadowParamsSchema.parse(
        request.params,
      );
      const input = UpdateForeshadowRequestSchema.parse(request.body);
      const current = state
        .listForeshadows(projectId)
        .find((item) => item.id === foreshadowId);
      if (!current)
        throw new StoryRouteError(
          "foreshadow.not_found",
          "Foreshadow not found",
          404,
        );
      if (current.updatedAt !== input.expectedUpdatedAt)
        throw new StoryRouteError(
          "foreshadow.version.conflict",
          "The foreshadow was updated by another process; refresh before editing",
          409,
        );
      return ForeshadowSchema.parse(
        state.updateForeshadow({
          ...current,
          ...input,
          id: foreshadowId,
          projectId,
          createdAt: current.createdAt,
          updatedAt: nextUpdatedAt(current.updatedAt),
        }),
      );
    },
  );

  app.route("GET", "/api/projects/:projectId/documents", async (request) => {
    const { projectId } = ProjectParamsSchema.parse(request.params);
    return documents
      .list(projectId)
      .map((document) => DocumentSchema.parse(document));
  });

  app.route("POST", "/api/projects/:projectId/documents", async (request) => {
    const { projectId } = ProjectParamsSchema.parse(request.params);
    const input = CreateDocumentRequestSchema.parse(request.body);
    const document = database.transaction(() => {
      requireProject(projects, projectId);
      const scope = `project:${projectId}:documents:create`;
      const requestHash = hashRequest({
        kind: input.kind,
        title: input.title,
        outlineNodeId: input.outlineNodeId,
      });
      const replay = requestReplays.get(scope, input.requestId);
      if (replay) {
        if (replay.requestHash !== requestHash) {
          throw new StoryRouteError(
            "document.create.idempotency_conflict",
            "The same requestId was already used for a different document creation request",
            409,
          );
        }
        return DocumentSchema.parse(replay.result);
      }

      const outlineKinds = new Set(["chapter", "scene"]);
      if (outlineKinds.has(input.kind)) {
        if (!input.outlineNodeId) {
          throw new StoryRouteError(
            "document.outline_node.required",
            "Chapter or scene manuscripts must be bound to their outline node",
            422,
          );
        }
        const target = story.getOutlineNode(projectId, input.outlineNodeId);
        if (!target || target.kind !== input.kind) {
          throw new StoryRouteError(
            "document.outline_node.invalid",
            "The outline node bound to the manuscript does not exist or has the wrong kind",
            422,
          );
        }
        if (documents.getByOutlineNodeId(projectId, input.outlineNodeId)) {
          throw new StoryRouteError(
            "document.outline_node.in_use",
            "The outline node already has a manuscript document",
            409,
          );
        }
      } else if (input.outlineNodeId) {
        throw new StoryRouteError(
          "document.outline_node.unsupported",
          "Only chapter or scene manuscripts can be bound to an outline node",
          422,
        );
      }
      const now = new Date().toISOString();
      const created = documents.insert(
        createDocument({
          id: randomUuid(),
          projectId,
          now,
          kind: input.kind,
          title: input.title,
          outlineNodeId: input.outlineNodeId,
        }),
      );
      requestReplays.insert({
        scope,
        requestId: input.requestId,
        requestHash,
        result: created,
        createdAt: now,
      });
      return created;
    });
    return { status: 201, body: DocumentSchema.parse(document) };
  });

  app.route(
    "GET",
    "/api/projects/:projectId/documents/:documentId/versions",
    async (request) => {
      const { projectId, documentId } = documentParams(request.params);
      return documents
        .listVersions(projectId, documentId)
        .map((version) => DocumentVersionSchema.parse(version));
    },
  );

  app.route(
    "POST",
    "/api/projects/:projectId/documents/:documentId/versions",
    async (request) => {
      const { projectId, documentId } = documentParams(request.params);
      const input = AppendDocumentVersionRequestSchema.parse(request.body);
      // 版本追加、删草稿、检索段、大纲状态与自动结算的副作用链在服务层。
      const version = commitDocumentVersion(database, {
        projectId,
        documentId,
        content: input.content,
        source: input.source,
        ...(input.expectedCurrentVersionId === undefined
          ? {}
          : { expectedCurrentVersionId: input.expectedCurrentVersionId }),
        triggerSettlement: input.source === "manual",
        environment: options.environment,
        coordinatorWake: () => {
          if (options.enableBackgroundWorker) options.coordinator.wake();
        },
      });
      return { status: 201, body: DocumentVersionSchema.parse(version) };
    },
  );

  app.route(
    "POST",
    "/api/projects/:projectId/documents/:documentId/restore",
    async (request) => {
      const { projectId, documentId } = documentParams(request.params);
      const input = RestoreDocumentVersionRequestSchema.parse(request.body);
      const target = documents
        .listVersions(projectId, documentId)
        .find((candidate) => candidate.id === input.targetVersionId);
      if (!target)
        throw new StoryRouteError(
          "document.version.not_found",
          "The version to restore does not exist",
          404,
        );
      // 恢复 = 以目标版本内容再走一次提交副作用链（含自动结算）。
      const version = commitDocumentVersion(database, {
        projectId,
        documentId,
        content: target.content,
        source: `restore:${input.targetVersionId}`,
        expectedCurrentVersionId: input.expectedCurrentVersionId,
        triggerSettlement: true,
        environment: options.environment,
        coordinatorWake: () => {
          if (options.enableBackgroundWorker) options.coordinator.wake();
        },
      });
      return { status: 201, body: DocumentVersionSchema.parse(version) };
    },
  );

  app.route(
    "POST",
    "/api/projects/:projectId/context/preview",
    async (request) => {
      const { projectId } = ProjectParamsSchema.parse(request.params);
      requireProject(projects, projectId);
      const input = ContextPreviewRequestSchema.parse(request.body);
      return context.compile({
        projectId,
        purpose: input.purpose,
        task: input.task,
        query: input.query,
        entityIds: input.entityIds,
        currentOutlineNodeId: input.currentOutlineNodeId,
        access: {
          audience: input.access.audience,
          ...(input.access.characterId
            ? { characterId: input.access.characterId }
            : {}),
          ...(input.access.includeCandidates === undefined
            ? {}
            : { includeCandidates: input.access.includeCandidates }),
        },
        budget: {
          contextWindow: input.budget.contextWindow,
          outputReserve: input.budget.outputReserve,
          fixedInstructionReserve: input.budget.fixedInstructionReserve,
          toolReserve: input.budget.toolReserve,
          schemaReserve: input.budget.schemaReserve,
          ...(input.budget.safetyReserve === undefined
            ? {}
            : { safetyReserve: input.budget.safetyReserve }),
        },
      });
    },
  );
}

function requireProject(
  projects: SqliteProjectRepository,
  projectId: string,
): void {
  if (!projects.get(projectId)) {
    throw new StoryRouteError("project.not_found", "Project not found", 404);
  }
}

function emptyIntent(projectId: string, now: string) {
  return {
    projectId,
    promise: null,
    themes: [],
    audience: null,
    tone: null,
    boundaries: [],
    endingDirection: null,
    currentFocus: null,
    lockedFields: [],
    updatedAt: now,
  };
}

function nextUpdatedAt(previous: string): string {
  return new Date(Math.max(Date.now(), Date.parse(previous) + 1)).toISOString();
}

function documentParams(value: unknown) {
  return z
    .object({
      projectId: z.string().min(1),
      documentId: z.string().min(1),
    })
    .parse(value);
}

function notFound(code: string, message: string) {
  return { status: 404, body: { error: { code, message } } };
}

export class StoryRouteError extends StoryServiceError {
  constructor(code: string, message: string, statusCode: number) {
    super(code, message, statusCode);
    this.name = "StoryRouteError";
  }
}
