import {
  AssistantActivitySchema,
  AssistantToolCallSchema,
  type AssistantActivityArtifactDto,
  type AssistantActivityDto,
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
import { getBuiltinAgentSkill } from "./agent-skill-registry.js";
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
            ? `规划后续 ${session.targetChapters} 章大纲`
            : `AI 快速创作 ${session.targetChapters} 章`,
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
                ? `已规划 ${session.targetChapters} 章大纲`
                : `已完成 ${session.completedChapters} 章`
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
          skillLabel: null,
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
      skillLabel: null,
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
      goal: activity.goal,
      stage: toolStage(activity),
      summary: resultSummary(activity),
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
      skillLabel: activity.skillId
        ? (getBuiltinAgentSkill(activity.skillId)?.label ?? null)
        : null,
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
        ? "你修改了任务依赖的内容，任务已暂停；继续后将基于最新状态重新读取"
        : activity.status === "failed"
          ? stringValue(activity.error, "message")
          : null;
    return AssistantActivitySchema.parse({
      id: `assistant_goal:${activity.id}`,
      conversationId: activity.conversationId,
      kind: "long_goal",
      layer: "primary",
      status,
      goal: activity.goal,
      stage: longGoalStage(goal, activity),
      summary:
        goal?.status === "completed"
          ? `已完成长期任务：${activity.goal}`
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
      skillLabel: activity.skillId
        ? (getBuiltinAgentSkill(activity.skillId)?.label ?? null)
        : null,
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
): string {
  if (!goal) return toolStage(activity);
  if (goal.status === "paused_baseline") return "基线已变化，等待你继续或取消";
  if (goal.status === "completed") return "长期任务已完成";
  if (goal.status === "failed") return "长期任务需要处理失败";
  if (goal.status === "cancelled") return "长期任务已取消";
  const phases: Record<AssistantLongGoal["phase"], string> = {
    foundation: "整理故事方向",
    outline: "补齐章节大纲",
    writing: "连续创作章节",
    done: "已完成",
  };
  return `复合任务 · ${phases[goal.phase]}`;
}

function runGoal(run: NarrativeRun, story: SqliteStoryRepository): string {
  const target = run.targetOutlineNodeId
    ? story.getOutlineNode(run.projectId, run.targetOutlineNodeId)
    : null;
  if (run.recipe === "assistant-turn") return "理解你的请求";
  if (run.recipe === "book-foundation") return "整理故事方向";
  if (run.recipe === "rolling-outline") return "规划后续章节";
  if (run.recipe === "canon-spread-candidate") return "整理故事圣经候选修改";
  if (run.recipe === "chapter-production") {
    return target ? `完成《${target.title}》` : "完成当前章节";
  }
  if (run.recipe === "selection-edit") return "修改选中文本";
  if (run.recipe === "cocreate-reply") return "继续共创回合";
  if (run.recipe === "scene-adoption") return "采纳共创片段";
  if (run.recipe === "import-analysis") return "分析导入稿件";
  return "后台创作任务";
}

function runStage(snapshot: RunSnapshot): string {
  if (snapshot.run.status === "pending") return "等待开始";
  if (snapshot.run.status === "paused") return "已暂停";
  if (snapshot.run.status === "awaiting_user") return "等待你确认";
  if (snapshot.run.status === "completed") return "已完成";
  if (snapshot.run.status === "cancelled") return "已取消";
  if (
    snapshot.run.status === "failed" ||
    snapshot.run.status === "failed_recoverable"
  ) {
    return "需要处理失败";
  }
  const current = snapshot.steps.find(
    (step) => step.id === snapshot.run.currentStepId,
  );
  return current ? stepLabel(current.kind) : "正在准备";
}

function stepLabel(kind: string): string {
  const labels: Record<string, string> = {
    "assistant.context": "正在读取当前作品",
    "assistant.respond": "正在理解并组织回复",
    "assistant.stage": "正在整理结果",
    "canon.context": "正在读取当前故事板块",
    "canon.candidate": "正在整理候选修改",
    "canon.stage": "正在保存待采纳候选",
    "foundation.generate": "正在整理故事方向",
    "outline.generate": "正在规划后续章节",
    "context.compile": "正在装配本章上下文",
    "scene.plan": "正在规划本章",
    "draft.generate": "正在写作正文",
    "deterministic.check": "正在检查正文",
    "semantic.review": "正在轻量审稿",
    "revision.generate": "正在修订正文",
    "chapter.settle": "正在结算故事状态",
    "chapter.commit": "正在保存本章",
  };
  return labels[kind] ?? "正在处理";
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
    "故事方向候选",
  );
  push("canon_change_set", result.canonChangeSetId, "故事圣经候选修改");
  push("edit_proposal", result.editProposalId, "选区修改候选");
  push("document_version", result.documentVersionId, "正文版本");
  push("revision_proposal", result.revisionProposalId, "修订提案");
  push("cocreate_turn", result.cocreateTurnId, "共创回合");
  push("import_batch", result.importBatchId, "导入批次");
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
  return reason ? { code: reason, message: stopReasonLabel(reason) } : null;
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
          label: "当前章节",
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
      typeof error.message === "string" && error.message
        ? error.message
        : stopReasonLabel(code);
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
): string | null {
  if (run.status !== "completed") return null;
  if (typeof result.documentVersionId === "string") return "正文版本已经保存";
  if (typeof result.foundationCandidateSetId === "string")
    return "故事方向候选已经生成";
  if (typeof result.canonCandidateSetId === "string")
    return "故事圣经候选修改已经生成";
  if (typeof result.editProposalId === "string") return "选区修改候选已经生成";
  return "任务已经完成";
}

function sessionStage(
  status: string,
  completed: number,
  target: number,
  chapterTitle: string | null,
  planningOnly: boolean,
): string {
  const unit = planningOnly ? "章大纲" : "章";
  if (status === "completed") return `已完成 ${completed}/${target} ${unit}`;
  if (status === "paused") return `已暂停 · ${completed}/${target} ${unit}`;
  if (status === "awaiting_user")
    return `等待确认 · ${completed}/${target} ${unit}`;
  if (status === "failed")
    return `需要处理失败 · ${completed}/${target} ${unit}`;
  if (status === "cancelled") return `已结束 · ${completed}/${target} ${unit}`;
  if (planningOnly) return `正在规划 · ${completed}/${target} 章大纲`;
  return chapterTitle
    ? `正在创作《${chapterTitle}》 · ${completed}/${target} 章`
    : `正在规划 · ${completed}/${target} 章`;
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

function stopReasonLabel(reason: string): string {
  const labels: Record<string, string> = {
    scene_plan_approval_required: "本章细纲等待确认",
    chapter_commit_approval_required: "正文候选等待采纳",
    settlement_conflict_requires_resolution: "故事变化存在冲突，等待裁定",
    request_start_timeout: "模型首响应超时，可以重试",
    session_cancelled: "快速创作已经取消",
  };
  return labels[reason] ?? reason;
}

function toolStage(activity: AssistantActivity): string {
  if (activity.status === "proposed") return "等待你确认";
  if (activity.status === "running") {
    if (activity.executionMode === "auto") return "正在交办";
    return "正在执行";
  }
  if (activity.status === "completed") {
    return activity.executionMode === "auto"
      ? "已交办到现有任务链路"
      : "已交给现有任务链路";
  }
  if (activity.status === "rejected") return "已拒绝";
  if (activity.status === "cancelled") return "已取消";
  return "执行失败";
}

function resultSummary(activity: AssistantActivity): string | null {
  if (activity.status === "completed") {
    return activity.executionMode === "auto"
      ? "已交办并关联任务"
      : "已创建并关联任务";
  }
  if (activity.status === "rejected") return "你没有执行这项建议";
  return null;
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
