import { randomUuid } from "@narralume/domain";

import {
  buildRollingOutlineRecipe,
  classifyStepError,
  compileChapterRecipeTemplate,
} from "@narralume/harness";
import {
  SqliteAutomationRepository,
  SqliteProjectRepository,
  SqliteRunRepository,
  SqliteStoryRepository,
  SqliteTemplateRepository,
  type NarrativeDatabase,
} from "@narralume/persistence";

import type { RunCoordinator } from "./run-coordinator.js";
import { withRuntimeModelPolicy } from "./run-policy.js";

export class AutopilotCoordinator {
  private readonly automation: SqliteAutomationRepository;
  private readonly runs: SqliteRunRepository;
  private readonly story: SqliteStoryRepository;
  private readonly projects: SqliteProjectRepository;
  private readonly templates: SqliteTemplateRepository;
  readonly #controller = new AbortController();
  #draining: Promise<void> | null = null;
  #wakeAgain = false;

  constructor(
    database: NarrativeDatabase,
    private readonly runCoordinator: RunCoordinator,
    private readonly onChange: (
      sessionId: string,
      action: string,
    ) => void = () => undefined,
    private readonly onError: (error: unknown) => void = () => undefined,
    private readonly now: () => Date = () => new Date(),
    private readonly autoRunWorker = true,
    private readonly environment: Readonly<
      Record<string, string | undefined>
    > = {},
  ) {
    this.automation = new SqliteAutomationRepository(database);
    this.runs = new SqliteRunRepository(database);
    this.story = new SqliteStoryRepository(database);
    this.projects = new SqliteProjectRepository(database);
    this.templates = new SqliteTemplateRepository(database);
  }

