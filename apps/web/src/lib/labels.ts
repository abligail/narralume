import type {
  AssignmentRole,
  AutopilotSession,
  AutopilotSessionDetail,
  CanonEntity,
  CanonFact,
  ExportFormat,
  FoundationCandidate,
  FoundationCandidateSet,
  Foreshadow,
  ModelConfigDto,
  NarrativeRun,
  OutlineNode,
  Project,
  ProjectQualityReport,
  QualityPreset,
  ReviewIssueDecisionAction,
  ReviewRevisionProposal,
  ReviewWorkspaceIssue,
  ReviewWorkspaceReport,
  RunStatus,
  RunStepKind,
  AssistantActivityTextDto,
  StoryDocument,
  StoryPersona,
  WireApi,
  WritingSkillScope,
} from "./api";
import { getLocale, translate, type MessageKey } from "../i18n";

/* ==========================================================================
   集中标签表：状态 / 步骤 / 角色 / 模式的中文名，从各旧视图去重搬入。
   文案已抽取到 i18n 字典 labels 模块，这里只做键到字典的映射。
   ========================================================================== */

/* --- 运行 -------------------------------------------------------------- */

export function runStatusLabel(status: RunStatus, recipe?: string): string {
  const keys: Record<RunStatus, MessageKey> = {
    pending: "labels.runStatus.pending",
    running: "labels.runStatus.running",
    paused: "labels.runStatus.paused",
    awaiting_user: "labels.runStatus.awaitingUser",
    failed_recoverable: "labels.runStatus.failedRecoverable",
    failed: "labels.runStatus.failed",
    cancelled: "labels.runStatus.cancelled",
    completed:
      recipe === "chapter-production"
        ? "labels.runStatus.completedChapter"
        : "labels.runStatus.completed",
  };
  return translate(getLocale(), keys[status]);
}

/** 面向列表的短版运行状态（无 recipe 语境）。 */
export function runStatusShortLabel(status: string): string {
  const keys: Record<string, MessageKey> = {
    pending: "labels.runStatusShort.pending",
    running: "labels.runStatusShort.running",
    paused: "labels.runStatusShort.paused",
    awaiting_user: "labels.runStatusShort.awaitingUser",
    failed_recoverable: "labels.runStatusShort.failedRecoverable",
    failed: "labels.runStatusShort.failed",
    cancelled: "labels.runStatusShort.cancelled",
    completed: "labels.runStatusShort.completed",
  };
  const key: MessageKey | undefined = keys[status];
  return key ? translate(getLocale(), key) : status;
}

export function runStepLabel(kind: RunStepKind): string {
  const keys: Record<RunStepKind, MessageKey> = {
    "context.compile": "labels.runStepKind.contextCompile",
    "scene.plan": "labels.runStepKind.scenePlan",
    "draft.generate": "labels.runStepKind.draftGenerate",
    "deterministic.check": "labels.runStepKind.deterministicCheck",
    "semantic.review": "labels.runStepKind.semanticReview",
    "revision.generate": "labels.runStepKind.revisionGenerate",
    "chapter.settle": "labels.runStepKind.chapterSettle",
    "chapter.commit": "labels.runStepKind.chapterCommit",
    "foundation.generate": "labels.runStepKind.foundationGenerate",
    "foundation.stage": "labels.runStepKind.foundationStage",
    "outline.generate": "labels.runStepKind.outlineGenerate",
    "outline.commit": "labels.runStepKind.outlineCommit",
    "steer.classify": "labels.runStepKind.steerClassify",
    "arc.review": "labels.runStepKind.arcReview",
    "volume.review": "labels.runStepKind.volumeReview",
    "cocreate.context": "labels.runStepKind.cocreateContext",
    "cocreate.respond": "labels.runStepKind.cocreateRespond",
    "cocreate.stage": "labels.runStepKind.cocreateStage",
    "adoption.prepare": "labels.runStepKind.adoptionPrepare",
    "adoption.settle": "labels.runStepKind.adoptionSettle",
    "adoption.commit": "labels.runStepKind.adoptionCommit",
    "edit.transform": "labels.runStepKind.editTransform",
    "edit.stage": "labels.runStepKind.editStage",
    "import.analyze": "labels.runStepKind.importAnalyze",
    "import.stage": "labels.runStepKind.importStage",
    "assistant.context": "labels.runStepKind.assistantContext",
    "assistant.respond": "labels.runStepKind.assistantRespond",
    "assistant.stage": "labels.runStepKind.assistantStage",
    "canon.context": "labels.runStepKind.canonContext",
    "canon.candidate": "labels.runStepKind.canonCandidate",
    "canon.stage": "labels.runStepKind.canonStage",
  };
  return translate(getLocale(), keys[kind]);
}

