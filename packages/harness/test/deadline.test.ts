import type {
  NarrativeRun,
  NarrativeRunStep,
  RunBudgetUsage,
  RunSnapshot,
  RunStepError,
} from "@narralume/domain";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildChapterRecipe,
  classifyStepError,
  computeStepDeadline,
  DEFAULT_LEASE_MS,
  HarnessSupervisor,
  RETRY_SCHEDULED_EVENT,
  routeRun,
  RUN_DEADLINE_EXCEEDED_EVENT,
  STEP_DEADLINE_EXCEEDED_EVENT,
  type HarnessStore,
  type LeasedRun,
  type StepExecutionResult,
  type StepWorker,
} from "../src/index.js";

const NOW = "2026-08-10T00:00:00.000Z";

afterEach(() => {
  vi.useRealTimers();
});

/**
 * In-memory HarnessStore. Only the behavior the supervisor relies on is
 * modelled: steps mutate in place, events/status changes are recorded for
 * assertions, and leases always succeed.
 */
class FakeStore implements HarnessStore {
  readonly appendedEvents: Array<{
    stepId: string | null;
    type: string;
    payload: Readonly<Record<string, unknown>>;
  }> = [];
  readonly renewals: Array<{ now: string; leaseMs: number }> = [];
  readonly statusChanges: Array<{
    status: NarrativeRun["status"];
    reason?: string;
  }> = [];
  readonly finishes: Array<{
    requeue: boolean;
    delayMs?: number;
    error?: RunStepError;
  }> = [];

  constructor(public readonly snapshot: RunSnapshot) {}

  leaseNext(workerId: string): LeasedRun | null {
    return { runId: this.snapshot.run.id, leaseOwner: workerId };
  }

  leaseRun(runId: string, workerId: string): LeasedRun | null {
    return { runId, leaseOwner: workerId };
  }

  renewLease(_runId: string, _workerId: string, now: string, leaseMs: number) {
    this.renewals.push({ now, leaseMs });
    return true;
  }

  getSnapshot(): RunSnapshot {
    return this.snapshot;
  }

  appendRunEvent(
    _runId: string,
    stepId: string | null,
    type: string,
    payload: Readonly<Record<string, unknown>>,
  ): void {
    this.appendedEvents.push({ stepId, type, payload });
  }

  startStep(_runId: string, stepId: string, now: string): NarrativeRunStep {
    const step = this.step(stepId);
    step.status = "running";
    step.attempt += 1;
    step.startedAt = now;
    this.snapshot.run.currentStepId = stepId;
    return step;
  }

  succeedStep(
    _runId: string,
    stepId: string,
    output: Readonly<Record<string, unknown>>,
    _artifactKind: string,
    now: string,
  ): void {
    const step = this.step(stepId);
    step.status = "succeeded";
    step.outputArtifact = output;
    step.finishedAt = now;
    this.snapshot.run.currentStepId = null;
  }

  failStep(_runId: string, stepId: string, error: RunStepError, now: string) {
    const step = this.step(stepId);
    step.status = "failed";
    step.error = error;
    step.finishedAt = now;
    this.snapshot.run.currentStepId = null;
  }

  recordBudget(_runId: string, _stepId: string, usage: RunBudgetUsage): void {
    const used = this.snapshot.run.budgetUsage;
    used.inputTokens += usage.inputTokens;
    used.outputTokens += usage.outputTokens;
    used.calls += usage.calls;
    used.costUsd += usage.costUsd;
    used.wallTimeMs += usage.wallTimeMs;
  }

  skipSteps(_runId: string, stepIds: readonly string[]): void {
    for (const stepId of stepIds) this.step(stepId).status = "skipped";
  }

  setRunStatus(
    _runId: string,
    status: NarrativeRun["status"],
    _now: string,
    reason?: string,
  ): void {
    this.snapshot.run.status = status;
    this.statusChanges.push({
      status,
      ...(reason === undefined ? {} : { reason }),
    });
  }

