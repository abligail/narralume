import { sha256Hex } from "@narralume/domain";
import {
  StoryCompassSchema,
  StoryLineProposalChangesSchema,
} from "@narralume/contracts";
import {
  StoryLineProposalService,
  storyLineDecisionFingerprint,
  storyLineReviewEvidence,
  storyLineProposalIssues,
} from "./story-line-proposals.js";
import { ContextCompiler, type ContextSource } from "@narralume/context";

import {
  createOutlineNode,
  type NarrativeRunStep,
  type OutlineNode,
  type RunBudgetUsage,
  type RunSnapshot,
  type StoryCompass,
} from "@narralume/domain";
import type {
  StepExecutionResult,
  StepWorker,
  WorkerRegistry,
} from "@narralume/harness";
import {
  promptDefaultInstructions,
  promptInvariants,
} from "@narralume/harness";
import {
  SqliteAutomationRepository,
  SqliteCanonRepository,
  SqliteContextReceiptRepository,
  SqliteNarrativeStateRepository,
  SqliteProjectRepository,
  SqliteReviewRepository,
  SqliteStoryRepository,
  SqliteTemplateRepository,
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
import {
  outlineFingerprint,
  planningEntityIssues,
  planningRejections,
  requirePlanningEntitiesReady,
  stagePlanningEntities,
} from "./planning-entities.js";
import {
  authoredInstructions,
  instructionsFor,
  promptLanguageOf,
} from "./prompt-language.js";
import { StoryStatePacketBuilder } from "./story-state-packet.js";
import { outlineContextSources } from "./outline-context.js";
import {
  memoryManuscriptSources,
  memorySummarySources,
  validateMemoryCitations,
  bindMemoryCitations,
} from "./chapter-memory.js";
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
  private readonly templates: SqliteTemplateRepository;
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
    this.templates = new SqliteTemplateRepository(database);
    this.storyState = new StoryStatePacketBuilder(
      this.canon,
      this.state,
      this.story,
    );
  }

  /** 替换式指令组装：模板生效内容（override ?? 官方默认）整体替换写作层，
   *  结构不变量由代码追加，不受模板影响。 */
  private authoredInstructions(projectId: string, key: string): string {
    return authoredInstructions({
      language: promptLanguageOf(
        this.projects.get(projectId)?.language ?? null,
      ),
      templateContent: this.templates.getByKey(key)?.effectiveContent ?? null,
      fallback: promptDefaultInstructions(key),
      invariants: promptInvariants(key),
    });
  }

  registry(): WorkerRegistry {
    return {
      "foundation.generate": this.worker(this.generateFoundation.bind(this)),
      "foundation.stage": this.worker(this.stageFoundation.bind(this)),
      "outline.generate": this.worker(this.generateOutline.bind(this)),
      "outline.entities": this.worker(this.stageOutlineEntities.bind(this)),
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
        instructions: this.authoredInstructions(
          project.id,
          "prompt.book-foundation",
        ),
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
    const compassContext = compassContextProjection(compass);
    const intent = this.story.getAuthorIntent(session.projectId);
    const outline = this.story.listOutline(session.projectId);
    const entities = this.canon.listEntities(session.projectId, {
      includeRetired: true,
    });
    const steers = this.automation
      .listSteers(sessionId)
      .filter(
        (steer) =>
          steer.status === "applied" &&
          ["future_plan", "canon_change", "rewrite_existing"].includes(
            steer.classification ?? "",
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
    const contextWindow =
      this.model.effectiveContextWindow?.(snapshot.run, "rolling-outline") ??
      64_000;
    const outputReserve =
      this.model.effectiveOutputLimit?.(snapshot.run, "rolling-outline") ??
      16_000;
    const latestChapter = outline
      .filter((node) => node.kind === "chapter" && node.status === "committed")
      .at(-1);
    const memoryBaseline = storyLineReviewEvidence(this.database, project.id);
    const decisionSets = new StoryLineProposalService(this.database)
      .list(project.id)
      .slice(0, 12);
    const authorDecisions = decisionSets.flatMap((set) =>
      set.items.map((item) => ({
        setId: set.id,
        itemId: item.id,
        title: item.before.title,
        action: item.decision?.action ?? "pending",
        result: item.decision?.result ?? null,
      })),
    );
    const sources: ContextSource[] = [
      {
        id: "planning-task",
        kind: "task",
        label: "本次规划任务",
        authority: "locked",
        priority: 100,
        required: true,
        compressible: false,
        sourceType: "autopilot_session",
        sourceId: session.id,
        content: JSON.stringify({
          title: project.title,
          windowChapters: windowSize,
          runRemainingChapters: remaining,
          activeStructure: outline
            .filter(
              (node) =>
                ["arc", "volume"].includes(node.kind) &&
                node.status !== "abandoned",
            )
            .slice(-6)
            .map(compactOutline),
        }),
      },
      {
        id: "planning-intent",
        kind: "author-intent",
        label: "作者意图与全书方向",
        authority: "locked",
        priority: 99,
        required: true,
        compressible: false,
        sourceType: "author_intent",
        sourceId: project.id,
        content: JSON.stringify({ intent, compass: compassContext.direction }),
      },
      ...compassContext.sources,
      ...outlineContextSources({
        projectId: project.id,
        outline,
        chapterSummaries: this.state
          .listLatestSummaries(project.id, "chapter")
          .filter((summary) =>
            memoryBaseline.chapters.some(
              (chapter) =>
                chapter.chapterId === summary.scopeId &&
                chapter.sourceHash === summary.sourceHash,
            ),
          ),
        targetOutlineNodeId: latestChapter?.id ?? null,
      }),
      ...memoryManuscriptSources(
        memoryBaseline.chapters,
        1,
        JSON.stringify(compass?.longLines ?? []),
        memoryBaseline.entityCatalog.flatMap(({ name, aliases }) => [
          name,
          ...aliases,
        ]),
      ),
      {
        id: "author-decision-receipt",
        kind: "author-intent",
        label: "作者裁定的实际记录",
        authority: "locked",
        priority: 99,
        required: true,
        compressible: false,
        sourceType: "canon_item_decisions",
        sourceId: project.id,
        content: JSON.stringify({
          authorDecisions: authorDecisions.map(
            ({ setId, itemId, title, action }) => ({
              setId,
              itemId,
              title,
              action,
            }),
          ),
          counts: {
            applied: authorDecisions.filter((item) => item.action === "apply")
              .length,
            rejected: authorDecisions.filter((item) => item.action === "reject")
              .length,
            pending: authorDecisions.filter((item) => item.action === "pending")
              .length,
          },
          decisionScope:
            "Only the proposed update; rejection never cancels an existing line. The current compass governs creative direction, not proof of past events.",
        }),
      },
      ...memorySummarySources(memoryBaseline.chapters, latestChapter?.id),
      {
        id: "planning-entities",
        kind: "canon",
        label: "实体目录与作者拒绝记录",
        authority: "confirmed",
        priority: 98,
        required: true,
        compressible: false,
        sourceType: "canon_entities",
        sourceId: project.id,
        content: JSON.stringify({
          entities: memoryBaseline.entityCatalog,
          rejectedProposals: planningRejections(this.database, project.id),
        }),
      },
      ...continuationState.sources,
      ...decisionSets.map((set, index): ContextSource => ({
        id: `story-line-decisions:${set.id}`,
        kind: "author-intent",
        label: "故事线建议与作者逐项裁定",
        content: JSON.stringify({
          scopeNodeId: set.scopeNodeId,
          stale: set.stale,
          items: set.items.map((item) => ({
            title: item.before.title,
            before: item.before,
            proposal: item.after,
            decisionScope:
              "proposed_update_only; rejecting an update does not remove or cancel the existing story line",
            decision: item.decision ?? "pending",
          })),
        }),
        authority: "reference",
        priority: Math.max(50, 97 - index),
        compressible: false,
        sourceType: "canon_change_set",
        sourceId: set.id,
      })),
      ...[
        ...this.state.listLatestSummaries(project.id, "arc"),
        ...this.state.listLatestSummaries(project.id, "volume"),
      ]
        .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((review, index): ContextSource => ({
          id: `planning-review:${review.id}`,
          kind: "summary",
          label: "阶段复盘的后续建议（须以正文核实）",
          content: JSON.stringify({
            scopeId: review.scopeId,
            recommendations: review.stateDelta.recommendations,
          }),
          authority: "reference",
          priority: Math.max(50, 80 - index),
          compressible: false,
          sourceType: "narrative_summary",
          sourceId: review.id,
        })),
      ...steers.map((steer, index): ContextSource => ({
        id: `planning-steer:${index}`,
        kind: "author-intent",
        label: "作者已确认的后续规划指示",
        content: steer.content,
        authority: "locked",
        priority: 99,
        required: true,
        compressible: false,
        sourceType: "story_steer",
        sourceId: session.id,
      })),
    ];
    const compiled = new ContextCompiler(this.now).compile({
      projectId: project.id,
      purpose: "rolling-outline",
      sources,
      budget: {
        contextWindow,
        outputReserve,
        fixedInstructionReserve: 1_500,
        schemaReserve: 1_500,
        toolReserve: 0,
      },
    });
    new SqliteContextReceiptRepository(this.database).insert(compiled.receipt, {
      runId: snapshot.run.id,
      stepId: step.id,
    });
    const result = await this.model.structured(
      snapshot.run,
      step,
      "rolling-outline",
      {
        instructions: instructionsFor(project.language, {
          "zh-CN": [
            "你是长篇小说滚动规划师。只详细规划当前可见窗口，不要一次冻结整部长篇。",
            "计划必须承接已提交章节，兑现指南针，尊重作者锁定意图与 steer。",
            "已提交正文是事件依据，摘要仅是检索索引；summaryPoints 的 observed/reported/inferred/unresolved 分别为叙述事实、人物说法、推测和未解问题。保留说话者与知情范围，不把计划 outcome、人物怀疑或复盘建议当成既成事实。",
            "先填写 continuityRisks，为本窗口要承接的事实建立连续性边界，再写 rationale、entityProposals 和章节计划。只记录与本次推进相关的人物、对象与原文状态：区分目击总量和实际参与或交接的数量、当前持有与索要或承诺移交、出发方向与抵达、已获知与准备转达；时间预估保留行动者和对象，以及后来修正的预估。所有字段沿用这些边界，新增事件明确作为未来安排，不倒写成既有历史。",
            "核对相关规则时，同时保留较早已经验证的效果与当前仍待验证的对象、条件或方法，不能把旧对象的验证推广到新对象，也不能把已有实证抹成一概未知。人物想起、猜测或希望某种机制，至多证明该想法出现，不能证明机制成立；缺少观察不能证明远处事件没有发生。",
            "planning-entities 确认作者设定的身份和关系，不证明读者已知、某角色已获知或描述中的行动已经发生。已确认的身份不得重新列为作者层面的未知；是否已向读者或角色披露须以正文核对。",
            "原文已经讲明的身份或往事不得重新安排为首次揭示；继续写它的后果、人物回应或仍未知的具体问题。作者进展记录或旧复盘仍写着尚未揭示时，也必须先以原文核对。",
            "decisionAcknowledgements 必须逐项原样确认 author-decision-receipt 中的 setId、itemId 和 action，包含 pending；不要从复盘文字推断作者裁定。rationale 只说明本窗口的创作安排，不重新统计或概括采纳／拒绝情况，实际裁定由程序单独记录。",
            "故事线候选中的 pending 尚未采纳，reject 已被作者拒绝，均不得当成作者方向。apply 的 result 是当时实际写入记录，当前指南针优先；不要重复被拒绝的变化。reject 只否决该次更新，不取消既有故事线，也不表示只能推进 apply 过的线；指南针中保留的每条线仍然有效。",
            "planning-intent 中的指南针是锁定的创作方向：longLines 的 promise、status 和 development 中的 scopeNodeId、stageGoal、nextDevelopment 指定承诺、作者维护的线状态与未来目标，不能证明事件已经发生或某项承诺仍未兑现。compass-stage-records 单独提供可回查的阶段记录：progress、openPromises 的未兑现判断和 evidenceChapterIds 只是参考，须核对已提交正文；已兑现部分应收窄，仍有效的作者承诺不得擅自取消。历史裁定中的 apply result 是当时写入记录，也不因此成为正文事件证据。结合当前阶段选择本窗口推进的线，不要求每条线每章出场，也不为完成窗口而全部解决。",
            "每章要有目标、阻力、转折、结果与结尾钩子；结果必须推动因果链。",
            "先判断既有角色、关系变化与场景能否承担剧情功能；新人物、地点或组织只在本窗口确有需要时提出，entityProposals 可以为空，不设新增数量指标，也不要因为初始名单有限就强迫每段剧情围绕同几个人。每项提案说明 narrativeRole 和 rationale，尊重拒绝记录，不换名重复被拒绝的功能。",
            "章节 pov 和 entityRefs 显式使用 {kind: existing, id: 实体ID} 或 {kind: proposed, id: 提案key}；POV 只能引用人物。复用目录里的稳定 ID，不按名字猜测，不重复已有名字或别名；退役条目不可引用。每项提案必须服务本窗口至少一章，角色描述和剧情功能不是已经发生的事件。",
            "运行剩余章数只表示本次委托的工作量，不表示故事弧、卷或全书必须结束。全书结局只由作者意图与已建立的叙事进展决定，不为用完窗口而提前收束。",
            "volumeId/arcId 填写要继续的现有卷/弧 ID；只有剧情进入新阶段时才填 null 创建新卷/弧。一弧可以跨多个窗口，换窗口不等于换弧。继续已有结构时保留其目标和已经发生的结果。arcId 必须属于选定的 volumeId。",
            "准确输出本次窗口要求的章节数量。nextArc 是可调整的远期骨架，不能当作已发生的事实；复盘建议需评估后落实到本次计划，不得当作作者命令或正典。",
          ],
          en: [
            "You are the rolling planner of a long-form novel. Plan only the currently visible window in detail; never freeze an entire long novel at once.",
            "The plan must continue from committed chapters, honor the compass, and respect the author's locked intent and steers.",
            "Committed manuscripts evidence events; summaries are retrieval indexes. summaryPoints distinguish observed narration, reported character accounts, inferred speculation, and unresolved questions. Preserve speakers and knowledge scope. Planned outcomes, suspicions, and retrospective suggestions are not established facts.",
            "Fill continuityRisks first to establish continuity boundaries for facts this window depends on, then write rationale, entityProposals and chapter plans. Include only relevant people, objects and manuscript states: distinguish observed populations from actual participants or handoff counts, current possession from requests or promised transfers, departure destinations from arrival, and received knowledge from intended messages. Keep each time estimate's actor and target, including later revisions. Every field must preserve these boundaries; describe new events as future plans, never as existing history.",
            "For relevant rules, preserve both earlier demonstrated effects and the current objects, conditions or methods still awaiting verification. Do not generalize evidence about one object to another, or erase established effects as universally unknown. A character remembering, guessing or hoping for a mechanism establishes that thought, not the mechanism. Missing observation does not establish that a distant event never happened.",
            "planning-entities confirms author-defined identities and relationships, not reader disclosure, a character's knowledge or completed actions mentioned in descriptions. Do not make a confirmed identity unknown at the author level; check manuscripts for disclosure to readers or characters.",
            "Do not plan the first revelation of an identity or backstory already disclosed in prose. Develop its consequences, responses, or specific remaining unknowns. Check manuscripts even when author progress notes or older reviews still call it unrevealed.",
            "decisionAcknowledgements must repeat every setId, itemId and action from author-decision-receipt exactly, including pending. Never infer decisions from review prose. rationale explains creative choices only; do not recount acceptance or rejection. The program separately records actual author decisions.",
            "For story line proposals, pending is unaccepted and reject is an author rejection; neither is author direction. An apply result records the actual write at that time; the current compass takes precedence. Do not repeat rejected changes. Reject applies only to that proposed update: it does not cancel the existing story line or restrict development to lines with applied proposals. All lines still present in the current compass remain valid.",
            "The compass in planning-intent locks creative direction: each line's promise, author-maintained status, and development.scopeNodeId/stageGoal/nextDevelopment express commitments and future objectives, not proof that an event happened or a commitment remains unfulfilled. compass-stage-records separately supplies reference progress notes, openPromises fulfillment judgments, and evidenceChapterIds. Check these against committed manuscripts, narrow fulfilled portions, and never cancel valid author commitments on your own. Historical apply results are records of writes, not manuscript event evidence. Select lines relevant to this window; not every line must appear in every chapter or resolve by the window's end.",
            "Each chapter needs a goal, resistance, a turn, an outcome, and a closing hook; outcomes must advance the causal chain.",
            "First consider whether existing characters, changing relationships, and settings can serve the story. Propose a new character, location, or organization only when this window needs one. entityProposals may be empty: there is no quota, and the initial cast need not carry every future conflict. Explain each narrativeRole and rationale, honor rejected proposals, and do not rename a rejected idea to repeat it.",
            "Chapter pov and entityRefs must use {kind: existing, id: entity ID} or {kind: proposed, id: proposal key}. POV must reference a character. Reuse stable catalog IDs, never infer identity from a name or duplicate an existing name or alias. Retired entries cannot be referenced. Every proposal must serve at least one chapter in this window. Descriptions and narrative roles are not events that have already occurred.",
            "Remaining run chapters describe this assignment's workload, not the end of an arc, volume, or book. Resolve the book only when author intent and established narrative progress call for it, never just to finish a window.",
            "Set volumeId/arcId to the existing volume/arc to continue, or null to create one only when the story enters a new phase. An arc may span several windows. Preserve existing goals and established outcomes. arcId must belong to volumeId.",
            "Return exactly the requested window chapter count. nextArc is a revisable future outline, not a past event. Evaluate retrospective suggestions and incorporate useful ones; they are neither author commands nor canon.",
          ],
        }),
        messages: [
          {
            role: "user",
            content: compiled.text,
          },
        ],
        reasoningEffort: "low",
      },
      ROLLING_OUTLINE_CONTRACT,
      automationValidator(RollingOutlineProposalSchema, (plan) => [
        ...planningEntityIssues(
          { ...plan, chapters: plan.chapters.slice(0, windowSize) },
          entities,
        ),
        ...(JSON.stringify(
          plan.decisionAcknowledgements
            .map(({ setId, itemId, action }) => ({ setId, itemId, action }))
            .sort((a, b) =>
              `${a.setId}:${a.itemId}`.localeCompare(`${b.setId}:${b.itemId}`),
            ),
        ) ===
        JSON.stringify(
          authorDecisions
            .map(({ setId, itemId, action }) => ({ setId, itemId, action }))
            .sort((a, b) =>
              `${a.setId}:${a.itemId}`.localeCompare(`${b.setId}:${b.itemId}`),
            ),
        )
          ? []
          : [
              "decisionAcknowledgements must exactly match every actual author decision",
            ]),
      ]),
      signal,
    );
    const value = {
      ...result.value,
      chapters: result.value.chapters.slice(0, windowSize),
    };
    const currentMemory = storyLineReviewEvidence(this.database, project.id);
    if (
      currentMemory.fingerprint !== memoryBaseline.fingerprint ||
      JSON.stringify(currentMemory.entityCatalog) !==
        JSON.stringify(memoryBaseline.entityCatalog) ||
      storyLineDecisionFingerprint(
        new StoryLineProposalService(this.database)
          .list(project.id)
          .slice(0, 12),
      ) !== storyLineDecisionFingerprint(decisionSets)
    ) {
      throw permanent(
        "planning.memory.stale",
        "Manuscripts, entity catalog or author decisions changed while planning; generate a new plan",
      );
    }
    return {
      artifactKind: "rolling-outline-proposal",
      output: {
        ...value,
        authorDecisions,
        generation: {
          mode: result.mode,
          attempts: result.attempts,
          // 保存生成时的大纲基线；commit 时比对，防止后台规划覆盖期间的人工编辑。
          outlineFingerprint: outlineFingerprint(outline),
          compassVersion: compass?.version ?? null,
          contextReceiptId: compiled.receipt.id,
          manuscriptFingerprint: memoryBaseline.fingerprint,
          entityCatalog: memoryBaseline.entityCatalog,
          decisionFingerprint: storyLineDecisionFingerprint(decisionSets),
        },
      },
      usage: result.usage,
    };
  }

  private async stageOutlineEntities(
    snapshot: RunSnapshot,
    step: NarrativeRunStep,
    signal: AbortSignal,
  ): Promise<StepExecutionResult> {
    const output = this.database.transaction(() => {
      requireActiveRunCommit(
        this.database,
        snapshot.run.id,
        snapshot.run.projectId,
        signal,
      );
      return stagePlanningEntities(
        this.database,
        snapshot,
        step.id,
        this.now().toISOString(),
      );
    });
    return {
      artifactKind: "planning-entity-candidates",
      output,
      usage: zeroUsage(),
    };
  }

  private async commitOutline(
    snapshot: RunSnapshot,
    _step: NarrativeRunStep,
    signal: AbortSignal,
  ): Promise<StepExecutionResult> {
    const artifact = requiredArtifact(snapshot, "outline.generate");
    const plan = RollingOutlineProposalSchema.parse(artifact);
    const sessionId = policyString(snapshot.run.policy, "sessionId");
    const session = this.automation.requireSession(sessionId);
    const now = this.now().toISOString();
    const result = this.database.transaction(() => {
      requireActiveRunCommit(
        this.database,
        snapshot.run.id,
        snapshot.run.projectId,
        signal,
      );
      const bindings = requirePlanningEntitiesReady(this.database, snapshot);
      const outline = this.story.listOutline(session.projectId);
      const root = outline.find((node) => node.kind === "book");
      if (!root)
        throw permanent(
          "outline.root.missing",
          "Project is missing the book root node",
        );
      let volume = plan.volumeId
        ? this.story.getOutlineNode(session.projectId, plan.volumeId)
        : null;
      if (
        plan.volumeId &&
        (!volume || volume.kind !== "volume" || volume.status === "abandoned")
      ) {
        throw permanent(
          "outline.structure.invalid",
          "The selected volume is unavailable",
        );
      }
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
      let arc = plan.arcId
        ? this.story.getOutlineNode(session.projectId, plan.arcId)
        : null;
      if (
        plan.arcId &&
        (!arc ||
          arc.kind !== "arc" ||
          arc.parentId !== volume.id ||
          arc.status === "abandoned")
      ) {
        throw permanent(
          "outline.structure.invalid",
          "The selected arc must belong to the selected volume",
        );
      }
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
            metadata: {
              ...arc.metadata,
              detail: "active",
              sourceRunId: snapshot.run.id,
            },
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
      const resolveEntity = (ref: {
        kind: "existing" | "proposed";
        id: string;
      }) => (ref.kind === "existing" ? ref.id : bindings.get(ref.id)!);
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
            povEntityId: chapter.pov ? resolveEntity(chapter.pov) : null,
            storyTime: chapter.storyTime,
            metadata: {
              hook: chapter.hook,
              sourceRunId: snapshot.run.id,
              planningRationale: plan.rationale,
              plannedEntityIds: [
                ...new Set(
                  [
                    ...chapter.entityRefs,
                    ...(chapter.pov ? [chapter.pov] : []),
                  ].map(resolveEntity),
                ),
              ],
            },
            now,
          }),
        );
        chapterIds.push(node.id);
      });
      let nextArcId: string | null = null;
      if (
        plan.nextArc &&
        !volumeChildren.some(
          (node) =>
            node.kind === "arc" &&
            node.metadata.detail === "skeleton" &&
            node.status !== "abandoned",
        )
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
        instructions: instructionsFor(
          this.projects.get(snapshot.run.projectId)?.language ?? null,
          {
            "zh-CN": [
              "你是小说生产 harness 的 steer 仲裁器，只分类影响范围，不创作正文。",
              "立即影响仅用于作者明确要求停止或改变正在生成的内容；涉及既有正文或正典要提高风险。",
              "输出必须选择唯一分类和最早安全生效边界。",
            ],
            en: [
              "You are the steer arbitrator of the novel production harness; classify impact scope only and never write prose.",
              "Immediate impact applies only when the author explicitly asks to stop or change content being generated; anything touching existing prose or canon raises the risk.",
              "The output must choose exactly one classification and the earliest safe effective boundary.",
            ],
          },
        ),
        messages: [
          {
            role: "user",
            content: `运行状态：${session?.status ?? "无会话"}\n作者 steer：${steer.content}`,
          },
        ],
        reasoningEffort: "low",
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
    const baselineCompass = this.automation.getCompass(snapshot.run.projectId);
    const compassContext = compassContextProjection(baselineCompass);
    const evidenceBaseline = storyLineReviewEvidence(
      this.database,
      snapshot.run.projectId,
      node.id,
    );
    const evidence = evidenceBaseline.evidence;
    const manuscriptSources = memoryManuscriptSources(
      [
        ...evidenceBaseline.chapters.filter((chapter) => !chapter.inScope),
        ...evidenceBaseline.chapters.filter((chapter) => chapter.inScope),
      ],
      this.automation.requireSession(sessionId).windowSize * 2,
      JSON.stringify(baselineCompass?.longLines ?? []),
      evidenceBaseline.entityCatalog.flatMap(({ name, aliases }) => [
        name,
        ...aliases,
      ]),
    ).map((source) => ({
      ...source,
      content: JSON.stringify({
        ...JSON.parse(source.content),
        inScope: evidenceBaseline.chapters.find(
          (chapter) => chapter.chapterId === source.sourceId,
        )!.inScope,
      }),
    }));
    const source = JSON.stringify({
      evidence,
      manuscripts: manuscriptSources.map((s) => s.content),
      entityCatalog: evidenceBaseline.entityCatalog,
    });
    const contextWindow =
      this.model.effectiveContextWindow?.(
        snapshot.run,
        `${scopeType}-review`,
      ) ?? 64_000;
    const outputReserve =
      this.model.effectiveOutputLimit?.(snapshot.run, `${scopeType}-review`) ??
      16_000;
    const compiled = new ContextCompiler(this.now).compile({
      projectId: snapshot.run.projectId,
      purpose: `${scopeType}-review`,
      budget: {
        contextWindow,
        outputReserve,
        fixedInstructionReserve: 1_000,
        schemaReserve: 1_000,
        toolReserve: 0,
      },
      sources: [
        {
          id: "review-task",
          kind: "task",
          label: "复盘范围与全书方向",
          authority: "locked",
          priority: 100,
          required: true,
          compressible: false,
          sourceType: "outline_node",
          sourceId: node.id,
          content: JSON.stringify({
            scopeNodeId: node.id,
            scope: node.title,
            scopeChapterIds: evidence
              .filter((chapter) => chapter.inScope)
              .map((chapter) => chapter.chapterId),
            compass: compassContext.direction,
          }),
        },
        {
          id: "review-entities",
          kind: "canon",
          label: "作者设定的实体身份与关系",
          authority: "confirmed",
          priority: 98,
          required: true,
          compressible: false,
          sourceType: "canon_entities",
          sourceId: snapshot.run.projectId,
          content: JSON.stringify({ entities: evidenceBaseline.entityCatalog }),
        },
        ...compassContext.sources,
        ...evidence.map((chapter, index): ContextSource => ({
          id: `review-chapter:${chapter.chapterId}`,
          kind: "summary",
          label: chapter.title,
          content: JSON.stringify(chapter),
          authority: "reference",
          compressible: false,
          priority: 60 + 30 * ((index + 1) / evidence.length),
          sourceType: "outline_node",
          sourceId: chapter.chapterId,
        })),
        ...manuscriptSources,
      ],
    });
    new SqliteContextReceiptRepository(this.database).insert(compiled.receipt, {
      runId: snapshot.run.id,
      stepId: step.id,
    });
    const result = await this.model.structured(
      snapshot.run,
      step,
      `${scopeType}-review`,
      {
        instructions: instructionsFor(
          this.projects.get(snapshot.run.projectId)?.language ?? null,
          {
            "zh-CN": [
              `你是长篇小说${scopeType === "arc" ? "故事弧" : "卷"}复盘编辑。`,
              "章节摘要只是检索索引，已提交正文才是事件依据。基于实际提供的带段号正文评估承诺兑现、因果、人物弧、节奏和连续性；摘要与原文不符时以原文为准。建议服务于下一滚动窗口，不改写已提交事实。",
              "只评价 review-task 的目标范围和 scopeChapterIds；inScope=false 的较早章节是历史核对依据，可引用来校正旧承诺和作者进展记录，不把历史事件记成目标阶段的新进展。所有正文均截止于目标范围最后已提交章，不借用后来故事弧的事实来判定本阶段已兑现。",
              "observations 是有原文证据的关键进展，每项 text 自足并明确说话者与知情范围；basis 区分 observed 叙述事实、reported 人物说法、inferred 推测、unresolved 未解问题。每项 citations 引用 chapterId、paragraphOrdinal 和该段连续的逐字原文 quote。系统直接据此生成复盘摘要，不另写无证据概括。核对人物、地点、时间和已经写出的身份／往事揭示；不要把修复完成写成待修复，把人物说法升级为确定机制。",
              "先在 observations 摘录与本次建议相关的事实锚点，再形成 recommendations、compassAdjustments 和 lineProposals。相关时明确对象、数量组成、动作完成状态、消息的实际接收者、新旧时间预估及其行动者；将已经发生、正在进行、未来安排分别写清。既有实证与当前待验证的对象或方法必须同时保留，不能把已有验证一概抹成未知，也不能推广为新机制已证实。各建议字段必须一致承接这些锚点，不得补完未展示的动作、交接、抵达或知情。",
              "review-entities 提供作者确认的身份与关系，可避免把已确认关系另列为作者层面的谜题；目录不是正文事件证据，不证明读者已经知道、某角色已经获知或描述中的行动发生于本阶段。披露和获知时间须回查正文。人物内在想法本身可以是 observed，但想法中的机制仍为 inferred；未观察到远处事件不等于事件未发生。",
              "recommendations 和 lineProposals 也必须保留原文证据的认知层级：reported、inferred、unresolved 不能写成已确定的事实，后续建议应写验证该判断；不要因本阶段没提到而断言角色不知道，尤其历史正文已写过获知或交接时。",
              "引用选该段中简短、能支持判断的连续原文，直接复制，保留标点与字词；不要改写、跨段拼接或加省略号。已披露的往事只列仍未知的具体问题，nextDevelopment 不重复要求首次披露，也不把推测当成已经确立的规则。",
              "这是当前已写部分的阶段复盘，不意味着故事弧、卷或全书已经结束。区分已兑现、仍在发展和需要后续处理的承诺；不要仅因本次运行结束而要求结局或回收所有伏笔。检索未命中或摘要没提到不证明某事未发生；complete=false 的正文片段不能证明整章不存在某事。章节序号使用 chapterNumber，从 1 开始；chapterId 是不透明标识，不能从其尾部数字推断序号。",
              "review-task 中的指南针锁定创作方向：promise、status、stageGoal、nextDevelopment 是承诺、作者维护的线状态与未来目标，不证明已经发生或仍未兑现。compass-stage-records 中的 progress、openPromises 未兑现判断和 evidenceChapterIds 单独作为参考，必须回查正文。指出有正文支持的变化，收窄已兑现部分并保留仍有效的承诺；不得擅自取消作者承诺。调整仅作为 compassAdjustments 建议，不自动修改故事线。",
              "lineProposals 是供作者逐项接受或拒绝的建议。lineIndex 是 compass.longLines 的零基索引，每条线最多一项；仅引用本次实际提供的 chapterId 作为 evidenceChapterIds。progress 概括有正文支持的进展，openPromises 保留尚未兑现的承诺，nextDevelopment 仅为后续方向。不要仅因阶段结束建议 resolved；无有效证据则返回空数组。",
              "lineEvidence 对每条 lineProposals 恰好一项，lineIndex 相同，citations 必须逐字引用支持 progress、status 和 openPromises 的正文。evidenceChapterIds 与 citations 的章节集合完全一致。认定已兑现或尚未揭示时回查原文；明确区分角色知道、读者知道和作者秘密。证据不足不生成该项调整，合理嫌疑和省略不能自动当作矛盾。",
            ],
            en: [
              `You are the retrospective editor of a long-form novel ${scopeType === "arc" ? "story arc" : "volume"}.`,
              "Chapter summaries are retrieval indexes; committed manuscripts evidence events. Assess promise fulfillment, causality, character arcs, pacing, and continuity from the supplied numbered prose. Prefer prose when an index disagrees. Suggestions serve the next window and never rewrite committed facts.",
              "Evaluate only the target scope and scopeChapterIds in review-task. Earlier chapters marked inScope=false are historical references: cite them to correct stale promises or author progress notes, without counting their events as new developments of this stage. Manuscripts stop at the target scope's last committed chapter; never use later arcs to claim this stage fulfilled a promise.",
              "observations are self-contained developments grounded in prose, with explicit speakers and knowledge scope. basis distinguishes observed narration, reported accounts, inferred speculation, and unresolved questions. Every citations entry gives chapterId, paragraphOrdinal and a contiguous verbatim quote from that paragraph. The program builds the summary from these observations. Check people, places, times and revelations already written; a completed repair is not future work and a character's account is not an established mechanism.",
              "First extract relevant factual anchors in observations, then form recommendations, compassAdjustments and lineProposals. When relevant, identify the object, counts and composition, action completion, actual message recipients, and earlier versus revised time estimates with their actors. Separate completed events, ongoing actions and future plans. Preserve both established effects and current objects or methods awaiting verification: neither erase prior evidence as universally unknown nor generalize it into a verified new mechanism. Every suggestion must consistently carry these anchors forward without completing unseen actions, handoffs, arrivals or knowledge transfers.",
              "review-entities provides author-confirmed identities and relationships; do not make confirmed relationships new author-level mysteries. The catalog is not manuscript event evidence and does not establish reader disclosure, a character's knowledge or that a described action occurred in this stage. Check manuscripts for disclosure and knowledge timing. The occurrence of an internal thought may be observed while its proposed mechanism remains inferred; failing to observe a distant event does not establish its absence.",
              "recommendations and lineProposals must preserve the evidence's epistemic level too: reported, inferred and unresolved claims cannot become established facts; recommend verifying the judgment instead. Do not claim a character lacks knowledge merely because this stage does not mention it, especially when earlier prose already records their discovery or a handoff.",
              "Copy a short continuous excerpt that supports the judgment, preserving its words and punctuation. Never paraphrase, join paragraphs, or add ellipses. For disclosed backstory, list only specific remaining unknowns: nextDevelopment must not request its first disclosure again or treat speculation as an established rule.",
              "This reviews progress so far, not an assumed arc, volume, or book ending. Distinguish fulfilled promises, ongoing developments, and future work. Do not demand an ending or resolve every setup because this run is over. State evidence limitations when summaries are insufficient. Use the supplied chapterNumber (starting at 1), never infer numbers from opaque chapterId values.",
              "The compass in review-task locks creative direction: promise, author-maintained status, stageGoal and nextDevelopment express commitments and future objectives, not proof of past events or unfulfilled status. progress, openPromises fulfillment judgments and evidenceChapterIds in compass-stage-records are separate references that must be checked against manuscripts. Identify supported changes, narrow fulfilled portions and retain valid commitments; never cancel author commitments on your own. Return adjustments as compassAdjustments suggestions without updating story lines.",
              "Return lineProposals for individual author decisions. lineIndex is the zero-based compass.longLines index; at most one proposal per line. evidenceChapterIds may only reference chapterId values actually supplied. progress records supported developments, openPromises retains outstanding promises, and nextDevelopment is future direction. Never suggest resolved merely because this stage ends. Return an empty array without valid evidence.",
              "Return exactly one lineEvidence item per proposal with the same lineIndex. Its citations quote manuscript evidence for progress, status and openPromises. evidenceChapterIds must exactly equal the citation chapter set. Check original prose before claiming fulfilled or unrevealed; separate character knowledge, reader knowledge and author secrets. Omit unsupported adjustments. Missing retrieval or summary mentions do not establish absence, and complete=false excerpts cannot establish absence across a chapter. Preserve legitimate suspicion and narrative omission.",
            ],
          },
        ),
        messages: [
          {
            role: "user",
            content: compiled.text,
          },
        ],
        reasoningEffort: "low",
      },
      PLANNING_REVIEW_CONTRACT,
      automationValidator(PlanningReviewResultSchema, (value) => {
        const includedSources = manuscriptSources.filter((source) =>
          compiled.sections.some((section) => section.id === source.id),
        );
        const issues = storyLineProposalIssues(
          value.lineProposals,
          baselineCompass?.longLines.length ?? 0,
          new Set(
            compiled.sections
              .filter((section) => section.id.startsWith("memory-manuscript:"))
              .map((section) => section.sourceId!),
          ),
        );
        issues.push(
          ...value.observations.flatMap((item, index) =>
            validateMemoryCitations(
              item.citations,
              includedSources,
              `observations.${index}.citations`,
            ),
          ),
        );
        if (
          value.lineEvidence.length !== value.lineProposals.length ||
          new Set(value.lineEvidence.map((item) => item.lineIndex)).size !==
            value.lineEvidence.length
        )
          issues.push(
            "Evidence must cover each proposed lineIndex exactly once",
          );
        for (const item of value.lineEvidence) {
          const proposal = value.lineProposals.find(
            (p) => p.lineIndex === item.lineIndex,
          );
          if (
            !proposal ||
            JSON.stringify(
              [...new Set(item.citations.map((c) => c.chapterId))].sort(),
            ) !== JSON.stringify([...proposal.evidenceChapterIds].sort())
          )
            issues.push(
              "Evidence chapter IDs must exactly match the proposal citations",
            );
          issues.push(
            ...validateMemoryCitations(
              item.citations,
              includedSources,
              `lineEvidence.${item.lineIndex}.citations`,
            ),
          );
        }
        return issues;
      }),
      signal,
    );
    const summary = result.value.observations
      .map((item) => item.text)
      .join("\n");
    const observations = result.value.observations.map((item) => ({
      ...item,
      citations: bindMemoryCitations(item.citations, evidenceBaseline.chapters),
    }));
    const lineEvidence = result.value.lineEvidence.map((item) => ({
      ...item,
      citations: bindMemoryCitations(item.citations, evidenceBaseline.chapters),
    }));
    const now = this.now().toISOString();
    const sourceHash = sha256(source);
    this.database.transaction(() => {
      requireActiveRunCommit(
        this.database,
        snapshot.run.id,
        snapshot.run.projectId,
        signal,
      );
      if (
        this.automation.getCompass(snapshot.run.projectId)?.version !==
          baselineCompass?.version ||
        storyLineReviewEvidence(this.database, snapshot.run.projectId, node.id)
          .fingerprint !== evidenceBaseline.fingerprint
      ) {
        throw permanent(
          "story_line_proposal.stale",
          "The compass or evidence changed while reviewing",
        );
      }
      if (result.value.lineProposals.length && baselineCompass) {
        new SqliteReviewRepository(this.database).insertCanonChangeSet({
          id: `${step.id}:story-lines`,
          projectId: snapshot.run.projectId,
          runId: snapshot.run.id,
          stepId: step.id,
          changes: StoryLineProposalChangesSchema.parse({
            kind: "story_line_progress",
            scopeNodeId: node.id,
            compass: StoryCompassSchema.parse(baselineCompass),
            evidenceFingerprint: evidenceBaseline.fingerprint,
            evidence: evidence.filter((chapter) =>
              compiled.sections.some(
                (section) => section.sourceId === chapter.chapterId,
              ),
            ),
            items: result.value.lineProposals,
          }),
          status: "candidate",
          createdAt: now,
        });
      }
      this.automation.insertPlanningReview({
        id: step.id,
        projectId: snapshot.run.projectId,
        sessionId,
        runId: snapshot.run.id,
        scopeType,
        outlineNodeId: node.id,
        summary,
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
        summary,
        stateDelta: {
          recommendations: result.value.recommendations,
          compassAdjustments: result.value.compassAdjustments,
          observations,
          lineEvidence,
        },
        sourceHash,
        createdAt: now,
      });
    });
    return {
      artifactKind: `${scopeType}-review`,
      output: {
        ...result.value,
        summary,
        observations,
        lineEvidence,
        outlineNodeId: node.id,
        sourceHash,
        generation: { mode: result.mode, attempts: result.attempts },
        contextReceiptId: compiled.receipt.id,
      },
      usage: result.usage,
    };
  }
}

