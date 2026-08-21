import { randomUuid, sha256Hex } from "@narralume/domain";

import type {
  NarrativeCheckpoint,
  NarrativeRun,
  NarrativeRunEvent,
  NarrativeRunStep,
  RunBudgetUsage,
  RunMode,
  RunSnapshot,
  RunStepError,
  RunStatus,
} from "@narralume/domain";

import type { NarrativeDatabase } from "./database.js";
import { PersistenceNotFoundError } from "./project-repository.js";

export interface RunStepSeedInput {
  id: string;
  ordinal: number;
  kind: NarrativeRunStep["kind"];
  cycle: number;
  idempotencyKey: string;
  maxAttempts: number;
}

export interface CreateRunInput {
  id: string;
  projectId: string;
  recipe: string;
  recipeVersion: number;
  mode: RunMode;
  targetOutlineNodeId: string | null;
  policy: Readonly<Record<string, unknown>>;
  steps: readonly RunStepSeedInput[];
  now: string;
  priority?: number;
}

/** A persisted run_events row, delivered to the optional onEvent listener. */
export interface RunEventRecord {
  runId: string;
  stepId: string | null;
  sequence: number;
  type: string;
  payload: Record<string, unknown>;
}

export type RunEventListener = (event: RunEventRecord) => void;

export class SqliteRunRepository {
  constructor(
    private readonly database: NarrativeDatabase,
    private onEvent?: RunEventListener,
  ) {}

  /**
   * Registers (or clears) the listener invoked synchronously after every
   * persisted run event. Used by the server to push run_events over SSE.
   */
  setEventListener(listener: RunEventListener | undefined): void {
    this.onEvent = listener;
  }

  create(input: CreateRunInput): RunSnapshot {
    return this.database.transaction(() => {
      requireUniqueOrdinals(input.steps);
      this.database.raw
        .prepare(
          `INSERT INTO runs(
            id, project_id, recipe, mode, status, policy_json, current_step_id,
            started_at, finished_at, created_at, updated_at, recipe_version,
            target_outline_node_id, budget_used_json,
            revision_cycle, pause_requested, cancel_requested, version
          ) VALUES (?, ?, ?, ?, 'pending', ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, 0, 0, 0, 0)`,
        )
        .run(
          input.id,
          input.projectId,
          input.recipe,
          input.mode,
          JSON.stringify(input.policy),
          input.now,
          input.now,
          input.recipeVersion,
          input.targetOutlineNodeId,
          JSON.stringify(ZERO_USAGE),
        );
      const insertStep = this.database.raw.prepare(
        `INSERT INTO run_steps(
          id, run_id, ordinal, kind, status, idempotency_key, input_hash,
          output_artifact_json, error_json, attempt, started_at, finished_at,
          created_at, cycle, max_attempts, output_hash, updated_at
        ) VALUES (?, ?, ?, ?, 'pending', ?, NULL, NULL, NULL, 0, NULL, NULL, ?, ?, ?, NULL, ?)`,
      );
      for (const step of input.steps) {
        insertStep.run(
          step.id,
          input.id,
          step.ordinal,
          step.kind,
          step.idempotencyKey,
          input.now,
          step.cycle,
          step.maxAttempts,
          input.now,
        );
      }
      this.database.raw
        .prepare(
          `INSERT INTO run_jobs(
            run_id, status, priority, available_at, lease_owner, lease_expires_at,
            last_error_json, created_at, updated_at
          ) VALUES (?, 'queued', ?, ?, NULL, NULL, NULL, ?, ?)`,
        )
        .run(input.id, input.priority ?? 0, input.now, input.now, input.now);
      this.appendEvent(
        input.id,
        null,
        "run.created",
        {
          recipe: input.recipe,
          recipeVersion: input.recipeVersion,
          stepCount: input.steps.length,
        },
        input.now,
      );
      return this.getSnapshot(input.id);
    });
  }