export function runModeLabel(mode: NarrativeRun["mode"]): string {
  const keys: Record<NarrativeRun["mode"], MessageKey> = {
    autopilot: "labels.runMode.autopilot",
    "chapter-gate": "labels.runMode.chapterGate",
    director: "labels.runMode.director",
    "co-create": "labels.runMode.coCreate",
    manual: "labels.runMode.manual",
  };
  return translate(getLocale(), keys[mode]);
}

export function runVerdictLabel(verdict: "pass" | "revise" | "block"): string {
  const keys: Record<typeof verdict, MessageKey> = {
    pass: "labels.runVerdict.pass",
    revise: "labels.runVerdict.revise",
    block: "labels.runVerdict.block",
  };
  return translate(getLocale(), keys[verdict]);
}

/* --- 模型供给：Provider / Model / Assignment ----------------------------- */

export function wireApiLabel(wireApi: WireApi): string {
  const keys: Record<WireApi, MessageKey> = {
    "openai-chat": "labels.wireApi.openaiChat",
    "openai-responses": "labels.wireApi.openaiResponses",
    "anthropic-messages": "labels.wireApi.anthropicMessages",
  };
  return translate(getLocale(), keys[wireApi]);
}

export function assignmentRoleLabel(role: AssignmentRole): string {
  const keys: Record<AssignmentRole, MessageKey> = {
    writing: "labels.assignmentRole.writing",
    planning: "labels.assignmentRole.planning",
    review: "labels.assignmentRole.review",
    embedding: "labels.assignmentRole.embedding",
    rerank: "labels.assignmentRole.rerank",
  };
  return translate(getLocale(), keys[role]);
}

/** 角色用途与降级规则（与后端语义一致）。 */
export function assignmentRoleHint(role: AssignmentRole): string {
  const keys: Record<AssignmentRole, MessageKey> = {
    writing: "labels.assignmentRoleHint.writing",
    planning: "labels.assignmentRoleHint.planning",
    review: "labels.assignmentRoleHint.review",
    embedding: "labels.assignmentRoleHint.embedding",
    rerank: "labels.assignmentRoleHint.rerank",
  };
  return translate(getLocale(), keys[role]);
}

export function metadataSourceLabel(
  source: ModelConfigDto["metadataSource"],
): string {
  const keys: Record<ModelConfigDto["metadataSource"], MessageKey> = {
    manual: "labels.metadataSource.manual",
    environment: "labels.metadataSource.environment",
    catalog: "labels.metadataSource.catalog",
    migration: "labels.metadataSource.migration",
  };
  return translate(getLocale(), keys[source]);
}

export function qualityPresetLabel(preset: QualityPreset): string {
  const keys: Record<QualityPreset, MessageKey> = {
    fast: "labels.qualityPreset.fast",
    standard: "labels.qualityPreset.standard",
    deep: "labels.qualityPreset.deep",
  };
  return translate(getLocale(), keys[preset]);
}

export function probeStageLabel(
  stage: "text" | "stream" | "tool" | "structured-output",
): string {
  const keys: Record<typeof stage, MessageKey> = {
    text: "labels.probeStage.text",
    stream: "labels.probeStage.stream",
    tool: "labels.probeStage.tool",
    "structured-output": "labels.probeStage.structuredOutput",
  };
  return translate(getLocale(), keys[stage]);
}

export function probeStageStatusLabel(
  status: "passed" | "failed" | "unsupported" | "skipped",
): string {
  const keys: Record<typeof status, MessageKey> = {
    passed: "labels.probeStageStatus.passed",
    failed: "labels.probeStageStatus.failed",
    unsupported: "labels.probeStageStatus.unsupported",
    skipped: "labels.probeStageStatus.skipped",
  };
  return translate(getLocale(), keys[status]);
}

/* --- 故事圣经 ----------------------------------------------------------- */

