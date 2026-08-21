import { sha256Hex } from "@narralume/domain";

import {
  createOutlineNode,
  type NarrativeRunStep,
  type OutlineNode,
  type RunBudgetUsage,
  type RunSnapshot,
} from "@narralume/domain";
import type {
  StepExecutionResult,
  StepWorker,
  WorkerRegistry,
} from "@narralume/harness";
import {
  SqliteAutomationRepository,
  SqliteCanonRepository,
  SqliteNarrativeStateRepository,
  SqliteProjectRepository,
  SqliteStoryRepository,
  type NarrativeDatabase,
} from "@narralume/persistence";

import type { NarrativeModelClient } from "./model-client.js";
import {
  automationValidator,
  FOUNDATION_CONTRACT,
  FoundationGenerationArtifactSchema,
  FoundationProposalSchema,
  PLANNING_REVIEW_CONTRACT,
  PlanningReviewResultSchema,
  ROLLING_OUTLINE_CONTRACT,
  RollingOutlineProposalSchema,
  STEER_CLASSIFICATION_CONTRACT,
  SteerClassificationResultSchema,
} from "./automation-schemas.js";
import { fingerprint } from "./canon-candidate-context.js";
import { StoryStatePacketBuilder } from "./story-state-packet.js";
import {
  requireActiveProject,
  requireActiveRunCommit,
} from "./project-guard.js";

export class AutomationWorkerSuite {
  private readonly automation: SqliteAutomationRepository;
  private readonly projects: SqliteProjectRepository;
  private readonly story: SqliteStoryRepository;
  private readonly canon: SqliteCanonRepository;
  private readonly state: SqliteNarrativeStateRepository;
  private readonly storyState: StoryStatePacketBuilder;

  constructor(
    private readonly database: NarrativeDatabase,
    private readonly model: NarrativeModelClient,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.automation = new SqliteAutomationRepository(database);
    this.projects = new SqliteProjectRepository(database);
    this.story = new SqliteStoryRepository(database);
    this.canon = new SqliteCanonRepository(database);
    this.state = new SqliteNarrativeStateRepository(
      database,
      this.canon,
      this.story,
    );
    this.storyState = new StoryStatePacketBuilder(
      this.canon,
      this.state,
      this.story,
    );
  }

  registry(): WorkerRegistry {
    return {
      "foundation.generate": this.worker(this.generateFoundation.bind(this)),
      "foundation.stage": this.worker(this.stageFoundation.bind(this)),
      "outline.generate": this.worker(this.generateOutline.bind(this)),
      "outline.commit": this.worker(this.commitOutline.bind(this)),
      "steer.classify": this.worker(this.classifySteer.bind(this)),
      "arc.review": this.worker(this.reviewArc.bind(this)),
      "volume.review": this.worker(this.reviewVolume.bind(this)),
    };
  }

  private worker(
    execute: (
      snapshot: RunSnapshot,
      step: NarrativeRunStep,
      signal: AbortSignal,
    ) => Promise<StepExecutionResult>,
  ): StepWorker {
    return {
      execute: (snapshot, step, signal) => {
        requireActiveProject(this.database, snapshot.run.projectId);
        return execute(snapshot, step, signal);
      },
    };
  }

