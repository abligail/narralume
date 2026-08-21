import { DomainError, type IsoDateTime, type ProjectId } from "./index.js";

export type PersonaKind = "author" | "narrator" | "character";
export type PersonaStatus = "active" | "retired";

export interface StoryPersona {
  id: string;
  projectId: ProjectId;
  kind: PersonaKind;
  entityId: string | null;
  name: string;
  description: string | null;
  instructions: string;
  voice: Readonly<Record<string, unknown>>;
  status: PersonaStatus;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  version: number;
}

export interface CoCreateSession {
  id: string;
  projectId: ProjectId;
  title: string;
  status: "active" | "paused" | "archived";
  speakerPolicy: "manual" | "round_robin" | "auto";
  activeBranchId: string | null;
  targetOutlineNodeId: string | null;
  authorPersonaId: string | null;
  directorNote: string | null;
  contextTurns: number;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  version: number;
}

export interface CoCreateParticipant {
  sessionId: string;
  personaId: string;
  position: number;
  enabled: boolean;
  talkativeness: number;
  createdAt: IsoDateTime;
}

export interface StoryBranch {
  id: string;
  sessionId: string;
  parentBranchId: string | null;
  forkedFromTurnId: string | null;
  name: string;
  status: "active" | "archived";
  headTurnId: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export type StoryTurnRole = "user" | "assistant" | "director" | "system";

export interface StoryTurn {
  id: string;
  projectId: ProjectId;
  sessionId: string;
  branchId: string;
  parentTurnId: string | null;
  ordinal: number;
  role: StoryTurnRole;
  personaId: string | null;
  content: string;
  status: "active" | "reverted" | "adopted";
  selectedSwipeId: string | null;
  sourceRunId: string | null;
  metadata: Readonly<Record<string, unknown>>;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface TurnSwipe {
  id: string;
  turnId: string;
  ordinal: number;
  content: string;
  speakerPersonaId: string | null;
  sourceRunId: string | null;
  status: "candidate" | "selected" | "rejected";
  metadata: Readonly<Record<string, unknown>>;
  createdAt: IsoDateTime;
}

export interface SceneAdoption {
  id: string;
  projectId: ProjectId;
  sessionId: string;
  branchId: string;
  fromTurnId: string;
  toTurnId: string;
  outlineNodeId: string;
  documentId: string;
  documentVersionId: string;
  runId: string;
  canonChangeSetId: string | null;
  createdAt: IsoDateTime;
}

export interface DocumentComment {
  id: string;
  projectId: ProjectId;
  documentId: string;
  versionId: string;
  startOffset: number;
  endOffset: number;
  quote: string;
  body: string;
  status: "open" | "resolved";
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export interface EditProposal {
  id: string;
  projectId: ProjectId;
  documentId: string;
  baseVersionId: string;
  runId: string;
  instruction: string;
  selectionStart: number;
  selectionEnd: number;
  originalText: string;
  replacementText: string;
  proposedContent: string;
  diff: Readonly<Record<string, unknown>>;
  status: "proposed" | "accepted" | "rejected" | "superseded";
  acceptedVersionId: string | null;
  createdAt: IsoDateTime;
  decidedAt: IsoDateTime | null;
}

export function validateTextRange(
  content: string,
  start: number,
  end: number,
): void {
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end <= start ||
    end > content.length
  ) {
    throw new DomainError(
      "text.range.invalid",
      "Text selection is outside the current version range",
    );
  }
}

export function requireCreativeText(
  value: string,
  code: string,
  label: string,
): string {
  const text = value.trim();
  if (!text) throw new DomainError(code, `${label} must not be empty`);
  return text;
}
