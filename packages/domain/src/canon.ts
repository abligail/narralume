import { DomainError, type IsoDateTime, type ProjectId } from "./index.js";

export const CANON_ENTITY_TYPES = [
  "character",
  "location",
  "organization",
  "item",
  "rule",
  "concept",
] as const;
export type CanonEntityType = (typeof CANON_ENTITY_TYPES)[number];
export type CanonAuthority = "candidate" | "inferred" | "confirmed" | "locked";
export type KnowledgeScope =
  "omniscient" | "reader" | "character" | "author_secret";

export interface CanonEntity {
  id: string;
  projectId: ProjectId;
  type: CanonEntityType;
  name: string;
  aliases: readonly string[];
  description: string | null;
  attributes: Readonly<Record<string, unknown>>;
  status: "active" | "retired";
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface CanonFact {
  id: string;
  projectId: ProjectId;
  subjectId: string;
  predicate: string;
  objectEntityId: string | null;
  value: unknown;
  validFromNodeId: string | null;
  validToNodeId: string | null;
  knowledgeScope: KnowledgeScope;
  knowledgeSubjectId: string | null;
  authority: CanonAuthority;
  confidence: number;
  sourceType: string;
  sourceId: string | null;
  supersedesFactId: string | null;
  createdAt: IsoDateTime;
}

export interface CreateCanonEntityInput {
  id: string;
  projectId: ProjectId;
  type: CanonEntityType;
  name: string;
  aliases?: readonly string[];
  description?: string | null;
  attributes?: Readonly<Record<string, unknown>>;
  now: IsoDateTime;
}

export function createCanonEntity(input: CreateCanonEntityInput): CanonEntity {
  const name = input.name.trim();
  if (!name)
    throw new DomainError(
      "canon.entity.name.empty",
      "Canon entity name must not be empty",
    );
  const aliases = [
    ...new Set(
      (input.aliases ?? []).map((alias) => alias.trim()).filter(Boolean),
    ),
  ];
  return {
    id: input.id,
    projectId: input.projectId,
    type: input.type,
    name,
    aliases: aliases.filter((alias) => alias !== name),
    description: input.description?.trim() || null,
    attributes: input.attributes ?? {},
    status: "active",
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export interface CreateCanonFactInput {
  id: string;
  projectId: ProjectId;
  subjectId: string;
  predicate: string;
  objectEntityId?: string | null;
  value?: unknown;
  validFromNodeId?: string | null;
  validToNodeId?: string | null;
  knowledgeScope?: KnowledgeScope;
  knowledgeSubjectId?: string | null;
  authority?: CanonAuthority;
  confidence?: number;
  sourceType: string;
  sourceId?: string | null;
  supersedesFactId?: string | null;
  now: IsoDateTime;
}

export function createCanonFact(input: CreateCanonFactInput): CanonFact {
  const predicate = input.predicate.trim();
  if (!predicate)
    throw new DomainError(
      "canon.fact.predicate.empty",
      "Fact predicate must not be empty",
    );
  const hasEntityObject = Boolean(input.objectEntityId);
  const hasValue = input.value !== undefined;
  if (hasEntityObject === hasValue) {
    throw new DomainError(
      "canon.fact.object.invalid",
      "A fact must contain exactly one of objectEntityId or value",
    );
  }
  const confidence =
    input.confidence ?? (input.authority === "candidate" ? 0.5 : 1);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new DomainError(
      "canon.fact.confidence.invalid",
      "Fact confidence must be between 0 and 1",
    );
  }
  const scope = input.knowledgeScope ?? "omniscient";
  if (scope === "character" && !input.knowledgeSubjectId) {
    throw new DomainError(
      "canon.fact.character_scope.missing",
      "Character-scoped facts must specify the character",
    );
  }

  return {
    id: input.id,
    projectId: input.projectId,
    subjectId: input.subjectId,
    predicate,
    objectEntityId: input.objectEntityId ?? null,
    value: hasValue ? input.value : null,
    validFromNodeId: input.validFromNodeId ?? null,
    validToNodeId: input.validToNodeId ?? null,
    knowledgeScope: scope,
    knowledgeSubjectId: input.knowledgeSubjectId ?? null,
    authority: input.authority ?? "candidate",
    confidence,
    sourceType: input.sourceType,
    sourceId: input.sourceId ?? null,
    supersedesFactId: input.supersedesFactId ?? null,
    createdAt: input.now,
  };
}

export interface CanonAccess {
  audience: "author" | "reader" | "character" | "omniscient";
  characterId?: string;
  includeCandidates?: boolean;
}

export function canAccessFact(fact: CanonFact, access: CanonAccess): boolean {
  if (fact.authority === "candidate" && !access.includeCandidates) return false;
  if (access.audience === "author" || access.audience === "omniscient")
    return true;
  switch (fact.knowledgeScope) {
    case "omniscient":
      return access.audience === "reader" || access.audience === "character";
    case "reader":
      return access.audience === "reader";
    case "character":
      return (
        access.audience === "character" &&
        access.characterId === fact.knowledgeSubjectId
      );
    case "author_secret":
      return false;
  }
}

export function authorityRank(authority: CanonAuthority): number {
  return { candidate: 0, inferred: 1, confirmed: 2, locked: 3 }[authority];
}
