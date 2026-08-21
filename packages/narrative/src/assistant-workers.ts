import type {
  NarrativeRunStep,
  RunBudgetUsage,
  RunSnapshot,
} from "@narralume/domain";
import {
  assistantToolAccess,
  type AssistantToolName,
} from "@narralume/contracts";
import type {
  StepExecutionResult,
  StepWorker,
  WorkerRegistry,
} from "@narralume/harness";
import {
  SqliteAssistantRepository,
  SqliteAutomationRepository,
  SqliteCanonRepository,
  SqliteDocumentRepository,
  SqliteNarrativeStateRepository,
  SqliteProjectRepository,
  SqliteRunRepository,
  SqliteStoryRepository,
  type NarrativeDatabase,
} from "@narralume/persistence";

import type { NarrativeModelClient } from "./model-client.js";
import {
  ASSISTANT_REPLY_CONTRACT,
  AssistantReplyArtifactSchema,
  assistantReplyValidator,
  type AssistantReply,
  type AssistantToolCall,
} from "./assistant-schemas.js";
import { requireActiveProject } from "./project-guard.js";

interface AssistantContextArtifact extends Readonly<Record<string, unknown>> {
  conversationId: string;
  userMessageId: string;
  context: string;
  allowedTools: readonly AssistantToolDescriptor[];
  chapterIds: readonly string[];
  documentIds: readonly string[];
  controllableSources: readonly string[];
}

interface AssistantToolDescriptor {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly access: "read" | "auto" | "confirm";
}

export class AssistantWorkerSuite {
  private readonly assistants: SqliteAssistantRepository;
  private readonly automation: SqliteAutomationRepository;
  private readonly canon: SqliteCanonRepository;
  private readonly documents: SqliteDocumentRepository;
  private readonly narrativeState: SqliteNarrativeStateRepository;
  private readonly projects: SqliteProjectRepository;
  private readonly runs: SqliteRunRepository;
  private readonly story: SqliteStoryRepository;

  constructor(
    private readonly database: NarrativeDatabase,
    private readonly model: NarrativeModelClient,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.assistants = new SqliteAssistantRepository(database);
    this.automation = new SqliteAutomationRepository(database);
    this.canon = new SqliteCanonRepository(database);
    this.documents = new SqliteDocumentRepository(database);
    this.projects = new SqliteProjectRepository(database);
    this.runs = new SqliteRunRepository(database);
    this.story = new SqliteStoryRepository(database);
    this.narrativeState = new SqliteNarrativeStateRepository(
      database,
      this.canon,
      this.story,
    );
  }

