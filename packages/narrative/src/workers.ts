import { sha256Hex } from "@narralume/domain";

import {
  ContextCompiler,
  type ContextCompileError,
  type ContextSource,
} from "@narralume/context";
import {
  createDocument,
  type CanonFact,
  type Document,
  type DocumentVersion,
  type Foreshadow,
  type NarrativeRunStep,
  type OutlineNode,
  type RelationshipEvent,
  type RunBudgetUsage,
  type RunStepError,
  type RunSnapshot,
} from "@narralume/domain";
import type {
  StepExecutionResult,
  StepWorker,
  WorkerRegistry,
} from "@narralume/harness";
import {
  SqliteCanonRepository,
  SqliteAutomationRepository,
  SqliteContextReceiptRepository,
  SqliteDocumentRepository,
  SqliteDeliveryRepository,
  SqliteNarrativeStateRepository,
  SqliteProjectRepository,
  SqliteRetrievalRepository,
  SqliteReviewRepository,
  SqliteRunRepository,
  SqliteStoryRepository,
  SqliteTemplateRepository,
  type NarrativeDatabase,
} from "@narralume/persistence";

import type { NarrativeModelClient } from "./model-client.js";
import {
  optionalEmbeddings,
  recordEmbeddingDegradation,
} from "./embedding-support.js";
import { outlineContextSources } from "./outline-context.js";
import {
  ParagraphLocator,
  ParagraphLocatorError,
  bindEvidenceDocumentVersion,
  type GroundedParagraphEvidence,
} from "./paragraph-locator.js";
import {
  SettlementApplicationService,
  SettlementConflictError,
} from "./settlement-application-service.js";
import { instructionsFor } from "./prompt-language.js";
import { StoryStatePacketBuilder } from "./story-state-packet.js";
import {
  REVIEW_CONTRACT,
  ReviewResultSchema,
  deriveReviewResult,
  SCENE_PLAN_CONTRACT,
  ScenePlanSchema,
  SETTLEMENT_CONTRACT,
  GroundedSettlementSchema,
  SettlementSchema,
  type DerivedReviewResult,
  type GroundedSettlement,
  type ReviewResult,
  type Settlement,
  zodValidator,
} from "./schemas.js";
import {
  requireActiveProject,
  requireActiveRunCommit,
} from "./project-guard.js";

