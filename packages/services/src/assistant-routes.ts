import { sha256Hex } from "@narralume/domain";

import {
  AssistantActivityActionRequestSchema,
  AssistantActivityActionResponseSchema,
  AssistantConversationActionRequestSchema,
  AssistantConversationDetailSchema,
  AssistantConversationSchema,
  AssistantLongGoalAcceptedSchema,
  AssistantLongGoalActionRequestSchema,
  AssistantLongGoalSchema,
  AssistantMessageAcceptedSchema,
  AssistantMessageSchema,
  CreateAssistantConversationRequestSchema,
  CreateAssistantMessageRequestSchema,
  StartAssistantLongGoalRequestSchema,
} from "@narralume/contracts";
import { buildAssistantTurnRecipe } from "@narralume/harness";
import {
  activityText,
  toolGoalParams,
  toolResultSummary,
  toolStage,
} from "./assistant-activity-text.js";
import {
  AssistantPersistenceError,
  SqliteAssistantLongGoalRepository,
  SqliteAssistantRepository,
  SqliteAssignmentRepository,
  SqliteDocumentRepository,
  SqliteImportedAgentSkillRepository,
  SqliteModelRepository,
  SqliteProjectRepository,
  SqliteProviderRepository,
  SqliteRunRepository,
  SqliteStoryRepository,
  type AssistantActivity,
  type NarrativeDatabase,
} from "@narralume/persistence";
import { AGENT_SKILL_REGISTRY } from "@narralume/services";
import { z } from "zod";

import type { AutopilotCoordinator, RouteApp } from "@narralume/services";
import { isRetryableAssistantActivityError } from "@narralume/services";
import { AssistantTaskProjectionService } from "@narralume/services";
import {
  AssistantToolExecutionError,
  AssistantToolExecutor,
} from "@narralume/services";
import { ASSISTANT_TOOL_REGISTRY } from "@narralume/services";
import type { LongGoalCoordinator } from "@narralume/services";
import type { RunCoordinator } from "@narralume/services";
import {
  requireAliveAssistantModel,
  requireAssistantProject,
  requireSwitchableAssistantModel,
  requireWritingAssignment,
  validateAssistantContext,
  withRuntimeModelPolicy,
} from "@narralume/services";

const ProjectParamsSchema = z.object({ projectId: z.string().trim().min(1) });
const ConversationParamsSchema = z.object({
  conversationId: z.string().trim().min(1),
});
const ActivityParamsSchema = z.object({
  activityId: z.string().trim().min(1),
});

export interface RegisterAssistantRouteOptions {
  runCoordinator: RunCoordinator;
  autopilotCoordinator: AutopilotCoordinator;
  longGoalCoordinator: LongGoalCoordinator;
  enableBackgroundWorker: boolean;
  environment: Readonly<Record<string, string | undefined>>;
}

