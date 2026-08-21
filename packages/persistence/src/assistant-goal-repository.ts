import type { NarrativeDatabase } from "./database.js";
import { PersistenceNotFoundError } from "./project-repository.js";

export type AssistantLongGoalPhase =
  "foundation" | "outline" | "writing" | "done";
export type AssistantLongGoalStatus =
  "active" | "paused_baseline" | "completed" | "failed" | "cancelled";

export interface AssistantLongGoal {
  id: string;
  projectId: string;
  conversationId: string;
  activityId: string;
  title: string;
  targetChapters: number;
  phase: AssistantLongGoalPhase;
  status: AssistantLongGoalStatus;
  baselineHash: string;
  sessionId: string | null;
  foundationRunId: string | null;
  outlineSessionId: string | null;
  lastError: Readonly<Record<string, unknown>> | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export class SqliteAssistantLongGoalRepository {
  constructor(private readonly database: NarrativeDatabase) {}

  insertGoal(input: Omit<AssistantLongGoal, "version">): AssistantLongGoal {
    this.database.raw
      .prepare(
        `INSERT INTO assistant_long_goals(
          id, project_id, conversation_id, activity_id, title, target_chapters,
          phase, status, baseline_hash, session_id, foundation_run_id,
          outline_session_id, last_error_json, created_at, updated_at, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
        ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        input.id,
        input.projectId,
        input.conversationId,
        input.activityId,
        input.title,
        input.targetChapters,
        input.phase,
        input.status,
        input.baselineHash,
        input.sessionId,
        input.foundationRunId,
        input.outlineSessionId,
        input.lastError ? JSON.stringify(input.lastError) : null,
        input.createdAt,
        input.updatedAt,
      );
    return this.requireGoal(input.id);
  }

  getGoal(id: string): AssistantLongGoal | null {
    const row = this.database.raw
      .prepare("SELECT * FROM assistant_long_goals WHERE id = ?")
      .get(id) as GoalRow | undefined;
    return row ? mapGoal(row) : null;
  }

  requireGoal(id: string): AssistantLongGoal {
    const goal = this.getGoal(id);
    if (!goal) throw new PersistenceNotFoundError("assistant_long_goal", id);
    return goal;
  }

  getActiveGoal(projectId: string): AssistantLongGoal | null {
    const row = this.database.raw
      .prepare(
        `SELECT * FROM assistant_long_goals
         WHERE project_id = ? AND status IN ('active','paused_baseline')
         ORDER BY created_at LIMIT 1`,
      )
      .get(projectId) as GoalRow | undefined;
    return row ? mapGoal(row) : null;
  }

  listGoals(projectId: string): AssistantLongGoal[] {
    const rows = this.database.raw
      .prepare(
        `SELECT * FROM assistant_long_goals
         WHERE project_id = ? ORDER BY created_at, id`,
      )
      .all(projectId) as unknown as GoalRow[];
    return rows.map(mapGoal);
  }

  listActionableGoals(): AssistantLongGoal[] {
    const rows = this.database.raw
      .prepare(
        `SELECT * FROM assistant_long_goals WHERE status = 'active'
         ORDER BY created_at`,
      )
      .all() as unknown as GoalRow[];
    return rows.map(mapGoal);
  }

  transitionGoal(
    id: string,
    expectedVersion: number,
    next: {
      phase?: AssistantLongGoalPhase | undefined;
      status?: AssistantLongGoalStatus | undefined;
      baselineHash?: string | undefined;
      sessionId?: string | null | undefined;
      foundationRunId?: string | null | undefined;
      outlineSessionId?: string | null | undefined;
      lastError?: Readonly<Record<string, unknown>> | null | undefined;
      now: string;
    },
  ): AssistantLongGoal {
    const goal = this.requireGoal(id);
    const phase = next.phase ?? goal.phase;
    const status = next.status ?? goal.status;
    const baselineHash = next.baselineHash ?? goal.baselineHash;
    const sessionId =
      next.sessionId === undefined ? goal.sessionId : next.sessionId;
    const foundationRunId =
      next.foundationRunId === undefined
        ? goal.foundationRunId
        : next.foundationRunId;
    const outlineSessionId =
      next.outlineSessionId === undefined
        ? goal.outlineSessionId
        : next.outlineSessionId;
    const lastError =
      next.lastError === undefined ? goal.lastError : next.lastError;
    const result = this.database.raw
      .prepare(
        `UPDATE assistant_long_goals
         SET phase = ?, status = ?, baseline_hash = ?, session_id = ?,
             foundation_run_id = ?, outline_session_id = ?, last_error_json = ?,
             updated_at = ?, version = version + 1
         WHERE id = ? AND version = ?`,
      )
      .run(
        phase,
        status,
        baselineHash,
        sessionId,
        foundationRunId,
        outlineSessionId,
        lastError ? JSON.stringify(lastError) : null,
        next.now,
        id,
        expectedVersion,
      );
    if (result.changes !== 1) {
      throw new AssistantLongGoalConflictError(
        "assistant.long_goal.conflict",
        `Long-term goal version has changed from ${expectedVersion}`,
      );
    }
    return this.requireGoal(id);
  }
}

export class AssistantLongGoalConflictError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AssistantLongGoalConflictError";
  }
}

interface GoalRow {
  id: string;
  project_id: string;
  conversation_id: string;
  activity_id: string;
  title: string;
  target_chapters: number;
  phase: AssistantLongGoalPhase;
  status: AssistantLongGoalStatus;
  baseline_hash: string;
  session_id: string | null;
  foundation_run_id: string | null;
  outline_session_id: string | null;
  last_error_json: string | null;
  created_at: string;
  updated_at: string;
  version: number;
}

function mapGoal(row: GoalRow): AssistantLongGoal {
  return {
    id: row.id,
    projectId: row.project_id,
    conversationId: row.conversation_id,
    activityId: row.activity_id,
    title: row.title,
    targetChapters: row.target_chapters,
    phase: row.phase,
    status: row.status,
    baselineHash: row.baseline_hash,
    sessionId: row.session_id,
    foundationRunId: row.foundation_run_id,
    outlineSessionId: row.outline_session_id,
    lastError: row.last_error_json
      ? (JSON.parse(row.last_error_json) as Readonly<Record<string, unknown>>)
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
}
