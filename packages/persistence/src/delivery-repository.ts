import type {
  ImportBatch,
  ImportBatchDetail,
  ImportCandidate,
  ProjectBackup,
  RunBudgetUsage,
  StyleProfile,
  WritingSkill,
  WritingSkillScope,
} from "@narralume/domain";

import type { NarrativeDatabase } from "./database.js";
import { PersistenceNotFoundError } from "./project-repository.js";

export class SqliteDeliveryRepository {
  constructor(private readonly database: NarrativeDatabase) {}

  insertStyleProfile(profile: StyleProfile): StyleProfile {
    return this.database.transaction(() => {
      if (profile.active) this.deactivateStyles(profile.projectId, profile.id);
      const inserted = this.database.raw
        .prepare(
          `INSERT INTO style_profiles(
            id, project_id, name, description, rules_json, examples_json,
            negative_rules_json, source, active, status, created_at, updated_at, version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(project_id, name) DO NOTHING`,
        )
        .run(
          profile.id,
          profile.projectId,
          profile.name,
          profile.description,
          JSON.stringify(profile.rules),
          JSON.stringify(profile.examples),
          JSON.stringify(profile.negativeRules),
          profile.source,
          profile.active ? 1 : 0,
          profile.status,
          profile.createdAt,
          profile.updatedAt,
          profile.version,
        );
      if (inserted.changes !== 1) {
        throw new DeliveryPersistenceError(
          "style.name.conflict",
          "A style with this name already exists in this project; please choose another name",
        );
      }
      return profile;
    });
  }

  getStyleProfile(id: string): StyleProfile | null {
    const row = this.database.raw
      .prepare("SELECT * FROM style_profiles WHERE id = ?")
      .get(id) as StyleProfileRow | undefined;
    return row ? mapStyle(row) : null;
  }

  listStyleProfiles(projectId: string, includeRetired = false): StyleProfile[] {
    const rows = (includeRetired
      ? this.database.raw
          .prepare(
            "SELECT * FROM style_profiles WHERE project_id = ? ORDER BY active DESC, updated_at DESC, name",
          )
          .all(projectId)
      : this.database.raw
          .prepare(
            "SELECT * FROM style_profiles WHERE project_id = ? AND status = 'active' ORDER BY active DESC, updated_at DESC, name",
          )
          .all(projectId)) as unknown as StyleProfileRow[];
    return rows.map(mapStyle);
  }

  getActiveStyleProfile(projectId: string): StyleProfile | null {
    const row = this.database.raw
      .prepare(
        "SELECT * FROM style_profiles WHERE project_id = ? AND active = 1 AND status = 'active' LIMIT 1",
      )
      .get(projectId) as StyleProfileRow | undefined;
    return row ? mapStyle(row) : null;
  }

  updateStyleProfile(
    id: string,
    patch: Partial<
      Pick<
        StyleProfile,
        | "name"
        | "description"
        | "rules"
        | "examples"
        | "negativeRules"
        | "active"
        | "status"
      >
    >,
    expectedVersion: number,
    updatedAt: string,
  ): StyleProfile {
    return this.database.transaction(() => {
      const current = this.getStyleProfile(id);
      if (!current) throw new PersistenceNotFoundError("style-profile", id);
      if (current.version !== expectedVersion) {
        throw new DeliveryVersionConflictError("style-profile", id);
      }
      const next: StyleProfile = {
        ...current,
        ...patch,
        updatedAt,
        version: current.version + 1,
      };
      if (next.status === "retired") next.active = false;
      const duplicate = this.database.raw
        .prepare(
          "SELECT 1 AS present FROM style_profiles WHERE project_id = ? AND name = ? AND id <> ? LIMIT 1",
        )
        .get(next.projectId, next.name, id);
      if (duplicate) {
        throw new DeliveryPersistenceError(
          "style.name.conflict",
          "A style with this name already exists in this project; please choose another name",
        );
      }
      if (next.active) this.deactivateStyles(next.projectId, next.id);
      const result = this.database.raw
        .prepare(
          `UPDATE style_profiles SET name = ?, description = ?, rules_json = ?,
             examples_json = ?, negative_rules_json = ?, active = ?, status = ?,
             updated_at = ?, version = ? WHERE id = ? AND version = ?`,
        )
        .run(
          next.name,
          next.description,
          JSON.stringify(next.rules),
          JSON.stringify(next.examples),
          JSON.stringify(next.negativeRules),
          next.active ? 1 : 0,
          next.status,
          next.updatedAt,
          next.version,
          id,
          expectedVersion,
        );
      if (result.changes !== 1) {
        throw new DeliveryVersionConflictError("style-profile", id);
      }
      return next;
    });
  }

