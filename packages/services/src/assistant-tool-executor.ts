import { sha256Hex } from "@narralume/domain";

import {
  AUTOMATION_DEFAULTS,
  resolveEffectivePolicy,
} from "@narralume/contracts";
import {
  buildCanonCandidateRecipe,
  buildSelectionEditRecipe,
  compileChapterRecipeTemplate,
} from "@narralume/harness";
import {
  AssistantPersistenceError,
  SqliteAssistantRepository,
  SqliteAutomationRepository,
  SqliteDocumentRepository,
  SqliteProjectRepository,
  SqliteReviewRepository,
  SqliteRunRepository,
  SqliteStoryRepository,
  SqliteTemplateRepository,
  type AssistantActivity,
  type NarrativeDatabase,
  type StoredAssistantContext,
} from "@narralume/persistence";

import type { AutopilotCoordinator } from "./autopilot-coordinator.js";
import type { LongGoalCoordinator } from "./long-goal-coordinator.js";
import type { RunCoordinator } from "./run-coordinator.js";
import {
  AutomationServiceError,
  createFoundationRun,
  requireWritingAssignment,
  resolveSessionFailure,
  withRuntimeModelPolicy,
} from "./index.js";

export interface AssistantToolExecutionResult {
  source: { type: "run" | "autopilot" | "long_goal"; id: string };
  result: Readonly<Record<string, unknown>>;
}

export interface AssistantToolExecutorOptions {
  runCoordinator: RunCoordinator;
  autopilotCoordinator: AutopilotCoordinator;
  longGoalCoordinator?: LongGoalCoordinator;
  enableBackgroundWorker: boolean;
  environment: Readonly<Record<string, string | undefined>>;
}

export class AssistantToolExecutor {
  private readonly assistants: SqliteAssistantRepository;
  private readonly automation: SqliteAutomationRepository;
  private readonly documents: SqliteDocumentRepository;
  private readonly projects: SqliteProjectRepository;
  private readonly reviews: SqliteReviewRepository;
  private readonly runs: SqliteRunRepository;
  private readonly story: SqliteStoryRepository;
  private readonly templates: SqliteTemplateRepository;

  constructor(
    private readonly database: NarrativeDatabase,
    private readonly options: AssistantToolExecutorOptions,
  ) {
    this.assistants = new SqliteAssistantRepository(database);
    this.automation = new SqliteAutomationRepository(database);
    this.documents = new SqliteDocumentRepository(database);
    this.projects = new SqliteProjectRepository(database);
    this.reviews = new SqliteReviewRepository(database);
    this.runs = new SqliteRunRepository(database);
    this.story = new SqliteStoryRepository(database);
    this.templates = new SqliteTemplateRepository(database);
  }

  execute(activity: AssistantActivity): AssistantToolExecutionResult {
    const conversation = this.assistants.requireConversation(
      activity.conversationId,
    );
    const project = this.projects.get(conversation.projectId);
    if (!project) {
      throw new AssistantToolExecutionError(
        "project.not_found",
        "Project not found",
        404,
      );
    }
    if (
      activity.toolName === "story.inspect" ||
      activity.toolName === "review.inspect"
    ) {
      throw new AssistantToolExecutionError(
        "assistant.tool.read_only",
        "Read-only queries do not need delegated execution",
        409,
      );
    }
    if (activity.toolName === "foundation.start") {
      return this.startFoundation(activity, project.id);
    }
    if (activity.toolName === "chapter.start") {
      return this.startChapter(activity, project.id);
    }
    if (activity.toolName === "autopilot.start") {
      return this.startAutopilot(activity, project.id);
    }
    if (activity.toolName === "outline.plan.start") {
      return this.startOutlinePlan(activity, project.id);
    }
    if (activity.toolName === "canon.candidate.start") {
      return this.startCanonCandidate(activity, project.id);
    }
    if (activity.toolName === "selection.edit.start") {
      return this.startSelectionEdit(activity, project.id);
    }
    if (activity.toolName === "long_goal.start") {
      return this.startLongGoal(activity, project.id);
    }
    return this.controlTask(activity, project.id);
  }

