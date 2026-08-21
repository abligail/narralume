import { sha256Hex } from "@narralume/domain";

import { ContextCompiler, type ContextSource } from "@narralume/context";
import {
  createDocument,
  createOutlineNode,
  validateTextRange,
  type NarrativeRunStep,
  type RunBudgetUsage,
  type RunSnapshot,
  type StoryTurn,
} from "@narralume/domain";
import type {
  StepExecutionResult,
  StepWorker,
  WorkerRegistry,
} from "@narralume/harness";
import {
  SqliteCanonRepository,
  SqliteContextReceiptRepository,
  SqliteCreativeRepository,
  SqliteDocumentRepository,
  SqliteDeliveryRepository,
  SqliteNarrativeStateRepository,
  SqliteProjectRepository,
  SqliteRetrievalRepository,
  SqliteReviewRepository,
  SqliteStoryRepository,
  type NarrativeDatabase,
} from "@narralume/persistence";

import type { NarrativeModelClient } from "./model-client.js";
import {
  optionalEmbeddings,
  recordEmbeddingDegradation,
} from "./embedding-support.js";
import { outlineContextSources } from "./outline-context.js";
import { StoryStatePacketBuilder } from "./story-state-packet.js";
import {
  ADOPTION_RESULT_CONTRACT,
  AdoptionResultSchema,
  COCREATE_RESPONSE_CONTRACT,
  collaborationValidator,
  CoCreateResponseSchema,
  GroundedAdoptionResultSchema,
  SELECTION_EDIT_CONTRACT,
  SelectionEditResultSchema,
} from "./collaboration-schemas.js";
import {
  ParagraphLocator,
  bindEvidenceDocumentVersion,
} from "./paragraph-locator.js";
import {
  requireActiveProject,
  requireActiveRunCommit,
} from "./project-guard.js";

export class CollaborationWorkerSuite {
  private readonly creative: SqliteCreativeRepository;
  private readonly projects: SqliteProjectRepository;
  private readonly story: SqliteStoryRepository;
  private readonly canon: SqliteCanonRepository;
  private readonly documents: SqliteDocumentRepository;
  private readonly receipts: SqliteContextReceiptRepository;
  private readonly retrieval: SqliteRetrievalRepository;
  private readonly reviews: SqliteReviewRepository;
  private readonly state: SqliteNarrativeStateRepository;
  private readonly delivery: SqliteDeliveryRepository;
  private readonly compiler: ContextCompiler;
  private readonly storyState: StoryStatePacketBuilder;

  constructor(
    private readonly database: NarrativeDatabase,
    private readonly model: NarrativeModelClient,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.creative = new SqliteCreativeRepository(database);
    this.projects = new SqliteProjectRepository(database);
    this.story = new SqliteStoryRepository(database);
    this.canon = new SqliteCanonRepository(database);
    this.documents = new SqliteDocumentRepository(database);
    this.receipts = new SqliteContextReceiptRepository(database);
    this.retrieval = new SqliteRetrievalRepository(database);
    this.reviews = new SqliteReviewRepository(database);
    this.state = new SqliteNarrativeStateRepository(
      database,
      this.canon,
      this.story,
    );
    this.delivery = new SqliteDeliveryRepository(database);
    this.compiler = new ContextCompiler(now);
    this.storyState = new StoryStatePacketBuilder(
      this.canon,
      this.state,
      this.story,
    );
  }