  insertWritingSkill(skill: WritingSkill): WritingSkill {
    return this.database.transaction(() => {
      const inserted = this.database.raw
        .prepare(
          `INSERT INTO writing_skills(
            id, project_id, name, description, instructions, scopes_json, priority,
            enabled, source, created_at, updated_at, version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(project_id, name) DO NOTHING`,
        )
        .run(
          skill.id,
          skill.projectId,
          skill.name,
          skill.description,
          skill.instructions,
          JSON.stringify(skill.scopes),
          skill.priority,
          skill.enabled ? 1 : 0,
          skill.source,
          skill.createdAt,
          skill.updatedAt,
          skill.version,
        );
      if (inserted.changes !== 1) {
        throw new DeliveryPersistenceError(
          "skill.name.conflict",
          "A writing skill with this name already exists in this project; please choose another name",
        );
      }
      return skill;
    });
  }

  replaceWritingSkillReferences(
    skillId: string,
    references: readonly {
      id: string;
      path: string;
      content: string;
      contentHash: string;
      createdAt: string;
    }[],
  ): void {
    this.database.transaction(() => {
      this.database.raw
        .prepare("DELETE FROM writing_skill_references WHERE skill_id = ?")
        .run(skillId);
      const insert = this.database.raw.prepare(
        `INSERT INTO writing_skill_references(
           id, skill_id, path, content, content_hash, created_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const reference of references)
        insert.run(
          reference.id,
          skillId,
          reference.path,
          reference.content,
          reference.contentHash,
          reference.createdAt,
        );
    });
  }

  listWritingSkillReferences(skillId: string): Array<{
    id: string;
    skillId: string;
    path: string;
    content: string;
    contentHash: string;
    createdAt: string;
  }> {
    const rows = this.database.raw
      .prepare(
        "SELECT * FROM writing_skill_references WHERE skill_id = ? ORDER BY path",
      )
      .all(skillId) as unknown as Array<{
      id: string;
      skill_id: string;
      path: string;
      content: string;
      content_hash: string;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      skillId: row.skill_id,
      path: row.path,
      content: row.content,
      contentHash: row.content_hash,
      createdAt: row.created_at,
    }));
  }

  getWritingSkill(id: string): WritingSkill | null {
    const row = this.database.raw
      .prepare("SELECT * FROM writing_skills WHERE id = ?")
      .get(id) as WritingSkillRow | undefined;
    return row ? mapSkill(row) : null;
  }

  listWritingSkills(projectId: string, enabledOnly = false): WritingSkill[] {
    const rows = (enabledOnly
      ? this.database.raw
          .prepare(
            "SELECT * FROM writing_skills WHERE project_id = ? AND enabled = 1 ORDER BY priority DESC, name",
          )
          .all(projectId)
      : this.database.raw
          .prepare(
            "SELECT * FROM writing_skills WHERE project_id = ? ORDER BY enabled DESC, priority DESC, name",
          )
          .all(projectId)) as unknown as WritingSkillRow[];
    return rows.map(mapSkill);
  }

  listApplicableSkills(
    projectId: string,
    scope: WritingSkillScope,
  ): WritingSkill[] {
    return this.listWritingSkills(projectId, true).filter(
      (skill) => skill.scopes.includes("all") || skill.scopes.includes(scope),
    );
  }

  updateWritingSkill(
    id: string,
    patch: Partial<
      Pick<
        WritingSkill,
        | "name"
        | "description"
        | "instructions"
        | "scopes"
        | "priority"
        | "enabled"
      >
    >,
    expectedVersion: number,
    updatedAt: string,
  ): WritingSkill {
    return this.database.transaction(() => {
      const current = this.getWritingSkill(id);
      if (!current) throw new PersistenceNotFoundError("writing-skill", id);
      if (current.version !== expectedVersion) {
        throw new DeliveryVersionConflictError("writing-skill", id);
      }
      const next: WritingSkill = {
        ...current,
        ...patch,
        updatedAt,
        version: current.version + 1,
      };
      const duplicate = this.database.raw
        .prepare(
          "SELECT 1 AS present FROM writing_skills WHERE project_id = ? AND name = ? AND id <> ? LIMIT 1",
        )
        .get(next.projectId, next.name, id);
      if (duplicate) {
        throw new DeliveryPersistenceError(
          "skill.name.conflict",
          "A writing skill with this name already exists in this project; please choose another name",
        );
      }
      const result = this.database.raw
        .prepare(
          `UPDATE writing_skills SET name = ?, description = ?, instructions = ?,
             scopes_json = ?, priority = ?, enabled = ?, updated_at = ?, version = ?
           WHERE id = ? AND version = ?`,
        )
        .run(
          next.name,
          next.description,
          next.instructions,
          JSON.stringify(next.scopes),
          next.priority,
          next.enabled ? 1 : 0,
          updatedAt,
          next.version,
          id,
          expectedVersion,
        );
      if (result.changes !== 1) {
        throw new DeliveryVersionConflictError("writing-skill", id);
      }
      return next;
    });
  }

  deleteWritingSkill(id: string): boolean {
    return (
      this.database.raw
        .prepare("DELETE FROM writing_skills WHERE id = ?")
        .run(id).changes === 1
    );
  }

  insertImportBatch(batch: ImportBatch): ImportBatch {
    this.database.raw
      .prepare(
        `INSERT INTO import_batches(
          id, target_project_id, filename, format, source_hash, source_characters,
          status, metadata_json, analysis_run_id, applied_project_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        batch.id,
        batch.targetProjectId,
        batch.filename,
        batch.format,
        batch.sourceHash,
        batch.sourceCharacters,
        batch.status,
        JSON.stringify(batch.metadata),
        batch.analysisRunId,
        batch.appliedProjectId,
        batch.createdAt,
        batch.updatedAt,
      );
    return batch;
  }

  getImportBatch(id: string): ImportBatch | null {
    const row = this.database.raw
      .prepare("SELECT * FROM import_batches WHERE id = ?")
      .get(id) as ImportBatchRow | undefined;
    return row ? mapBatch(row) : null;
  }

  requireImportBatch(id: string): ImportBatch {
    const batch = this.getImportBatch(id);
    if (!batch) throw new PersistenceNotFoundError("import-batch", id);
    return batch;
  }

  listImportBatches(targetProjectId?: string): ImportBatch[] {
    const rows = (targetProjectId
      ? this.database.raw
          .prepare(
            "SELECT * FROM import_batches WHERE target_project_id = ? ORDER BY created_at DESC",
          )
          .all(targetProjectId)
      : this.database.raw
          .prepare(
            "SELECT * FROM import_batches ORDER BY created_at DESC LIMIT 100",
          )
          .all()) as unknown as ImportBatchRow[];
    return rows.map(mapBatch);
  }

  updateImportBatch(
    id: string,
    patch: Partial<
      Pick<
        ImportBatch,
        "status" | "metadata" | "analysisRunId" | "appliedProjectId"
      >
    >,
    updatedAt: string,
  ): ImportBatch {
    const current = this.requireImportBatch(id);
    const next = { ...current, ...patch, updatedAt };
    this.database.raw
      .prepare(
        `UPDATE import_batches SET status = ?, metadata_json = ?, analysis_run_id = ?,
           applied_project_id = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        next.status,
        JSON.stringify(next.metadata),
        next.analysisRunId,
        next.appliedProjectId,
        next.updatedAt,
        id,
      );
    return next;
  }

  upsertImportCandidate(candidate: ImportCandidate): ImportCandidate {
    this.database.raw
      .prepare(
        `INSERT INTO import_candidates(
          id, batch_id, kind, ordinal, title, payload_json, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          payload_json = excluded.payload_json,
          status = CASE WHEN import_candidates.status = 'applied' THEN 'applied' ELSE excluded.status END,
          updated_at = excluded.updated_at`,
      )
      .run(
        candidate.id,
        candidate.batchId,
        candidate.kind,
        candidate.ordinal,
        candidate.title,
        JSON.stringify(candidate.payload),
        candidate.status,
        candidate.createdAt,
        candidate.updatedAt,
      );
    return this.requireImportCandidate(candidate.id);
  }

  requireImportCandidate(id: string): ImportCandidate {
    const row = this.database.raw
      .prepare("SELECT * FROM import_candidates WHERE id = ?")
      .get(id) as ImportCandidateRow | undefined;
    if (!row) throw new PersistenceNotFoundError("import-candidate", id);
    return mapCandidate(row);
  }

  listImportCandidates(batchId: string): ImportCandidate[] {
    const rows = this.database.raw
      .prepare(
        `SELECT * FROM import_candidates WHERE batch_id = ?
         ORDER BY CASE kind
           WHEN 'project' THEN 0 WHEN 'intent' THEN 1 WHEN 'style' THEN 2
           WHEN 'skill' THEN 3 WHEN 'entity' THEN 4 WHEN 'outline' THEN 5
           WHEN 'relationship' THEN 6 WHEN 'timeline' THEN 7
           WHEN 'foreshadow' THEN 8 WHEN 'character-arc' THEN 9
           WHEN 'scene-analysis' THEN 10 ELSE 11 END,
           ordinal`,
      )
      .all(batchId) as unknown as ImportCandidateRow[];
    return rows.map(mapCandidate);
  }

  getImportAnalysisArtifact(
    batchId: string,
    stage: ImportAnalysisArtifact["stage"],
    ordinal: number,
  ): ImportAnalysisArtifact | null {
    const row = this.database.raw
      .prepare(
        `SELECT * FROM import_analysis_artifacts
         WHERE batch_id = ? AND stage = ? AND ordinal = ?`,
      )
      .get(batchId, stage, ordinal) as ImportAnalysisArtifactRow | undefined;
    return row ? mapImportAnalysisArtifact(row) : null;
  }

  listImportAnalysisArtifacts(batchId: string): ImportAnalysisArtifact[] {
    const rows = this.database.raw
      .prepare(
        `SELECT * FROM import_analysis_artifacts WHERE batch_id = ?
         ORDER BY CASE stage WHEN 'chunk' THEN 0 ELSE 1 END, ordinal`,
      )
      .all(batchId) as unknown as ImportAnalysisArtifactRow[];
    return rows.map(mapImportAnalysisArtifact);
  }

  upsertImportAnalysisArtifact(
    artifact: ImportAnalysisArtifact,
  ): ImportAnalysisArtifact {
    this.database.raw
      .prepare(
        `INSERT INTO import_analysis_artifacts(
           id, batch_id, run_id, stage, ordinal, input_digest, output_json,
           output_digest, usage_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(batch_id, stage, ordinal) DO UPDATE SET
           id = excluded.id,
           run_id = excluded.run_id,
           input_digest = excluded.input_digest,
           output_json = excluded.output_json,
           output_digest = excluded.output_digest,
           usage_json = excluded.usage_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        artifact.id,
        artifact.batchId,
        artifact.runId,
        artifact.stage,
        artifact.ordinal,
        artifact.inputDigest,
        JSON.stringify(artifact.output),
        artifact.outputDigest,
        JSON.stringify(artifact.usage),
        artifact.createdAt,
        artifact.updatedAt,
      );
    return this.getImportAnalysisArtifact(
      artifact.batchId,
      artifact.stage,
      artifact.ordinal,
    )!;
  }

  getImportBatchDetail(id: string): ImportBatchDetail | null {
    const batch = this.getImportBatch(id);
    return batch
      ? { batch, candidates: this.listImportCandidates(batch.id) }
      : null;
  }

  setCandidateStatus(
    id: string,
    status: ImportCandidate["status"],
    updatedAt: string,
  ): ImportCandidate {
    const result = this.database.raw
      .prepare(
        "UPDATE import_candidates SET status = ?, updated_at = ? WHERE id = ? AND status <> 'applied'",
      )
      .run(status, updatedAt, id);
    if (result.changes === 0) return this.requireImportCandidate(id);
    return this.requireImportCandidate(id);
  }

  insertBackup(backup: ProjectBackup, bundleJson: string): ProjectBackup {
    this.database.raw
      .prepare(
        `INSERT INTO project_backups(
          id, project_id, label, bundle_json, bundle_hash, size_bytes, created_at, restored_project_id, counts_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        backup.id,
        backup.projectId,
        backup.label,
        bundleJson,
        backup.bundleHash,
        backup.sizeBytes,
        backup.createdAt,
        backup.restoredProjectId,
        backup.counts ? JSON.stringify(backup.counts) : null,
      );
    return backup;
  }

  listBackups(projectId: string): ProjectBackup[] {
    const rows = this.database.raw
      .prepare(
        `SELECT id, project_id, label, bundle_hash, size_bytes, created_at, restored_project_id, counts_json
         FROM project_backups WHERE project_id = ? ORDER BY created_at DESC`,
      )
      .all(projectId) as unknown as ProjectBackupRow[];
    return rows.map(mapBackup);
  }

  getBackup(id: string): { backup: ProjectBackup; bundleJson: string } | null {
    const row = this.database.raw
      .prepare("SELECT * FROM project_backups WHERE id = ?")
      .get(id) as (ProjectBackupRow & { bundle_json: string }) | undefined;
    return row ? { backup: mapBackup(row), bundleJson: row.bundle_json } : null;
  }

  markBackupRestored(id: string, restoredProjectId: string): ProjectBackup {
    const result = this.database.raw
      .prepare(
        "UPDATE project_backups SET restored_project_id = ? WHERE id = ?",
      )
      .run(restoredProjectId, id);
    if (result.changes !== 1) throw new PersistenceNotFoundError("backup", id);
    return this.getBackup(id)!.backup;
  }

  private deactivateStyles(projectId: string, exceptId: string): void {
    this.database.raw
      .prepare(
        "UPDATE style_profiles SET active = 0, version = version + 1 WHERE project_id = ? AND id <> ? AND active = 1",
      )
      .run(projectId, exceptId);
  }
}

export class DeliveryVersionConflictError extends Error {
  constructor(
    readonly entity: string,
    readonly id: string,
  ) {
    super(`${entity} ${id} was updated by another operation`);
    this.name = "DeliveryVersionConflictError";
  }
}

export class DeliveryPersistenceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DeliveryPersistenceError";
  }
}

export interface ImportAnalysisArtifact {
  id: string;
  batchId: string;
  runId: string | null;
  stage: "chunk" | "synthesis";
  ordinal: number;
  inputDigest: string;
  output: Record<string, unknown>;
  outputDigest: string;
  usage: RunBudgetUsage;
  createdAt: string;
  updatedAt: string;
}

interface StyleProfileRow {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  rules_json: string;
  examples_json: string;
  negative_rules_json: string;
  source: string;
  active: number;
  status: StyleProfile["status"];
  created_at: string;
  updated_at: string;
  version: number;
}

interface WritingSkillRow {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  instructions: string;
  scopes_json: string;
  priority: number;
  enabled: number;
  source: string;
  created_at: string;
  updated_at: string;
  version: number;
}

interface ImportBatchRow {
  id: string;
  target_project_id: string | null;
  filename: string;
  format: ImportBatch["format"];
  source_hash: string;
  source_characters: number;
  status: ImportBatch["status"];
  metadata_json: string;
  analysis_run_id: string | null;
  applied_project_id: string | null;
  created_at: string;
  updated_at: string;
}

interface ImportCandidateRow {
  id: string;
  batch_id: string;
  kind: ImportCandidate["kind"];
  ordinal: number;
  title: string;
  payload_json: string;
  status: ImportCandidate["status"];
  created_at: string;
  updated_at: string;
}

interface ImportAnalysisArtifactRow {
  id: string;
  batch_id: string;
  run_id: string | null;
  stage: ImportAnalysisArtifact["stage"];
  ordinal: number;
  input_digest: string;
  output_json: string;
  output_digest: string;
  usage_json: string;
  created_at: string;
  updated_at: string;
}

interface ProjectBackupRow {
  id: string;
  project_id: string;
  label: string;
  bundle_hash: string;
  size_bytes: number;
  created_at: string;
  restored_project_id: string | null;
  counts_json: string | null;
}

function mapStyle(row: StyleProfileRow): StyleProfile {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    description: row.description,
    rules: parseStringArray(row.rules_json),
    examples: parseStringArray(row.examples_json),
    negativeRules: parseStringArray(row.negative_rules_json),
    source: row.source,
    active: row.active === 1,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

function mapSkill(row: WritingSkillRow): WritingSkill {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    scopes: parseStringArray(row.scopes_json) as WritingSkillScope[],
    priority: row.priority,
    enabled: row.enabled === 1,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

function mapBatch(row: ImportBatchRow): ImportBatch {
  return {
    id: row.id,
    targetProjectId: row.target_project_id,
    filename: row.filename,
    format: row.format,
    sourceHash: row.source_hash,
    sourceCharacters: row.source_characters,
    status: row.status,
    metadata: parseObject(row.metadata_json),
    analysisRunId: row.analysis_run_id,
    appliedProjectId: row.applied_project_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCandidate(row: ImportCandidateRow): ImportCandidate {
  return {
    id: row.id,
    batchId: row.batch_id,
    kind: row.kind,
    ordinal: row.ordinal,
    title: row.title,
    payload: parseObject(row.payload_json),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapImportAnalysisArtifact(
  row: ImportAnalysisArtifactRow,
): ImportAnalysisArtifact {
  return {
    id: row.id,
    batchId: row.batch_id,
    runId: row.run_id,
    stage: row.stage,
    ordinal: row.ordinal,
    inputDigest: row.input_digest,
    output: parseObject(row.output_json),
    outputDigest: row.output_digest,
    usage: JSON.parse(row.usage_json) as RunBudgetUsage,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapBackup(row: ProjectBackupRow): ProjectBackup {
  return {
    id: row.id,
    projectId: row.project_id,
    label: row.label,
    bundleHash: row.bundle_hash,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
    restoredProjectId: row.restored_project_id,
    counts: row.counts_json
      ? (JSON.parse(row.counts_json) as Record<string, number>)
      : null,
  };
}

function parseStringArray(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string")
    : [];
}

function parseObject(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}
