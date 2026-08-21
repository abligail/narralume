import {
  MIN_VIABLE_PARTIAL_CHARACTERS,
  QUALITY_PRESETS,
  type AdoptRunStreamResponse,
  type AssistantActivityDto,
  type AssistantActivityActionResponseDto,
  type AssistantContext,
  type AssistantConversationDetailDto,
  type AssistantConversationDto,
  type AssistantMessageAcceptedDto,
  type AssistantMessageDto,
  type AssignmentRole,
  type AutopilotSessionDetailDto,
  type AutopilotSessionDto,
  type ChapterRunCreatedDto,
  type CanonCandidateSetDto,
  type CanonSpread,
  type ContinueRunStreamRequest,
  type CreateAssistantConversationRequest,
  type CreateAssistantMessageRequest,
  type DocumentReviewRunCreatedDto,
  type EffectivePolicy,
  type HealthResponse,
  type ImportedAgentSkillDto,
  type ModelAssignmentDto,
  type ModelConfigDto,
  type ModelExecutionPolicy,
  type ModelTaskType,
  type PublicProviderDto,
  type ProjectCoverDto,
  type ProjectCoverMutation,
  type QualityPreset,
  type RegenerateRunStreamResponse,
  type RunDetailDto,
  type RunOrigin,
  type StorySteerDto,
  type UpsertModelRequest,
  type UpsertProviderRequest,
  type WireApi,
} from "@narralume/contracts";

import { kernelRequest } from "../kernel/kernel-client";
import { getLocale, translate, type MessageKey } from "../i18n";
import { errors as zhErrors } from "../i18n/zh/errors";
import {
  currentDriverMode,
  readDriverOverride,
  requireResolvedMode,
} from "../kernel/transport";

// 直接复用合约导出，供给 / 运行详情等工作区与后端保持同一份类型真相。
export { MIN_VIABLE_PARTIAL_CHARACTERS, QUALITY_PRESETS };
export type {
  AdoptRunStreamResponse,
  AssistantActivityDto,
  AssistantActivityActionResponseDto,
  AssistantContext,
  AssistantConversationDetailDto,
  AssistantConversationDto,
  AssistantMessageAcceptedDto,
  AssistantMessageDto,
  AssignmentRole,
  AutopilotSessionDetailDto,
  AutopilotSessionDto,
  ChapterRunCreatedDto,
  CanonCandidateSetDto,
  CanonSpread,
  ContinueRunStreamRequest,
  CreateAssistantConversationRequest,
  CreateAssistantMessageRequest,
  DocumentReviewRunCreatedDto,
  EffectivePolicy,
  HealthResponse,
  ImportedAgentSkillDto,
  ModelAssignmentDto,
  ModelConfigDto,
  ModelExecutionPolicy,
  ModelTaskType,
  PublicProviderDto,
  ProjectCoverDto,
  ProjectCoverMutation,
  QualityPreset,
  RegenerateRunStreamResponse,
  RunDetailDto,
  RunOrigin,
  StorySteerDto,
  UpsertModelRequest,
  UpsertProviderRequest,
  WireApi,
};

/* ==========================================================================
   统一错误：后端 { error: { code, message, details } } → ApiError
   ========================================================================== */

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: unknown;

  constructor(code: string, message: string, status: number, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function apiErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const key = errorLookupKey(`message.${errorCodeKey(error.code)}`);
    if (key) return translate(getLocale(), key);
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return translate(getLocale(), "errors.message.requestFailed");
}

/** 后端错误码（request.unknown_field、assignment.model_limits.required 等）转字典键的 camelCase。 */
function errorCodeKey(code: string): string {
  return code.replace(/[._-](\w)/g, (_sep, ch: string) => ch.toUpperCase());
}

/* 错误提示统一查 errors 字典（zh 为结构真相）；运行期按 code 拼键，先校验存在再翻译，
   避免未知 code 落入 translate 的 missing-key 告警。 */
