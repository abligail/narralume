import {
  AssistantActivitySchema,
  AssistantToolCallSchema,
  type AssistantActivityArtifactDto,
  type AssistantActivityDto,
  type AssistantActivityTextDto,
  type AssistantContext,
} from "@narralume/contracts";
import type { NarrativeRun, RunSnapshot } from "@narralume/domain";
import {
  SqliteAssistantLongGoalRepository,
  SqliteAssistantRepository,
  SqliteAutomationRepository,
  SqliteRunRepository,
  SqliteRunStreamRepository,
  SqliteStoryRepository,
  type AssistantActivity,
  type AssistantLongGoal,
  type NarrativeDatabase,
} from "@narralume/persistence";

import { runProductProjection } from "./run-policy.js";
import {
  activityProgress,
  activityText,
  toolGoalParams,
  toolResultSummary,
  toolStage,
} from "./assistant-activity-text.js";
import { isRetryableAssistantActivityError } from "./assistant-retry.js";
import { runTaskLayer } from "./task-classification.js";

export class AssistantTaskProjectionService {
  private readonly assistant: SqliteAssistantRepository;
  private readonly automation: SqliteAutomationRepository;
  private readonly goals: SqliteAssistantLongGoalRepository;
  private readonly runs: SqliteRunRepository;
  private readonly streams: SqliteRunStreamRepository;
  private readonly story: SqliteStoryRepository;

  constructor(database: NarrativeDatabase) {
    this.assistant = new SqliteAssistantRepository(database);
    this.automation = new SqliteAutomationRepository(database);
    this.goals = new SqliteAssistantLongGoalRepository(database);
    this.runs = new SqliteRunRepository(database);
    this.streams = new SqliteRunStreamRepository(database);
    this.story = new SqliteStoryRepository(database);
  }