  finishLease(
    _runId: string,
    _workerId: string,
    options: { requeue: boolean; delayMs?: number; error?: RunStepError },
  ): void {
    this.finishes.push(options);
  }

  private step(stepId: string): NarrativeRunStep {
    const step = this.snapshot.steps.find((entry) => entry.id === stepId);
    if (!step) throw new Error(`step ${stepId} missing`);
    return step;
  }
}

/** A worker that never completes on its own; it rejects when aborted. */
function hangingWorker(
  onAbort?: (signal: AbortSignal) => void,
): StepWorker & { calls: number } {
  const worker = {
    calls: 0,
    execute(
      _snapshot: RunSnapshot,
      _step: NarrativeRunStep,
      signal: AbortSignal,
    ): Promise<StepExecutionResult> {
      worker.calls += 1;
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            onAbort?.(signal);
            reject(new DOMException("The operation was aborted", "AbortError"));
          },
          { once: true },
        );
      });
    },
  };
  return worker;
}

function succeedingWorker(
  execute?: (snapshot: RunSnapshot) => void,
): StepWorker {
  return {
    execute(snapshot): Promise<StepExecutionResult> {
      execute?.(snapshot);
      return Promise.resolve({ output: { ok: true }, artifactKind: "test" });
    },
  };
}

function makeSnapshot(overrides: {
  policy?: Record<string, unknown>;
  createdAt?: string;
}): RunSnapshot {
  const recipe = buildChapterRecipe("run-1", 0);
  const createdAt = overrides.createdAt ?? NOW;
  const run: NarrativeRun = {
    id: "run-1",
    projectId: "p1",
    recipe: recipe.name,
    recipeVersion: recipe.version,
    mode: "manual",
    status: "running",
    targetOutlineNodeId: null,
    policy: overrides.policy ?? {},
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
    startedAt: createdAt,
    finishedAt: null,
    createdAt,
    updatedAt: createdAt,
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
    createdAt,
    updatedAt: createdAt,
  }));
  return { run, steps, events: [], latestCheckpoint: null };
}

describe("computeStepDeadline", () => {
  it("picks the tightest of run/step deadlines", () => {
    const nowMs = Date.parse(NOW);
    const run = makeSnapshot({
      policy: { stepDeadlineMs: 5_000, runDeadlineMs: 60_000 },
    }).run;
    // step (5s) < run (60s)
    expect(computeStepDeadline(run, nowMs)).toEqual({
      at: nowMs + 5_000,
      scope: "step",
    });

    // run (2s) < step (5s): the run deadline shortens the step.
    run.policy = { stepDeadlineMs: 5_000, runDeadlineMs: 2_000 };
    expect(computeStepDeadline(run, nowMs)).toEqual({
      at: nowMs + 2_000,
      scope: "run",
    });
  });

  it("returns null when no deadline policy applies", () => {
    const run = makeSnapshot({}).run;
    expect(computeStepDeadline(run, Date.parse(NOW))).toBeNull();
  });
});