function errorLookupKey(path: string): MessageKey | null {
  let node: unknown = zhErrors;
  for (const part of path.split(".")) {
    if (!node || typeof node !== "object") return null;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? (`errors.${path}` as MessageKey) : null;
}

/** 按后端错误码给出可读补充提示（探测失败阶段等由 details 另行渲染）。 */
export function apiErrorHint(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  if (error.code === "policy.unknown_field") {
    const fields = detailStringList(error.details, "fields");
    return fields.length
      ? translate(getLocale(), "errors.hint.policyUnknownFieldFields", {
          fields: fields.join(fieldSeparator()),
        })
      : translate(getLocale(), "errors.hint.policyUnknownField");
  }
  if (error.code === "request.unknown_field") {
    const fields = detailStringList(error.details, "fields");
    return fields.length
      ? translate(getLocale(), "errors.hint.requestUnknownFieldFields", {
          fields: fields.join(fieldSeparator()),
        })
      : translate(getLocale(), "errors.hint.requestUnknownField");
  }
  const key = errorLookupKey(`hint.${errorCodeKey(error.code)}`);
  return key ? translate(getLocale(), key) : null;
}

function fieldSeparator(): string {
  return getLocale() === "zh-CN" ? "、" : ", ";
}

function detailStringList(details: unknown, key: string): string[] {
  if (!details || typeof details !== "object") return [];
  const value = (details as Record<string, unknown>)[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/* ==========================================================================
   Provider / Model / Assignment（B1 三层模型供给）
   ========================================================================== */

export async function listProviders(
  signal?: AbortSignal,
): Promise<PublicProviderDto[]> {
  return requestJson("/api/providers", signal ? { signal } : {});
}

export async function createProvider(
  input: UpsertProviderRequest,
): Promise<PublicProviderDto> {
  return requestJson("/api/providers", jsonRequest("POST", input));
}

export async function updateProvider(
  providerId: string,
  input: UpsertProviderRequest & { expectedUpdatedAt: string },
): Promise<PublicProviderDto> {
  return requestJson(
    `/api/providers/${encodeURIComponent(providerId)}`,
    jsonRequest("PUT", input),
  );
}

export async function deleteProvider(providerId: string): Promise<void> {
  return requestVoid(`/api/providers/${encodeURIComponent(providerId)}`, {
    method: "DELETE",
  });
}

export interface ProbeStage {
  stage: "text" | "stream" | "tool" | "structured-output";
  status: "passed" | "failed" | "unsupported" | "skipped";
  latencyMs: number;
  detail: string;
  /** 仅 structured-output 阶段返回：native | json-mode | prompt | none */
  capability?: string;
}

export interface ProviderProbeResult {
  providerId: string;
  modelId: string;
  startedAt: string;
  finishedAt: string;
  stages: ProbeStage[];
}

export async function probeProvider(input: {
  providerId: string;
  modelId: string;
  includeStreaming?: boolean;
  includeTools?: boolean;
  includeStructuredOutput?: boolean;
}): Promise<ProviderProbeResult> {
  return requestJson(
    "/api/providers/test",
    jsonRequest("POST", {
      providerId: input.providerId,
      modelId: input.modelId,
      includeStreaming: input.includeStreaming ?? true,
      includeTools: input.includeTools ?? true,
      includeStructuredOutput: input.includeStructuredOutput ?? true,
    }),
  );
}

export async function listModels(
  providerId?: string,
  signal?: AbortSignal,
): Promise<ModelConfigDto[]> {
  const query = providerId
    ? `?providerId=${encodeURIComponent(providerId)}`
    : "";
  return requestJson(`/api/models${query}`, signal ? { signal } : {});
}

export async function createModel(
  input: UpsertModelRequest,
): Promise<ModelConfigDto> {
  return requestJson("/api/models", jsonRequest("POST", input));
}

export async function updateModel(
  modelId: string,
  input: UpsertModelRequest & { expectedUpdatedAt: string },
): Promise<ModelConfigDto> {
  return requestJson(
    `/api/models/${encodeURIComponent(modelId)}`,
    jsonRequest("PUT", input),
  );
}

export async function deleteModel(modelId: string): Promise<void> {
  return requestVoid(`/api/models/${encodeURIComponent(modelId)}`, {
    method: "DELETE",
  });
}

export async function listAssignments(
  signal?: AbortSignal,
): Promise<ModelAssignmentDto[]> {
  return requestJson("/api/assignments", signal ? { signal } : {});
}

export async function setAssignment(
  role: AssignmentRole,
  modelId: string,
): Promise<ModelAssignmentDto> {
  return requestJson(
    `/api/assignments/${encodeURIComponent(role)}`,
    jsonRequest("PUT", { modelId }),
  );
}

export async function deleteAssignment(role: AssignmentRole): Promise<void> {
  return requestVoid(`/api/assignments/${encodeURIComponent(role)}`, {
    method: "DELETE",
  });
}

/* ==========================================================================
   领域类型（story / run / review / automation / studio / delivery …）
   ========================================================================== */

export interface RetrievalHit {
  id: string;
  projectId: string;
  sourceType: string;
  sourceId: string;
  title: string;
  content: string;
  authority: "reference" | "draft" | "candidate" | "confirmed" | "locked";
  metadata: Record<string, unknown>;
  entityIds: string[];
  createdAt: string;
  updatedAt: string;
  lexicalRank: number | null;
  vectorRank: number | null;
  entityScore: number;
  vectorScore: number;
  rerankScore: number | null;
  score: number;
  reasons: ("fts" | "entity" | "vector" | "rerank")[];
}

export interface NarrativeMemory {
  id: string;
  projectId: string;
  layer: "working" | "episodic" | "semantic";
  scopeType: string;
  scopeId: string;
  title: string;
  content: string;
  stateDelta: Record<string, unknown>;
  sourceHash: string;
  status: "active" | "stale" | "retired";
  refreshedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface PlotPrediction {
  id: string;
  projectId: string;
  title: string;
  horizon: number;
  summary: string;
  impact: string[];
  risks: string[];
  uncertainty: number;
  contextFingerprint: string;
  status: "candidate" | "adopted" | "dismissed";
  stale: boolean;
  sourceIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface DryRunResult {
  fingerprint: string;
  safeToProceed: boolean;
  findings: {
    kind: "entity" | "fact" | "timeline" | "foreshadow" | "outline";
    sourceId: string;
    label: string;
    impact: string;
    severity: "info" | "warning";
  }[];
}

export interface WritingSkillValidation {
  valid: boolean;
  applicable: boolean;
  scope: WritingSkillScope;
  checks: { id: string; passed: boolean; message: string }[];
}

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

export interface Project {
  id: string;
  title: string;
  subtitle: string | null;
  premise: string | null;
  language: string;
  phase:
    | "idea"
    | "foundation"
    | "outlining"
    | "writing"
    | "revising"
    | "complete";
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastWritingAt?: string | null;
  wordCount?: number;
  committedChapters?: number;
  totalChapters?: number;
  cover?: ProjectCoverDto | null;
}

export interface RecycledProject extends Project {
  deletedAt: string;
  deletionToken: string;
  deleteAfter: string;
}

export interface AuthorIntent {
  projectId: string;
  promise: string | null;
  themes: string[];
  audience: string | null;
  tone: string | null;
  boundaries: string[];
  endingDirection: string | null;
  currentFocus: string | null;
  lockedFields: string[];
  updatedAt: string;
}

export interface OutlineNode {
  id: string;
  projectId: string;
  parentId: string | null;
  kind: "book" | "volume" | "arc" | "chapter" | "scene" | "beat";
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
  status: "planned" | "drafting" | "review" | "committed" | "abandoned";
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CanonEntity {
  id: string;
  projectId: string;
  type: "character" | "location" | "organization" | "item" | "rule" | "concept";
  name: string;
  aliases: string[];
  description: string | null;
  attributes: Record<string, unknown>;
  status: "active" | "retired";
  createdAt: string;
  updatedAt: string;
}

export interface CanonFact {
  id: string;
  projectId: string;
  subjectId: string;
  predicate: string;
  objectEntityId: string | null;
  value: unknown;
  validFromNodeId: string | null;
  validToNodeId: string | null;
  knowledgeScope: "omniscient" | "reader" | "character" | "author_secret";
  knowledgeSubjectId: string | null;
  authority: "candidate" | "inferred" | "confirmed" | "locked";
  confidence: number;
  sourceType: string;
  sourceId: string | null;
  supersedesFactId: string | null;
  createdAt: string;
}

export interface RelationshipEvent {
  id: string;
  projectId: string;
  fromEntityId: string;
  toEntityId: string;
  relation: string;
  intensity: number | null;
  state: Record<string, unknown>;
  outlineNodeId: string | null;
  storyTime: string | null;
  sourceId: string | null;
  createdAt: string;
}

export interface TimelineEvent {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  outlineNodeId: string | null;
  storyTimeStart: string | null;
  storyTimeEnd: string | null;
  sequence: number;
  participants: string[];
  causes: string[];
  visibility: "omniscient" | "reader" | "author_secret";
  sourceId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Foreshadow {
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: "planned" | "planted" | "developing" | "resolved" | "abandoned";
  importance: 1 | 2 | 3 | 4 | 5;
  dependencies: string[];
  evidenceNodeIds: string[];
  targetFromNodeId: string | null;
  targetToNodeId: string | null;
  resolutionNodeId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StoryBible {
  project: Project;
  intent: AuthorIntent | null;
  outline: OutlineNode[];
  entities: CanonEntity[];
  facts: CanonFact[];
  relationships: RelationshipEvent[];
  timeline: TimelineEvent[];
  foreshadows: Foreshadow[];
  occupiedOutlineNodeIds: string[];
  documents: {
    id: string;
    projectId: string;
    kind: string;
    title: string;
    currentVersionId: string | null;
    archivedAt?: string | null;
    createdAt: string;
    updatedAt: string;
  }[];
}

export interface StyleProfile {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  rules: string[];
  examples: string[];
  negativeRules: string[];
  source: string;
  active: boolean;
  status: "active" | "retired";
  createdAt: string;
  updatedAt: string;
  version: number;
}

export type WritingSkillScope =
  | "all"
  | "chapter"
  | "cocreate"
  | "edit"
  | "review";

export interface WritingSkill {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  instructions: string;
  scopes: WritingSkillScope[];
  priority: number;
  enabled: boolean;
  source: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export type ImportFormat =
  | "markdown"
  | "text"
  | "docx"
  | "html"
  | "epub"
  | "narrative-bundle";
export type ExportFormat =
  | "markdown"
  | "text"
  | "docx"
  | "epub"
  | "narrative-bundle";

export interface ImportBatch {
  id: string;
  targetProjectId: string | null;
  filename: string;
  format: ImportFormat;
  sourceHash: string;
  sourceCharacters: number;
  status: "previewed" | "analyzing" | "ready" | "applied" | "discarded";
  metadata: Record<string, unknown>;
  analysisRunId: string | null;
  appliedProjectId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ImportBatchDetail {
  batch: ImportBatch;
  candidates: {
    id: string;
    batchId: string;
    kind:
      | "project"
      | "document"
      | "outline"
      | "intent"
      | "entity"
      | "style"
      | "skill"
      | "relationship"
      | "timeline"
      | "foreshadow"
      | "character-arc"
      | "scene-analysis";
    ordinal: number;
    title: string;
    payload: Record<string, unknown>;
    status: "pending" | "selected" | "discarded" | "applied";
    createdAt: string;
    updatedAt: string;
  }[];
}

export interface BundleCounts {
  outline: number;
  entities: number;
  facts: number;
  relationships: number;
  timeline: number;
  foreshadows: number;
  documents: number;
  versions: number;
  drafts: number;
  personas: number;
  styles: number;
  skills: number;
  annotations: number;
  cover: number;
  cocreateSessions: number;
  storyTurns: number;
  reviews: number;
  reviewIssues: number;
  assistantConversations: number;
  assistantMessages: number;
  assistantActivities: number;
  assistantLongGoals: number;
  runs: number;
}

export interface ProjectBackup {
  id: string;
  projectId: string;
  label: string;
  bundleHash: string;
  sizeBytes: number;
  createdAt: string;
  restoredProjectId: string | null;
  counts?: BundleCounts | null;
}

export interface ImportUploadSession {
  id: string;
  batchId: string | null;
  targetProjectId: string | null;
  filename: string;
  format: ImportFormat;
  totalBytes: number;
  chunkSize: number;
  expectedHash: string | null;
  receivedBytes: number;
  receivedChunks: number;
  status: "uploading" | "completed" | "expired" | "discarded";
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface SystemBackupManifest {
  id: string;
  label: string;
  databaseFile: string;
  createdAt: string;
  sizeBytes: number;
  sha256: string;
  migration: number;
  pageCount: number;
  projectCount: number;
}

export interface SystemBackupPreview {
  manifest: SystemBackupManifest;
  valid: boolean;
  hashMatches: boolean;
  integrityCheck: string;
  foreignKeyViolations: number;
  counts: {
    projects: number;
    documents: number;
    versions: number;
    canonFacts: number;
    runs: number;
  };
}

export interface ProjectQualityReport {
  projectId: string;
  score: number;
  readiness: "blocked" | "needs_attention" | "ready";
  gates: {
    id: string;
    label: string;
    passed: boolean;
    message: string;
    targetType: string | null;
    targetId: string | null;
  }[];
  generatedAt: string;
  metrics: Record<string, number>;
  issues: {
    id: string;
    category: "structure" | "manuscript" | "canon" | "continuity" | "workflow";
    severity: "info" | "warning" | "error";
    message: string;
    targetType: string | null;
    targetId: string | null;
    suggestion: string;
  }[];
}

export interface ContextPreview {
  text: string;
  sections: {
    id: string;
    kind: string;
    label: string;
    content: string;
    authority: string;
    tokenEstimate: number;
    compressed: boolean;
  }[];
  receipt: {
    id: string;
    purpose: string;
    compiledHash: string;
    budget: { available: number; used: number; remaining: number };
    entries: {
      sourceId: string;
      label: string;
      status: "included" | "compressed" | "excluded";
      originalTokens: number;
      finalTokens: number;
      reason: string;
    }[];
  };
}

export type RunStatus =
  | "pending"
  | "running"
  | "paused"
  | "awaiting_user"
  | "failed_recoverable"
  | "failed"
  | "cancelled"
  | "completed";

export type RunStepKind =
  | "context.compile"
  | "scene.plan"
  | "draft.generate"
  | "deterministic.check"
  | "semantic.review"
  | "revision.generate"
  | "chapter.settle"
  | "chapter.commit"
  | "foundation.generate"
  | "foundation.stage"
  | "outline.generate"
  | "outline.commit"
  | "steer.classify"
  | "arc.review"
  | "volume.review"
  | "cocreate.context"
  | "cocreate.respond"
  | "cocreate.stage"
  | "adoption.prepare"
  | "adoption.settle"
  | "adoption.commit"
  | "edit.transform"
  | "edit.stage"
  | "import.analyze"
  | "import.stage"
  | "assistant.context"
  | "assistant.respond"
  | "assistant.stage"
  | "canon.context"
  | "canon.candidate"
  | "canon.stage";

export interface NarrativeRun {
  id: string;
  projectId: string;
  recipe: string;
  recipeVersion: number;
  mode: "autopilot" | "chapter-gate" | "director" | "co-create" | "manual";
  status: RunStatus;
  targetOutlineNodeId: string | null;
  policy: Record<string, unknown>;
  budgetUsage: RunBudgetUsage;
  revisionCycle: number;
  pauseRequested: boolean;
  cancelRequested: boolean;
  currentStepId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface RunBudgetUsage {
  inputTokens: number;
  outputTokens: number;
  calls: number;
  costUsd: number;
  wallTimeMs: number;
}

export interface NarrativeRunStep {
  id: string;
  runId: string;
  ordinal: number;
  kind: RunStepKind;
  cycle: number;
  status:
    | "pending"
    | "running"
    | "succeeded"
    | "failed"
    | "skipped"
    | "cancelled";
  outputArtifact: Record<string, unknown> | null;
  outputHash: string | null;
  error: { code: string; message: string; retryable: boolean } | null;
  attempt: number;
  maxAttempts: number;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface RunSnapshot {
  run: NarrativeRun;
  steps: NarrativeRunStep[];
  events: {
    id: number;
    sequence: number;
    stepId: string | null;
    type: string;
    payload: Record<string, unknown>;
    createdAt: string;
  }[];
  latestCheckpoint: {
    kind: string;
    stateHash: string;
    createdAt: string;
  } | null;
}

/** B1 运行详情：在快照之外带 effectivePolicy / contextReceipts /
 *  modelSnapshots / llmCalls / reviews / streams，直接复用合约 DTO。 */
export type RunDetail = RunDetailDto;

export type ReviewIssueStatus = "open" | "accepted" | "rejected" | "resolved";
export type ReviewIssueDecisionAction =
  | "accept"
  | "reject"
  | "false_positive"
  | "intentional_keep";

export interface ReviewWorkspaceIssue {
  id: string;
  category: string;
  severity: "info" | "minor" | "major" | "critical";
  message: string;
  evidence: { quote: string; start?: number; end?: number }[];
  suggestedDirection: string | null;
  status: ReviewIssueStatus;
  decision: {
    action: ReviewIssueDecisionAction;
    note: string | null;
    decidedAt: string;
  } | null;
}

export interface ReviewWorkspaceReport {
  id: string;
  projectId: string;
  runId: string;
  stepId: string;
  documentVersionId: string | null;
  documentId: string | null;
  documentTitle: string | null;
  verdict: "pass" | "revise" | "block";
  summary: string;
  scores: Record<string, number>;
  reviewedContent: string | null;
  reviewedContentHash: string | null;
  issues: ReviewWorkspaceIssue[];
  createdAt: string;
}

export interface ReviewRevisionProposal {
  id: string;
  runId: string;
  stepId: string;
  documentId: string | null;
  baseDocumentVersionId: string | null;
  baseContent: string | null;
  revisedContent: string;
  diff: Record<string, unknown>;
  addressedIssueIds: string[];
  status: "proposed" | "accepted" | "rejected" | "superseded";
  createdAt: string;
  decidedAt: string | null;
}

export interface ReviewWorkspace {
  reports: ReviewWorkspaceReport[];
  proposals: ReviewRevisionProposal[];
}

export interface StoryCompass {
  projectId: string;
  corePromise: string;
  endingDirection: string | null;
  longLines: { title: string; promise: string; status: string }[];
  themeQuestions: string[];
  target: { chapters: number; wordsPerChapter: number; volumes: number };
  constraints: string[];
  version: number;
  updatedAt: string;
}

export interface FoundationCandidate {
  id: string;
  setId: string;
  projectId: string;
  kind: "intent" | "compass" | "entity";
  label: string;
  payload: Record<string, unknown>;
  editedPayload: Record<string, unknown> | null;
  status: "pending" | "adopted" | "discarded";
  adoptedRefType: string | null;
  adoptedRefId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FoundationCandidateSet {
  set: {
    id: string;
    projectId: string;
    sourceRunId: string;
    title: string;
    status: "open" | "partially_adopted" | "adopted" | "discarded";
    createdAt: string;
    updatedAt: string;
  };
  candidates: FoundationCandidate[];
}

/** 自动驾驶会话 / 舵令 / 详情：直接复用合约 DTO，与后端保持同一份形状。
 *  契约里 session 同时携带 mode、approvalMode 与 origin。 */
export type AutopilotSession = AutopilotSessionDto;
export type StorySteer = StorySteerDto;
export type AutopilotSessionDetail = AutopilotSessionDetailDto;

export interface RunOriginInput {
  /** zod 契约里 documentId/selection 有 default，但从 z.infer 推导出的类型上
   *  它们是必填；请求侧允许只给 surface，故此处全部可选。 */
  surface: string;
  documentId?: string | null;
  selection?: { start: number; end: number } | null;
}

/** 后台任务的统一动作枚举（RunAvailableAction）。 */
export type RunAction =
  | "pause"
  | "resume"
  | "cancel"
  | "accept_plan"
  | "switch_to_manual"
  | "accept_manuscript"
  | "request_revision"
  | "discard_manuscript"
  | "use_partial"
  | "regenerate"
  | "retry_chapter";

/** POST /api/runs/:runId/actions 的请求体（RunActionRequest）。 */
export type RunActionRequest =
  | {
      action:
        | "pause"
        | "resume"
        | "cancel"
        | "accept_plan"
        | "switch_to_manual"
        | "accept_manuscript"
        | "discard_manuscript";
    }
  | { action: "request_revision"; requestId: string; instruction?: string }
  | { action: "retry_chapter"; requestId: string };

/** POST /api/autopilot/sessions/:sessionId/actions 的请求体（SessionActionRequest）。 */
export type SessionActionRequest =
  | {
      action: "pause" | "resume" | "cancel";
    }
  | {
      action: "accept_plan" | "accept_manuscript";
      requestId: string;
    }
  | { action: "request_revision"; requestId: string; instruction?: string };

/** 后台任务的产物投影（RunProductResult）。不参与内部 Step 解析。 */
export interface RunProductResult {
  planCandidate: Record<string, unknown> | null;
  manuscriptCandidate: Record<string, unknown> | null;
  reviewSummary: Record<string, unknown> | null;
  settlementCandidate: Record<string, unknown> | null;
  canonChangeSetId: string | null;
  foundationCandidateSetId: string | null;
  canonCandidateSetId: string | null;
  editProposalId: string | null;
  cocreateTurnId: string | null;
  cocreateSwipeId: string | null;
  sceneAdoptionId: string | null;
  documentId: string | null;
  documentVersionId: string | null;
  importBatchId: string | null;
  partialRecovery: {
    stepId: string;
    attempt: number;
    characters: number;
    canAdopt: boolean;
  } | null;
}

/** 202 接收的后台任务：运行快照 + 产物投影 + 当前可执行动作（BackgroundRunCreated）。 */
export interface BackgroundRunCreated extends RunSnapshot {
  origin: RunOrigin | null;
  result: RunProductResult;
  availableActions: RunAction[];
}

export interface ProjectOverviewChapter {
  outlineNodeId: string;
  title: string;
  status: "planned" | "drafting" | "review" | "committed" | "abandoned";
  documentId: string | null;
  documentVersionId: string | null;
}

/** 项目概览的主创作任务（快速创作 / 单章 / AI 建书）。 */
export interface ProjectOverviewActiveTask {
  kind: "quick_creation" | "chapter" | "foundation";
  id: string;
  status: string;
  targetChapter: ProjectOverviewChapter | null;
  origin: Record<string, unknown> | null;
  stopReason: string | null;
  availableActions: string[];
}

export interface ProjectOverview {
  project: Project;
  progress: {
    lastWritingAt: string | null;
    wordCount: number;
    committedChapters: number;
    totalChapters: number;
  };
  currentChapter: ProjectOverviewChapter | null;
  activeTask: ProjectOverviewActiveTask | null;
  pending: {
    foundationCandidates: number;
    reviewIssues: number;
    revisionProposals: number;
    canonChangeSets: number;
    reviewDocumentId: string | null;
  };
  nextAction: {
    kind:
      | "continue_task"
      | "review_foundation"
      | "resolve_story_changes"
      | "review_writing"
      | "write_chapter"
      | "build_outline"
      | "complete";
    targetId: string | null;
  };
}

export interface ProjectFoundationTaskCreated {
  project: Project;
  task: BackgroundRunCreated;
  idempotentReplay: boolean;
}

export type PersonaKind = "author" | "narrator" | "character";

export interface StoryPersona {
  id: string;
  projectId: string;
  kind: PersonaKind;
  entityId: string | null;
  name: string;
  description: string | null;
  instructions: string;
  voice: Record<string, unknown>;
  status: "active" | "retired";
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface CoCreateSession {
  id: string;
  projectId: string;
  title: string;
  status: "active" | "paused" | "archived";
  speakerPolicy: "manual" | "round_robin" | "auto";
  activeBranchId: string | null;
  targetOutlineNodeId: string | null;
  authorPersonaId: string | null;
  directorNote: string | null;
  contextTurns: number;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface CoCreateParticipant {
  sessionId: string;
  personaId: string;
  position: number;
  enabled: boolean;
  talkativeness: number;
  createdAt: string;
  persona: StoryPersona;
}

export interface StoryBranch {
  id: string;
  sessionId: string;
  parentBranchId: string | null;
  forkedFromTurnId: string | null;
  name: string;
  status: "active" | "archived";
  headTurnId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TurnSwipe {
  id: string;
  turnId: string;
  ordinal: number;
  content: string;
  speakerPersonaId: string | null;
  sourceRunId: string | null;
  status: "candidate" | "selected" | "rejected";
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface StoryTurn {
  id: string;
  projectId: string;
  sessionId: string;
  branchId: string;
  parentTurnId: string | null;
  ordinal: number;
  role: "user" | "assistant" | "director" | "system";
  personaId: string | null;
  content: string;
  status: "active" | "reverted" | "adopted";
  selectedSwipeId: string | null;
  sourceRunId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  swipes: TurnSwipe[];
}

export interface SceneAdoption {
  id: string;
  projectId: string;
  sessionId: string;
  branchId: string;
  fromTurnId: string;
  toTurnId: string;
  outlineNodeId: string;
  documentId: string;
  documentVersionId: string;
  runId: string;
  canonChangeSetId: string | null;
  createdAt: string;
}

export interface CoCreateSessionDetail {
  session: CoCreateSession;
  participants: CoCreateParticipant[];
  branches: StoryBranch[];
  turns: StoryTurn[];
  adoptions: SceneAdoption[];
}

export interface StoryDocument {
  id: string;
  projectId: string;
  kind:
    | "manuscript"
    | "chapter"
    | "scene"
    | "outline"
    | "synopsis"
    | "note"
    | "style-sample";
  title: string;
  outlineNodeId: string | null;
  currentVersionId: string | null;
  archivedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentVersion {
  id: string;
  documentId: string;
  parentVersionId: string | null;
  content: string;
  contentHash: string;
  source: string;
  runId: string | null;
  createdAt: string;
}

export interface DocumentComment {
  id: string;
  projectId: string;
  documentId: string;
  versionId: string;
  startOffset: number;
  endOffset: number;
  quote: string;
  body: string;
  status: "open" | "resolved";
  createdAt: string;
  updatedAt: string;
}

export interface EditProposal {
  id: string;
  projectId: string;
  documentId: string;
  baseVersionId: string;
  runId: string;
  instruction: string;
  selectionStart: number;
  selectionEnd: number;
  originalText: string;
  replacementText: string;
  proposedContent: string;
  diff: Record<string, unknown>;
  status: "proposed" | "accepted" | "rejected" | "superseded";
  acceptedVersionId: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface StudioDocumentDetail {
  document: StoryDocument;
  currentVersion: DocumentVersion | null;
  draft: DocumentDraft | null;
  versions: DocumentVersion[];
  comments: DocumentComment[];
  proposals: EditProposal[];
}

export interface DocumentDraft {
  projectId: string;
  documentId: string;
  baseVersionId: string | null;
  content: string;
  contentHash: string;
  updatedAt: string;
}

/* ==========================================================================
   系统 / 健康
   ========================================================================== */

export async function getHealth(signal?: AbortSignal): Promise<HealthResponse> {
  return requestJson<HealthResponse>("/api/health", signal ? { signal } : {});
}

/* ==========================================================================
   作品 / 故事圣经
   ========================================================================== */

export async function getProjects(signal?: AbortSignal): Promise<Project[]> {
  return getAllProjectPages(false, signal);
}

export async function getProjectsIncludingArchived(
  signal?: AbortSignal,
): Promise<Project[]> {
  return getAllProjectPages(true, signal);
}

async function getAllProjectPages(
  includeArchived: boolean,
  signal?: AbortSignal,
): Promise<Project[]> {
  const pageSize = 100;
  const projects: Project[] = [];
  let offset = 0;
  while (true) {
    const params = new URLSearchParams();
    if (includeArchived) params.set("includeArchived", "true");
    if (offset > 0) params.set("offset", String(offset));
    const query = params.toString();
    const page = await requestJson<Project[]>(
      `/api/projects${query ? `?${query}` : ""}`,
      signal ? { signal } : {},
    );
    projects.push(...page);
    if (page.length < pageSize) return projects;
    offset += page.length;
  }
}

export async function createProject(input: {
  requestId: string;
  title: string;
  premise: string | null;
}): Promise<Project> {
  return requestJson<Project>("/api/projects", jsonRequest("POST", input));
}

/* ==========================================================================
   项目助手：会话、消息、统一活动与显式工具确认
   ========================================================================== */

export async function createAssistantConversation(
  projectId: string,
  input: CreateAssistantConversationRequest,
): Promise<AssistantConversationDto> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/assistant/conversations`,
    jsonRequest("POST", input),
  );
}

export async function getAssistantConversations(
  projectId: string,
  signal?: AbortSignal,
): Promise<AssistantConversationDto[]> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/assistant/conversations`,
    signal ? { signal } : {},
  );
}

export async function getAssistantConversation(
  conversationId: string,
  signal?: AbortSignal,
): Promise<AssistantConversationDetailDto> {
  return requestJson(
    `/api/assistant/conversations/${encodeURIComponent(conversationId)}`,
    signal ? { signal } : {},
  );
}

export async function archiveAssistantConversation(
  conversationId: string,
): Promise<AssistantConversationDto> {
  return requestJson(
    `/api/assistant/conversations/${encodeURIComponent(conversationId)}/actions`,
    jsonRequest("POST", { action: "archive" }),
  );
}

export async function renameAssistantConversation(
  conversationId: string,
  title: string,
): Promise<AssistantConversationDto> {
  return requestJson(
    `/api/assistant/conversations/${encodeURIComponent(conversationId)}/actions`,
    jsonRequest("POST", { action: "rename", title }),
  );
}

/** 对话级模型/思考档设置；modelId=null 清除覆盖回到全局默认。 */
export async function configureAssistantConversation(
  conversationId: string,
  input: { modelId?: string | null; reasoningEffort?: string | null },
): Promise<AssistantConversationDto> {
  return requestJson(
    `/api/assistant/conversations/${encodeURIComponent(conversationId)}/actions`,
    jsonRequest("POST", { action: "configure", ...input }),
  );
}

export async function sendAssistantMessage(
  conversationId: string,
  input: CreateAssistantMessageRequest,
): Promise<AssistantMessageAcceptedDto> {
  return requestJson(
    `/api/assistant/conversations/${encodeURIComponent(conversationId)}/messages`,
    jsonRequest("POST", input),
  );
}

export async function decideAssistantActivity(
  activityId: string,
  action: "confirm" | "reject" | "retry" | "resume" | "cancel",
): Promise<AssistantActivityActionResponseDto> {
  return requestJson(
    `/api/assistant/activities/${encodeURIComponent(activityId)}/actions`,
    jsonRequest("POST", { action }),
  );
}

export async function updateProject(
  projectId: string,
  input: {
    title: string;
    subtitle: string | null;
    premise: string | null;
    archived: boolean;
    expectedUpdatedAt: string;
    cover?: ProjectCoverMutation;
  },
): Promise<Project> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}`,
    jsonRequest("PUT", input),
  );
}

export function projectCoverUrl(
  project: Pick<Project, "id" | "cover">,
): string | null {
  if (!project.cover) return null;
  if (readDriverOverride() === "local" || currentDriverMode() === "local") {
    // local 模式封面无 HTTP URL——封面经 projectCoverBlob() 取 bytes 后
    // 由调用方渲染；此处返回 null 让调用方走默认占位或已缓存的 blob。
    return localCoverCache.get(coverCacheKey(project)) ?? null;
  }
  return `/api/projects/${encodeURIComponent(project.id)}/cover?v=${encodeURIComponent(project.cover.updatedAt)}`;
}

const localCoverCache = new Map<string, string>();
function coverCacheKey(
  project: Pick<Project, "id" | "cover">,
): string {
  return `${project.id}:${project.cover?.updatedAt ?? ""}`;
}

/** local 模式取封面 bytes 并缓存为 Blob URL（同封面更新时间只取一次）。 */
export async function projectCoverBlob(
  project: Pick<Project, "id" | "cover">,
): Promise<string | null> {
  if (!project.cover) return null;
  const key = coverCacheKey(project);
  const cached = localCoverCache.get(key);
  if (cached) return cached;
  const { blob } = await requestBlob(
    `/api/projects/${encodeURIComponent(project.id)}/cover`,
  );
  const url = URL.createObjectURL(blob);
  // 回收旧版本的 Blob URL，避免刷新封面后累积泄漏。
  for (const [existingKey, existingUrl] of localCoverCache) {
    if (existingKey.startsWith(`${project.id}:`) && existingKey !== key) {
      URL.revokeObjectURL(existingUrl);
      localCoverCache.delete(existingKey);
    }
  }
  localCoverCache.set(key, url);
  return url;
}

export async function duplicateProject(
  projectId: string,
  title?: string,
): Promise<Project> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/duplicate`,
    jsonRequest("POST", title ? { title } : {}),
  );
}

export async function deleteProject(
  project: Pick<Project, "id" | "title" | "updatedAt">,
): Promise<RecycledProject> {
  return requestJson(
    `/api/projects/${encodeURIComponent(project.id)}`,
    jsonRequest("DELETE", {
      confirmationTitle: project.title,
      expectedUpdatedAt: project.updatedAt,
    }),
  );
}

export async function getRecycledProjects(
  signal?: AbortSignal,
): Promise<RecycledProject[]> {
  return requestJson(
    "/api/projects/recycle-bin",
    signal ? { signal } : {},
  );
}

export async function restoreRecycledProject(
  project: Pick<RecycledProject, "id" | "deletionToken">,
): Promise<Project> {
  return requestJson(
    `/api/projects/${encodeURIComponent(project.id)}/restore`,
    jsonRequest("POST", { deletionToken: project.deletionToken }),
  );
}

export async function purgeRecycledProject(
  project: Pick<RecycledProject, "id" | "title" | "deletionToken">,
): Promise<void> {
  return requestVoid(
    `/api/projects/${encodeURIComponent(project.id)}/purge`,
    jsonRequest("DELETE", {
      deletionToken: project.deletionToken,
      confirmationTitle: project.title,
    }),
  );
}

export async function getStoryBible(
  projectId: string,
  signal?: AbortSignal,
): Promise<StoryBible> {
  return requestJson<StoryBible>(
    `/api/projects/${encodeURIComponent(projectId)}/story-bible`,
    signal ? { signal } : {},
  );
}

export async function startCanonCandidate(
  projectId: string,
  spread: CanonSpread,
  input: { requestId: string; instruction: string },
): Promise<{ runId: string; idempotentReplay: boolean }> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/canon-spreads/${encodeURIComponent(spread)}/candidates`,
    jsonRequest("POST", input),
  );
}

export async function getCanonCandidates(
  projectId: string,
  spread: CanonSpread,
  signal?: AbortSignal,
): Promise<CanonCandidateSetDto[]> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/canon-spreads/${encodeURIComponent(spread)}/candidates`,
    signal ? { signal } : {},
  );
}

export async function decideCanonCandidateItem(
  projectId: string,
  candidateSetId: string,
  itemId: string,
  input: { action: "apply" | "reject"; confirmLocked?: boolean },
): Promise<{
  candidateSet: CanonCandidateSetDto;
  item: CanonCandidateSetDto["items"][number];
}> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/canon-candidates/${encodeURIComponent(candidateSetId)}/items/${encodeURIComponent(itemId)}/decisions`,
    jsonRequest("POST", input),
  );
}

export async function updateAuthorIntent(
  projectId: string,
  input: Partial<Omit<AuthorIntent, "projectId" | "updatedAt">> & {
    expectedUpdatedAt: string | null;
  },
): Promise<AuthorIntent> {
  return requestJson<AuthorIntent>(
    `/api/projects/${encodeURIComponent(projectId)}/intent`,
    jsonRequest("PUT", input),
  );
}

export async function createCanonEntity(
  projectId: string,
  input: {
    type: CanonEntity["type"];
    name: string;
    aliases: string[];
    description: string | null;
    attributes?: Record<string, unknown>;
  },
): Promise<CanonEntity> {
  return requestJson<CanonEntity>(
    `/api/projects/${encodeURIComponent(projectId)}/entities`,
    jsonRequest("POST", input),
  );
}

export async function updateCanonEntity(
  projectId: string,
  entityId: string,
  input: Pick<
    CanonEntity,
    "name" | "aliases" | "description" | "attributes" | "status"
  > & { expectedUpdatedAt: string },
): Promise<CanonEntity> {
  return requestJson<CanonEntity>(
    `/api/projects/${encodeURIComponent(projectId)}/entities/${encodeURIComponent(entityId)}`,
    jsonRequest("PUT", input),
  );
}

export interface StoryResourceRemoval {
  id: string;
  disposition: "deleted" | "abandoned" | "retired" | "voided";
  references: number;
}

function removeStoryResource(path: string, expectedUpdatedAt: string) {
  return requestJson<StoryResourceRemoval>(
    path,
    jsonRequest("DELETE", { expectedUpdatedAt }),
  );
}

export function removeCanonEntity(projectId: string, entity: CanonEntity) {
  return removeStoryResource(
    `/api/projects/${encodeURIComponent(projectId)}/entities/${encodeURIComponent(entity.id)}`,
    entity.updatedAt,
  );
}

export async function createOutlineNode(
  projectId: string,
  input: {
    parentId: string;
    kind: OutlineNode["kind"];
    ordinal: number;
    title: string;
    summary: string | null;
    metadata: Record<string, unknown>;
  },
): Promise<OutlineNode> {
  return requestJson<OutlineNode>(
    `/api/projects/${encodeURIComponent(projectId)}/outline`,
    jsonRequest("POST", input),
  );
}

export async function updateOutlineNode(
  projectId: string,
  nodeId: string,
  input: Partial<
    Pick<
      OutlineNode,
      | "title"
      | "summary"
      | "goal"
      | "conflict"
      | "outcome"
      | "povEntityId"
      | "storyTime"
      | "status"
      | "metadata"
    >
  > & { expectedUpdatedAt: string },
): Promise<OutlineNode> {
  return requestJson<OutlineNode>(
    `/api/projects/${encodeURIComponent(projectId)}/outline/${encodeURIComponent(nodeId)}`,
    jsonRequest("PUT", input),
  );
}

export function removeOutlineNode(projectId: string, node: OutlineNode) {
  return removeStoryResource(
    `/api/projects/${encodeURIComponent(projectId)}/outline/${encodeURIComponent(node.id)}`,
    node.updatedAt,
  );
}

export async function createCanonFact(
  projectId: string,
  input: {
    subjectId: string;
    predicate: string;
    objectEntityId?: string | null;
    value?: unknown;
    authority: CanonFact["authority"];
    knowledgeScope: CanonFact["knowledgeScope"];
    knowledgeSubjectId?: string | null;
    confidence?: number;
  },
): Promise<{
  fact: CanonFact;
  conflicts: { reason: string; fact: CanonFact }[];
}> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/facts`,
    jsonRequest("POST", input),
  );
}

export async function reviseCanonFact(
  projectId: string,
  factId: string,
  input: {
    subjectId: string;
    predicate: string;
    objectEntityId: string | null;
    value?: unknown;
    validFromNodeId: string | null;
    validToNodeId: string | null;
    knowledgeScope: CanonFact["knowledgeScope"];
    knowledgeSubjectId: string | null;
    authority: CanonFact["authority"];
    confidence: number;
    confirmLockedRevision: boolean;
  },
): Promise<{
  fact: CanonFact;
  conflicts: { reason: string; fact: CanonFact }[];
}> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/facts/${encodeURIComponent(factId)}`,
    jsonRequest("PUT", input),
  );
}

export async function promoteCanonFact(
  projectId: string,
  factId: string,
  authority: "inferred" | "confirmed" | "locked",
): Promise<CanonFact> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/facts/${encodeURIComponent(factId)}/promote`,
    jsonRequest("POST", { authority }),
  );
}

export async function withdrawCanonFact(
  projectId: string,
  factId: string,
  input: {
    reason: string;
    confirmLockedWithdrawal: boolean;
  },
): Promise<{
  factId: string;
  projectId: string;
  reason: string;
  withdrawnAt: string;
}> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/facts/${encodeURIComponent(factId)}/withdraw`,
    jsonRequest("POST", input),
  );
}

export async function createRelationshipEvent(
  projectId: string,
  input: Omit<RelationshipEvent, "id" | "projectId" | "createdAt">,
): Promise<RelationshipEvent> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/relationships`,
    jsonRequest("POST", input),
  );
}

export function removeRelationshipEvent(
  projectId: string,
  relationship: RelationshipEvent,
) {
  return removeStoryResource(
    `/api/projects/${encodeURIComponent(projectId)}/relationships/${encodeURIComponent(relationship.id)}`,
    relationship.createdAt,
  );
}

export async function createTimelineEvent(
  projectId: string,
  input: Omit<TimelineEvent, "id" | "projectId" | "createdAt" | "updatedAt">,
): Promise<TimelineEvent> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/timeline`,
    jsonRequest("POST", input),
  );
}

export async function updateTimelineEvent(
  projectId: string,
  eventId: string,
  input: Omit<TimelineEvent, "id" | "projectId" | "createdAt" | "updatedAt"> & {
    expectedUpdatedAt: string;
  },
): Promise<TimelineEvent> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/timeline/${encodeURIComponent(eventId)}`,
    jsonRequest("PUT", input),
  );
}

export function removeTimelineEvent(projectId: string, event: TimelineEvent) {
  return removeStoryResource(
    `/api/projects/${encodeURIComponent(projectId)}/timeline/${encodeURIComponent(event.id)}`,
    event.updatedAt,
  );
}

export async function createForeshadow(
  projectId: string,
  input: Omit<Foreshadow, "id" | "projectId" | "createdAt" | "updatedAt">,
): Promise<Foreshadow> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/foreshadows`,
    jsonRequest("POST", input),
  );
}

export async function updateForeshadow(
  projectId: string,
  foreshadowId: string,
  input: Omit<Foreshadow, "id" | "projectId" | "createdAt" | "updatedAt"> & {
    expectedUpdatedAt: string;
  },
): Promise<Foreshadow> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/foreshadows/${encodeURIComponent(foreshadowId)}`,
    jsonRequest("PUT", input),
  );
}

export function removeForeshadow(projectId: string, item: Foreshadow) {
  return removeStoryResource(
    `/api/projects/${encodeURIComponent(projectId)}/foreshadows/${encodeURIComponent(item.id)}`,
    item.updatedAt,
  );
}

export async function previewContext(
  projectId: string,
  input: {
    task: string;
    query: string;
    entityIds: string[];
    currentOutlineNodeId: string | null;
    access: { audience: "author"; includeCandidates: boolean };
  },
): Promise<ContextPreview> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/context/preview`,
    jsonRequest("POST", { purpose: "studio-preview", ...input }),
  );
}

/* ==========================================================================
   运行
   ========================================================================== */

export async function createChapterRun(
  projectId: string,
  input: {
    /** 同一次提交的幂等键；网络重试复用同一个 requestId，重新提交才换新。 */
    requestId: string;
    targetOutlineNodeId: string;
    planningMode?: "auto" | "confirm";
    origin?: RunOriginInput | null;
    maxRevisionCycles: number;
    /** 稀疏覆盖：只包含用户显式改过的字段。 */
    policy?: ModelExecutionPolicy;
  },
): Promise<ChapterRunCreatedDto> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/runs/chapter`,
    jsonRequest("POST", input),
  );
}

export async function getProjectRuns(
  projectId: string,
  signal?: AbortSignal,
): Promise<NarrativeRun[]> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/runs`,
    signal ? { signal } : {},
  );
}

export async function getRunDetail(
  projectId: string,
  runId: string,
  signal?: AbortSignal,
): Promise<RunDetail> {
  return requestJson(
    `/api/runs/${encodeURIComponent(runId)}?projectId=${encodeURIComponent(projectId)}`,
    signal ? { signal } : {},
  );
}

export async function controlRun(
  projectId: string,
  runId: string,
  action: RunActionRequest,
): Promise<RunSnapshot> {
  return requestJson(
    `/api/runs/${encodeURIComponent(runId)}/actions`,
    jsonRequest("POST", { ...action, projectId }),
  );
}

export async function advanceRun(
  projectId: string,
  runId: string,
): Promise<{
  processed: boolean;
  snapshot: RunSnapshot;
}> {
  return requestJson(
    `/api/runs/${encodeURIComponent(runId)}/advance`,
    jsonRequest("POST", { projectId }),
  );
}

export async function discardRunStream(
  projectId: string,
  runId: string,
  stepId: string,
  attempt: number,
): Promise<{ discarded: boolean }> {
  return requestJson(
    `/api/runs/${encodeURIComponent(runId)}/streams/discard`,
    jsonRequest("POST", { projectId, stepId, attempt }),
  );
}

/** 以 partial 为前缀创建续写运行（202；runId 幂等）。 */
export async function continueRunStream(
  projectId: string,
  runId: string,
  input: Omit<ContinueRunStreamRequest, "projectId">,
): Promise<ChapterRunCreatedDto> {
  return requestJson(
    `/api/runs/${encodeURIComponent(runId)}/streams/continue`,
    jsonRequest("POST", { ...input, projectId }),
  );
}

/** 把 partial 追加进章节文档的不可变版本链（重复调用幂等回放）。 */
export async function adoptRunStream(
  projectId: string,
  runId: string,
  input: Omit<ContinueRunStreamRequest, "projectId">,
): Promise<AdoptRunStreamResponse> {
  return requestJson(
    `/api/runs/${encodeURIComponent(runId)}/streams/adopt`,
    jsonRequest("POST", { ...input, projectId }),
  );
}

/** 丢弃 partial 并推动 harness 重试来源步骤。 */
export async function regenerateRunStream(
  projectId: string,
  runId: string,
  input: Omit<ContinueRunStreamRequest, "projectId">,
): Promise<RegenerateRunStreamResponse> {
  return requestJson(
    `/api/runs/${encodeURIComponent(runId)}/streams/regenerate`,
    jsonRequest("POST", { ...input, projectId }),
  );
}

/* ==========================================================================
   审稿
   ========================================================================== */

export async function getReviewWorkspace(
  projectId: string,
  signal?: AbortSignal,
): Promise<ReviewWorkspace> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/reviews`,
    signal ? { signal } : {},
  );
}