  registry(): WorkerRegistry {
    return {
      "assistant.context": this.worker(this.compileContext.bind(this)),
      "assistant.respond": this.worker(this.respond.bind(this)),
      "assistant.stage": this.worker(this.stage.bind(this)),
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

  private async compileContext(
    snapshot: RunSnapshot,
  ): Promise<StepExecutionResult> {
    const conversationId = policyString(
      snapshot.run.policy,
      "assistantConversationId",
    );
    const userMessageId = policyString(
      snapshot.run.policy,
      "assistantUserMessageId",
    );
    const conversation = this.assistants.requireConversation(conversationId);
    const userMessage = this.assistants.requireMessage(userMessageId);
    if (
      conversation.projectId !== snapshot.run.projectId ||
      userMessage.conversationId !== conversation.id ||
      userMessage.role !== "user"
    ) {
      throw permanent(
        "assistant.context.mismatch",
        "Assistant conversation, message, and current project do not match",
      );
    }

    const project = this.projects.get(snapshot.run.projectId);
    if (!project) throw permanent("project.not_found", "Project not found");
    const outline = this.story.listOutline(project.id);
    const entities = this.canon.listEntities(project.id);
    const entityNames = new Map(
      entities.map((entity) => [entity.id, entity.name]),
    );
    const facts = this.canon.listEffectiveFacts(project.id);
    const relationships = this.narrativeState.listCurrentRelationships(
      project.id,
    );
    const timeline = this.narrativeState.listTimeline(project.id);
    const foreshadows = this.narrativeState.listForeshadows(project.id);
    const documents = this.documents.list(project.id);
    const activeRuns = this.runs
      .listActiveRuns(project.id)
      .filter((run) => run.recipe !== "assistant-turn");
    const activeSessions = this.automation
      .listSessions(project.id)
      .filter((session) => !isTerminalSessionStatus(session.status));
    const allowedTools = policyToolDescriptors(snapshot.run.policy);
    const selectedDocument = userMessage.context?.documentId
      ? this.documents.get(project.id, userMessage.context.documentId)
      : null;
    const selectedVersion = selectedDocument?.currentVersionId
      ? this.documents.getVersion(
          project.id,
          selectedDocument.id,
          selectedDocument.currentVersionId,
        )
      : null;
    const messages = this.assistants.listMessages(conversation.id);
    const triggerIndex = messages.findIndex(
      (message) => message.id === userMessage.id,
    );
    const recentMessages = messages
      .slice(Math.max(0, triggerIndex - 15), triggerIndex + 1)
      .map((message) => ({
        role: message.role,
        content: clipText(message.content, 8_000),
        context: message.context,
      }));
    const chapterNumbers = new Map(
      outline
        .filter((node) => node.kind === "chapter")
        .map((node, index) => [node.id, index + 1]),
    );

    const packet = {
      project: {
        id: project.id,
        title: project.title,
        subtitle: project.subtitle,
        premise: project.premise,
        language: project.language,
        phase: project.phase,
      },
      currentContext: userMessage.context,
      authorIntent: this.story.getAuthorIntent(project.id),
      outline: outline.slice(0, 160).map((node) => {
        const chapterNumber = chapterNumbers.get(node.id);
        return {
          id: node.id,
          parentId: node.parentId,
          kind: node.kind,
          ...(chapterNumber
            ? {
                chapterNumber,
                displayLabel: `第${chapterNumber}章`,
              }
            : {}),
          title: node.title,
          summary: node.summary,
          goal: node.goal,
          conflict: node.conflict,
          outcome: node.outcome,
          status: node.status,
        };
      }),
      canon: {
        entities: entities.slice(0, 160).map((entity) => ({
          id: entity.id,
          type: entity.type,
          name: entity.name,
          aliases: entity.aliases,
          description: entity.description,
          attributes: entity.attributes,
        })),
        facts: facts.slice(0, 240).map((fact) => ({
          id: fact.id,
          subject: entityNames.get(fact.subjectId) ?? fact.subjectId,
          predicate: fact.predicate,
          object: fact.objectEntityId
            ? (entityNames.get(fact.objectEntityId) ?? fact.objectEntityId)
            : fact.value,
          authority: fact.authority,
          validFromNodeId: fact.validFromNodeId,
          validToNodeId: fact.validToNodeId,
        })),
        relationships: relationships.slice(0, 160).map((relationship) => ({
          from:
            entityNames.get(relationship.fromEntityId) ??
            relationship.fromEntityId,
          to:
            entityNames.get(relationship.toEntityId) ?? relationship.toEntityId,
          relation: relationship.relation,
          intensity: relationship.intensity,
          state: relationship.state,
        })),
        timeline: timeline.slice(0, 160).map((event) => ({
          id: event.id,
          title: event.title,
          description: event.description,
          outlineNodeId: event.outlineNodeId,
          storyTimeStart: event.storyTimeStart,
          storyTimeEnd: event.storyTimeEnd,
          participants: event.participants.map(
            (id) => entityNames.get(id) ?? id,
          ),
        })),
        foreshadows: foreshadows.slice(0, 160).map((foreshadow) => ({
          id: foreshadow.id,
          title: foreshadow.title,
          description: foreshadow.description,
          status: foreshadow.status,
          importance: foreshadow.importance,
          targetFromNodeId: foreshadow.targetFromNodeId,
          targetToNodeId: foreshadow.targetToNodeId,
          resolutionNodeId: foreshadow.resolutionNodeId,
        })),
        totals: {
          entities: entities.length,
          facts: facts.length,
          relationships: relationships.length,
          timeline: timeline.length,
          foreshadows: foreshadows.length,
        },
      },
      documents: documents.slice(0, 120).map((document) => ({
        id: document.id,
        kind: document.kind,
        title: document.title,
        outlineNodeId: document.outlineNodeId,
        currentVersionId: document.currentVersionId,
      })),
      selectedDocument: selectedDocument
        ? {
            id: selectedDocument.id,
            title: selectedDocument.title,
            kind: selectedDocument.kind,
            outlineNodeId: selectedDocument.outlineNodeId,
            content: selectedVersion
              ? clipText(selectedVersion.content, 24_000)
              : null,
          }
        : null,
      conversation: recentMessages,
      activeTasks: {
        runs: activeRuns.map((run) => ({
          id: run.id,
          recipe: run.recipe,
          status: run.status,
          targetOutlineNodeId: run.targetOutlineNodeId,
          availableActions: runControlActions(run.status),
        })),
        autopilot: activeSessions.map((session) => ({
          id: session.id,
          status: session.status,
          mode: session.mode,
          completedChapters: session.completedChapters,
          targetChapters: session.targetChapters,
          availableActions: sessionControlActions(session.status),
        })),
      },
      allowedTools: allowedTools.map((tool) => ({
        name: tool.name,
        label: tool.label,
        description: tool.description,
        access: tool.access,
      })),
    };
    const controllableSources = [
      ...activeRuns.flatMap((run) =>
        runControlActions(run.status).map(
          (action) => `run:${run.id}:${action}`,
        ),
      ),
      ...activeSessions.flatMap((session) =>
        sessionControlActions(session.status).map(
          (action) => `autopilot:${session.id}:${action}`,
        ),
      ),
    ];
    return {
      artifactKind: "assistant-context",
      output: {
        conversationId,
        userMessageId,
        context: JSON.stringify(packet),
        allowedTools,
        chapterIds: outline
          .filter((node) => node.kind === "chapter")
          .map((node) => node.id),
        documentIds: documents.map((document) => document.id),
        controllableSources,
      } satisfies AssistantContextArtifact,
      usage: zeroUsage(),
    };
  }

  private async respond(
    snapshot: RunSnapshot,
    step: NarrativeRunStep,
    signal: AbortSignal,
  ): Promise<StepExecutionResult> {
    const context = assistantContextArtifact(
      requiredArtifact(snapshot, "assistant.context"),
    );
    /* 思考档来自对话设置（可选 policy 字段）：off=不发送参数让模型自决，
       未设置时保持旧默认 low。思考 token 会吃输出预算，档位越高输出上限同步抬高。 */
    const effort = snapshot.run.policy.assistantReasoningEffort;
    const effortCeiling: Record<"off" | "low" | "medium" | "high", number> = {
      off: 8_000,
      low: 8_000,
      medium: 16_000,
      high: 24_000,
    };
    const effectiveEffort =
      effort === "off" ||
      effort === "low" ||
      effort === "medium" ||
      effort === "high"
        ? effort
        : "low";
    const result = await this.model.structured(
      snapshot.run,
      step,
      "project-assistant",
      {
        instructions: [
          "你是长篇小说项目里的协作助手。用简明、自然的中文回答作者，并以提供的作品数据为唯一事实来源。",
          "明确区分已存在的事实、你的建议和尚未执行的操作；不得声称未发生的任务已经完成。",
          "你每次最多提出一个工具调用，而且只能从 allowedTools 中选择；工具名与参数必须严格匹配，不能虚构工具、参数、章节 ID、文档 ID 或任务 ID。",
          "章节序号一律以 outline 中的 chapterNumber 和 displayLabel 为准，从第 1 章开始；id 与 parentId 只是不可解读的内部标识，绝不能从其中推断章节序号。",
          "工具按 access 分级：read 只读直接回答（材料已在上下文中，toolCall 设为 null 即可）；auto 是候选生成或任务控制，用户明确要求时会直接执行，不会再追加确认；confirm 会先进入待确认卡片，由作者决定执行与否。正文采纳、Canon 采纳和永久删除不在工具面内，永远由作者在对应界面确认。",
          "先识别作者的最终目标，而不是只处理眼前缺失的前置条件。作者要求写作或创作正文、但尚无章节大纲时，必须使用 long_goal.start 串联补大纲与正文写作；已有故事方向时 braindump 传 null。只有作者明确只要大纲或规划、不要求正文时，才能使用 outline.plan.start。绝不能启动纯规划任务后声称还会自动继续写作。",
          "story.inspect / review.inspect 的材料已经包含在上下文中；能直接回答时将 toolCall 设为 null。只有用户明确要求执行动作时才提出工具调用；讨论、询问或征求意见时不要提出。",
          "回复中不要输出 JSON、代码围栏或内部实现细节。",
        ].join("\n"),
        messages: [{ role: "user", content: context.context }],
        ...(effectiveEffort === "off"
          ? {}
          : { reasoningEffort: effectiveEffort }),
        maxOutputTokens: Math.max(
          policyNumber(snapshot.run.policy, "assistantMaxOutputTokens", 3_000),
          effortCeiling[effectiveEffort],
        ),
      },
      ASSISTANT_REPLY_CONTRACT,
      assistantReplyValidator((reply) => validateToolCall(reply, context)),
      signal,
    );
    return {
      artifactKind: "assistant-reply",
      output: {
        ...result.value,
        generation: { mode: result.mode, attempts: result.attempts },
      },
      usage: result.usage,
    };
  }

  private async stage(snapshot: RunSnapshot): Promise<StepExecutionResult> {
    const context = assistantContextArtifact(
      requiredArtifact(snapshot, "assistant.context"),
    );
    const reply = AssistantReplyArtifactSchema.parse(
      requiredArtifact(snapshot, "assistant.respond"),
    );
    const userMessage = this.assistants.requireMessage(context.userMessageId);
    const now = this.now().toISOString();
    const assistantMessageId = `${snapshot.run.id}:assistant`;
    const activityId = reply.toolCall ? `${snapshot.run.id}:tool` : null;
    const toolCall = reply.toolCall;
    const access = toolCall ? assistantToolAccess(toolCall.name) : null;
    const stagedActivityId = access === "read" ? null : activityId;
    const executionMode = access === "read" ? null : access;
    this.database.transaction(() => {
      this.assistants.insertMessage({
        id: assistantMessageId,
        conversationId: context.conversationId,
        role: "assistant",
        content: reply.reply,
        context: userMessage.context,
        sourceRunId: snapshot.run.id,
        replyToMessageId: userMessage.id,
        createdAt: now,
      });
      if (toolCall && stagedActivityId) {
        // auto：候选生成或任务控制直接交办，不再追加确认卡片；
        // confirm：维持待确认卡片，由作者显式执行。
        const status = access === "auto" ? "running" : "proposed";
        this.assistants.insertActivity({
          id: stagedActivityId,
          conversationId: context.conversationId,
          messageId: assistantMessageId,
          kind: "tool_proposal",
          toolName: toolCall.name,
          status,
          goal: toolGoal(toolCall),
          input: toolCall.arguments,
          result: null,
          error: null,
          sourceType: null,
          sourceId: null,
          origin: userMessage.context,
          executionMode,
          skillId: null,
          phaseKey: null,
          artifacts: null,
          createdAt: now,
          updatedAt: now,
        });
      }
    });
    return {
      artifactKind: "assistant-staged",
      output: {
        conversationId: context.conversationId,
        messageId: assistantMessageId,
        activityId: stagedActivityId,
        executionMode,
      },
      usage: zeroUsage(),
    };
  }
}

function validateToolCall(
  reply: AssistantReply,
  context: AssistantContextArtifact,
): string[] {
  const call = reply.toolCall;
  if (!call) return [];
  const issues: string[] = [];
  if (!context.allowedTools.some((tool) => tool.name === call.name)) {
    issues.push(`toolCall.name: ${call.name} 不在服务器允许清单中`);
  }
  if (
    call.name === "chapter.start" &&
    !context.chapterIds.includes(call.arguments.targetOutlineNodeId)
  ) {
    issues.push("toolCall.arguments.targetOutlineNodeId: 不是当前作品的章节");
  }
  if (
    call.name === "selection.edit.start" &&
    (!context.documentIds.includes(call.arguments.documentId) ||
      call.arguments.selectionEnd <= call.arguments.selectionStart)
  ) {
    issues.push(
      "toolCall.arguments.documentId/selection: 不是当前作品的有效选区",
    );
  }
  if (
    call.name === "task.control" &&
    !context.controllableSources.includes(
      `${call.arguments.sourceType}:${call.arguments.sourceId}:${call.arguments.action}`,
    )
  ) {
    issues.push("toolCall.arguments.sourceId: 不是当前作品的可控制任务");
  }
  return issues;
}

function assistantContextArtifact(
  value: Readonly<Record<string, unknown>>,
): AssistantContextArtifact {
  const conversationId = stringField(value, "conversationId");
  const userMessageId = stringField(value, "userMessageId");
  const context = stringField(value, "context");
  return {
    conversationId,
    userMessageId,
    context,
    allowedTools: toolDescriptorArray(value.allowedTools),
    chapterIds: stringArray(value.chapterIds),
    documentIds: stringArray(value.documentIds),
    controllableSources: stringArray(value.controllableSources),
  };
}

function toolDescriptorArray(value: unknown): AssistantToolDescriptor[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === "string") {
      // 旧工件里 allowedTools 只是工具名数组；按默认策略重建描述。
      const access = assistantToolAccess(entry as AssistantToolName);
      return [{ name: entry, label: entry, description: "", access }];
    }
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Readonly<Record<string, unknown>>;
    const name = record.name;
    if (typeof name !== "string" || !name.trim()) return [];
    const access = assistantToolAccess(name as AssistantToolName);
    return [
      {
        name,
        label: typeof record.label === "string" ? record.label : name,
        description:
          typeof record.description === "string" ? record.description : "",
        access,
      },
    ];
  });
}

