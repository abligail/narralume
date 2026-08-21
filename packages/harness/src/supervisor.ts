import type {
  NarrativeRun,
  NarrativeRunStep,
  RunStepKind,
  RunBudgetUsage,
  RunSnapshot,
  RunStepError,
} from "@narralume/domain";

import { routeRun, type HarnessAction } from "./router.js";
import {
  DEADLINE_EXCEEDED_CODE,
  RUN_DEADLINE_EXCEEDED_EVENT,
  RUN_DEADLINE_EXCEEDED_REASON,
  STEP_DEADLINE_EXCEEDED_EVENT,
  computeStepDeadline,
  deadlineExceededError,
  runDeadlineAt,
} from "./deadline.js";
import {
  FATAL_SHORTCUT_EVENT,
  RETRY_EXHAUSTED_EVENT,
  RETRY_SCHEDULED_EVENT,
} from "./retry.js";

/**
 * Default lease/heartbeat cadence. Heartbeat evaluation (M4): the lease
 * renewal in processLease IS the worker heartbeat — every leaseMs/3 it
 * rewrites run_jobs.lease_expires_at (and runs.lease_expires_at), reusing
 * the lease columns so no migration is needed. A dead worker stops renewing
 * and is discovered at the latest `leaseMs` after its last renewal, when
 * recoverExpiredLeases requeues the job. The 5s default keeps process-death
 * discovery at seconds level; the server's RunCoordinator drains leases
 * sequentially, so a briefly stalled event loop cannot be preempted by a
 * concurrent local worker.
 */
export const DEFAULT_LEASE_MS = 5_000;

const TERMINAL_RUN_STATUSES = new Set(["failed", "cancelled", "completed"]);

export interface LeasedRun {
  runId: string;
  leaseOwner: string;
}

export interface HarnessStore {
  leaseNext(workerId: string, now: string, leaseMs: number): LeasedRun | null;
  leaseRun(
    runId: string,
    workerId: string,
    now: string,
    leaseMs: number,
  ): LeasedRun | null;
  renewLease(
    runId: string,
    workerId: string,
    now: string,
    leaseMs: number,
  ): boolean;
  getSnapshot(runId: string): RunSnapshot;
  appendRunEvent(
    runId: string,
    stepId: string | null,
    type: string,
    payload: Readonly<Record<string, unknown>>,
    now: string,
  ): void;
  startStep(runId: string, stepId: string, now: string): NarrativeRunStep;
  succeedStep(
    runId: string,
    stepId: string,
    output: Readonly<Record<string, unknown>>,
    artifactKind: string,
    now: string,
  ): void;
  failStep(
    runId: string,
    stepId: string,
    error: RunStepError,
    now: string,
  ): void;
  recordBudget(
    runId: string,
    stepId: string,
    usage: RunBudgetUsage,
    now: string,
  ): void;
  skipSteps(
    runId: string,
    stepIds: readonly string[],
    reason: string,
    now: string,
  ): void;
  setRunStatus(
    runId: string,
    status: NarrativeRun["status"],
    now: string,
    reason?: string,
  ): void;
  finishLease(
    runId: string,
    workerId: string,
    options: { requeue: boolean; delayMs?: number; error?: RunStepError },
    now: string,
  ): void;
}

export interface StepExecutionResult {
  output: Readonly<Record<string, unknown>>;
  artifactKind: string;
  usage?: RunBudgetUsage;
}

export interface StepWorker {
  execute(
    snapshot: RunSnapshot,
    step: NarrativeRunStep,
    signal: AbortSignal,
  ): Promise<StepExecutionResult>;
}

export type WorkerRegistry = Readonly<Partial<Record<RunStepKind, StepWorker>>>;

/** Result of applying a routed action: whether to requeue, and after what delay. */
interface ActionOutcome {
  requeue: boolean;
  delayMs?: number;
}

export class HarnessSupervisor {
  readonly #activeControllers = new Map<string, AbortController>();

  constructor(
    private readonly store: HarnessStore,
    private readonly workers: WorkerRegistry,
    private readonly options: {
      leaseMs?: number;
      retryDelayMs?: number;
      now?: () => Date;
      onAction?: (runId: string, action: HarnessAction) => void;
    } = {},
  ) {}

  async processNext(workerId: string, signal?: AbortSignal): Promise<boolean> {
    const now = this.now();
    const lease = this.store.leaseNext(
      workerId,
      now,
      this.options.leaseMs ?? DEFAULT_LEASE_MS,
    );
    if (!lease) return false;
    return this.processLease(lease, workerId, signal);
  }

  async processRun(
    runId: string,
    workerId: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const lease = this.store.leaseRun(
      runId,
      workerId,
      this.now(),
      this.options.leaseMs ?? DEFAULT_LEASE_MS,
    );
    if (!lease) return false;
    return this.processLease(lease, workerId, signal);
  }