export function projectPhaseLabel(phase: Project["phase"]): string {
  const keys: Record<Project["phase"], MessageKey> = {
    idea: "labels.projectPhase.idea",
    foundation: "labels.projectPhase.foundation",
    outlining: "labels.projectPhase.outlining",
    writing: "labels.projectPhase.writing",
    revising: "labels.projectPhase.revising",
    complete: "labels.projectPhase.complete",
  };
  return translate(getLocale(), keys[phase]);
}

export function entityTypeLabel(type: CanonEntity["type"]): string {
  const keys: Record<CanonEntity["type"], MessageKey> = {
    character: "labels.entityType.character",
    location: "labels.entityType.location",
    organization: "labels.entityType.organization",
    item: "labels.entityType.item",
    rule: "labels.entityType.rule",
    concept: "labels.entityType.concept",
  };
  return translate(getLocale(), keys[type]);
}

export function outlineKindLabel(kind: OutlineNode["kind"]): string {
  const keys: Record<OutlineNode["kind"], MessageKey> = {
    book: "labels.outlineKind.book",
    volume: "labels.outlineKind.volume",
    arc: "labels.outlineKind.arc",
    chapter: "labels.outlineKind.chapter",
    scene: "labels.outlineKind.scene",
    beat: "labels.outlineKind.beat",
  };
  return translate(getLocale(), keys[kind]);
}

export function outlineStatusLabel(status: OutlineNode["status"]): string {
  const keys: Record<OutlineNode["status"], MessageKey> = {
    planned: "labels.outlineStatus.planned",
    drafting: "labels.outlineStatus.drafting",
    review: "labels.outlineStatus.review",
    committed: "labels.outlineStatus.committed",
    abandoned: "labels.outlineStatus.abandoned",
  };
  return translate(getLocale(), keys[status]);
}

export function factAuthorityLabel(authority: CanonFact["authority"]): string {
  const keys: Record<CanonFact["authority"], MessageKey> = {
    candidate: "labels.factAuthority.candidate",
    inferred: "labels.factAuthority.inferred",
    confirmed: "labels.factAuthority.confirmed",
    locked: "labels.factAuthority.locked",
  };
  return translate(getLocale(), keys[authority]);
}

export function foreshadowStatusLabel(status: Foreshadow["status"]): string {
  const keys: Record<Foreshadow["status"], MessageKey> = {
    planned: "labels.foreshadowStatus.planned",
    planted: "labels.foreshadowStatus.planted",
    developing: "labels.foreshadowStatus.developing",
    resolved: "labels.foreshadowStatus.resolved",
    abandoned: "labels.foreshadowStatus.abandoned",
  };
  return translate(getLocale(), keys[status]);
}

/* --- 自动驾驶 / 建书候选 -------------------------------------------------- */

export function autopilotSessionStatusLabel(
  status: AutopilotSession["status"],
): string {
  const keys: Record<AutopilotSession["status"], MessageKey> = {
    pending: "labels.autopilotSessionStatus.pending",
    planning: "labels.autopilotSessionStatus.planning",
    running: "labels.autopilotSessionStatus.running",
    paused: "labels.autopilotSessionStatus.paused",
    awaiting_user: "labels.autopilotSessionStatus.awaitingUser",
    failed: "labels.autopilotSessionStatus.failed",
    cancelled: "labels.autopilotSessionStatus.cancelled",
    completed: "labels.autopilotSessionStatus.completed",
  };
  return translate(getLocale(), keys[status]);
}

export function autopilotLinkRoleLabel(
  role: AutopilotSessionDetail["links"][number]["role"],
): string {
  const keys: Record<typeof role, MessageKey> = {
    "rolling-plan": "labels.autopilotLinkRole.rollingPlan",
    chapter: "labels.autopilotLinkRole.chapter",
    "closing-review": "labels.autopilotLinkRole.closingReview",
  };
  return translate(getLocale(), keys[role]);
}

export function steerClassificationLabel(
  value: NonNullable<
    AutopilotSessionDetail["steers"][number]["classification"]
  >,
): string {
  const keys: Record<typeof value, MessageKey> = {
    immediate_current: "labels.steerClassification.immediateCurrent",
    next_scene: "labels.steerClassification.nextScene",
    future_plan: "labels.steerClassification.futurePlan",
    canon_change: "labels.steerClassification.canonChange",
    rewrite_existing: "labels.steerClassification.rewriteExisting",
    temporary_director_note: "labels.steerClassification.temporaryDirectorNote",
  };
  return translate(getLocale(), keys[value]);
}

