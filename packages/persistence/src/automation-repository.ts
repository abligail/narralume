import type {
  AutopilotRunLink,
  AutopilotRunRole,
  AutopilotSession,
  AutopilotSessionStatus,
  FoundationCandidate,
  FoundationCandidateKind,
  FoundationCandidateSet,
  FoundationCandidateStatus,
  PlanningReview,
  SteerClassification,
  StoryCompass,
  StorySteer,
} from "@narralume/domain";

import type { NarrativeDatabase } from "./database.js";
import { PersistenceNotFoundError } from "./project-repository.js";

export interface CandidateSetDetail {
  set: FoundationCandidateSet;
  candidates: FoundationCandidate[];
}

export class SqliteAutomationRepository {
  constructor(private readonly database: NarrativeDatabase) {}

  upsertCompass(compass: StoryCompass): StoryCompass {
    this.database.raw
      .prepare(
        `INSERT INTO story_compasses(
          project_id, core_promise, ending_direction, long_lines_json,
          theme_questions_json, target_json, constraints_json, version, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id) DO UPDATE SET
          core_promise = excluded.core_promise,
          ending_direction = excluded.ending_direction,
          long_lines_json = excluded.long_lines_json,
          theme_questions_json = excluded.theme_questions_json,
          target_json = excluded.target_json,
          constraints_json = excluded.constraints_json,
          version = story_compasses.version + 1,
          updated_at = excluded.updated_at`,
      )
      .run(
        compass.projectId,
        compass.corePromise,
        compass.endingDirection,
        JSON.stringify(compass.longLines),
        JSON.stringify(compass.themeQuestions),
        JSON.stringify(compass.target),
        JSON.stringify(compass.constraints),
        compass.version,
        compass.updatedAt,
      );
    return this.requireCompass(compass.projectId);
  }

  getCompass(projectId: string): StoryCompass | null {
    const row = this.database.raw
      .prepare("SELECT * FROM story_compasses WHERE project_id = ?")
      .get(projectId) as CompassRow | undefined;
    return row ? mapCompass(row) : null;
  }

  requireCompass(projectId: string): StoryCompass {
    const compass = this.getCompass(projectId);
    if (!compass)
      throw new PersistenceNotFoundError("story_compass", projectId);
    return compass;
  }

  stageCandidateSet(input: {
    id: string;
    projectId: string;
    sourceRunId: string;
    title: string;
    candidates: readonly {
      id: string;
      kind: FoundationCandidateKind;
      label: string;
      payload: Readonly<Record<string, unknown>>;
    }[];
    now: string;
  }): CandidateSetDetail {
    return this.database.transaction(() => {
      const existing = this.getCandidateSet(input.id);
      if (existing) return existing;
      this.database.raw
        .prepare(
          `INSERT INTO foundation_candidate_sets(
            id, project_id, source_run_id, title, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'open', ?, ?)`,
        )
        .run(
          input.id,
          input.projectId,
          input.sourceRunId,
          input.title,
          input.now,
          input.now,
        );
      const insert = this.database.raw.prepare(
        `INSERT INTO foundation_candidates(
          id, set_id, project_id, kind, label, payload_json, edited_payload_json,
          status, adopted_ref_type, adopted_ref_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, 'pending', NULL, NULL, ?, ?)`,
      );
      for (const candidate of input.candidates) {
        insert.run(
          candidate.id,
          input.id,
          input.projectId,
          candidate.kind,
          candidate.label,
          JSON.stringify(candidate.payload),
          input.now,
          input.now,
        );
      }
      return this.requireCandidateSet(input.id);
    });
  }

  listCandidateSets(projectId: string): CandidateSetDetail[] {
    const rows = this.database.raw
      .prepare(
        "SELECT * FROM foundation_candidate_sets WHERE project_id = ? ORDER BY created_at DESC",
      )
      .all(projectId) as unknown as CandidateSetRow[];
    return rows.map((row) => ({
      set: mapCandidateSet(row),
      candidates: this.listCandidates(row.id),
    }));
  }

