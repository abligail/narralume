import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { CanonEntity, RunStepKind, StoryCompass } from "@narralume/domain";
import type { ModelProtocol, FetchLike } from "@narralume/llm";
import type { NarrativeModelClient } from "@narralume/narrative";
import type {
  NarrativeDatabase,
  SqliteStoryRepository,
} from "@narralume/persistence";
import type * as ProductionDomain from "@narralume/domain";
import type * as ProductionHarness from "@narralume/harness";
import type * as ProductionContracts from "@narralume/contracts";
import type * as ProductionNarrative from "@narralume/narrative";
import type * as ProductionPersistence from "@narralume/persistence";
import type * as ProductionDatabase from "@narralume/persistence/node";
import type * as ProductionServices from "@narralume/services";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureTime = "2026-10-04T00:00:00.000Z";
const productionPackages = [
  "contracts",
  "context",
  "domain",
  "harness",
  "llm",
  "narrative",
  "persistence",
  "services",
] as const;

export interface SemanticCase {
  id: string;
  title: string;
  language: "zh-CN" | "en";
  scope: { title: string; kind: "arc" | "volume" };
  compass: Omit<StoryCompass, "projectId" | "version" | "updatedAt">;
  authorIntent?: Omit<
    Parameters<SqliteStoryRepository["upsertAuthorIntent"]>[0],
    "projectId" | "updatedAt"
  >;
  entities?: Pick<
    CanonEntity,
    "id" | "type" | "name" | "aliases" | "description" | "status"
  >[];
  chapters: {
    id: string;
    title: string;
    content: string;
    inScope: boolean;
    source: {
      database: string;
      projectId: string;
      documentId: string;
      versionId: string;
      contentHash: string;
      chapterNumber: number;
    };
    summary?: string;
    summaryPoints?: unknown[];
  }[];
  rubric: {
    expected: string[];
    forbidden: string[];
    allowed: string[];
    knowledgeBoundaries: string[];
    notes: string | string[];
    sourceEvidence: {
      chapterId: string;
      paragraphOrdinals: number[];
      paragraphs?: ReturnType<ProductionNarrative.ParagraphLocator["locate"]>;
    }[];
  };
}
export interface SemanticDataset {
  version: string;
  cases: SemanticCase[];
}
export type EvalStage = "review" | "planner";
export interface SemanticEvalArgs {
  cases: string[] | null;
  repeats: number;
  outputDir: string;
  dataset: string;
  label: string;
  stage: EvalStage | "both";
  concurrency: number;
  protocol: ModelProtocol;
  resume: boolean;
  prepareOnly: boolean;
  help: boolean;
}

export const semanticEvalUsage = `Usage: npm run eval:memory:semantic -- [options]
  --dataset PATH       fixed corpus (default evals/narrative-memory-semantic-v1.json)
  --cases ID,ID        selected cases (default all six)
  --repeats N          repetitions per case (default 3)
  --stage both         production review then rolling planner (review/planner also accepted)
  --concurrency N      isolated case databases in flight, 1 or 2 (default 1)
  --protocol NAME      openai-responses/openai-chat/anthropic-messages
  --label NAME         baseline or candidate identity (default baseline)
  --output-dir PATH    artifact directory (default .tmp/narrative-memory-semantic)
  --resume             reuse each stage's first valid completion; retry missing stages in a fresh attempt directory
  --prepare-only       capture production requests without making model calls
  --help
Credentials and model configuration come only from the existing NARRATIVE_* environment variables.
No dotenv/private configuration files are read. Semantic acceptance requires explicit scores with reviewer attribution.
Both stages use separate databases seeded from the same fixture. Compilation uses the configured Gateway model limits.`;