export function steerStatusLabel(
  steer: AutopilotSessionDetail["steers"][number],
): string {
  const locale = getLocale();
  if (steer.status === "awaiting_confirmation")
    return translate(locale, "labels.steerStatus.awaitingConfirmation", {
      classification: steer.classification
        ? steerClassificationLabel(steer.classification)
        : translate(locale, "labels.steerStatus.fallbackChange"),
    });
  if (steer.status === "applied")
    return translate(locale, "labels.steerStatus.applied", {
      classification: steer.classification
        ? steerClassificationLabel(steer.classification)
        : translate(locale, "labels.steerStatus.fallbackInstruction"),
    });
  if (steer.status === "rejected")
    return translate(locale, "labels.steerStatus.rejected");
  if (steer.classification) return steerClassificationLabel(steer.classification);
  if (steer.status === "classifying")
    return translate(locale, "labels.steerStatus.classifying");
  return translate(locale, "labels.steerStatus.pendingClassification");
}

export function foundationCandidateKindLabel(
  kind: FoundationCandidate["kind"],
): string {
  const keys: Record<FoundationCandidate["kind"], MessageKey> = {
    intent: "labels.foundationCandidateKind.intent",
    compass: "labels.foundationCandidateKind.compass",
    entity: "labels.foundationCandidateKind.entity",
  };
  return translate(getLocale(), keys[kind]);
}

export function foundationCandidateStatusLabel(
  status: FoundationCandidate["status"],
): string {
  const keys: Record<FoundationCandidate["status"], MessageKey> = {
    pending: "labels.foundationCandidateStatus.pending",
    adopted: "labels.foundationCandidateStatus.adopted",
    discarded: "labels.foundationCandidateStatus.discarded",
  };
  return translate(getLocale(), keys[status]);
}

export function foundationCandidateSetStatusLabel(
  status: FoundationCandidateSet["set"]["status"],
): string {
  const keys: Record<typeof status, MessageKey> = {
    open: "labels.foundationCandidateSetStatus.open",
    partially_adopted: "labels.foundationCandidateSetStatus.partiallyAdopted",
    adopted: "labels.foundationCandidateSetStatus.adopted",
    discarded: "labels.foundationCandidateSetStatus.discarded",
  };
  return translate(getLocale(), keys[status]);
}

/* --- 审稿室 -------------------------------------------------------------- */

export function reviewCategoryLabel(category: string): string {
  const keys: Record<string, MessageKey> = {
    continuity: "labels.reviewCategory.continuity",
    canon: "labels.reviewCategory.canon",
    pov: "labels.reviewCategory.pov",
    character: "labels.reviewCategory.character",
    agency: "labels.reviewCategory.agency",
    causality: "labels.reviewCategory.causality",
    pacing: "labels.reviewCategory.pacing",
    information: "labels.reviewCategory.information",
    prose: "labels.reviewCategory.prose",
    style: "labels.reviewCategory.style",
    foreshadow: "labels.reviewCategory.foreshadow",
    goal: "labels.reviewCategory.goal",
    safety: "labels.reviewCategory.safety",
  };
  const key: MessageKey | undefined = keys[category];
  return key ? translate(getLocale(), key) : category;
}

export function reviewIssueStatusLabel(issue: ReviewWorkspaceIssue): string {
  if (issue.decision) return reviewIssueActionLabel(issue.decision.action);
  return issue.status === "open"
    ? translate(getLocale(), "labels.reviewIssueStatus.open")
    : issue.status;
}

export function reviewIssueActionLabel(
  action: ReviewIssueDecisionAction,
): string {
  const keys: Record<ReviewIssueDecisionAction, MessageKey> = {
    accept: "labels.reviewIssueAction.accept",
    reject: "labels.reviewIssueAction.reject",
    false_positive: "labels.reviewIssueAction.falsePositive",
    intentional_keep: "labels.reviewIssueAction.intentionalKeep",
  };
  return translate(getLocale(), keys[action]);
}