  /**
   * R6 直接执行语义：stage 落盘为 running 的 auto 活动，在所属
   * assistant-turn Run 完成后由这里交办。重复调用必须幂等——下游
   * Run/Session 使用以 activity.id 派生的确定性 ID。
   */
  executeAutoActivity(activityId: string): AssistantToolExecutionResult | null {
    const activity = this.assistants.getActivity(activityId);
    if (!activity || activity.status !== "running") return null;
    if (activity.executionMode !== "auto") return null;
    if (activity.sourceType !== null || activity.sourceId !== null) return null;
    const now = new Date().toISOString();
    try {
      const execution = this.execute(activity);
      this.assistants.transitionActivity(activity.id, "running", {
        status: "completed",
        result: execution.result,
        sourceType: execution.source.type,
        sourceId: execution.source.id,
        now,
      });
      return execution;
    } catch (error) {
      const current = this.assistants.requireActivity(activityId);
      if (current.status === "running") {
        this.assistants.transitionActivity(activityId, "running", {
          status: "failed",
          error: {
            code: errorCode(error),
            message: errorMessage(error),
          },
          now,
        });
      }
      return null;
    }
  }

  /**
   * Run 终态回调：交办该 assistant-turn 直接执行的待办活动。
   * 必须在事务外调用；只读取并执行，失败落盘为 failed 供原活动重试。
   */
  runAutoActivitiesForTurn(runId: string): void {
    const activityId = `${runId}:tool`;
    const activity = this.assistants.getActivity(activityId);
    if (!activity || activity.status !== "running") return;
    if (activity.executionMode !== "auto") return;
    if (activity.sourceType !== null || activity.sourceId !== null) return;
    const now = new Date().toISOString();
    try {
      const execution = this.execute(activity);
      this.assistants.transitionActivity(activity.id, "running", {
        status: "completed",
        result: execution.result,
        sourceType: execution.source.type,
        sourceId: execution.source.id,
        now,
      });
    } catch (error) {
      const current = this.assistants.requireActivity(activityId);
      if (current.status === "running") {
        this.assistants.transitionActivity(activityId, "running", {
          status: "failed",
          error: {
            code: errorCode(error),
            message: errorMessage(error),
          },
          now,
        });
      }
    }
  }

  private startFoundation(
    activity: AssistantActivity,
    projectId: string,
  ): AssistantToolExecutionResult {
    requireWritingAssignment(this.database, this.options.environment);
    const runId = deterministicId("assistant-foundation", activity.id);
    const existing = this.runs.getRun(runId);
    if (!existing) {
      const braindump = requiredString(activity.input, "braindump");
      const root = this.story
        .listOutline(projectId)
        .find((node) => node.kind === "book");
      createFoundationRun({
        runs: this.runs,
        runId,
        projectId,
        rootOutlineNodeId: root?.id ?? null,
        braindump,
        preferences: {
          genre: null,
          audience: null,
          tone: null,
          ...AUTOMATION_DEFAULTS,
        },
        policy: assistantPolicy(activity),
        origin: runOrigin(activity.origin),
        environment: this.options.environment,
        now: new Date().toISOString(),
      });
      this.wakeRuns();
    } else if (existing.projectId !== projectId) {
      throw sourceCollision(runId);
    }
    return {
      source: { type: "run", id: runId },
      result: {
        recipe: "book-foundation",
        status: this.runs.getRun(runId)!.status,
      },
    };
  }