export function parseSemanticEvalArgs(
  argv: readonly string[],
): SemanticEvalArgs {
  const args: SemanticEvalArgs = {
    cases: null,
    repeats: 3,
    outputDir: ".tmp/narrative-memory-semantic",
    dataset: "evals/narrative-memory-semantic-v1.json",
    label: "baseline",
    stage: "both",
    concurrency: 1,
    protocol: "openai-responses",
    resume: false,
    prepareOnly: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--help") {
      args.help = true;
      continue;
    }
    if (argument === "--resume") {
      args.resume = true;
      continue;
    }
    if (argument === "--prepare-only") {
      args.prepareOnly = true;
      continue;
    }
    const separator = argument.indexOf("=");
    const key = separator < 0 ? argument : argument.slice(0, separator);
    const value = separator < 0 ? argv[++index] : argument.slice(separator + 1);
    if (!value || value.startsWith("--"))
      throw new Error(`Missing value for ${key}`);
    switch (key) {
      case "--cases":
        args.cases = [
          ...new Set(
            value
              .split(",")
              .map((id) => id.trim())
              .filter(Boolean),
          ),
        ];
        if (!args.cases.length)
          throw new Error("--cases must contain a case ID");
        break;
      case "--repeats":
        args.repeats = positiveInteger(value, key, 100);
        break;
      case "--concurrency":
        args.concurrency = positiveInteger(value, key, 2);
        break;
      case "--output-dir":
        args.outputDir = value;
        break;
      case "--dataset":
        args.dataset = value;
        break;
      case "--label":
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(value))
          throw new Error("Invalid --label");
        args.label = value;
        break;
      case "--stage":
        if (!["review", "planner", "both"].includes(value))
          throw new Error("Invalid --stage");
        args.stage = value as SemanticEvalArgs["stage"];
        break;
      case "--protocol":
        if (
          !["openai-responses", "openai-chat", "anthropic-messages"].includes(
            value,
          )
        )
          throw new Error("Invalid --protocol");
        args.protocol = value as ModelProtocol;
        break;
      default:
        throw new Error(`Unknown option ${key}`);
    }
  }
  return args;
}
function positiveInteger(value: string, name: string, maximum: number): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum)
    throw new Error(`${name} must be an integer from 1 to ${maximum}`);
  return result;
}
export function sha256Text(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
export function sha256Json(value: unknown): string {
  return sha256Text(JSON.stringify(value));
}
export function redact<T>(value: T, secrets: readonly string[]): T {
  const json = JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item !== "string") return item;
    return secrets
      .filter(Boolean)
      .reduce((text, secret) => text.replaceAll(secret, "[REDACTED]"), item);
  });
  return JSON.parse(json) as T;
}
function writeJson(
  path: string,
  value: unknown,
  secrets: readonly string[] = [],
): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify(redact(value, secrets), null, 2)}\n`,
    "utf8",
  );
}
function filesBelow(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .flatMap((item) =>
      item.isDirectory()
        ? filesBelow(join(path, item.name))
        : [join(path, item.name)],
    )
    .sort();
}
interface FileIdentity {
  path: string;
  sha256: string;
}
export interface ProductionIdentity {
  sourceDigest: string;
  distDigest: string;
  sourceFiles: FileIdentity[];
  distFiles: FileIdentity[];
  gitCommit: string;
  gitDirty: boolean;
  nodeVersion: string;
  typescriptVersion: string;
  entrypoints: Record<string, string>;
}
function sourceInventory(root: string): string[] {
  return [
    "tsconfig.base.json",
    "package-lock.json",
    "scripts/narrative-memory-semantic-eval.ts",
    ...productionPackages.flatMap((name) => [
      `packages/${name}/package.json`,
      `packages/${name}/tsconfig.json`,
      ...filesBelow(join(root, "packages", name, "src"))
        .filter((path) => path.endsWith(".ts"))
        .map((path) => relative(root, path)),
    ]),
  ]
    .map((path) => path.replaceAll("\\", "/"))
    .sort();
}
function distInventory(root: string): string[] {
  return productionPackages
    .flatMap((name) =>
      filesBelow(join(root, "packages", name, "dist"))
        .filter((path) => path.endsWith(".js"))
        .map((path) => relative(root, path).replaceAll("\\", "/")),
    )
    .sort();
}
function fileIdentities(
  root: string,
  paths: readonly string[],
): FileIdentity[] {
  return paths.map((path) => ({
    path,
    sha256: sha256Text(readFileSync(join(root, path))),
  }));
}
export function buildProductionIdentity(root: string): ProductionIdentity {
  const before = fileIdentities(root, sourceInventory(root));
  const build = spawnSync(
    process.execPath,
    [
      join(root, "node_modules", "typescript", "bin", "tsc"),
      "-b",
      "--force",
      "--pretty",
      "false",
      "packages/narrative",
      "packages/services",
    ],
    { cwd: root, encoding: "utf8" },
  );
  if (build.status !== 0)
    throw new Error(
      `Production build failed before model calls:\n${build.stdout}\n${build.stderr}`,
    );
  const sourceFiles = fileIdentities(root, sourceInventory(root));
  if (sha256Json(before) !== sha256Json(sourceFiles))
    throw new Error(
      "Source changed during production build; run again with stable source",
    );
  for (const file of sourceFiles.filter(
    (item) => item.path.includes("/src/") && !item.path.endsWith(".d.ts"),
  )) {
    const emitted = file.path
      .replace("/src/", "/dist/")
      .replace(/\.ts$/u, ".js");
    if (!existsSync(join(root, emitted)))
      throw new Error(`Production emit missing: ${emitted}`);
  }
  const distFiles = fileIdentities(root, distInventory(root));
  const typescriptVersion = (
    JSON.parse(
      readFileSync(join(root, "node_modules/typescript/package.json"), "utf8"),
    ) as { version: string }
  ).version;
  return {
    sourceDigest: sha256Json(sourceFiles),
    distDigest: sha256Json(distFiles),
    sourceFiles,
    distFiles,
    gitCommit: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
    gitDirty: Boolean(
      execFileSync("git", ["status", "--porcelain"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
    ),
    nodeVersion: process.version,
    typescriptVersion,
    entrypoints: Object.fromEntries(
      productionPackages.map((name) => [
        name,
        `packages/${name}/dist/index.js`,
      ]),
    ),
  };
}
export function verifyProductionIdentity(
  root: string,
  identity: ProductionIdentity,
): void {
  if (
    sha256Json(fileIdentities(root, sourceInventory(root))) !==
      identity.sourceDigest ||
    sha256Json(fileIdentities(root, distInventory(root))) !==
      identity.distDigest
  ) {
    throw new Error(
      "Production source or dist changed after verified build; refusing model call",
    );
  }
}
export interface EvalRunIdentity {
  datasetHash: string;
  codeSourceDigest: string;
  codeDistDigest: string;
  profileHash: string;
  stage: SemanticEvalArgs["stage"];
  label: string;
  repeats: number;
  cases: string[];
  prepareOnly: boolean;
}
export function assertResumeIdentity(
  previous: EvalRunIdentity,
  current: EvalRunIdentity,
): void {
  if (sha256Json(previous) !== sha256Json(current))
    throw new Error(
      "Resume identity differs: keep the same dataset, code, profile, stages, cases and repeats or use a new output directory",
    );
}
export function validateDataset(dataset: SemanticDataset): void {
  if (
    !dataset.version ||
    !Array.isArray(dataset.cases) ||
    !dataset.cases.length
  )
    throw new Error("Invalid semantic dataset");
  const ids = new Set<string>();
  for (const testCase of dataset.cases) {
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(testCase.id) ||
      ids.has(testCase.id)
    )
      throw new Error("Dataset case IDs must be unique, safe directory names");
    ids.add(testCase.id);
    if (
      !["zh-CN", "en"].includes(testCase.language) ||
      !["arc", "volume"].includes(testCase.scope.kind) ||
      !testCase.scope.title
    )
      throw new Error(`Invalid scope/language in ${testCase.id}`);
    if (
      !testCase.chapters.length ||
      !testCase.chapters.some((chapter) => chapter.inScope)
    )
      throw new Error(`No target prose in ${testCase.id}`);
    let targetStarted = false;
    let previousNumber = 0;
    const chapterIds = new Set<string>();
    for (const chapter of testCase.chapters) {
      if (chapterIds.has(chapter.id) || !chapter.id || !chapter.content.trim())
        throw new Error(`Invalid chapter in ${testCase.id}`);
      chapterIds.add(chapter.id);
      if (targetStarted && !chapter.inScope)
        throw new Error(
          `Historical chapters must precede target prose in ${testCase.id}`,
        );
      targetStarted ||= chapter.inScope;
      if (
        !Number.isSafeInteger(chapter.source.chapterNumber) ||
        chapter.source.chapterNumber <= previousNumber
      )
        throw new Error(`Source chapters must be ordered in ${testCase.id}`);
      previousNumber = chapter.source.chapterNumber;
      if (
        sha256Text(chapter.content) !== chapter.source.contentHash ||
        !chapter.source.versionId
      )
        throw new Error(
          `Source content hash/version mismatch in ${testCase.id}`,
        );
    }
    for (const evidence of testCase.rubric.sourceEvidence) {
      if (!chapterIds.has(evidence.chapterId))
        throw new Error(
          `Rubric evidence is outside the fixture in ${testCase.id}`,
        );
    }
  }
}

type Production = {
  domain: typeof ProductionDomain;
  harness: typeof ProductionHarness;
  contracts: typeof ProductionContracts;
  narrative: typeof ProductionNarrative;
  persistence: typeof ProductionPersistence;
  database: typeof ProductionDatabase;
  services: typeof ProductionServices;
};
export function validateDatasetEvidence(
  production: Production,
  dataset: SemanticDataset,
): void {
  for (const testCase of dataset.cases)
    for (const evidence of testCase.rubric.sourceEvidence) {
      const chapter = testCase.chapters.find(
        (item) => item.id === evidence.chapterId,
      )!;
      const fresh = new production.narrative.ParagraphLocator(chapter.content, {
        documentVersionId: chapter.source.versionId,
      }).locate(evidence.paragraphOrdinals);
      if (
        evidence.paragraphs &&
        (evidence.paragraphs.length !== fresh.length ||
          evidence.paragraphs.some((expected, index) => {
            const actual = fresh[index]!;
            return (
              expected.quote !== actual.quote ||
              expected.start !== actual.start ||
              expected.end !== actual.end ||
              expected.paragraphOrdinal !== actual.paragraphOrdinal ||
              expected.documentVersionId !== actual.documentVersionId ||
              expected.contentHash !== actual.contentHash
            );
          }))
      )
        throw new Error(
          `Rubric evidence differs from the immutable source in ${testCase.id}`,
        );
    }
}
async function loadProduction(root: string): Promise<Production> {
  const load = (name: string, file = "index.js") =>
    import(pathToFileURL(join(root, "packages", name, "dist", file)).href);
  const [
    domain,
    harness,
    contracts,
    narrative,
    persistence,
    database,
    services,
  ] = await Promise.all([
    load("domain"),
    load("harness"),
    load("contracts"),
    load("narrative"),
    load("persistence"),
    load("persistence", "node.js"),
    load("services"),
  ]);
  return {
    domain,
    harness,
    contracts,
    narrative,
    persistence,
    database,
    services,
  } as Production;
}
function configureProfile(
  production: Production,
  database: NarrativeDatabase,
  environment: Readonly<Record<string, string | undefined>>,
  args: SemanticEvalArgs,
) {
  const { persistence } = production;
  production.services.seedEnvironmentModelConfig(
    database,
    environment,
    fixtureTime,
  );
  const modelId = {
    "openai-responses": "environment-responses",
    "openai-chat": "environment-chat",
    "anthropic-messages": "environment-anthropic",
  }[args.protocol];
  const models = new persistence.SqliteModelRepository(database);
  const providers = new persistence.SqliteProviderRepository(database);
  if (args.prepareOnly && !models.get(modelId)) {
    providers.upsert({
      id: modelId,
      name: "Capture only",
      wireApi: args.protocol,
      baseUrl: "https://invalid.example",
      endpoint: null,
      credentialRef: "env:SEMANTIC_EVAL_UNUSED",
      anthropicVersion: null,
      headers: {},
      queryParams: {},
      requestStartTimeoutMs: null,
      streamIdleTimeoutMs: null,
      enabled: true,
      createdAt: fixtureTime,
      updatedAt: fixtureTime,
    });
    models.upsert({
      id: modelId,
      providerId: modelId,
      modelId: "capture-only",
      taskType: "writing",
      contextWindow: 64_000,
      maxOutputTokens: 16_000,
      sampling: {},
      capabilities: {},
      metadataSource: "environment",
      metadataVerifiedAt: fixtureTime,
      enabled: true,
      createdAt: fixtureTime,
      updatedAt: fixtureTime,
    });
  }
  const model = models.get(modelId);
  const provider = model ? providers.get(model.providerId) : null;
  if (!model || !provider || !provider.credentialRef.startsWith("env:"))
    throw new Error(
      "Requested protocol requires environment-only model configuration",
    );
  const credential = persistence.resolveCredential(provider, environment);
  if (!args.prepareOnly && !credential.ok)
    throw new Error("Requested model credential is missing from environment");
  const url = new URL(provider.baseUrl);
  if (url.username || url.password)
    throw new Error("Provider URL must not contain credentials");
  const assignments = new persistence.SqliteAssignmentRepository(database);
  for (const role of ["writing", "planning", "review"] as const)
    assignments.set(role, model.id, fixtureTime);
  return {
    profile: {
      protocol: provider.wireApi,
      modelId: model.modelId,
      baseUrlOrigin: url.origin,
      baseUrlPath: url.pathname,
      baseUrlHash: sha256Text(provider.baseUrl),
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens,
      sampling: model.sampling,
      capabilities: model.capabilities,
      metadataSource: model.metadataSource,
      metadataVerifiedAt: model.metadataVerifiedAt,
      runtimePolicy: "production defaults",
      compilationLimits:
        "Gateway effective limits; per-stage actual budget is recorded in context-receipts.json",
      prepareOnly: args.prepareOnly,
    },
    secrets: credential.ok ? [credential.apiKey] : [],
  };
}

export function seedSemanticFixture(
  production: Production,
  database: NarrativeDatabase,
  testCase: SemanticCase,
) {
  const { domain, persistence, contracts } = production;
  const prefix = `eval-${sha256Text(testCase.id).slice(0, 16)}`;
  const projectId = `${prefix}-project`;
  const projects = new persistence.SqliteProjectRepository(database);
  projects.insert(
    domain.createProject({
      id: projectId,
      title: "Manuscript",
      language: testCase.language,
      now: fixtureTime,
    }),
  );
  const story = new persistence.SqliteStoryRepository(database);
  if (testCase.authorIntent)
    story.upsertAuthorIntent({
      ...testCase.authorIntent,
      projectId,
      updatedAt: fixtureTime,
    });
  const canon = new persistence.SqliteCanonRepository(database);
  for (const entity of testCase.entities ?? [])
    canon.insertEntity({
      ...entity,
      projectId,
      attributes: {},
      createdAt: fixtureTime,
      updatedAt: fixtureTime,
    });
  const root = story.insertOutlineNode(
    domain.createOutlineNode({
      id: `${prefix}-book`,
      projectId,
      parent: null,
      kind: "book",
      ordinal: 0,
      title: "Manuscript",
      now: fixtureTime,
    }),
  );
  const volume = story.insertOutlineNode(
    domain.createOutlineNode({
      id: `${prefix}-volume`,
      projectId,
      parent: root,
      kind: "volume",
      ordinal: 0,
      title:
        testCase.scope.kind === "volume"
          ? testCase.scope.title
          : "Current volume",
      now: fixtureTime,
    }),
  );
  const previous = testCase.chapters.some((chapter) => !chapter.inScope)
    ? story.insertOutlineNode(
        domain.createOutlineNode({
          id: `${prefix}-history`,
          projectId,
          parent: testCase.scope.kind === "volume" ? root : volume,
          kind: testCase.scope.kind,
          ordinal: 0,
          title: "Prior stage",
          now: fixtureTime,
        }),
      )
    : null;
  if (previous && testCase.scope.kind === "volume")
    story.updateOutlineOrdinal(projectId, volume.id, 1, fixtureTime);
  const target =
    testCase.scope.kind === "volume"
      ? volume
      : story.insertOutlineNode(
          domain.createOutlineNode({
            id: `${prefix}-arc`,
            projectId,
            parent: volume,
            kind: "arc",
            ordinal: previous ? 1 : 0,
            title: testCase.scope.title,
            now: fixtureTime,
          }),
        );
  const documents = new persistence.SqliteDocumentRepository(database);
  const state = new persistence.SqliteNarrativeStateRepository(
    database,
    new persistence.SqliteCanonRepository(database),
    story,
  );
  const provenance = testCase.chapters.map((chapter, index) => {
    const parent = chapter.inScope ? target : previous!;
    story.insertOutlineNode(
      domain.createOutlineNode({
        id: chapter.id,
        projectId,
        parent,
        kind: "chapter",
        ordinal: index,
        title: chapter.title,
        now: fixtureTime,
      }),
    );
    story.updateOutlineStatus(projectId, chapter.id, "committed", fixtureTime);
    const documentId = chapter.source.documentId;
    documents.insert(
      domain.createDocument({
        id: documentId,
        projectId,
        kind: "chapter",
        title: chapter.title,
        outlineNodeId: chapter.id,
        now: fixtureTime,
      }),
    );
    const version = documents.appendVersion(projectId, documentId, {
      id: chapter.source.versionId,
      content: chapter.content,
      source: "semantic-eval-fixture",
      now: fixtureTime,
    });
    if (version.contentHash !== chapter.source.contentHash)
      throw new Error("Fixture immutable version hash changed during import");
    if (chapter.summary !== undefined)
      state.upsertSummary({
        id: `${prefix}-summary-${index}`,
        projectId,
        scopeType: "chapter",
        scopeId: chapter.id,
        summary: chapter.summary,
        stateDelta: {
          ...(chapter.summaryPoints
            ? { summaryPoints: chapter.summaryPoints }
            : {}),
        },
        sourceHash: version.contentHash,
        createdAt: fixtureTime,
      });
    return {
      chapterId: chapter.id,
      source: chapter.source,
      evaluation: {
        projectId,
        documentId,
        versionId: version.id,
        contentHash: version.contentHash,
        chapterNumber: index + 1,
        inScope: chapter.inScope,
      },
    };
  });
  const automation = new persistence.SqliteAutomationRepository(database);
  automation.upsertCompass(
    contracts.StoryCompassSchema.parse({
      ...testCase.compass,
      projectId,
      version: 1,
      updatedAt: fixtureTime,
    }),
  );
  const session = automation.createSession({
    id: `${prefix}-session`,
    projectId,
    mode: "autopilot",
    targetChapters: 2,
    windowSize: 2,
    maxRevisionCycles: 0,
    chapterPolicy: {},
    now: fixtureTime,
  });
  return {
    projectId,
    scopeId: target.id,
    scopeKind: testCase.scope.kind,
    sessionId: session.id,
    rootId: root.id,
    provenance,
  };
}

export interface StageResult {
  stage: EvalStage;
  status: "completed" | "failed" | "prepared";
  runId: string;
  requestHash: string | null;
  outputPath: string | null;
  artifactSha256: string | null;
  receiptPath: string;
  ledger: {
    logicalCalls: number;
    physicalAttempts: number;
    repairAttempts: number;
    transportErrors: number;
  };
  error: unknown;
}
interface StageExecution {
  attempt: number;
  path: string;
  stage: EvalStage;
  status: StageResult["status"] | "unfinished";
  result: StageResult | null;
  ledger: StageResult["ledger"];
}
interface UnitResult {
  caseId: string;
  repeat: number;
  attempt: number;
  path: string;
  stages: StageResult[];
  status: "completed" | "failed" | "prepared";
  executions: StageExecution[];
  ledger: StageResult["ledger"];
}
interface Grade {
  caseId: string;
  repeat: number;
  stages: Partial<
    Record<
      EvalStage,
      {
        verdict: "unscored" | "pass" | "fail";
        notes: string;
        outputPath: string | null;
        artifactSha256: string | null;
      }
    >
  >;
}
interface GradingSheet {
  reviewer: string | null;
  reviewedAt: string | null;
  units: Grade[];
}
function safeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error)
    return {
      name: error.name,
      message: error.message,
      ...("code" in error ? { code: error.code } : {}),
    };
  if (error && typeof error === "object")
    return Object.fromEntries(
      ["code", "message", "retryable", "usage", "details"]
        .filter((key) => key in error)
        .map((key) => [key, (error as Record<string, unknown>)[key]]),
    );
  return { message: String(error) };
}
export function scoredAcceptance(
  stages: readonly EvalStage[],
  results: readonly StageResult[],
  grade: Grade | undefined,
  sheet: GradingSheet,
): boolean {
  return Boolean(
    sheet.reviewer?.trim() &&
    sheet.reviewedAt &&
    Number.isFinite(Date.parse(sheet.reviewedAt)) &&
    stages.every((stage) => {
      const result = results.find((item) => item.stage === stage);
      const score = grade?.stages[stage];
      return (
        result?.status === "completed" &&
        score?.verdict === "pass" &&
        Boolean(result.outputPath && result.artifactSha256) &&
        score.outputPath === result.outputPath &&
        score.artifactSha256 === result.artifactSha256 &&
        Boolean(result.requestHash) &&
        validRequestHash(join(dirname(result.outputPath!), "request.json")) ===
          result.requestHash &&
        validOutputHash(result.outputPath) === result.artifactSha256
      );
    }),
  );
}
function validOutputHash(path: string | null): string | null {
  if (!path || !existsSync(path)) return null;
  try {
    const bytes = readFileSync(path);
    const output = JSON.parse(bytes.toString("utf8")) as {
      artifactKind?: unknown;
      output?: unknown;
    };
    return typeof output?.artifactKind === "string" &&
      output.output !== null &&
      typeof output.output === "object"
      ? sha256Text(bytes)
      : null;
  } catch {
    return null;
  }
}
function readArtifact<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}
function validRequestHash(path: string): string | null {
  const captured = readArtifact<{
    purpose?: unknown;
    request?: unknown;
    contract?: unknown;
    requestHash?: unknown;
  }>(path);
  if (
    typeof captured?.purpose !== "string" ||
    !captured.request ||
    typeof captured.request !== "object" ||
    Array.isArray(captured.request) ||
    !captured.contract ||
    typeof captured.contract !== "object" ||
    Array.isArray(captured.contract)
  )
    return null;
  const hash = sha256Json({
    purpose: captured.purpose,
    request: captured.request,
    contract: captured.contract,
  });
  return captured.requestHash === hash ? hash : null;
}
function executionLedger(
  directory: string,
  saved: StageResult | null,
): StageResult["ledger"] {
  const files = readdirSync(directory);
  const requests = files.filter((name) =>
    /^wire-\d+\.request\.json$/u.test(name),
  );
  const transport = files
    .filter((name) => /^wire-\d+\.transport\.json$/u.test(name))
    .map((name) => readArtifact<Record<string, unknown>>(join(directory, name)))
    .filter((item) => item !== null);
  const eventsPath = join(directory, "model-events.jsonl");
  const events: { type?: string; mode?: string }[] = [];
  if (existsSync(eventsPath)) {
    for (const line of readFileSync(eventsPath, "utf8").split("\n")) {
      try {
        events.push(JSON.parse(line) as (typeof events)[number]);
      } catch {
        // A hard interruption can leave the last event only partly written.
      }
    }
  }
  let logicalCalls =
    readArtifact<unknown[]>(join(directory, "llm-calls.json"))?.length ?? 0;
  const databasePath = join(directory, "evaluation.sqlite");
  if (existsSync(databasePath)) {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      if (
        database
          .prepare(
            "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'llm_calls'",
          )
          .get()
      )
        logicalCalls = Math.max(
          logicalCalls,
          Number(
            database.prepare("SELECT COUNT(*) AS count FROM llm_calls").get()!
              .count,
          ),
        );
    } finally {
      database.close();
    }
  }
  const repairRequests = requests.filter((name) => {
    const captured = readArtifact<{ body?: string }>(join(directory, name));
    if (!captured?.body) return false;
    try {
      const body = JSON.parse(captured.body) as {
        messages?: { role?: string; content?: unknown }[];
        input?: { role?: string; content?: unknown }[];
      };
      const last = (body.messages ?? body.input)?.at(-1);
      const content = Array.isArray(last?.content)
        ? last.content
            .map((part: { text?: string }) => part.text ?? "")
            .join("")
        : last?.content;
      return (
        last?.role === "user" &&
        content ===
          "Return the corrected JSON value only. Do not explain the repair."
      );
    } catch {
      return false;
    }
  }).length;
  return {
    logicalCalls: Math.max(
      saved?.ledger?.logicalCalls ?? 0,
      logicalCalls,
      requests.length ? 1 : 0,
    ),
    physicalAttempts: Math.max(
      saved?.ledger?.physicalAttempts ?? 0,
      requests.length,
      transport.length,
    ),
    repairAttempts: Math.max(
      saved?.ledger?.repairAttempts ?? 0,
      repairRequests,
      events.filter(
        (event) =>
          event.type === "structured.attempt" && event.mode === "repair",
      ).length,
    ),
    transportErrors: Math.max(
      saved?.ledger?.transportErrors ?? 0,
      transport.filter(
        (item) => item.error || item.bodyError || item.ok === false,
      ).length,
    ),
  };
}
export function readSemanticUnit(options: {
  caseId: string;
  repeat: number;
  unitDir: string;
  stages: readonly EvalStage[];
  prepareOnly: boolean;
}): UnitResult {
  const { caseId, repeat, unitDir, stages, prepareOnly } = options;
  const attempts = existsSync(unitDir)
    ? readdirSync(unitDir)
        .filter((name) => /^attempt-\d+$/u.test(name))
        .map((name) => ({
          name,
          number: Number(name.slice("attempt-".length)),
        }))
        .sort((a, b) => a.number - b.number)
    : [];
  const executions: StageExecution[] = [];
  for (const attempt of attempts) {
    for (const stage of stages) {
      const path = join(unitDir, attempt.name, stage);
      if (!existsSync(path)) continue;
      let result = readArtifact<StageResult>(join(path, "result.json"));
      const ledger = executionLedger(path, result);
      if (
        result?.stage !== stage ||
        !["completed", "failed", "prepared"].includes(result?.status ?? "")
      )
        result = null;
      if (result) {
        const outputPath = join(path, "output.json");
        const artifactSha256 = validOutputHash(outputPath);
        const requestValid = Boolean(
          result.requestHash &&
          validRequestHash(join(path, "request.json")) === result.requestHash,
        );
        const valid =
          result.status === "completed"
            ? result.outputPath === outputPath &&
              artifactSha256 !== null &&
              result.artifactSha256 === artifactSha256 &&
              requestValid
            : result.status !== "prepared" || requestValid;
        result = {
          ...result,
          artifactSha256,
          ledger,
          ...(!valid
            ? {
                status: "failed" as const,
                error: {
                  code: "semantic_eval.output_invalid",
                  message:
                    "Stage output or request is missing, invalid or changed",
                },
              }
            : {}),
        };
      }
      executions.push({
        attempt: attempt.number,
        path,
        stage,
        status: result?.status ?? "unfinished",
        result,
        ledger,
      });
    }
  }
  const selected = stages.flatMap((stage) => {
    const candidates = executions.filter(
      (execution) => execution.stage === stage,
    );
    const successful = candidates.find(
      ({ result }) =>
        result?.status === "completed" ||
        (prepareOnly && result?.status === "prepared"),
    );
    const result = (successful ?? candidates.at(-1))?.result;
    return result ? [result] : [];
  });
  const complete = stages.every((stage) =>
    selected.some(
      (result) =>
        result.stage === stage &&
        (result.status === "completed" ||
          (prepareOnly && result.status === "prepared")),
    ),
  );
  const ledger = {
    logicalCalls: 0,
    physicalAttempts: 0,
    repairAttempts: 0,
    transportErrors: 0,
  };
  for (const execution of executions)
    for (const field of Object.keys(ledger) as (keyof typeof ledger)[])
      ledger[field] += execution.ledger[field];
  return {
    caseId,
    repeat,
    attempt: attempts.at(-1)?.number ?? 0,
    path: unitDir,
    stages: selected,
    status: complete ? (prepareOnly ? "prepared" : "completed") : "failed",
    executions,
    ledger,
  };
}
export async function executeSemanticUnit(options: {
  caseId: string;
  repeat: number;
  unitDir: string;
  stages: readonly EvalStage[];
  prepareOnly: boolean;
  signal: AbortSignal;
  execute: (stage: EvalStage, directory: string) => Promise<void>;
}): Promise<UnitResult> {
  const saved = readSemanticUnit(options);
  const missing = options.stages.filter(
    (stage) =>
      !saved.stages.some(
        (result) =>
          result.stage === stage &&
          (result.status === "completed" ||
            (options.prepareOnly && result.status === "prepared")),
      ),
  );
  if (!missing.length) return saved;
  const attempt = saved.attempt + 1;
  const directory = join(
    options.unitDir,
    `attempt-${String(attempt).padStart(3, "0")}`,
  );
  mkdirSync(directory, { recursive: true });
  for (const stage of missing) {
    if (options.signal.aborted) break;
    await options.execute(stage, join(directory, stage));
  }
  const result = readSemanticUnit(options);
  writeJson(join(directory, "unit-result.json"), result);
  return result;
}
function requestedStages(stage: SemanticEvalArgs["stage"]): EvalStage[] {
  return stage === "both" ? ["review", "planner"] : [stage];
}
function captureFetch(
  directory: string,
  secrets: readonly string[],
  pending: Promise<unknown>[],
  transport: Record<string, unknown>[],
): FetchLike {
  let physical = 0;
  return async (input, init) => {
    physical += 1;
    const id = physical;
    const prefix = join(directory, `wire-${String(id).padStart(2, "0")}`);
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    const requestBody =
      typeof init?.body === "string"
        ? init.body
        : input instanceof Request
          ? await input.clone().text()
          : null;
    writeJson(
      `${prefix}.request.json`,
      {
        method: init?.method ?? "POST",
        endpoint: { origin: url.origin, path: url.pathname },
        body: requestBody,
      },
      secrets,
    );
    const startedAt = new Date().toISOString();
    try {
      const response = await fetch(input, init);
      const receipt: Record<string, unknown> = {
        attempt: id,
        startedAt,
        status: response.status,
        ok: response.ok,
        rawResponsePath: `${prefix}.response.txt`,
      };
      transport.push(receipt);
      const clone = response.clone();
      pending.push(
        (async () => {
          const chunks: Uint8Array[] = [];
          try {
            const reader = clone.body?.getReader();
            if (reader) {
              while (true) {
                const next = await reader.read();
                if (next.done) break;
                chunks.push(next.value);
              }
            }
          } catch (error) {
            receipt.bodyError = safeError(error);
          }
          writeFileSync(
            `${prefix}.response.txt`,
            redact(Buffer.concat(chunks).toString("utf8"), secrets),
            "utf8",
          );
          receipt.finishedAt = new Date().toISOString();
          writeJson(`${prefix}.transport.json`, receipt, secrets);
        })(),
      );
      return response;
    } catch (error) {
      const receipt = {
        attempt: id,
        startedAt,
        finishedAt: new Date().toISOString(),
        error: safeError(error),
      };
      transport.push(receipt);
      writeJson(`${prefix}.transport.json`, receipt, secrets);
      throw error;
    }
  };
}
async function executeStage(options: {
  production: Production;
  database: NarrativeDatabase;
  seeded: ReturnType<typeof seedSemanticFixture>;
  stage: EvalStage;
  directory: string;
  environment: Readonly<Record<string, string | undefined>>;
  args: SemanticEvalArgs;
  secrets: readonly string[];
  identity: ProductionIdentity;
  signal: AbortSignal;
}): Promise<StageResult> {
  const {
    production,
    database,
    seeded,
    stage,
    directory,
    environment,
    args,
    secrets,
    identity,
    signal,
  } = options;
  verifyProductionIdentity(repositoryRoot, identity);
  mkdirSync(directory, { recursive: true });
  const runs = new production.persistence.SqliteRunRepository(database);
  const runId = randomUUID();
  const recipe =
    stage === "review"
      ? production.harness.buildClosingReviewRecipe(runId, [seeded.scopeKind])
      : production.harness.buildRollingOutlineRecipe(runId);
  runs.create({
    id: runId,
    projectId: seeded.projectId,
    mode: "autopilot",
    recipe: recipe.name,
    recipeVersion: recipe.version,
    targetOutlineNodeId: stage === "review" ? seeded.scopeId : seeded.rootId,
    policy: {
      sessionId: seeded.sessionId,
      ...(stage === "review"
        ? { [`${seeded.scopeKind}Id`]: seeded.scopeId }
        : {}),
    },
    steps: recipe.steps,
    now: fixtureTime,
  });
  if (!runs.leaseRun(runId, "semantic-eval", fixtureTime, 3_600_000))
    throw new Error("Could not lease isolated evaluation run");
  const step = runs.startStep(runId, recipe.steps[0]!.id, fixtureTime);
  const pending: Promise<unknown>[] = [];
  const transport: Record<string, unknown>[] = [];
  const attemptEvents: { mode: string; valid: boolean }[] = [];
  const gateway = new production.narrative.GatewayNarrativeModelClient(
    database,
    environment,
    (_runId, _stepId, event) => {
      if (event.type === "structured.attempt") attemptEvents.push(event);
      appendFileSync(
        join(directory, "model-events.jsonl"),
        `${JSON.stringify(redact(event, secrets))}\n`,
        "utf8",
      );
    },
    captureFetch(directory, secrets, pending, transport),
  );
  let requestHash: string | null = null;
  const model: NarrativeModelClient = {
    text: gateway.text.bind(gateway),
    effectiveContextWindow: gateway.effectiveContextWindow.bind(gateway),
    effectiveOutputLimit: gateway.effectiveOutputLimit.bind(gateway),
    async structured(
      run,
      runStep,
      purpose,
      request,
      contract,
      validate,
      callSignal,
    ) {
      requestHash = sha256Json({ purpose, request, contract });
      writeJson(
        join(directory, "request.json"),
        { purpose, request, contract, requestHash },
        secrets,
      );
      if (args.prepareOnly)
        throw {
          code: "semantic_eval.prepared",
          message: "Production request captured without a model call",
        };
      verifyProductionIdentity(repositoryRoot, identity);
      const result = await gateway.structured(
        run,
        runStep,
        purpose,
        request,
        contract,
        validate,
        callSignal,
      );
      writeJson(join(directory, "structured-result.json"), result, secrets);
      return result;
    },
  };
  let status: StageResult["status"];
  let outputPath: string | null = null;
  let error: unknown = null;
  try {
    const kind: RunStepKind =
      stage === "review"
        ? seeded.scopeKind === "arc"
          ? "arc.review"
          : "volume.review"
        : "outline.generate";
    const worker = new production.narrative.AutomationWorkerSuite(
      database,
      model,
      () => new Date(fixtureTime),
    ).registry()[kind]!;
    const result = await worker.execute(runs.getSnapshot(runId), step, signal);
    outputPath = join(directory, "output.json");
    writeJson(outputPath, result, secrets);
    runs.succeedStep(
      runId,
      step.id,
      result.output,
      result.artifactKind,
      fixtureTime,
    );
    if (result.usage)
      runs.recordBudget(runId, step.id, result.usage, fixtureTime);
    runs.setRunStatus(
      runId,
      "completed",
      fixtureTime,
      "Evaluation executes only the requested generation worker",
    );
    status = "completed";
  } catch (caught) {
    error = safeError(caught);
    status =
      (error as { code?: string }).code === "semantic_eval.prepared"
        ? "prepared"
        : "failed";
    runs.setRunStatus(
      runId,
      status === "prepared" ? "cancelled" : "failed",
      fixtureTime,
      "Semantic evaluation worker stopped",
    );
  } finally {
    await Promise.allSettled(pending);
  }
  const calls = new production.persistence.SqliteLlmCallRepository(
    database,
  ).listForRun(runId);
  const receipts = new production.persistence.SqliteContextReceiptRepository(
    database,
  ).listForRun(runId);
  const snapshots =
    new production.persistence.SqliteModelAssignmentSnapshotRepository(
      database,
    ).listForRun(runId);
  const receiptPath = join(directory, "context-receipts.json");
  writeJson(receiptPath, receipts, secrets);
  writeJson(join(directory, "llm-calls.json"), calls, secrets);
  writeJson(join(directory, "assignment-snapshots.json"), snapshots, secrets);
  writeJson(join(directory, "transport.json"), transport, secrets);
  const ledger = {
    logicalCalls: calls.length,
    physicalAttempts: transport.length,
    repairAttempts: attemptEvents.filter((event) => event.mode === "repair")
      .length,
    transportErrors: transport.filter(
      (item) => item.error || item.bodyError || item.ok === false,
    ).length,
  };
  const result: StageResult = {
    stage,
    status,
    runId,
    requestHash,
    outputPath,
    artifactSha256: validOutputHash(outputPath),
    receiptPath,
    ledger,
    error: redact(error, secrets),
  };
  writeJson(join(directory, "result.json"), result, secrets);
  return result;
}

export async function runSemanticEval(
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<number> {
  const args = parseSemanticEvalArgs(argv);
  if (args.help) {
    process.stdout.write(`${semanticEvalUsage}\n`);
    return 0;
  }
  const datasetPath = resolve(repositoryRoot, args.dataset);
  const datasetText = readFileSync(datasetPath, "utf8");
  const dataset = JSON.parse(datasetText) as SemanticDataset;
  validateDataset(dataset);
  const cases = args.cases
    ? args.cases.map((id) => {
        const result = dataset.cases.find((testCase) => testCase.id === id);
        if (!result) throw new Error(`Unknown case ${id}`);
        return result;
      })
    : dataset.cases;
  const outputDir = resolve(repositoryRoot, args.outputDir);
  const manifestPath = join(outputDir, "manifest.json");
  if (existsSync(manifestPath) && !args.resume)
    throw new Error(
      "Output directory already has an evaluation; use --resume or a new directory",
    );
  mkdirSync(outputDir, { recursive: true });
  // Runtime modules are deliberately imported only after a successful forced build.
  const identity = buildProductionIdentity(repositoryRoot);
  const production = await loadProduction(repositoryRoot);
  validateDatasetEvidence(production, dataset);
  const profileDatabase = new production.database.NodeNarrativeDatabase();
  profileDatabase.migrate();
  let configured: ReturnType<typeof configureProfile>;
  try {
    configured = configureProfile(
      production,
      profileDatabase,
      environment,
      args,
    );
  } finally {
    profileDatabase.close();
  }
  const runIdentity: EvalRunIdentity = {
    datasetHash: sha256Text(datasetText),
    codeSourceDigest: identity.sourceDigest,
    codeDistDigest: identity.distDigest,
    profileHash: sha256Json(configured.profile),
    stage: args.stage,
    label: args.label,
    repeats: args.repeats,
    cases: cases.map((testCase) => testCase.id),
    prepareOnly: args.prepareOnly,
  };
  if (existsSync(manifestPath))
    assertResumeIdentity(
      (
        JSON.parse(readFileSync(manifestPath, "utf8")) as {
          identity: EvalRunIdentity;
        }
      ).identity,
      runIdentity,
    );
  else
    writeJson(manifestPath, {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      identity: runIdentity,
      build: identity,
      profile: configured.profile,
      datasetVersion: dataset.version,
      datasetPath,
      chapterNumberMapping:
        "Only fixture chapters exist in the isolated outline. Context chapterNumber is dense fixture order; original chapter numbers remain in provenance.",
      acceptance:
        "Unscored means not passed. Every requested production stage must complete and be explicitly scored pass with reviewer attribution. No separate judge API is called.",
      stageIsolation:
        "Review and planner each receive a freshly seeded fixture database; review outputs are not propagated into the fixed planner control.",
    });
  writeJson(join(outputDir, "dataset.json"), dataset, configured.secrets);
  const stages = requestedStages(args.stage);
  const gradingPath = join(outputDir, "grading.json");
  if (!existsSync(gradingPath))
    writeJson(gradingPath, {
      reviewer: null,
      reviewedAt: null,
      units: cases.flatMap((testCase) =>
        Array.from({ length: args.repeats }, (_, index) => ({
          caseId: testCase.id,
          repeat: index + 1,
          stages: Object.fromEntries(
            stages.map((stage) => [
              stage,
              {
                verdict: "unscored",
                notes: "",
                outputPath: null,
                artifactSha256: null,
              },
            ]),
          ),
        })),
      ),
    } satisfies GradingSheet);
  const tasks = cases.flatMap((testCase) =>
    Array.from({ length: args.repeats }, (_, index) => ({
      testCase,
      repeat: index + 1,
    })),
  );
  const controller = new AbortController();
  const interrupt = () => controller.abort("Evaluation interrupted");
  process.once("SIGINT", interrupt);
  const summarize = () => {
    const grading = JSON.parse(
      readFileSync(gradingPath, "utf8"),
    ) as GradingSheet;
    const results = tasks
      .map(({ testCase, repeat }) =>
        readSemanticUnit({
          caseId: testCase.id,
          repeat,
          unitDir: join(
            outputDir,
            testCase.id,
            `repeat-${String(repeat).padStart(2, "0")}`,
          ),
          stages,
          prepareOnly: args.prepareOnly,
        }),
      )
      .filter((unit) => unit.executions.length > 0);
    for (const unit of results) {
      const grade = grading.units.find(
        (item) => item.caseId === unit.caseId && item.repeat === unit.repeat,
      );
      for (const result of unit.stages) {
        const score = grade?.stages[result.stage];
        if (score?.verdict === "unscored") {
          score.outputPath = result.outputPath;
          score.artifactSha256 = result.artifactSha256;
        }
      }
    }
    writeJson(gradingPath, grading, configured.secrets);
    const units = results
      .toSorted(
        (a, b) => a.caseId.localeCompare(b.caseId) || a.repeat - b.repeat,
      )
      .map((result) => ({
        ...result,
        semanticPassed: scoredAcceptance(
          stages,
          result.stages,
          grading.units.find(
            (grade) =>
              grade.caseId === result.caseId && grade.repeat === result.repeat,
          ),
          grading,
        ),
      }));
    const passed =
      units.length === tasks.length &&
      units.every((unit) => unit.semanticPassed);
    const scored = Boolean(
      grading.reviewer?.trim() &&
      grading.reviewedAt &&
      Number.isFinite(Date.parse(grading.reviewedAt)) &&
      units.length === tasks.length &&
      units.every((unit) => {
        const grade = grading.units.find(
          (item) => item.caseId === unit.caseId && item.repeat === unit.repeat,
        );
        return stages.every((stage) => {
          const result = unit.stages.find((item) => item.stage === stage);
          const score = grade?.stages[stage];
          return (
            result?.status === "completed" &&
            score &&
            score.verdict !== "unscored" &&
            score.outputPath === result.outputPath &&
            score.artifactSha256 === result.artifactSha256
          );
        });
      }),
    );
    const report = {
      label: args.label,
      identity: runIdentity,
      total: tasks.length,
      finished: units.length,
      structurallyCompleted: units.filter((unit) => unit.status === "completed")
        .length,
      semanticPassed: units.filter((unit) => unit.semanticPassed).length,
      passed,
      status: passed
        ? "passed"
        : units.some((unit) => unit.status === "failed")
          ? "execution-failed"
          : scored
            ? "scored-not-passed"
            : "awaiting-score",
      ledger: units.reduce(
        (total, unit) => ({
          logicalCalls: total.logicalCalls + unit.ledger.logicalCalls,
          physicalAttempts:
            total.physicalAttempts + unit.ledger.physicalAttempts,
          repairAttempts: total.repairAttempts + unit.ledger.repairAttempts,
          transportErrors: total.transportErrors + unit.ledger.transportErrors,
        }),
        {
          logicalCalls: 0,
          physicalAttempts: 0,
          repairAttempts: 0,
          transportErrors: 0,
        },
      ),
      units,
    };
    writeJson(join(outputDir, "report.json"), report, configured.secrets);
    return report;
  };
  let next = 0;
  try {
    await Promise.all(
      Array.from({ length: args.concurrency }, async () => {
        while (next < tasks.length && !controller.signal.aborted) {
          const { testCase, repeat } = tasks[next++]!;
          const unitDir = join(
            outputDir,
            testCase.id,
            `repeat-${String(repeat).padStart(2, "0")}`,
          );
          mkdirSync(unitDir, { recursive: true });
          await executeSemanticUnit({
            caseId: testCase.id,
            repeat,
            unitDir,
            stages,
            prepareOnly: args.prepareOnly,
            signal: controller.signal,
            execute: async (stage, stageDirectory) => {
              verifyProductionIdentity(repositoryRoot, identity);
              const grading = JSON.parse(
                readFileSync(gradingPath, "utf8"),
              ) as GradingSheet;
              const grade = grading.units.find(
                (item) => item.caseId === testCase.id && item.repeat === repeat,
              )!;
              grade.stages[stage] = {
                verdict: "unscored",
                notes: "",
                outputPath: null,
                artifactSha256: null,
              };
              writeJson(gradingPath, grading, configured.secrets);
              writeJson(
                join(dirname(stageDirectory), "fixture.json"),
                testCase,
                configured.secrets,
              );
              mkdirSync(stageDirectory, { recursive: true });
              const database = new production.database.NodeNarrativeDatabase(
                join(stageDirectory, "evaluation.sqlite"),
              );
              database.migrate();
              try {
                const profile = configureProfile(
                  production,
                  database,
                  environment,
                  args,
                );
                if (sha256Json(profile.profile) !== runIdentity.profileHash)
                  throw new Error("Model profile changed between units");
                const seeded = seedSemanticFixture(
                  production,
                  database,
                  testCase,
                );
                writeJson(
                  join(stageDirectory, "provenance.json"),
                  seeded.provenance,
                  configured.secrets,
                );
                const result = await executeStage({
                  production,
                  database,
                  seeded,
                  stage,
                  directory: stageDirectory,
                  environment,
                  args,
                  secrets: configured.secrets,
                  identity,
                  signal: controller.signal,
                });
                process.stdout.write(
                  `${JSON.stringify({ case: testCase.id, repeat, stage, status: result.status, ledger: result.ledger })}\n`,
                );
              } finally {
                database.close();
              }
            },
          });
          summarize();
        }
      }),
    );
  } finally {
    process.removeListener("SIGINT", interrupt);
    summarize();
  }
  const report = summarize();
  // Successful transport/schema validation is deliberately insufficient for semantic acceptance.
  return controller.signal.aborted
    ? 130
    : report.passed
      ? 0
      : args.prepareOnly
        ? 0
        : report.units.some((unit) => unit.status === "failed")
          ? 1
          : 2;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = await runSemanticEval(process.argv.slice(2));
  } catch (error) {
    // Only configured credential values are used for redaction; no environment inventory is logged.
    const secrets = [
      process.env.NARRATIVE_LLM_API_KEY,
      process.env.NARRATIVE_CHAT_API_KEY,
      process.env.NARRATIVE_RESPONSES_API_KEY,
      process.env.NARRATIVE_ANTHROPIC_API_KEY,
    ].filter((value): value is string => Boolean(value));
    process.stderr.write(
      `${JSON.stringify(redact(safeError(error), secrets))}\n`,
    );
    process.exitCode = 1;
  }
}
