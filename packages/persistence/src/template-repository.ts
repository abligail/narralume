import type { NarrativeDatabase } from "./database.js";
import { PersistenceNotFoundError } from "./project-repository.js";

export interface HarnessTemplate {
  id: string;
  kind: "prompt" | "recipe";
  key: string;
  name: string;
  description: string;
  systemInvariants: string;
  defaultContent: string;
  overrideContent: string | null;
  effectiveContent: string;
  clonedFromKey: string | null;
  version: number;
  updatedAt: string;
}

export class SqliteTemplateRepository {
  constructor(private readonly database: NarrativeDatabase) {}

  seed(
    definitions: readonly Omit<
      HarnessTemplate,
      "effectiveContent" | "overrideContent" | "clonedFromKey" | "version"
    >[],
  ): void {
    const insert = this.database.raw.prepare(
      `INSERT INTO harness_templates(
         id, kind, template_key, name, description, system_invariants,
         default_content, override_content, cloned_from_key, version, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, ?)
       ON CONFLICT(template_key) DO UPDATE SET
         name = excluded.name,
         description = excluded.description,
         system_invariants = excluded.system_invariants,
         default_content = excluded.default_content`,
    );
    for (const definition of definitions)
      insert.run(
        definition.id,
        definition.kind,
        definition.key,
        definition.name,
        definition.description,
        definition.systemInvariants,
        definition.defaultContent,
        definition.updatedAt,
      );
  }

  list(): HarnessTemplate[] {
    return (
      this.database.raw
        .prepare("SELECT * FROM harness_templates ORDER BY kind, template_key")
        .all() as unknown as TemplateRow[]
    ).map(mapTemplate);
  }

  getByKey(key: string): HarnessTemplate | null {
    const row = this.database.raw
      .prepare("SELECT * FROM harness_templates WHERE template_key = ?")
      .get(key) as TemplateRow | undefined;
    return row ? mapTemplate(row) : null;
  }

  updateOverride(
    key: string,
    content: string,
    expectedVersion: number,
    updatedAt: string,
  ): HarnessTemplate {
    return this.database.transaction(() => {
      const current = this.getByKey(key);
      if (!current) throw new PersistenceNotFoundError("harness_template", key);
      if (current.version !== expectedVersion) {
        throw new TemplatePersistenceError(
          "harness_template.version.conflict",
          "The template was updated elsewhere; refresh and try again",
        );
      }
      const result = this.database.raw
        .prepare(
          `UPDATE harness_templates SET override_content = ?, version = version + 1, updated_at = ?
           WHERE template_key = ? AND version = ?`,
        )
        .run(content, updatedAt, key, expectedVersion);
      if (result.changes !== 1) {
        throw new TemplatePersistenceError(
          "harness_template.version.conflict",
          "The template was updated elsewhere; refresh and try again",
        );
      }
      return this.getByKey(key)!;
    });
  }

  restoreDefault(
    key: string,
    expectedVersion: number,
    updatedAt: string,
  ): HarnessTemplate {
    return this.database.transaction(() => {
      const current = this.getByKey(key);
      if (!current) throw new PersistenceNotFoundError("harness_template", key);
      if (current.version !== expectedVersion) {
        throw new TemplatePersistenceError(
          "harness_template.version.conflict",
          "The template was updated elsewhere; refresh and try again",
        );
      }
      const result = this.database.raw
        .prepare(
          `UPDATE harness_templates SET override_content = NULL, version = version + 1, updated_at = ?
           WHERE template_key = ? AND version = ?`,
        )
        .run(updatedAt, key, expectedVersion);
      if (result.changes !== 1) {
        throw new TemplatePersistenceError(
          "harness_template.version.conflict",
          "The template was updated elsewhere; refresh and try again",
        );
      }
      return this.getByKey(key)!;
    });
  }

  clone(
    sourceKey: string,
    input: { id: string; key: string; name: string; updatedAt: string },
  ): HarnessTemplate {
    return this.database.transaction(() => {
      const source = this.getByKey(sourceKey);
      if (!source)
        throw new PersistenceNotFoundError("harness_template", sourceKey);
      const inserted = this.database.raw
        .prepare(
          `INSERT INTO harness_templates(
             id, kind, template_key, name, description, system_invariants,
             default_content, override_content, cloned_from_key, version, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
           ON CONFLICT(template_key) DO NOTHING`,
        )
        .run(
          input.id,
          source.kind,
          input.key,
          input.name,
          source.description,
          source.systemInvariants,
          source.defaultContent,
          source.effectiveContent,
          source.key,
          input.updatedAt,
        );
      if (inserted.changes !== 1) {
        throw new TemplatePersistenceError(
          "harness_template.key.conflict",
          "The template key already exists; please choose another key",
        );
      }
      return this.getByKey(input.key)!;
    });
  }
}

export class TemplatePersistenceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TemplatePersistenceError";
  }
}

interface TemplateRow {
  id: string;
  kind: HarnessTemplate["kind"];
  template_key: string;
  name: string;
  description: string;
  system_invariants: string;
  default_content: string;
  override_content: string | null;
  cloned_from_key: string | null;
  version: number;
  updated_at: string;
}

function mapTemplate(row: TemplateRow): HarnessTemplate {
  return {
    id: row.id,
    kind: row.kind,
    key: row.template_key,
    name: row.name,
    description: row.description,
    systemInvariants: row.system_invariants,
    defaultContent: row.default_content,
    overrideContent: row.override_content,
    effectiveContent: row.override_content ?? row.default_content,
    clonedFromKey: row.cloned_from_key,
    version: row.version,
    updatedAt: row.updated_at,
  };
}