  list(projectId: string, conversationId: string): AssistantActivityDto[] {
    const persisted = this.assistant
      .listActivities(conversationId)
      .map((activity) => this.persistedActivity(activity));
    const runActivities = this.runs
      .listRuns(projectId)
      .map((run) => this.runActivity(this.runs.getSnapshot(run.id)))
      // 快速创作的子 run 已由会话卡吸收（同一等待只出一张卡），不再单独成卡。
      .filter(
        (activity) =>
          activity.conversationId === conversationId &&
          this.automation.findRunLink(activity.sourceId) === null,
      );
    const sessionActivities = this.automation
      .listSessions(projectId)
      .map((session) => {
        const child = session.currentRunId
          ? this.runs.getSnapshot(session.currentRunId)
          : null;
        const currentNode = session.currentOutlineNodeId
          ? this.story.getOutlineNode(projectId, session.currentOutlineNodeId)
          : null;
        const conversation = stringValue(
          session.chapterPolicy,
          "assistantConversationId",
        );
        const origin = assistantContext(
          session.chapterPolicy.origin,
          session.currentOutlineNodeId,
        );
        const reason = child
          ? latestRunReason(child)
          : errorCode(session.lastError);
        const planningOnly = session.chapterPolicy.planningOnly === true;
        return AssistantActivitySchema.parse({
          id: `autopilot:${session.id}`,
          conversationId: conversation,
          kind: "task",
          layer: "primary",
          status: sessionStatus(session.status),
          goal: planningOnly
            ? activityText("activity.goal.sessionOutline", {
                count: session.targetChapters,
              })
            : activityText("activity.goal.sessionChapters", {
                count: session.targetChapters,
              }),
          stage: sessionStage(
            session.status,
            session.completedChapters,
            session.targetChapters,
            currentNode?.title ?? null,
            planningOnly,
          ),
          summary:
            session.status === "completed"
              ? planningOnly
                ? activityText("activity.stage.sessionCompletedOutline", {
                    progress: activityProgress(
                      session.completedChapters,
                      session.targetChapters,
                    ),
                  })
                : activityText("activity.stage.sessionCompletedChapters", {
                    progress: activityProgress(
                      session.completedChapters,
                      session.targetChapters,
                    ),
                  })
              : null,
          waitingReason: reason,
          availableActions: sessionActions(session.status, reason),
          sourceType: "autopilot",
          sourceId: session.id,
          origin,
          result: {
            completedChapters: session.completedChapters,
            targetChapters: session.targetChapters,
            currentRunId: session.currentRunId,
            currentOutlineNodeId: session.currentOutlineNodeId,
            planningOnly,
          },
          toolCall: null,
          skillId: null,
          phaseKey: sessionPhaseKey(session, child, planningOnly),
          artifacts: sessionArtifacts(session),
          lastError: sessionLastError(session, child),
          linkedSources: child ? [{ type: "run", id: child.run.id }] : [],
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
        });
      })
      .filter((activity) => activity.conversationId === conversationId);
    return [...persisted, ...runActivities, ...sessionActivities].sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id),
    );
  }

  private runActivity(snapshot: RunSnapshot): AssistantActivityDto {
    const projection = runProductProjection(
      snapshot,
      this.streams.listForRun(snapshot.run.id),
    );
    const reason = latestRunReason(snapshot);
    return AssistantActivitySchema.parse({
      id: `run:${snapshot.run.id}`,
      conversationId: stringValue(
        snapshot.run.policy,
        "assistantConversationId",
      ),
      kind:
        snapshot.run.recipe === "assistant-turn"
          ? "assistant_response"
          : "task",
      layer: runTaskLayer(snapshot.run.recipe),
      status: runStatus(snapshot.run.status),
      goal: runGoal(snapshot.run, this.story),
      stage: runStage(snapshot),
      summary: runSummary(snapshot.run, projection.result),
      waitingReason: reason,
      availableActions: projection.availableActions,
      sourceType: "run",
      sourceId: snapshot.run.id,
      origin: assistantContext(
        projection.origin,
        snapshot.run.targetOutlineNodeId,
      ),
      result: projection.result,
      toolCall: null,
      skillId: null,
      phaseKey: runPhaseKey(snapshot),
      artifacts: runArtifacts(projection.result),
      lastError: runLastError(snapshot),
      linkedSources: [],
      createdAt: snapshot.run.createdAt,
      updatedAt: snapshot.run.updatedAt,
    });
  }

  private persistedActivity(activity: AssistantActivity): AssistantActivityDto {
    if (activity.kind === "long_goal") {
      return this.longGoalActivity(activity);
    }
    const toolCall = AssistantToolCallSchema.parse({
      name: activity.toolName,
      arguments: activity.input,
    });
    const linkedSource =
      activity.status === "completed" &&
      activity.sourceType !== null &&
      activity.sourceId !== null;
    return AssistantActivitySchema.parse({
      id: `assistant_tool:${activity.id}`,
      conversationId: activity.conversationId,
      kind: "tool",
      layer: "local",
      status: activityStatus(activity.status),
      goal: activityText(activity.goal, toolGoalParams(activity)),
      stage: toolStage(activity),
      summary: toolResultSummary(activity),
      waitingReason:
        activity.status === "failed"
          ? stringValue(activity.error, "message")
          : null,
      availableActions:
        activity.status === "proposed"
          ? ["confirm", "reject"]
          : activity.status === "failed" &&
              isRetryableAssistantActivityError(activity.error)
            ? ["retry"]
            : [],
      sourceType: linkedSource ? activity.sourceType : "assistant_tool",
      sourceId: linkedSource ? activity.sourceId : activity.id,
      origin: activity.origin,
      result: activity.result,
      toolCall,
      skillId: activity.skillId,
      phaseKey: activity.phaseKey,
      artifacts: activity.artifacts ?? [],
      lastError: activityLastError(activity),
      linkedSources: linkedSource
        ? [{ type: activity.sourceType!, id: activity.sourceId! }]
        : [],
      createdAt: activity.createdAt,
      updatedAt: activity.updatedAt,
    });
  }

  private longGoalActivity(activity: AssistantActivity): AssistantActivityDto {
    const goal = this.goals.getGoal(activity.id.replace(/:activity$/, ""));
    const status = goal
      ? goalStatus(goal.status)
      : activityStatus(activity.status);
    const waitingReason =
      goal?.status === "paused_baseline"
        ? "long_goal.paused_baseline"
        : activity.status === "failed"
          ? stringValue(activity.error, "message")
          : null;
    return AssistantActivitySchema.parse({
      id: `assistant_goal:${activity.id}`,
      conversationId: activity.conversationId,
      kind: "long_goal",
      layer: "primary",
      status,
      goal:
        activity.goal === LONG_GOAL_TITLE_KEY
          ? activityText(LONG_GOAL_TITLE_KEY, {
              ...(goal ? { count: goal.targetChapters } : {}),
            })
          : activity.goal,
      stage: longGoalStage(goal, activity),
      summary:
        goal?.status === "completed"
          ? activityText("activity.summary.longGoalCompleted")
          : null,
      waitingReason,
      availableActions:
        goal?.status === "paused_baseline" ? ["resume", "cancel"] : [],
      sourceType:
        goal?.sessionId && goal.status === "completed"
          ? "autopilot"
          : "assistant_tool",
      sourceId:
        goal?.sessionId && goal.status === "completed"
          ? goal.sessionId
          : activity.id,
      origin: activity.origin,
      result: activity.result,
      toolCall: null,
      skillId: activity.skillId,
      phaseKey: goal?.phase ?? activity.phaseKey,
      artifacts: activity.artifacts ?? [],
      lastError: goal?.lastError
        ? {
            code: String(goal.lastError.code ?? "long_goal.failed"),
            message: String(
              goal.lastError.message ?? "Long-running goal failed",
            ),
          }
        : activityLastError(activity),
      linkedSources: [
        goal?.foundationRunId
          ? { type: "run" as const, id: goal.foundationRunId }
          : null,
        goal?.outlineSessionId
          ? { type: "autopilot" as const, id: goal.outlineSessionId }
          : null,
        goal?.sessionId
          ? { type: "autopilot" as const, id: goal.sessionId }
          : null,
      ].filter((source): source is { type: "run" | "autopilot"; id: string } =>
        Boolean(source),
      ),
      createdAt: activity.createdAt,
      updatedAt: activity.updatedAt,
    });
  }
}