  private startChapter(
    activity: AssistantActivity,
    projectId: string,
  ): AssistantToolExecutionResult {
    requireWritingAssignment(this.database, this.options.environment);
    const targetOutlineNodeId = requiredString(
      activity.input,
      "targetOutlineNodeId",
    );
    const target = this.story.requireOutlineNode(
      projectId,
      targetOutlineNodeId,
    );
    if (target.kind !== "chapter") {
      throw new AssistantToolExecutionError(
        "run.target.not_chapter",
        "Chapter production requires a chapter outline node",
        422,
      );
    }
    const runId = deterministicId("assistant-chapter", activity.id);
    const existing = this.runs.getRun(runId);
    if (!existing) {
      this.requireNoActiveWritingTask(projectId);
      const template = this.templates.getByKey("recipe.chapter-production");
      if (!template) {
        throw new AssistantToolExecutionError(
          "recipe.template.missing",
          "Chapter production recipe template not found",
          500,
        );
      }
      const maxRevisionCycles = 2;
      const recipe = compileChapterRecipeTemplate(
        runId,
        template.effectiveContent,
        maxRevisionCycles,
        template.version,
      );
      const policy = withRuntimeModelPolicy(
        {
          ...assistantPolicy(activity),
          planningMode: "auto",
          origin: runOrigin(activity.origin),
          creationRequestId: activity.id,
          creationRequestHash: hashStable(activity.input),
        },
        this.options.environment,
      );
      this.runs.create({
        id: runId,
        projectId,
        recipe: recipe.name,
        recipeVersion: recipe.version,
        mode: "chapter-gate",
        targetOutlineNodeId,
        policy,
        steps: recipe.steps,
        now: new Date().toISOString(),
      });
      this.wakeRuns();
    } else if (existing.projectId !== projectId) {
      throw sourceCollision(runId);
    }
    return {
      source: { type: "run", id: runId },
      result: {
        recipe: "chapter-production",
        targetOutlineNodeId,
        status: this.runs.getRun(runId)!.status,
      },
    };
  }

  private startAutopilot(
    activity: AssistantActivity,
    projectId: string,
  ): AssistantToolExecutionResult {
    requireWritingAssignment(this.database, this.options.environment);
    const sessionId = deterministicId("assistant-autopilot", activity.id);
    const existing = this.automation.getSession(sessionId);
    if (!existing) {
      this.requireNoActiveWritingTask(projectId);
      const targetChapters = requiredInteger(
        activity.input,
        "targetChapters",
        1,
        50,
      );
      const approvalMode = requiredEnum(activity.input, "approvalMode", [
        "continuous",
        "per_chapter",
      ] as const);
      const { effectivePolicy } = resolveEffectivePolicy({});
      this.automation.createSession({
        id: sessionId,
        projectId,
        mode: approvalMode === "continuous" ? "autopilot" : "chapter-gate",
        targetChapters,
        windowSize: Math.min(5, targetChapters),
        maxRevisionCycles: 2,
        chapterPolicy: {
          ...effectivePolicy,
          explicitPolicyFields: [],
          planningMode: "auto",
          origin: runOrigin(activity.origin),
          assistantConversationId: activity.conversationId,
          assistantActivityId: activity.id,
          creationRequestId: activity.id,
          creationRequestHash: hashStable(activity.input),
        },
        now: new Date().toISOString(),
      });
      this.wakeAutopilot();
    } else if (existing.projectId !== projectId) {
      throw sourceCollision(sessionId);
    }
    const session = this.automation.requireSession(sessionId);
    return {
      source: { type: "autopilot", id: sessionId },
      result: {
        targetChapters: session.targetChapters,
        approvalMode:
          session.mode === "autopilot" ? "continuous" : "per_chapter",
        status: session.status,
      },
    };
  }

