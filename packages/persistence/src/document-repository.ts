import { sha256Hex } from "@narralume/domain";

import type {
  Document,
  DocumentKind,
  DocumentVersion,
} from "@narralume/domain";

import type { NarrativeDatabase } from "./database.js";
import { PersistenceNotFoundError } from "./project-repository.js";

export interface AppendDocumentVersionInput {
  id: string;
  content: string;
  source: string;
  runId?: string | null;
  now: string;
  /** Undefined opts out; null explicitly asserts that no version exists yet. */
  expectedCurrentVersionId?: string | null;
}

export interface DocumentDraft {
  projectId: string;
  documentId: string;
  baseVersionId: string | null;
  content: string;
  contentHash: string;
  updatedAt: string;
}

export interface UpsertDocumentDraftInput {
  baseVersionId: string | null;
  content: string;
  now: string;
}

export class SqliteDocumentRepository {
  constructor(private readonly database: NarrativeDatabase) {}

  insert(document: Document): Document {
    this.database.raw
      .prepare(
        `INSERT INTO documents(
          id, project_id, kind, title, outline_node_id, current_version_id,
          archived_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        document.id,
        document.projectId,
        document.kind,
        document.title,
        document.outlineNodeId,
        document.currentVersionId,
        document.archivedAt,
        document.createdAt,
        document.updatedAt,
      );
    return document;
  }

  get(projectId: string, documentId: string): Document | null {
    const row = this.database.raw
      .prepare("SELECT * FROM documents WHERE project_id = ? AND id = ?")
      .get(projectId, documentId) as DocumentRow | undefined;
    return row ? mapDocument(row) : null;
  }

  getByOutlineNodeId(
    projectId: string,
    outlineNodeId: string,
  ): Document | null {
    const row = this.database.raw
      .prepare(
        "SELECT * FROM documents WHERE project_id = ? AND outline_node_id = ?",
      )
      .get(projectId, outlineNodeId) as DocumentRow | undefined;
    return row ? mapDocument(row) : null;
  }

  list(
    projectId: string,
    kind?: DocumentKind,
    includeArchived = false,
  ): Document[] {
    const where = ["project_id = ?"];
    const parameters: string[] = [projectId];
    if (kind) {
      where.push("kind = ?");
      parameters.push(kind);
    }
    if (!includeArchived) where.push("archived_at IS NULL");
    const rows = this.database.raw
      .prepare(
        `SELECT * FROM documents WHERE ${where.join(" AND ")} ORDER BY updated_at DESC, title`,
      )
      .all(...parameters) as unknown as DocumentRow[];
    return rows.map(mapDocument);
  }

  setArchived(
    projectId: string,
    documentId: string,
    archived: boolean,
    expectedUpdatedAt: string,
    now: string,
  ): Document {
    const result = this.database.raw
      .prepare(
        `UPDATE documents SET archived_at = ?, updated_at = ?
         WHERE project_id = ? AND id = ? AND updated_at = ?`,
      )
      .run(
        archived ? now : null,
        now,
        projectId,
        documentId,
        expectedUpdatedAt,
      );
    if (result.changes !== 1) {
      const current = this.get(projectId, documentId);
      if (!current) throw new PersistenceNotFoundError("document", documentId);
      throw new DocumentVersionConflictError(
        documentId,
        expectedUpdatedAt,
        current.updatedAt,
      );
    }
    return this.get(projectId, documentId)!;
  }

  getDraft(projectId: string, documentId: string): DocumentDraft | null {
    this.requireDocument(projectId, documentId);
    const row = this.database.raw
      .prepare(
        "SELECT * FROM document_drafts WHERE project_id = ? AND document_id = ?",
      )
      .get(projectId, documentId) as DocumentDraftRow | undefined;
    return row ? mapDraft(row) : null;
  }

  upsertDraft(
    projectId: string,
    documentId: string,
    input: UpsertDocumentDraftInput,
  ): DocumentDraft {
    const document = this.get(projectId, documentId);
    if (!document) throw new PersistenceNotFoundError("document", documentId);
    if (
      input.baseVersionId &&
      !this.getVersion(projectId, documentId, input.baseVersionId)
    ) {
      throw new PersistenceNotFoundError(
        "document-version",
        input.baseVersionId,
      );
    }
    const draft: DocumentDraft = {
      projectId,
      documentId,
      baseVersionId: input.baseVersionId,
      content: input.content,
      contentHash: hashContent(input.content),
      updatedAt: input.now,
    };
    this.database.raw
      .prepare(
        `INSERT INTO document_drafts(
          document_id, project_id, base_version_id, content, content_hash, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(document_id) DO UPDATE SET
          project_id = excluded.project_id,
          base_version_id = excluded.base_version_id,
          content = excluded.content,
          content_hash = excluded.content_hash,
          updated_at = excluded.updated_at`,
      )
      .run(
        draft.documentId,
        draft.projectId,
        draft.baseVersionId,
        draft.content,
        draft.contentHash,
        draft.updatedAt,
      );
    return draft;
  }

  deleteDraft(
    projectId: string,
    documentId: string,
    expectedContent?: string,
  ): boolean {
    const result =
      expectedContent === undefined
        ? this.database.raw
            .prepare(
              "DELETE FROM document_drafts WHERE project_id = ? AND document_id = ?",
            )
            .run(projectId, documentId)
        : this.database.raw
            .prepare(
              `DELETE FROM document_drafts
             WHERE project_id = ? AND document_id = ? AND content_hash = ?`,
            )
            .run(projectId, documentId, hashContent(expectedContent));
    return result.changes === 1;
  }

  appendVersion(
    projectId: string,
    documentId: string,
    input: AppendDocumentVersionInput,
  ): DocumentVersion {
    return this.database.transaction(() => {
      const document = this.get(projectId, documentId);
      if (!document) throw new PersistenceNotFoundError("document", documentId);
      if (
        input.expectedCurrentVersionId !== undefined &&
        input.expectedCurrentVersionId !== document.currentVersionId
      ) {
        throw new DocumentVersionConflictError(
          documentId,
          input.expectedCurrentVersionId,
          document.currentVersionId,
        );
      }
      const version: DocumentVersion = {
        id: input.id,
        documentId,
        parentVersionId: document.currentVersionId,
        content: input.content,
        contentHash: hashContent(input.content),
        source: input.source.trim() || "manual",
        runId: input.runId ?? null,
        createdAt: input.now,
      };
      this.database.raw
        .prepare(
          `INSERT INTO document_versions(
            id, document_id, parent_version_id, content, content_hash, source, run_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          version.id,
          version.documentId,
          version.parentVersionId,
          version.content,
          version.contentHash,
          version.source,
          version.runId,
          version.createdAt,
        );
      this.database.raw
        .prepare(
          "UPDATE documents SET current_version_id = ?, updated_at = ? WHERE project_id = ? AND id = ?",
        )
        .run(version.id, input.now, projectId, documentId);
      // 正式版本推进后，任何不基于新版本的草稿都已过期，必须清除；
      // 否则旧草稿会遮住新正式正文（各写入路径统一在此处理）。
      this.database.raw
        .prepare(
          `DELETE FROM document_drafts
           WHERE document_id = ? AND (base_version_id IS NULL OR base_version_id != ?)`,
        )
        .run(documentId, version.id);
      return version;
    });
  }