/** 长任务标题的机码：两条创建路径（工具确认 / 直接路由）都存此键。 */
const LONG_GOAL_TITLE_KEY = "tool.goal.long_goal.start";

function runStatus(
  status: NarrativeRun["status"],
): AssistantActivityDto["status"] {
  if (status === "pending") return "queued";
  if (status === "running") return "running";
  if (status === "paused" || status === "awaiting_user") return "waiting";
  if (status === "completed") return "completed";
  if (status === "cancelled") return "cancelled";
  return "failed";
}

function sessionStatus(status: string): AssistantActivityDto["status"] {
  if (status === "pending" || status === "planning") return "queued";
  if (status === "running") return "running";
  if (status === "paused" || status === "awaiting_user") return "waiting";
  if (status === "completed") return "completed";
  if (status === "cancelled") return "cancelled";
  return "failed";
}

function activityStatus(
  status: AssistantActivity["status"],
): AssistantActivityDto["status"] {
  if (status === "running") return "running";
  if (status === "completed") return "completed";
  if (status === "cancelled") return "cancelled";
  if (status === "rejected") return "rejected";
  if (status === "failed") return "failed";
  return "proposed";
}

function goalStatus(
  status: AssistantLongGoal["status"],
): AssistantActivityDto["status"] {
  if (status === "active") return "running";
  if (status === "paused_baseline") return "waiting";
  if (status === "completed") return "completed";
  if (status === "cancelled") return "cancelled";
  return "failed";
}