  private async generateFoundation(
    snapshot: RunSnapshot,
    step: NarrativeRunStep,
    signal: AbortSignal,
  ): Promise<StepExecutionResult> {
    const project = this.projects.get(snapshot.run.projectId);
    if (!project) throw permanent("project.not_found", "Project not found");
    const braindump = policyString(snapshot.run.policy, "braindump");
    const preferences = policyRecord(snapshot.run.policy, "preferences");
    const creativePreferences = {
      genre: preferences.genre ?? null,
      audience: preferences.audience ?? null,
      tone: preferences.tone ?? null,
    };
    const planningTarget = {
      chapters: policyNumber(preferences, "targetChapters", 12),
      wordsPerChapter: policyNumber(preferences, "wordsPerChapter", 3_000),
      volumes: policyNumber(preferences, "volumes", 1),
    };
    const baseline = {
      intentUpdatedAt:
        this.story.getAuthorIntent(snapshot.run.projectId)?.updatedAt ?? null,
      compassVersion:
        this.automation.getCompass(snapshot.run.projectId)?.version ?? null,
    };
    const result = await this.model.structured(
      snapshot.run,
      step,
      "book-foundation",
      {
        instructions: [
          "你是长篇小说总策划。把作者的原始灵感整理成可选择的建书候选，而不是替作者宣告正典。",
          "保持创意具体、可持续写作、角色有欲望与代价。不要模仿在世作者。",
          "所有字段必须完整；边界应尊重作者原话，不能擅自添加猎奇内容。",
          "规划规模只属于故事指南针的 compass.target，不属于作者意图。除非作者素材原文明确提出相同限制，不得把目标章节数、每章字数或卷数写入 intent.boundaries、intent.currentFocus 或其他作者意图字段。",
        ].join("\n"),
        messages: [
          {
            role: "user",
            content: [
              `作品暂定名：${project.title}`,
              project.premise ? `已有命题：${project.premise}` : "",
              `作者素材：\n${braindump}`,
              `创作偏好：${JSON.stringify(creativePreferences)}`,
              `规划规模（仅写入故事指南针 compass.target）：${JSON.stringify(planningTarget)}`,
              "给出一组相互协调、但仍可逐条采纳或丢弃的建书候选。",
            ]
              .filter(Boolean)
              .join("\n\n"),
          },
        ],
        reasoningEffort: "low",
        maxOutputTokens: policyNumber(
          snapshot.run.policy,
          "foundationMaxOutputTokens",
          8_000,
        ),
      },
      FOUNDATION_CONTRACT,
      automationValidator(FoundationProposalSchema),
      signal,
    );
    return {
      artifactKind: "foundation-proposal",
      output: {
        ...result.value,
        compass: {
          ...result.value.compass,
          target: planningTarget,
        },
        baseline,
        generation: { mode: result.mode, attempts: result.attempts },
      },
      usage: result.usage,
    };
  }

  private async stageFoundation(
    snapshot: RunSnapshot,
  ): Promise<StepExecutionResult> {
    const proposal = FoundationGenerationArtifactSchema.parse(
      requiredArtifact(snapshot, "foundation.generate"),
    );
    const setId = `${snapshot.run.id}:foundation-set`;
    const now = this.now().toISOString();
    const candidates = [
      {
        id: `${setId}:intent`,
        kind: "intent" as const,
        label: "作者意图",
        payload: {
          ...proposal.intent,
          baseline: {
            intentUpdatedAt: proposal.baseline.intentUpdatedAt,
          },
        },
      },
      {
        id: `${setId}:compass`,
        kind: "compass" as const,
        label: "故事指南针",
        payload: {
          ...proposal.compass,
          baseline: {
            compassVersion: proposal.baseline.compassVersion,
          },
        },
      },
      ...proposal.entities.map((entity, index) => ({
        id: `${setId}:entity:${index}`,
        kind: "entity" as const,
        label: entity.name,
        payload: { ...entity },
      })),
    ];
    const detail = this.automation.stageCandidateSet({
      id: setId,
      projectId: snapshot.run.projectId,
      sourceRunId: snapshot.run.id,
      title: proposal.title,
      candidates,
      now,
    });
    return {
      artifactKind: "foundation-candidate-set",
      output: {
        candidateSetId: detail.set.id,
        candidateCount: detail.candidates.length,
        rationale: proposal.rationale,
      },
      usage: zeroUsage(),
    };
  }

