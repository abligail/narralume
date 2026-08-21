import type {
  NarrativeRun,
  NarrativeRunEvent,
  NarrativeRunStep,
  RunSnapshot,
} from "@narralume/domain";
import { describe, expect, it } from "vitest";

import {
  buildChapterRecipe,
  classifyStepError,
  computeRetryBackoffMs,
  routeRun,
} from "../src/index.js";

const now = "2026-08-10T00:00:00.000Z";

describe("chapter recipe", () => {
  it("expands a bounded revision loop into deterministic idempotent steps", () => {
    const recipe = buildChapterRecipe("run-1", 2);
    expect(recipe.steps).toHaveLength(13);
    expect(recipe.steps.map((step) => step.kind)).toEqual([
      "context.compile",
      "scene.plan",
      "draft.generate",
      "deterministic.check",
      "semantic.review",
      "revision.generate",
      "deterministic.check",
      "semantic.review",
      "revision.generate",
      "deterministic.check",
      "semantic.review",
      "chapter.settle",
      "chapter.commit",
    ]);
    expect(new Set(recipe.steps.map((step) => step.idempotencyKey)).size).toBe(
      recipe.steps.length,
    );
  });
});

describe("routeRun", () => {
  it("routes the first pending step and honors cancellation before work", () => {
    const snapshot = makeSnapshot(1);
    expect(routeRun(snapshot)).toEqual({
      type: "start_step",
      stepId: "run-1:context",
    });
    snapshot.run.cancelRequested = true;
    expect(routeRun(snapshot)).toEqual({ type: "cancel_run" });
  });

  it("schedules a backoff retry for retryable failures within the attempt budget", () => {
    const snapshot = makeSnapshot(1);
    Object.assign(snapshot.steps[0]!, {
      status: "failed",
      attempt: 1,
      maxAttempts: 2,
      error: { code: "network", message: "lost", retryable: true },
    });
    expect(
      routeRun(snapshot, { now: () => new Date(now), random: () => 0.5 }),
    ).toEqual({
      type: "retry_step",
      stepId: "run-1:context",
      delayMs: 1_000,
      reason: "network",
      category: "network",
      attempt: 1,
      maxAttempts: 2,
      nextAttemptAt: "2026-08-10T00:00:01.000Z",
    });
    snapshot.steps[0]!.attempt = 2;
    expect(routeRun(snapshot)).toEqual({
      type: "fail_run",
      reason: "network",
      stepId: "run-1:context",
      retryExhausted: {
        stepId: "run-1:context",
        attempts: 2,
        reason: "attempts_exhausted",
      },
    });
  });

  it("skips remaining revision cycles after a passing semantic gate", () => {
    const snapshot = makeSnapshot(2);
    succeedThrough(snapshot, "run-1:review:0");
    setOutput(snapshot, "run-1:check:0", { verdict: "pass" });
    setOutput(snapshot, "run-1:review:0", { verdict: "pass" });
    const action = routeRun(snapshot);
    expect(action).toMatchObject({
      type: "skip_steps",
      reason: "quality_gate_passed",
    });
    if (action.type !== "skip_steps") throw new Error("expected skip");
    expect(action.stepIds).toEqual([
      "run-1:revise:0",
      "run-1:check:1",
      "run-1:review:1",
      "run-1:revise:1",
      "run-1:check:2",
      "run-1:review:2",
    ]);
    for (const step of snapshot.steps) {
      if (action.stepIds.includes(step.id)) step.status = "skipped";
    }
    expect(routeRun(snapshot)).toEqual({
      type: "start_step",
      stepId: "run-1:settle",
    });
  });

  it("uses mechanical evidence to bypass semantic review and revise", () => {
    const snapshot = makeSnapshot(1);
    succeedThrough(snapshot, "run-1:check:0");
    setOutput(snapshot, "run-1:check:0", { verdict: "revise" });
    expect(routeRun(snapshot)).toEqual({
      type: "skip_steps",
      stepIds: ["run-1:review:0"],
      reason: "deterministic_check_requires_revision",
    });
    snapshot.steps.find((step) => step.id === "run-1:review:0")!.status =
      "skipped";
    expect(routeRun(snapshot)).toEqual({
      type: "start_step",
      stepId: "run-1:revise:0",
    });
  });

  it("runs the one lightweight review after a mechanical revision passes", () => {
    const snapshot = makeSnapshot(1);
    succeedThrough(snapshot, "run-1:check:1");
    snapshot.steps.find((step) => step.id === "run-1:review:0")!.status =
      "skipped";
    setOutput(snapshot, "run-1:check:0", { verdict: "revise" });
    setOutput(snapshot, "run-1:check:1", { verdict: "pass" });

    expect(routeRun(snapshot)).toEqual({
      type: "start_step",
      stepId: "run-1:review:1",
    });
  });

  it("lets chapter-gate reach manuscript approval with non-critical issues", () => {
    const snapshot = makeSnapshot(0);
    succeedThrough(snapshot, "run-1:review:0");
    setOutput(snapshot, "run-1:check:0", { verdict: "pass" });
    setOutput(snapshot, "run-1:review:0", { verdict: "revise" });
    expect(routeRun(snapshot)).toEqual({
      type: "start_step",
      stepId: "run-1:settle",
    });
  });

  it("lets autopilot continue with a non-critical review marker", () => {
    const snapshot = makeSnapshot(0);
    snapshot.run.mode = "autopilot";
    succeedThrough(snapshot, "run-1:review:0");
    setOutput(snapshot, "run-1:check:0", { verdict: "pass" });
    setOutput(snapshot, "run-1:review:0", {
      verdict: "revise",
      issues: [{ severity: "major" }],
    });
    expect(routeRun(snapshot)).toEqual({
      type: "start_step",
      stepId: "run-1:settle",
    });
  });

  it("stops autopilot when a critical review issue remains", () => {
    const snapshot = makeSnapshot(0);
    snapshot.run.mode = "autopilot";
    succeedThrough(snapshot, "run-1:review:0");
    setOutput(snapshot, "run-1:check:0", { verdict: "pass" });
    setOutput(snapshot, "run-1:review:0", {
      verdict: "revise",
      issues: [{ severity: "critical" }],
    });
    expect(routeRun(snapshot)).toEqual({
      type: "await_user",
      reason: "critical_review_unresolved",
      stepId: "run-1:review:0",
    });
  });

  it("requires explicit chapter-gate approval before the atomic commit", () => {
    const snapshot = makeSnapshot(0);
    for (const step of snapshot.steps) {
      if (step.kind === "chapter.commit") break;
      step.status = "succeeded";
    }
    setOutput(snapshot, "run-1:check:0", { verdict: "pass" });
    setOutput(snapshot, "run-1:review:0", { verdict: "pass" });
    expect(routeRun(snapshot)).toEqual({
      type: "await_user",
      reason: "chapter_commit_approval_required",
      stepId: "run-1:commit",
    });
    snapshot.run.policy = { chapterApproved: true };
    expect(routeRun(snapshot)).toEqual({
      type: "start_step",
      stepId: "run-1:commit",
    });
  });

  it("can pause after the lightweight plan before generating prose", () => {
    const snapshot = makeSnapshot(0);
    succeedThrough(snapshot, "run-1:plan");
    snapshot.run.policy = { planningMode: "confirm" };
    expect(routeRun(snapshot)).toEqual({
      type: "await_user",
      reason: "scene_plan_approval_required",
      stepId: "run-1:draft",
    });
    snapshot.run.policy = { planningMode: "confirm", planApproved: true };
    expect(routeRun(snapshot)).toEqual({
      type: "start_step",
      stepId: "run-1:draft",
    });
  });

  it("reviews the manuscript again after an AI revision", () => {
    const snapshot = makeSnapshot(1);
    succeedThrough(snapshot, "run-1:check:1");
    setOutput(snapshot, "run-1:check:1", { verdict: "pass" });
    expect(routeRun(snapshot)).toEqual({
      type: "start_step",
      stepId: "run-1:review:1",
    });
  });

  it("still runs semantic review after a final mechanical failure", () => {
    const snapshot = makeSnapshot(1);
    succeedThrough(snapshot, "run-1:check:1");
    setOutput(snapshot, "run-1:check:1", { verdict: "revise" });
    expect(routeRun(snapshot)).toEqual({
      type: "start_step",
      stepId: "run-1:review:1",
    });
  });

  it("parks a committed manuscript when canon settlement still conflicts", () => {
    const snapshot = makeSnapshot(0);
    for (const step of snapshot.steps) step.status = "succeeded";
    setOutput(snapshot, "run-1:commit", {
      documentId: "document-1",
      versionId: "version-1",
      changeSetId: "change-1",
      settlementConflict: {
        code: "settlement.conflict",
        conflicts: [{ path: "factCandidates.0", existingIds: ["fact-1"] }],
      },
    });
    expect(routeRun(snapshot)).toEqual({
      type: "await_user",
      reason: "settlement_conflict_requires_resolution",
      stepId: "run-1:commit",
    });
    snapshot.run.policy = { settlementConflictResolved: true };
    expect(routeRun(snapshot)).toEqual({ type: "complete_run" });
  });
});