  private startOutlinePlan(
    activity: AssistantActivity,
    projectId: string,
  ): AssistantToolExecutionResult {
    requireWritingAssignment(this.database, this.options.environment);
    const sessionId = deterministicId("assistant-outline-plan", activity.id);
    const existing = this.automation.getSession(sessionId);
    if (!existing) {
      this.requireNoActiveWritingTask(projectId);
      const targetChapters = requiredInteger(
        activity.input,
        "targetChapters",
        1,
        20,
      );
      const { effectivePolicy } = resolveEffectivePolicy({});
      this.automation.createSession({
        id: sessionId,
        projectId,
        mode: "autopilot",
        targetChapters,
        windowSize: Math.min(5, targetChapters),
        maxRevisionCycles: 2,
        chapterPolicy: {
          ...effectivePolicy,
          explicitPolicyFields: [],
          planningMode: "auto",
          planningOnly: true,
          origin: runOrigin(activity.origin),
          assistantConversationId: activity.conversationId,
          assistantActivityId: activity.id,
          creationRequestId: activity.id,
          creationRequestHash: hashStable(activity.input),
        },
        now: new Date().toISOString(),
      });
      this.wakeAutopilot();
    } else if (existing.projectId !== projectId) {
      throw sourceCollision(sessionId);
    }
    const session = this.automation.requireSession(sessionId);
    return {
      source: { type: "autopilot", id: sessionId },
      result: {
        targetChapters: session.targetChapters,
        planningOnly: true,
        status: session.status,
      },
    };
  }

  private startCanonCandidate(
    activity: AssistantActivity,
    projectId: string,
  ): AssistantToolExecutionResult {
    requireWritingAssignment(this.database, this.options.environment);
    const spread = requiredEnum(activity.input, "spread", [
      "intent",
      "outline",
      "entities",
      "facts",
      "relations",
      "timeline",
      "foreshadows",
    ] as const);
    const instruction = requiredString(activity.input, "instruction");
    const runId = deterministicId("assistant-canon-candidate", activity.id);
    const existing = this.runs.getRun(runId);
    if (!existing) {
      const requestHash = hashStable({ spread, instruction });
      const activeRun = this.runs
        .listActiveRuns(projectId)
        .find(
          (candidate) =>
            candidate.recipe === "canon-spread-candidate" &&
            candidate.policy.canonSpread === spread,
        );
      if (activeRun) {
        throw new AssistantToolExecutionError(
          "canon_candidate.active_run_exists",
          `The current Canon spread already has an active candidate run: ${activeRun.id}`,
          409,
        );
      }
      const recipe = buildCanonCandidateRecipe(runId);
      this.runs.create({
        id: runId,
        projectId,
        recipe: recipe.name,
        recipeVersion: recipe.version,
        mode: "manual",
        targetOutlineNodeId: null,
        policy: withRuntimeModelPolicy(
          {
            canonSpread: spread,
            canonInstruction: instruction,
            canonMaxOutputTokens: 6_000,
            origin: {
              ...runOrigin(activity.origin),
              surface: activity.origin?.surface ?? "bible",
              canonSpread: spread,
            },
            assistantConversationId: activity.conversationId,
            assistantActivityId: activity.id,
            creationRequestId: activity.id,
            creationRequestHash: requestHash,
          },
          this.options.environment,
        ),
        steps: recipe.steps,
        now: new Date().toISOString(),
      });
      this.wakeRuns();
    } else if (existing.projectId !== projectId) {
      throw sourceCollision(runId);
    }
    return {
      source: { type: "run", id: runId },
      result: {
        recipe: "canon-spread-candidate",
        spread,
        status: this.runs.getRun(runId)!.status,
      },
    };
  }