function longGoalStage(
  goal: AssistantLongGoal | null,
  activity: AssistantActivity,
): AssistantActivityTextDto {
  if (!goal) return toolStage(activity);
  if (goal.status === "paused_baseline")
    return activityText("activity.stage.longGoalBaselineChanged");
  if (goal.status === "completed")
    return activityText("activity.stage.longGoalCompleted");
  if (goal.status === "failed")
    return activityText("activity.stage.longGoalFailed");
  if (goal.status === "cancelled")
    return activityText("activity.stage.longGoalCancelled");
  const phases: Record<AssistantLongGoal["phase"], AssistantActivityTextDto> = {
    foundation: activityText("activity.stage.longGoalFoundation"),
    outline: activityText("activity.stage.longGoalOutline"),
    writing: activityText("activity.stage.longGoalWriting"),
    done: activityText("activity.stage.longGoalDone"),
  };
  return phases[goal.phase];
}

function runGoal(
  run: NarrativeRun,
  story: SqliteStoryRepository,
): AssistantActivityTextDto {
  const target = run.targetOutlineNodeId
    ? story.getOutlineNode(run.projectId, run.targetOutlineNodeId)
    : null;
  if (run.recipe === "assistant-turn")
    return activityText("activity.goal.assistantTurn");
  if (run.recipe === "book-foundation")
    return activityText("activity.goal.bookFoundation");
  if (run.recipe === "rolling-outline")
    return activityText("activity.goal.rollingOutline");
  if (run.recipe === "canon-spread-candidate")
    return activityText("activity.goal.canonSpread");
  if (run.recipe === "chapter-production") {
    return target
      ? activityText("activity.goal.chapterTitle", { title: target.title })
      : activityText("activity.goal.chapter");
  }
  if (run.recipe === "selection-edit")
    return activityText("activity.goal.selectionEdit");
  if (run.recipe === "cocreate-reply")
    return activityText("activity.goal.cocreateReply");
  if (run.recipe === "scene-adoption")
    return activityText("activity.goal.sceneAdoption");
  if (run.recipe === "import-analysis")
    return activityText("activity.goal.importAnalysis");
  return activityText("activity.goal.generic");
}

function runStage(snapshot: RunSnapshot): AssistantActivityTextDto {
  if (snapshot.run.status === "pending")
    return activityText("activity.stage.pending");
  if (snapshot.run.status === "paused")
    return activityText("activity.stage.paused");
  if (snapshot.run.status === "awaiting_user")
    return activityText("activity.stage.awaitingUser");
  if (snapshot.run.status === "completed")
    return activityText("activity.stage.completed");
  if (snapshot.run.status === "cancelled")
    return activityText("activity.stage.cancelled");
  if (
    snapshot.run.status === "failed" ||
    snapshot.run.status === "failed_recoverable"
  ) {
    return activityText("activity.stage.failed");
  }
  const current = snapshot.steps.find(
    (step) => step.id === snapshot.run.currentStepId,
  );
  return current
    ? stepLabel(current.kind)
    : activityText("activity.step.preparing");
}

const STEP_LABEL_KEYS: Record<string, AssistantActivityTextDto> = {
  "assistant.context": activityText("activity.step.assistantContext"),
  "assistant.respond": activityText("activity.step.assistantRespond"),
  "assistant.stage": activityText("activity.step.assistantStage"),
  "canon.context": activityText("activity.step.canonContext"),
  "canon.candidate": activityText("activity.step.canonCandidate"),
  "canon.stage": activityText("activity.step.canonStage"),
  "foundation.generate": activityText("activity.step.foundationGenerate"),
  "outline.generate": activityText("activity.step.outlineGenerate"),
  "context.compile": activityText("activity.step.contextCompile"),
  "scene.plan": activityText("activity.step.scenePlan"),
  "draft.generate": activityText("activity.step.draftGenerate"),
  "deterministic.check": activityText("activity.step.deterministicCheck"),
  "semantic.review": activityText("activity.step.semanticReview"),
  "revision.generate": activityText("activity.step.revisionGenerate"),
  "chapter.settle": activityText("activity.step.chapterSettle"),
  "chapter.commit": activityText("activity.step.chapterCommit"),
};

function stepLabel(kind: string): AssistantActivityTextDto {
  return STEP_LABEL_KEYS[kind] ?? activityText("activity.step.processing");
}

