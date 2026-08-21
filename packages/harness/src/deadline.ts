import type { NarrativeRun, RunStepError } from "@narralume/domain";

/**
 * Harness deadline tree (M4). Every layer of the execution stack may only
 * shorten the wall-clock budget of the layers below it:
 *
 *   run deadline (run.createdAt + policy.runDeadlineMs)
 *   step deadline (step start + policy.stepDeadlineMs)
 *
 * The supervisor merges the tightest of these into the step's AbortSignal
 * (via AbortSignal.timeout + AbortSignal.any) and converts an expiry into a
 * `deadline_exceeded` worker error, which the retry owner classifies as
 * fatal — an expired deadline is never retried automatically.
 */

/** Worker error code produced when an execution deadline aborts a step. */
export const DEADLINE_EXCEEDED_CODE = "deadline_exceeded";

/** Run event persisted when a running step is aborted by a deadline. */
export const STEP_DEADLINE_EXCEEDED_EVENT = "run.step.deadline_exceeded";

/** Run event persisted when the run deadline fails the run before routing. */
export const RUN_DEADLINE_EXCEEDED_EVENT = "run.deadline_exceeded";

/** fail_run reason used when the run-level deadline expires. */
export const RUN_DEADLINE_EXCEEDED_REASON = "run_deadline_exceeded";

/** Which wall-clock budget produced a deadline. */
export type DeadlineScope = "step" | "run";

export interface StepDeadline {
  /** Absolute epoch-ms instant at which the step must finish. */
  at: number;
  /** Which budget produced the tightest deadline. */
  scope: DeadlineScope;
}

const STEP_DEADLINE_MAX_MS = 7_200_000;
const RUN_DEADLINE_MAX_MS = 86_400_000;

/** policy.stepDeadlineMs, or null when absent/out of range. */
export function resolveStepDeadlineMs(
  policy: Readonly<Record<string, unknown>>,
): number | null {
  return intBetween(policy["stepDeadlineMs"], 1, STEP_DEADLINE_MAX_MS);
}

/** policy.runDeadlineMs, or null when absent/out of range. */
export function resolveRunDeadlineMs(
  policy: Readonly<Record<string, unknown>>,
): number | null {
  return intBetween(policy["runDeadlineMs"], 1, RUN_DEADLINE_MAX_MS);
}

/**
 * Absolute epoch-ms instant of the run-level deadline, or null when the run
 * has no usable runDeadlineMs (or an unparseable createdAt).
 */
export function runDeadlineAt(run: NarrativeRun): number | null {
  const runDeadlineMs = resolveRunDeadlineMs(run.policy);
  if (runDeadlineMs === null) return null;
  const createdMs = Date.parse(run.createdAt);
  if (Number.isNaN(createdMs)) return null;
  return createdMs + runDeadlineMs;
}

/**
 * Computes the tightest wall-clock deadline for a step starting at `nowMs`:
 * the minimum of the run deadline and the per-step deadline. Returns null
 * when neither applies. On ties the earlier candidate in run → step order
 * wins.
 */
export function computeStepDeadline(
  run: NarrativeRun,
  nowMs: number,
): StepDeadline | null {
  const candidates: Array<{ at: number; scope: DeadlineScope }> = [];
  const runAt = runDeadlineAt(run);
  if (runAt !== null) candidates.push({ at: runAt, scope: "run" });
  const stepMs = resolveStepDeadlineMs(run.policy);
  if (stepMs !== null) candidates.push({ at: nowMs + stepMs, scope: "step" });
  if (candidates.length === 0) return null;
  let winner = candidates[0]!;
  for (const candidate of candidates) {
    if (candidate.at < winner.at) winner = candidate;
  }
  return { at: winner.at, scope: winner.scope };
}

/**
 * Builds the fatal worker error for an expired deadline. `elapsedMs` is the
 * wall-clock time the step had already consumed.
 */
export function deadlineExceededError(
  deadline: StepDeadline,
  elapsedMs: number,
): RunStepError {
  return {
    code: DEADLINE_EXCEEDED_CODE,
    message: DEADLINE_MESSAGES[deadline.scope],
    retryable: false,
    details: {
      deadlineScope: deadline.scope,
      deadlineAt: new Date(deadline.at).toISOString(),
      elapsedMs: Math.max(0, Math.round(elapsedMs)),
    },
  };
}

const DEADLINE_MESSAGES: Record<DeadlineScope, string> = {
  step: "Step execution exceeded the stepDeadlineMs deadline",
  run: "Run exceeded the runDeadlineMs deadline",
};

function intBetween(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
    ? value
    : null;
}
