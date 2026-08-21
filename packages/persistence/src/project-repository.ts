import { randomUuid } from "@narralume/domain";

import type { Project, ProjectPhase } from "@narralume/domain";

import type { NarrativeDatabase } from "./database.js";

interface ProjectRow {
  id: string;
  title: string;
  subtitle: string | null;
  premise: string | null;
  language: string;
  phase: ProjectPhase;
  archived_at: string | null;
  deleted_at: string | null;
  deletion_token: string | null;
  delete_after: string | null;
  created_at: string;
  updated_at: string;
}

export class SqliteProjectRepository {
  constructor(private readonly database: NarrativeDatabase) {}

  insert(project: Project): Project {
    this.database.raw
      .prepare(
        `
        INSERT INTO projects(
          id, title, subtitle, premise, language, phase, archived_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        project.id,
        project.title,
        project.subtitle,
        project.premise,
        project.language,
        project.phase,
        project.archivedAt,
        project.createdAt,
        project.updatedAt,
      );
    return project;
  }

  get(id: string): Project | null {
    const row = this.database.raw
      .prepare("SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL")
      .get(id) as ProjectRow | undefined;
    return row ? mapProject(row) : null;
  }

  getIncludingDeleted(id: string): ProjectRecycleRecord | null {
    const row = this.database.raw
      .prepare("SELECT * FROM projects WHERE id = ?")
      .get(id) as ProjectRow | undefined;
    return row ? mapRecycleRecord(row) : null;
  }

  list(
    options: {
      includeArchived?: boolean;
      limit?: number;
      offset?: number;
    } = {},
  ): Project[] {
    const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
    const offset = Math.max(0, options.offset ?? 0);
    const sql = options.includeArchived
      ? "SELECT * FROM projects WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT ? OFFSET ?"
      : "SELECT * FROM projects WHERE deleted_at IS NULL AND archived_at IS NULL ORDER BY updated_at DESC LIMIT ? OFFSET ?";
    const rows = this.database.raw
      .prepare(sql)
      .all(limit, offset) as unknown as ProjectRow[];
    return rows.map(mapProject);
  }

  update(project: Project): Project {
    const result = this.database.raw
      .prepare(
        `
        UPDATE projects SET
          title = ?, subtitle = ?, premise = ?, language = ?, phase = ?,
          archived_at = ?, updated_at = ?
        WHERE id = ? AND deleted_at IS NULL
      `,
      )
      .run(
        project.title,
        project.subtitle,
        project.premise,
        project.language,
        project.phase,
        project.archivedAt,
        project.updatedAt,
        project.id,
      );
    if (result.changes !== 1)
      throw new PersistenceNotFoundError("project", project.id);
    return project;
  }

  delete(id: string): boolean {
    return (
      this.database.raw.prepare("DELETE FROM projects WHERE id = ?").run(id)
        .changes === 1
    );
  }

  listDeleted(): ProjectRecycleRecord[] {
    const rows = this.database.raw
      .prepare(
        `SELECT * FROM projects
         WHERE deleted_at IS NOT NULL
         ORDER BY deleted_at DESC, updated_at DESC`,
      )
      .all() as unknown as ProjectRow[];
    return rows.map(mapRecycleRecord);
  }

  softDelete(
    id: string,
    expectedUpdatedAt: string,
    now: string,
    retentionDays = 30,
  ): ProjectRecycleRecord {
    const deletionToken = randomUuid();
    const deleteAfter = new Date(
      Date.parse(now) + Math.max(1, retentionDays) * 86_400_000,
    ).toISOString();
    const result = this.database.raw
      .prepare(
        `UPDATE projects SET
           archived_at = COALESCE(archived_at, ?), deleted_at = ?,
           deletion_token = ?, delete_after = ?, updated_at = ?
         WHERE id = ? AND deleted_at IS NULL AND updated_at = ?`,
      )
      .run(now, now, deletionToken, deleteAfter, now, id, expectedUpdatedAt);
    if (result.changes !== 1) throw new PersistenceNotFoundError("project", id);
    return this.getIncludingDeleted(id)!;
  }

  restoreDeleted(id: string, deletionToken: string, now: string): Project {
    const result = this.database.raw
      .prepare(
        `UPDATE projects SET deleted_at = NULL, deletion_token = NULL,
           delete_after = NULL, updated_at = ?
         WHERE id = ? AND deleted_at IS NOT NULL AND deletion_token = ?`,
      )
      .run(now, id, deletionToken);
    if (result.changes !== 1)
      throw new PersistenceNotFoundError("deleted_project", id);
    return this.get(id)!;
  }

  purge(id: string, deletionToken: string): boolean {
    return (
      this.database.raw
        .prepare(
          `DELETE FROM projects
           WHERE id = ? AND deleted_at IS NOT NULL AND deletion_token = ?`,
        )
        .run(id, deletionToken).changes === 1
    );
  }

  purgeExpired(now: string): number {
    return Number(
      this.database.raw
        .prepare(
          `DELETE FROM projects
           WHERE deleted_at IS NOT NULL AND delete_after <= ?`,
        )
        .run(now).changes,
    );
  }
}

export interface ProjectRecycleRecord extends Project {
  deletedAt: string | null;
  deletionToken: string | null;
  deleteAfter: string | null;
}

export class PersistenceNotFoundError extends Error {
  readonly entity: string;
  readonly id: string;

  constructor(entity: string, id: string) {
    super(`${entity} ${id} does not exist`);
    this.name = "PersistenceNotFoundError";
    this.entity = entity;
    this.id = id;
  }
}

function mapProject(row: ProjectRow): Project {
  return {
    id: row.id,
    title: row.title,
    subtitle: row.subtitle,
    premise: row.premise,
    language: row.language,
    phase: row.phase,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRecycleRecord(row: ProjectRow): ProjectRecycleRecord {
  return {
    ...mapProject(row),
    deletedAt: row.deleted_at,
    deletionToken: row.deletion_token,
    deleteAfter: row.delete_after,
  };
}