describe("classifyStepError", () => {
  it("classifies model.<category> codes into fatal/retryable/cancelled", () => {
    for (const category of [
      "authentication",
      "permission",
      "invalid_request",
      "context_length",
      "content_filter",
      "model_not_found",
    ]) {
      expect(
        classifyStepError({
          code: `model.${category}`,
          message: "",
          retryable: true,
        }),
      ).toEqual({ kind: "fatal", category });
    }
    for (const category of [
      "rate_limit",
      "server",
      "network",
      "timeout",
      "request_start_timeout",
      "stream_idle_timeout",
      "stream_interrupted",
    ]) {
      expect(
        classifyStepError({
          code: `model.${category}`,
          message: "",
          retryable: false,
        }),
      ).toEqual({ kind: "retryable", category });
    }
    expect(
      classifyStepError({
        code: "model.cancelled",
        message: "",
        retryable: true,
      }),
    ).toEqual({ kind: "cancelled", category: "cancelled" });
  });

  it("treats worker cancellation as cancelled and falls back to details.category", () => {
    expect(
      classifyStepError({
        code: "worker.cancelled",
        message: "aborted",
        retryable: true,
      }),
    ).toEqual({ kind: "cancelled", category: "cancelled" });
    expect(
      classifyStepError({
        code: "model.failed",
        message: "",
        retryable: true,
        details: { category: "rate_limit" },
      }),
    ).toEqual({ kind: "retryable", category: "rate_limit" });
    expect(
      classifyStepError({
        code: "worker.failed",
        message: "",
        retryable: true,
      }),
    ).toEqual({ kind: "unknown", category: null });
    expect(classifyStepError(null)).toEqual({
      kind: "unknown",
      category: null,
    });
  });
});

