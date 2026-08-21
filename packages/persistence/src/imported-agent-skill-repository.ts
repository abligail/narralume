import type { NarrativeDatabase } from "./database.js";
import { PersistenceNotFoundError } from "./project-repository.js";

export interface ImportedAgentSkill {
  id: string;
  projectId: string;
  label: string;
  version: string;
  description: string;
  triggerDescription: string;
  instructions: string;
  references: readonly { path: string; contentHash: string }[];
  requiredContext: readonly string[];
  allowedCapabilities: readonly string[];
  outputKind: "answer" | "candidate" | "task_handle" | "long_goal";
  checkpoint: "none" | "confirm_start" | "candidate_adoption";
  enabled: boolean;
  source: string;
  contentHash: string;
  createdAt: string;
  updatedAt: string;
}

interface SkillRow {
  id: string;
  project_id: string;
  label: string;
  version: string;
  description: string;
  trigger_description: string;
  instructions: string;
  references_json: string;
  required_context_json: string;
  allowed_capabilities_json: string;
  output_kind: ImportedAgentSkill["outputKind"];
  checkpoint: ImportedAgentSkill["checkpoint"];
  enabled: 0 | 1;
  source: string;
  content_hash: string;
  created_at: string;
  updated_at: string;
}

export class SqliteImportedAgentSkillRepository {
  constructor(private readonly database: NarrativeDatabase) {}

  insert(input: ImportedAgentSkill): ImportedAgentSkill {
    this.database.raw
      .prepare(
        `INSERT INTO imported_agent_skills(
          id, project_id, label, version, description, trigger_description,
          instructions, references_json, required_context_json,
          allowed_capabilities_json, output_kind, checkpoint, enabled, source,
          content_hash, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.projectId,
        input.label,
        input.version,
        input.description,
        input.triggerDescription,
        input.instructions,
        JSON.stringify(input.references),
        JSON.stringify(input.requiredContext),
        JSON.stringify(input.allowedCapabilities),
        input.outputKind,
        input.checkpoint,
        input.enabled ? 1 : 0,
        input.source,
        input.contentHash,
        input.createdAt,
        input.updatedAt,
      );
    return this.require(input.id);
  }

  get(id: string): ImportedAgentSkill | null {
    const row = this.database.raw
      .prepare("SELECT * FROM imported_agent_skills WHERE id = ?")
      .get(id) as SkillRow | undefined;
    return row ? mapSkill(row) : null;
  }

  require(id: string): ImportedAgentSkill {
    const skill = this.get(id);
    if (!skill) throw new PersistenceNotFoundError("imported_agent_skill", id);
    return skill;
  }

  listForProject(projectId: string): ImportedAgentSkill[] {
    const rows = this.database.raw
      .prepare(
        `SELECT * FROM imported_agent_skills
         WHERE project_id = ? ORDER BY label`,
      )
      .all(projectId) as unknown as SkillRow[];
    return rows.map(mapSkill);
  }

  listEnabledForProject(projectId: string): ImportedAgentSkill[] {
    return this.listForProject(projectId).filter((skill) => skill.enabled);
  }

  setEnabled(
    id: string,
    enabled: boolean,
    expectedUpdatedAt: string,
    now: string,
  ): ImportedAgentSkill {
    const current = this.require(id);
    if (current.updatedAt !== expectedUpdatedAt) {
      throw new ImportedAgentSkillVersionConflictError(id);
    }
    const result = this.database.raw
      .prepare(
        `UPDATE imported_agent_skills SET enabled = ?, updated_at = ?
         WHERE id = ? AND updated_at = ?`,
      )
      .run(enabled ? 1 : 0, now, id, expectedUpdatedAt);
    if (result.changes !== 1) {
      throw new ImportedAgentSkillVersionConflictError(id);
    }
    return this.require(id);
  }

  delete(id: string): boolean {
    return (
      this.database.raw
        .prepare("DELETE FROM imported_agent_skills WHERE id = ?")
        .run(id).changes === 1
    );
  }
}

export class ImportedAgentSkillVersionConflictError extends Error {
  constructor(id: string) {
    super(`imported_agent_skill ${id} was updated by another operation`);
    this.name = "ImportedAgentSkillVersionConflictError";
  }
}

function mapSkill(row: SkillRow): ImportedAgentSkill {
  return {
    id: row.id,
    projectId: row.project_id,
    label: row.label,
    version: row.version,
    description: row.description,
    triggerDescription: row.trigger_description,
    instructions: row.instructions,
    references: JSON.parse(row.references_json) as {
      path: string;
      contentHash: string;
    }[],
    requiredContext: JSON.parse(row.required_context_json) as string[],
    allowedCapabilities: JSON.parse(row.allowed_capabilities_json) as string[],
    outputKind: row.output_kind,
    checkpoint: row.checkpoint,
    enabled: row.enabled === 1,
    source: row.source,
    contentHash: row.content_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
