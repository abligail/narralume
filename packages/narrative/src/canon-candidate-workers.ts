import { CanonSpreadSchema, type CanonSpread } from "@narralume/contracts";
import type {
  NarrativeRunStep,
  RunBudgetUsage,
  RunSnapshot,
} from "@narralume/domain";
import type {
  StepExecutionResult,
  StepWorker,
  WorkerRegistry,
} from "@narralume/harness";
import {
  SqliteCanonRepository,
  SqliteDocumentRepository,
  SqliteProjectRepository,
  SqliteReviewRepository,
  SqliteStoryRepository,
  type NarrativeDatabase,
} from "@narralume/persistence";

import {
  candidateAfterInstructions,
  candidateSemanticIssues,
  materializeCandidateItems,
  readCanonSpread,
  type CanonSpreadState,
} from "./canon-candidate-context.js";
import {
  CANON_CANDIDATE_MODEL_CONTRACT,
  CanonCandidateModelResultSchema,
  canonCandidateModelValidator,
} from "./canon-candidate-schemas.js";
import { instructionsFor } from "./prompt-language.js";
import type { NarrativeModelClient } from "./model-client.js";
import { requireActiveProject } from "./project-guard.js";

interface CanonContextArtifact extends Readonly<Record<string, unknown>> {
  spread: CanonSpread;
  instruction: string;
  baseFingerprint: string;
  current: CanonSpreadState["value"];
  prompt: string;
}

export class CanonCandidateWorkerSuite {
  private readonly canon: SqliteCanonRepository;
  private readonly documents: SqliteDocumentRepository;
  private readonly projects: SqliteProjectRepository;
  private readonly reviews: SqliteReviewRepository;
  private readonly story: SqliteStoryRepository;

  constructor(
    private readonly database: NarrativeDatabase,
    private readonly model: NarrativeModelClient,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.canon = new SqliteCanonRepository(database);
    this.documents = new SqliteDocumentRepository(database);
    this.projects = new SqliteProjectRepository(database);
    this.reviews = new SqliteReviewRepository(database);
    this.story = new SqliteStoryRepository(database);
  }