export function reviewVerdictLabel(
  verdict: ReviewWorkspaceReport["verdict"],
): string {
  const keys: Record<ReviewWorkspaceReport["verdict"], MessageKey> = {
    pass: "labels.reviewVerdict.pass",
    revise: "labels.reviewVerdict.revise",
    block: "labels.reviewVerdict.block",
  };
  return translate(getLocale(), keys[verdict]);
}

export function proposalStatusLabel(
  status: ReviewRevisionProposal["status"],
): string {
  const keys: Record<ReviewRevisionProposal["status"], MessageKey> = {
    proposed: "labels.proposalStatus.proposed",
    accepted: "labels.proposalStatus.accepted",
    rejected: "labels.proposalStatus.rejected",
    superseded: "labels.proposalStatus.superseded",
  };
  return translate(getLocale(), keys[status]);
}

/* --- 交付 / 导入 / 体检 --------------------------------------------------- */

export function qualityReadinessLabel(
  readiness: ProjectQualityReport["readiness"],
): string {
  if (readiness === "blocked")
    return translate(getLocale(), "labels.qualityReadiness.blocked");
  if (readiness === "needs_attention")
    return translate(getLocale(), "labels.qualityReadiness.needsAttention");
  return translate(getLocale(), "labels.qualityReadiness.ready");
}

export function qualitySeverityLabel(
  severity: ProjectQualityReport["issues"][number]["severity"],
): string {
  const keys: Record<
    ProjectQualityReport["issues"][number]["severity"],
    MessageKey
  > = {
    error: "labels.qualitySeverity.error",
    warning: "labels.qualitySeverity.warning",
    info: "labels.qualitySeverity.info",
  };
  return translate(getLocale(), keys[severity]);
}

export function importStatusLabel(status: string): string {
  const keys: Record<string, MessageKey> = {
    previewed: "labels.importStatus.previewed",
    analyzing: "labels.importStatus.analyzing",
    ready: "labels.importStatus.ready",
    applied: "labels.importStatus.applied",
    discarded: "labels.importStatus.discarded",
  };
  const key: MessageKey | undefined = keys[status];
  return key ? translate(getLocale(), key) : status;
}

export function importCandidateKindLabel(kind: string): string {
  const keys: Record<string, MessageKey> = {
    project: "labels.importCandidateKind.project",
    document: "labels.importCandidateKind.document",
    outline: "labels.importCandidateKind.outline",
    intent: "labels.importCandidateKind.intent",
    entity: "labels.importCandidateKind.entity",
    style: "labels.importCandidateKind.style",
    skill: "labels.importCandidateKind.skill",
    relationship: "labels.importCandidateKind.relationship",
    timeline: "labels.importCandidateKind.timeline",
    foreshadow: "labels.importCandidateKind.foreshadow",
    "character-arc": "labels.importCandidateKind.characterArc",
    "scene-analysis": "labels.importCandidateKind.sceneAnalysis",
  };
  const key: MessageKey | undefined = keys[kind];
  return key ? translate(getLocale(), key) : kind;
}

export function writingSkillScopeLabel(scope: WritingSkillScope): string {
  const keys: Record<WritingSkillScope, MessageKey> = {
    all: "labels.writingSkillScope.all",
    chapter: "labels.writingSkillScope.chapter",
    cocreate: "labels.writingSkillScope.cocreate",
    edit: "labels.writingSkillScope.edit",
    review: "labels.writingSkillScope.review",
  };
  return translate(getLocale(), keys[scope]);
}

export function exportFormatLabel(format: ExportFormat): string {
  const keys: Record<ExportFormat, MessageKey> = {
    markdown: "labels.exportFormat.markdown",
    text: "labels.exportFormat.text",
    docx: "labels.exportFormat.docx",
    epub: "labels.exportFormat.epub",
    "narrative-bundle": "labels.exportFormat.narrativeBundle",
  };
  return translate(getLocale(), keys[format]);
}

/* --- 写作台 --------------------------------------------------------------- */

export function documentKindLabel(kind: StoryDocument["kind"]): string {
  const keys: Record<StoryDocument["kind"], MessageKey> = {
    manuscript: "labels.documentKind.manuscript",
    chapter: "labels.documentKind.chapter",
    scene: "labels.documentKind.scene",
    outline: "labels.documentKind.outline",
    synopsis: "labels.documentKind.synopsis",
    note: "labels.documentKind.note",
    "style-sample": "labels.documentKind.styleSample",
  };
  return translate(getLocale(), keys[kind]);
}