  private async generateOutline(
    snapshot: RunSnapshot,
    step: NarrativeRunStep,
    signal: AbortSignal,
  ): Promise<StepExecutionResult> {
    const sessionId = policyString(snapshot.run.policy, "sessionId");
    const session = this.automation.requireSession(sessionId);
    const project = this.projects.get(session.projectId);
    if (!project) throw permanent("project.not_found", "Project not found");
    const compass = this.automation.getCompass(session.projectId);
    const intent = this.story.getAuthorIntent(session.projectId);
    const outline = this.story.listOutline(session.projectId);
    const summaries = outline
      .filter((node) => node.kind === "chapter" && node.status === "committed")
      .map((node) => ({
        title: node.title,
        summary:
          this.state.latestSummary(session.projectId, "chapter", node.id)
            ?.summary ?? node.summary,
      }));
    const steers = this.automation
      .listSteers(sessionId)
      .filter((steer) =>
        ["classified", "applied", "awaiting_confirmation"].includes(
          steer.status,
        ),
      )
      .map((steer) => ({
        content: steer.content,
        classification: steer.classification,
        status: steer.status,
      }));
    const continuationState = this.storyState.build({
      projectId: session.projectId,
      audience: "author",
      maxTimelineEvents: 120,
      maxRelationships: 120,
    });
    const remaining = Math.max(
      1,
      session.targetChapters - session.completedChapters,
    );
    const windowSize = Math.min(session.windowSize, remaining);
    const result = await this.model.structured(
      snapshot.run,
      step,
      "rolling-outline",
      {
        instructions: [
          "你是长篇小说滚动规划师。只详细规划当前可见窗口，不要一次冻结整部长篇。",
          "计划必须承接已提交章节，兑现指南针，尊重作者锁定意图与 steer。",
          "每章要有目标、阻力、转折、结果与结尾钩子；结果必须推动因果链。",
        ].join("\n"),
        messages: [
          {
            role: "user",
            content: [
              `作品：${project.title}`,
              `指南针：${JSON.stringify(compass)}`,
              `作者意图：${JSON.stringify(intent)}`,
              `现有大纲：${JSON.stringify(outline.map(compactOutline))}`,
              `已提交摘要：${JSON.stringify(summaries)}`,
              `<author-continuation-state>\n${continuationState.sources
                .map((source) => `${source.label}\n${source.content}`)
                .join("\n\n")}\n</author-continuation-state>`,
              `待考虑 steer：${JSON.stringify(steers)}`,
              `本次详细规划 ${windowSize} 章，并给出下一弧骨架。`,
            ].join("\n\n"),
          },
        ],
        reasoningEffort: "low",
        maxOutputTokens: policyNumber(
          snapshot.run.policy,
          "planningMaxOutputTokens",
          10_000,
        ),
      },
      ROLLING_OUTLINE_CONTRACT,
      automationValidator(RollingOutlineProposalSchema),
      signal,
    );
    const value = {
      ...result.value,
      chapters: result.value.chapters.slice(0, windowSize),
    };
    return {
      artifactKind: "rolling-outline-proposal",
      output: {
        ...value,
        generation: {
          mode: result.mode,
          attempts: result.attempts,
          // 保存生成时的大纲基线；commit 时比对，防止后台规划覆盖期间的人工编辑。
          outlineFingerprint: outlineFingerprint(outline),
        },
      },
      usage: result.usage,
    };
  }