/** Author direction and derived stage judgments have distinct model authority. */
function compassContextProjection(compass: StoryCompass | null) {
  const direction = compass
    ? {
        ...compass,
        longLines: compass.longLines.map(
          ({ title, promise, status, development }) => ({
            title,
            promise,
            status,
            ...(development
              ? {
                  development: {
                    scopeNodeId: development.scopeNodeId,
                    stageGoal: development.stageGoal,
                    nextDevelopment: development.nextDevelopment,
                  },
                }
              : {}),
          }),
        ),
      }
    : null;
  const longLines =
    compass?.longLines.flatMap((line, lineIndex) =>
      line.development
        ? [
            {
              lineIndex,
              title: line.title,
              scopeNodeId: line.development.scopeNodeId,
              progress: line.development.progress,
              openPromises: line.development.openPromises,
              evidenceChapterIds: line.development.evidenceChapterIds,
            },
          ]
        : [],
    ) ?? [];
  const sources: ContextSource[] = longLines.length
    ? [
        {
          id: "compass-stage-records",
          kind: "summary",
          label: "作者阶段记录（须以正文核实）",
          content: JSON.stringify({ longLines }),
          authority: "reference",
          priority: 90,
          compressible: false,
          sourceType: "story_compass",
          sourceId: compass!.projectId,
        },
      ]
    : [];
  return { direction, sources };
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

function permanent(code: string, message: string) {
  return { code, message, retryable: false };
}