export function registerAssistantRoutes(
  app: RouteApp,
  database: NarrativeDatabase,
  options: RegisterAssistantRouteOptions,
): void {
  const assistants = new SqliteAssistantRepository(database);
  const documents = new SqliteDocumentRepository(database);
  const projects = new SqliteProjectRepository(database);
  const runs = new SqliteRunRepository(database);
  const story = new SqliteStoryRepository(database);
  const models = new SqliteModelRepository(database);
  const providers = new SqliteProviderRepository(database);
  const assignments = new SqliteAssignmentRepository(database);
  const projection = new AssistantTaskProjectionService(database);
  const executor = new AssistantToolExecutor(database, {
    runCoordinator: options.runCoordinator,
    autopilotCoordinator: options.autopilotCoordinator,
    longGoalCoordinator: options.longGoalCoordinator,
    enableBackgroundWorker: options.enableBackgroundWorker,
    environment: options.environment,
  });
  const longGoals = new SqliteAssistantLongGoalRepository(database);
  const importedSkills = new SqliteImportedAgentSkillRepository(database);

  app.route(
    "POST",
    "/api/projects/:projectId/assistant/conversations",
    async (request) => {
      const { projectId } = ProjectParamsSchema.parse(request.params);
      requireProject(projects, projectId);
      const input = CreateAssistantConversationRequestSchema.parse(
        request.body,
      );
      const id = deterministicId(
        "assistant-conversation",
        projectId,
        input.requestId,
      );
      const existing = assistants.getConversation(id);
      if (existing) {
        if (
          existing.projectId !== projectId ||
          existing.title !== input.title
        ) {
          throw new AssistantRouteError(
            "assistant.conversation.idempotency_conflict",
            "The same requestId was already used for a different assistant conversation request",
            409,
          );
        }
        return {
          status: 200,
          body: AssistantConversationSchema.parse(existing),
        };
      }
      const now = new Date().toISOString();
      return {
        status: 201,
        body: AssistantConversationSchema.parse(
          assistants.insertConversation({
            id,
            projectId,
            title: input.title,
            status: "active",
            settings: { modelId: null, reasoningEffort: null },
            createdAt: now,
            updatedAt: now,
          }),
        ),
      };
    },
  );

  app.route(
    "GET",
    "/api/projects/:projectId/assistant/conversations",
    async (request) => {
      const { projectId } = ProjectParamsSchema.parse(request.params);
      requireProject(projects, projectId);
      return assistants
        .listConversations(projectId)
        .map((conversation) => AssistantConversationSchema.parse(conversation));
    },
  );

  app.route(
    "GET",
    "/api/assistant/conversations/:conversationId",
    async (request) => {
      const { conversationId } = ConversationParamsSchema.parse(request.params);
      const conversation = assistants.requireConversation(conversationId);
      requireAssistantProject(projects, conversation.projectId);
      return AssistantConversationDetailSchema.parse({
        conversation,
        messages: assistants.listMessages(conversation.id),
        activities: projection.list(conversation.projectId, conversation.id),
        tools: ASSISTANT_TOOL_REGISTRY,
        skills: AGENT_SKILL_REGISTRY,
        importedSkills: importedSkills.listEnabledForProject(
          conversation.projectId,
        ),
      });
    },
  );

  app.route(
    "POST",
    "/api/assistant/conversations/:conversationId/actions",
    async (request) => {
      const { conversationId } = ConversationParamsSchema.parse(request.params);
      const input = AssistantConversationActionRequestSchema.parse(
        request.body,
      );
      const conversation = assistants.requireConversation(conversationId);
      requireAssistantProject(projects, conversation.projectId);
      if (input.action === "rename") {
        return AssistantConversationSchema.parse(
          assistants.renameConversation(
            conversationId,
            input.title,
            new Date().toISOString(),
          ),
        );
      }
      if (input.action === "configure") {
        if (input.modelId !== undefined && input.modelId !== null) {
          requireSwitchableAssistantModel(conversation, input.modelId, {
            models,
            providers,
            assignments,
          });
        }
        return AssistantConversationSchema.parse(
          assistants.configureConversation(
            conversationId,
            {
              ...(input.modelId === undefined
                ? {}
                : { modelId: input.modelId }),
              ...(input.reasoningEffort === undefined
                ? {}
                : { reasoningEffort: input.reasoningEffort }),
            },
            new Date().toISOString(),
          ),
        );
      }
      return AssistantConversationSchema.parse(
        assistants.archiveConversation(
          conversationId,
          new Date().toISOString(),
        ),
      );
    },
  );

  app.route(
    "POST",
    "/api/assistant/conversations/:conversationId/messages",
    async (request) => {
      const { conversationId } = ConversationParamsSchema.parse(request.params);
      const conversation = assistants.requireConversation(conversationId);
      if (conversation.status !== "active") {
        throw new AssistantRouteError(
          "assistant.conversation.archived",
          "This conversation has been archived",
          409,
        );
      }
      const project = requireAssistantProject(projects, conversation.projectId);
      const input = CreateAssistantMessageRequestSchema.parse(request.body);
      validateAssistantContext(project.id, input.context, documents, story);
      const requestHash = hashStable({
        content: input.content,
        context: input.context,
      });
      const runId = deterministicId(
        "assistant-turn",
        conversation.id,
        input.requestId,
      );
      const messageId = deterministicId(
        "assistant-user-message",
        conversation.id,
        input.requestId,
      );
      const recipe = buildAssistantTurnRecipe(runId);
      const now = new Date().toISOString();
      /* 对话覆盖的模型失效时明确失败并提示重选，不静默回退全局默认。 */
      if (conversation.settings.modelId) {
        requireAliveAssistantModel(conversation.settings.modelId, {
          models,
          providers,
        });
      }
      const origin = {
        surface: input.context.surface,
        documentId: input.context.documentId,
        selection: input.context.selection
          ? {
              start: input.context.selection.start,
              end: input.context.selection.end,
            }
          : null,
      };
      const policy = withRuntimeModelPolicy(
        {
          assistantConversationId: conversation.id,
          assistantUserMessageId: messageId,
          assistantContext: input.context,
          assistantTools: ASSISTANT_TOOL_REGISTRY,
          assistantMaxOutputTokens: 3_000,
          ...(conversation.settings.modelId
            ? { assistantModelId: conversation.settings.modelId }
            : {}),
          ...(conversation.settings.reasoningEffort
            ? {
                assistantReasoningEffort: conversation.settings.reasoningEffort,
              }
            : {}),
          creationRequestId: input.requestId,
          creationRequestHash: requestHash,
          origin,
        },
        options.environment,
      );
      const idempotentReplay = database.transaction(() => {
        const existing = runs.getRun(runId);
        if (existing) {
          if (
            existing.projectId !== project.id ||
            existing.policy.creationRequestHash !== requestHash
          ) {
            throw new AssistantRouteError(
              "assistant.message.idempotency_conflict",
              "The same requestId was already used for a different assistant message",
              409,
            );
          }
          assistants.requireMessage(messageId);
          return true;
        }
        requireWritingAssignment(database, options.environment);
        const activeResponse = runs
          .listActiveRuns(project.id)
          .find(
            (run) =>
              run.recipe === "assistant-turn" &&
              run.policy.assistantConversationId === conversation.id,
          );
        if (activeResponse) {
          throw new AssistantRouteError(
            "assistant.message.response_in_progress",
            "The previous message is still being processed; wait for the answer before sending a new one",
            409,
          );
        }
        runs.create({
          id: runId,
          projectId: project.id,
          recipe: recipe.name,
          recipeVersion: recipe.version,
          mode: "manual",
          targetOutlineNodeId: null,
          policy,
          steps: recipe.steps,
          now,
        });
        assistants.insertMessage({
          id: messageId,
          conversationId: conversation.id,
          role: "user",
          content: input.content,
          context: input.context,
          sourceRunId: runId,
          replyToMessageId: null,
          createdAt: now,
        });
        return false;
      });
      if (!idempotentReplay && options.enableBackgroundWorker) {
        options.runCoordinator.wake();
      }
      return {
        status: 202,
        body: AssistantMessageAcceptedSchema.parse({
          message: AssistantMessageSchema.parse(
            assistants.requireMessage(messageId),
          ),
          runId,
          idempotentReplay,
        }),
      };
    },
  );

  app.route(
    "POST",
    "/api/assistant/activities/:activityId/actions",
    async (request) => {
      const { activityId } = ActivityParamsSchema.parse(request.params);
      const input = AssistantActivityActionRequestSchema.parse(request.body);
      let activity = assistants.requireActivity(activityId);
      if (input.action === "resume" || input.action === "cancel") {
        if (activity.kind !== "long_goal") {
          throw invalidActivityState(activity, input.action);
        }
        const goalId = activity.id.replace(/:activity$/, "");
        const now = new Date().toISOString();
        options.longGoalCoordinator[
          input.action === "resume" ? "resume" : "cancel"
        ](goalId, now);
        return activityResponse(assistants.requireActivity(activityId));
      }
      if (input.action === "reject") {
        if (activity.status === "proposed") {
          activity = assistants.transitionActivity(activity.id, "proposed", {
            status: "rejected",
            result: { rejected: true },
            now: new Date().toISOString(),
          });
        } else if (activity.status !== "rejected") {
          throw invalidActivityState(activity, "reject");
        }
        return activityResponse(activity);
      }

      if (input.action === "retry") {
        if (
          activity.status !== "failed" ||
          !isRetryableAssistantActivityError(activity.error)
        ) {
          throw invalidActivityState(activity, "retry");
        }
        activity = assistants.transitionActivity(activity.id, "failed", {
          status: "running",
          now: new Date().toISOString(),
        });
        if (activity.executionMode === "auto") {
          // auto 活动失败后重试：交办执行，但不走下面的 confirm 响应路径；
          // 结果由 projection 统一投影。
          const execution = executor.executeAutoActivity(activity.id);
          if (!execution) {
            const current = assistants.requireActivity(activity.id);
            return activityResponse(current);
          }
          return activityResponse(assistants.requireActivity(activity.id));
        }
      }

      if (activity.status === "completed") return activityResponse(activity);
      if (activity.status === "proposed") {
        try {
          activity = assistants.transitionActivity(activity.id, "proposed", {
            status: "running",
            now: new Date().toISOString(),
          });
        } catch (error) {
          if (!(error instanceof AssistantPersistenceError)) throw error;
          activity = assistants.requireActivity(activity.id);
        }
      }
      if (activity.status === "completed") return activityResponse(activity);
      if (activity.status !== "running") {
        throw invalidActivityState(activity, "confirm");
      }
      try {
        const execution = executor.execute(activity);
        const completed = assistants.transitionActivity(
          activity.id,
          "running",
          {
            status: "completed",
            result: execution.result,
            sourceType: execution.source.type,
            sourceId: execution.source.id,
            now: new Date().toISOString(),
          },
        );
        return AssistantActivityActionResponseSchema.parse({
          activity: projection
            .list(
              assistants.requireConversation(completed.conversationId)
                .projectId,
              completed.conversationId,
            )
            .find(
              (candidate) => candidate.id === `assistant_tool:${completed.id}`,
            ),
          source: execution.source,
        });
      } catch (error) {
        const current = assistants.requireActivity(activity.id);
        if (current.status === "running") {
          assistants.transitionActivity(current.id, "running", {
            status: "failed",
            error: {
              code: errorCode(error),
              message: errorMessage(error),
            },
            now: new Date().toISOString(),
          });
        }
        throw error;
      }
    },
  );

  app.route(
    "POST",
    "/api/assistant/conversations/:conversationId/long-goals",
    async (request) => {
      const { conversationId } = ConversationParamsSchema.parse(request.params);
      const conversation = assistants.requireConversation(conversationId);
      if (conversation.status !== "active") {
        throw new AssistantRouteError(
          "assistant.conversation.archived",
          "This conversation has been archived",
          409,
        );
      }
      requireAssistantProject(projects, conversation.projectId);
      const input = StartAssistantLongGoalRequestSchema.parse(request.body);
      const goalId = deterministicId(
        "assistant-long-goal",
        conversation.id,
        input.requestId,
      );
      const activityId = `${goalId}:activity`;
      const existing = longGoals.getGoal(goalId);
      if (existing) {
        const existingActivity = assistants.getActivity(existing.activityId);
        const existingBraindump =
          existingActivity &&
          typeof existingActivity.input.braindump === "string"
            ? existingActivity.input.braindump
            : null;
        if (
          existing.conversationId !== conversation.id ||
          existing.targetChapters !== input.targetChapters ||
          existingBraindump !== input.braindump
        ) {
          throw new AssistantRouteError(
            "assistant.long_goal.idempotency_conflict",
            "The same requestId was already used for a different composite creation task",
            409,
          );
        }
        return {
          status: 200,
          body: AssistantLongGoalAcceptedSchema.parse({
            goal: toLongGoalDto(existing),
            idempotentReplay: true,
          }),
        };
      }
      const goal = options.longGoalCoordinator.startGoal({
        goalId,
        projectId: conversation.projectId,
        conversationId: conversation.id,
        activityId,
        title: "tool.goal.long_goal.start",
        targetChapters: input.targetChapters,
        braindump: input.braindump,
        now: new Date().toISOString(),
      });
      return {
        status: 202,
        body: AssistantLongGoalAcceptedSchema.parse({
          goal: toLongGoalDto(goal),
          idempotentReplay: false,
        }),
      };
    },
  );

  app.route(
    "POST",
    "/api/assistant/long-goals/:goalId/actions",
    async (request) => {
      const { goalId } = GoalParamsSchema.parse(request.params);
      const input = AssistantLongGoalActionRequestSchema.parse(request.body);
      const now = new Date().toISOString();
      const goal =
        input.action === "resume"
          ? options.longGoalCoordinator.resume(goalId, now)
          : options.longGoalCoordinator.cancel(goalId, now);
      return AssistantLongGoalSchema.parse(toLongGoalDto(goal));
    },
  );
}