  private startSelectionEdit(
    activity: AssistantActivity,
    projectId: string,
  ): AssistantToolExecutionResult {
    requireWritingAssignment(this.database, this.options.environment);
    const documentId = requiredString(activity.input, "documentId");
    const selectionStart = requiredInteger(
      activity.input,
      "selectionStart",
      0,
      1_000_000,
    );
    const selectionEnd = requiredInteger(
      activity.input,
      "selectionEnd",
      0,
      1_000_000,
    );
    const instruction = requiredString(activity.input, "instruction");
    const document = this.documents.get(projectId, documentId);
    if (!document) {
      throw new AssistantToolExecutionError(
        "document.not_found",
        "The document does not exist in this project",
        404,
      );
    }
    if (!document.currentVersionId) {
      throw new AssistantToolExecutionError(
        "document.version.missing",
        "This manuscript has no manuscript version to use as a baseline",
        409,
      );
    }
    const baseVersion = this.documents.getVersion(
      projectId,
      documentId,
      document.currentVersionId,
    );
    if (!baseVersion) {
      throw new AssistantToolExecutionError(
        "document.version.not_found",
        "Selection base version not found",
        404,
      );
    }
    if (
      selectionEnd <= selectionStart ||
      selectionEnd > [...baseVersion.content].length
    ) {
      throw new AssistantToolExecutionError(
        "edit.selection.invalid",
        "The selection is outside the current manuscript; re-select and try again",
        422,
      );
    }
    const runId = deterministicId("assistant-selection-edit", activity.id);
    const existing = this.runs.getRun(runId);
    if (!existing) {
      const recipe = buildSelectionEditRecipe(runId);
      this.runs.create({
        id: runId,
        projectId,
        recipe: recipe.name,
        recipeVersion: recipe.version,
        mode: "manual",
        targetOutlineNodeId: null,
        policy: withRuntimeModelPolicy(
          {
            documentId,
            baseVersionId: baseVersion.id,
            selectionStart,
            selectionEnd,
            instruction,
            editMaxOutputTokens: 4_000,
            origin: {
              surface: activity.origin?.surface ?? "assistant",
              documentId,
              selection: { start: selectionStart, end: selectionEnd },
            },
            assistantConversationId: activity.conversationId,
            assistantActivityId: activity.id,
            creationRequestId: activity.id,
            creationRequestHash: hashStable(activity.input),
          },
          this.options.environment,
        ),
        steps: recipe.steps,
        now: new Date().toISOString(),
      });
      this.wakeRuns();
    } else if (existing.projectId !== projectId) {
      throw sourceCollision(runId);
    }
    return {
      source: { type: "run", id: runId },
      result: {
        recipe: "selection-edit",
        documentId,
        status: this.runs.getRun(runId)!.status,
      },
    };
  }

  private startLongGoal(
    activity: AssistantActivity,
    projectId: string,
  ): AssistantToolExecutionResult {
    const coordinator = this.options.longGoalCoordinator;
    if (!coordinator) {
      throw new AssistantToolExecutionError(
        "assistant.long_goal.unavailable",
        "The composite creation coordinator is not enabled",
        503,
      );
    }
    requireWritingAssignment(this.database, this.options.environment);
    const targetChapters = requiredInteger(
      activity.input,
      "targetChapters",
      1,
      50,
    );
    const braindump =
      typeof activity.input.braindump === "string"
        ? activity.input.braindump
        : null;
    const goalId = `${activity.id}:goal`;
    const existing = coordinator.getGoal(goalId);
    if (existing) {
      if (existing.projectId !== projectId) throw sourceCollision(goalId);
      return {
        source: { type: "long_goal", id: existing.id },
        result: {
          goalId: existing.id,
          phase: existing.phase,
          status: existing.status,
          targetChapters: existing.targetChapters,
        },
      };
    }
    const goal = coordinator.startGoal({
      goalId,
      projectId,
      conversationId: activity.conversationId,
      activityId: `${goalId}:activity`,
      title: activity.goal,
      targetChapters,
      braindump,
      now: new Date().toISOString(),
    });
    return {
      source: { type: "long_goal", id: goal.id },
      result: {
        goalId: goal.id,
        phase: goal.phase,
        status: goal.status,
        targetChapters: goal.targetChapters,
      },
    };
  }

