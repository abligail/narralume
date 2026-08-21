import { DomainError, type IsoDateTime, type ProjectId } from "./index.js";

export const OUTLINE_KINDS = [
  "book",
  "volume",
  "arc",
  "chapter",
  "scene",
  "beat",
] as const;
export type OutlineKind = (typeof OUTLINE_KINDS)[number];
export type OutlineStatus =
  "planned" | "drafting" | "review" | "committed" | "abandoned";

const CHILD_KINDS: Readonly<Record<OutlineKind, readonly OutlineKind[]>> = {
  book: ["volume", "arc", "chapter"],
  volume: ["arc", "chapter"],
  arc: ["chapter", "scene"],
  chapter: ["scene", "beat"],
  scene: ["beat"],
  beat: [],
};

export interface OutlineNode {
  id: string;
  projectId: ProjectId;
  parentId: string | null;
  kind: OutlineKind;
  path: string;
  depth: number;
  ordinal: number;
  title: string;
  summary: string | null;
  goal: string | null;
  conflict: string | null;
  outcome: string | null;
  povEntityId: string | null;
  storyTime: string | null;
  status: OutlineStatus;
  metadata: Readonly<Record<string, unknown>>;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface CreateOutlineNodeInput {
  id: string;
  projectId: ProjectId;
  parent: OutlineNode | null;
  kind: OutlineKind;
  ordinal: number;
  title: string;
  summary?: string | null;
  goal?: string | null;
  conflict?: string | null;
  outcome?: string | null;
  povEntityId?: string | null;
  storyTime?: string | null;
  metadata?: Readonly<Record<string, unknown>>;
  now: IsoDateTime;
}

export function createOutlineNode(input: CreateOutlineNodeInput): OutlineNode {
  const title = requiredText(
    input.title,
    "outline.title.empty",
    "Outline node title must not be empty",
  );
  if (!Number.isInteger(input.ordinal) || input.ordinal < 0) {
    throw new DomainError(
      "outline.ordinal.invalid",
      "Outline node ordinal must be a non-negative integer",
    );
  }
  if (input.parent) {
    if (input.parent.projectId !== input.projectId) {
      throw new DomainError(
        "outline.parent.cross_project",
        "The parent node does not belong to this project",
      );
    }
    if (!CHILD_KINDS[input.parent.kind].includes(input.kind)) {
      throw new DomainError(
        "outline.parent.invalid_kind",
        `Cannot create ${input.kind} under ${input.parent.kind}`,
      );
    }
  } else if (input.kind !== "book") {
    throw new DomainError(
      "outline.root.invalid_kind",
      "The root node must be a book",
    );
  }

  return {
    id: input.id,
    projectId: input.projectId,
    parentId: input.parent?.id ?? null,
    kind: input.kind,
    path: input.parent ? `${input.parent.path}/${input.id}` : `/${input.id}`,
    depth: (input.parent?.depth ?? -1) + 1,
    ordinal: input.ordinal,
    title,
    summary: optionalText(input.summary),
    goal: optionalText(input.goal),
    conflict: optionalText(input.conflict),
    outcome: optionalText(input.outcome),
    povEntityId: input.povEntityId ?? null,
    storyTime: optionalText(input.storyTime),
    status: "planned",
    metadata: input.metadata ?? {},
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export function isAncestor(
  candidate: OutlineNode,
  descendant: OutlineNode,
): boolean {
  return (
    candidate.projectId === descendant.projectId &&
    descendant.path.startsWith(`${candidate.path}/`)
  );
}

function requiredText(value: string, code: string, message: string): string {
  const text = value.trim();
  if (!text) throw new DomainError(code, message);
  return text;
}

function optionalText(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text ? text : null;
}