  private async commitOutline(
    snapshot: RunSnapshot,
  ): Promise<StepExecutionResult> {
    const artifact = requiredArtifact(snapshot, "outline.generate");
    const plan = RollingOutlineProposalSchema.parse(artifact);
    const baseline =
      isRecord(artifact) &&
      isRecord(artifact.generation) &&
      typeof artifact.generation.outlineFingerprint === "string"
        ? artifact.generation.outlineFingerprint
        : null;
    const sessionId = policyString(snapshot.run.policy, "sessionId");
    const session = this.automation.requireSession(sessionId);
    const now = this.now().toISOString();
    const result = this.database.transaction(() => {
      const outline = this.story.listOutline(session.projectId);
      // 生成后大纲若被人工编辑（骨架弧详情、结构、章节变动），旧方案必须显式失效，
      // 不能用旧方案无条件覆盖作者的修改或按漂移后的结构追加章节。
      if (!baseline || outlineFingerprint(outline) !== baseline) {
        throw permanent(
          "outline.baseline.conflict",
          "The outline was changed by other edits after rolling planning; this plan is stale, please plan again",
        );
      }
      const root = outline.find((node) => node.kind === "book");
      if (!root)
        throw permanent(
          "outline.root.missing",
          "Project is missing the book root node",
        );
      let volume = latestNode(outline, "volume");
      if (!volume) {
        volume = this.story.insertOutlineNode(
          createOutlineNode({
            id: `${snapshot.run.id}:volume`,
            projectId: session.projectId,
            parent: root,
            kind: "volume",
            ordinal: nextOrdinal(outline, root.id),
            title: plan.volume.title,
            summary: plan.volume.summary,
            goal: plan.volume.goal,
            metadata: { detail: "active", sourceRunId: snapshot.run.id },
            now,
          }),
        );
      }
      const volumeChildren = this.story.listOutlineChildren(
        session.projectId,
        volume.id,
      );
      let arc = volumeChildren.find(
        (node) =>
          node.kind === "arc" &&
          node.metadata.detail === "skeleton" &&
          this.story.listOutlineChildren(session.projectId, node.id).length ===
            0,
      );
      if (arc) {
        arc = this.story.updateOutlineDetails(
          session.projectId,
          arc.id,
          {
            title: plan.arc.title,
            summary: plan.arc.summary,
            goal: plan.arc.goal,
            conflict: plan.arc.conflict,
            outcome: plan.arc.outcome,
            metadata: { detail: "active", sourceRunId: snapshot.run.id },
          },
          now,
        );
      } else {
        arc = this.story.insertOutlineNode(
          createOutlineNode({
            id: `${snapshot.run.id}:arc`,
            projectId: session.projectId,
            parent: volume,
            kind: "arc",
            ordinal: nextOrdinal(volumeChildren, volume.id),
            title: plan.arc.title,
            summary: plan.arc.summary,
            goal: plan.arc.goal,
            conflict: plan.arc.conflict,
            outcome: plan.arc.outcome,
            metadata: { detail: "active", sourceRunId: snapshot.run.id },
            now,
          }),
        );
      }
      const entities = this.canon.listEntities(session.projectId);
      const existingChapters = this.story.listOutlineChildren(
        session.projectId,
        arc.id,
      );
      const chapterIds: string[] = [];
      plan.chapters.forEach((chapter, index) => {
        const id = `${snapshot.run.id}:chapter:${index}`;
        const existing = this.story.getOutlineNode(session.projectId, id);
        if (existing) {
          chapterIds.push(existing.id);
          return;
        }
        const pov = chapter.povName
          ? entities.find(
              (entity) =>
                entity.name === chapter.povName ||
                entity.aliases.includes(chapter.povName!),
            )
          : null;
        const node = this.story.insertOutlineNode(
          createOutlineNode({
            id,
            projectId: session.projectId,
            parent: arc!,
            kind: "chapter",
            ordinal: nextOrdinal(existingChapters, arc!.id) + index,
            title: chapter.title,
            summary: chapter.summary,
            goal: chapter.goal,
            conflict: chapter.conflict,
            outcome: chapter.outcome,
            povEntityId: pov?.id ?? null,
            storyTime: chapter.storyTime,
            metadata: {
              hook: chapter.hook,
              sourceRunId: snapshot.run.id,
              planningRationale: plan.rationale,
            },
            now,
          }),
        );
        chapterIds.push(node.id);
      });
      let nextArcId: string | null = null;
      if (
        plan.nextArc &&
        session.completedChapters + chapterIds.length < session.targetChapters
      ) {
        const nextId = `${snapshot.run.id}:next-arc`;
        const existing = this.story.getOutlineNode(session.projectId, nextId);
        const nextArc =
          existing ??
          this.story.insertOutlineNode(
            createOutlineNode({
              id: nextId,
              projectId: session.projectId,
              parent: volume,
              kind: "arc",
              ordinal: nextOrdinal(
                this.story.listOutlineChildren(session.projectId, volume.id),
                volume.id,
              ),
              title: plan.nextArc.title,
              summary: plan.nextArc.summary,
              goal: plan.nextArc.goal,
              metadata: { detail: "skeleton", sourceRunId: snapshot.run.id },
              now,
            }),
          );
        nextArcId = nextArc.id;
      }
      const project = this.projects.get(session.projectId);
      if (project && ["idea", "foundation"].includes(project.phase)) {
        this.projects.update({
          ...project,
          phase: "outlining",
          updatedAt: now,
        });
      }
      return { volumeId: volume.id, arcId: arc.id, chapterIds, nextArcId };
    });
    return {
      artifactKind: "rolling-outline-commit",
      output: result,
      usage: zeroUsage(),
    };
  }