export async function createDocumentReview(
  projectId: string,
  documentId: string,
  input: {
    requestId: string;
    documentVersionId: string;
    origin?: RunOriginInput | null;
    policy?: ModelExecutionPolicy;
  },
): Promise<DocumentReviewRunCreatedDto> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(documentId)}/reviews`,
    jsonRequest("POST", input),
  );
}

export async function decideReviewIssue(
  projectId: string,
  issueId: string,
  input: {
    action: ReviewIssueDecisionAction;
    note: string | null;
    expectedStatus: ReviewIssueStatus;
  },
): Promise<{
  id: string;
  issueId: string;
  action: ReviewIssueDecisionAction;
  note: string | null;
  priorStatus: ReviewIssueStatus;
  resultingStatus: ReviewIssueStatus;
  createdAt: string;
}> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/review-issues/${encodeURIComponent(issueId)}/decisions`,
    jsonRequest("POST", {
      ...input,
      requestId: `${issueId}:${input.action}`,
    }),
  );
}

/** 修订提案裁定：apply 把 revisedContent 落成文档新版本，reject 仅记决策。 */
export async function decideRevisionProposal(
  projectId: string,
  proposalId: string,
  action: "apply" | "reject",
): Promise<{ proposal: ReviewRevisionProposal }> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/revision-proposals/${encodeURIComponent(proposalId)}/decisions`,
    jsonRequest("POST", {
      action,
      requestId: `${proposalId}:${action}`,
    }),
  );
}

export interface CanonChangeSetView {
  id: string;
  projectId: string;
  runId: string;
  stepId: string;
  changes: Record<string, unknown>;
  status: "candidate" | "partially_applied" | "applied" | "rejected";
  createdAt: string;
  decidedAt: string | null;
}

export async function getCanonChangeSets(
  projectId: string,
  signal?: AbortSignal,
): Promise<CanonChangeSetView[]> {
  const response = (await requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/canon-change-sets`,
    signal ? { signal } : {},
  )) as { changeSets: CanonChangeSetView[] };
  return response.changeSets;
}

