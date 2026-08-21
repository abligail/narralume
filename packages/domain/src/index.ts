export type IsoDateTime = string;
export type ProjectId = string;

export const PROJECT_PHASES = [
  "idea",
  "foundation",
  "outlining",
  "writing",
  "revising",
  "complete",
] as const;
export type ProjectPhase = (typeof PROJECT_PHASES)[number];

export const PROJECT_PHASE_TRANSITIONS: Readonly<
  Record<ProjectPhase, readonly ProjectPhase[]>
> = {
  idea: ["idea", "foundation"],
  foundation: ["foundation", "outlining"],
  outlining: ["outlining", "writing"],
  writing: ["writing", "revising", "complete"],
  revising: ["revising", "writing", "complete"],
  complete: ["complete", "revising"],
};

export interface Project {
  id: ProjectId;
  title: string;
  subtitle: string | null;
  premise: string | null;
  language: string;
  phase: ProjectPhase;
  archivedAt: IsoDateTime | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface CreateProjectInput {
  id: ProjectId;
  title: string;
  subtitle?: string | null;
  premise?: string | null;
  language?: string;
  now: IsoDateTime;
}

export function createProject(input: CreateProjectInput): Project {
  const title = input.title.trim();
  if (title.length === 0) {
    throw new DomainError(
      "project.title.empty",
      "Project title must not be empty",
    );
  }

  return {
    id: input.id,
    title,
    subtitle: normalizeOptionalText(input.subtitle),
    premise: normalizeOptionalText(input.premise),
    language: input.language?.trim() || "zh-CN",
    phase: "idea",
    archivedAt: null,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export function transitionProjectPhase(
  project: Project,
  next: ProjectPhase,
  now: IsoDateTime,
): Project {
  if (!PROJECT_PHASE_TRANSITIONS[project.phase].includes(next)) {
    throw new DomainError(
      "project.phase.invalid_transition",
      `Cannot transition from ${project.phase} to ${next}`,
    );
  }
  return { ...project, phase: next, updatedAt: now };
}

export class DomainError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}

export * from "./canon.js";
export * from "./document.js";
export * from "./narrative-state.js";
export * from "./run.js";
export * from "./automation.js";
export * from "./collaboration.js";
export * from "./delivery.js";
export * from "./story.js";

function normalizeOptionalText(
  value: string | null | undefined,
): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
export { randomUuid, sha256BytesHex, sha256Hex } from "./crypto.js";