export class ChapterWorkerSuite {
  private readonly automation: SqliteAutomationRepository;
  private readonly projects: SqliteProjectRepository;
  private readonly story: SqliteStoryRepository;
  private readonly canon: SqliteCanonRepository;
  private readonly state: SqliteNarrativeStateRepository;
  private readonly documents: SqliteDocumentRepository;
  private readonly retrieval: SqliteRetrievalRepository;
  private readonly receipts: SqliteContextReceiptRepository;
  private readonly reviews: SqliteReviewRepository;
  private readonly runs: SqliteRunRepository;
  private readonly delivery: SqliteDeliveryRepository;
  private readonly compiler: ContextCompiler;
  private readonly templates: SqliteTemplateRepository;
  private readonly storyState: StoryStatePacketBuilder;
  private readonly settlementApplication: SettlementApplicationService;

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
    this.documents = new SqliteDocumentRepository(database);
    this.retrieval = new SqliteRetrievalRepository(database);
    this.receipts = new SqliteContextReceiptRepository(database);
    this.reviews = new SqliteReviewRepository(database);
    this.runs = new SqliteRunRepository(database);
    this.delivery = new SqliteDeliveryRepository(database);
    this.compiler = new ContextCompiler(now);
    this.templates = new SqliteTemplateRepository(database);
    this.storyState = new StoryStatePacketBuilder(
      this.canon,
      this.state,
      this.story,
    );
    this.settlementApplication = new SettlementApplicationService(database);
  }

  registry(): WorkerRegistry {
    return {
      "context.compile": this.worker(this.compileContext.bind(this)),
      "scene.plan": this.worker(this.planScenes.bind(this)),
      "draft.generate": this.worker(this.generateDraft.bind(this)),
      "deterministic.check": this.worker(this.deterministicCheck.bind(this)),
      "semantic.review": this.worker(this.semanticReview.bind(this)),
      "revision.generate": this.worker(this.generateRevision.bind(this)),
      "chapter.settle": this.worker(this.settleChapter.bind(this)),
      "chapter.commit": this.worker(this.commitChapter.bind(this)),
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

  private instructions(key: string, systemInvariants: string): string {
    const template = this.templates.getByKey(key);
    return template?.effectiveContent.trim()
      ? `${systemInvariants}\n<author-prompt-layer>\n${template.effectiveContent}\n</author-prompt-layer>`
      : systemInvariants;
  }

  private projectLanguage(projectId: string): string | null {
    return this.projects.get(projectId)?.language ?? null;
  }

  private async compileContext(
    snapshot: RunSnapshot,
    step: NarrativeRunStep,
    signal: AbortSignal,
  ): Promise<StepExecutionResult> {
    const run = snapshot.run;
    const project = this.projects.get(run.projectId);
    if (!project) throw permanent("project.not_found", "Project not found");
    if (!run.targetOutlineNodeId) {
      throw permanent(
        "run.target.missing",
        "The chapter run has no target outline node",
      );
    }
    const target = this.story.requireOutlineNode(
      run.projectId,
      run.targetOutlineNodeId,
    );
    if (target.kind !== "chapter") {
      throw permanent(
        "run.target.not_chapter",
        "The chapter production target must be a chapter",
      );
    }
    const compass = this.automation.getCompass(run.projectId);
    const chapterWritingReference = compass
      ? {
          targetCharacters: compass.target.wordsPerChapter,
          compassVersion: compass.version,
        }
      : null;
    const documentReview = this.documentReviewTarget(snapshot);
    const sources: ContextSource[] = [
      {
        id: `task:${target.id}`,
        kind: "task",
        label: `章节任务 · ${target.title}`,
        content: [
          `为《${project.title}》创作章节「${target.title}」。`,
          target.summary && `摘要：${target.summary}`,
          target.goal && `目标：${target.goal}`,
          target.conflict && `冲突：${target.conflict}`,
          target.outcome && `预期结果：${target.outcome}`,
          target.povEntityId && `POV 实体：${target.povEntityId}`,
        ]
          .filter(Boolean)
          .join("\n"),
        authority: "locked",
        priority: 100,
        required: true,
        compressible: false,
        sourceType: "outline_node",
        sourceId: target.id,
      },
    ];
    const activeStyle = this.delivery.getActiveStyleProfile(run.projectId);
    if (activeStyle) {
      sources.push({
        id: `style:${activeStyle.id}`,
        kind: "style",
        label: `启用风格 · ${activeStyle.name}`,
        content: [
          activeStyle.description ?? "",
          ...activeStyle.rules.map((rule) => `必须：${rule}`),
          ...activeStyle.negativeRules.map((rule) => `避免：${rule}`),
          ...activeStyle.examples.map((example) => `短样例：${example}`),
        ]
          .filter(Boolean)
          .join("\n"),
        authority: "locked",
        priority: 98,
        required: true,
        compressible: false,
        sourceType: "style_profile",
        sourceId: activeStyle.id,
      });
    }
    for (const skill of this.delivery.listApplicableSkills(
      run.projectId,
      "chapter",
    )) {
      sources.push({
        id: `skill:${skill.id}`,
        kind: "system",
        label: `写作 Skill · ${skill.name}`,
        content: skill.instructions,
        authority: "locked",
        priority: 90 + skill.priority / 20,
        required: skill.priority >= 80,
        compressible: skill.priority < 80,
        sourceType: "writing_skill",
        sourceId: skill.id,
      });
    }
    const lessons = this.reviews.listLessons(run.projectId).slice(0, 30);
    if (lessons.length > 0) {
      sources.push({
        id: "review:learned-lessons",
        kind: "system",
        label: "已确认的长期写作教训",
        content: lessons
          .map(
            (lesson) =>
              `- [${lesson.category}｜置信度 ${lesson.confidence.toFixed(2)}｜${lesson.occurrences} 次] ${lesson.guidance}`,
          )
          .join("\n"),
        summary: lessons
          .slice(0, 10)
          .map((lesson) => `- [${lesson.category}] ${lesson.guidance}`)
          .join("\n"),
        authority: "confirmed",
        priority: 91,
        sourceType: "review_lesson",
        sourceId: run.projectId,
      });
    }
    const steerNotes = Array.isArray(run.policy.steerNotes)
      ? run.policy.steerNotes.filter(
          (note): note is string =>
            typeof note === "string" && Boolean(note.trim()),
        )
      : [];
    if (steerNotes.length > 0) {
      sources.push({
        id: `steer:${run.id}`,
        kind: "author-intent",
        label: "本章导演注",
        content: steerNotes.map((note) => `- ${note}`).join("\n"),
        authority: "locked",
        priority: 99,
        required: true,
        compressible: false,
        sourceType: "story_steer",
        sourceId: run.id,
      });
    }
    const intent = this.story.getAuthorIntent(run.projectId);
    if (intent) {
      const content = [
        intent.promise && `核心承诺：${intent.promise}`,
        intent.themes.length && `主题：${intent.themes.join("、")}`,
        intent.audience && `目标读者：${intent.audience}`,
        intent.tone && `语气：${intent.tone}`,
        intent.boundaries.length && `边界：${intent.boundaries.join("；")}`,
        intent.endingDirection && `结局方向：${intent.endingDirection}`,
        intent.currentFocus && `当前焦点：${intent.currentFocus}`,
      ]
        .filter(Boolean)
        .join("\n");
      if (content) {
        sources.push({
          id: "author-intent",
          kind: "author-intent",
          label: "作者意图",
          content,
          authority: "locked",
          priority: 98,
          required: true,
          compressible: false,
          sourceType: "author_intent",
          sourceId: run.projectId,
        });
      }
    }
    const outline = this.story.listOutline(run.projectId);
    sources.push(
      ...outlineContextSources({
        projectId: run.projectId,
        outline,
        chapterSummaries: this.state.listLatestSummaries(
          run.projectId,
          "chapter",
        ),
        targetOutlineNodeId: target.id,
      }),
    );
    const authorStoryStatePacket = this.storyState.build({
      projectId: run.projectId,
      audience: "author",
      targetOutlineNodeId: target.id,
    });
    const draftStoryStatePacket = target.povEntityId
      ? this.storyState.build({
          projectId: run.projectId,
          audience: "character",
          characterId: target.povEntityId,
          targetOutlineNodeId: target.id,
        })
      : authorStoryStatePacket;

    const chapterNodes = outline.filter((node) => node.kind === "chapter");
    const pinnedDocumentSourceIds = new Set<string>();
    const targetChapterIndex = chapterNodes.findIndex(
      (node) => node.id === target.id,
    );
    for (let index = targetChapterIndex - 1; index >= 0; index -= 1) {
      const previousChapter = chapterNodes[index]!;
      const previousDocument = this.documents.getByOutlineNodeId(
        run.projectId,
        previousChapter.id,
      );
      const previousVersion = previousDocument?.currentVersionId
        ? this.documents.getVersion(
            run.projectId,
            previousDocument!.id,
            previousDocument.currentVersionId,
          )
        : null;
      if (!previousVersion?.content) continue;
      pinnedDocumentSourceIds.add(previousDocument!.id);
      pinnedDocumentSourceIds.add(previousVersion.id);
      const previousSummary = this.state.latestSummary(
        run.projectId,
        "chapter",
        previousChapter.id,
      )?.summary;
      sources.push({
        id: `previous-chapter:${previousVersion.id}`,
        kind: "recent-text",
        label: `紧邻上一章最新正文 · ${previousChapter.title}`,
        content: previousVersion.content,
        ...(previousSummary ? { summary: previousSummary } : {}),
        authority: "confirmed",
        priority: 97,
        required: true,
        compressible: true,
        sourceType: "document_version",
        sourceId: previousVersion.id,
        metadata: {
          outlineNodeId: previousChapter.id,
          documentId: previousDocument!.id,
        },
      });
      break;
    }

    const chapterDocument =
      documentReview?.document ??
      this.documents.getByOutlineNodeId(run.projectId, target.id);
    const baseVersion =
      documentReview?.version ??
      (chapterDocument?.currentVersionId && chapterDocument
        ? this.documents.getVersion(
            run.projectId,
            chapterDocument.id,
            chapterDocument.currentVersionId,
          )
        : null);
    if (baseVersion?.content) {
      pinnedDocumentSourceIds.add(chapterDocument!.id);
      pinnedDocumentSourceIds.add(baseVersion.id);
      const existingSummary = this.state.latestSummary(
        run.projectId,
        "chapter",
        target.id,
      )?.summary;
      sources.push({
        id: `recent:${baseVersion.id}`,
        kind: "recent-text",
        label: "当前章节底稿",
        content: baseVersion.content,
        ...(existingSummary ? { summary: existingSummary } : {}),
        authority: "confirmed",
        priority: 75,
        sourceType: "document_version",
        sourceId: baseVersion.id,
      });
    }
    const retrievalQuery = [target.title, target.summary]
      .filter(Boolean)
      .join(" ");
    const queryEmbedding = await optionalEmbeddings(
      this.model,
      run,
      step,
      "context-retrieval-query",
      retrievalQuery ? [retrievalQuery] : [],
      signal,
    );
    recordEmbeddingDegradation(
      this.database,
      run.id,
      step.id,
      queryEmbedding.degradation,
    );
    const retrievalHits = this.retrieval.search(run.projectId, retrievalQuery, {
      entityIds: [target.povEntityId].filter((value): value is string =>
        Boolean(value),
      ),
      limit: 8,
      rerank: false,
      ...(queryEmbedding.vectors[0]
        ? {
            queryEmbedding: queryEmbedding.vectors[0],
          }
        : {}),
      ...(queryEmbedding.model ? { embeddingModel: queryEmbedding.model } : {}),
    });
    for (const hit of retrievalHits) {
      if (pinnedDocumentSourceIds.has(hit.sourceId)) continue;
      sources.push({
        id: `retrieval:${hit.id}`,
        kind: "retrieval",
        label: hit.title || `${hit.sourceType}:${hit.sourceId}`,
        content: hit.content,
        authority:
          hit.authority === "locked"
            ? "locked"
            : hit.authority === "confirmed"
              ? "confirmed"
              : "reference",
        priority: 55 + Math.round(hit.score * 100),
        sourceType: hit.sourceType,
        sourceId: hit.sourceId,
        metadata: {
          retrievalReasons: hit.reasons,
          lexicalRank: hit.lexicalRank,
          vectorRank: hit.vectorRank,
          vectorScore: hit.vectorScore,
          rerankScore: hit.rerankScore,
        },
      });
    }

    const requestedContextWindow = policyNumber(
      run.policy,
      "contextWindow",
      128_000,
    );
    const inventoryDigest = sha256(
      stableContextInventory([...sources, ...authorStoryStatePacket.sources]),
    );
    const purposeRequests = {
      "scene-plan": 3_000,
      "chapter-draft": policyNumber(run.policy, "draftMaxOutputTokens", 32_000),
      "semantic-review": policyNumber(
        run.policy,
        "reviewMaxOutputTokens",
        24_000,
      ),
      "chapter-revision": policyNumber(
        run.policy,
        "draftMaxOutputTokens",
        32_000,
      ),
      "chapter-settlement": policyNumber(
        run.policy,
        "settlementMaxOutputTokens",
        24_000,
      ),
    } as const;
    const contexts: Record<
      string,
      {
        text: string;
        receiptId: string;
        compiledHash: string;
        contextWindow: number;
        outputReserve: number;
        modelMaterializationKey: string;
        inventoryDigest: string;
      }
    > = {};
    for (const [purpose, purposeRequest] of Object.entries(purposeRequests)) {
      const statePacket = [
        "scene-plan",
        "semantic-review",
        "chapter-settlement",
      ].includes(purpose)
        ? authorStoryStatePacket
        : draftStoryStatePacket;
      const purposeSources = [...sources, ...statePacket.sources];
      const purposeInventoryDigest = sha256(
        stableContextInventory(purposeSources),
      );
      const contextWindow =
        this.model.effectiveContextWindow?.(run, purpose) ??
        requestedContextWindow;
      const outputReserve = Math.min(
        purposeRequest,
        this.model.effectiveOutputLimit?.(run, purpose) ?? purposeRequest,
        Math.floor(contextWindow * 0.4),
      );
      const modelMaterializationKey =
        this.model.contextMaterializationKey?.(run, purpose) ?? "unresolved";
      const budget = {
        contextWindow,
        outputReserve,
        fixedInstructionReserve: 1_500,
        toolReserve: purpose.includes("draft") ? 0 : 500,
        schemaReserve: purpose.includes("draft") ? 0 : 1_000,
      };
      let compiled;
      try {
        compiled = this.compiler.compile({
          projectId: run.projectId,
          purpose,
          budget,
          sources: purposeSources,
        });
      } catch (error) {
        const contextError = error as Partial<ContextCompileError>;
        throw permanent(
          typeof contextError.code === "string"
            ? contextError.code
            : "context.compile.failed",
          `${purpose} context compilation failed: ${error instanceof Error ? error.message : String(error)}; budget ${JSON.stringify(budget)}`,
        );
      }
      const receipt = {
        ...compiled.receipt,
        id: `${step.id}:receipt:${purpose}`,
        inventoryDigest: purposeInventoryDigest,
        materializationDigest: sha256(
          `${purposeInventoryDigest}\0${purpose}\0${contextWindow}\0${outputReserve}\0${modelMaterializationKey}`,
        ),
        ...(queryEmbedding.degradation
          ? { degradations: [queryEmbedding.degradation] }
          : {}),
      };
      if (!this.receipts.get(run.projectId, receipt.id)) {
        this.receipts.insert(receipt, { runId: run.id, stepId: step.id });
      }
      contexts[purpose] = {
        text: compiled.text,
        receiptId: receipt.id,
        compiledHash: receipt.compiledHash,
        contextWindow,
        outputReserve,
        modelMaterializationKey,
        inventoryDigest: purposeInventoryDigest,
      };
    }
    return {
      artifactKind: "compiled-context",
      output: {
        inventoryDigest,
        inventorySources: sources.length,
        contexts,
        baseDocumentId: chapterDocument?.id ?? null,
        baseVersionId: baseVersion?.id ?? null,
        targetOutlineNodeId: target.id,
        chapterWritingReference,
        storyStateFingerprint: authorStoryStatePacket.fingerprint,
        storyStateCounts: authorStoryStatePacket.counts,
        storyStateFingerprints: {
          author: authorStoryStatePacket.fingerprint,
          draft: draftStoryStatePacket.fingerprint,
        },
        retrievalEmbedding: {
          model: queryEmbedding.model,
          modelId: queryEmbedding.modelId,
          warning: queryEmbedding.warning,
        },
      },
      usage: queryEmbedding.usage,
    };
  }

  private async planScenes(
    snapshot: RunSnapshot,
    step: NarrativeRunStep,
    signal: AbortSignal,
  ): Promise<StepExecutionResult> {
    const context = requiredArtifact(snapshot, "context.compile");
    const writingReference = chapterWritingReference(context);
    const result = await this.model.structured(
      snapshot.run,
      step,
      "scene-plan",
      {
        instructions: instructionsFor(
          this.projectLanguage(snapshot.run.projectId),
          {
            "zh-CN": [
              "你是长篇小说章节规划师。把章节目标拆成可写的场景，不写正文。",
              "每个场景必须有目标、阻力、转折和不可逆结果；只使用上下文中存在的实体 ID。",
              "保持滚动规划：只规划当前章，不擅自锁死远期情节。",
            ],
            en: [
              "You are the chapter planner of a long-form novel. Break the chapter goal into writable scenes; do not write prose.",
              "Every scene must have a goal, resistance, a turn, and an irreversible outcome; only use entity IDs that exist in the context.",
              "Keep the rolling plan going: plan only the current chapter and never lock in distant plot on your own.",
            ],
          },
        ),
        messages: [
          {
            role: "user",
            content: [
              ...(writingReference
                ? [
                    "<chapter-writing-reference>",
                    `本章完整正文的参考篇幅约为 ${writingReference.targetCharacters} 字。这只是节奏参考，不是硬性限制；情节完整和叙事自然优先。`,
                    "请据此安排场景数量和展开程度，使 scenes[].targetCharacters 合计大致围绕参考篇幅；不要为凑字数添加无效内容。",
                    "若本章导演注或作者提示包含更具体的篇幅要求，以更具体要求为准。",
                    "</chapter-writing-reference>",
                  ]
                : []),
              "以下是已编译且带权威边界的上下文：",
              purposeContextText(context, "scene-plan"),
            ].join("\n\n"),
          },
        ],
        maxOutputTokens: 3_000,
        temperature: 0.65,
        reasoningEffort: "low",
      },
      SCENE_PLAN_CONTRACT,
      zodValidator(ScenePlanSchema),
      signal,
    );
    return {
      artifactKind: "scene-plan",
      output: {
        ...result.value,
        generation: { mode: result.mode, attempts: result.attempts },
      },
      usage: result.usage,
    };
  }

  private async generateDraft(
    snapshot: RunSnapshot,
    step: NarrativeRunStep,
    signal: AbortSignal,
  ): Promise<StepExecutionResult> {
    const context = requiredArtifact(snapshot, "context.compile");
    const plan = requiredArtifact(snapshot, "scene.plan");
    // Set by POST /api/runs/:runId/streams/continue: the interrupted partial
    // becomes the chapter's existing beginning; the model only writes the
    // continuation and the final manuscript is prefix + generated part.
    const continuationPrefix = continuationPrefixOf(snapshot.run.policy);
    const writingReference = chapterWritingReference(context);
    const result = await this.model.text(
      snapshot.run,
      step,
      "chapter-draft",
      {
        instructions: instructionsFor(
          this.projectLanguage(snapshot.run.projectId),
          {
            "zh-CN": [
              "你是成熟的中文长篇小说作者。按照场景计划写出完整章节正文。",
              "让因果通过行动、感官、选择与后果显现；避免大纲腔、总结腔和解释性结尾。",
              "不得改写锁定事实，不得泄露 POV 角色未知的信息，不要输出标题、说明或 Markdown 围栏。",
              "若计划与锁定正典冲突，以锁定正典为准，并在不暴露流程的前提下自然化解。",
            ],
            en: [
              "You are an accomplished novelist writing a long-form novel in English. Write the full chapter prose according to the scene plan.",
              "Let causality emerge through action, senses, choices, and consequences; avoid outline-speak, summary-speak, and explanatory endings.",
              "Do not rewrite locked facts, do not reveal information unknown to the POV character, and output no titles, notes, or Markdown fences.",
              "If the plan conflicts with locked canon, locked canon wins; resolve it naturally without exposing the machinery.",
            ],
          },
        ),
        messages: [
          {
            role: "user",
            content: [
              ...(writingReference
                ? [
                    "<chapter-writing-reference>",
                    `本章完整正文的参考篇幅约为 ${writingReference.targetCharacters} 字。这只是节奏参考，不是硬性限制；情节完整和叙事自然优先，不要机械凑字数。`,
                    "若本章导演注或作者提示包含更具体的篇幅要求，以更具体要求为准。",
                    ...(continuationPrefix
                      ? [
                          `现有开头已有 ${[...continuationPrefix].length} 字；参考篇幅指完整章节总量，不是要求再新增 ${writingReference.targetCharacters} 字。`,
                        ]
                      : []),
                    "</chapter-writing-reference>",
                  ]
                : []),
              "<compiled-context>",
              purposeContextText(context, "chapter-draft"),
              "</compiled-context>",
              "<scene-plan>",
              JSON.stringify(plan),
              "</scene-plan>",
              ...(continuationPrefix
                ? [
                    "<existing-beginning>",
                    continuationPrefix,
                    "</existing-beginning>",
                    "以上 <existing-beginning> 是本章已经写好的开头，可能在句子中途截断。请紧接它的结尾继续写正文：不要重复、复述或改写已有内容，只输出新增的续写部分。",
                  ]
                : ["现在写正文。"]),
            ].join("\n"),
          },
        ],
        maxOutputTokens: policyNumber(
          snapshot.run.policy,
          "draftMaxOutputTokens",
          8_000,
        ),
        temperature: 0.82,
        reasoningEffort: "low",
      },
      signal,
    );
    const generated = cleanManuscript(result.text);
    if (isOutputLimitFinish(result.finishReason)) {
      throw <RunStepError>{
        code: "draft.output_limit",
        message:
          "The chapter manuscript hit the model output/context limit; generation can continue from the saved partial",
        retryable: true,
        details: {
          finishReason: result.finishReason,
          partial: true,
          recoveryActions: ["continue", "adopt", "regenerate"],
          partialCharacters: [...generated].length,
          partialHash: sha256(generated),
        },
        usage: result.usage,
      };
    }
    if (!generated) {
      throw {
        ...retryable("draft.empty", "The model returned no chapter manuscript"),
        usage: result.usage,
      };
    }
    const content = continuationPrefix
      ? continuationPrefix + generated
      : generated;
    return {
      artifactKind: "chapter-draft",
      output: {
        content,
        characters: [...content].length,
        paragraphs: paragraphs(content).length,
        contentHash: sha256(content),
        ...(continuationPrefix
          ? { continuationPrefixCharacters: [...continuationPrefix].length }
          : {}),
      },
      usage: result.usage,
    };
  }

  private async deterministicCheck(
    snapshot: RunSnapshot,
  ): Promise<StepExecutionResult> {
    const content = finalContent(snapshot);
    const issues: {
      code: string;
      severity: "major" | "critical";
      message: string;
      evidence: string | null;
    }[] = [];
    const minCharacters = policyNumber(
      snapshot.run.policy,
      "minChapterCharacters",
      1_200,
    );
    if ([...content].length < minCharacters) {
      issues.push({
        code: "draft.too_short",
        severity: "major",
        message: `正文少于 ${minCharacters} 个字符`,
        evidence: null,
      });
    }
    const placeholder =
      /(\{\{[^}]+\}\}|\[待(?:补|写|定)[^\]]*\]|\bTODO\b|作为(?:一个)?AI)/i.exec(
        content,
      );
    if (placeholder) {
      issues.push({
        code: "draft.placeholder",
        severity: "critical",
        message: "正文含有模板占位或模型自述",
        evidence: placeholder[0],
      });
    }
    const seen = new Set<string>();
    for (const paragraph of paragraphs(content)) {
      const normalized = paragraph.replace(/\s+/g, "").toLowerCase();
      if (normalized.length >= 30 && seen.has(normalized)) {
        issues.push({
          code: "draft.duplicate_paragraph",
          severity: "major",
          message: "正文含有完全重复的长段落",
          evidence: paragraph.slice(0, 160),
        });
        break;
      }
      seen.add(normalized);
    }
    const bannedTerms = Array.isArray(snapshot.run.policy.bannedTerms)
      ? snapshot.run.policy.bannedTerms.filter(
          (term): term is string => typeof term === "string" && Boolean(term),
        )
      : [];
    for (const term of bannedTerms) {
      const index = content.indexOf(term);
      if (index < 0) continue;
      issues.push({
        code: "draft.banned_term",
        severity: "critical",
        message: `正文包含禁用词：${term}`,
        evidence: content.slice(index, index + Math.max(term.length, 40)),
      });
    }
    const formatLeak =
      /(^|\n)\s*(?:#{1,6}\s+|```|<\/?(?:analysis|assistant|system)>)/i.exec(
        content,
      );
    if (formatLeak) {
      issues.push({
        code: "draft.format_leak",
        severity: "critical",
        message: "正文包含 Markdown 标题、代码围栏或模型角色标签",
        evidence: formatLeak[0].trim(),
      });
    }
    const sectionBreaks = content.match(
      /(?:^|\n)\s*(?:\*{3,}|-{3,})\s*(?=\n|$)/g,
    );
    if ((sectionBreaks?.length ?? 0) > 5) {
      issues.push({
        code: "draft.section_break_abuse",
        severity: "major",
        message: "正文使用了过多场景分隔符",
        evidence: sectionBreaks?.[0]?.trim() ?? null,
      });
    }
    const repeatedPhrase = repeatedPhraseEvidence(content, 12, 4);
    if (repeatedPhrase) {
      issues.push({
        code: "draft.repeated_phrase_density",
        severity: "major",
        message: "正文存在高频重复短语",
        evidence: repeatedPhrase,
      });
    }
    const cliche = repeatedCliche(content);
    if (cliche) {
      issues.push({
        code: "draft.cliche_density",
        severity: "major",
        message: "正文中过度重复常见套话",
        evidence: cliche,
      });
    }
    return {
      artifactKind: "deterministic-review",
      output: {
        verdict: issues.length ? "revise" : "pass",
        issues,
        characters: [...content].length,
        paragraphs: paragraphs(content).length,
        contentHash: sha256(content),
      },
      usage: zeroUsage(),
    };
  }

  private async semanticReview(
    snapshot: RunSnapshot,
    step: NarrativeRunStep,
    signal: AbortSignal,
  ): Promise<StepExecutionResult> {
    const documentReview = this.documentReviewTarget(snapshot);
    const content = documentReview?.content ?? finalContent(snapshot);
    const context = requiredArtifact(snapshot, "context.compile");
    const plan = documentReview
      ? {
          chapterTitle: documentReview.outlineNode.title,
          goal: documentReview.outlineNode.goal,
          summary: documentReview.outlineNode.summary,
          mode: "review-current-version",
        }
      : requiredArtifact(
          snapshot.run.recipe === "chapter-candidate-revision"
            ? this.requestedRevisionSource(snapshot)
            : snapshot,
          "scene.plan",
        );
    const locator = documentReview
      ? new ParagraphLocator(content, {
          documentVersionId: documentReview.version.id,
        })
      : this.paragraphLocator(snapshot.run.projectId, content, context);
    const result = await this.model.structured(
      snapshot.run,
      step,
      "semantic-review",
      {
        instructions: instructionsFor(
          this.projectLanguage(snapshot.run.projectId),
          {
            "zh-CN": [
              "你是证据约束的小说审稿人。独立检查正典连续性、角色能动性、因果链、节奏、视角、信息释放、风格一致性、伏笔推进和章节目标。",
              "每个问题必须用 evidenceParagraphs 引用带 [P#] 标签的正文段落；可引用多段，无法举证就不要提出。",
              "章节目标未完成必须提出 category=goal 且 severity=major/critical 的问题，不能只降低 goal 分数或标成 minor/info。",
              "每个问题都填写 requiresAuthorDecision。只有无法通过局部修订安全解决、必须由作者选择方向的 major/critical 正典或方向冲突才填 true；其余一律填 false。不要输出总 verdict，系统会根据问题派生。",
            ],
            en: [
              "You are an evidence-bound novel reviewer. Independently check canon continuity, character agency, causal chains, pacing, point of view, information release, style consistency, foreshadowing progress, and the chapter goal.",
              "Every issue must cite paragraphs tagged [P#] through evidenceParagraphs; citing several is allowed, and issues you cannot evidence must not be raised.",
              "An unmet chapter goal must yield an issue with category=goal and severity=major/critical; do not merely lower the goal score or file it as minor/info.",
              "Fill requiresAuthorDecision on every issue. Set true only for major/critical canon or direction conflicts that local revision cannot safely resolve and that require the author to choose a direction; set false otherwise. Output no overall verdict; the system derives one from the issues.",
            ],
          },
        ),
        messages: [
          {
            role: "user",
            content: [
              "<compiled-context>",
              purposeContextText(context, "semantic-review"),
              "</compiled-context>",
              `<scene-plan>${JSON.stringify(plan)}</scene-plan>`,
              "<manuscript>",
              locator.render(),
              "</manuscript>",
            ].join("\n"),
          },
        ],
        maxOutputTokens: policyNumber(
          snapshot.run.policy,
          "reviewMaxOutputTokens",
          16_000,
        ),
        temperature: 0.2,
        reasoningEffort: "low",
      },
      REVIEW_CONTRACT,
      zodValidator(ReviewResultSchema, (value) =>
        reviewSemanticIssues(value, locator),
      ),
      signal,
    );
    const grounded = groundReviewEvidence(
      deriveReviewResult(result.value),
      locator,
    );
    const reportId = `${step.id}:report`;
    const persistedIssues = grounded.issues.map((issue, index) => ({
      ...issue,
      id: `${reportId}:issue:${index}`,
    }));
    this.reviews.insertReport({
      id: reportId,
      projectId: snapshot.run.projectId,
      runId: snapshot.run.id,
      stepId: step.id,
      documentVersionId: locator.documentVersionId,
      verdict: grounded.verdict,
      summary: grounded.summary,
      scores: grounded.scores,
      reviewedContent: content,
      reviewedContentHash: locator.contentHash,
      issues: persistedIssues.map((issue) => ({
        id: issue.id,
        category: issue.category,
        severity: issue.severity,
        message: issue.message,
        evidence: issue.evidence,
        suggestedDirection: issue.suggestedDirection,
      })),
      createdAt: this.now().toISOString(),
    });
    return {
      artifactKind: "semantic-review",
      output: {
        ...grounded,
        issues: persistedIssues,
        reportId,
        generation: { mode: result.mode, attempts: result.attempts },
      },
      usage: result.usage,
    };
  }

  private async generateRevision(
    snapshot: RunSnapshot,
    step: NarrativeRunStep,
    signal: AbortSignal,
  ): Promise<StepExecutionResult> {
    const isRequestedRevision =
      snapshot.run.recipe === "chapter-candidate-revision" &&
      step.id.endsWith(":revise:requested");
    const requestedSource = isRequestedRevision
      ? this.requestedRevisionSource(snapshot)
      : null;
    const baseContent = requestedSource
      ? finalContent(requestedSource)
      : finalContent(snapshot);
    if (!baseContent.trim()) {
      throw permanent(
        "revision.base_manuscript.missing",
        "The revision run has no complete source manuscript available",
      );
    }
    const revisionInstruction = isRequestedRevision
      ? stringField(snapshot.run.policy, "revisionInstruction")
      : null;
    const review = isRequestedRevision
      ? {
          verdict: "revise",
          summary: revisionInstruction,
          issues: [],
          source: "author_revision_request",
        }
      : latestGateArtifact(snapshot);
    const context = requiredArtifact(snapshot, "context.compile");
    const result = await this.model.text(
      snapshot.run,
      step,
      "chapter-revision",
      {
        instructions: instructionsFor(
          this.projectLanguage(snapshot.run.projectId),
          {
            "zh-CN": [
              "你是小说修订者。只解决给定的可举证问题，同时保护原稿已成立的声音、节奏和事实。",
              "输出修订后的完整正文，不要解释，不要 Markdown 围栏。",
              "非空输出必须从原稿开头写到结尾；如果无法完成全文修订，返回空字符串，不得只返回改动段落、摘要或说明。",
              "不要为了润色而全篇换风格；不得新增上下文之外的锁定事实。",
            ],
            en: [
              "You are a manuscript reviser. Resolve only the given evidence-backed issues while protecting the voice, rhythm, and facts the draft has already established.",
              "Output the full revised prose without explanations or Markdown fences.",
              "A non-empty output must run from the start of the draft to its end; if the full revision is impossible, return an empty string - never only changed passages, summaries, or notes.",
              "Do not restyle the whole piece as polish; do not introduce locked facts beyond the context.",
            ],
          },
        ),
        messages: [
          {
            role: "user",
            content: [
              `<authoritative-context>${purposeContextText(context, "chapter-revision")}</authoritative-context>`,
              revisionInstruction
                ? `<author-revision-instruction>${revisionInstruction}</author-revision-instruction>`
                : "",
              `<review>${JSON.stringify(review)}</review>`,
              "<base-manuscript>",
              baseContent,
              "</base-manuscript>",
            ].join("\n"),
          },
        ],
        maxOutputTokens: policyNumber(
          snapshot.run.policy,
          "draftMaxOutputTokens",
          8_000,
        ),
        temperature: 0.55,
        reasoningEffort: "low",
      },
      signal,
    );
    const content = revisionManuscript(result.text);
    if (isOutputLimitFinish(result.finishReason)) {
      throw <RunStepError>{
        code: "revision.output_limit",
        message:
          "The full revision hit the model output/context limit; truncated text cannot be promoted to a new manuscript",
        retryable: true,
        details: {
          finishReason: result.finishReason,
          partial: true,
          partialCharacters: [...content].length,
          partialHash: sha256(content),
        },
        usage: result.usage,
      };
    }
    if (isRevisionNoop(baseContent, content)) {
      const reason =
        content.length === 0 ? "empty_output" : "line_endings_only";
      if (isRequestedRevision) {
        throw <RunStepError>{
          code: "revision.requested_noop",
          message:
            "AI did not produce a materially changed version as requested",
          retryable: true,
          details: { reason, baseHash: sha256(baseContent) },
          usage: result.usage,
        };
      }
      return {
        artifactKind: "revision_noop",
        output: {
          content: baseContent,
          noop: true,
          reason,
          baseHash: sha256(baseContent),
          contentHash: sha256(baseContent),
          characters: [...baseContent].length,
        },
        usage: result.usage,
      };
    }
    const characters = [...content].length;
    const minimumCharacters = policyNumber(
      snapshot.run.policy,
      "minChapterCharacters",
      1_200,
    );
    if (characters < minimumCharacters) {
      throw <RunStepError>{
        code: "revision.incomplete",
        message: `The revision returned only ${characters} characters, below the full manuscript minimum of ${minimumCharacters}`,
        retryable: true,
        details: {
          characters,
          minimumCharacters,
          outputHash: sha256(content),
        },
        usage: result.usage,
      };
    }
    const proposalId = `${step.id}:proposal`;
    const issueIds = Array.isArray(review.issues)
      ? review.issues
          .map((issue) =>
            isRecord(issue) && typeof issue.id === "string" ? issue.id : null,
          )
          .filter((id): id is string => Boolean(id))
      : [];
    this.reviews.insertRevisionProposal({
      id: proposalId,
      projectId: snapshot.run.projectId,
      runId: snapshot.run.id,
      stepId: step.id,
      baseDocumentVersionId: stringOrNull(context.baseVersionId),
      revisedContent: content,
      diff: buildTextDiff(baseContent, content),
      addressedIssueIds: issueIds,
      status: "proposed",
      createdAt: this.now().toISOString(),
    });
    return {
      artifactKind: "chapter-revision",
      output: {
        content,
        proposalId,
        baseHash: sha256(baseContent),
        contentHash: sha256(content),
        characters: [...content].length,
        diff: buildTextDiff(baseContent, content),
      },
      usage: result.usage,
    };
  }

  private requestedRevisionSource(snapshot: RunSnapshot): RunSnapshot {
    const sourceRunId = stringField(snapshot.run.policy, "revisionSourceRunId");
    const source = this.runs.getSnapshot(sourceRunId);
    if (
      source.run.projectId !== snapshot.run.projectId ||
      source.run.targetOutlineNodeId !== snapshot.run.targetOutlineNodeId
    ) {
      throw permanent(
        "revision.source.scope_mismatch",
        "The revision source manuscript does not belong to the current project and chapter",
      );
    }
    return source;
  }

  private async settleChapter(
    snapshot: RunSnapshot,
    step: NarrativeRunStep,
    signal: AbortSignal,
  ): Promise<StepExecutionResult> {
    const manual = this.manualSettlementTarget(snapshot);
    const content = manual ? manual.content : finalContent(snapshot);
    const locator = manual
      ? new ParagraphLocator(content, {
          documentVersionId: manual.version.id,
        })
      : this.paragraphLocator(
          snapshot.run.projectId,
          content,
          requiredArtifact(snapshot, "context.compile"),
        );
    const authoritative = manual
      ? this.manualSettlementContext(
          snapshot.run.projectId,
          manual.outlineNode.id,
        )
      : purposeContextText(
          requiredArtifact(snapshot, "context.compile"),
          "chapter-settlement",
        );
    const entities = this.canon.listEntities(snapshot.run.projectId);
    const entityIds = new Set(entities.map((entity) => entity.id));
    const settlementState = {
      facts: new Map(
        this.canon
          .listEffectiveFacts(snapshot.run.projectId)
          .map((fact) => [fact.id, fact]),
      ),
      relationships: new Map(
        this.state
          .listCurrentRelationships(snapshot.run.projectId)
          .map((relationship) => [relationship.id, relationship]),
      ),
      timelineEventIds: new Set(
        this.state
          .listTimeline(snapshot.run.projectId)
          .map((event) => event.id),
      ),
      foreshadows: new Map(
        this.state
          .listForeshadows(snapshot.run.projectId)
          .map((foreshadow) => [foreshadow.id, foreshadow]),
      ),
      outlineNodeIds: new Set(
        this.story.listOutline(snapshot.run.projectId).map((node) => node.id),
      ),
    };
    const result = await this.model.structured(
      snapshot.run,
      step,
      "chapter-settlement",
      {
        instructions: this.instructions(
          "prompt.chapter-settlement",
          instructionsFor(this.projectLanguage(snapshot.run.projectId), {
            "zh-CN": [
              "你是章节结算员。仅从正文提取可举证的状态变化、候选事实、事件、关系变化与伏笔动作。每一项都用 evidenceParagraphs 引用带 [P#] 标签的一个或多个正文段落。",
              "这些结果都是候选，不得声称已修改正典。实体只能使用给定 ID。",
              "事实操作规则：assert 用于增加一个正文已证实的命题，即使同一 subjectId/predicate 已有其他值也不需要覆盖；只有正文明确推翻或替换某条当前事实时才使用 supersede，并必须通过 factId 指定被替换事实；withdraw 也必须通过 factId 指定撤回目标。不得根据 subjectId/predicate 猜测替换目标。关系使用 start/update/end，伏笔仅在 plant 时不提供 foreshadowId。",
              "ID 引用规则：causeEventIds 只能使用上下文中 [timeline:…] 标注的事件 ID；targetFromNodeId/targetToNodeId 只能使用 [node:…] 标注的大纲节点 ID；实体、关系、伏笔同理只能使用上下文标注的对应 ID。禁止编造或挪用其它类型的 ID。",
              "事实宾语规则：assert/supersede 必须在 objectEntityId 与 value 中二选一。实体宾语填 objectEntityId 并将 value 置 null；普通文本、数字或布尔值填 value 并将 objectEntityId 置 null。不要额外填写布尔值或字符串 true 表示事实成立，operation 已表达事实操作；同时需要实体和文本时拆成两条事实。withdraw 通过 factId 指定目标事实，subjectId/predicate 必须与目标一致，objectEntityId 与 value 都填 null。",
              "伏笔规则：plant（新埋）不填 foreshadowId 也不填 expectedStatus；update/resolve 必须引用已有伏笔 ID，且 expectedStatus 填该伏笔现在所处的状态（乐观并发检查：status 标注里｜竖线后面的值，如 planted），不是你想改成的新状态——新状态由 action 决定。",
              "只记录本章实际发生的变化；未变化的状态和未回收伏笔不要重复提交，也不要为了推进下一章而强行回收伏笔。",
              "factCandidates 必须描述故事世界里的实际命题，不要使用‘得知’‘看见’‘意识到’等元谓词来重复表达知情关系。例如角色得知‘钥匙能开侧门’，predicate/value 应记录‘钥匙能开侧门’这个命题，谁知道它只由 knowledgeScope、knowledgeSubjectId 和 belief 表达。",
              "人物知识必须填写真正的知情角色；knowledgeSubjectId 仅在 knowledgeScope 为 character 时填写该角色 ID，其余 scope（omniscient/reader/author_secret）必须填 null。",
              "不要把修辞、推测或人物谎言当作全知事实。",
            ],
            en: [
              "You are the chapter settler. Extract only evidence-backed state changes, candidate facts, events, relationship changes, and foreshadowing actions from the prose. Cite one or more [P#]-tagged paragraphs through evidenceParagraphs for every item.",
              "These results are candidates; never claim canon has been modified. Entities may only use the given IDs.",
              "Fact operation rules: assert adds a proposition the prose has evidenced - even when another value exists for the same subjectId/predicate no overwrite is needed; use supersede only when the prose explicitly overturns or replaces a current fact, naming the replaced fact via factId; use withdraw only against a target named via factId. Never guess replacement targets from subjectId/predicate. Relationships use start/update/end; foreshadows omit foreshadowId only when planting.",
              "ID reference rules: causeEventIds may only use event IDs annotated [timeline:…] in the context; targetFromNodeId/targetToNodeId may only use outline node IDs annotated [node:…]; entities, relationships, and foreshadows likewise may only use correspondingly annotated IDs. Fabricating or repurposing other ID types is forbidden.",
              "Fact object rules: assert/supersede must choose exactly one of objectEntityId and value. Fill objectEntityId with a null value for entity objects; fill value with a null objectEntityId for plain text, numbers, or booleans. Do not put boolean true or a quoted true to state that a fact holds - the operation already expresses it; split into two facts when both an entity and text are needed. withdraw names its target via factId with matching subjectId/predicate and both objectEntityId and value null.",
              "Foreshadow rules: plant (a new one) fills neither foreshadowId nor expectedStatus; update/resolve must reference an existing foreshadow ID, and expectedStatus takes the status the foreshadow currently holds (optimistic concurrency check: the value after the | bar in the status annotation, e.g. planted) - not the new state you intend, which the action determines.",
              "Record only changes that actually happen in this chapter; do not resubmit unchanged states or unrecovered foreshadows, and never force a foreshadow to pay off just to move the next chapter forward.",
              "factCandidates must describe real propositions in the story world; never restate knowledge through meta-predicates such as learns, sees, or realizes. If a character learns that the key opens the side door, predicate/value should record the proposition that the key opens the side door; who knows it is expressed only by knowledgeScope, knowledgeSubjectId, and belief.",
              "Character knowledge names the character who actually knows; fill knowledgeSubjectId only when knowledgeScope is character, and leave it null for the other scopes (omniscient/reader/author_secret).",
              "Never treat rhetoric, speculation, or in-character lies as omniscient facts.",
            ],
          }),
        ),
        messages: [
          {
            role: "user",
            content: [
              `<authoritative-context>${authoritative}</authoritative-context>`,
              `<entities>${JSON.stringify(entities.map(({ id, name, type }) => ({ id, name, type })))}</entities>`,
              "<manuscript>",
              locator.render(),
              "</manuscript>",
            ].join("\n"),
          },
        ],
        maxOutputTokens: policyNumber(
          snapshot.run.policy,
          "settlementMaxOutputTokens",
          16_000,
        ),
        temperature: 0.15,
        reasoningEffort: "low",
      },
      SETTLEMENT_CONTRACT,
      zodValidator(SettlementSchema, (value) =>
        settlementSemanticIssues(
          stripContextTagPrefixes(value),
          entityIds,
          settlementState,
          locator,
        ),
      ),
      signal,
    );
    const grounded = groundSettlementEvidence(
      stripContextTagPrefixes(result.value),
      locator,
    );
    return {
      artifactKind: "chapter-settlement",
      output: {
        ...grounded,
        manuscriptHash: locator.contentHash,
        generation: { mode: result.mode, attempts: result.attempts },
      },
      usage: result.usage,
    };
  }

  private async commitChapter(
    snapshot: RunSnapshot,
    step: NarrativeRunStep,
    signal: AbortSignal,
  ): Promise<StepExecutionResult> {
    const run = snapshot.run;
    const settlement = GroundedSettlementSchema.parse(
      requiredArtifact(snapshot, "chapter.settle"),
    );
    const manual = this.manualSettlementTarget(snapshot);
    if (manual) {
      return this.commitManualSettlement(
        snapshot,
        step,
        manual,
        settlement,
        signal,
      );
    }
    const context = requiredArtifact(snapshot, "context.compile");
    const content = finalContent(snapshot);
    const targetId = stringField(context, "targetOutlineNodeId");
    const target = this.story.requireOutlineNode(run.projectId, targetId);
    const now = this.now().toISOString();
    const replayDocumentId =
      stringOrNull(context.baseDocumentId) ?? `${run.id}:chapter-document`;
    const replayVersion = this.documents.getVersion(
      run.projectId,
      replayDocumentId,
      step.id,
    );
    if (replayVersion) {
      this.reviews.bindRunReportsToDocumentVersion(
        run.id,
        replayVersion.id,
        replayVersion.contentHash,
      );
      this.reviews.acceptRunRevisionProposals(run.id, now);
      return {
        artifactKind: "chapter-commit",
        output: {
          documentId: replayDocumentId,
          versionId: replayVersion.id,
          contentHash: replayVersion.contentHash,
          idempotentReplay: true,
          changeSetId: `${run.id}:canon-change-set`,
        },
        usage: zeroUsage(),
      };
    }
    const contentEmbedding = await optionalEmbeddings(
      this.model,
      run,
      step,
      "chapter-index",
      [content],
      signal,
    );
    const output = this.database.transaction(() => {
      requireActiveRunCommit(this.database, run.id, run.projectId, signal);
      let document = stringOrNull(context.baseDocumentId)
        ? this.documents.get(
            run.projectId,
            stringField(context, "baseDocumentId"),
          )
        : null;
      if (!document) {
        const documentId = `${run.id}:chapter-document`;
        document = this.documents.get(run.projectId, documentId);
        if (!document) {
          document = this.documents.insert(
            createDocument({
              id: documentId,
              projectId: run.projectId,
              kind: "chapter",
              title: target.title,
              outlineNodeId: target.id,
              now,
            }),
          );
        }
      }
      const existing = this.documents.getVersion(
        run.projectId,
        document.id,
        step.id,
      );
      if (existing) {
        this.reviews.acceptRunRevisionProposals(run.id, now);
        return {
          documentId: document.id,
          versionId: existing.id,
          contentHash: existing.contentHash,
          idempotentReplay: true,
          changeSetId: `${run.id}:canon-change-set`,
        };
      }
      const currentVersion = document.currentVersionId
        ? this.documents.getVersion(
            run.projectId,
            document.id,
            document.currentVersionId,
          )
        : null;
      const replayChangeSet = this.reviews.getCanonChangeSet(
        run.projectId,
        `${run.id}:canon-change-set`,
      );
      if (replayChangeSet && currentVersion?.contentHash === sha256(content)) {
        this.reviews.bindRunReportsToDocumentVersion(
          run.id,
          currentVersion.id,
          currentVersion.contentHash,
        );
        this.reviews.acceptRunRevisionProposals(run.id, now);
        return {
          documentId: document.id,
          versionId: currentVersion.id,
          contentHash: currentVersion.contentHash,
          idempotentReplay: true,
          versionCreated: false,
          changeSetId: replayChangeSet.id,
        };
      }
      const versionCreated = currentVersion?.contentHash !== sha256(content);
      const version = versionCreated
        ? this.documents.appendVersion(run.projectId, document.id, {
            id: step.id,
            content,
            source: `run:${run.id}`,
            runId: run.id,
            expectedCurrentVersionId: stringOrNull(context.baseVersionId),
            now,
          })
        : currentVersion!;
      const boundSettlement = bindSettlementEvidence(settlement, version.id);
      this.reviews.bindRunReportsToDocumentVersion(
        run.id,
        version.id,
        version.contentHash,
      );
      this.reviews.acceptRunRevisionProposals(run.id, now);
      const entityIds = settlementEntityIds(boundSettlement).filter((id) =>
        Boolean(this.canon.getEntity(run.projectId, id)),
      );
      if (versionCreated) {
        const segment = this.retrieval.upsertSegment({
          id: `document:${document.id}:current`,
          projectId: run.projectId,
          sourceType: "document_current",
          sourceId: document.id,
          title: target.title,
          content,
          authority: "confirmed",
          metadata: {
            documentId: document.id,
            documentVersionId: version.id,
            outlineNodeId: target.id,
            runId: run.id,
          },
          entityIds,
          createdAt: now,
          updatedAt: now,
        });
        if (contentEmbedding.vectors[0] && contentEmbedding.model) {
          this.retrieval.upsertEmbedding({
            segmentId: segment.id,
            model: contentEmbedding.model,
            embedding: contentEmbedding.vectors[0],
            updatedAt: now,
          });
        }
      }
      this.state.upsertSummary({
        id: `${run.id}:summary`,
        projectId: run.projectId,
        scopeType: "chapter",
        scopeId: target.id,
        summary: boundSettlement.summary,
        stateDelta: { changes: boundSettlement.stateDelta },
        sourceHash: version.contentHash,
        createdAt: now,
      });
      const changeSetId = `${run.id}:canon-change-set`;
      this.reviews.insertCanonChangeSet({
        id: changeSetId,
        projectId: run.projectId,
        runId: run.id,
        stepId: step.id,
        changes: boundSettlement,
        status: "candidate",
        createdAt: now,
      });
      let settlementApplication = null;
      let settlementConflict = null;
      if (run.mode === "autopilot" || run.policy.autoApplySettlement === true) {
        try {
          settlementApplication = this.settlementApplication.apply({
            projectId: run.projectId,
            changeSetId,
            conflictPolicy: "reject",
            now,
          });
        } catch (error) {
          if (!(error instanceof SettlementConflictError)) throw error;
          settlementConflict = {
            code: error.code,
            changeSetId,
            conflicts: error.conflicts,
          };
        }
      }
      this.story.updateOutlineStatus(
        run.projectId,
        target.id,
        settlementConflict ? "review" : "committed",
        now,
      );
      return {
        documentId: document.id,
        versionId: version.id,
        contentHash: version.contentHash,
        idempotentReplay: false,
        versionCreated,
        changeSetId,
        settlementApplication,
        settlementConflict,
        retrievalEmbedding: {
          model: contentEmbedding.model,
          modelId: contentEmbedding.modelId,
          warning: contentEmbedding.warning,
        },
      };
    });
    return {
      artifactKind: "chapter-commit",
      output,
      usage: contentEmbedding.usage,
    };
  }

  private paragraphLocator(
    projectId: string,
    content: string,
    context: Readonly<Record<string, unknown>>,
  ): ParagraphLocator {
    const documentId = stringOrNull(context.baseDocumentId);
    const versionId = stringOrNull(context.baseVersionId);
    const version =
      documentId && versionId
        ? this.documents.getVersion(projectId, documentId, versionId)
        : null;
    return new ParagraphLocator(content, {
      documentVersionId:
        version?.contentHash === sha256(content) ? version.id : null,
    });
  }

  /** 手动结算的目标：正文来自已提交的文档版本，而不是 Run 内部草稿。 */
  private manualSettlementTarget(snapshot: RunSnapshot): {
    document: Document;
    version: DocumentVersion;
    outlineNode: OutlineNode;
    content: string;
  } | null {
    if (snapshot.run.recipe !== "manual-settlement") return null;
    const documentId = stringOrNull(snapshot.run.policy.documentId);
    const versionId = stringOrNull(snapshot.run.policy.documentVersionId);
    if (!documentId || !versionId) {
      throw permanent(
        "manual_settlement.target.missing",
        "The manual settlement run is missing a manuscript version target",
      );
    }
    const document = this.documents.get(snapshot.run.projectId, documentId);
    if (!document) {
      throw permanent(
        "document.not_found",
        "The manual settlement target document does not exist",
      );
    }
    const version = this.documents.getVersion(
      snapshot.run.projectId,
      documentId,
      versionId,
    );
    if (!version) {
      throw permanent(
        "document.version.not_found",
        "The manual settlement target version does not exist",
      );
    }
    if (!document.outlineNodeId) {
      throw permanent(
        "document.outline_node.missing",
        "The manual settlement target is not bound to an outline node",
      );
    }
    return {
      document,
      version,
      outlineNode: this.story.requireOutlineNode(
        snapshot.run.projectId,
        document.outlineNodeId,
      ),
      content: version.content,
    };
  }

  /** An immutable chapter version selected for review without rewriting it. */
  private documentReviewTarget(snapshot: RunSnapshot): {
    document: Document;
    version: DocumentVersion;
    outlineNode: OutlineNode;
    content: string;
  } | null {
    if (snapshot.run.recipe !== "document-review") return null;
    const documentId = stringOrNull(snapshot.run.policy.documentId);
    const versionId = stringOrNull(snapshot.run.policy.documentVersionId);
    if (!documentId || !versionId) {
      throw permanent(
        "document_review.target.missing",
        "The review run is missing a manuscript version target",
      );
    }
    const document = this.documents.get(snapshot.run.projectId, documentId);
    if (!document) {
      throw permanent(
        "document.not_found",
        "The review target document does not exist",
      );
    }
    const version = this.documents.getVersion(
      snapshot.run.projectId,
      documentId,
      versionId,
    );
    if (!version) {
      throw permanent(
        "document.version.not_found",
        "The review target version does not exist",
      );
    }
    if (!document.outlineNodeId) {
      throw permanent(
        "document.outline_node.missing",
        "The review target is not bound to a chapter outline",
      );
    }
    if (document.outlineNodeId !== snapshot.run.targetOutlineNodeId) {
      throw permanent(
        "document_review.target.conflict",
        "The review target does not match the run chapter",
      );
    }
    return {
      document,
      version,
      outlineNode: this.story.requireOutlineNode(
        snapshot.run.projectId,
        document.outlineNodeId,
      ),
      content: version.content,
    };
  }

  /* 手动结算没有 context.compile 步骤：权威上下文直接用作者视角的故事
     状态包（历史时点正典、知情状态、时间线、伏笔的稳定 ID 都在其中）。 */
  private manualSettlementContext(
    projectId: string,
    outlineNodeId: string,
  ): string {
    const packet = this.storyState.build({
      projectId,
      audience: "author",
      targetOutlineNodeId: outlineNodeId,
    });
    return packet.sources
      .map((source) => `[${source.label}]\n${source.content}`)
      .join("\n\n");
  }

  /* 手动结算的收口：不追加版本、不绑审稿报告、不自动应用、不动大纲状态；
     只补检索实体绑定与 embedding、写章节摘要、落 candidate 变更集。 */
  private async commitManualSettlement(
    snapshot: RunSnapshot,
    step: NarrativeRunStep,
    manual: NonNullable<
      ReturnType<ChapterWorkerSuite["manualSettlementTarget"]>
    >,
    settlement: GroundedSettlement,
    signal: AbortSignal,
  ): Promise<StepExecutionResult> {
    const run = snapshot.run;
    const changeSetId = `${run.id}:canon-change-set`;
    const replayChangeSet = this.reviews.getCanonChangeSet(
      run.projectId,
      changeSetId,
    );
    if (replayChangeSet) {
      return {
        artifactKind: "chapter-commit",
        output: {
          documentId: manual.document.id,
          versionId: manual.version.id,
          contentHash: manual.version.contentHash,
          idempotentReplay: true,
          versionCreated: false,
          changeSetId,
          manualSettlement: true,
        },
        usage: zeroUsage(),
      };
    }
    const contentEmbedding = await optionalEmbeddings(
      this.model,
      run,
      step,
      "chapter-index",
      [manual.content],
      signal,
    );
    const now = this.now().toISOString();
    const output = this.database.transaction(() => {
      requireActiveRunCommit(this.database, run.id, run.projectId, signal);
      const boundSettlement = bindSettlementEvidence(
        settlement,
        manual.version.id,
      );
      const entityIds = settlementEntityIds(boundSettlement).filter((id) =>
        Boolean(this.canon.getEntity(run.projectId, id)),
      );
      this.retrieval.upsertSegment({
        id: `document:${manual.document.id}:current`,
        projectId: run.projectId,
        sourceType: "document_current",
        sourceId: manual.document.id,
        title: manual.document.title,
        content: manual.content,
        authority: "confirmed",
        metadata: {
          documentId: manual.document.id,
          documentVersionId: manual.version.id,
          outlineNodeId: manual.outlineNode.id,
          runId: run.id,
        },
        entityIds,
        createdAt: now,
        updatedAt: now,
      });
      if (contentEmbedding.vectors[0] && contentEmbedding.model) {
        this.retrieval.upsertEmbedding({
          segmentId: `document:${manual.document.id}:current`,
          model: contentEmbedding.model,
          embedding: contentEmbedding.vectors[0],
          updatedAt: now,
        });
      }
      this.state.upsertSummary({
        id: `${run.id}:summary`,
        projectId: run.projectId,
        scopeType: "chapter",
        scopeId: manual.outlineNode.id,
        summary: boundSettlement.summary,
        stateDelta: { changes: boundSettlement.stateDelta },
        sourceHash: manual.version.contentHash,
        createdAt: now,
      });
      /* 没有任何候选的手动结算（例如只修错字）不建空变更集，避免裁定面板出现噪音。 */
      const hasCandidates =
        boundSettlement.stateDelta.length > 0 ||
        boundSettlement.factCandidates.length > 0 ||
        boundSettlement.timelineCandidates.length > 0 ||
        boundSettlement.relationshipCandidates.length > 0 ||
        boundSettlement.foreshadowCandidates.length > 0;
      if (hasCandidates) {
        this.reviews.insertCanonChangeSet({
          id: changeSetId,
          projectId: run.projectId,
          runId: run.id,
          stepId: step.id,
          changes: boundSettlement,
          status: "candidate",
          createdAt: now,
        });
      }
      return {
        documentId: manual.document.id,
        versionId: manual.version.id,
        contentHash: manual.version.contentHash,
        idempotentReplay: false,
        versionCreated: false,
        changeSetId: hasCandidates ? changeSetId : null,
        settlementApplication: null,
        settlementConflict: null,
        manualSettlement: true,
        retrievalEmbedding: {
          model: contentEmbedding.model,
          modelId: contentEmbedding.modelId,
          warning: contentEmbedding.warning,
        },
      };
    });
    return {
      artifactKind: "chapter-commit",
      output,
      usage: contentEmbedding.usage,
    };
  }
}