/** 故事变化裁定：整组 apply（可显式 force）或整组 reject。 */
export async function decideCanonChangeSet(
  projectId: string,
  changeSetId: string,
  input: {
    action: "apply" | "reject";
    expectedStatus?: "candidate";
    conflictPolicy?: "reject" | "force";
  },
): Promise<{ changeSet: CanonChangeSetView }> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/canon-change-sets/${encodeURIComponent(changeSetId)}/decisions`,
    jsonRequest("POST", {
      ...input,
      requestId: `${changeSetId}:${input.action}:${input.conflictPolicy ?? "reject"}`,
    }),
  );
}

/* ==========================================================================
   建书（foundation）/ 自动驾驶
   ========================================================================== */

export async function generateFoundation(
  projectId: string,
  input: {
    requestId: string;
    braindump: string;
    /** 稀疏覆盖；qualityPreset 在这里选择。 */
    policy?: ModelExecutionPolicy;
    preferences: {
      genre: string | null;
      audience: string | null;
      tone: string | null;
      targetChapters: number;
      wordsPerChapter: number;
      volumes: number;
    };
  },
): Promise<BackgroundRunCreated> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/foundation/generate`,
    jsonRequest("POST", input),
  );
}

/** AI 引导建书：一次请求同时立项并发起 foundation 后台任务（202，幂等）。 */
export async function createProjectWithFoundation(input: {
  requestId: string;
  title: string;
  subtitle?: string | null;
  premise?: string | null;
  language?: string;
  braindump: string;
  policy?: ModelExecutionPolicy;
  preferences?: {
    genre: string | null;
    audience: string | null;
    tone: string | null;
    targetChapters: number;
    wordsPerChapter: number;
    volumes: number;
  };
}): Promise<ProjectFoundationTaskCreated> {
  return requestJson("/api/projects/with-foundation", jsonRequest("POST", input));
}