export function documentSourceLabel(source: string): string {
  const locale = getLocale();
  if (source.startsWith("restore:"))
    return translate(locale, "labels.documentSource.restore");
  if (source.startsWith("edit-proposal:"))
    return translate(locale, "labels.documentSource.editProposal");
  if (source.startsWith("cocreate:"))
    return translate(locale, "labels.documentSource.cocreate");
  return source === "manual"
    ? translate(locale, "labels.documentSource.manual")
    : source;
}

export function speakerPolicyLabel(
  policy: "manual" | "round_robin" | "auto",
): string {
  const keys: Record<typeof policy, MessageKey> = {
    manual: "labels.speakerPolicy.manual",
    round_robin: "labels.speakerPolicy.roundRobin",
    auto: "labels.speakerPolicy.auto",
  };
  return translate(getLocale(), keys[policy]);
}

export function personaKindLabel(kind: StoryPersona["kind"]): string {
  const keys: Record<StoryPersona["kind"], MessageKey> = {
    author: "labels.personaKind.author",
    narrator: "labels.personaKind.narrator",
    character: "labels.personaKind.character",
  };
  return translate(getLocale(), keys[kind]);
}

/* --- 任务协议（origin / stopReason / availableActions / nextAction） --------- */

/** 后台任务可执行动作的中文名（RunAvailableAction + 航次失败处置）。 */
export function taskActionLabel(action: string): string {
  const keys: Record<string, MessageKey> = {
    pause: "labels.taskAction.pause",
    resume: "labels.taskAction.resume",
    cancel: "labels.taskAction.cancel",
    accept_plan: "labels.taskAction.acceptPlan",
    switch_to_manual: "labels.taskAction.switchToManual",
    accept_manuscript: "labels.taskAction.acceptManuscript",
    request_revision: "labels.taskAction.requestRevision",
    discard_manuscript: "labels.taskAction.discardManuscript",
    use_partial: "labels.taskAction.usePartial",
    regenerate: "labels.taskAction.regenerate",
    retry_chapter: "labels.taskAction.retryChapter",
    "retry-current": "labels.taskAction.retryCurrent",
    "skip-chapter": "labels.taskAction.skipChapter",
    replan: "labels.taskAction.replan",
    stop: "labels.taskAction.stop",
  };
  const key: MessageKey | undefined = keys[action];
  return key ? translate(getLocale(), key) : action;
}

export function taskStatusLabel(status: string): string {
  const keys: Record<string, MessageKey> = {
    pending: "labels.taskStatus.pending",
    planning: "labels.taskStatus.planning",
    running: "labels.taskStatus.running",
    paused: "labels.taskStatus.paused",
    awaiting_user: "labels.taskStatus.awaitingUser",
    failed_recoverable: "labels.taskStatus.failedRecoverable",
    failed: "labels.taskStatus.failed",
    cancelled: "labels.taskStatus.cancelled",
    completed: "labels.taskStatus.completed",
  };
  const key: MessageKey | undefined = keys[status];
  return key ? translate(getLocale(), key) : status;
}

/** 活动任务的种类名（ProjectOverview.activeTask.kind）。 */
export function taskKindLabel(kind: string): string {
  const keys: Record<string, MessageKey> = {
    quick_creation: "labels.taskKind.quickCreation",
    chapter: "labels.taskKind.chapter",
    foundation: "labels.taskKind.foundation",
  };
  const key: MessageKey | undefined = keys[kind];
  return key ? translate(getLocale(), key) : kind;
}

/** 全站唯一的等待/停止原因文案表：服务端各投影只传机器码，
 *  侧栏、概览、快速创作都从这里渲染。 */