function runPhaseKey(snapshot: RunSnapshot): string | null {
  const status = snapshot.run.status;
  if (status === "pending") return "queued";
  if (status === "paused") return "paused";
  if (status === "awaiting_user") return "awaiting_author";
  if (status === "completed") return "completed";
  if (status === "cancelled") return "cancelled";
  if (status === "failed" || status === "failed_recoverable") return "failed";
  const current = snapshot.steps.find(
    (step) => step.id === snapshot.run.currentStepId,
  );
  return current ? current.kind : "preparing";
}

function runArtifacts(
  result: Readonly<Record<string, unknown>>,
): AssistantActivityArtifactDto[] {
  const artifacts: AssistantActivityArtifactDto[] = [];
  const push = (kind: string, value: unknown, label: string) => {
    if (typeof value === "string" && value) {
      artifacts.push({ kind, id: value, label });
    }
  };
  push(
    "foundation_candidate_set",
    result.foundationCandidateSetId,
    "foundation_candidate_set",
  );
  push("canon_change_set", result.canonChangeSetId, "canon_change_set");
  push("edit_proposal", result.editProposalId, "edit_proposal");
  push("document_version", result.documentVersionId, "document_version");
  push("revision_proposal", result.revisionProposalId, "revision_proposal");
  push("cocreate_turn", result.cocreateTurnId, "cocreate_turn");
  push("import_batch", result.importBatchId, "import_batch");
  return artifacts;
}

function runLastError(
  snapshot: RunSnapshot,
): { code: string; message: string } | null {
  const status = snapshot.run.status;
  if (status !== "failed" && status !== "failed_recoverable") return null;
  const failedStep = [...snapshot.steps]
    .reverse()
    .find((step) => step.status === "failed" && step.error);
  if (failedStep?.error) {
    return {
      code: failedStep.error.code,
      message: failedStep.error.message,
    };
  }
  const reason = latestRunReason(snapshot);
  return reason ? { code: reason, message: reason } : null;
}

function sessionPhaseKey(
  session: {
    status: string;
    currentRunId: string | null;
  },
  child: RunSnapshot | null,
  planningOnly: boolean,
): string | null {
  if (session.status === "pending" || session.status === "planning") {
    return "planning";
  }
  if (session.status === "running") {
    if (child) return runPhaseKey(child);
    return planningOnly ? "outline.generate" : "chapter";
  }
  if (session.status === "paused") return "paused";
  if (session.status === "awaiting_user") return "awaiting_author";
  if (session.status === "completed") return "completed";
  if (session.status === "cancelled") return "cancelled";
  return "failed";
}

function sessionArtifacts(session: {
  currentOutlineNodeId: string | null;
}): AssistantActivityArtifactDto[] {
  return session.currentOutlineNodeId
    ? [
        {
          kind: "outline_node",
          id: session.currentOutlineNodeId,
          label: "outline_node",
        },
      ]
    : [];
}

function sessionLastError(
  session: { status: string; lastError: unknown },
  child: RunSnapshot | null,
): { code: string; message: string } | null {
  if (session.status !== "failed" && session.status !== "awaiting_user") {
    return null;
  }
  if (child) {
    const childError = runLastError(child);
    if (childError) return childError;
  }
  const error = session.lastError;
  if (isRecord(error)) {
    const code = typeof error.code === "string" ? error.code : "session.failed";
    const message =
      typeof error.message === "string" && error.message ? error.message : code;
    return { code, message };
  }
  return null;
}

function activityLastError(
  activity: AssistantActivity,
): { code: string; message: string } | null {
  if (activity.status !== "failed") return null;
  const error = activity.error;
  if (isRecord(error)) {
    const code =
      typeof error.code === "string" ? error.code : "assistant.tool.failed";
    const message =
      typeof error.message === "string" && error.message
        ? error.message
        : "Tool execution failed";
    return { code, message };
  }
  return { code: "assistant.tool.failed", message: "Tool execution failed" };
}