  private controlTask(
    activity: AssistantActivity,
    projectId: string,
  ): AssistantToolExecutionResult {
    const sourceType = requiredEnum(activity.input, "sourceType", [
      "run",
      "autopilot",
    ] as const);
    const sourceId = requiredString(activity.input, "sourceId");
    const action = requiredEnum(activity.input, "action", [
      "pause",
      "resume",
      "cancel",
      "retry-current",
      "skip-chapter",
      "replan",
      "stop",
    ] as const);
    const now = new Date().toISOString();
    if (sourceType === "run") {
      const run = this.runs.getRun(sourceId);
      if (!run || run.projectId !== projectId) {
        throw new AssistantToolExecutionError(
          "run.not_found",
          "The run does not exist in this project",
          404,
        );
      }
      if (action === "cancel") {
        if (!isTerminalRunStatus(run.status)) {
          this.database.transaction(() => {
            this.runs.requestCancel(sourceId, now);
            this.reviews.supersedeRunRevisionProposals(sourceId, now);
          });
          this.options.runCoordinator.interrupt(
            sourceId,
            "assistant_cancelled",
          );
        }
      } else if (action === "pause") {
        if (!isTerminalRunStatus(run.status) && run.status !== "paused") {
          this.runs.requestPause(sourceId, now);
        }
      } else if (run.status === "paused") {
        this.runs.resume(sourceId, now);
      } else if (run.status === "failed_recoverable") {
        throw new AssistantToolExecutionError(
          "assistant.tool.action_unavailable",
          "This run is waiting for an automatic retry or a partial-manuscript decision and cannot be resumed directly",
          409,
        );
      } else if (run.status !== "running" && run.status !== "pending") {
        throw terminalControl("Run", run.status, action);
      }
      this.wakeRuns();
      return {
        source: { type: "run", id: sourceId },
        result: { action, status: this.runs.getRun(sourceId)!.status },
      };
    }

    const session = this.automation.getSession(sourceId);
    if (!session || session.projectId !== projectId) {
      throw new AssistantToolExecutionError(
        "autopilot_session.not_found",
        "The writing session does not exist in this project",
        404,
      );
    }
    if (isSessionResolutionAction(action)) {
      if (session.status !== "failed") {
        throw terminalControl("Autopilot session", session.status, action);
      }
      if (session.lastError?.code === "child.fatal" && action !== "stop") {
        requireWritingAssignment(this.database, this.options.environment);
      }
      try {
        this.database.transaction(() => {
          resolveSessionFailure(
            this.automation,
            this.runs,
            this.story,
            sourceId,
            action,
          );
        });
      } catch (error) {
        if (error instanceof AutomationServiceError) {
          throw new AssistantToolExecutionError(
            error.code,
            error.message,
            error.statusCode,
          );
        }
        throw error;
      }
      this.wakeAutopilot();
      return {
        source: { type: "autopilot", id: sourceId },
        result: {
          action,
          status: this.automation.requireSession(sourceId).status,
        },
      };
    }
    if (action === "cancel") {
      if (!isTerminalSessionStatus(session.status)) {
        this.automation.requestSessionControl(sourceId, "cancel", now);
        if (session.currentRunId) {
          this.reviews.supersedeRunRevisionProposals(session.currentRunId, now);
          this.options.runCoordinator.interrupt(
            session.currentRunId,
            "session_cancelled",
          );
        }
      }
    } else if (action === "pause") {
      if (
        !isTerminalSessionStatus(session.status) &&
        session.status !== "paused"
      ) {
        this.automation.requestSessionControl(sourceId, "pause", now);
      }
    } else if (session.status === "paused") {
      if (session.currentRunId) {
        const child = this.runs.getRun(session.currentRunId);
        if (child?.status === "paused") this.runs.resume(child.id, now);
      }
      this.automation.resumeSession(sourceId, now);
    } else if (!["pending", "planning", "running"].includes(session.status)) {
      throw terminalControl("Writing session", session.status, action);
    }
    this.wakeRuns();
    this.wakeAutopilot();
    return {
      source: { type: "autopilot", id: sourceId },
      result: {
        action,
        status: this.automation.requireSession(sourceId).status,
      },
    };
  }