  restoreVersion(
    projectId: string,
    documentId: string,
    targetVersionId: string,
    input: Omit<AppendDocumentVersionInput, "content">,
  ): DocumentVersion {
    const target = this.getVersion(projectId, documentId, targetVersionId);
    if (!target)
      throw new PersistenceNotFoundError("document-version", targetVersionId);
    return this.appendVersion(projectId, documentId, {
      ...input,
      content: target.content,
      source: input.source.trim() || `restore:${targetVersionId}`,
    });
  }

  getVersion(
    projectId: string,
    documentId: string,
    versionId: string,
  ): DocumentVersion | null {
    const row = this.database.raw
      .prepare(
        `SELECT version.* FROM document_versions version
         JOIN documents document ON document.id = version.document_id
         WHERE document.project_id = ? AND document.id = ? AND version.id = ?`,
      )
      .get(projectId, documentId, versionId) as DocumentVersionRow | undefined;
    return row ? mapVersion(row) : null;
  }

  listVersions(projectId: string, documentId: string): DocumentVersion[] {
    this.requireDocument(projectId, documentId);
    const rows = this.database.raw
      .prepare(
        `SELECT version.* FROM document_versions version
         JOIN documents document ON document.id = version.document_id
         WHERE document.project_id = ? AND document.id = ?
         ORDER BY version.created_at DESC, version.rowid DESC`,
      )
      .all(projectId, documentId) as unknown as DocumentVersionRow[];
    return rows.map(mapVersion);
  }

  private requireDocument(projectId: string, documentId: string): void {
    if (!this.get(projectId, documentId))
      throw new PersistenceNotFoundError("document", documentId);
  }
}

export class DocumentVersionConflictError extends Error {
  constructor(
    readonly documentId: string,
    readonly expected: string | null,
    readonly actual: string | null,
  ) {
    super(
      `Document ${documentId} was updated: expected version ${String(expected)}, actual version ${String(actual)}`,
    );
    this.name = "DocumentVersionConflictError";
  }
}

interface DocumentRow {
  id: string;
  project_id: string;
  kind: DocumentKind;
  title: string;
  outline_node_id: string | null;
  current_version_id: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

interface DocumentVersionRow {
  id: string;
  document_id: string;
  parent_version_id: string | null;
  content: string;
  content_hash: string;
  source: string;
  run_id: string | null;
  created_at: string;
}

interface DocumentDraftRow {
  document_id: string;
  project_id: string;
  base_version_id: string | null;
  content: string;
  content_hash: string;
  updated_at: string;
}

function mapDocument(row: DocumentRow): Document {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    title: row.title,
    outlineNodeId: row.outline_node_id,
    currentVersionId: row.current_version_id,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapVersion(row: DocumentVersionRow): DocumentVersion {
  return {
    id: row.id,
    documentId: row.document_id,
    parentVersionId: row.parent_version_id,
    content: row.content,
    contentHash: row.content_hash,
    source: row.source,
    runId: row.run_id,
    createdAt: row.created_at,
  };
}

function mapDraft(row: DocumentDraftRow): DocumentDraft {
  return {
    projectId: row.project_id,
    documentId: row.document_id,
    baseVersionId: row.base_version_id,
    content: row.content,
    contentHash: row.content_hash,
    updatedAt: row.updated_at,
  };
}

function hashContent(content: string): string {
  return sha256Hex(content);
}