  getRun(runId: string): NarrativeRun | null {
    const row = this.database.raw
      .prepare("SELECT * FROM runs WHERE id = ?")
      .get(runId) as RunRow | undefined;
    return row ? mapRun(row) : null;
  }

  listRuns(projectId: string, limit = 100): NarrativeRun[] {
    const rows = this.database.raw
      .prepare(
        "SELECT * FROM runs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?",
      )
      .all(projectId, Math.max(1, Math.min(limit, 500))) as unknown as RunRow[];
    return rows.map(mapRun);
  }

  /**
   * Every non-terminal run of a project, without the display window's LIMIT.
   * Business decisions ("is a writing task already active?") must use this
   * instead of the paginated listRuns window.
   */
  listActiveRuns(projectId: string): NarrativeRun[] {
    const rows = this.database.raw
      .prepare(
        `SELECT * FROM runs WHERE project_id = ?
         AND status IN ('pending', 'running', 'paused', 'awaiting_user', 'failed_recoverable')
         ORDER BY created_at DESC`,
      )
      .all(projectId) as unknown as RunRow[];
    return rows.map(mapRun);
  }

  /**
   * Non-terminal runs of one cocreate session (policy.sessionId), used to
   * cancel reply/adoption workers whose source context was reverted.
   */
  listActiveRunsBySession(sessionId: string): NarrativeRun[] {
    const rows = this.database.raw
      .prepare(
        `SELECT * FROM runs
         WHERE json_extract(policy_json, '$.sessionId') = ?
         AND status IN ('pending', 'running', 'paused', 'awaiting_user', 'failed_recoverable')
         ORDER BY created_at DESC`,
      )
      .all(sessionId) as unknown as RunRow[];
    return rows.map(mapRun);
  }