  private async classifySteer(
    snapshot: RunSnapshot,
    step: NarrativeRunStep,
    signal: AbortSignal,
  ): Promise<StepExecutionResult> {
    const steerId = policyString(snapshot.run.policy, "steerId");
    const steer = this.automation.requireSteer(steerId);
    const session = steer.sessionId
      ? this.automation.requireSession(steer.sessionId)
      : null;
    const result = await this.model.structured(
      snapshot.run,
      step,
      "steer-classification",
      {
        instructions: [
          "你是小说生产 harness 的 steer 仲裁器，只分类影响范围，不创作正文。",
          "立即影响仅用于作者明确要求停止或改变正在生成的内容；涉及既有正文或正典要提高风险。",
          "输出必须选择唯一分类和最早安全生效边界。",
        ].join("\n"),
        messages: [
          {
            role: "user",
            content: `运行状态：${session?.status ?? "无会话"}\n作者 steer：${steer.content}`,
          },
        ],
        reasoningEffort: "low",
        maxOutputTokens: 1_200,
      },
      STEER_CLASSIFICATION_CONTRACT,
      automationValidator(SteerClassificationResultSchema),
      signal,
    );
    const classified = this.database.transaction(() => {
      requireActiveRunCommit(
        this.database,
        snapshot.run.id,
        snapshot.run.projectId,
        signal,
      );
      return this.automation.classifySteer(steer.id, {
        ...result.value,
        now: this.now().toISOString(),
      });
    });
    return {
      artifactKind: "steer-classification",
      output: {
        steerId: classified.id,
        classification: classified.classification,
        effectiveBoundary: classified.effectiveBoundary,
        rationale: classified.rationale,
        risk: classified.risk,
        generation: { mode: result.mode, attempts: result.attempts },
      },
      usage: result.usage,
    };
  }

  private reviewArc(
    snapshot: RunSnapshot,
    step: NarrativeRunStep,
    signal: AbortSignal,
  ): Promise<StepExecutionResult> {
    return this.reviewScope(snapshot, step, signal, "arc");
  }

  private reviewVolume(
    snapshot: RunSnapshot,
    step: NarrativeRunStep,
    signal: AbortSignal,
  ): Promise<StepExecutionResult> {
    return this.reviewScope(snapshot, step, signal, "volume");
  }

  private async reviewScope(
    snapshot: RunSnapshot,
    step: NarrativeRunStep,
    signal: AbortSignal,
    scopeType: "arc" | "volume",
  ): Promise<StepExecutionResult> {
    const sessionId = policyString(snapshot.run.policy, "sessionId");
    const nodeId = policyString(
      snapshot.run.policy,
      scopeType === "arc" ? "arcId" : "volumeId",
    );
    const node = this.story.requireOutlineNode(snapshot.run.projectId, nodeId);
    if (node.kind !== scopeType) {
      throw permanent(
        "planning_review.scope.invalid",
        `Planning review target kind ${node.kind} is not ${scopeType}`,
      );
    }
    const outline = this.story.listOutline(snapshot.run.projectId);
    const chapters = outline.filter(
      (candidate) =>
        candidate.kind === "chapter" &&
        (candidate.parentId === node.id ||
          (scopeType === "volume" &&
            outline.some(
              (parent) =>
                parent.id === candidate.parentId && parent.parentId === node.id,
            ))),
    );
    const evidence = chapters.map((chapter) => ({
      title: chapter.title,
      status: chapter.status,
      summary:
        this.state.latestSummary(snapshot.run.projectId, "chapter", chapter.id)
          ?.summary ?? chapter.summary,
    }));
    const source = JSON.stringify(evidence);
    const result = await this.model.structured(
      snapshot.run,
      step,
      `${scopeType}-review`,
      {
        instructions: [
          `你是长篇小说${scopeType === "arc" ? "故事弧" : "卷"}复盘编辑。`,
          "基于章节摘要评估承诺兑现、因果、人物弧、节奏和连续性。建议服务于下一滚动窗口，不改写已提交事实。",
        ].join("\n"),
        messages: [
          {
            role: "user",
            content: [
              `范围：${node.title}`,
              `指南针：${JSON.stringify(this.automation.getCompass(snapshot.run.projectId))}`,
              `章节证据：${source}`,
            ].join("\n\n"),
          },
        ],
        reasoningEffort: "low",
        maxOutputTokens: 4_000,
      },
      PLANNING_REVIEW_CONTRACT,
      automationValidator(PlanningReviewResultSchema),
      signal,
    );
    const now = this.now().toISOString();
    const sourceHash = sha256(source);
    this.database.transaction(() => {
      requireActiveRunCommit(
        this.database,
        snapshot.run.id,
        snapshot.run.projectId,
        signal,
      );
      this.automation.insertPlanningReview({
        id: step.id,
        projectId: snapshot.run.projectId,
        sessionId,
        runId: snapshot.run.id,
        scopeType,
        outlineNodeId: node.id,
        summary: result.value.summary,
        scores: result.value.scores,
        recommendations: result.value.recommendations,
        sourceHash,
        createdAt: now,
      });
      this.state.upsertSummary({
        id: `${step.id}:summary`,
        projectId: snapshot.run.projectId,
        scopeType,
        scopeId: node.id,
        summary: result.value.summary,
        stateDelta: {
          recommendations: result.value.recommendations,
          compassAdjustments: result.value.compassAdjustments,
        },
        sourceHash,
        createdAt: now,
      });
    });
    return {
      artifactKind: `${scopeType}-review`,
      output: {
        ...result.value,
        outlineNodeId: node.id,
        sourceHash,
        generation: { mode: result.mode, attempts: result.attempts },
      },
      usage: result.usage,
    };
  }
}

