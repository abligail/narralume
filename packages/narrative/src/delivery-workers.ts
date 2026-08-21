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
  SqliteDeliveryRepository,
  SqliteProjectRepository,
  type NarrativeDatabase,
} from "@narralume/persistence";

import type { NarrativeModelClient } from "./model-client.js";
import { ParagraphLocator } from "./paragraph-locator.js";
import {
  requireActiveProject,
  requireActiveRunCommit,
} from "./project-guard.js";
import {
  deliveryValidator,
  IMPORT_ANALYSIS_CONTRACT,
  ImportAnalysisSchema,
  type ImportAnalysis,
} from "./delivery-schemas.js";

export class DeliveryWorkerSuite {
  private readonly delivery: SqliteDeliveryRepository;
  private readonly projects: SqliteProjectRepository;

  constructor(
    private readonly database: NarrativeDatabase,
    private readonly model: NarrativeModelClient,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.delivery = new SqliteDeliveryRepository(database);
    this.projects = new SqliteProjectRepository(database);
  }

  registry(): WorkerRegistry {
    return {
      "import.analyze": this.worker(this.analyzeImport.bind(this)),
      "import.stage": this.worker(this.stageAnalysis.bind(this)),
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

  private async analyzeImport(
    snapshot: RunSnapshot,
    step: NarrativeRunStep,
    signal: AbortSignal,
  ): Promise<StepExecutionResult> {
    const batchId = policyString(snapshot.run.policy, "batchId");
    const batch = this.delivery.requireImportBatch(batchId);
    requireAnalysisOwnership(batch, snapshot.run.id);
    if (batch.targetProjectId !== snapshot.run.projectId) {
      throw permanent(
        "import.project.mismatch",
        "The import batch does not belong to the current project",
      );
    }
    if (batch.format === "narrative-bundle") {
      throw permanent(
        "import.bundle.analysis_not_needed",
        "A full project bundle already contains structured data and does not need analysis again",
      );
    }
    const project = this.projects.get(snapshot.run.projectId);
    if (!project) throw permanent("project.not_found", "Project not found");
    const documents = this.importedText(batchId);
    if (!documents.trim()) {
      throw permanent(
        "import.content.empty",
        "There is no manuscript content for AI analysis",
      );
    }
    const chunkCharacters = Math.max(
      10_000,
      Math.min(
        policyNumber(snapshot.run.policy, "importChunkCharacters", 60_000),
        120_000,
      ),
    );
    const locator = new ParagraphLocator(documents);
    const chunks = splitImportParagraphs(locator, chunkCharacters);
    const chunkResults = await concurrentMap(
      chunks,
      Math.max(
        1,
        Math.min(
          3,
          Math.trunc(policyNumber(snapshot.run.policy, "importConcurrency", 2)),
        ),
      ),
      signal,
      async (chunk, index, chunkSignal): Promise<ImportChunkResult> => {
        const inputDigest = sha256(
          `${batch.sourceHash}\0chunk\0${index}\0${chunk.text}`,
        );
        const cached = this.delivery.getImportAnalysisArtifact(
          batchId,
          "chunk",
          index,
        );
        const cachedAnalysis =
          cached?.inputDigest === inputDigest
            ? ImportAnalysisSchema.safeParse(cached.output)
            : null;
        if (cachedAnalysis?.success) {
          return {
            analysis: cachedAnalysis.data,
            digest: cached!.outputDigest,
            usage:
              cached!.runId === snapshot.run.id ? cached!.usage : zeroUsage(),
            reused: true,
          };
        }
        const result = await this.model.structured(
          snapshot.run,
          step,
          `import-analysis-chunk-${index + 1}`,
          importAnalysisRequest({
            projectTitle: project.title,
            premise: project.premise,
            filename: batch.filename,
            text: chunk.promptText,
            rangeLabel: `分段 ${index + 1}/${chunks.length}`,
            maxOutputTokens: policyNumber(
              snapshot.run.policy,
              "analysisMaxOutputTokens",
              16_000,
            ),
          }),
          IMPORT_ANALYSIS_CONTRACT,
          deliveryValidator(ImportAnalysisSchema, (value) =>
            importEvidenceIssues(
              value,
              locator,
              new Set(chunk.paragraphOrdinals),
            ),
          ),
          chunkSignal,
        );
        const outputDigest = sha256(stableJson(result.value));
        const now = this.now().toISOString();
        this.delivery.upsertImportAnalysisArtifact({
          id: `${batchId}:chunk:${index}:${inputDigest.slice(0, 16)}`,
          batchId,
          runId: snapshot.run.id,
          stage: "chunk",
          ordinal: index,
          inputDigest,
          output: result.value,
          outputDigest,
          usage: result.usage,
          createdAt: cached?.createdAt ?? now,
          updatedAt: now,
        });
        return {
          analysis: result.value,
          digest: outputDigest,
          usage: result.usage,
          reused: false,
        };
      },
    );
    const analyses = chunkResults.map((result) => result.analysis);
    const digests = chunkResults.map((result) => result.digest);
    let usage = chunkResults.reduce(
      (total, result) => addUsage(total, result.usage),
      zeroUsage(),
    );
    let reusedArtifacts = chunkResults.filter((result) => result.reused).length;

    let aggregate = analyses[0]!;
    let aggregateDigest = digests[0]!;
    for (let index = 1; index < analyses.length; index += 1) {
      const inputDigest = sha256(
        `${aggregateDigest}\0${digests[index]}\0synthesis\0${index}`,
      );
      const cached = this.delivery.getImportAnalysisArtifact(
        batchId,
        "synthesis",
        index - 1,
      );
      const cachedAnalysis =
        cached?.inputDigest === inputDigest
          ? ImportAnalysisSchema.safeParse(cached.output)
          : null;
      if (cachedAnalysis?.success) {
        aggregate = cachedAnalysis.data;
        aggregateDigest = cached!.outputDigest;
        if (cached!.runId === snapshot.run.id)
          usage = addUsage(usage, cached!.usage);
        reusedArtifacts += 1;
        continue;
      }
      const result = await this.model.structured(
        snapshot.run,
        step,
        `import-analysis-synthesis-${index}`,
        importSynthesisRequest(
          aggregate,
          analyses[index]!,
          policyNumber(snapshot.run.policy, "analysisMaxOutputTokens", 16_000),
        ),
        IMPORT_ANALYSIS_CONTRACT,
        deliveryValidator(ImportAnalysisSchema, (value) =>
          importEvidenceIssues(value, locator),
        ),
        signal,
      );
      usage = addUsage(usage, result.usage);
      aggregate = result.value;
      aggregateDigest = sha256(stableJson(aggregate));
      const now = this.now().toISOString();
      this.delivery.upsertImportAnalysisArtifact({
        id: `${batchId}:synthesis:${index - 1}:${inputDigest.slice(0, 16)}`,
        batchId,
        runId: snapshot.run.id,
        stage: "synthesis",
        ordinal: index - 1,
        inputDigest,
        output: aggregate,
        outputDigest: aggregateDigest,
        usage: result.usage,
        createdAt: cached?.createdAt ?? now,
        updatedAt: now,
      });
    }
    return {
      artifactKind: "import-analysis",
      output: {
        ...aggregate,
        importPipeline: {
          sourceCharacters: documents.length,
          chunkCharacters,
          chunks: chunks.length,
          synthesisStages: Math.max(0, chunks.length - 1),
          reusedArtifacts,
          finalInputDigest: aggregateDigest,
        },
      },
      usage,
    };
  }

  private async stageAnalysis(
    snapshot: RunSnapshot,
    _step: NarrativeRunStep,
    signal: AbortSignal,
  ): Promise<StepExecutionResult> {
    const batchId = policyString(snapshot.run.policy, "batchId");
    requireAnalysisOwnership(
      this.delivery.requireImportBatch(batchId),
      snapshot.run.id,
    );
    const analysis = ImportAnalysisSchema.parse(
      requiredArtifact(snapshot, "import.analyze"),
    );
    const now = this.now().toISOString();
    const sourceText = this.importedText(batchId);
    const locator = new ParagraphLocator(sourceText);
    const withEvidence = <T extends { evidenceParagraphs: number[] }>(
      item: T,
    ) => ({ ...item, evidence: locator.locate(item.evidenceParagraphs) });
    const candidates = [
      {
        id: `${batchId}:intent:0`,
        kind: "intent" as const,
        ordinal: 0,
        title: "作者意图候选",
        payload: {
          promise: analysis.synopsis,
          themes: analysis.themes,
          audience: analysis.audience,
          tone: analysis.tone,
          boundaries: analysis.boundaries,
          endingDirection: null,
          currentFocus: null,
        },
      },
      {
        id: `${batchId}:style:1`,
        kind: "style" as const,
        ordinal: 1,
        title: analysis.style.name,
        payload: { ...analysis.style, active: false },
      },
      ...analysis.entities.map((entity, index) => ({
        id: `${batchId}:entity:${index}`,
        kind: "entity" as const,
        ordinal: index,
        title: entity.name,
        payload: { ...entity, attributes: {} },
      })),
      ...analysis.skills.map((skill, index) => ({
        id: `${batchId}:skill:${index}`,
        kind: "skill" as const,
        ordinal: index,
        title: skill.name,
        payload: { ...skill, enabled: true },
      })),
      ...analysis.relationships
        .map(withEvidence)
        .map((relationship, index) => ({
          id: `${batchId}:relationship:${index}`,
          kind: "relationship" as const,
          ordinal: index,
          title: `${relationship.fromName} · ${relationship.relation} · ${relationship.toName}`,
          payload: relationship,
        })),
      ...analysis.timeline.map(withEvidence).map((event, index) => ({
        id: `${batchId}:timeline:${index}`,
        kind: "timeline" as const,
        ordinal: index,
        title: event.title,
        payload: event,
      })),
      ...analysis.foreshadows.map(withEvidence).map((foreshadow, index) => ({
        id: `${batchId}:foreshadow:${index}`,
        kind: "foreshadow" as const,
        ordinal: index,
        title: foreshadow.title,
        payload: foreshadow,
      })),
      ...analysis.characterArcs.map(withEvidence).map((arc, index) => ({
        id: `${batchId}:character-arc:${index}`,
        kind: "character-arc" as const,
        ordinal: index,
        title: `${arc.characterName} · 角色弧`,
        payload: arc,
      })),
      ...analysis.scenes.map(withEvidence).map((scene, index) => ({
        id: `${batchId}:scene-analysis:${index}`,
        kind: "scene-analysis" as const,
        ordinal: index,
        title: scene.title,
        payload: scene,
      })),
    ];
    this.database.transaction(() => {
      requireActiveRunCommit(
        this.database,
        snapshot.run.id,
        snapshot.run.projectId,
        signal,
      );
      requireAnalysisOwnership(
        this.delivery.requireImportBatch(batchId),
        snapshot.run.id,
      );
      for (const item of candidates) {
        this.delivery.upsertImportCandidate({
          ...item,
          batchId,
          status: "pending",
          createdAt: now,
          updatedAt: now,
        });
      }
      this.delivery.updateImportBatch(
        batchId,
        { status: "ready", analysisRunId: snapshot.run.id },
        now,
      );
    });
    return {
      artifactKind: "import-candidate-set",
      output: { batchId, stagedCandidates: candidates.length },
      usage: zeroUsage(),
    };
  }

  private importedText(batchId: string): string {
    return this.delivery
      .listImportCandidates(batchId)
      .filter((candidate) => candidate.kind === "document")
      .map((candidate) => {
        const content = candidate.payload.content;
        return `# ${candidate.title}\n${typeof content === "string" ? content : ""}`;
      })
      .join("\n\n");
  }
}

function importAnalysisRequest(input: {
  projectTitle: string;
  premise: string | null;
  filename: string;
  text: string;
  rangeLabel: string;
  maxOutputTokens: number;
}) {
  return {
    instructions: [
      "你是长篇小说拆书编辑。只分析给定文本，不续写、不补齐、不模仿原句。",
      "输出是待作者裁定的候选，不是正典。实体必须有文本依据；不确定时宁缺毋滥。",
      "风格规则要可操作且与题材事实分离；examples 只能摘取很短的原文片段。",
      "Writing Skill 是可开关的流程指令，不能包含具体人物、世界事实或要求复制原文。",
      "分开提取关系、时间线、伏笔、角色弧和场景；每一项必须用 evidenceParagraphs 给出本分段中带 [P#] 标签的一个或多个原文段号。",
    ].join("\n"),
    messages: [
      {
        role: "user" as const,
        content: [
          `目标作品：《${input.projectTitle}》`,
          input.premise ? `已有命题：${input.premise}` : "",
          `导入文件：${input.filename}`,
          input.rangeLabel,
          `正文：\n${input.text}`,
          "请拆解概要、主题、受众、语气边界、实体、关系、时间线、伏笔、角色弧、场景、风格档案与 1-4 条通用写作 Skill。",
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    ],
    reasoningEffort: "medium" as const,
    maxOutputTokens: input.maxOutputTokens,
  };
}

function importSynthesisRequest(
  accumulated: ImportAnalysis,
  next: ImportAnalysis,
  maxOutputTokens: number,
) {
  return {
    instructions: [
      "你是长篇拆书结果的合并编辑。合并两份分段分析，去重但不得丢弃后段独有信息。",
      "证据 evidenceParagraphs 必须原样保留自输入分析，不得改写、合并段号或创造段号。",
      "时间线按全书因果顺序重新编号；同名实体谨慎合并，无法确认时分别保留。",
      "输出仍是同一份完整 ImportAnalysis JSON。",
    ].join("\n"),
    messages: [
      {
        role: "user" as const,
        content: `<accumulated>${JSON.stringify(accumulated)}</accumulated>\n<next>${JSON.stringify(next)}</next>`,
      },
    ],
    reasoningEffort: "medium" as const,
    maxOutputTokens,
  };
}

interface ImportTextChunk {
  text: string;
  promptText: string;
  paragraphOrdinals: number[];
}

interface ImportChunkResult {
  analysis: ImportAnalysis;
  digest: string;
  usage: RunBudgetUsage;
  reused: boolean;
}

async function concurrentMap<T, R extends { usage: RunBudgetUsage }>(
  items: readonly T[],
  concurrency: number,
  signal: AbortSignal,
  task: (item: T, index: number, signal: AbortSignal) => Promise<R>,
): Promise<R[]> {
  const results: Array<R | undefined> = new Array(items.length);
  const local = new AbortController();
  const combined = AbortSignal.any([signal, local.signal]);
  let cursor = 0;
  let firstError: unknown;
  const worker = async () => {
    while (!combined.aborted) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        results[index] = await task(items[index]!, index, combined);
      } catch (error) {
        if (firstError === undefined) {
          firstError = error;
          local.abort(error);
        }
        return;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () =>
      worker(),
    ),
  );
  if (firstError !== undefined || signal.aborted) {
    throw errorWithPartialUsage(
      firstError ?? {
        code: "model.cancelled",
        message: "Import analysis was cancelled",
        retryable: true,
      },
      results.filter((result): result is R => result !== undefined),
    );
  }
  return results as R[];
}

function errorWithPartialUsage<R extends { usage: RunBudgetUsage }>(
  error: unknown,
  completed: readonly R[],
): unknown {
  const partial = completed.reduce(
    (total, result) => addUsage(total, result.usage),
    zeroUsage(),
  );
  const existing = errorUsage(error);
  const usage = existing ? addUsage(partial, existing) : partial;
  if (error && typeof error === "object") return { ...error, usage };
  return {
    code: "import.analysis.failed",
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
    usage,
  };
}

function errorUsage(error: unknown): RunBudgetUsage | null {
  if (!error || typeof error !== "object") return null;
  const usage = (error as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return null;
  const candidate = usage as Partial<RunBudgetUsage>;
  return typeof candidate.calls === "number" &&
    typeof candidate.inputTokens === "number" &&
    typeof candidate.outputTokens === "number" &&
    typeof candidate.costUsd === "number" &&
    typeof candidate.wallTimeMs === "number"
    ? (candidate as RunBudgetUsage)
    : null;
}

function requireAnalysisOwnership(
  batch: { status: string; analysisRunId: string | null },
  runId: string,
): void {
  if (batch.status === "analyzing" && batch.analysisRunId === runId) return;
  const error = new Error("Import analysis is no longer writable");
  error.name = "AbortError";
  throw error;
}

function splitImportParagraphs(
  locator: ParagraphLocator,
  maxCharacters: number,
): ImportTextChunk[] {
  const chunks: ImportTextChunk[] = [];
  let ordinals: number[] = [];
  let characters = 0;
  const flush = () => {
    if (ordinals.length === 0) return;
    const selected = ordinals.map(
      (ordinal) => locator.paragraphs[ordinal - 1]!,
    );
    chunks.push({
      text: selected.map((paragraph) => paragraph.quote).join("\n\n"),
      promptText: locator.render(ordinals),
      paragraphOrdinals: ordinals,
    });
    ordinals = [];
    characters = 0;
  };
  for (const paragraph of locator.paragraphs) {
    const added = paragraph.quote.length + (ordinals.length > 0 ? 2 : 0);
    if (ordinals.length > 0 && characters + added > maxCharacters) flush();
    ordinals.push(paragraph.ordinal);
    characters += paragraph.quote.length + (ordinals.length > 1 ? 2 : 0);
  }
  flush();
  return chunks;
}

function sha256(value: string): string {
  return sha256Hex(value);
}

function addUsage(left: RunBudgetUsage, right: RunBudgetUsage): RunBudgetUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    calls: left.calls + right.calls,
    costUsd: left.costUsd + right.costUsd,
    wallTimeMs: left.wallTimeMs + right.wallTimeMs,
  };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}

function importEvidenceIssues(
  analysis: ImportAnalysis,
  locator: ParagraphLocator,
  allowedOrdinals?: ReadonlySet<number>,
): string[] {
  const issues: string[] = [];
  for (const key of [
    "relationships",
    "timeline",
    "foreshadows",
    "characterArcs",
    "scenes",
  ] as const) {
    analysis[key].forEach((item, index) => {
      issues.push(
        ...locator.validate(
          item.evidenceParagraphs,
          `${key}.${index}.evidenceParagraphs`,
          allowedOrdinals,
        ),
      );
    });
  }
  return issues;
}

function requiredArtifact(
  snapshot: RunSnapshot,
  kind: NarrativeRunStep["kind"],
) {
  const artifact = [...snapshot.steps]
    .reverse()
    .find(
      (step) => step.kind === kind && step.status === "succeeded",
    )?.outputArtifact;
  if (!artifact)
    throw permanent("artifact.missing", `Missing artifact for step ${kind}`);
  return { ...artifact };
}

function policyString(policy: Readonly<Record<string, unknown>>, key: string) {
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
) {
  const value = policy[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
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
  const error = new Error(message) as Error & {
    code: string;
    retryable: boolean;
  };
  error.code = code;
  error.retryable = false;
  return error;
}
import { sha256Hex } from "@narralume/domain";