  private requireNoActiveWritingTask(projectId: string): void {
    const session = this.automation
      .listSessions(projectId)
      .find((candidate) => !isTerminalSessionStatus(candidate.status));
    if (session) {
      throw new AssistantToolExecutionError(
        "project.writing_task.active",
        `The project already has an active autopilot session: ${session.id}`,
        409,
      );
    }
    const run = this.runs
      .listActiveRuns(projectId)
      .find((candidate) => candidate.targetOutlineNodeId !== null);
    if (run) {
      throw new AssistantToolExecutionError(
        "project.writing_task.active",
        `The project already has an active chapter run: ${run.id}`,
        409,
      );
    }
  }

  private wakeRuns(): void {
    if (this.options.enableBackgroundWorker) this.options.runCoordinator.wake();
  }

  private wakeAutopilot(): void {
    if (this.options.enableBackgroundWorker) {
      this.options.autopilotCoordinator.wake();
    }
  }
}

export class AssistantToolExecutionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "AssistantToolExecutionError";
  }
}

function errorCode(error: unknown): string {
  if (
    error instanceof AssistantToolExecutionError ||
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

function assistantPolicy(
  activity: AssistantActivity,
): Readonly<Record<string, unknown>> {
  return {
    assistantConversationId: activity.conversationId,
    assistantActivityId: activity.id,
  };
}

function isSessionResolutionAction(
  action: string,
): action is "retry-current" | "skip-chapter" | "replan" | "stop" {
  return ["retry-current", "skip-chapter", "replan", "stop"].includes(action);
}

function runOrigin(context: StoredAssistantContext | null): {
  surface: string;
  documentId: string | null;
  selection: { start: number; end: number } | null;
} {
  return {
    surface: context?.surface ?? "assistant",
    documentId: context?.documentId ?? null,
    selection: context?.selection
      ? { start: context.selection.start, end: context.selection.end }
      : null,
  };
}

function requiredString(
  value: Readonly<Record<string, unknown>>,
  key: string,
): string {
  const entry = value[key];
  if (typeof entry !== "string" || !entry.trim()) {
    throw invalidArguments(key);
  }
  return entry;
}

function requiredInteger(
  value: Readonly<Record<string, unknown>>,
  key: string,
  minimum: number,
  maximum: number,
): number {
  const entry = value[key];
  if (
    typeof entry !== "number" ||
    !Number.isInteger(entry) ||
    entry < minimum ||
    entry > maximum
  ) {
    throw invalidArguments(key);
  }
  return entry;
}

function requiredEnum<const T extends readonly string[]>(
  value: Readonly<Record<string, unknown>>,
  key: string,
  choices: T,
): T[number] {
  const entry = value[key];
  if (typeof entry !== "string" || !choices.includes(entry)) {
    throw invalidArguments(key);
  }
  return entry;
}

function invalidArguments(key: string): AssistantToolExecutionError {
  return new AssistantToolExecutionError(
    "assistant.tool.arguments_invalid",
    `Invalid tool argument: ${key}`,
    422,
  );
}

function deterministicId(kind: string, activityId: string): string {
  const hex = sha256Hex(`${kind}\0${activityId}`);
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

function isTerminalRunStatus(status: string): boolean {
  return ["completed", "failed", "cancelled"].includes(status);
}

function isTerminalSessionStatus(status: string): boolean {
  return ["completed", "cancelled"].includes(status);
}

function sourceCollision(id: string): AssistantToolExecutionError {
  return new AssistantToolExecutionError(
    "assistant.tool.source_collision",
    `Deterministic task id ${id} is already used by another project`,
    409,
  );
}

function terminalControl(
  label: string,
  status: string,
  action: string,
): AssistantToolExecutionError {
  return new AssistantToolExecutionError(
    "assistant.tool.task_terminal",
    `${label} is in state "${status}" and cannot be ${action}`,
    409,
  );
}
