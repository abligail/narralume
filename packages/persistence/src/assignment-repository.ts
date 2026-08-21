import type { NarrativeDatabase } from "./database.js";
import type { StoredModel } from "./model-repository.js";
import { SqliteModelRepository } from "./model-repository.js";
import type { StoredProvider } from "./provider-repository.js";
import { SqliteProviderRepository } from "./provider-repository.js";

export const ASSIGNMENT_ROLES = [
  "writing",
  "planning",
  "review",
  "embedding",
  "rerank",
] as const;
export type AssignmentRole = (typeof ASSIGNMENT_ROLES)[number];

export interface ModelAssignment {
  role: AssignmentRole;
  modelId: string;
  updatedAt: string;
}

export interface ResolvedModelAssignment {
  requestedRole: AssignmentRole;
  /** Effective role after fallback (planning/review fall back to writing). */
  role: AssignmentRole;
  model: StoredModel;
  provider: StoredProvider;
}

interface AssignmentRow {
  role: AssignmentRole;
  model_id: string;
  updated_at: string;
}

/** Roles that fall back to the writing assignment when unset. */
const WRITING_FALLBACK_ROLES: readonly AssignmentRole[] = [
  "planning",
  "review",
];

export class SqliteAssignmentRepository {
  constructor(private readonly database: NarrativeDatabase) {}

  list(): ModelAssignment[] {
    const rows = this.database.raw
      .prepare("SELECT * FROM model_assignments ORDER BY role")
      .all() as unknown as AssignmentRow[];
    return rows.map(mapAssignment);
  }

  get(role: AssignmentRole): ModelAssignment | null {
    const row = this.database.raw
      .prepare("SELECT * FROM model_assignments WHERE role = ?")
      .get(role) as AssignmentRow | undefined;
    return row ? mapAssignment(row) : null;
  }

  set(
    role: AssignmentRole,
    modelId: string,
    updatedAt: string,
  ): ModelAssignment {
    const models = new SqliteModelRepository(this.database);
    const model = models.get(modelId);
    if (!model) {
      throw new AssignmentPersistenceError(
        "assignment.model.not_found",
        "The model assignment references a model that does not exist",
      );
    }
    const provider = new SqliteProviderRepository(this.database).get(
      model.providerId,
    );
    if (!model.enabled) {
      throw new AssignmentPersistenceError(
        "assignment.model.disabled",
        "Cannot assign a disabled model",
      );
    }
    if (!provider?.enabled) {
      throw new AssignmentPersistenceError(
        "assignment.provider.disabled",
        "Cannot assign a model whose provider is missing or disabled",
      );
    }
    if (!assignmentCompatible(role, model.taskType)) {
      throw new AssignmentPersistenceError(
        "assignment.task_type.mismatch",
        `Model task type ${model.taskType} cannot be assigned to ${role}`,
      );
    }
    this.database.raw
      .prepare(
        `INSERT INTO model_assignments(role, model_id, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(role) DO UPDATE SET
           model_id = excluded.model_id,
           updated_at = excluded.updated_at`,
      )
      .run(role, modelId, updatedAt);
    return { role, modelId, updatedAt };
  }

  remove(role: AssignmentRole): boolean {
    return (
      this.database.raw
        .prepare("DELETE FROM model_assignments WHERE role = ?")
        .run(role).changes === 1
    );
  }

  /**
   * Resolves an assignment to its model and provider. planning/review fall
   * back to the writing assignment when unset; embedding/rerank (and an unset
   * writing) resolve to null so the caller can degrade.
   */
  resolve(role: AssignmentRole): ResolvedModelAssignment | null {
    const assignment =
      this.get(role) ??
      (WRITING_FALLBACK_ROLES.includes(role) ? this.get("writing") : null);
    if (!assignment) return null;
    const model = new SqliteModelRepository(this.database).get(
      assignment.modelId,
    );
    if (!model) return null;
    const provider = new SqliteProviderRepository(this.database).get(
      model.providerId,
    );
    if (!provider) return null;
    if (!model.enabled || !provider.enabled) return null;
    if (!assignmentCompatible(assignment.role, model.taskType)) return null;
    return { requestedRole: role, role: assignment.role, model, provider };
  }
}

export class AssignmentPersistenceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AssignmentPersistenceError";
  }
}

function mapAssignment(row: AssignmentRow): ModelAssignment {
  return {
    role: row.role,
    modelId: row.model_id,
    updatedAt: row.updated_at,
  };
}

function assignmentCompatible(
  role: AssignmentRole,
  taskType: StoredModel["taskType"],
): boolean {
  const generation = new Set(["writing", "planning", "review"]);
  return (
    role === taskType || (generation.has(role) && generation.has(taskType))
  );
}