function requiredArtifact(
  snapshot: RunSnapshot,
  kind: NarrativeRunStep["kind"],
): Record<string, unknown> {
  const output = [...snapshot.steps]
    .reverse()
    .find(
      (step) => step.kind === kind && step.status === "succeeded",
    )?.outputArtifact;
  if (!output) {
    throw permanent(
      "artifact.missing",
      `Missing confirmed artifact for step ${kind}`,
    );
  }
  return { ...output };
}

function latestGateArtifact(snapshot: RunSnapshot): Record<string, unknown> {
  const output = [...snapshot.steps]
    .reverse()
    .find(
      (step) =>
        step.status === "succeeded" &&
        (step.kind === "semantic.review" ||
          step.kind === "deterministic.check"),
    )?.outputArtifact;
  if (!output)
    throw permanent(
      "review.missing",
      "No quality gate artifact exists before revision",
    );
  return { ...output };
}

function finalContent(snapshot: RunSnapshot): string {
  const output = [...snapshot.steps]
    .reverse()
    .find(
      (step) =>
        step.status === "succeeded" &&
        (step.kind === "revision.generate" || step.kind === "draft.generate"),
    )?.outputArtifact;
  return output ? stringField(output, "content") : "";
}

function reviewSemanticIssues(
  review: ReviewResult,
  locator: ParagraphLocator,
): string[] {
  const issues: string[] = [];
  for (const [index, issue] of review.issues.entries()) {
    issues.push(
      ...locator.validate(
        issue.evidenceParagraphs,
        `issues.${index}.evidenceParagraphs`,
      ),
    );
  }
  return issues;
}