  wake(): void {
    if (this.#controller.signal.aborted) return;
    if (this.#draining) {
      this.#wakeAgain = true;
      return;
    }
    this.#draining = this.drain().finally(() => {
      this.#draining = null;
      if (this.#wakeAgain) {
        this.#wakeAgain = false;
        this.wake();
      }
    });
  }

  async advanceSession(sessionId: string): Promise<boolean> {
    if (this.#controller.signal.aborted) return false;
    const now = this.now().toISOString();
    this.automation.reconcileSteerClassifications(sessionId, now);
    const session = this.automation.requireSession(sessionId);
    if (["completed", "cancelled", "failed"].includes(session.status)) {
      return false;
    }
    if (["paused", "awaiting_user"].includes(session.status)) {
      return false;
    }
    if (session.cancelRequested) {
      if (session.currentRunId) {
        const child = this.runs.getSnapshot(session.currentRunId).run;
        if (!["completed", "failed", "cancelled"].includes(child.status)) {
          if (!child.cancelRequested) {
            this.runs.requestCancel(child.id, now);
            this.runCoordinator.interrupt(child.id, "autopilot_cancelled");
            this.wakeRunWorker();
            return this.changed(session.id, "child.cancel_requested");
          }
          return false;
        }
        this.automation.markRunProcessed(
          session.id,
          child.id,
          child.status,
          now,
        );
      }
      this.automation.setSessionStatus(session.id, "cancelled", now);
      return this.changed(session.id, "session.cancelled");
    }

    if (session.pauseRequested) {
      if (session.currentRunId) {
        const child = this.runs.getSnapshot(session.currentRunId).run;
        if (
          ["pending", "running", "failed_recoverable"].includes(child.status)
        ) {
          if (!child.pauseRequested) {
            this.runs.requestPause(child.id, now);
            this.wakeRunWorker();
            return this.changed(session.id, "child.pause_requested");
          }
          return false;
        }
      }
      this.automation.setSessionStatus(session.id, "paused", now);
      return this.changed(session.id, "session.paused");
    }

    const steer = this.automation.listClassifiedSteers(session.id)[0];
    if (steer) return this.applySteer(session.id, steer.id, now);

    if (session.currentRunId) {
      return this.reconcileChild(session.id, session.currentRunId, now);
    }

    if (session.replanRequested) {
      this.abandonSessionPlans(session.id, now);
      this.automation.clearReplan(session.id, now);
      return this.changed(session.id, "outline.replan_prepared");
    }

    const current = this.automation.requireSession(session.id);
    if (current.completedChapters >= current.targetChapters) {
      this.automation.setSessionStatus(current.id, "completed", now);
      return this.changed(current.id, "session.completed");
    }

    const nextChapter = this.nextChapter(current.id);
    if (nextChapter) {
      const notes = this.automation.consumeActiveNotes(current.id, now);
      const runId = randomUuid();
      const template = this.templates.getByKey("recipe.chapter-production");
      if (!template) {
        this.automation.setSessionStatus(current.id, "failed", now, {
          code: "recipe.template.missing",
          message: "The chapter production recipe template does not exist",
        });
        return this.changed(current.id, "session.failed");
      }
      const recipe = compileChapterRecipeTemplate(
        runId,
        template.effectiveContent,
        current.maxRevisionCycles,
        template.version,
      );
      this.runs.create({
        id: runId,
        projectId: current.projectId,
        recipe: recipe.name,
        recipeVersion: recipe.version,
        mode: current.mode,
        targetOutlineNodeId: nextChapter.id,
        policy: withRuntimeModelPolicy(
          {
            ...resolveSessionEffectivePolicy(current),
            chapterApproved: current.mode === "autopilot",
            steerNotes: notes,
            autopilotSessionId: current.id,
          },
          this.environment,
        ),
        steps: recipe.steps,
        now,
      });
      this.automation.attachRun(current.id, {
        runId,
        role: "chapter",
        outlineNodeId: nextChapter.id,
        now,
      });
      this.story.updateOutlineStatus(
        current.projectId,
        nextChapter.id,
        "drafting",
        now,
      );
      const project = this.projects.get(current.projectId);
      if (project && project.phase !== "writing") {
        this.projects.update({ ...project, phase: "writing", updatedAt: now });
      }
      this.wakeRunWorker();
      return this.changed(current.id, "chapter.started");
    }

    const root = this.story
      .listOutline(current.projectId)
      .find((node) => node.kind === "book");
    if (!root) {
      this.automation.setSessionStatus(current.id, "failed", now, {
        code: "outline.root.missing",
        message: "The project is missing the book root node",
      });
      return this.changed(current.id, "session.failed");
    }
    const runId = randomUuid();
    const recipe = buildRollingOutlineRecipe(runId);
    this.runs.create({
      id: runId,
      projectId: current.projectId,
      recipe: recipe.name,
      recipeVersion: recipe.version,
      mode: "autopilot",
      targetOutlineNodeId: root.id,
      policy: withRuntimeModelPolicy(
        {
          ...resolveSessionEffectivePolicy(current),
          sessionId: current.id,
        },
        this.environment,
      ),
      steps: recipe.steps,
      now,
    });
    this.automation.attachRun(current.id, {
      runId,
      role: "rolling-plan",
      outlineNodeId: root.id,
      now,
    });
    this.wakeRunWorker();
    return this.changed(current.id, "planning.started");
  }

  async stop(): Promise<void> {
    this.#controller.abort("server_stopping");
    await this.#draining;
  }

  private async drain(): Promise<void> {
    try {
      while (!this.#controller.signal.aborted) {
        let progressed = false;
        for (const session of this.automation.listActionableSessions()) {
          if (await this.advanceSession(session.id)) {
            progressed = true;
            break;
          }
        }
        if (!progressed) return;
      }
    } catch (error) {
      if (!this.#controller.signal.aborted) this.onError(error);
    }
  }

  private reconcileChild(
    sessionId: string,
    runId: string,
    now: string,
  ): boolean {
    const snapshot = this.runs.getSnapshot(runId);
    const child = snapshot.run;
    const link = this.automation.requireRunLink(sessionId, runId);
    if (["pending", "running", "failed_recoverable"].includes(child.status)) {
      this.wakeRunWorker();
      return false;
    }
    if (child.status === "paused") {
      this.automation.setSessionStatus(sessionId, "paused", now);
      return this.changed(sessionId, "child.paused");
    }
    if (child.status === "awaiting_user") {
      this.automation.setSessionStatus(sessionId, "awaiting_user", now, {
        code: "child.awaiting_user",
        runId,
        reason: latestRunReason(this.runs.getSnapshot(runId)),
      });
      return this.changed(sessionId, "child.awaiting_user");
    }
    if (child.status === "failed") {
      this.automation.markRunProcessed(sessionId, runId, "failed", now);
      // A fatal child error (authentication, permission, invalid_request, …)
      // can never succeed by spawning more children, so the session parks in
      // awaiting_user with a resolution note instead of failing outright;
      // awaiting_user sessions are neither actionable nor advanceable, which
      // guarantees no further child runs are created.
      const failedStep = [...snapshot.steps]
        .reverse()
        .find((step) => step.status === "failed");
      const classification = classifyStepError(failedStep?.error ?? null);
      if (classification.kind === "fatal") {
        this.automation.setSessionStatus(sessionId, "awaiting_user", now, {
          code: "child.fatal",
          runId,
          stepId: failedStep?.id ?? null,
          category: classification.category,
          message: failedStep?.error?.message ?? "",
        });
        return this.changed(sessionId, "child.fatal");
      }
      this.automation.setSessionStatus(sessionId, "failed", now, {
        code: "child.failed",
        runId,
        stepId: child.currentStepId,
      });
      return this.changed(sessionId, "child.failed");
    }
    if (child.status === "cancelled") {
      this.automation.markRunProcessed(sessionId, runId, "cancelled", now);
      if (link.role === "chapter" && link.outlineNodeId) {
        this.story.updateOutlineStatus(
          child.projectId,
          link.outlineNodeId,
          "planned",
          now,
        );
      }
      this.automation.setSessionStatus(sessionId, "running", now);
      return this.changed(sessionId, "child.cancelled");
    }
    if (child.status !== "completed") return false;
    const newlyProcessed = this.automation.markRunProcessed(
      sessionId,
      runId,
      "completed",
      now,
    );
    if (!newlyProcessed) return false;
    if (
      link.role === "rolling-plan" &&
      this.automation.requireSession(sessionId).chapterPolicy.planningOnly ===
        true
    ) {
      // planningOnly 会话只负责补齐章节大纲：规划 Run 完成后即结算，
      // 不进入章节生产。写作由后续会话（或作者）另行启动。
      this.automation.setSessionStatus(sessionId, "completed", now);
      return this.changed(sessionId, "session.completed");
    }
    if (link.role === "chapter") {
      if (link.outlineNodeId) {
        this.story.updateOutlineStatus(
          child.projectId,
          link.outlineNodeId,
          "committed",
          now,
        );
      }
      this.automation.recordChapterOutcome(sessionId, "completed", now);
    }
    if (link.role === "closing-review") {
      this.automation.setSessionStatus(sessionId, "completed", now);
      return this.changed(sessionId, "session.completed");
    }
    this.automation.setSessionStatus(sessionId, "running", now);
    return this.changed(sessionId, `${link.role}.completed`);
  }

  private applySteer(sessionId: string, steerId: string, now: string): boolean {
    const steer = this.automation.requireSteer(steerId);
    const session = this.automation.requireSession(sessionId);
    switch (steer.classification) {
      case "immediate_current":
        this.automation.appendActiveNote(sessionId, steer.content, now);
        if (session.currentRunId) {
          const child = this.runs.getSnapshot(session.currentRunId).run;
          if (!["completed", "failed", "cancelled"].includes(child.status)) {
            this.runs.requestCancel(child.id, now);
            this.runCoordinator.interrupt(child.id, "steer_immediate_current");
            this.wakeRunWorker();
          }
        }
        this.automation.resolveSteer(steerId, "applied", now);
        return this.changed(sessionId, "steer.immediate_applied");
      case "next_scene":
      case "temporary_director_note":
        this.automation.appendActiveNote(sessionId, steer.content, now);
        this.automation.resolveSteer(steerId, "applied", now);
        return this.changed(sessionId, "steer.note_queued");
      case "future_plan":
        this.automation.requestSessionControl(sessionId, "replan", now);
        this.automation.resolveSteer(steerId, "applied", now);
        return this.changed(sessionId, "steer.replan_queued");
      case "canon_change":
      case "rewrite_existing":
        this.automation.resolveSteer(steerId, "awaiting_confirmation", now);
        this.automation.setSessionStatus(sessionId, "awaiting_user", now, {
          code: `steer.${steer.classification}`,
          steerId,
        });
        return this.changed(sessionId, "steer.awaiting_confirmation");
      default:
        return false;
    }
  }

  private nextChapter(sessionId: string) {
    const session = this.automation.requireSession(sessionId);
    const resolved = new Set(
      this.automation
        .listRunLinks(sessionId)
        .filter(
          (link) =>
            link.role === "chapter" &&
            ["completed", "skipped"].includes(link.outcome ?? ""),
        )
        .map((link) => link.outlineNodeId)
        .filter((id): id is string => Boolean(id)),
    );
    return (
      this.story
        .listOutline(session.projectId)
        .find(
          (node) =>
            node.kind === "chapter" &&
            node.status === "planned" &&
            !resolved.has(node.id),
        ) ?? null
    );
  }

  private abandonSessionPlans(sessionId: string, now: string): void {
    const session = this.automation.requireSession(sessionId);
    const planningRunIds = new Set(
      this.automation
        .listRunLinks(sessionId)
        .filter((link) => link.role === "rolling-plan")
        .map((link) => link.runId),
    );
    for (const node of this.story.listOutline(session.projectId)) {
      if (
        node.kind === "chapter" &&
        node.status === "planned" &&
        typeof node.metadata.sourceRunId === "string" &&
        planningRunIds.has(node.metadata.sourceRunId)
      ) {
        this.story.updateOutlineStatus(
          session.projectId,
          node.id,
          "abandoned",
          now,
        );
      }
    }
  }

  private wakeRunWorker(): void {
    if (this.autoRunWorker) this.runCoordinator.wake();
  }

  private changed(sessionId: string, action: string): true {
    this.onChange(sessionId, action);
    return true;
  }
}

/**
 * Re-resolves the policy stored on an autopilot session into a complete
 * EffectivePolicy. Sessions created after M2 persist the normalized
 * effectivePolicy, so this is idempotent for them; legacy rows holding a
 * partial policy are upgraded with built-in defaults.
 */
// 迁移至 @narralume/services（automation-service）；本文件与路由都从那里取用。
export { resolveSessionEffectivePolicy } from "./automation-service.js";
import { resolveSessionEffectivePolicy } from "./automation-service.js";

function latestRunReason(
  snapshot: ReturnType<SqliteRunRepository["getSnapshot"]>,
) {
  const event = [...snapshot.events]
    .reverse()
    .find((candidate) => candidate.type === `run.${snapshot.run.status}`);
  return typeof event?.payload.reason === "string"
    ? event.payload.reason
    : snapshot.run.status;
}