export function stopReasonLabel(reason: string): string {
  const keys: Record<string, MessageKey> = {
    chapter_commit_approval_required:
      "labels.stopReason.chapterCommitApprovalRequired",
    critical_review_unresolved: "labels.stopReason.criticalReviewUnresolved",
    quality_gate_blocked: "labels.stopReason.qualityGateBlocked",
    semantic_review_blocked: "labels.stopReason.semanticReviewBlocked",
    revision_limit_reached: "labels.stopReason.revisionLimitReached",
    scene_plan_approval_required:
      "labels.stopReason.scenePlanApprovalRequired",
    settlement_conflict_requires_resolution:
      "labels.stopReason.settlementConflictRequiresResolution",
    request_start_timeout: "labels.stopReason.requestStartTimeout",
    session_cancelled: "labels.stopReason.sessionCancelled",
    "child.fatal": "labels.stopReason.childFatal",
    awaiting_user: "labels.stopReason.awaitingUser",
    "long_goal.paused_baseline": "labels.stopReason.longGoalBaselineChanged",
  };
  const key: MessageKey | undefined = keys[reason];
  return key ? translate(getLocale(), key) : reason;
}

/** 项目概览 suggested 下一步（ProjectOverview.nextAction.kind）。 */
export function nextActionKindLabel(kind: string): string {
  const keys: Record<string, MessageKey> = {
    continue_task: "labels.nextActionKind.continueTask",
    review_foundation: "labels.nextActionKind.reviewFoundation",
    resolve_story_changes: "labels.nextActionKind.resolveStoryChanges",
    review_writing: "labels.nextActionKind.reviewWriting",
    write_chapter: "labels.nextActionKind.writeChapter",
    build_outline: "labels.nextActionKind.buildOutline",
    complete: "labels.nextActionKind.complete",
  };
  const key: MessageKey | undefined = keys[kind];
  return key ? translate(getLocale(), key) : kind;
}

/* --- 助手活动卡片（AssistantActivityDto） ------------------------------- */

/* 服务端只发机码描述符；字典路径直接镜像机码（labels.<key> 的嵌套结构），
   因此这里不需要逐键对照表。未知机码原样回显，便于发现漏配。 */
function renderActivityMessage(message: AssistantActivityTextDto): string {
  const key = `labels.${message.key}` as MessageKey;
  const rendered = translate(getLocale(), key, message.params);
  return rendered === key ? message.key : rendered;
}

/** 活动卡标题：机码描述符查字典渲染；原文字符串（用户自拟标题）原样返回。 */
export function activityGoalLabel(
  goal: string | AssistantActivityTextDto,
): string {
  if (typeof goal === "string") return goal;
  return renderActivityMessage(goal);
}

/** 活动卡阶段行：运行状态或当前步骤的进行中文案。 */
export function activityStageLabel(stage: AssistantActivityTextDto): string {
  return renderActivityMessage(stage);
}

/** 活动卡摘要行。 */
export function activitySummaryLabel(
  summary: AssistantActivityTextDto | null,
): string | null {
  return summary ? renderActivityMessage(summary) : null;
}

/** 活动卡工件名：已知 kind 走字典，未知回退服务端 label。 */
export function artifactKindLabel(kind: string, fallback: string): string {
  const keys: Record<string, MessageKey> = {
    foundation_candidate_set: "labels.artifactKind.foundationCandidateSet",
    canon_change_set: "labels.artifactKind.canonChangeSet",
    edit_proposal: "labels.artifactKind.editProposal",
    document_version: "labels.artifactKind.documentVersion",
    revision_proposal: "labels.artifactKind.revisionProposal",
    cocreate_turn: "labels.artifactKind.cocreateTurn",
    import_batch: "labels.artifactKind.importBatch",
    outline_node: "labels.artifactKind.outlineNode",
  };
  const key: MessageKey | undefined = keys[kind];
  return key ? translate(getLocale(), key) : fallback;
}

/** 内置技能名：按 skillId 查字典（服务端不再下发技能展示文案）。 */
export function assistantSkillLabel(skillId: string): string {
  const keys: Record<string, MessageKey> = {
    "story.query": "labels.assistantSkill.storyQuery",
    "book.foundation": "labels.assistantSkill.bookFoundation",
    "chapter.write": "labels.assistantSkill.chapterWrite",
    "serial.write": "labels.assistantSkill.serialWrite",
    "compose.serial": "labels.assistantSkill.composeSerial",
    "review.run": "labels.assistantSkill.reviewRun",
    "canon.edit": "labels.assistantSkill.canonEdit",
    "selection.polish": "labels.assistantSkill.selectionPolish",
  };
  const key: MessageKey | undefined = keys[skillId];
  return key ? translate(getLocale(), key) : skillId;
}