function groundReviewEvidence(
  review: DerivedReviewResult,
  locator: ParagraphLocator,
): GroundedReviewResult {
  return {
    ...review,
    issues: review.issues.map((issue) => {
      const evidence = locateEvidence(locator, issue.evidenceParagraphs);
      return {
        ...issue,
        evidence,
      };
    }),
  };
}

/** 剥掉模型把上下文标注语法（[node:…]、[timeline:…] 等）抄进 ID 值的前缀。
 *  返回规范化的结算对象；只重写字段值，不丢任何候选。 */
function stripContextTagPrefixes(settlement: Settlement): Settlement {
  const id = (value: string): string =>
    value.replace(
      /^(?:node|timeline|entity|foreshadow|relationship|fact):/,
      "",
    );
  const nullableId = (value: string | null): string | null =>
    value === null ? null : id(value);
  return {
    ...settlement,
    factCandidates: settlement.factCandidates.map((fact) => ({
      ...fact,
      subjectId: id(fact.subjectId),
      objectEntityId: nullableId(fact.objectEntityId),
      factId: nullableId(fact.factId),
      knowledgeSubjectId: nullableId(fact.knowledgeSubjectId),
    })),
    timelineCandidates: settlement.timelineCandidates.map((event) => ({
      ...event,
      participantIds: event.participantIds.map(id),
      causeEventIds: event.causeEventIds.map(id),
      knownBy: event.knownBy.map((knowledge) => ({
        ...knowledge,
        entityId: id(knowledge.entityId),
      })),
    })),
    relationshipCandidates: settlement.relationshipCandidates.map(
      (relation) => ({
        ...relation,
        relationshipId: nullableId(relation.relationshipId),
        fromEntityId: id(relation.fromEntityId),
        toEntityId: id(relation.toEntityId),
      }),
    ),
    foreshadowCandidates: settlement.foreshadowCandidates.map((foreshadow) => ({
      ...foreshadow,
      foreshadowId: nullableId(foreshadow.foreshadowId),
      targetFromNodeId: nullableId(foreshadow.targetFromNodeId),
      targetToNodeId: nullableId(foreshadow.targetToNodeId),
    })),
  };
}