  private async processLease(
    lease: LeasedRun,
    workerId: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    let outcome: ActionOutcome = { requeue: true };
    let failure: RunStepError | undefined;
    const leaseMs = this.options.leaseMs ?? DEFAULT_LEASE_MS;
    const heartbeat = setInterval(
      () => {
        try {
          const renewed = this.store.renewLease(
            lease.runId,
            workerId,
            this.now(),
            leaseMs,
          );
          if (!renewed) this.interrupt(lease.runId, "lease_lost");
        } catch {
          this.interrupt(lease.runId, "lease_heartbeat_failed");
        }
      },
      Math.max(250, Math.floor(leaseMs / 3)),
    );
    // Node：unref 让进程不被心跳计时器拖住；Worker 无此方法。
    heartbeat.unref?.();
    try {
      const snapshot = this.store.getSnapshot(lease.runId);
      const runDeadline = runDeadlineAt(snapshot.run);
      if (
        runDeadline !== null &&
        Date.parse(this.now()) >= runDeadline &&
        !TERMINAL_RUN_STATUSES.has(snapshot.run.status) &&
        !snapshot.run.cancelRequested
      ) {
        // Run-level deadline: a hard wall-clock stop checked before every
        // routing decision, so an expired run fails instead of routing
        // another step. A live running step is unreachable here (processLease
        // is blocked inside applyAction while one runs) and still gets the
        // deadline through its merged abort signal.
        this.store.appendRunEvent(
          lease.runId,
          null,
          RUN_DEADLINE_EXCEEDED_EVENT,
          {
            deadlineScope: "run",
            deadlineAt: new Date(runDeadline).toISOString(),
          },
          this.now(),
        );
        this.store.setRunStatus(
          lease.runId,
          "failed",
          this.now(),
          RUN_DEADLINE_EXCEEDED_REASON,
        );
        outcome = { requeue: false };
      } else {
        const action = routeRun(snapshot, {
          now: () => new Date(this.now()),
        });
        outcome = await this.applyAction(snapshot, action, signal);
        this.options.onAction?.(lease.runId, action);
      }
    } catch (error) {
      failure = normalizeWorkerError(error);
    } finally {
      clearInterval(heartbeat);
      this.store.finishLease(
        lease.runId,
        workerId,
        {
          requeue: outcome.requeue,
          ...(failure
            ? {
                delayMs: this.options.retryDelayMs ?? 1_000,
                error: failure,
              }
            : outcome.delayMs !== undefined
              ? { delayMs: outcome.delayMs }
              : {}),
        },
        this.now(),
      );
    }
    return true;
  }

  interrupt(runId: string, reason = "cancel_requested"): boolean {
    const controller = this.#activeControllers.get(runId);
    if (!controller) return false;
    controller.abort(reason);
    return true;
  }