/** 项目概览：进度、当前章节、活动任务、待办计数与下一步。 */
export async function getProjectOverview(
  projectId: string,
  signal?: AbortSignal,
): Promise<ProjectOverview> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/overview`,
    signal ? { signal } : {},
  );
}

export async function getFoundationCandidates(
  projectId: string,
  signal?: AbortSignal,
): Promise<FoundationCandidateSet[]> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/foundation/candidates`,
    signal ? { signal } : {},
  );
}

export async function resolveFoundationCandidate(
  candidateId: string,
  action: "adopt" | "discard",
  payload?: Record<string, unknown>,
): Promise<FoundationCandidate> {
  return requestJson(
    `/api/candidates/${encodeURIComponent(candidateId)}/actions`,
    jsonRequest("POST", { action, ...(payload ? { payload } : {}) }),
  );
}

export async function resolveFoundationCandidateSet(
  setId: string,
  action: "adopt-all" | "discard-all",
): Promise<FoundationCandidateSet> {
  return requestJson(
    `/api/candidate-sets/${encodeURIComponent(setId)}/actions`,
    jsonRequest("POST", { action }),
  );
}

export async function getStoryCompass(
  projectId: string,
  signal?: AbortSignal,
): Promise<StoryCompass | null> {
  try {
    return await requestJson(
      `/api/projects/${encodeURIComponent(projectId)}/compass`,
      signal ? { signal } : {},
    );
  } catch (error) {
    if (error instanceof ApiError && error.code === "story_compass.not_found") {
      return null;
    }
    throw error;
  }
}