function settlementSemanticIssues(
  settlement: Settlement,
  entityIds: ReadonlySet<string>,
  current: {
    facts: ReadonlyMap<string, CanonFact>;
    relationships: ReadonlyMap<string, RelationshipEvent>;
    timelineEventIds: ReadonlySet<string>;
    foreshadows: ReadonlyMap<string, Foreshadow>;
    outlineNodeIds: ReadonlySet<string>;
  },
  locator: ParagraphLocator,
): string[] {
  const issues: string[] = [];
  const requireEntity = (id: string, path: string) => {
    if (!entityIds.has(id)) issues.push(`${path}: 未知实体 ID ${id}`);
  };
  settlement.factCandidates.forEach((fact, index) => {
    const path = `factCandidates.${index}`;
    requireEntity(fact.subjectId, `factCandidates.${index}.subjectId`);
    if (fact.objectEntityId)
      requireEntity(
        fact.objectEntityId,
        `factCandidates.${index}.objectEntityId`,
      );
    if (fact.knowledgeSubjectId)
      requireEntity(
        fact.knowledgeSubjectId,
        `factCandidates.${index}.knowledgeSubjectId`,
      );
    if (
      fact.knowledgeScope === "character" &&
      fact.knowledgeSubjectId === null
    ) {
      issues.push(`${path}.knowledgeSubjectId: 角色认知必须指定知情角色`);
    }
    if (
      fact.knowledgeScope !== "character" &&
      fact.knowledgeSubjectId !== null
    ) {
      issues.push(
        `${path}.knowledgeSubjectId: knowledgeScope 为 ${fact.knowledgeScope} 时必须为 null（置空该字段；确属某个角色才知道的认知时改用 character 并填该角色 ID）`,
      );
    }
    if (fact.operation === "assert" && fact.factId !== null) {
      issues.push(`${path}.factId: assert 不得引用已有事实`);
    }
    if (fact.operation !== "assert") {
      const target = fact.factId ? current.facts.get(fact.factId) : null;
      if (!target) {
        issues.push(`${path}.factId: ${fact.operation} 必须引用当前事实 ID`);
      } else if (
        target.subjectId !== fact.subjectId ||
        target.predicate !== fact.predicate
      ) {
        issues.push(`${path}.factId: 引用事实与 subject/predicate 不一致`);
      }
    }
    issues.push(
      ...locator.validate(
        fact.evidenceParagraphs,
        `factCandidates.${index}.evidenceParagraphs`,
      ),
    );
  });
  settlement.timelineCandidates.forEach((event, index) => {
    event.participantIds.forEach((id) =>
      requireEntity(id, `timelineCandidates.${index}.participantIds`),
    );
    event.knownBy.forEach((knowledge, knowledgeIndex) =>
      requireEntity(
        knowledge.entityId,
        `timelineCandidates.${index}.knownBy.${knowledgeIndex}.entityId`,
      ),
    );
    event.causeEventIds.forEach((id) => {
      if (!current.timelineEventIds.has(id)) {
        issues.push(
          `timelineCandidates.${index}.causeEventIds: 未知时间线事件 ID ${id}（只能引用上下文中 [timeline:…] 标注的事件 ID）`,
        );
      }
    });
    issues.push(
      ...locator.validate(
        event.evidenceParagraphs,
        `timelineCandidates.${index}.evidenceParagraphs`,
      ),
    );
  });
  settlement.relationshipCandidates.forEach((relation, index) => {
    const path = `relationshipCandidates.${index}`;
    requireEntity(
      relation.fromEntityId,
      `relationshipCandidates.${index}.fromEntityId`,
    );
    if (relation.action === "start" && relation.relationshipId !== null) {
      issues.push(`${path}.relationshipId: start 不得引用已有关系`);
    }
    if (relation.action !== "start") {
      const target = relation.relationshipId
        ? current.relationships.get(relation.relationshipId)
        : null;
      if (!target) {
        issues.push(
          `${path}.relationshipId: ${relation.action} 必须引用当前关系 ID`,
        );
      } else if (
        target.fromEntityId !== relation.fromEntityId ||
        target.toEntityId !== relation.toEntityId
      ) {
        issues.push(`${path}.relationshipId: 引用关系的双方不一致`);
      }
    }
    requireEntity(
      relation.toEntityId,
      `relationshipCandidates.${index}.toEntityId`,
    );
    issues.push(
      ...locator.validate(
        relation.evidenceParagraphs,
        `relationshipCandidates.${index}.evidenceParagraphs`,
      ),
    );
  });
  settlement.foreshadowCandidates.forEach((foreshadow, index) => {
    const path = `foreshadowCandidates.${index}`;
    if (foreshadow.action === "plant") {
      if (foreshadow.foreshadowId !== null)
        issues.push(
          `${path}.foreshadowId: plant 不得引用已有伏笔（新埋伏笔不填 foreshadowId 与 expectedStatus）`,
        );
      if (foreshadow.expectedStatus !== null)
        issues.push(
          `${path}.expectedStatus: plant 不得填写已有状态（新埋伏笔不填 foreshadowId 与 expectedStatus）`,
        );
    } else {
      const target = foreshadow.foreshadowId
        ? current.foreshadows.get(foreshadow.foreshadowId)
        : null;
      if (!target) {
        issues.push(
          `${path}.foreshadowId: ${foreshadow.action} 必须引用已有伏笔 ID`,
        );
      } else if (target.status !== foreshadow.expectedStatus) {
        issues.push(
          `${path}.expectedStatus: 应填该伏笔当前的状态 ${target.status}（乐观并发检查，不是你想改成的新状态；新状态由 action 决定）`,
        );
      }
    }
    for (const [field, id] of [
      ["targetFromNodeId", foreshadow.targetFromNodeId],
      ["targetToNodeId", foreshadow.targetToNodeId],
    ] as const) {
      if (id && !current.outlineNodeIds.has(id))
        issues.push(
          `${path}.${field}: 未知大纲节点 ID ${id}（只能引用上下文中 [node:…] 标注的节点 ID）`,
        );
    }
    issues.push(
      ...locator.validate(
        foreshadow.evidenceParagraphs,
        `foreshadowCandidates.${index}.evidenceParagraphs`,
      ),
    );
  });
  settlement.stateDelta.forEach((change, index) => {
    issues.push(
      ...locator.validate(
        change.evidenceParagraphs,
        `stateDelta.${index}.evidenceParagraphs`,
      ),
    );
  });
  return issues;
}