  getSnapshot(runId: string): RunSnapshot {
    const run = this.getRun(runId);
    if (!run) throw new PersistenceNotFoundError("run", runId);
    const stepRows = this.database.raw
      .prepare("SELECT * FROM run_steps WHERE run_id = ? ORDER BY ordinal")
      .all(runId) as unknown as StepRow[];
    const eventRows = this.database.raw
      .prepare("SELECT * FROM run_events WHERE run_id = ? ORDER BY sequence")
      .all(runId) as unknown as EventRow[];
    const checkpointRow = this.database.raw
      .prepare(
        "SELECT * FROM checkpoints WHERE run_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )
      .get(runId) as CheckpointRow | undefined;
    return {
      run,
      steps: stepRows.map(mapStep),
      events: eventRows.map(mapEvent),
      latestCheckpoint: checkpointRow ? mapCheckpoint(checkpointRow) : null,
    };
  }

  leaseNext(
    workerId: string,
    now: string,
    leaseMs: number,
  ): { runId: string; leaseOwner: string } | null {
    return this.database.transaction(() => {
      this.recoverExpiredLeases(now);
      const job = this.database.raw
        .prepare(
          `SELECT run_id FROM run_jobs
           WHERE status = 'queued' AND available_at <= ?
           ORDER BY priority DESC, created_at, run_id LIMIT 1`,
        )
        .get(now) as { run_id: string } | undefined;
      return job ? this.acquireLease(job.run_id, workerId, now, leaseMs) : null;
    });
  }

  nextQueuedAvailableAt(): string | null {
    const row = this.database.raw
      .prepare(
        `SELECT MIN(available_at) AS available_at
         FROM run_jobs WHERE status = 'queued'`,
      )
      .get() as { available_at: string | null } | undefined;
    return row?.available_at ?? null;
  }

  leaseRun(
    runId: string,
    workerId: string,
    now: string,
    leaseMs: number,
  ): { runId: string; leaseOwner: string } | null {
    return this.database.transaction(() => {
      this.requireRun(runId);
      this.recoverExpiredLeases(now);
      const job = this.database.raw
        .prepare(
          `SELECT run_id FROM run_jobs
           WHERE run_id = ? AND status = 'queued' AND available_at <= ?`,
        )
        .get(runId, now) as { run_id: string } | undefined;
      return job ? this.acquireLease(job.run_id, workerId, now, leaseMs) : null;
    });
  }

  renewLease(
    runId: string,
    workerId: string,
    now: string,
    leaseMs: number,
  ): boolean {
    const expiresAt = new Date(
      new Date(now).getTime() + Math.max(1_000, leaseMs),
    ).toISOString();
    return this.database.transaction(() => {
      const changed = this.database.raw
        .prepare(
          `UPDATE run_jobs SET lease_expires_at = ?, updated_at = ?
           WHERE run_id = ? AND status = 'leased' AND lease_owner = ?`,
        )
        .run(expiresAt, now, runId, workerId);
      if (changed.changes !== 1) return false;
      this.database.raw
        .prepare(
          `UPDATE runs SET lease_expires_at = ?, updated_at = ?
           WHERE id = ? AND lease_owner = ?`,
        )
        .run(expiresAt, now, runId, workerId);
      return true;
    });
  }

  private acquireLease(
    runId: string,
    workerId: string,
    now: string,
    leaseMs: number,
  ): { runId: string; leaseOwner: string } | null {
    const expiresAt = new Date(
      new Date(now).getTime() + Math.max(1_000, leaseMs),
    ).toISOString();
    const changed = this.database.raw
      .prepare(
        `UPDATE run_jobs SET status = 'leased', lease_owner = ?, lease_expires_at = ?,
           updated_at = ? WHERE run_id = ? AND status = 'queued'`,
      )
      .run(workerId, expiresAt, now, runId);
    if (changed.changes !== 1) return null;
    this.database.raw
      .prepare(
        `UPDATE runs SET lease_owner = ?, lease_expires_at = ?,
           status = CASE WHEN status = 'pending' THEN 'running' ELSE status END,
           started_at = COALESCE(started_at, ?), updated_at = ?, version = version + 1
         WHERE id = ?`,
      )
      .run(workerId, expiresAt, now, now, runId);
    this.appendEvent(
      runId,
      null,
      "run.leased",
      {
        workerId,
        expiresAt,
      },
      now,
    );
    return { runId, leaseOwner: workerId };
  }

  startStep(runId: string, stepId: string, now: string): NarrativeRunStep {
    return this.database.transaction(() => {
      const step = this.requireStep(runId, stepId);
      if (step.status !== "pending" && step.status !== "failed") {
        throw new RunPersistenceError(
          "run.step.not_startable",
          `Step ${stepId} in status ${step.status} cannot be started`,
        );
      }
      if (step.attempt >= step.maxAttempts) {
        throw new RunPersistenceError(
          "run.step.attempts_exhausted",
          `Step ${stepId} has exhausted its retries`,
        );
      }
      this.database.raw
        .prepare(
          `UPDATE run_steps SET status = 'running', attempt = attempt + 1,
             error_json = NULL, started_at = ?, finished_at = NULL, updated_at = ?
           WHERE run_id = ? AND id = ?`,
        )
        .run(now, now, runId, stepId);
      this.database.raw
        .prepare(
          `UPDATE runs SET status = 'running', current_step_id = ?, updated_at = ?,
             version = version + 1 WHERE id = ?`,
        )
        .run(stepId, now, runId);
      this.appendEvent(
        runId,
        stepId,
        "step.started",
        {
          kind: step.kind,
          attempt: step.attempt + 1,
          cycle: step.cycle,
        },
        now,
      );
      return this.requireStep(runId, stepId);
    });
  }

  succeedStep(
    runId: string,
    stepId: string,
    output: Readonly<Record<string, unknown>>,
    artifactKind: string,
    now: string,
  ): void {
    this.database.transaction(() => {
      const step = this.requireStep(runId, stepId);
      if (step.status !== "running")
        throw new RunPersistenceError(
          "run.step.not_running",
          `Step ${stepId} is not running`,
        );
      const serialized = stableJson(output);
      const outputHash = hash(serialized);
      this.database.raw
        .prepare(
          `UPDATE run_steps SET status = 'succeeded', output_artifact_json = ?,
             output_hash = ?, finished_at = ?, updated_at = ?
           WHERE run_id = ? AND id = ?`,
        )
        .run(serialized, outputHash, now, now, runId, stepId);
      const version = (
        this.database.raw
          .prepare(
            "SELECT COALESCE(MAX(version), 0) + 1 AS version FROM run_artifacts WHERE run_id = ? AND kind = ?",
          )
          .get(runId, artifactKind) as { version: number }
      ).version;
      const artifactId = randomUuid();
      this.database.raw
        .prepare(
          `INSERT INTO run_artifacts(
            id, run_id, step_id, kind, version, content_json, content_hash, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          artifactId,
          runId,
          stepId,
          artifactKind,
          version,
          serialized,
          outputHash,
          now,
        );
      this.database.raw
        .prepare(
          `UPDATE runs SET current_step_id = NULL,
             revision_cycle = MAX(revision_cycle, ?), updated_at = ?, version = version + 1
           WHERE id = ?`,
        )
        .run(step.cycle, now, runId);
      this.appendEvent(
        runId,
        stepId,
        "step.succeeded",
        {
          artifactId,
          artifactKind,
          outputHash,
        },
        now,
      );
      this.createCheckpoint(
        runId,
        stepId,
        `after:${step.kind}`,
        {
          stepId,
          outputHash,
          artifactId,
          artifactKind,
        },
        now,
      );
    });
  }

  failStep(
    runId: string,
    stepId: string,
    error: RunStepError,
    now: string,
  ): void {
    this.database.transaction(() => {
      const step = this.requireStep(runId, stepId);
      if (step.status !== "running")
        throw new RunPersistenceError(
          "run.step.not_running",
          `Step ${stepId} is not running`,
        );
      const recoverable = error.retryable && step.attempt < step.maxAttempts;
      this.database.raw
        .prepare(
          `UPDATE run_steps SET status = 'failed', error_json = ?, finished_at = ?,
             updated_at = ? WHERE run_id = ? AND id = ?`,
        )
        .run(JSON.stringify(error), now, now, runId, stepId);
      this.database.raw
        .prepare(
          `UPDATE runs SET status = ?, current_step_id = NULL, updated_at = ?,
             version = version + 1 WHERE id = ?`,
        )
        .run(recoverable ? "failed_recoverable" : "running", now, runId);
      this.appendEvent(
        runId,
        stepId,
        "step.failed",
        {
          ...error,
          recoverable,
        },
        now,
      );
    });
  }

  recordBudget(
    runId: string,
    stepId: string,
    usage: RunBudgetUsage,
    now: string,
  ): void {
    this.database.transaction(() => {
      this.requireStep(runId, stepId);
      const run = this.requireRun(runId);
      const next: RunBudgetUsage = {
        inputTokens: run.budgetUsage.inputTokens + usage.inputTokens,
        outputTokens: run.budgetUsage.outputTokens + usage.outputTokens,
        calls: run.budgetUsage.calls + usage.calls,
        costUsd: run.budgetUsage.costUsd + usage.costUsd,
        wallTimeMs: run.budgetUsage.wallTimeMs + usage.wallTimeMs,
      };
      this.database.raw
        .prepare(
          `INSERT INTO run_budget_entries(
            run_id, step_id, call_id, input_tokens, output_tokens, cost_usd,
            wall_time_ms, created_at
          ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`,
        )
        .run(
          runId,
          stepId,
          usage.inputTokens,
          usage.outputTokens,
          usage.costUsd,
          usage.wallTimeMs,
          now,
        );
      this.database.raw
        .prepare(
          "UPDATE runs SET budget_used_json = ?, updated_at = ?, version = version + 1 WHERE id = ?",
        )
        .run(JSON.stringify(next), now, runId);
      this.appendEvent(runId, stepId, "budget.recorded", { ...usage }, now);
    });
  }

  skipSteps(
    runId: string,
    stepIds: readonly string[],
    reason: string,
    now: string,
  ): void {
    this.database.transaction(() => {
      for (const stepId of new Set(stepIds)) {
        const step = this.requireStep(runId, stepId);
        if (step.status !== "pending") continue;
        this.database.raw
          .prepare(
            `UPDATE run_steps SET status = 'skipped', output_artifact_json = ?,
               finished_at = ?, updated_at = ? WHERE run_id = ? AND id = ?`,
          )
          .run(JSON.stringify({ reason }), now, now, runId, stepId);
        this.appendEvent(runId, stepId, "step.skipped", { reason }, now);
      }
      this.database.raw
        .prepare(
          "UPDATE runs SET updated_at = ?, version = version + 1 WHERE id = ?",
        )
        .run(now, runId);
    });
  }

  setRunStatus(
    runId: string,
    status: RunStatus,
    now: string,
    reason?: string,
  ): void {
    this.database.transaction(() => {
      this.requireRun(runId);
      const terminal = ["failed", "cancelled", "completed"].includes(status);
      this.database.raw
        .prepare(
          `UPDATE runs SET status = ?, current_step_id = NULL,
             pause_requested = CASE WHEN ? = 'paused' THEN 0 ELSE pause_requested END,
             cancel_requested = CASE WHEN ? = 'cancelled' THEN 0 ELSE cancel_requested END,
             finished_at = CASE WHEN ? THEN ? ELSE finished_at END,
             updated_at = ?, version = version + 1 WHERE id = ?`,
        )
        .run(status, status, status, terminal ? 1 : 0, now, now, runId);
      if (status === "cancelled") {
        this.database.raw
          .prepare(
            "UPDATE run_steps SET status = 'cancelled', finished_at = ?, updated_at = ? WHERE run_id = ? AND status IN ('pending','running')",
          )
          .run(now, now, runId);
      }
      this.appendEvent(
        runId,
        null,
        `run.${status}`,
        {
          ...(reason ? { reason } : {}),
        },
        now,
      );
    });
  }

  consumeRecoverableRun(
    runId: string,
    now: string,
    reason: string,
  ): NarrativeRun {
    return this.database.transaction(() => {
      const run = this.requireRun(runId);
      if (run.status !== "failed_recoverable") {
        throw new RunPersistenceError(
          "run.partial.not_recoverable",
          `Run ${runId} in status ${run.status} cannot consume a partial`,
        );
      }
      this.setRunStatus(runId, "cancelled", now, reason);
      this.database.raw
        .prepare(
          `UPDATE run_jobs SET status = 'finished', available_at = ?,
             lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
           WHERE run_id = ? AND status IN ('queued', 'waiting')`,
        )
        .run(now, now, runId);
      return this.requireRun(runId);
    });
  }

  requestPause(runId: string, now: string): void {
    this.setControlFlag(
      runId,
      "pause_requested",
      true,
      "run.pause_requested",
      now,
    );
  }

  requestCancel(runId: string, now: string): void {
    this.setControlFlag(
      runId,
      "cancel_requested",
      true,
      "run.cancel_requested",
      now,
    );
  }

  resume(runId: string, now: string): void {
    this.database.transaction(() => {
      const run = this.requireRun(runId);
      if (run.status !== "paused" && run.status !== "awaiting_user") {
        throw new RunPersistenceError(
          "run.not_resumable",
          `Run ${runId} in status ${run.status} cannot be resumed`,
        );
      }
      this.database.raw
        .prepare(
          `UPDATE runs SET status = 'running', pause_requested = 0,
             updated_at = ?, version = version + 1 WHERE id = ?`,
        )
        .run(now, runId);
      this.database.raw
        .prepare(
          `UPDATE run_jobs SET status = 'queued', available_at = ?, lease_owner = NULL,
             lease_expires_at = NULL, updated_at = ? WHERE run_id = ?`,
        )
        .run(now, now, runId);
      this.appendEvent(runId, null, "run.resumed", {}, now);
    });
  }

  mergePolicy(
    runId: string,
    patch: Readonly<Record<string, unknown>>,
    now: string,
  ): NarrativeRun {
    const run = this.requireRun(runId);
    const policy = { ...run.policy, ...patch };
    this.database.raw
      .prepare(
        "UPDATE runs SET policy_json = ?, updated_at = ?, version = version + 1 WHERE id = ?",
      )
      .run(JSON.stringify(policy), now, runId);
    return this.requireRun(runId);
  }

  finishLease(
    runId: string,
    workerId: string,
    options: { requeue: boolean; delayMs?: number; error?: RunStepError },
    now: string,
  ): void {
    this.database.transaction(() => {
      const run = this.requireRun(runId);
      const status = options.requeue
        ? "queued"
        : ["completed", "failed", "cancelled"].includes(run.status)
          ? "finished"
          : "waiting";
      const availableAt = new Date(
        new Date(now).getTime() + (options.delayMs ?? 0),
      ).toISOString();
      const changed = this.database.raw
        .prepare(
          `UPDATE run_jobs SET status = ?, available_at = ?, lease_owner = NULL,
             lease_expires_at = NULL, last_error_json = ?, updated_at = ?
           WHERE run_id = ? AND lease_owner = ?`,
        )
        .run(
          status,
          availableAt,
          options.error ? JSON.stringify(options.error) : null,
          now,
          runId,
          workerId,
        );
      if (changed.changes !== 1) {
        throw new RunPersistenceError(
          "run.lease.lost",
          `The lease of run ${runId} does not belong to ${workerId}`,
        );
      }
      this.database.raw
        .prepare(
          "UPDATE runs SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?",
        )
        .run(now, runId);
    });
  }

  recoverExpiredLeases(now: string): number {
    return this.database.transaction(() => {
      const expired = this.database.raw
        .prepare(
          `SELECT run_id, lease_owner FROM run_jobs
           WHERE status = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
        )
        .all(now) as unknown as {
        run_id: string;
        lease_owner: string | null;
      }[];
      for (const row of expired) {
        const runningSteps = this.database.raw
          .prepare(
            `SELECT id, attempt, max_attempts FROM run_steps
             WHERE run_id = ? AND status = 'running' ORDER BY ordinal`,
          )
          .all(row.run_id) as unknown as Array<{
          id: string;
          attempt: number;
          max_attempts: number;
        }>;
        for (const step of runningSteps) {
          const error: RunStepError = {
            code: "run.lease_expired",
            message: "Worker lease expired while the step was running",
            retryable: step.attempt < step.max_attempts,
            details: { priorLeaseOwner: row.lease_owner },
          };
          this.database.raw
            .prepare(
              `UPDATE run_steps SET status = 'failed', error_json = ?,
                 finished_at = ?, updated_at = ? WHERE run_id = ? AND id = ?
                 AND status = 'running'`,
            )
            .run(JSON.stringify(error), now, now, row.run_id, step.id);
          this.appendEvent(
            row.run_id,
            step.id,
            "step.recovered_after_lease_expiry",
            { ...error, attempt: step.attempt },
            now,
          );
        }
        this.database.raw
          .prepare(
            `UPDATE run_jobs SET status = 'queued', lease_owner = NULL,
               lease_expires_at = NULL, available_at = ?, updated_at = ? WHERE run_id = ?`,
          )
          .run(now, now, row.run_id);
        this.database.raw
          .prepare(
            `UPDATE runs SET lease_owner = NULL, lease_expires_at = NULL,
               current_step_id = CASE WHEN ? > 0 THEN NULL ELSE current_step_id END,
               status = CASE WHEN ? > 0 THEN 'failed_recoverable' ELSE status END,
               updated_at = ?, version = version + 1 WHERE id = ?`,
          )
          .run(runningSteps.length, runningSteps.length, now, row.run_id);
        this.appendEvent(
          row.run_id,
          null,
          "run.lease_expired",
          {
            priorLeaseOwner: row.lease_owner,
            recoveredStepIds: runningSteps.map((step) => step.id),
          },
          now,
        );
      }
      return expired.length;
    });
  }

  private setControlFlag(
    runId: string,
    column: "pause_requested" | "cancel_requested",
    value: boolean,
    event: string,
    now: string,
  ): void {
    this.database.transaction(() => {
      this.requireRun(runId);
      this.database.raw
        .prepare(
          `UPDATE runs SET ${column} = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
        )
        .run(value ? 1 : 0, now, runId);
      this.database.raw
        .prepare(
          `UPDATE run_jobs SET status = CASE WHEN status = 'waiting' THEN 'queued' ELSE status END,
             available_at = ?, updated_at = ? WHERE run_id = ?`,
        )
        .run(now, now, runId);
      this.appendEvent(runId, null, event, {}, now);
    });
  }

  private createCheckpoint(
    runId: string,
    stepId: string | null,
    kind: string,
    state: Readonly<Record<string, unknown>>,
    now: string,
  ): NarrativeCheckpoint {
    const serialized = stableJson(state);
    const checkpoint: NarrativeCheckpoint = {
      id: randomUuid(),
      runId,
      stepId,
      kind,
      state,
      stateHash: hash(serialized),
      createdAt: now,
    };
    this.database.raw
      .prepare(
        `INSERT INTO checkpoints(id, run_id, step_id, kind, state_json, state_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        checkpoint.id,
        checkpoint.runId,
        checkpoint.stepId,
        checkpoint.kind,
        serialized,
        checkpoint.stateHash,
        checkpoint.createdAt,
      );
    return checkpoint;
  }

  /**
   * Public event-append entry point for the harness supervisor. Wraps the
   * shared appendEvent in a transaction so the sequence allocation
   * (MAX(sequence) + 1) cannot race a concurrent writer.
   */
  appendRunEvent(
    runId: string,
    stepId: string | null,
    type: string,
    payload: Readonly<Record<string, unknown>>,
    now: string,
  ): void {
    this.database.transaction(() => {
      this.requireRun(runId);
      this.appendEvent(runId, stepId, type, payload, now);
    });
  }

  private appendEvent(
    runId: string,
    stepId: string | null,
    type: string,
    payload: Readonly<Record<string, unknown>>,
    now: string,
  ): void {
    const sequence = (
      this.database.raw
        .prepare(
          "SELECT COALESCE(MAX(sequence), -1) + 1 AS sequence FROM run_events WHERE run_id = ?",
        )
        .get(runId) as { sequence: number }
    ).sequence;
    this.database.raw
      .prepare(
        `INSERT INTO run_events(run_id, step_id, sequence, type, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(runId, stepId, sequence, type, JSON.stringify(payload), now);
    const event = {
      runId,
      stepId,
      sequence,
      type,
      payload: { ...payload },
    };
    this.database.afterCommit(() => {
      if (this.onEvent) {
        try {
          this.onEvent(event);
        } catch {
          // Listener errors are swallowed: persistence is the source of truth.
        }
      }
      // Database-level subscribers observe only committed rows, regardless of
      // which repository instance created the event.
      this.database.notifyRunEvent(event);
    });
  }

  private requireRun(runId: string): NarrativeRun {
    const run = this.getRun(runId);
    if (!run) throw new PersistenceNotFoundError("run", runId);
    return run;
  }

  private requireStep(runId: string, stepId: string): NarrativeRunStep {
    const row = this.database.raw
      .prepare("SELECT * FROM run_steps WHERE run_id = ? AND id = ?")
      .get(runId, stepId) as StepRow | undefined;
    if (!row) throw new PersistenceNotFoundError("run_step", stepId);
    return mapStep(row);
  }
}

export class RunPersistenceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RunPersistenceError";
  }
}

interface RunRow {
  id: string;
  project_id: string;
  recipe: string;
  recipe_version: number;
  mode: NarrativeRun["mode"];
  status: NarrativeRun["status"];
  target_outline_node_id: string | null;
  policy_json: string;
  budget_used_json: string;
  revision_cycle: number;
  pause_requested: number;
  cancel_requested: number;
  current_step_id: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
  version: number;
}

interface StepRow {
  id: string;
  run_id: string;
  ordinal: number;
  kind: NarrativeRunStep["kind"];
  cycle: number;
  status: NarrativeRunStep["status"];
  idempotency_key: string;
  input_hash: string | null;
  output_artifact_json: string | null;
  output_hash: string | null;
  error_json: string | null;
  attempt: number;
  max_attempts: number;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string | null;
}

interface EventRow {
  id: number;
  run_id: string;
  step_id: string | null;
  sequence: number;
  type: string;
  payload_json: string;
  created_at: string;
}

interface CheckpointRow {
  id: string;
  run_id: string;
  step_id: string | null;
  kind: string;
  state_json: string;
  state_hash: string;
  created_at: string;
}

const ZERO_USAGE: RunBudgetUsage = {
  inputTokens: 0,
  outputTokens: 0,
  calls: 0,
  costUsd: 0,
  wallTimeMs: 0,
};

function mapRun(row: RunRow): NarrativeRun {
  return {
    id: row.id,
    projectId: row.project_id,
    recipe: row.recipe,
    recipeVersion: row.recipe_version,
    mode: row.mode,
    status: row.status,
    targetOutlineNodeId: row.target_outline_node_id,
    policy: parseObject(row.policy_json),
    budgetUsage: JSON.parse(row.budget_used_json) as RunBudgetUsage,
    revisionCycle: row.revision_cycle,
    pauseRequested: row.pause_requested === 1,
    cancelRequested: row.cancel_requested === 1,
    currentStepId: row.current_step_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

function mapStep(row: StepRow): NarrativeRunStep {
  return {
    id: row.id,
    runId: row.run_id,
    ordinal: row.ordinal,
    kind: row.kind,
    cycle: row.cycle,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    inputHash: row.input_hash,
    outputArtifact: row.output_artifact_json
      ? parseObject(row.output_artifact_json)
      : null,
    outputHash: row.output_hash,
    error: row.error_json ? (JSON.parse(row.error_json) as RunStepError) : null,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? row.created_at,
  };
}

function mapEvent(row: EventRow): NarrativeRunEvent {
  return {
    id: row.id,
    runId: row.run_id,
    stepId: row.step_id,
    sequence: row.sequence,
    type: row.type,
    payload: parseObject(row.payload_json),
    createdAt: row.created_at,
  };
}

function mapCheckpoint(row: CheckpointRow): NarrativeCheckpoint {
  return {
    id: row.id,
    runId: row.run_id,
    stepId: row.step_id,
    kind: row.kind,
    state: parseObject(row.state_json),
    stateHash: row.state_hash,
    createdAt: row.created_at,
  };
}

function parseObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}

function hash(value: string): string {
  return sha256Hex(value);
}

function requireUniqueOrdinals(steps: readonly RunStepSeedInput[]): void {
  const ordinals = new Set(steps.map((step) => step.ordinal));
  const ids = new Set(steps.map((step) => step.id));
  const keys = new Set(steps.map((step) => step.idempotencyKey));
  if (
    ordinals.size !== steps.length ||
    ids.size !== steps.length ||
    keys.size !== steps.length
  ) {
    throw new RunPersistenceError(
      "run.recipe.duplicate_step",
      "Run step IDs, ordinals, and idempotency keys must be unique",
    );
  }
}