export async function updateStoryCompass(
  projectId: string,
  input: Omit<StoryCompass, "projectId" | "version" | "updatedAt"> & {
    expectedVersion: number | null;
  },
): Promise<StoryCompass> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/compass`,
    jsonRequest("PUT", input),
  );
}

export async function createAutopilotSession(
  projectId: string,
  input: {
    /** 同一次提交的幂等键；网络重试复用同一个 requestId，重新提交才换新。 */
    requestId: string;
    /** continuous = 多章连续生产（AI 快速创作）；per_chapter = 逐章验收。 */
    approvalMode?: "continuous" | "per_chapter";
    planningMode?: "auto" | "confirm";
    origin?: RunOriginInput | null;
    targetChapters: number;
    windowSize: number;
    maxRevisionCycles: number;
    /** 稀疏覆盖。 */
    chapterPolicy?: ModelExecutionPolicy;
  },
): Promise<AutopilotSession & { idempotentReplay: boolean }> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/autopilot/sessions`,
    jsonRequest("POST", input),
  );
}

export async function getAutopilotSessions(
  projectId: string,
  signal?: AbortSignal,
): Promise<AutopilotSession[]> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/autopilot/sessions`,
    signal ? { signal } : {},
  );
}

export async function getAutopilotSession(
  sessionId: string,
  signal?: AbortSignal,
): Promise<AutopilotSessionDetail> {
  return requestJson(
    `/api/autopilot/sessions/${encodeURIComponent(sessionId)}`,
    signal ? { signal } : {},
  );
}

export async function controlAutopilotSession(
  sessionId: string,
  action: SessionActionRequest,
): Promise<AutopilotSessionDetail> {
  return requestJson(
    `/api/autopilot/sessions/${encodeURIComponent(sessionId)}/actions`,
    jsonRequest("POST", action),
  );
}

export async function resolveAutopilotFailure(
  sessionId: string,
  action: "retry-current" | "skip-chapter" | "replan" | "stop",
): Promise<AutopilotSessionDetail> {
  return requestJson(
    `/api/autopilot/sessions/${encodeURIComponent(sessionId)}/resolutions`,
    jsonRequest("POST", { action }),
  );
}

export async function sendStorySteer(
  sessionId: string,
  input: { requestId: string; content: string },
): Promise<StorySteer> {
  return requestJson(
    `/api/autopilot/sessions/${encodeURIComponent(sessionId)}/steers`,
    jsonRequest("POST", input),
  );
}

export async function decideStorySteer(
  sessionId: string,
  steerId: string,
  action: "apply" | "reject",
): Promise<{ steer: StorySteer; detail: AutopilotSessionDetail }> {
  return requestJson(
    `/api/autopilot/sessions/${encodeURIComponent(sessionId)}/steers/${encodeURIComponent(steerId)}/decisions`,
    jsonRequest("POST", { action }),
  );
}

export async function advanceAutopilotSession(
  sessionId: string,
): Promise<{ processed: boolean; detail: AutopilotSessionDetail }> {
  return requestJson(
    `/api/autopilot/sessions/${encodeURIComponent(sessionId)}/advance`,
    jsonRequest("POST", {}),
  );
}

/* ==========================================================================
   写作台：人物 / 故事房 / 稿件
   ========================================================================== */

export async function getPersonas(
  projectId: string,
  signal?: AbortSignal,
): Promise<StoryPersona[]> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/personas`,
    signal ? { signal } : {},
  );
}

export async function createPersona(
  projectId: string,
  input: Pick<
    StoryPersona,
    "kind" | "entityId" | "name" | "description" | "instructions" | "voice"
  >,
): Promise<StoryPersona> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/personas`,
    jsonRequest("POST", input),
  );
}

export async function updatePersona(
  personaId: string,
  input: Pick<
    StoryPersona,
    | "kind"
    | "entityId"
    | "name"
    | "description"
    | "instructions"
    | "voice"
    | "status"
  > & { expectedVersion: number },
): Promise<StoryPersona> {
  return requestJson(
    `/api/personas/${encodeURIComponent(personaId)}`,
    jsonRequest("PUT", input),
  );
}

export async function getCoCreateSessions(
  projectId: string,
  signal?: AbortSignal,
): Promise<CoCreateSession[]> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/cocreate/sessions`,
    signal ? { signal } : {},
  );
}

export async function createCoCreateSession(
  projectId: string,
  input: {
    title: string;
    speakerPolicy: CoCreateSession["speakerPolicy"];
    targetOutlineNodeId: string | null;
    authorPersonaId: string | null;
    directorNote: string | null;
    contextTurns: number;
    participantIds: string[];
  },
): Promise<CoCreateSessionDetail> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/cocreate/sessions`,
    jsonRequest("POST", input),
  );
}

export async function getCoCreateSession(
  sessionId: string,
  signal?: AbortSignal,
): Promise<CoCreateSessionDetail> {
  return requestJson(
    `/api/cocreate/sessions/${encodeURIComponent(sessionId)}`,
    signal ? { signal } : {},
  );
}

export async function updateCoCreateSession(
  sessionId: string,
  input: Partial<
    Pick<
      CoCreateSession,
      | "title"
      | "status"
      | "speakerPolicy"
      | "targetOutlineNodeId"
      | "authorPersonaId"
      | "directorNote"
      | "contextTurns"
    >
  > & { expectedVersion: number },
): Promise<CoCreateSession> {
  return requestJson(
    `/api/cocreate/sessions/${encodeURIComponent(sessionId)}`,
    jsonRequest("PUT", input),
  );
}

export async function replaceCoCreateParticipants(
  sessionId: string,
  expectedVersion: number,
  participants: {
    personaId: string;
    enabled: boolean;
    talkativeness: number;
  }[],
): Promise<CoCreateSessionDetail> {
  return requestJson(
    `/api/cocreate/sessions/${encodeURIComponent(sessionId)}/participants`,
    jsonRequest("PUT", { expectedVersion, participants }),
  );
}

export async function postStoryTurn(
  sessionId: string,
  input: {
    requestId: string;
    role: "user" | "director";
    personaId: string | null;
    content: string;
    generateReply: boolean;
    speakerPersonaId: string | null;
  },
): Promise<{ turn: StoryTurn; run: NarrativeRun | null }> {
  return requestJson(
    `/api/cocreate/sessions/${encodeURIComponent(sessionId)}/turns`,
    jsonRequest("POST", input),
  );
}

export async function generateTurnSwipe(
  turnId: string,
  requestId: string,
  speakerPersonaId: string | null,
): Promise<RunSnapshot> {
  return requestJson(
    `/api/turns/${encodeURIComponent(turnId)}/swipes`,
    jsonRequest("POST", { requestId, speakerPersonaId }),
  );
}

export async function selectTurnSwipe(
  turnId: string,
  swipeId: string,
): Promise<StoryTurn> {
  return requestJson(
    `/api/turns/${encodeURIComponent(turnId)}/swipe-selection`,
    jsonRequest("POST", { swipeId }),
  );
}

export async function revertStoryTurn(
  turnId: string,
): Promise<CoCreateSessionDetail> {
  return requestJson(
    `/api/turns/${encodeURIComponent(turnId)}/actions`,
    jsonRequest("POST", { action: "revert" }),
  );
}

export async function createStoryBranch(
  sessionId: string,
  fromTurnId: string,
  name: string,
  expectedVersion: number,
): Promise<StoryBranch> {
  return requestJson(
    `/api/cocreate/sessions/${encodeURIComponent(sessionId)}/branches`,
    jsonRequest("POST", { fromTurnId, name, expectedVersion }),
  );
}

export async function selectStoryBranch(
  sessionId: string,
  branchId: string,
  expectedVersion: number,
): Promise<CoCreateSessionDetail> {
  return requestJson(
    `/api/cocreate/sessions/${encodeURIComponent(sessionId)}/branch-selection`,
    jsonRequest("POST", { branchId, expectedVersion }),
  );
}

export async function adoptStoryRange(
  sessionId: string,
  input: {
    requestId: string;
    branchId: string;
    fromTurnId: string;
    toTurnId: string;
    title: string;
  },
): Promise<RunSnapshot> {
  return requestJson(
    `/api/cocreate/sessions/${encodeURIComponent(sessionId)}/adoptions`,
    jsonRequest("POST", input),
  );
}

export async function getStudioDocuments(
  projectId: string,
  signal?: AbortSignal,
  includeArchived = false,
): Promise<StoryDocument[]> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/studio/documents${includeArchived ? "?includeArchived=true" : ""}`,
    signal ? { signal } : {},
  );
}