describe("computeRetryBackoffMs", () => {
  it("grows exponentially with ±20% jitter and caps at 30s", () => {
    expect(computeRetryBackoffMs(1, 1_000, () => 0)).toBe(800);
    expect(computeRetryBackoffMs(1, 1_000, () => 0.5)).toBe(1_000);
    expect(computeRetryBackoffMs(1, 1_000, () => 0.999)).toBe(1_200);
    expect(computeRetryBackoffMs(3, 1_000, () => 0.5)).toBe(4_000);
    expect(computeRetryBackoffMs(10, 1_000, () => 0.5)).toBe(30_000);
  });
});

describe("routeRun failed-step classification", () => {
  function failFirstStep(
    snapshot: RunSnapshot,
    error: NarrativeRunStep["error"],
    attempt = 1,
  ): void {
    Object.assign(snapshot.steps[0]!, {
      status: "failed",
      attempt,
      maxAttempts: 3,
      error,
    });
  }

  it("short-circuits fatal errors without consuming any retry", () => {
    const snapshot = makeSnapshot(1);
    failFirstStep(snapshot, {
      code: "model.authentication",
      message: "bad key",
      retryable: true,
    });
    expect(routeRun(snapshot)).toEqual({
      type: "fail_run",
      reason: "model.authentication",
      stepId: "run-1:context",
      fatalShortcut: {
        stepId: "run-1:context",
        category: "authentication",
        message: "bad key",
      },
    });
  });

  it("never retries cancelled errors", () => {
    const snapshot = makeSnapshot(1);
    failFirstStep(snapshot, {
      code: "model.cancelled",
      message: "Cancelled",
      retryable: true,
    });
    expect(routeRun(snapshot)).toEqual({
      type: "fail_run",
      reason: "model.cancelled",
      stepId: "run-1:context",
    });
  });

  it("keeps legacy retryable-flag semantics for unknown errors", () => {
    const snapshot = makeSnapshot(1);
    failFirstStep(snapshot, {
      code: "worker.failed",
      message: "boom",
      retryable: true,
    });
    const action = routeRun(snapshot, {
      now: () => new Date(now),
      random: () => 0.5,
    });
    expect(action).toMatchObject({
      type: "retry_step",
      stepId: "run-1:context",
      category: null,
      delayMs: 1_000,
    });
    failFirstStep(
      snapshot,
      { code: "worker.failed", message: "boom", retryable: false },
      1,
    );
    expect(routeRun(snapshot)).toEqual({
      type: "fail_run",
      reason: "worker.failed",
      stepId: "run-1:context",
    });
  });

  it("caps retries by policy.maxRetries even when the step allows more", () => {
    const snapshot = makeSnapshot(1);
    snapshot.run.policy = { maxRetries: 0 };
    failFirstStep(snapshot, {
      code: "model.rate_limit",
      message: "slow down",
      retryable: true,
    });
    expect(routeRun(snapshot)).toEqual({
      type: "fail_run",
      reason: "model.rate_limit",
      stepId: "run-1:context",
      retryExhausted: {
        stepId: "run-1:context",
        attempts: 1,
        reason: "attempts_exhausted",
      },
    });
  });

  it("fails instead of retrying when the next attempt would pass the run deadline", () => {
    const snapshot = makeSnapshot(1);
    snapshot.run.policy = { runDeadlineMs: 500, retryBaseDelayMs: 1_000 };
    failFirstStep(snapshot, {
      code: "model.server",
      message: "500",
      retryable: true,
    });
    expect(
      routeRun(snapshot, { now: () => new Date(now), random: () => 0.5 }),
    ).toEqual({
      type: "fail_run",
      reason: "run_deadline_exceeded",
      stepId: "run-1:context",
      retryExhausted: {
        stepId: "run-1:context",
        attempts: 1,
        reason: "run_deadline_exceeded",
      },
    });
  });

  it("starts the step directly once its retry has been scheduled", () => {
    const snapshot = makeSnapshot(1);
    failFirstStep(snapshot, {
      code: "model.rate_limit",
      message: "slow down",
      retryable: true,
    });
    (snapshot.events as NarrativeRunEvent[]).push({
      id: 1,
      runId: "run-1",
      stepId: "run-1:context",
      sequence: 0,
      type: "run.step.retry_scheduled",
      payload: { stepId: "run-1:context", attempt: 1 },
      createdAt: now,
    });
    expect(routeRun(snapshot)).toEqual({
      type: "start_step",
      stepId: "run-1:context",
    });
  });
});