/** 工具活动卡片的 goal 机码：落库存储，展示文案由前端标签表渲染。
 *  数字参数（targetChapters）由投影层从 input 提取插值。 */
function toolGoal(call: AssistantToolCall): string {
  if (call.name === "foundation.start") return "tool.goal.foundation.start";
  if (call.name === "chapter.start") return "tool.goal.chapter.start";
  if (call.name === "autopilot.start") return "tool.goal.autopilot.start";
  if (call.name === "outline.plan.start") return "tool.goal.outline.plan.start";
  if (call.name === "canon.candidate.start") {
    return `tool.goal.canon.candidate.start.${call.arguments.spread}`;
  }
  if (call.name === "selection.edit.start")
    return "tool.goal.selection.edit.start";
  if (call.name === "long_goal.start") return "tool.goal.long_goal.start";
  if (call.name === "task.control") {
    return `tool.goal.task.control.${call.arguments.action}`;
  }
  return "tool.goal.info";
}

function requiredArtifact(
  snapshot: RunSnapshot,
  kind: NarrativeRunStep["kind"],
): Readonly<Record<string, unknown>> {
  const artifact = [...snapshot.steps]
    .reverse()
    .find(
      (candidate) =>
        candidate.kind === kind && candidate.status === "succeeded",
    )?.outputArtifact;
  if (!artifact)
    throw permanent("artifact.missing", `Missing artifact for step ${kind}`);
  return artifact;
}