function groundSettlementEvidence(
  settlement: Settlement,
  locator: ParagraphLocator,
): GroundedSettlement {
  return {
    ...settlement,
    stateDelta: settlement.stateDelta.map((change) => ({
      ...change,
      evidence: locateEvidence(locator, change.evidenceParagraphs),
    })),
    factCandidates: settlement.factCandidates.map((candidate) => ({
      ...candidate,
      evidence: locateEvidence(locator, candidate.evidenceParagraphs),
    })),
    timelineCandidates: settlement.timelineCandidates.map((candidate) => ({
      ...candidate,
      evidence: locateEvidence(locator, candidate.evidenceParagraphs),
    })),
    relationshipCandidates: settlement.relationshipCandidates.map(
      (candidate) => ({
        ...candidate,
        evidence: locateEvidence(locator, candidate.evidenceParagraphs),
      }),
    ),
    foreshadowCandidates: settlement.foreshadowCandidates.map((candidate) => ({
      ...candidate,
      evidence: locateEvidence(locator, candidate.evidenceParagraphs),
    })),
  };
}

type GroundedReviewResult = Omit<DerivedReviewResult, "issues"> & {
  issues: Array<
    DerivedReviewResult["issues"][number] & {
      evidence: GroundedParagraphEvidence[];
    }
  >;
};