describe("supervisor step deadlines", () => {
  it("aborts a step at the step deadline with a fatal deadline_exceeded error", async () => {
    const store = new FakeStore(
      makeSnapshot({ policy: { stepDeadlineMs: 60 } }),
    );
    const worker = hangingWorker();
    const supervisor = new HarnessSupervisor(
      store,
      { "context.compile": worker },
      { now: () => new Date(NOW) },
    );

    await supervisor.processRun("run-1", "worker-1");

    const step = store.snapshot.steps[0]!;
    expect(worker.calls).toBe(1);
    expect(step.status).toBe("failed");
    expect(step.error).toEqual({
      code: "deadline_exceeded",
      message: "Step execution exceeded the stepDeadlineMs deadline",
      retryable: false,
      details: {
        deadlineScope: "step",
        deadlineAt: "2026-08-10T00:00:00.060Z",
        elapsedMs: 0,
      },
    });
    const event = store.appendedEvents.find(
      (entry) => entry.type === STEP_DEADLINE_EXCEEDED_EVENT,
    );
    expect(event).toBeDefined();
    expect(event!.stepId).toBe(step.id);
    expect(event!.payload).toEqual({
      stepId: step.id,
      deadlineScope: "step",
      deadlineAt: "2026-08-10T00:00:00.060Z",
      elapsedMs: 0,
    });
  });

  it("aborts a running step at the run deadline (scope 'run')", async () => {
    // Run deadline falls 100ms after the (fixed) routing clock.
    const createdAt = "2026-08-09T23:59:58.100Z";
    const store = new FakeStore(
      makeSnapshot({ policy: { runDeadlineMs: 2_000 }, createdAt }),
    );
    const supervisor = new HarnessSupervisor(
      store,
      { "context.compile": hangingWorker() },
      { now: () => new Date(NOW) },
    );

    await supervisor.processRun("run-1", "worker-1");

    expect(store.snapshot.steps[0]!.error).toMatchObject({
      code: "deadline_exceeded",
      details: {
        deadlineScope: "run",
        deadlineAt: "2026-08-10T00:00:00.100Z",
      },
    });
  });

  it("fails without invoking the worker when the deadline already passed", async () => {
    // Run deadline is already in the past relative to the fixed clock.
    const createdAt = "2026-08-09T23:59:58.000Z";
    const store = new FakeStore(
      makeSnapshot({ policy: { runDeadlineMs: 1_000 }, createdAt }),
    );
    const worker = hangingWorker();
    const supervisor = new HarnessSupervisor(
      store,
      { "context.compile": worker },
      { now: () => new Date(NOW) },
    );

    await supervisor.processRun("run-1", "worker-1");

    expect(worker.calls).toBe(0);
    expect(store.snapshot.run.status).toBe("failed");
    expect(store.statusChanges).toContainEqual({
      status: "failed",
      reason: "run_deadline_exceeded",
    });
  });

  it("never retries a deadline expiry: the next routing fails the run", async () => {
    const store = new FakeStore(
      makeSnapshot({ policy: { stepDeadlineMs: 60 } }),
    );
    const supervisor = new HarnessSupervisor(
      store,
      { "context.compile": hangingWorker() },
      { now: () => new Date(NOW) },
    );

    await supervisor.processRun("run-1", "worker-1");
    await supervisor.processRun("run-1", "worker-1");

    expect(store.snapshot.run.status).toBe("failed");
    expect(store.statusChanges).toContainEqual({
      status: "failed",
      reason: "deadline_exceeded",
    });
    expect(
      store.appendedEvents.some(
        (entry) => entry.type === RETRY_SCHEDULED_EVENT,
      ),
    ).toBe(false);
    expect(store.finishes[1]).toMatchObject({ requeue: false });
  });

  it("attributes an explicit interrupt to cancellation, not to the deadline", async () => {
    const store = new FakeStore(
      makeSnapshot({ policy: { stepDeadlineMs: 60_000 } }),
    );
    let started!: () => void;
    const workerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const worker: StepWorker = {
      execute(_snapshot, _step, signal) {
        started();
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () =>
              reject(
                new DOMException("The operation was aborted", "AbortError"),
              ),
            { once: true },
          );
        });
      },
    };
    const supervisor = new HarnessSupervisor(
      store,
      { "context.compile": worker },
      { now: () => new Date(NOW) },
    );

    const processed = supervisor.processRun("run-1", "worker-1");
    await workerStarted;
    expect(supervisor.interrupt("run-1")).toBe(true);
    await processed;

    expect(store.snapshot.steps[0]!.error).toMatchObject({
      code: "worker.cancelled",
    });
    expect(
      store.appendedEvents.some(
        (entry) => entry.type === STEP_DEADLINE_EXCEEDED_EVENT,
      ),
    ).toBe(false);
  });

  it("rejects a successful result from a worker that ignored an abort", async () => {
    const store = new FakeStore(makeSnapshot({}));
    let started!: () => void;
    let release!: () => void;
    const workerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const worker: StepWorker = {
      execute(_snapshot, _step, signal) {
        started();
        return new Promise((resolve) => {
          release = () =>
            resolve({
              output: { observedAborted: signal.aborted },
              artifactKind: "test",
              usage: {
                inputTokens: 10,
                outputTokens: 20,
                calls: 1,
                costUsd: 0,
                wallTimeMs: 30,
              },
            });
        });
      },
    };
    const supervisor = new HarnessSupervisor(
      store,
      { "context.compile": worker },
      { now: () => new Date(NOW) },
    );

    const processed = supervisor.processRun("run-1", "worker-1");
    await workerStarted;
    expect(supervisor.interrupt("run-1")).toBe(true);
    release();
    await processed;

    expect(store.snapshot.steps[0]).toMatchObject({
      status: "failed",
      error: { code: "worker.cancelled" },
      outputArtifact: null,
    });
    expect(store.snapshot.run.budgetUsage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      calls: 0,
      costUsd: 0,
      wallTimeMs: 0,
    });
  });

  it("rejects a worker result after cancellation was persisted", async () => {
    const store = new FakeStore(makeSnapshot({}));
    const worker = succeedingWorker((snapshot) => {
      (snapshot.run as { cancelRequested: boolean }).cancelRequested = true;
    });
    const supervisor = new HarnessSupervisor(
      store,
      { "context.compile": worker },
      { now: () => new Date(NOW) },
    );

    await supervisor.processRun("run-1", "worker-1");

    expect(store.snapshot.steps[0]).toMatchObject({
      status: "failed",
      error: { code: "worker.cancelled" },
      outputArtifact: null,
    });
  });
});