function policyString(
  policy: Readonly<Record<string, unknown>>,
  key: string,
): string {
  const value = policy[key];
  if (typeof value !== "string" || !value.trim()) {
    throw permanent("policy.value.invalid", `Run policy is missing ${key}`);
  }
  return value;
}

function policyNumber(
  policy: Readonly<Record<string, unknown>>,
  key: string,
  fallback: number,
): number {
  const value = policy[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function policyToolDescriptors(
  policy: Readonly<Record<string, unknown>>,
): readonly AssistantToolDescriptor[] {
  return toolDescriptorArray(policy.assistantTools);
}

function stringField(
  value: Readonly<Record<string, unknown>>,
  key: string,
): string {
  const entry = value[key];
  if (typeof entry !== "string" || !entry.trim()) {
    throw permanent("artifact.value.invalid", `Artifact is missing ${key}`);
  }
  return entry;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function clipText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const head = Math.floor(limit * 0.68);
  const tail = limit - head;
  return `${value.slice(0, head)}\n\n[中间内容已省略]\n\n${value.slice(-tail)}`;
}

function isTerminalSessionStatus(status: string): boolean {
  return ["completed", "cancelled"].includes(status);
}

function runControlActions(
  status: string,
): Array<"pause" | "resume" | "cancel"> {
  if (status === "pending" || status === "running") return ["pause", "cancel"];
  if (status === "paused") return ["resume", "cancel"];
  if (status === "awaiting_user" || status === "failed_recoverable") {
    return ["cancel"];
  }
  return [];
}

function sessionControlActions(
  status: string,
): Array<
  | "pause"
  | "resume"
  | "cancel"
  | "retry-current"
  | "skip-chapter"
  | "replan"
  | "stop"
> {
  if (status === "pending" || status === "planning" || status === "running") {
    return ["pause", "cancel"];
  }
  if (status === "paused") return ["resume", "cancel"];
  if (status === "failed") {
    return ["retry-current", "skip-chapter", "replan", "stop"];
  }
  return [];
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

function permanent(code: string, message: string): Error {
  const error = new Error(message) as Error & {
    code: string;
    retryable: boolean;
  };
  error.code = code;
  error.retryable = false;
  return error;
}