export async function setStoryDocumentArchived(
  document: StoryDocument,
  archived: boolean,
): Promise<StoryDocument> {
  return requestJson(
    `/api/projects/${encodeURIComponent(document.projectId)}/studio/documents/${encodeURIComponent(document.id)}/archive`,
    jsonRequest("PUT", {
      archived,
      expectedUpdatedAt: document.updatedAt,
    }),
  );
}

export async function createStoryDocument(
  projectId: string,
  input: {
    requestId: string;
    kind: StoryDocument["kind"];
    title: string;
    outlineNodeId: string | null;
  },
): Promise<StoryDocument> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/documents`,
    jsonRequest("POST", input),
  );
}

export async function getStudioDocument(
  projectId: string,
  documentId: string,
  signal?: AbortSignal,
): Promise<StudioDocumentDetail> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/studio/documents/${encodeURIComponent(documentId)}`,
    signal ? { signal } : {},
  );
}

export async function appendDocumentVersion(
  projectId: string,
  documentId: string,
  input: {
    content: string;
    source: string;
    expectedCurrentVersionId: string | null;
  },
): Promise<DocumentVersion> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(documentId)}/versions`,
    jsonRequest("POST", input),
  );
}

export async function saveDocumentDraft(
  projectId: string,
  documentId: string,
  input: {
    content: string;
    baseVersionId: string | null;
    expectedDraftUpdatedAt: string | null;
  },
): Promise<DocumentDraft | null> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/studio/documents/${encodeURIComponent(documentId)}/draft`,
    jsonRequest("PUT", input),
  );
}

export async function restoreDocumentVersion(
  projectId: string,
  documentId: string,
  targetVersionId: string,
  expectedCurrentVersionId: string | null,
): Promise<DocumentVersion> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(documentId)}/restore`,
    jsonRequest("POST", { targetVersionId, expectedCurrentVersionId }),
  );
}

export async function createDocumentComment(
  projectId: string,
  documentId: string,
  input: {
    versionId: string;
    startOffset: number;
    endOffset: number;
    quote: string;
    body: string;
  },
): Promise<DocumentComment> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/studio/documents/${encodeURIComponent(documentId)}/comments`,
    jsonRequest("POST", input),
  );
}

export async function setDocumentCommentStatus(
  commentId: string,
  status: DocumentComment["status"],
): Promise<DocumentComment> {
  return requestJson(
    `/api/studio/comments/${encodeURIComponent(commentId)}`,
    jsonRequest("PUT", { status }),
  );
}

export async function createSelectionEdit(
  projectId: string,
  documentId: string,
  input: {
    baseVersionId: string;
    draftContentHash: string | null;
    selectionStart: number;
    selectionEnd: number;
    instruction: string;
    /** 稀疏覆盖；模型由服务端 assignment 解析。 */
    policy?: ModelExecutionPolicy;
  },
): Promise<RunSnapshot> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/studio/documents/${encodeURIComponent(documentId)}/selection-edits`,
    jsonRequest("POST", input),
  );
}

export async function decideEditProposal(
  proposalId: string,
  action: "accept" | "reject",
): Promise<EditProposal> {
  return requestJson(
    `/api/studio/edit-proposals/${encodeURIComponent(proposalId)}/actions`,
    jsonRequest("POST", {
      action,
      requestId: `${proposalId}:${action}`,
    }),
  );
}

/* ==========================================================================
   风格 / 写作 Skill
   ========================================================================== */

export async function getStyleProfiles(
  projectId: string,
  signal?: AbortSignal,
): Promise<StyleProfile[]> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/styles`,
    signal ? { signal } : {},
  );
}

export async function createStyleProfile(
  projectId: string,
  input: Pick<
    StyleProfile,
    "name" | "description" | "rules" | "examples" | "negativeRules" | "active"
  >,
): Promise<StyleProfile> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/styles`,
    jsonRequest("POST", input),
  );
}

export async function updateStyleProfile(
  profile: StyleProfile,
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
): Promise<StyleProfile> {
  const next = { ...profile, ...patch };
  return requestJson(
    `/api/styles/${encodeURIComponent(profile.id)}`,
    jsonRequest("PUT", {
      name: next.name,
      description: next.description,
      rules: next.rules,
      examples: next.examples,
      negativeRules: next.negativeRules,
      active: next.active,
      status: next.status,
      expectedVersion: profile.version,
    }),
  );
}

export async function getWritingSkills(
  projectId: string,
  signal?: AbortSignal,
): Promise<WritingSkill[]> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/writing-skills`,
    signal ? { signal } : {},
  );
}

export async function createWritingSkill(
  projectId: string,
  input: Pick<
    WritingSkill,
    "name" | "description" | "instructions" | "scopes" | "priority" | "enabled"
  >,
): Promise<WritingSkill> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/writing-skills`,
    jsonRequest("POST", input),
  );
}

export async function updateWritingSkill(
  skill: WritingSkill,
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
): Promise<WritingSkill> {
  const next = { ...skill, ...patch };
  return requestJson(
    `/api/writing-skills/${encodeURIComponent(skill.id)}`,
    jsonRequest("PUT", {
      name: next.name,
      description: next.description,
      instructions: next.instructions,
      scopes: next.scopes,
      priority: next.priority,
      enabled: next.enabled,
      expectedVersion: skill.version,
    }),
  );
}

export async function deleteWritingSkill(skillId: string): Promise<void> {
  return requestVoid(
    `/api/writing-skills/${encodeURIComponent(skillId)}`,
    jsonRequest("DELETE", {}),
  );
}

export async function importWritingSkillPackage(
  projectId: string,
  input: { filename: string; contentBase64: string },
): Promise<{
  skill: WritingSkill;
  references: {
    id: string;
    skillId: string;
    path: string;
    content: string;
    contentHash: string;
    createdAt: string;
  }[];
}> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/writing-skills/import`,
    jsonRequest("POST", input),
  );
}

export async function validateWritingSkill(
  skillId: string,
  scope: WritingSkillScope,
): Promise<WritingSkillValidation> {
  return requestJson(
    `/api/writing-skills/${encodeURIComponent(skillId)}/validate`,
    jsonRequest("POST", { scope }),
  );
}

export async function getWritingSkillPackage(
  skillId: string,
): Promise<{ blob: Blob; filename: string }> {
  const { blob, filename } = await requestBlob(
    `/api/writing-skills/${encodeURIComponent(skillId)}/package`,
  );
  return { blob, filename: filename ?? "writing-skill.skill.zip" };
}

/** 下载我的库（D6）：浏览器本地内核导出完整 SQLite 字节。 */
export async function downloadLibraryDatabase(): Promise<{
  blob: Blob;
  filename: string | null;
}> {
  return requestBlob("/api/system/database-download");
}

/* ==========================================================================
   Agent Skill 导入（R9）：受约束的项目级助手技能，只读 + 候选型能力白名单
   ========================================================================== */

export async function getAgentSkills(
  projectId: string,
  signal?: AbortSignal,
): Promise<ImportedAgentSkillDto[]> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/agent-skills`,
    signal ? { signal } : {},
  );
}

export async function importAgentSkillPackage(
  projectId: string,
  input: { filename: string; contentBase64: string },
): Promise<ImportedAgentSkillDto> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/agent-skills/import`,
    jsonRequest("POST", input),
  );
}

export async function setAgentSkillEnabled(
  skill: ImportedAgentSkillDto,
  enabled: boolean,
): Promise<ImportedAgentSkillDto> {
  return requestJson(
    `/api/agent-skills/${encodeURIComponent(skill.id)}/enabled`,
    jsonRequest("POST", { enabled, expectedUpdatedAt: skill.updatedAt }),
  );
}

export async function deleteAgentSkill(skillId: string): Promise<void> {
  return requestVoid(
    `/api/agent-skills/${encodeURIComponent(skillId)}`,
    { method: "DELETE" },
  );
}

/* ==========================================================================
   旧稿导入 / 交付 / 备份
   ========================================================================== */

export async function previewStoryImport(input: {
  targetProjectId: string | null;
  filename: string;
  format: ImportFormat;
  contentBase64: string;
}): Promise<ImportBatchDetail> {
  return requestJson("/api/imports/preview", jsonRequest("POST", input));
}

export async function uploadStoryFile(
  file: File,
  targetProjectId: string | null,
  format: ImportFormat,
  onProgress?: (receivedBytes: number, totalBytes: number) => void,
): Promise<ImportBatchDetail> {
  const chunkSize = 2 * 1024 * 1024;
  if (file.size <= chunkSize) {
    const contentBase64 = bytesToBase64(
      new Uint8Array(await file.arrayBuffer()),
    );
    onProgress?.(file.size, file.size);
    return previewStoryImport({
      targetProjectId,
      filename: file.name,
      format,
      contentBase64,
    });
  }
  const session = await requestJson<ImportUploadSession>(
    "/api/import-uploads",
    jsonRequest("POST", {
      targetProjectId,
      filename: file.name,
      format,
      totalBytes: file.size,
      chunkSize,
      expectedHash: null,
    }),
  );
  for (
    let offset = 0, index = 0;
    offset < file.size;
    offset += chunkSize, index += 1
  ) {
    const bytes = new Uint8Array(
      await file
        .slice(offset, Math.min(file.size, offset + chunkSize))
        .arrayBuffer(),
    );
    const chunkHash = await sha256(bytes);
    await requestJson<ImportUploadSession>(
      `/api/import-uploads/${encodeURIComponent(session.id)}/chunks/${index}`,
      jsonRequest("PUT", {
        contentBase64: bytesToBase64(bytes),
        chunkHash,
      }),
    );
    onProgress?.(Math.min(file.size, offset + bytes.byteLength), file.size);
  }
  const result = await requestJson<{
    session: ImportUploadSession;
    detail: ImportBatchDetail;
  }>(
    `/api/import-uploads/${encodeURIComponent(session.id)}/complete`,
    jsonRequest("POST", {}),
  );
  return result.detail;
}

export async function getStoryImport(
  batchId: string,
  signal?: AbortSignal,
): Promise<ImportBatchDetail> {
  return requestJson(
    `/api/imports/${encodeURIComponent(batchId)}`,
    signal ? { signal } : {},
  );
}