function locateEvidence(
  locator: ParagraphLocator,
  ordinals: readonly number[],
): GroundedParagraphEvidence[] {
  try {
    return locator.locate(ordinals);
  } catch (error) {
    if (error instanceof ParagraphLocatorError) {
      throw permanent(error.code, error.message);
    }
    throw error;
  }
}

function bindSettlementEvidence(
  settlement: GroundedSettlement,
  documentVersionId: string,
): GroundedSettlement {
  const bind = <T extends { evidence: GroundedParagraphEvidence[] }>(
    item: T,
  ) => ({
    ...item,
    evidence: bindEvidenceDocumentVersion(item.evidence, documentVersionId),
  });
  return {
    ...settlement,
    stateDelta: settlement.stateDelta.map(bind),
    factCandidates: settlement.factCandidates.map(bind),
    timelineCandidates: settlement.timelineCandidates.map(bind),
    relationshipCandidates: settlement.relationshipCandidates.map(bind),
    foreshadowCandidates: settlement.foreshadowCandidates.map(bind),
  };
}

function settlementEntityIds(settlement: Record<string, unknown>): string[] {
  const ids = new Set<string>();
  for (const key of [
    "factCandidates",
    "timelineCandidates",
    "relationshipCandidates",
  ]) {
    const entries = Array.isArray(settlement[key]) ? settlement[key] : [];
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      for (const field of [
        "subjectId",
        "objectEntityId",
        "fromEntityId",
        "toEntityId",
      ]) {
        if (typeof entry[field] === "string") ids.add(entry[field]);
      }
      if (Array.isArray(entry.participantIds)) {
        entry.participantIds.forEach((id) => {
          if (typeof id === "string") ids.add(id);
        });
      }
    }
  }
  return [...ids];
}