  registry(): WorkerRegistry {
    return {
      "canon.context": this.worker(this.compileContext.bind(this)),
      "canon.candidate": this.worker(this.generateCandidate.bind(this)),
      "canon.stage": this.worker(this.stageCandidate.bind(this)),
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
    const project = this.projects.get(snapshot.run.projectId);
    if (!project) throw permanent("project.not_found", "Project not found");
    const spread = CanonSpreadSchema.parse(
      policyString(snapshot.run.policy, "canonSpread"),
    );
    const instruction = policyString(snapshot.run.policy, "canonInstruction");
    const current = readCanonSpread(this.database, project.id, spread);
    const outline = this.story.listOutline(project.id);
    const entities = this.canon.listEntities(project.id, {
      includeRetired: true,
    });
    const documents = this.documents
      .list(project.id)
      .filter((document) => document.currentVersionId)
      .slice(-8)
      .map((document) => {
        const version = this.documents.getVersion(
          project.id,
          document.id,
          document.currentVersionId!,
        );
        return {
          id: document.id,
          title: document.title,
          kind: document.kind,
          outlineNodeId: document.outlineNodeId,
          content: version ? clipText(version.content, 10_000) : null,
        };
      });
    const packet = {
      task: {
        spread,
        instruction,
        afterJsonFields: candidateAfterInstructions(spread),
      },
      project: {
        id: project.id,
        title: project.title,
        premise: project.premise,
        language: project.language,
      },
      currentSpread: current.value,
      supportingIndex: {
        authorIntent: this.story.getAuthorIntent(project.id),
        outline: outline.slice(0, 200).map((node) => ({
          id: node.id,
          parentId: node.parentId,
          kind: node.kind,
          title: node.title,
          summary: node.summary,
          goal: node.goal,
          status: node.status,
        })),
        entities: entities.slice(0, 240).map((entity) => ({
          id: entity.id,
          type: entity.type,
          name: entity.name,
          aliases: entity.aliases,
          description: entity.description,
        })),
      },
      recentManuscript: documents,
    };
    return {
      artifactKind: "canon-context",
      output: {
        spread,
        instruction,
        baseFingerprint: current.fingerprint,
        current: current.value,
        prompt: JSON.stringify(packet),
      } satisfies CanonContextArtifact,
      usage: zeroUsage(),
    };
  }

  private async generateCandidate(
    snapshot: RunSnapshot,
    step: NarrativeRunStep,
    signal: AbortSignal,
  ): Promise<StepExecutionResult> {
    const context = canonContextArtifact(
      requiredArtifact(snapshot, "canon.context"),
    );
    const result = await this.model.structured(
      snapshot.run,
      step,
      "canon-revision",
      {
        instructions: instructionsFor(
          this.projects.get(snapshot.run.projectId)?.language ?? null,
          {
            "zh-CN": [
              "你是长篇小说的故事圣经编辑。只根据提供的作品材料，为指定 Canon Spread 生成少量、可逐项裁定的候选修改。",
              "不要直接改写数据库，不要声称候选已经生效。每项必须说明理由和影响；没有必要的改动不要凑数。",
              "create 的 targetId 必须为 null；update 必须使用 currentSpread 中真实存在的 id。作者意图只能 update 且 targetId 固定为 intent。",
              "只有 facts 可以 withdraw，此时 afterJson 为 null；其他 create/update 的 afterJson 必须是一个 JSON 对象序列化后的字符串。",
              `afterJson 只能使用这些字段：${candidateAfterInstructions(context.spread)}。update 只放要改的字段，create 提供完整必填字段。`,
              "引用实体、大纲、因果或依赖时只能使用 supportingIndex 中给出的真实 ID。不得生成数据库 ID。",
              "不要修改锁定策略本身；如果建议触及锁定内容，仍作为候选说明，系统会要求作者二次确认。",
            ],
            en: [
              "You are the story bible editor of a long-form novel. Working only from the provided project material, generate a small number of individually adjudicable change candidates for the given Canon Spread.",
              "Never rewrite the database directly and never claim candidates took effect. Every item must state its reasoning and impact; do not pad with unnecessary changes.",
              "create's targetId must be null; update must use ids that actually exist in currentSpread. Author intent may only be updated, with targetId fixed to intent.",
              "Only facts can be withdrawn, with afterJson null in that case; every other create/update must carry afterJson as a serialized JSON object string.",
              `afterJson accepts only these fields: ${candidateAfterInstructions(context.spread)}. update carries only changed fields; create provides every required field.`,
              "When referencing entities, outline nodes, causes, or dependencies, use only real IDs given in supportingIndex. Never invent database IDs.",
              "Do not modify lock policies themselves; when a suggestion touches locked content, still describe it as a candidate and the system will ask the author to confirm again.",
            ],
          },
        ),
        messages: [{ role: "user", content: context.prompt }],
        reasoningEffort: "medium",
        maxOutputTokens: policyNumber(
          snapshot.run.policy,
          "canonMaxOutputTokens",
          6_000,
        ),
      },
      CANON_CANDIDATE_MODEL_CONTRACT,
      canonCandidateModelValidator((value) =>
        candidateSemanticIssues(context.spread, context.current, value),
      ),
      signal,
    );
    return {
      artifactKind: "canon-candidate",
      output: {
        ...result.value,
        generation: { mode: result.mode, attempts: result.attempts },
      },
      usage: result.usage,
    };
  }

  private async stageCandidate(
    snapshot: RunSnapshot,
    step: NarrativeRunStep,
  ): Promise<StepExecutionResult> {
    const context = canonContextArtifact(
      requiredArtifact(snapshot, "canon.context"),
    );
    const generatedArtifact = requiredArtifact(snapshot, "canon.candidate");
    const generated = CanonCandidateModelResultSchema.parse({
      summary: generatedArtifact.summary,
      items: generatedArtifact.items,
    });
    const changeSetId = `${snapshot.run.id}:canon-change-set`;
    const items = materializeCandidateItems(
      snapshot.run.projectId,
      context.spread,
      context.current,
      generated,
    );
    this.reviews.insertCanonChangeSet({
      id: changeSetId,
      projectId: snapshot.run.projectId,
      runId: snapshot.run.id,
      stepId: step.id,
      changes: {
        kind: "canon_spread_revision",
        spread: context.spread,
        instruction: context.instruction,
        summary: generated.summary,
        baseFingerprint: context.baseFingerprint,
        items,
      },
      status: "candidate",
      createdAt: this.now().toISOString(),
    });
    return {
      artifactKind: "canon-candidate-set",
      output: {
        candidateSetId: changeSetId,
        spread: context.spread,
        itemCount: items.length,
      },
      usage: zeroUsage(),
    };
  }
}

function canonContextArtifact(
  value: Readonly<Record<string, unknown>>,
): CanonContextArtifact {
  return {
    spread: CanonSpreadSchema.parse(value.spread),
    instruction: stringField(value, "instruction"),
    baseFingerprint: stringField(value, "baseFingerprint"),
    current:
      value.current === null ||
      Array.isArray(value.current) ||
      isRecord(value.current)
        ? value.current
        : null,
    prompt: stringField(value, "prompt"),
  };
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
  if (typeof value !== "string" || !value.trim())
    throw permanent("policy.value.invalid", `Run policy is missing ${key}`);
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

function stringField(
  value: Readonly<Record<string, unknown>>,
  key: string,
): string {
  const entry = value[key];
  if (typeof entry !== "string" || !entry.trim())
    throw permanent("artifact.value.invalid", `Artifact is missing ${key}`);
  return entry;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function clipText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.floor(limit * 0.7))}\n\n[中间内容已省略]\n\n${value.slice(-Math.ceil(limit * 0.3))}`;
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