  getCandidateSet(id: string): CandidateSetDetail | null {
    const row = this.database.raw
      .prepare("SELECT * FROM foundation_candidate_sets WHERE id = ?")
      .get(id) as CandidateSetRow | undefined;
    return row
      ? { set: mapCandidateSet(row), candidates: this.listCandidates(id) }
      : null;
  }

  requireCandidateSet(id: string): CandidateSetDetail {
    const detail = this.getCandidateSet(id);
    if (!detail) throw new PersistenceNotFoundError("candidate_set", id);
    return detail;
  }

  getCandidate(id: string): FoundationCandidate | null {
    const row = this.database.raw
      .prepare("SELECT * FROM foundation_candidates WHERE id = ?")
      .get(id) as CandidateRow | undefined;
    return row ? mapCandidate(row) : null;
  }

  requireCandidate(id: string): FoundationCandidate {
    const candidate = this.getCandidate(id);
    if (!candidate) throw new PersistenceNotFoundError("candidate", id);
    return candidate;
  }

  resolveCandidate(
    id: string,
    input: {
      status: Extract<FoundationCandidateStatus, "adopted" | "discarded">;
      editedPayload?: Readonly<Record<string, unknown>> | null;
      adoptedRefType?: string | null;
      adoptedRefId?: string | null;
      now: string;
    },
  ): FoundationCandidate {
    return this.database.transaction(() => {
      const candidate = this.requireCandidate(id);
      if (candidate.status !== "pending") return candidate;
      this.database.raw
        .prepare(
          `UPDATE foundation_candidates SET status = ?, edited_payload_json = ?,
             adopted_ref_type = ?, adopted_ref_id = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          input.status,
          input.editedPayload ? JSON.stringify(input.editedPayload) : null,
          input.adoptedRefType ?? null,
          input.adoptedRefId ?? null,
          input.now,
          id,
        );
      this.refreshCandidateSetStatus(candidate.setId, input.now);
      return this.requireCandidate(id);
    });
  }

  discardPendingCandidates(setId: string, now: string): CandidateSetDetail {
    return this.database.transaction(() => {
      this.requireCandidateSet(setId);
      this.database.raw
        .prepare(
          `UPDATE foundation_candidates SET status = 'discarded', updated_at = ?
           WHERE set_id = ? AND status = 'pending'`,
        )
        .run(now, setId);
      this.refreshCandidateSetStatus(setId, now);
      return this.requireCandidateSet(setId);
    });
  }

  createSession(input: {
    id: string;
    projectId: string;
    mode: AutopilotSession["mode"];
    targetChapters: number;
    windowSize: number;
    maxRevisionCycles: number;
    chapterPolicy: Readonly<Record<string, unknown>>;
    now: string;
  }): AutopilotSession {
    this.database.raw
      .prepare(
        `INSERT INTO autopilot_sessions(
          id, project_id, mode, status, target_chapters, window_size,
          max_revision_cycles, chapter_policy_json,
          current_run_id, current_outline_node_id, completed_chapters,
          skipped_chapters, pause_requested, cancel_requested, replan_requested,
          active_notes_json, last_error_json, created_at, updated_at, finished_at, version
        ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, NULL, NULL, 0, 0, 0, 0, 0,
          '[]', NULL, ?, ?, NULL, 0)`,
      )
      .run(
        input.id,
        input.projectId,
        input.mode,
        input.targetChapters,
        input.windowSize,
        input.maxRevisionCycles,
        JSON.stringify(input.chapterPolicy),
        input.now,
        input.now,
      );
    return this.requireSession(input.id);
  }

  getSession(id: string): AutopilotSession | null {
    const row = this.database.raw
      .prepare("SELECT * FROM autopilot_sessions WHERE id = ?")
      .get(id) as SessionRow | undefined;
    return row ? mapSession(row) : null;
  }

  requireSession(id: string): AutopilotSession {
    const session = this.getSession(id);
    if (!session) throw new PersistenceNotFoundError("autopilot_session", id);
    return session;
  }

  listSessions(projectId: string): AutopilotSession[] {
    const rows = this.database.raw
      .prepare(
        "SELECT * FROM autopilot_sessions WHERE project_id = ? ORDER BY created_at DESC",
      )
      .all(projectId) as unknown as SessionRow[];
    return rows.map(mapSession);
  }

  listActionableSessions(): AutopilotSession[] {
    const rows = this.database.raw
      .prepare(
        `SELECT * FROM autopilot_sessions
         WHERE status IN ('pending','planning','running')
         ORDER BY created_at`,
      )
      .all() as unknown as SessionRow[];
    return rows.map(mapSession);
  }

  setSessionStatus(
    id: string,
    status: AutopilotSessionStatus,
    now: string,
    error?: Readonly<Record<string, unknown>> | null,
  ): AutopilotSession {
    const terminal = ["completed", "cancelled", "failed"].includes(status);
    const result = this.database.raw
      .prepare(
        `UPDATE autopilot_sessions SET status = ?, last_error_json = ?,
           pause_requested = CASE WHEN ? = 'paused' THEN 0 ELSE pause_requested END,
           cancel_requested = CASE WHEN ? = 'cancelled' THEN 0 ELSE cancel_requested END,
           finished_at = CASE WHEN ? THEN ? ELSE NULL END,
           updated_at = ?, version = version + 1 WHERE id = ?`,
      )
      .run(
        status,
        error ? JSON.stringify(error) : null,
        status,
        status,
        terminal ? 1 : 0,
        now,
        now,
        id,
      );
    if (result.changes !== 1)
      throw new PersistenceNotFoundError("autopilot_session", id);
    return this.requireSession(id);
  }

  requestSessionControl(
    id: string,
    control: "pause" | "cancel" | "replan",
    now: string,
  ): AutopilotSession {
    this.requireSession(id);
    const column =
      control === "pause"
        ? "pause_requested"
        : control === "cancel"
          ? "cancel_requested"
          : "replan_requested";
    this.database.raw
      .prepare(
        `UPDATE autopilot_sessions SET ${column} = 1, updated_at = ?, version = version + 1 WHERE id = ?`,
      )
      .run(now, id);
    return this.requireSession(id);
  }

  resumeSession(id: string, now: string): AutopilotSession {
    const session = this.requireSession(id);
    if (session.status !== "paused" && session.status !== "awaiting_user") {
      throw new AutomationPersistenceError(
        "autopilot.not_resumable",
        `Autopilot session in status ${session.status} cannot be resumed`,
      );
    }
    this.database.raw
      .prepare(
        `UPDATE autopilot_sessions SET status = 'running', pause_requested = 0,
           last_error_json = NULL, updated_at = ?, version = version + 1 WHERE id = ?`,
      )
      .run(now, id);
    return this.requireSession(id);
  }

  attachRun(
    sessionId: string,
    input: {
      runId: string;
      role: AutopilotRunRole;
      outlineNodeId: string | null;
      now: string;
    },
  ): AutopilotRunLink {
    return this.database.transaction(() => {
      const session = this.requireSession(sessionId);
      const existing = this.findRunLink(input.runId);
      if (existing) return existing;
      if (session.currentRunId) {
        throw new AutomationPersistenceError(
          "autopilot.child.active",
          "Autopilot session already has an active child run",
        );
      }
      const sequence = (
        this.database.raw
          .prepare(
            "SELECT COALESCE(MAX(sequence), -1) + 1 AS sequence FROM autopilot_run_links WHERE session_id = ?",
          )
          .get(sessionId) as { sequence: number }
      ).sequence;
      this.database.raw
        .prepare(
          `INSERT INTO autopilot_run_links(
            session_id, run_id, role, outline_node_id, sequence, created_at,
            processed_at, outcome
          ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
        )
        .run(
          sessionId,
          input.runId,
          input.role,
          input.outlineNodeId,
          sequence,
          input.now,
        );
      this.database.raw
        .prepare(
          `UPDATE autopilot_sessions SET current_run_id = ?, current_outline_node_id = ?,
             status = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
        )
        .run(
          input.runId,
          input.outlineNodeId,
          input.role === "rolling-plan" ? "planning" : "running",
          input.now,
          sessionId,
        );
      return this.requireRunLink(sessionId, input.runId);
    });
  }

  markRunProcessed(
    sessionId: string,
    runId: string,
    outcome: string,
    now: string,
  ): boolean {
    return this.database.transaction(() => {
      const changed = this.database.raw
        .prepare(
          `UPDATE autopilot_run_links SET processed_at = ?, outcome = ?
           WHERE session_id = ? AND run_id = ? AND processed_at IS NULL`,
        )
        .run(now, outcome, sessionId, runId);
      if (changed.changes !== 1) return false;
      this.database.raw
        .prepare(
          `UPDATE autopilot_sessions SET current_run_id = NULL,
             current_outline_node_id = NULL, updated_at = ?, version = version + 1
           WHERE id = ? AND current_run_id = ?`,
        )
        .run(now, sessionId, runId);
      return true;
    });
  }

  recordChapterOutcome(
    sessionId: string,
    outcome: "completed" | "skipped",
    now: string,
  ): AutopilotSession {
    const column =
      outcome === "completed" ? "completed_chapters" : "skipped_chapters";
    this.database.raw
      .prepare(
        `UPDATE autopilot_sessions SET ${column} = ${column} + 1,
           updated_at = ?, version = version + 1 WHERE id = ?`,
      )
      .run(now, sessionId);
    return this.requireSession(sessionId);
  }

  clearReplan(id: string, now: string): AutopilotSession {
    this.database.raw
      .prepare(
        `UPDATE autopilot_sessions SET replan_requested = 0, updated_at = ?,
           version = version + 1 WHERE id = ?`,
      )
      .run(now, id);
    return this.requireSession(id);
  }

  appendActiveNote(id: string, note: string, now: string): AutopilotSession {
    const session = this.requireSession(id);
    const notes = [...session.activeNotes, note].slice(-20);
    this.database.raw
      .prepare(
        `UPDATE autopilot_sessions SET active_notes_json = ?, updated_at = ?,
           version = version + 1 WHERE id = ?`,
      )
      .run(JSON.stringify(notes), now, id);
    return this.requireSession(id);
  }

  consumeActiveNotes(id: string, now: string): string[] {
    return this.database.transaction(() => {
      const session = this.requireSession(id);
      this.database.raw
        .prepare(
          `UPDATE autopilot_sessions SET active_notes_json = '[]', updated_at = ?,
             version = version + 1 WHERE id = ?`,
        )
        .run(now, id);
      return [...session.activeNotes];
    });
  }

  listRunLinks(sessionId: string): AutopilotRunLink[] {
    const rows = this.database.raw
      .prepare(
        "SELECT * FROM autopilot_run_links WHERE session_id = ? ORDER BY sequence",
      )
      .all(sessionId) as unknown as RunLinkRow[];
    return rows.map(mapRunLink);
  }

  findRunLink(runId: string): AutopilotRunLink | null {
    const row = this.database.raw
      .prepare("SELECT * FROM autopilot_run_links WHERE run_id = ?")
      .get(runId) as RunLinkRow | undefined;
    return row ? mapRunLink(row) : null;
  }

  requireRunLink(sessionId: string, runId: string): AutopilotRunLink {
    const link = this.findRunLink(runId);
    if (!link || link.sessionId !== sessionId)
      throw new PersistenceNotFoundError("autopilot_run_link", runId);
    return link;
  }

  createSteer(input: {
    id: string;
    projectId: string;
    sessionId: string | null;
    targetRunId: string | null;
    content: string;
    now: string;
  }): StorySteer {
    this.database.raw
      .prepare(
        `INSERT INTO story_steers(
          id, project_id, session_id, target_run_id, content, classification,
          status, effective_boundary, rationale, risk, classification_run_id,
          applied_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, NULL, 'pending', 'future', NULL, NULL, NULL,
          NULL, ?, ?)`,
      )
      .run(
        input.id,
        input.projectId,
        input.sessionId,
        input.targetRunId,
        input.content,
        input.now,
        input.now,
      );
    return this.requireSteer(input.id);
  }

  getSteer(id: string): StorySteer | null {
    const row = this.database.raw
      .prepare("SELECT * FROM story_steers WHERE id = ?")
      .get(id) as SteerRow | undefined;
    return row ? mapSteer(row) : null;
  }

  requireSteer(id: string): StorySteer {
    const steer = this.getSteer(id);
    if (!steer) throw new PersistenceNotFoundError("story_steer", id);
    return steer;
  }

  listSteers(sessionId: string): StorySteer[] {
    const rows = this.database.raw
      .prepare(
        "SELECT * FROM story_steers WHERE session_id = ? ORDER BY created_at DESC",
      )
      .all(sessionId) as unknown as SteerRow[];
    return rows.map(mapSteer);
  }

  reconcileSteerClassifications(sessionId: string, now: string): number {
    return this.database.transaction(() => {
      const terminal = this.database.raw
        .prepare(
          `SELECT steer.id, run.status
           FROM story_steers steer
           LEFT JOIN runs run ON run.id = steer.classification_run_id
           WHERE steer.session_id = ? AND steer.status = 'classifying'
             AND (run.id IS NULL OR run.status IN ('completed', 'failed', 'cancelled'))`,
        )
        .all(sessionId) as unknown as Array<{
        id: string;
        status: "completed" | "failed" | "cancelled" | null;
      }>;
      const update = this.database.raw.prepare(
        `UPDATE story_steers
         SET status = 'rejected', rationale = ?, updated_at = ?
         WHERE id = ? AND status = 'classifying'`,
      );
      let changed = 0;
      for (const steer of terminal) {
        const message =
          steer.status === "cancelled"
            ? "Impact assessment was cancelled, so this steering instruction was not applied"
            : steer.status === "failed"
              ? "Impact assessment failed, so this steering instruction was not applied"
              : "Impact assessment produced no valid result, so this steering instruction was not applied";
        changed += Number(update.run(message, now, steer.id).changes);
      }
      return changed;
    });
  }

  setSteerClassificationRun(
    id: string,
    runId: string,
    now: string,
  ): StorySteer {
    this.database.raw
      .prepare(
        `UPDATE story_steers SET status = 'classifying', classification_run_id = ?,
           updated_at = ? WHERE id = ? AND status = 'pending'`,
      )
      .run(runId, now, id);
    return this.requireSteer(id);
  }

  classifySteer(
    id: string,
    input: {
      classification: SteerClassification;
      effectiveBoundary: StorySteer["effectiveBoundary"];
      rationale: string;
      risk: NonNullable<StorySteer["risk"]>;
      now: string;
    },
  ): StorySteer {
    this.database.raw
      .prepare(
        `UPDATE story_steers SET classification = ?, effective_boundary = ?,
           rationale = ?, risk = ?, status = 'classified', updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.classification,
        input.effectiveBoundary,
        input.rationale,
        input.risk,
        input.now,
        id,
      );
    return this.requireSteer(id);
  }

  resolveSteer(
    id: string,
    status: Extract<
      StorySteer["status"],
      "applied" | "awaiting_confirmation" | "rejected"
    >,
    now: string,
  ): StorySteer {
    this.database.raw
      .prepare(
        `UPDATE story_steers SET status = ?, applied_at = CASE WHEN ? = 'applied' THEN ? ELSE applied_at END,
           updated_at = ? WHERE id = ?`,
      )
      .run(status, status, now, now, id);
    return this.requireSteer(id);
  }

  listClassifiedSteers(sessionId: string): StorySteer[] {
    const rows = this.database.raw
      .prepare(
        `SELECT * FROM story_steers WHERE session_id = ? AND status = 'classified'
         ORDER BY created_at`,
      )
      .all(sessionId) as unknown as SteerRow[];
    return rows.map(mapSteer);
  }

  insertPlanningReview(review: PlanningReview): PlanningReview {
    this.database.raw
      .prepare(
        `INSERT OR IGNORE INTO planning_reviews(
          id, project_id, session_id, run_id, scope_type, outline_node_id,
          summary, scores_json, recommendations_json, source_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        review.id,
        review.projectId,
        review.sessionId,
        review.runId,
        review.scopeType,
        review.outlineNodeId,
        review.summary,
        JSON.stringify(review.scores),
        JSON.stringify(review.recommendations),
        review.sourceHash,
        review.createdAt,
      );
    return review;
  }

  listPlanningReviews(sessionId: string): PlanningReview[] {
    const rows = this.database.raw
      .prepare(
        "SELECT * FROM planning_reviews WHERE session_id = ? ORDER BY created_at",
      )
      .all(sessionId) as unknown as PlanningReviewRow[];
    return rows.map(mapPlanningReview);
  }

  private listCandidates(setId: string): FoundationCandidate[] {
    const rows = this.database.raw
      .prepare(
        "SELECT * FROM foundation_candidates WHERE set_id = ? ORDER BY created_at, id",
      )
      .all(setId) as unknown as CandidateRow[];
    return rows.map(mapCandidate);
  }

  private refreshCandidateSetStatus(setId: string, now: string): void {
    const counts = this.database.raw
      .prepare(
        `SELECT COUNT(*) AS total,
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
          SUM(CASE WHEN status = 'adopted' THEN 1 ELSE 0 END) AS adopted
         FROM foundation_candidates WHERE set_id = ?`,
      )
      .get(setId) as { total: number; pending: number; adopted: number };
    const status: FoundationCandidateSet["status"] =
      counts.pending > 0
        ? counts.adopted > 0
          ? "partially_adopted"
          : "open"
        : counts.adopted === counts.total && counts.total > 0
          ? "adopted"
          : counts.adopted > 0
            ? "partially_adopted"
            : "discarded";
    this.database.raw
      .prepare(
        "UPDATE foundation_candidate_sets SET status = ?, updated_at = ? WHERE id = ?",
      )
      .run(status, now, setId);
  }
}

export class AutomationPersistenceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AutomationPersistenceError";
  }
}

interface CompassRow {
  project_id: string;
  core_promise: string;
  ending_direction: string | null;
  long_lines_json: string;
  theme_questions_json: string;
  target_json: string;
  constraints_json: string;
  version: number;
  updated_at: string;
}

interface CandidateSetRow {
  id: string;
  project_id: string;
  source_run_id: string;
  title: string;
  status: FoundationCandidateSet["status"];
  created_at: string;
  updated_at: string;
}

interface CandidateRow {
  id: string;
  set_id: string;
  project_id: string;
  kind: FoundationCandidateKind;
  label: string;
  payload_json: string;
  edited_payload_json: string | null;
  status: FoundationCandidateStatus;
  adopted_ref_type: string | null;
  adopted_ref_id: string | null;
  created_at: string;
  updated_at: string;
}

interface SessionRow {
  id: string;
  project_id: string;
  mode: AutopilotSession["mode"];
  status: AutopilotSessionStatus;
  target_chapters: number;
  window_size: number;
  max_revision_cycles: number;
  chapter_policy_json: string;
  current_run_id: string | null;
  current_outline_node_id: string | null;
  completed_chapters: number;
  skipped_chapters: number;
  pause_requested: number;
  cancel_requested: number;
  replan_requested: number;
  active_notes_json: string;
  last_error_json: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
  version: number;
}

interface RunLinkRow {
  session_id: string;
  run_id: string;
  role: AutopilotRunRole;
  outline_node_id: string | null;
  sequence: number;
  created_at: string;
  processed_at: string | null;
  outcome: string | null;
}

interface SteerRow {
  id: string;
  project_id: string;
  session_id: string | null;
  target_run_id: string | null;
  content: string;
  classification: SteerClassification | null;
  status: StorySteer["status"];
  effective_boundary: StorySteer["effectiveBoundary"];
  rationale: string | null;
  risk: StorySteer["risk"];
  classification_run_id: string | null;
  applied_at: string | null;
  created_at: string;
  updated_at: string;
}

interface PlanningReviewRow {
  id: string;
  project_id: string;
  session_id: string;
  run_id: string;
  scope_type: PlanningReview["scopeType"];
  outline_node_id: string;
  summary: string;
  scores_json: string;
  recommendations_json: string;
  source_hash: string;
  created_at: string;
}

function mapCompass(row: CompassRow): StoryCompass {
  return {
    projectId: row.project_id,
    corePromise: row.core_promise,
    endingDirection: row.ending_direction,
    longLines: parseArray(row.long_lines_json) as StoryCompass["longLines"],
    themeQuestions: stringArray(row.theme_questions_json),
    target: parseObject(row.target_json) as StoryCompass["target"],
    constraints: stringArray(row.constraints_json),
    version: row.version,
    updatedAt: row.updated_at,
  };
}

function mapCandidateSet(row: CandidateSetRow): FoundationCandidateSet {
  return {
    id: row.id,
    projectId: row.project_id,
    sourceRunId: row.source_run_id,
    title: row.title,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCandidate(row: CandidateRow): FoundationCandidate {
  return {
    id: row.id,
    setId: row.set_id,
    projectId: row.project_id,
    kind: row.kind,
    label: row.label,
    payload: parseObject(row.payload_json),
    editedPayload: row.edited_payload_json
      ? parseObject(row.edited_payload_json)
      : null,
    status: row.status,
    adoptedRefType: row.adopted_ref_type,
    adoptedRefId: row.adopted_ref_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSession(row: SessionRow): AutopilotSession {
  return {
    id: row.id,
    projectId: row.project_id,
    mode: row.mode,
    status: row.status,
    targetChapters: row.target_chapters,
    windowSize: row.window_size,
    maxRevisionCycles: row.max_revision_cycles,
    chapterPolicy: parseObject(row.chapter_policy_json),
    currentRunId: row.current_run_id,
    currentOutlineNodeId: row.current_outline_node_id,
    completedChapters: row.completed_chapters,
    skippedChapters: row.skipped_chapters,
    pauseRequested: row.pause_requested === 1,
    cancelRequested: row.cancel_requested === 1,
    replanRequested: row.replan_requested === 1,
    activeNotes: stringArray(row.active_notes_json),
    lastError: row.last_error_json ? parseObject(row.last_error_json) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
    version: row.version,
  };
}

function mapRunLink(row: RunLinkRow): AutopilotRunLink {
  return {
    sessionId: row.session_id,
    runId: row.run_id,
    role: row.role,
    outlineNodeId: row.outline_node_id,
    sequence: row.sequence,
    createdAt: row.created_at,
    processedAt: row.processed_at,
    outcome: row.outcome,
  };
}

function mapSteer(row: SteerRow): StorySteer {
  return {
    id: row.id,
    projectId: row.project_id,
    sessionId: row.session_id,
    targetRunId: row.target_run_id,
    content: row.content,
    classification: row.classification,
    status: row.status,
    effectiveBoundary: row.effective_boundary,
    rationale: row.rationale,
    risk: row.risk,
    classificationRunId: row.classification_run_id,
    appliedAt: row.applied_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPlanningReview(row: PlanningReviewRow): PlanningReview {
  return {
    id: row.id,
    projectId: row.project_id,
    sessionId: row.session_id,
    runId: row.run_id,
    scopeType: row.scope_type,
    outlineNodeId: row.outline_node_id,
    summary: row.summary,
    scores: parseObject(row.scores_json) as Record<string, number>,
    recommendations: stringArray(row.recommendations_json),
    sourceHash: row.source_hash,
    createdAt: row.created_at,
  };
}

function parseObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function parseArray(value: string): unknown[] {
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? parsed : [];
}

function stringArray(value: string): string[] {
  return parseArray(value).filter(
    (entry): entry is string => typeof entry === "string",
  );
}