function makeSnapshot(maxRevisionCycles: number): RunSnapshot {
  const recipe = buildChapterRecipe("run-1", maxRevisionCycles);
  const run: NarrativeRun = {
    id: "run-1",
    projectId: "p1",
    recipe: recipe.name,
    recipeVersion: recipe.version,
    mode: "chapter-gate",
    status: "running",
    targetOutlineNodeId: "chapter-1",
    policy: {},
    budgetUsage: {
      inputTokens: 0,
      outputTokens: 0,
      calls: 0,
      costUsd: 0,
      wallTimeMs: 0,
    },
    revisionCycle: 0,
    pauseRequested: false,
    cancelRequested: false,
    currentStepId: null,
    startedAt: now,
    finishedAt: null,
    createdAt: now,
    updatedAt: now,
    version: 0,
  };
  const steps: NarrativeRunStep[] = recipe.steps.map((seed) => ({
    ...seed,
    runId: run.id,
    status: "pending",
    inputHash: null,
    outputArtifact: null,
    outputHash: null,
    error: null,
    attempt: 0,
    startedAt: null,
    finishedAt: null,
    createdAt: now,
    updatedAt: now,
  }));
  return { run, steps, events: [], latestCheckpoint: null };
}

function succeedThrough(snapshot: RunSnapshot, stepId: string): void {
  for (const step of snapshot.steps) {
    step.status = "succeeded";
    if (step.id === stepId) return;
  }
  throw new Error(`step ${stepId} missing`);
}

function setOutput(
  snapshot: RunSnapshot,
  stepId: string,
  output: Record<string, unknown>,
): void {
  snapshot.steps.find((step) => step.id === stepId)!.outputArtifact = output;
}