describe("supervisor run deadline", () => {
  it("fails the run before routing when run.createdAt + runDeadlineMs passed", async () => {
    const store = new FakeStore(
      makeSnapshot({
        policy: { runDeadlineMs: 1_000 },
        createdAt: "2026-08-09T23:59:59.000Z",
      }),
    );
    const worker = hangingWorker();
    const supervisor = new HarnessSupervisor(
      store,
      { "context.compile": worker },
      // Routing happens 2s after createdAt: the deadline is already gone.
      { now: () => new Date("2026-08-10T00:00:01.000Z") },
    );

    const processed = await supervisor.processRun("run-1", "worker-1");

    expect(processed).toBe(true);
    expect(worker.calls).toBe(0);
    expect(store.snapshot.run.status).toBe("failed");
    expect(store.statusChanges).toEqual([
      { status: "failed", reason: "run_deadline_exceeded" },
    ]);
    expect(store.appendedEvents).toContainEqual({
      stepId: null,
      type: RUN_DEADLINE_EXCEEDED_EVENT,
      payload: {
        deadlineScope: "run",
        deadlineAt: "2026-08-10T00:00:00.000Z",
      },
    });
    expect(store.finishes[0]).toMatchObject({ requeue: false });
  });

  it("lets a requested cancel win over the expired run deadline", async () => {
    const store = new FakeStore(
      makeSnapshot({
        policy: { runDeadlineMs: 1_000 },
        createdAt: "2026-08-09T23:59:59.000Z",
      }),
    );
    store.snapshot.run.cancelRequested = true;
    const supervisor = new HarnessSupervisor(
      store,
      { "context.compile": hangingWorker() },
      { now: () => new Date("2026-08-10T00:00:01.000Z") },
    );

    await supervisor.processRun("run-1", "worker-1");

    expect(store.snapshot.run.status).toBe("cancelled");
    expect(
      store.appendedEvents.some(
        (entry) => entry.type === RUN_DEADLINE_EXCEEDED_EVENT,
      ),
    ).toBe(false);
  });
});