export async function getStoryImports(
  projectId: string,
  signal?: AbortSignal,
): Promise<ImportBatch[]> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/imports`,
    signal ? { signal } : {},
  );
}

export async function decideImportCandidate(
  candidateId: string,
  status: "selected" | "discarded",
): Promise<ImportBatchDetail> {
  return requestJson(
    `/api/import-candidates/${encodeURIComponent(candidateId)}`,
    jsonRequest("PUT", { status }),
  );
}

export async function analyzeStoryImport(
  batchId: string,
  requestId: string,
  policy?: ModelExecutionPolicy,
): Promise<RunSnapshot> {
  return requestJson(
    `/api/imports/${encodeURIComponent(batchId)}/analyze`,
    jsonRequest("POST", { requestId, ...(policy ? { policy } : {}) }),
  );
}

export async function applyStoryImport(
  batchId: string,
  selectedCandidateIds: string[],
): Promise<{ projectId: string; detail: ImportBatchDetail }> {
  return requestJson(
    `/api/imports/${encodeURIComponent(batchId)}/actions`,
    jsonRequest("POST", { action: "apply", selectedCandidateIds }),
  );
}

export async function discardStoryImport(
  batchId: string,
): Promise<ImportBatchDetail> {
  return requestJson(
    `/api/imports/${encodeURIComponent(batchId)}/actions`,
    jsonRequest("POST", { action: "discard", selectedCandidateIds: [] }),
  );
}

export async function getProjectQuality(
  projectId: string,
  signal?: AbortSignal,
): Promise<ProjectQualityReport> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/quality`,
    signal ? { signal } : {},
  );
}

export async function getProjectBackups(
  projectId: string,
  signal?: AbortSignal,
): Promise<ProjectBackup[]> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/backups`,
    signal ? { signal } : {},
  );
}

export async function createProjectBackup(
  projectId: string,
  label: string,
): Promise<ProjectBackup> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/backups`,
    jsonRequest("POST", { label }),
  );
}

export async function restoreProjectBackup(
  backupId: string,
  requestId: string,
): Promise<{
  projectId: string;
  backup: ProjectBackup;
  counts: BundleCounts;
}> {
  return requestJson(
    `/api/backups/${encodeURIComponent(backupId)}/restore`,
    jsonRequest("POST", { requestId }),
  );
}

export async function getProjectExport(
  projectId: string,
  format: ExportFormat,
  options: {
    versionMode: "current" | "history";
    includeAnnotations: boolean;
    includeRuns: boolean;
  } = {
    versionMode: "current",
    includeAnnotations: false,
    includeRuns: false,
  },
): Promise<{ blob: Blob; filename: string }> {
  const query = new URLSearchParams({
    versionMode: options.versionMode,
    includeAnnotations: String(options.includeAnnotations),
    includeRuns: String(options.includeRuns),
  });
  const { blob, filename } = await requestBlob(
    `/api/projects/${encodeURIComponent(projectId)}/exports/${encodeURIComponent(format)}?${query}`,
  );
  return { blob, filename: filename ?? `novel.${format}` };
}

export async function getSystemBackups(
  signal?: AbortSignal,
): Promise<SystemBackupManifest[]> {
  return requestJson("/api/system/backups", signal ? { signal } : {});
}

export async function createSystemBackup(
  label: string,
): Promise<SystemBackupManifest> {
  return requestJson("/api/system/backups", jsonRequest("POST", { label }));
}

export async function previewSystemBackup(
  backupId: string,
): Promise<SystemBackupPreview> {
  return requestJson(
    `/api/system/backups/${encodeURIComponent(backupId)}/preview`,
    {},
  );
}

export async function restoreSystemBackup(
  backupId: string,
  targetDirectory: string,
  overwrite = false,
): Promise<{
  targetDirectory: string;
  databasePath: string;
  sha256: string;
  migration: number;
  counts: SystemBackupPreview["counts"];
}> {
  return requestJson(
    `/api/system/backups/${encodeURIComponent(backupId)}/restore`,
    jsonRequest("POST", { targetDirectory, overwrite }),
  );
}

/* ==========================================================================
   长篇推演：检索 / 记忆 / 预测 / Dry-run
   ========================================================================== */

export async function searchProjectMemory(
  projectId: string,
  input: {
    query: string;
    entityIds?: string[];
    limit?: number;
    rerank?: boolean;
  },
): Promise<RetrievalHit[]> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/retrieval/search`,
    jsonRequest("POST", input),
  );
}

export async function getNarrativeMemories(
  projectId: string,
  includeStale = false,
  signal?: AbortSignal,
): Promise<NarrativeMemory[]> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/memories?includeStale=${includeStale}`,
    signal ? { signal } : {},
  );
}

export async function rebuildNarrativeMemories(
  projectId: string,
): Promise<NarrativeMemory[]> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/memories/rebuild`,
    jsonRequest("POST", {}),
  );
}

export async function consolidateNarrativeMemory(
  projectId: string,
): Promise<NarrativeMemory | null> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/memories/sleep`,
    jsonRequest("POST", {}),
  );
}

export async function getPlotPredictions(
  projectId: string,
  signal?: AbortSignal,
): Promise<PlotPrediction[]> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/predictions`,
    signal ? { signal } : {},
  );
}

export async function generatePlotPredictions(
  projectId: string,
  input: { direction: string; horizon: number; count: number },
): Promise<PlotPrediction[]> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/predictions`,
    jsonRequest("POST", input),
  );
}

export async function decidePlotPrediction(
  projectId: string,
  predictionId: string,
  status: "adopted" | "dismissed",
): Promise<PlotPrediction> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/predictions/${encodeURIComponent(predictionId)}`,
    jsonRequest("PUT", { status }),
  );
}

export async function previewDryRun(
  projectId: string,
  change: string,
): Promise<DryRunResult> {
  return requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/dry-run`,
    jsonRequest("POST", { change }),
  );
}

/* ==========================================================================
   Prompt / Recipe 工坊
   ========================================================================== */

export async function getHarnessTemplates(
  signal?: AbortSignal,
): Promise<HarnessTemplate[]> {
  return requestJson("/api/harness/templates", signal ? { signal } : {});
}

export async function updateHarnessTemplate(
  template: HarnessTemplate,
  content: string,
): Promise<HarnessTemplate> {
  return requestJson(
    `/api/harness/templates/${encodeURIComponent(template.key)}`,
    jsonRequest("PUT", { content, expectedVersion: template.version }),
  );
}

export async function restoreHarnessTemplate(
  template: HarnessTemplate,
): Promise<HarnessTemplate> {
  return requestJson(
    `/api/harness/templates/${encodeURIComponent(template.key)}/restore`,
    jsonRequest("POST", { expectedVersion: template.version }),
  );
}

export async function cloneHarnessTemplate(
  template: HarnessTemplate,
  input: { key: string; name: string },
): Promise<HarnessTemplate> {
  return requestJson(
    `/api/harness/templates/${encodeURIComponent(template.key)}/clone`,
    jsonRequest("POST", input),
  );
}

/* ==========================================================================
   底层请求助手
   ========================================================================== */

function jsonRequest(
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  body: unknown,
): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

/*
 * 底层助手经双驱动传输分发：server 模式相对路径 fetch（原行为），
 * local 模式转成 HTTP 形状送进浏览器内核。所有上层导出函数签名不变。
 */

async function transportRequest(
  input: string,
  init: RequestInit,
): Promise<{ status: number; headers: Record<string, string>; body: unknown }> {
  const mode = await requireResolvedMode();
  if (mode === "local") {
    return kernelRequest({
      method: (init.method ?? "GET") as "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
      path: input,
      body: init.body,
      headers: init.headers as Record<string, string> | undefined,
    });
  }
  const response = await fetch(input, init);
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json")
    ? await response.json().catch(() => null)
    : await response.text().catch(() => "");
  return { status: response.status, headers, body };
}

function transportError(
  status: number,
  body: unknown,
): ApiError {
  const envelope =
    body && typeof body === "object" && "error" in body
      ? (body as { error: Record<string, unknown> }).error
      : null;
  const code =
    envelope && typeof envelope.code === "string"
      ? envelope.code
      : `http.${status}`;
  const message =
    envelope && typeof envelope.message === "string"
      ? envelope.message
      : `请求失败（${status}）`;
  let details: unknown = envelope?.details;
  if (details === undefined && envelope) {
    // 后端有时把附加信息直接放进 error 包（如 fields:string[]），
    // 没有 details 字段时原样保留这些余量键。
    const rest: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(envelope)) {
      if (key !== "code" && key !== "message" && key !== "requestId") {
        rest[key] = value;
      }
    }
    details = Object.keys(rest).length > 0 ? rest : undefined;
  }
  return new ApiError(code, message, status, details);
}

async function requestJson<T>(input: string, init: RequestInit): Promise<T> {
  const response = await transportRequest(input, init);
  if (response.status >= 400)
    throw transportError(response.status, response.body);
  return response.body as T;
}

async function requestVoid(input: string, init: RequestInit): Promise<void> {
  const response = await transportRequest(input, init);
  if (response.status >= 400)
    throw transportError(response.status, response.body);
}

/** 裸二进制下载（导出 / 技能包）：local 模式把内核 Uint8Array 转 Blob。 */
async function requestBlob(
  input: string,
  init: RequestInit = {},
): Promise<{ blob: Blob; filename: string | null; contentType: string | null }> {
  const mode = await requireResolvedMode();
  if (mode === "local") {
    const response = await kernelRequest({
      method: (init.method ?? "GET") as "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
      path: input,
      body: init.body,
      headers: init.headers as Record<string, string> | undefined,
    });
    if (response.status >= 400) {
      throw transportError(
        response.status,
        response.body && typeof response.body === "object" && "error" in response.body
          ? response.body
          : null,
      );
    }
    const disposition = response.headers["content-disposition"] ?? "";
    const encodedName =
      disposition.match(/filename\*=UTF-8''([^;]+)/iu)?.[1] ?? null;
    return {
      blob: new Blob([response.body as BlobPart]),
      filename: encodedName ? decodeURIComponent(encodedName) : null,
      contentType: response.headers["content-type"] ?? null,
    };
  }
  const response = await fetch(input, init);
  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw transportError(response.status, null);
    }
    throw transportError(response.status, body);
  }
  const disposition = response.headers.get("content-disposition") ?? "";
  const encodedName =
    disposition.match(/filename\*=UTF-8''([^;]+)/iu)?.[1] ?? null;
  return {
    blob: await response.blob(),
    filename: encodedName ? decodeURIComponent(encodedName) : null,
    contentType: response.headers.get("content-type"),
  };
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const stride = 32_768;
  for (let offset = 0; offset < bytes.length; offset += stride) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + stride));
  }
  return btoa(binary);
}

async function sha256(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}