const GoalParamsSchema = z.object({ goalId: z.string().trim().min(1) });

function toLongGoalDto(goal: {
  id: string;
  projectId: string;
  conversationId: string;
  activityId: string;
  title: string;
  targetChapters: number;
  phase: "foundation" | "outline" | "writing" | "done";
  status: "active" | "paused_baseline" | "completed" | "failed" | "cancelled";
  baselineHash: string;
  sessionId: string | null;
  foundationRunId: string | null;
  outlineSessionId: string | null;
  lastError: Readonly<Record<string, unknown>> | null;
  createdAt: string;
  updatedAt: string;
}) {
  return {
    id: goal.id,
    projectId: goal.projectId,
    conversationId: goal.conversationId,
    activityId: goal.activityId,
    title: goal.title,
    targetChapters: goal.targetChapters,
    phase: goal.phase,
    status: goal.status,
    baselineHash: goal.baselineHash,
    sessionId: goal.sessionId,
    foundationRunId: goal.foundationRunId,
    outlineSessionId: goal.outlineSessionId,
    lastError:
      goal.lastError &&
      typeof goal.lastError.code === "string" &&
      typeof goal.lastError.message === "string"
        ? { code: goal.lastError.code, message: goal.lastError.message }
        : null,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
  };
}

export class AssistantRouteError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "AssistantRouteError";
  }
}