function buildTextDiff(before: string, after: string): Record<string, unknown> {
  let prefix = 0;
  const maxPrefix = Math.min(before.length, after.length);
  while (prefix < maxPrefix && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return {
    prefixCharacters: prefix,
    removed: before.slice(prefix, before.length - suffix),
    inserted: after.slice(prefix, after.length - suffix),
    suffixCharacters: suffix,
  };
}

function cleanManuscript(value: string): string {
  return value
    .trim()
    .replace(/^```(?:markdown|text)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

function revisionManuscript(value: string): string {
  const fenced =
    /^\s*```(?:markdown|text)?[\t ]*\r?\n([\s\S]*?)\r?\n```\s*$/iu.exec(value);
  return fenced?.[1] ?? value;
}

/**
 * Empty output means the model declines to change the manuscript. Apart from
 * CRLF/CR normalization, every whitespace/indentation/paragraph edit remains
 * a real revision.
 */
export function isRevisionNoop(base: string, candidate: string): boolean {
  return (
    candidate.length === 0 ||
    normalizeLineEndings(candidate) === normalizeLineEndings(base)
  );
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/gu, "\n");
}

function repeatedPhraseEvidence(
  content: string,
  phraseLength: number,
  threshold: number,
): string | null {
  const normalized = content.replace(/\s+/g, "");
  const counts = new Map<string, number>();
  for (let index = 0; index + phraseLength <= normalized.length; index += 3) {
    const phrase = normalized.slice(index, index + phraseLength);
    if (/^[\p{P}\p{S}]+$/u.test(phrase)) continue;
    const count = (counts.get(phrase) ?? 0) + 1;
    if (count >= threshold) return phrase;
    counts.set(phrase, count);
  }
  return null;
}

function repeatedCliche(content: string): string | null {
  const patterns = [
    "不禁",
    "仿佛",
    "宛如",
    "一丝",
    "嘴角勾起",
    "眼底闪过",
    "空气仿佛凝固",
  ];
  for (const pattern of patterns) {
    let count = 0;
    let offset = 0;
    while ((offset = content.indexOf(pattern, offset)) >= 0) {
      count += 1;
      offset += pattern.length;
    }
    if (count >= 5) return `${pattern}（${count} 次）`;
  }
  return null;
}

function paragraphs(content: string): string[] {
  return content
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
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

/**
 * Reads the continuation prefix persisted in run.policy by the partial
 * continue endpoint. Blank/missing values mean a normal from-scratch draft.
 */
function continuationPrefixOf(
  policy: Readonly<Record<string, unknown>>,
): string | null {
  const value = policy.continuationPrefix;
  return typeof value === "string" && value.trim() ? value : null;
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string") {
    throw permanent(
      "artifact.field.invalid",
      `Artifact field ${key} is not a string`,
    );
  }
  return field;
}

function purposeContextText(
  artifact: Record<string, unknown>,
  purpose: string,
): string {
  const contexts = artifact.contexts;
  if (!isRecord(contexts) || !isRecord(contexts[purpose])) {
    throw permanent(
      "context.purpose.missing",
      `Missing the dedicated context for purpose ${purpose}`,
    );
  }
  return stringField(contexts[purpose], "text");
}

function isOutputLimitFinish(value: unknown): boolean {
  return value === "length" || value === "context_length";
}

function stableContextInventory(sources: readonly ContextSource[]): string {
  return JSON.stringify(
    sources.map((source) => ({
      id: source.id,
      kind: source.kind,
      label: source.label,
      content: source.content,
      summary: source.summary ?? null,
      authority: source.authority,
      priority: source.priority,
      required: source.required ?? false,
      compressible: source.compressible ?? true,
      sourceType: source.sourceType,
      sourceId: source.sourceId ?? null,
      metadata: source.metadata ?? null,
    })),
  );
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function chapterWritingReference(
  artifact: Readonly<Record<string, unknown>>,
): { targetCharacters: number; compassVersion: number } | null {
  const reference = artifact.chapterWritingReference;
  if (!isRecord(reference)) return null;
  const targetCharacters = reference.targetCharacters;
  const compassVersion = reference.compassVersion;
  return typeof targetCharacters === "number" &&
    Number.isInteger(targetCharacters) &&
    targetCharacters > 0 &&
    typeof compassVersion === "number" &&
    Number.isInteger(compassVersion) &&
    compassVersion > 0
    ? { targetCharacters, compassVersion }
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sha256(value: string): string {
  return sha256Hex(value);
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

function permanent(code: string, message: string) {
  return { code, message, retryable: false };
}

function retryable(code: string, message: string) {
  return { code, message, retryable: true };
}
