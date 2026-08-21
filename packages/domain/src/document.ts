import { DomainError, type IsoDateTime, type ProjectId } from "./index.js";

export const DOCUMENT_KINDS = [
  "manuscript",
  "chapter",
  "scene",
  "outline",
  "synopsis",
  "note",
  "style-sample",
] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export interface Document {
  id: string;
  projectId: ProjectId;
  kind: DocumentKind;
  title: string;
  outlineNodeId: string | null;
  currentVersionId: string | null;
  archivedAt: IsoDateTime | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface DocumentVersion {
  id: string;
  documentId: string;
  parentVersionId: string | null;
  content: string;
  contentHash: string;
  source: string;
  runId: string | null;
  createdAt: IsoDateTime;
}

export interface CreateDocumentInput {
  id: string;
  projectId: ProjectId;
  kind: DocumentKind;
  title: string;
  outlineNodeId?: string | null;
  now: IsoDateTime;
}

export function createDocument(input: CreateDocumentInput): Document {
  const title = input.title.trim();
  if (!title) {
    throw new DomainError(
      "document.title.empty",
      "Document title must not be empty",
    );
  }
  return {
    id: input.id,
    projectId: input.projectId,
    kind: input.kind,
    title,
    outlineNodeId: input.outlineNodeId ?? null,
    currentVersionId: null,
    archivedAt: null,
    createdAt: input.now,
    updatedAt: input.now,
  };
}