function requiredArtifact(
  snapshot: RunSnapshot,
  kind: NarrativeRunStep["kind"],
): Record<string, unknown> {
  const artifact = snapshot.steps.find(
    (step) => step.kind === kind && step.status === "succeeded",
  )?.outputArtifact;
  if (!artifact)
    throw permanent("artifact.missing", `Missing ${kind} artifact`);
  return { ...artifact };
}

function compactOutline(node: OutlineNode) {
  return {
    id: node.id,
    parentId: node.parentId,
    kind: node.kind,
    title: node.title,
    summary: node.summary,
    status: node.status,
    metadata: node.metadata,
  };
}

function latestNode(
  outline: readonly OutlineNode[],
  kind: OutlineNode["kind"],
): OutlineNode | null {
  return [...outline].reverse().find((node) => node.kind === kind) ?? null;
}

function nextOrdinal(nodes: readonly OutlineNode[], parentId: string): number {
  return (
    Math.max(
      -1,
      ...nodes
        .filter((node) => node.parentId === parentId)
        .map((node) => node.ordinal),
    ) + 1
  );
}

function policyString(
  policy: Readonly<Record<string, unknown>>,
  key: string,
): string {
  const value = policy[key];
  if (typeof value !== "string" || !value.trim()) {
    throw permanent("run.policy.invalid", `Run policy is missing ${key}`);
  }
  return value;
}

function policyRecord(
  policy: Readonly<Record<string, unknown>>,
  key: string,
): Record<string, unknown> {
  const value = policy[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function policyNumber(
  policy: Readonly<Record<string, unknown>>,
  key: string,
  fallback: number,
): number {
  const value = policy[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function zeroUsage(): RunBudgetUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    calls: 0,
    costUsd: 0,
    wallTimeMs: 0,
  };
}

function sha256(value: string): string {
  return sha256Hex(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** 大纲结构指纹：覆盖节点身份、层级、排序、详情与 updatedAt，任何人工编辑都会改变它。 */
function outlineFingerprint(outline: readonly OutlineNode[]): string {
  return fingerprint(
    outline
      .map((node) => ({
        id: node.id,
        parentId: node.parentId,
        kind: node.kind,
        ordinal: node.ordinal,
        title: node.title,
        summary: node.summary,
        goal: node.goal,
        conflict: node.conflict,
        outcome: node.outcome,
        status: node.status,
        updatedAt: node.updatedAt,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  );
}

function permanent(code: string, message: string) {
  return { code, message, retryable: false };
}