function activityResponse(activity: AssistantActivity) {
  const linkedSource =
    activity.status === "completed" &&
    activity.sourceType !== null &&
    activity.sourceId !== null;
  return AssistantActivityActionResponseSchema.parse({
    activity: {
      id: `assistant_tool:${activity.id}`,
      conversationId: activity.conversationId,
      kind: "tool",
      layer: "local",
      status: activity.status,
      goal: activityText(activity.goal, toolGoalParams(activity)),
      stage: toolStage(activity),
      summary: toolResultSummary(activity),
      waitingReason: null,
      availableActions: [],
      sourceType: linkedSource ? activity.sourceType : "assistant_tool",
      sourceId: linkedSource ? activity.sourceId : activity.id,
      origin: activity.origin,
      result: activity.result,
      toolCall: { name: activity.toolName, arguments: activity.input },
      createdAt: activity.createdAt,
      updatedAt: activity.updatedAt,
    },
    source:
      activity.sourceType && activity.sourceId
        ? { type: activity.sourceType, id: activity.sourceId }
        : null,
  });
}

function invalidActivityState(
  activity: AssistantActivity,
  action: string,
): AssistantRouteError {
  return new AssistantRouteError(
    "assistant.activity.invalid_state",
    `The activity is in state "${activity.status}" and cannot be ${action}`,
    409,
  );
}

function requireProject(projects: SqliteProjectRepository, projectId: string) {
  const project = projects.get(projectId);
  if (!project) {
    throw new AssistantRouteError(
      "project.not_found",
      "Project not found",
      404,
    );
  }
  return project;
}

function deterministicId(
  kind: string,
  scope: string,
  requestId: string,
): string {
  const hex = sha256Hex(`${kind}\0${scope}\0${requestId}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function hashStable(value: unknown): string {
  return sha256Hex(stableJson(value));
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}

function errorCode(error: unknown): string {
  if (
    error instanceof AssistantToolExecutionError ||
    error instanceof AssistantRouteError ||
    error instanceof AssistantPersistenceError
  ) {
    return error.code;
  }
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return "assistant.tool.execution_failed";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Tool execution failed";
}

/**
 * 对话内换模型只允许在当前生效模型（对话覆盖 ?? 全局 writing 分配）的
 * 同协议家族内进行：跨协议模型在设置页改默认分配后再用。
 */