describe("deadline_exceeded classification", () => {
  it("is fatal even when the error is marked retryable", () => {
    expect(
      classifyStepError({
        code: "deadline_exceeded",
        message: "Step execution exceeded the stepDeadlineMs deadline",
        retryable: true,
      }),
    ).toEqual({ kind: "fatal", category: "deadline_exceeded" });

    const snapshot = makeSnapshot({});
    Object.assign(snapshot.steps[0]!, {
      status: "failed",
      attempt: 1,
      maxAttempts: 3,
      error: {
        code: "deadline_exceeded",
        message: "Step execution exceeded the stepDeadlineMs deadline",
        retryable: true,
        details: { deadlineScope: "step", remainingBudgetMs: 60_000 },
      },
    });
    expect(routeRun(snapshot)).toEqual({
      type: "fail_run",
      reason: "deadline_exceeded",
      stepId: "run-1:context",
      fatalShortcut: {
        stepId: "run-1:context",
        category: "deadline_exceeded",
        message: "Step execution exceeded the stepDeadlineMs deadline",
      },
    });
  });
});

describe("pause boundary", () => {
  it("never interrupts a running step; pause takes effect between steps", async () => {
    const store = new FakeStore(makeSnapshot({}));
    // The pause flag lands mid-step (as if the API set it during execution).
    const worker = succeedingWorker((snapshot) => {
      (snapshot.run as { pauseRequested: boolean }).pauseRequested = true;
    });
    const supervisor = new HarnessSupervisor(
      store,
      { "context.compile": worker },
      { now: () => new Date(NOW) },
    );

    await supervisor.processRun("run-1", "worker-1");

    // The in-flight step ran to completion at the safe boundary.
    expect(store.snapshot.steps[0]!.status).toBe("succeeded");
    expect(store.snapshot.run.status).toBe("running");

    await supervisor.processRun("run-1", "worker-1");

    expect(store.snapshot.run.status).toBe("paused");
    expect(store.statusChanges).toContainEqual({
      status: "paused",
      reason: "requested",
    });
    expect(store.finishes[1]).toMatchObject({ requeue: false });
  });
});

describe("worker heartbeat", () => {
  it("renews the lease every leaseMs/3 while a long step runs", async () => {
    vi.useFakeTimers();
    const store = new FakeStore(makeSnapshot({}));
    let release!: () => void;
    const worker: StepWorker = {
      execute: () =>
        new Promise<StepExecutionResult>((resolve) => {
          release = () => resolve({ output: {}, artifactKind: "test" });
        }),
    };
    const supervisor = new HarnessSupervisor(
      store,
      { "context.compile": worker },
      { leaseMs: 900, now: () => new Date(NOW) },
    );

    const processed = supervisor.processRun("run-1", "worker-1");
    await vi.advanceTimersByTimeAsync(1_000);
    release();
    await processed;

    // Heartbeat interval = max(250, 900/3) = 300ms → 3 renewals in 1s.
    expect(store.renewals.length).toBeGreaterThanOrEqual(3);
    expect(store.renewals[0]).toEqual({ now: NOW, leaseMs: 900 });
  });

  it("defaults to a seconds-level lease so a dead worker is discovered fast", async () => {
    vi.useFakeTimers();
    const store = new FakeStore(makeSnapshot({}));
    let release!: () => void;
    const worker: StepWorker = {
      execute: () =>
        new Promise<StepExecutionResult>((resolve) => {
          release = () => resolve({ output: {}, artifactKind: "test" });
        }),
    };
    const supervisor = new HarnessSupervisor(
      store,
      { "context.compile": worker },
      { now: () => new Date(NOW) },
    );

    const processed = supervisor.processRun("run-1", "worker-1");
    await vi.advanceTimersByTimeAsync(DEFAULT_LEASE_MS / 3 + 10);
    release();
    await processed;

    // The default lease is 5s: heartbeat ~1.7s, discovery ≤5s after death.
    expect(DEFAULT_LEASE_MS).toBe(5_000);
    expect(store.renewals.length).toBeGreaterThanOrEqual(1);
    expect(store.renewals[0]!.leaseMs).toBe(DEFAULT_LEASE_MS);
  });
});