  registry(): WorkerRegistry {
    return {
      "cocreate.context": this.worker(this.compileRoomContext.bind(this)),
      "cocreate.respond": this.worker(this.generateRoomResponse.bind(this)),
      "cocreate.stage": this.worker(this.stageRoomResponse.bind(this)),
      "adoption.prepare": this.worker(this.prepareAdoption.bind(this)),
      "adoption.settle": this.worker(this.settleAdoption.bind(this)),
      "adoption.commit": this.worker(this.commitAdoption.bind(this)),
      "edit.transform": this.worker(this.transformSelection.bind(this)),
      "edit.stage": this.worker(this.stageSelectionEdit.bind(this)),
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

  private async compileRoomContext(
    snapshot: RunSnapshot,
    step: NarrativeRunStep,
    signal: AbortSignal,
  ): Promise<StepExecutionResult> {
    const sessionId = policyString(snapshot.run.policy, "sessionId");
    const session = this.creative.requireSession(sessionId);
    if (session.status !== "active") {
      throw permanent(
        "cocreate.session.inactive",
        "The co-create session cannot generate right now",
      );
    }
    const branchId =
      policyOptionalString(snapshot.run.policy, "branchId") ??
      session.activeBranchId;
    if (!branchId)
      throw permanent(
        "cocreate.branch.missing",
        "The session has no active branch",
      );
    const branch = this.creative.requireBranch(branchId);
    if (branch.sessionId !== session.id) {
      throw permanent(
        "cocreate.branch.mismatch",
        "The active branch does not belong to the current session",
      );
    }
    const project = this.projects.get(session.projectId);
    if (!project) throw permanent("project.not_found", "Project not found");
    const participants = this.creative
      .requireSessionDetail(session.id)
      .participants.filter(
        (participant) =>
          participant.enabled && participant.persona.status === "active",
      );
    if (participants.length === 0) {
      throw permanent(
        "cocreate.participants.empty",
        "At least one AI participant must be enabled",
      );
    }
    const allowedSpeakerIds = participants.map(
      (participant) => participant.personaId,
    );
    const branchTurns = this.creative.listBranchTurns(branch.id);
    const expectedSpeakerId = chooseSpeaker(
      session.speakerPolicy,
      policyOptionalString(snapshot.run.policy, "speakerPersonaId"),
      participants,
      branchTurns,
    );
    const visibleTurns = branchTurns.slice(-session.contextTurns);
    const personaById = new Map(
      [
        ...participants.map((participant) => participant.persona),
        ...(session.authorPersonaId
          ? [this.creative.requirePersona(session.authorPersonaId)]
          : []),
      ].map((persona) => [persona.id, persona]),
    );
    const sources: ContextSource[] = [
      {
        id: `room-task:${session.id}`,
        kind: "task",
        label: "共创回合任务",
        content: [
          `作品：《${project.title}》`,
          project.premise ? `命题：${project.premise}` : "",
          `会话：${session.title}`,
          `发言策略：${session.speakerPolicy}`,
          expectedSpeakerId
            ? `本轮必须由 Persona ${expectedSpeakerId} 发言。`
            : "从允许的 Persona 中选择最自然的下一位发言者。",
        ]
          .filter(Boolean)
          .join("\n"),
        authority: "locked",
        priority: 100,
        required: true,
        compressible: false,
        sourceType: "cocreate_session",
        sourceId: session.id,
      },
      {
        id: `room-personas:${session.id}`,
        kind: "session",
        label: "在场 Persona",
        content: participants
          .map(
            ({ persona, talkativeness }) =>
              `- ${persona.id}｜${persona.name}｜${persona.kind}｜发言倾向 ${talkativeness}\n  设定：${persona.description ?? "未补充"}\n  表演指令：${persona.instructions || "保持角色一致"}\n  声线：${JSON.stringify(persona.voice)}`,
          )
          .join("\n"),
        authority: "locked",
        priority: 99,
        required: true,
        compressible: false,
        sourceType: "story_persona",
        sourceId: session.id,
      },
    ];
    const activeStyle = this.delivery.getActiveStyleProfile(session.projectId);
    if (activeStyle) {
      sources.push({
        id: `style:${activeStyle.id}`,
        kind: "style",
        label: `启用风格 · ${activeStyle.name}`,
        content: [
          activeStyle.description ?? "",
          ...activeStyle.rules.map((rule) => `必须：${rule}`),
          ...activeStyle.negativeRules.map((rule) => `避免：${rule}`),
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
      session.projectId,
      "cocreate",
    )) {
      sources.push({
        id: `skill:${skill.id}`,
        kind: "system",
        label: `共创 Skill · ${skill.name}`,
        content: skill.instructions,
        authority: "locked",
        priority: 90 + skill.priority / 20,
        required: skill.priority >= 80,
        compressible: skill.priority < 80,
        sourceType: "writing_skill",
        sourceId: skill.id,
      });
    }
    if (session.directorNote) {
      sources.push({
        id: `director-note:${session.id}`,
        kind: "author-intent",
        label: "当前 Author's Note / 导演注",
        content: session.directorNote,
        authority: "locked",
        priority: 100,
        required: true,
        compressible: false,
        sourceType: "director_note",
        sourceId: session.id,
      });
    }
    const intent = this.story.getAuthorIntent(session.projectId);
    if (intent) {
      sources.push({
        id: "author-intent",
        kind: "author-intent",
        label: "作者锁定意图",
        content: JSON.stringify(intent),
        authority: "locked",
        priority: 98,
        required: true,
        compressible: false,
        sourceType: "author_intent",
        sourceId: session.projectId,
      });
    }
    const transcript = visibleTurns
      .map((turn) => {
        const persona = turn.personaId ? personaById.get(turn.personaId) : null;
        return `[${turn.role.toUpperCase()}${persona ? `:${persona.name}` : ""}] ${turn.content}`;
      })
      .join("\n\n");
    if (transcript) {
      sources.push({
        id: `transcript:${branch.id}`,
        kind: "session",
        label: "当前分支最近回合",
        content: transcript,
        authority: "confirmed",
        priority: 97,
        required: true,
        compressible: false,
        sourceType: "story_branch",
        sourceId: branch.id,
      });
    }
    const branchSummary = this.state.latestSummary(
      session.projectId,
      "session",
      branch.id,
    );
    if (branchSummary && branchTurns.length > visibleTurns.length) {
      sources.push({
        id: `branch-summary:${branch.id}`,
        kind: "summary",
        label: "当前分支较早回合摘要",
        content: branchSummary.summary,
        authority: "confirmed",
        priority: 84,
        sourceType: "narrative_summary",
        sourceId: branchSummary.id,
      });
    }
    const outline = this.story.listOutline(session.projectId);
    if (outline.length > 0) {
      sources.push(
        ...outlineContextSources({
          projectId: session.projectId,
          outline,
          chapterSummaries: this.state.listLatestSummaries(
            session.projectId,
            "chapter",
          ),
          targetOutlineNodeId: session.targetOutlineNodeId,
        }),
      );
    }
    const speakerPersona = expectedSpeakerId
      ? personaById.get(expectedSpeakerId)
      : null;
    const storyStatePacket = this.storyState.build({
      projectId: session.projectId,
      audience:
        speakerPersona?.kind === "character" && speakerPersona.entityId
          ? "character"
          : speakerPersona?.kind === "author"
            ? "author"
            : "reader",
      ...(speakerPersona?.entityId
        ? { characterId: speakerPersona.entityId }
        : {}),
      targetOutlineNodeId: session.targetOutlineNodeId,
    });
    sources.push(...storyStatePacket.sources);
    const retrievalQuery = [
      session.title,
      session.directorNote,
      ...visibleTurns.slice(-3).map((turn) => turn.content),
    ]
      .filter((value): value is string => Boolean(value?.trim()))
      .join(" ");
    const queryEmbedding = await optionalEmbeddings(
      this.model,
      snapshot.run,
      step,
      "cocreate-retrieval-query",
      retrievalQuery ? [retrievalQuery] : [],
      signal,
    );
    recordEmbeddingDegradation(
      this.database,
      snapshot.run.id,
      step.id,
      queryEmbedding.degradation,
    );
    for (const hit of this.retrieval.search(session.projectId, retrievalQuery, {
      entityIds: [speakerPersona?.entityId].filter((value): value is string =>
        Boolean(value),
      ),
      limit: 6,
      rerank: false,
      ...(queryEmbedding.vectors[0]
        ? { queryEmbedding: queryEmbedding.vectors[0] }
        : {}),
      ...(queryEmbedding.model ? { embeddingModel: queryEmbedding.model } : {}),
    })) {
      sources.push({
        id: `cocreate-retrieval:${hit.id}`,
        kind: "retrieval",
        label: hit.title || `${hit.sourceType}:${hit.sourceId}`,
        content: hit.content,
        authority: hit.authority === "locked" ? "locked" : "confirmed",
        priority: 60 + Math.round(hit.score * 100),
        sourceType: hit.sourceType,
        sourceId: hit.sourceId,
        metadata: { retrievalReasons: hit.reasons },
      });
    }
    const compiled = this.compiler.compile({
      projectId: session.projectId,
      purpose: "cocreate-response",
      budget: {
        contextWindow:
          this.model.effectiveContextWindow?.(
            snapshot.run,
            "cocreate-response",
          ) ?? policyNumber(snapshot.run.policy, "contextWindow", 32_000),
        outputReserve: Math.min(
          policyNumber(snapshot.run.policy, "replyMaxOutputTokens", 3_000),
          this.model.effectiveOutputLimit?.(
            snapshot.run,
            "cocreate-response",
          ) ?? 3_000,
        ),
        fixedInstructionReserve: 1_200,
        toolReserve: 0,
        schemaReserve: 800,
      },
      sources,
    });
    this.receipts.insert(
      queryEmbedding.degradation
        ? { ...compiled.receipt, degradations: [queryEmbedding.degradation] }
        : compiled.receipt,
      {
        runId: snapshot.run.id,
        stepId: step.id,
      },
    );
    return {
      artifactKind: "cocreate-context",
      output: {
        sessionId,
        branchId,
        context: compiled.text,
        contextReceiptId: compiled.receipt.id,
        allowedSpeakerIds,
        expectedSpeakerId,
        storyStateFingerprint: storyStatePacket.fingerprint,
        storyStateCounts: storyStatePacket.counts,
        retrievalEmbedding: {
          model: queryEmbedding.model,
          modelId: queryEmbedding.modelId,
          warning: queryEmbedding.warning,
        },
      },
      usage: queryEmbedding.usage,
    };
  }

  private async generateRoomResponse(
    snapshot: RunSnapshot,
    step: NarrativeRunStep,
    signal: AbortSignal,
  ): Promise<StepExecutionResult> {
    const context = requiredArtifact(snapshot, "cocreate.context");
    const allowed = stringArray(context.allowedSpeakerIds);
    const expected = optionalString(context.expectedSpeakerId);
    const result = await this.model.structured(
      snapshot.run,
      step,
      "cocreate-response",
      {
        instructions: [
          "你在小说共创房间中扮演角色或叙述者。延续当前局面，用具体行动、对白和感官细节推进一小步。",
          "不得替作者发言，不得解释模型行为，不得把导演注原样写进故事。保持角色认知边界。",
          "每次只生成一个自然回合；content 直接可读，不加姓名前缀或 Markdown 围栏。",
          expected
            ? `speakerPersonaId 必须严格等于 ${expected}。`
            : `speakerPersonaId 必须从以下 ID 中选择：${allowed.join(", ")}。`,
          "suggestedCanonFacts 只是候选，不宣告已进入正典。",
        ].join("\n"),
        messages: [{ role: "user", content: stringField(context, "context") }],
        reasoningEffort: "low",
        maxOutputTokens: policyNumber(
          snapshot.run.policy,
          "replyMaxOutputTokens",
          3_000,
        ),
      },
      COCREATE_RESPONSE_CONTRACT,
      collaborationValidator(CoCreateResponseSchema, (value) => {
        const issues: string[] = [];
        if (!allowed.includes(value.speakerPersonaId)) {
          issues.push("speakerPersonaId: 不在当前启用参与者中");
        }
        if (expected && value.speakerPersonaId !== expected) {
          issues.push(`speakerPersonaId: 本轮必须为 ${expected}`);
        }
        return issues;
      }),
      signal,
    );
    return {
      artifactKind: "cocreate-response",
      output: {
        ...result.value,
        generation: { mode: result.mode, attempts: result.attempts },
      },
      usage: result.usage,
    };
  }

  private async stageRoomResponse(
    snapshot: RunSnapshot,
  ): Promise<StepExecutionResult> {
    const context = requiredArtifact(snapshot, "cocreate.context");
    const response = CoCreateResponseSchema.parse(
      requiredArtifact(snapshot, "cocreate.respond"),
    );
    const now = this.now().toISOString();
    const staged = this.creative.stageAssistantSwipe({
      swipeId: `${snapshot.run.id}:swipe`,
      turnId: policyOptionalString(snapshot.run.policy, "targetTurnId"),
      newTurnId: `${snapshot.run.id}:turn`,
      sessionId: stringField(context, "sessionId"),
      branchId: stringField(context, "branchId"),
      speakerPersonaId: response.speakerPersonaId,
      content: response.content,
      sourceRunId: snapshot.run.id,
      metadata: {
        intent: response.intent,
        emotionalShift: response.emotionalShift,
        suggestedCanonFacts: response.suggestedCanonFacts,
      },
      now,
    });
    const branchTurns = this.creative.listBranchTurns(staged.turn.branchId);
    const branchSummary = branchTurns
      .slice(-60)
      .map(
        (turn) =>
          `[${turn.role}${turn.personaId ? `:${turn.personaId}` : ""}] ${clipText(turn.content, 280)}`,
      )
      .join("\n");
    const summaryHash = sha256Hex(branchSummary);
    this.state.upsertSummary({
      id: `${staged.turn.branchId}:summary:${summaryHash.slice(0, 16)}`,
      projectId: staged.turn.projectId,
      scopeType: "session",
      scopeId: staged.turn.branchId,
      summary: branchSummary,
      stateDelta: { turnCount: branchTurns.length },
      sourceHash: summaryHash,
      createdAt: now,
    });
    return {
      artifactKind: "cocreate-swipe",
      output: {
        turnId: staged.turn.id,
        swipeId: staged.swipe.id,
        speakerPersonaId: response.speakerPersonaId,
      },
      usage: zeroUsage(),
    };
  }

  private async prepareAdoption(
    snapshot: RunSnapshot,
  ): Promise<StepExecutionResult> {
    const sessionId = policyString(snapshot.run.policy, "sessionId");
    const branchId = policyString(snapshot.run.policy, "branchId");
    const fromTurnId = policyString(snapshot.run.policy, "fromTurnId");
    const toTurnId = policyString(snapshot.run.policy, "toTurnId");
    const session = this.creative.requireSession(sessionId);
    const branch = this.creative.requireBranch(branchId);
    if (branch.sessionId !== session.id) {
      throw permanent(
        "adoption.scope.mismatch",
        "The branch of the adoption range does not belong to the current session",
      );
    }
    const turns = this.creative.listBranchTurns(branchId);
    const fromIndex = turns.findIndex((turn) => turn.id === fromTurnId);
    const toIndex = turns.findIndex((turn) => turn.id === toTurnId);
    if (fromIndex < 0 || toIndex < fromIndex) {
      throw permanent(
        "adoption.range.invalid",
        "The adoption range is outside the current branch or in an invalid order",
      );
    }
    const selected = turns.slice(fromIndex, toIndex + 1);
    const transcript = selected
      .map((turn) => {
        const persona = turn.personaId
          ? this.creative.requirePersona(turn.personaId).name
          : turn.role === "director"
            ? "导演注"
            : "作者";
        return `[${turn.role}:${persona}] ${turn.content}`;
      })
      .join("\n\n");
    return {
      artifactKind: "adoption-source",
      output: {
        sessionId: session.id,
        branchId,
        fromTurnId,
        toTurnId,
        requestedTitle: policyString(snapshot.run.policy, "title"),
        transcript,
        selectedTurnIds: selected.map((turn) => turn.id),
      },
      usage: zeroUsage(),
    };
  }

  private async settleAdoption(
    snapshot: RunSnapshot,
    step: NarrativeRunStep,
    signal: AbortSignal,
  ): Promise<StepExecutionResult> {
    const source = requiredArtifact(snapshot, "adoption.prepare");
    const session = this.creative.requireSession(
      stringField(source, "sessionId"),
    );
    const intent = this.story.getAuthorIntent(session.projectId);
    const adoptionGuidance = {
      style: this.delivery.getActiveStyleProfile(session.projectId),
      skills: this.delivery.listApplicableSkills(session.projectId, "cocreate"),
    };
    const result = await this.model.structured(
      snapshot.run,
      step,
      "cocreate-adoption",
      {
        instructions: [
          "把已选共创回合整理成可进入正文的小说场景。导演注是改写指令，不得原样出现在 sceneContent。",
          "保留发生过的行动、对白含义与角色能动性，补足必要的叙述连接，但不要擅自增加重大事件。",
          "sceneContent 只输出场景正文，不含标题或 Markdown 围栏。canonCandidates 仅列正文有直接证据的新事实，并用 evidenceParagraphs 返回 sceneContent 中从 1 开始的段落序号；多段证据使用数组。",
        ].join("\n"),
        messages: [
          {
            role: "user",
            content: [
              `期望标题：${stringField(source, "requestedTitle")}`,
              `作者意图：${JSON.stringify(intent)}`,
              `已启用风格与 Skill：${JSON.stringify(adoptionGuidance)}`,
              `所选回合：\n${stringField(source, "transcript")}`,
            ].join("\n\n"),
          },
        ],
        reasoningEffort: "low",
        maxOutputTokens: policyNumber(
          snapshot.run.policy,
          "adoptionMaxOutputTokens",
          8_000,
        ),
      },
      ADOPTION_RESULT_CONTRACT,
      collaborationValidator(AdoptionResultSchema, (value) => {
        const locator = new ParagraphLocator(value.sceneContent);
        return value.canonCandidates.flatMap((candidate, index) =>
          locator.validate(
            candidate.evidenceParagraphs,
            `canonCandidates.${index}.evidenceParagraphs`,
          ),
        );
      }),
      signal,
    );
    const locator = new ParagraphLocator(result.value.sceneContent);
    const grounded = {
      ...result.value,
      canonCandidates: result.value.canonCandidates.map((candidate) => ({
        ...candidate,
        evidence: locator.locate(candidate.evidenceParagraphs),
      })),
    };
    return {
      artifactKind: "adoption-draft",
      output: {
        ...grounded,
        generation: { mode: result.mode, attempts: result.attempts },
      },
      usage: result.usage,
    };
  }

  private async commitAdoption(
    snapshot: RunSnapshot,
    step: NarrativeRunStep,
    signal: AbortSignal,
  ): Promise<StepExecutionResult> {
    const source = requiredArtifact(snapshot, "adoption.prepare");
    const draft = GroundedAdoptionResultSchema.parse(
      requiredArtifact(snapshot, "adoption.settle"),
    );
    const session = this.creative.requireSession(
      stringField(source, "sessionId"),
    );
    const replay = this.creative
      .listSceneAdoptions(session.id)
      .find((adoption) => adoption.runId === snapshot.run.id);
    if (replay) {
      return {
        artifactKind: "scene-adoption",
        output: { ...replay, idempotentReplay: true },
        usage: zeroUsage(),
      };
    }
    this.requireActiveAdoptionSource(session.id, source);
    const contentEmbedding = await optionalEmbeddings(
      this.model,
      snapshot.run,
      step,
      "cocreate-scene-index",
      [draft.sceneContent],
      signal,
    );
    const now = this.now().toISOString();
    const result = this.database.transaction(() => {
      requireActiveRunCommit(
        this.database,
        snapshot.run.id,
        session.projectId,
        signal,
      );
      this.requireActiveAdoptionSource(session.id, source);
      const outline = this.story.listOutline(session.projectId);
      const root = outline.find((node) => node.kind === "book");
      if (!root)
        throw permanent(
          "outline.root.missing",
          "Project is missing the book root node",
        );
      // 采纳目标以 Run 创建时的快照为准（CR-59）：会话的 targetOutlineNodeId
      // 是可变字段，执行期间被改动不应改变本次采纳的落点。
      const target = snapshot.run.targetOutlineNodeId
        ? this.story.getOutlineNode(
            session.projectId,
            snapshot.run.targetOutlineNodeId,
          )
        : null;
      let chapter =
        target?.kind === "chapter"
          ? target
          : target?.kind === "scene" && target.parentId
            ? this.story.getOutlineNode(session.projectId, target.parentId)
            : null;
      chapter =
        chapter ??
        [...outline]
          .reverse()
          .find(
            (node) => node.kind === "chapter" && node.status !== "abandoned",
          ) ??
        null;
      if (!chapter || chapter.kind !== "chapter") {
        chapter = this.story.insertOutlineNode(
          createOutlineNode({
            id: `${snapshot.run.id}:chapter`,
            projectId: session.projectId,
            parent: root,
            kind: "chapter",
            ordinal: this.story.listOutlineChildren(session.projectId, root.id)
              .length,
            title: `共创章节 · ${draft.sceneTitle}`,
            summary: draft.summary,
            now,
          }),
        );
      }
      const scene = this.story.insertOutlineNode(
        createOutlineNode({
          id: `${snapshot.run.id}:scene`,
          projectId: session.projectId,
          parent: chapter,
          kind: "scene",
          ordinal: this.story.listOutlineChildren(session.projectId, chapter.id)
            .length,
          title: draft.sceneTitle,
          summary: draft.summary,
          metadata: {
            source: "cocreate-adoption",
            sessionId: session.id,
            branchId: stringField(source, "branchId"),
          },
          now,
        }),
      );
      const baseTitle = draft.sceneTitle;
      const duplicateTitle = this.documents
        .list(session.projectId, "scene")
        .some((document) => document.title === baseTitle);
      const document = this.documents.insert(
        createDocument({
          id: `${snapshot.run.id}:scene-document`,
          projectId: session.projectId,
          kind: "scene",
          title: duplicateTitle
            ? `${baseTitle} · ${snapshot.run.id.slice(0, 6)}`
            : baseTitle,
          outlineNodeId: scene.id,
          now,
        }),
      );
      const version = this.documents.appendVersion(
        session.projectId,
        document.id,
        {
          id: step.id,
          content: draft.sceneContent,
          source: `cocreate:${session.id}`,
          runId: snapshot.run.id,
          expectedCurrentVersionId: null,
          now,
        },
      );
      const groundedCandidates = draft.canonCandidates.map((candidate) => ({
        ...candidate,
        evidence: bindEvidenceDocumentVersion(candidate.evidence, version.id),
      }));
      const changeSetId = `${snapshot.run.id}:canon-change-set`;
      this.reviews.insertCanonChangeSet({
        id: changeSetId,
        projectId: session.projectId,
        runId: snapshot.run.id,
        stepId: step.id,
        changes: {
          source: "cocreate-adoption",
          summary: draft.summary,
          candidates: groundedCandidates,
        },
        status: "candidate",
        createdAt: now,
      });
      const segment = this.retrieval.upsertSegment({
        id: `document:${document.id}:current`,
        projectId: session.projectId,
        sourceType: "document_current",
        sourceId: document.id,
        title: draft.sceneTitle,
        content: draft.sceneContent,
        authority: "confirmed",
        metadata: {
          documentId: document.id,
          documentVersionId: version.id,
          outlineNodeId: scene.id,
          sessionId: session.id,
        },
        entityIds: [],
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
      this.state.upsertSummary({
        id: `${snapshot.run.id}:scene-summary`,
        projectId: session.projectId,
        scopeType: "scene",
        scopeId: scene.id,
        summary: draft.summary,
        stateDelta: { candidates: draft.canonCandidates },
        sourceHash: version.contentHash,
        createdAt: now,
      });
      this.story.updateOutlineStatus(
        session.projectId,
        scene.id,
        "committed",
        now,
      );
      const adoption = this.creative.insertSceneAdoption({
        id: `${snapshot.run.id}:adoption`,
        projectId: session.projectId,
        sessionId: session.id,
        branchId: stringField(source, "branchId"),
        fromTurnId: stringField(source, "fromTurnId"),
        toTurnId: stringField(source, "toTurnId"),
        outlineNodeId: scene.id,
        documentId: document.id,
        documentVersionId: version.id,
        runId: snapshot.run.id,
        canonChangeSetId: changeSetId,
        createdAt: now,
      });
      return {
        ...adoption,
        canonChangeSetId: changeSetId,
        retrievalEmbedding: {
          model: contentEmbedding.model,
          modelId: contentEmbedding.modelId,
          warning: contentEmbedding.warning,
        },
        idempotentReplay: false,
      };
    });
    return {
      artifactKind: "scene-adoption",
      output: result,
      usage: contentEmbedding.usage,
    };
  }

  private requireActiveAdoptionSource(
    sessionId: string,
    source: Readonly<Record<string, unknown>>,
  ): string {
    this.creative.requireSession(sessionId);
    const branchId = stringField(source, "branchId");
    const branch = this.creative.requireBranch(branchId);
    if (branch.sessionId !== sessionId) {
      throw permanent(
        "adoption.scope.mismatch",
        "The branch of the adoption range does not belong to the current session",
      );
    }
    const visibleTurnIds = new Set(
      this.creative.listBranchTurns(branchId).map((turn) => turn.id),
    );
    const selectedTurnIds = Array.isArray(source.selectedTurnIds)
      ? source.selectedTurnIds.filter(
          (id): id is string => typeof id === "string",
        )
      : [];
    if (
      selectedTurnIds.length === 0 ||
      selectedTurnIds.some((id) => !visibleTurnIds.has(id))
    ) {
      throw permanent(
        "adoption.turns.stale",
        "Turns in the adoption range have been withdrawn; start the adoption again",
      );
    }
    return branchId;
  }

  private async transformSelection(
    snapshot: RunSnapshot,
    step: NarrativeRunStep,
    signal: AbortSignal,
  ): Promise<StepExecutionResult> {
    const documentId = policyString(snapshot.run.policy, "documentId");
    const baseVersionId = policyString(snapshot.run.policy, "baseVersionId");
    const version = this.documents.getVersion(
      snapshot.run.projectId,
      documentId,
      baseVersionId,
    );
    if (!version)
      throw permanent("document.version.not_found", "Base version not found");
    const start = policyNumber(snapshot.run.policy, "selectionStart", -1);
    const end = policyNumber(snapshot.run.policy, "selectionEnd", -1);
    validateTextRange(version.content, start, end);
    const selected = version.content.slice(start, end);
    const instruction = policyString(snapshot.run.policy, "instruction");
    const left = version.content.slice(Math.max(0, start - 2_000), start);
    const right = version.content.slice(
      end,
      Math.min(version.content.length, end + 2_000),
    );
    const intent = this.story.getAuthorIntent(snapshot.run.projectId);
    const editGuidance = {
      style: this.delivery.getActiveStyleProfile(snapshot.run.projectId),
      skills: this.delivery.listApplicableSkills(
        snapshot.run.projectId,
        "edit",
      ),
    };
    const result = await this.model.structured(
      snapshot.run,
      step,
      "selection-edit",
      {
        instructions: [
          "你是小说文字编辑，只改写给定选区。返回 replacementText，不输出全文、解释前缀或 Markdown 围栏。",
          "保持选区之外的事实、视角和时态；若指令会改变正典或事件结果，将 risk 标为 high，但仍给出最保守的候选。",
          "不要模仿在世作者。",
        ].join("\n"),
        messages: [
          {
            role: "user",
            content: [
              `作者意图：${JSON.stringify(intent)}`,
              `已启用风格与 Skill：${JSON.stringify(editGuidance)}`,
              `指令：${instruction}`,
              `前文：${left}`,
              `【精确选区】${selected}【选区结束】`,
              `后文：${right}`,
            ].join("\n\n"),
          },
        ],
        reasoningEffort: "low",
        maxOutputTokens: policyNumber(
          snapshot.run.policy,
          "editMaxOutputTokens",
          4_000,
        ),
      },
      SELECTION_EDIT_CONTRACT,
      collaborationValidator(SelectionEditResultSchema),
      signal,
    );
    return {
      artifactKind: "selection-edit-result",
      output: {
        ...result.value,
        documentId,
        baseVersionId,
        selectionStart: start,
        selectionEnd: end,
        originalText: selected,
        instruction,
        generation: { mode: result.mode, attempts: result.attempts },
      },
      usage: result.usage,
    };
  }

  private async stageSelectionEdit(
    snapshot: RunSnapshot,
  ): Promise<StepExecutionResult> {
    const result = SelectionEditResultSchema.parse(
      requiredArtifact(snapshot, "edit.transform"),
    );
    const transform = requiredArtifact(snapshot, "edit.transform");
    const documentId = stringField(transform, "documentId");
    const baseVersionId = stringField(transform, "baseVersionId");
    const version = this.documents.getVersion(
      snapshot.run.projectId,
      documentId,
      baseVersionId,
    );
    if (!version)
      throw permanent("document.version.not_found", "Base version not found");
    const start = numberField(transform, "selectionStart");
    const end = numberField(transform, "selectionEnd");
    validateTextRange(version.content, start, end);
    const originalText = version.content.slice(start, end);
    if (originalText !== stringField(transform, "originalText")) {
      throw permanent(
        "edit.selection.changed",
        "The selection does not match the base version",
      );
    }
    const proposedContent =
      version.content.slice(0, start) +
      result.replacementText +
      version.content.slice(end);
    const proposal = this.creative.insertEditProposal({
      id: `${snapshot.run.id}:proposal`,
      projectId: snapshot.run.projectId,
      documentId,
      baseVersionId,
      runId: snapshot.run.id,
      instruction: stringField(transform, "instruction"),
      selectionStart: start,
      selectionEnd: end,
      originalText,
      replacementText: result.replacementText,
      proposedContent,
      diff: selectionDiff(originalText, result.replacementText, start, end),
      status: "proposed",
      acceptedVersionId: null,
      createdAt: this.now().toISOString(),
      decidedAt: null,
    });
    return {
      artifactKind: "edit-proposal",
      output: {
        proposalId: proposal.id,
        documentId,
        baseVersionId,
        risk: result.risk,
      },
      usage: zeroUsage(),
    };
  }
}

function chooseSpeaker(
  policy: "manual" | "round_robin" | "auto",
  requested: string | null,
  participants: readonly {
    personaId: string;
    talkativeness: number;
  }[],
  turns: readonly StoryTurn[],
): string | null {
  const allowed = participants.map((participant) => participant.personaId);
  if (policy === "manual") {
    if (!requested || !allowed.includes(requested)) {
      throw permanent(
        "cocreate.speaker.required",
        "A manual speaker policy must specify an enabled Persona",
      );
    }
    return requested;
  }
  if (requested) {
    if (!allowed.includes(requested)) {
      throw permanent(
        "cocreate.speaker.invalid",
        "The specified Persona is not enabled",
      );
    }
    return requested;
  }
  if (policy === "auto") return null;
  const lastSpeaker = [...turns]
    .reverse()
    .find((turn) => turn.role === "assistant")?.personaId;
  const start = lastSpeaker ? allowed.indexOf(lastSpeaker) + 1 : 0;
  return allowed[start % allowed.length] ?? null;
}

function requiredArtifact(
  snapshot: RunSnapshot,
  kind: NarrativeRunStep["kind"],
): Record<string, unknown> {
  const artifact = [...snapshot.steps]
    .reverse()
    .find(
      (step) => step.kind === kind && step.status === "succeeded",
    )?.outputArtifact;
  if (!artifact)
    throw permanent("artifact.missing", `Missing artifact for step ${kind}`);
  return { ...artifact };
}

function selectionDiff(
  before: string,
  after: string,
  start: number,
  end: number,
): Record<string, unknown> {
  const beforeParagraphs = before.split(/\n{2,}/u);
  const afterParagraphs = after.split(/\n{2,}/u);
  return {
    range: { start, end },
    before,
    after,
    beforeCharacters: [...before].length,
    afterCharacters: [...after].length,
    paragraphHunks: Array.from(
      { length: Math.max(beforeParagraphs.length, afterParagraphs.length) },
      (_, index) => ({
        index,
        before: beforeParagraphs[index] ?? null,
        after: afterParagraphs[index] ?? null,
        changed: beforeParagraphs[index] !== afterParagraphs[index],
      }),
    ),
    hash: sha256Hex(`${before}\0${after}`),
  };
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

function policyOptionalString(
  policy: Readonly<Record<string, unknown>>,
  key: string,
): string | null {
  const value = policy[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function policyNumber(
  policy: Readonly<Record<string, unknown>>,
  key: string,
  fallback: number,
): number {
  const value = policy[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || !field.trim()) {
    throw permanent("artifact.invalid", `Artifact field ${key} is invalid`);
  }
  return field;
}

function numberField(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  if (typeof field !== "number" || !Number.isFinite(field)) {
    throw permanent("artifact.invalid", `Artifact field ${key} is invalid`);
  }
  return field;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function clipText(value: string, maxCharacters: number): string {
  return value.length <= maxCharacters
    ? value
    : `${value.slice(0, maxCharacters - 1)}…`;
}

function stringArray(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string")
  ) {
    throw permanent("artifact.invalid", "Artifact string array is invalid");
  }
  return [...value];
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
  return {
    code,
    message,
    retryable: false,
  };
}