function runSummary(
  run: NarrativeRun,
  result: Readonly<Record<string, unknown>>,
): AssistantActivityTextDto | null {
  if (run.status !== "completed") return null;
  if (typeof result.documentVersionId === "string")
    return activityText("activity.summary.documentVersion");
  if (typeof result.foundationCandidateSetId === "string")
    return activityText("activity.summary.foundationCandidates");
  if (typeof result.canonCandidateSetId === "string")
    return activityText("activity.summary.canonCandidates");
  if (typeof result.editProposalId === "string")
    return activityText("activity.summary.editProposal");
  return activityText("activity.summary.taskCompleted");
}

function sessionStage(
  status: string,
  completed: number,
  target: number,
  chapterTitle: string | null,
  planningOnly: boolean,
): AssistantActivityTextDto {
  const progressText = activityProgress(completed, target);
  if (status === "completed")
    return planningOnly
      ? activityText("activity.stage.sessionCompletedOutline", {
          progress: progressText,
        })
      : activityText("activity.stage.sessionCompletedChapters", {
          progress: progressText,
        });
  if (status === "paused")
    return planningOnly
      ? activityText("activity.stage.sessionPausedOutline", {
          progress: progressText,
        })
      : activityText("activity.stage.sessionPausedChapters", {
          progress: progressText,
        });
  if (status === "awaiting_user")
    return planningOnly
      ? activityText("activity.stage.sessionAwaitingOutline", {
          progress: progressText,
        })
      : activityText("activity.stage.sessionAwaitingChapters", {
          progress: progressText,
        });
  if (status === "failed")
    return planningOnly
      ? activityText("activity.stage.sessionFailedOutline", {
          progress: progressText,
        })
      : activityText("activity.stage.sessionFailedChapters", {
          progress: progressText,
        });
  if (status === "cancelled")
    return planningOnly
      ? activityText("activity.stage.sessionCancelledOutline", {
          progress: progressText,
        })
      : activityText("activity.stage.sessionCancelledChapters", {
          progress: progressText,
        });
  if (planningOnly)
    return activityText("activity.stage.sessionPlanningOutline", {
      progress: progressText,
    });
  return chapterTitle
    ? activityText("activity.stage.sessionWritingTitle", {
        title: chapterTitle,
        progress: progressText,
      })
    : activityText("activity.stage.sessionPlanningChapters", {
        progress: progressText,
      });
}

function sessionActions(status: string, reason: string | null): string[] {
  if (["pending", "planning", "running"].includes(status))
    return ["pause", "cancel"];
  if (status === "paused") return ["resume", "cancel"];
  if (status === "failed")
    return ["retry-current", "skip-chapter", "replan", "stop"];
  if (status !== "awaiting_user") return [];
  if (reason === "chapter_commit_approval_required") {
    return ["accept_manuscript", "request_revision", "cancel"];
  }
  if (reason === "scene_plan_approval_required")
    return ["accept_plan", "cancel"];
  if (reason === "settlement_conflict_requires_resolution") {
    return ["cancel"];
  }
  return ["cancel"];
}

function latestRunReason(snapshot: RunSnapshot): string | null {
  const event = [...snapshot.events]
    .reverse()
    .find((candidate) => candidate.type === `run.${snapshot.run.status}`);
  return typeof event?.payload.reason === "string"
    ? event.payload.reason
    : null;
}

function assistantContext(
  value: unknown,
  outlineNodeId: string | null,
): AssistantContext | null {
  if (!isRecord(value) || typeof value.surface !== "string") return null;
  const selection =
    isRecord(value.selection) &&
    typeof value.selection.start === "number" &&
    typeof value.selection.end === "number"
      ? {
          start: value.selection.start,
          end: value.selection.end,
          text: null,
        }
      : null;
  return {
    surface: value.surface,
    documentId: typeof value.documentId === "string" ? value.documentId : null,
    outlineNodeId,
    canonSpread:
      typeof value.canonSpread === "string" &&
      [
        "intent",
        "outline",
        "entities",
        "facts",
        "relations",
        "timeline",
        "foreshadows",
      ].includes(value.canonSpread)
        ? (value.canonSpread as AssistantContext["canonSpread"])
        : null,
    selection,
  };
}

function errorCode(value: unknown): string | null {
  return isRecord(value) && typeof value.code === "string" ? value.code : null;
}

function stringValue(value: unknown, key: string): string | null {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