  private async applyAction(
    snapshot: RunSnapshot,
    action: HarnessAction,
    signal?: AbortSignal,
  ): Promise<ActionOutcome> {
    const now = this.now();
    switch (action.type) {
      case "start_step": {
        const step = this.store.startStep(snapshot.run.id, action.stepId, now);
        const worker = this.workers[step.kind];
        if (!worker) {
          this.store.failStep(
            snapshot.run.id,
            step.id,
            {
              code: "worker.missing",
              message: `Step ${step.kind} has no registered worker`,
              retryable: false,
            },
            this.now(),
          );
          return { requeue: true };
        }
        const controller = new AbortController();
        this.#activeControllers.set(snapshot.run.id, controller);
        const relay = () => controller.abort(signal?.reason);
        if (signal?.aborted) relay();
        else signal?.addEventListener("abort", relay, { once: true });
        // Wall-clock deadline tree: run deadline, per-step deadline and the
        // remaining wall-time budget all feed one timeout signal merged into
        // the step's abort signal, so each layer can only shorten the budget
        // the step gets. Expiry is attributed to the tightest scope.
        const stepStartMs = Date.parse(now);
        const deadline = computeStepDeadline(snapshot.run, stepStartMs);
        const deadlineSignal =
          deadline !== null && deadline.at > stepStartMs
            ? AbortSignal.timeout(deadline.at - stepStartMs)
            : null;
        try {
          if (deadline !== null && deadline.at <= stepStartMs) {
            // The deadline already passed between routing and step start:
            // fail without invoking the worker at all.
            throw deadlineExceededError(deadline, 0);
          }
          const result = await worker.execute(
            snapshot,
            step,
            deadlineSignal
              ? AbortSignal.any([controller.signal, deadlineSignal])
              : controller.signal,
          );
          const currentRun = this.store.getSnapshot(snapshot.run.id).run;
          if (
            controller.signal.aborted ||
            deadlineSignal?.aborted ||
            currentRun.cancelRequested ||
            TERMINAL_RUN_STATUSES.has(currentRun.status)
          ) {
            throw new DOMException("The operation was aborted", "AbortError");
          }
          this.store.succeedStep(
            snapshot.run.id,
            step.id,
            result.output,
            result.artifactKind,
            this.now(),
          );
          if (result.usage) {
            this.store.recordBudget(
              snapshot.run.id,
              step.id,
              result.usage,
              this.now(),
            );
          }
        } catch (error) {
          // An explicit interrupt wins attribution over the deadline; a
          // deadline abort is rewritten to the fatal deadline_exceeded error
          // whatever the worker threw while unwinding.
          const normalized =
            deadlineSignal?.aborted && !controller.signal.aborted
              ? deadlineExceededError(
                  deadline!,
                  Date.parse(this.now()) - stepStartMs,
                )
              : normalizeWorkerError(error);
          if (normalized.code === DEADLINE_EXCEEDED_CODE) {
            this.store.appendRunEvent(
              snapshot.run.id,
              step.id,
              STEP_DEADLINE_EXCEEDED_EVENT,
              {
                stepId: step.id,
                ...(normalized.details as Record<string, unknown>),
              },
              this.now(),
            );
          }
          this.store.failStep(snapshot.run.id, step.id, normalized, this.now());
          if (normalized.usage) {
            this.store.recordBudget(
              snapshot.run.id,
              step.id,
              normalized.usage,
              this.now(),
            );
          }
        } finally {
          this.#activeControllers.delete(snapshot.run.id);
          signal?.removeEventListener("abort", relay);
        }
        return { requeue: true };
      }
      case "retry_step": {
        // Persist the retry event BEFORE the delayed requeue so there is
        // always an audit trail before any backoff wait.
        this.store.appendRunEvent(
          snapshot.run.id,
          action.stepId,
          RETRY_SCHEDULED_EVENT,
          {
            stepId: action.stepId,
            attempt: action.attempt,
            maxAttempts: action.maxAttempts,
            reason: action.reason,
            category: action.category,
            waitMs: action.delayMs,
            nextAttemptAt: action.nextAttemptAt,
            remainingBudget: Math.max(
              0,
              action.maxAttempts - action.attempt - 1,
            ),
          },
          now,
        );
        return { requeue: true, delayMs: action.delayMs };
      }
      case "skip_steps":
        this.store.skipSteps(
          snapshot.run.id,
          action.stepIds,
          action.reason,
          now,
        );
        return { requeue: true };
      case "pause_run":
        this.store.setRunStatus(snapshot.run.id, "paused", now, "requested");
        return { requeue: false };
      case "cancel_run":
        this.store.setRunStatus(snapshot.run.id, "cancelled", now, "requested");
        return { requeue: false };
      case "await_user":
        this.store.setRunStatus(
          snapshot.run.id,
          "awaiting_user",
          now,
          action.reason,
        );
        return { requeue: false };
      case "fail_run": {
        if (action.fatalShortcut) {
          this.store.appendRunEvent(
            snapshot.run.id,
            action.fatalShortcut.stepId,
            FATAL_SHORTCUT_EVENT,
            {
              stepId: action.fatalShortcut.stepId,
              category: action.fatalShortcut.category,
              message: action.fatalShortcut.message,
            },
            now,
          );
        }
        if (action.retryExhausted) {
          this.store.appendRunEvent(
            snapshot.run.id,
            action.retryExhausted.stepId,
            RETRY_EXHAUSTED_EVENT,
            {
              stepId: action.retryExhausted.stepId,
              attempts: action.retryExhausted.attempts,
              reason: action.retryExhausted.reason,
            },
            now,
          );
        }
        this.store.setRunStatus(snapshot.run.id, "failed", now, action.reason);
        return { requeue: false };
      }
      case "complete_run":
        this.store.setRunStatus(snapshot.run.id, "completed", now);
        return { requeue: false };
      case "wait":
        return { requeue: action.reason === "step_running" };
    }
  }

  private now(): string {
    return (this.options.now ?? (() => new Date()))().toISOString();
  }
}

function normalizeWorkerError(error: unknown): RunStepError {
  if (isRunStepError(error)) return error;
  if (error instanceof Error) {
    return {
      code: error.name === "AbortError" ? "worker.cancelled" : "worker.failed",
      message: error.message,
      retryable:
        error.name === "AbortError" || /timeout|network/i.test(error.message),
    };
  }
  return {
    code: "worker.failed",
    message: String(error),
    retryable: false,
  };
}

function isRunStepError(value: unknown): value is RunStepError {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as RunStepError).code === "string" &&
    typeof (value as RunStepError).message === "string" &&
    typeof (value as RunStepError).retryable === "boolean"
  );
}
