import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import * as domain from "@narralume/domain";
import * as harness from "@narralume/harness";
import * as contracts from "@narralume/contracts";
import * as narrative from "@narralume/narrative";
import * as persistence from "@narralume/persistence";
import * as database from "@narralume/persistence/node";
import * as services from "@narralume/services";
import {
  assertResumeIdentity,
  executeSemanticUnit,
  parseSemanticEvalArgs,
  redact,
  readSemanticUnit,
  scoredAcceptance,
  seedSemanticFixture,
  sha256Json,
  sha256Text,
  validateDataset,
  validateDatasetEvidence,
  verifyProductionIdentity,
  type EvalRunIdentity,
  type ProductionIdentity,
  type SemanticCase,
  type EvalStage,
  type StageResult,
} from "../../../scripts/narrative-memory-semantic-eval.js";

const production = {
  domain,
  harness,
  contracts,
  narrative,
  persistence,
  database,
  services,
};
const fixture: SemanticCase = {
  id: "fixed-case",
  title: "SCORING TITLE MUST STAY OUTSIDE REQUESTS",
  language: "zh-CN",
  scope: { title: "渡口", kind: "arc" },
  compass: {
    corePromise: "调查渡口",
    endingDirection: null,
    longLines: [],
    themeQuestions: [],
    constraints: [],
    target: { chapters: 20, volumes: 1, wordsPerChapter: 3000 },
  },
  authorIntent: {
    promise: "调查渡口",
    themes: [],
    audience: null,
    tone: null,
    boundaries: [],
    endingDirection: null,
    currentFocus: null,
    lockedFields: [],
  },
  entities: [
    {
      id: "character-id",
      type: "character",
      name: "泽伯",
      aliases: [],
      description: "渡口的照看者。",
      status: "active",
    },
  ],
  chapters: [
    {
      id: "historical-chapter",
      title: "交接",
      content: "阿苇已经交给泽伯。",
      inScope: false,
      source: {
        database: "PROVENANCE MUST STAY OUTSIDE REQUESTS",
        projectId: "original-project",
        documentId: "historical-document",
        versionId: "historical-version",
        contentHash: sha256Text("阿苇已经交给泽伯。"),
        chapterNumber: 15,
      },
      summary: "此前已完成交接。",
    },
    {
      id: "target-chapter",
      title: "启程",
      content: "两人离开了渡口。",
      inScope: true,
      source: {
        database: "PROVENANCE MUST STAY OUTSIDE REQUESTS",
        projectId: "original-project",
        documentId: "target-document",
        versionId: "target-version",
        contentHash: sha256Text("两人离开了渡口。"),
        chapterNumber: 18,
      },
      summary: "两人继续前行。",
    },
  ],
  rubric: {
    expected: ["EXPECTED ANSWER MUST STAY OUTSIDE REQUESTS"],
    forbidden: ["FORBIDDEN ANSWER MUST STAY OUTSIDE REQUESTS"],
    allowed: [],
    knowledgeBoundaries: [],
    notes: "ADJUDICATION ONLY",
    sourceEvidence: [
      { chapterId: "historical-chapter", paragraphOrdinals: [1] },
    ],
  },
};
function saveStage(
  directory: string,
  stage: EvalStage,
  status: StageResult["status"] = "completed",
  ledger: StageResult["ledger"] = {
    logicalCalls: 1,
    physicalAttempts: 1,
    repairAttempts: 0,
    transportErrors: 0,
  },
): StageResult {
  mkdirSync(directory, { recursive: true });
  const outputPath =
    status === "completed" ? join(directory, "output.json") : null;
  if (outputPath)
    writeFileSync(
      outputPath,
      JSON.stringify({ artifactKind: stage, output: { stage } }),
    );
  const request = {
    purpose: stage,
    request: { fixture: true },
    contract: { name: stage },
  };
  const requestHash = sha256Json(request);
  writeFileSync(
    join(directory, "request.json"),
    JSON.stringify({ ...request, requestHash }),
  );
  const result: StageResult = {
    stage,
    status,
    runId: "run",
    requestHash,
    outputPath,
    artifactSha256: outputPath ? sha256Text(readFileSync(outputPath)) : null,
    receiptPath: join(directory, "context-receipts.json"),
    ledger,
    error: status === "failed" ? { message: "failed" } : null,
  };
  writeFileSync(join(directory, "result.json"), JSON.stringify(result));
  return result;
}

describe("production narrative memory semantic evaluation runner", () => {
  it("parses selectors, repetitions, isolated concurrency and resume", () => {
    expect(parseSemanticEvalArgs([])).toMatchObject({
      repeats: 3,
      stage: "both",
      concurrency: 1,
      protocol: "openai-responses",
      resume: false,
    });
    expect(
      parseSemanticEvalArgs([
        "--cases=fixed-case,other",
        "--repeats",
        "2",
        "--concurrency=2",
        "--resume",
        "--prepare-only",
        "--label",
        "candidate",
        "--output-dir",
        ".tmp/custom",
      ]),
    ).toMatchObject({
      cases: ["fixed-case", "other"],
      repeats: 2,
      concurrency: 2,
      resume: true,
      prepareOnly: true,
      label: "candidate",
      outputDir: ".tmp/custom",
    });
    for (const args of [
      ["--repeats=0"],
      ["--concurrency=3"],
      ["--stage=qa"],
      ["--label=../unsafe"],
      ["--unknown=value"],
      ["--dataset"],
    ])
      expect(() => parseSemanticEvalArgs(args)).toThrow();
  });

  it("refuses source hash corruption and historical prose after the target scope", () => {
    expect(() =>
      validateDataset({ version: "v1", cases: [fixture] }),
    ).not.toThrow();
    expect(() =>
      validateDataset({
        version: "v1",
        cases: [{ ...fixture, chapters: fixture.chapters.toReversed() }],
      }),
    ).toThrow();
    expect(() =>
      validateDataset({
        version: "v1",
        cases: [
          {
            ...fixture,
            chapters: [
              { ...fixture.chapters[0]!, content: "改写了原文。" },
              fixture.chapters[1]!,
            ],
          },
        ],
      }),
    ).toThrow("hash");
  });

  it("rejects resume under different fixtures, code or model profile", () => {
    const identity: EvalRunIdentity = {
      datasetHash: "dataset",
      codeSourceDigest: "source",
      codeDistDigest: "dist",
      profileHash: "profile",
      stage: "both",
      label: "baseline",
      repeats: 3,
      cases: ["fixed-case"],
      prepareOnly: false,
    };
    expect(() => assertResumeIdentity(identity, { ...identity })).not.toThrow();
    for (const field of [
      "datasetHash",
      "codeSourceDigest",
      "codeDistDigest",
      "profileHash",
      "label",
    ] as const)
      expect(() =>
        assertResumeIdentity(identity, { ...identity, [field]: "changed" }),
      ).toThrow("Resume identity");
  });

  it("checks rubric paragraph ordinals and immutable evidence with the production locator", () => {
    expect(() =>
      validateDatasetEvidence(production, { version: "v1", cases: [fixture] }),
    ).not.toThrow();
    const changed = structuredClone(fixture);
    changed.rubric.sourceEvidence[0]!.paragraphOrdinals = [99];
    expect(() =>
      validateDatasetEvidence(production, { version: "v1", cases: [changed] }),
    ).toThrow();
    const forged = structuredClone(fixture);
    const locator = new narrative.ParagraphLocator(
      fixture.chapters[0]!.content,
      { documentVersionId: fixture.chapters[0]!.source.versionId },
    );
    forged.rubric.sourceEvidence[0]!.paragraphs = [
      { ...locator.locate([1])[0]!, documentVersionId: "different-version" },
    ];
    expect(() =>
      validateDatasetEvidence(production, { version: "v1", cases: [forged] }),
    ).toThrow("immutable source");
  });

  it("never treats unscored structural success as semantic acceptance", () => {
    const root = mkdtempSync(join(tmpdir(), "narralume-semantic-scoring-"));
    try {
      const results = (["review", "planner"] as const).map((stage) =>
        saveStage(join(root, stage), stage),
      );
      const grade = {
        caseId: "fixed-case",
        repeat: 1,
        stages: {
          review: {
            verdict: "pass" as const,
            notes: "Reviewed against corpus rubric",
            outputPath: results[0]!.outputPath,
            artifactSha256: results[0]!.artifactSha256,
          },
          planner: {
            verdict: "pass" as const,
            notes: "Reviewed against corpus rubric",
            outputPath: results[1]!.outputPath,
            artifactSha256: results[1]!.artifactSha256,
          },
        },
      };
      expect(
        scoredAcceptance(["review", "planner"], results, undefined, {
          reviewer: "Codex",
          reviewedAt: new Date().toISOString(),
          units: [],
        }),
      ).toBe(false);
      expect(
        scoredAcceptance(["review", "planner"], results, grade, {
          reviewer: null,
          reviewedAt: null,
          units: [grade],
        }),
      ).toBe(false);
      expect(
        scoredAcceptance(["review", "planner"], results, grade, {
          reviewer: "Codex",
          reviewedAt: new Date().toISOString(),
          units: [grade],
        }),
      ).toBe(true);
      expect(
        scoredAcceptance(
          ["review", "planner"],
          [{ ...results[0]!, status: "failed" }, results[1]!],
          grade,
          {
            reviewer: "Codex",
            reviewedAt: new Date().toISOString(),
            units: [grade],
          },
        ),
      ).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resumes only the failed planner and preserves the successful review and all attempt costs", async () => {
    const root = mkdtempSync(join(tmpdir(), "narralume-semantic-resume-"));
    try {
      const review = saveStage(join(root, "attempt-001/review"), "review");
      const before = readFileSync(review.outputPath!, "utf8");
      saveStage(join(root, "attempt-001/planner"), "planner", "failed", {
        logicalCalls: 1,
        physicalAttempts: 2,
        repairAttempts: 1,
        transportErrors: 1,
      });
      writeFileSync(
        join(root, "attempt-001/unit-result.json"),
        JSON.stringify({ status: "failed" }),
      );
      const calls: EvalStage[] = [];
      const result = await executeSemanticUnit({
        caseId: fixture.id,
        repeat: 1,
        unitDir: root,
        stages: ["review", "planner"],
        prepareOnly: false,
        signal: new AbortController().signal,
        execute: async (stage, directory) => {
          calls.push(stage);
          saveStage(directory, stage);
        },
      });
      expect(calls).toEqual(["planner"]);
      expect(result.status).toBe("completed");
      expect(result.stages[0]!.outputPath).toBe(review.outputPath);
      expect(readFileSync(review.outputPath!, "utf8")).toBe(before);
      expect(existsSync(join(root, "attempt-002/review"))).toBe(false);
      expect(result.executions.map((execution) => execution.status)).toEqual([
        "completed",
        "failed",
        "completed",
      ]);
      expect(result.ledger).toEqual({
        logicalCalls: 3,
        physicalAttempts: 4,
        repairAttempts: 1,
        transportErrors: 1,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reuses completed stage records after interruption before unit-result was written", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "narralume-semantic-unit-interrupt-"),
    );
    try {
      for (const stage of ["review", "planner"] as const)
        saveStage(join(root, "attempt-001", stage), stage);
      const result = await executeSemanticUnit({
        caseId: fixture.id,
        repeat: 1,
        unitDir: root,
        stages: ["review", "planner"],
        prepareOnly: false,
        signal: new AbortController().signal,
        execute: async () => {
          throw new Error("Completed stages must not be called again");
        },
      });
      expect(result.status).toBe("completed");
      expect(existsSync(join(root, "attempt-001/unit-result.json"))).toBe(
        false,
      );
      expect(existsSync(join(root, "attempt-002"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("selects the earliest valid output and requires scoring its actual path and unchanged hash", () => {
    const root = mkdtempSync(join(tmpdir(), "narralume-semantic-binding-"));
    try {
      const earliest = saveStage(join(root, "attempt-001/review"), "review");
      const later = saveStage(join(root, "attempt-002/review"), "review");
      const options = {
        caseId: fixture.id,
        repeat: 1,
        unitDir: root,
        stages: ["review"] as const,
        prepareOnly: false,
      };
      const selected = readSemanticUnit(options).stages;
      expect(selected[0]!.outputPath).toBe(earliest.outputPath);
      const grade = {
        caseId: fixture.id,
        repeat: 1,
        stages: {
          review: {
            verdict: "pass" as const,
            notes: "adjudicated",
            outputPath: later.outputPath,
            artifactSha256: later.artifactSha256,
          },
        },
      };
      const sheet = {
        reviewer: "reviewer",
        reviewedAt: "2026-10-11T00:00:00Z",
        units: [grade],
      };
      expect(scoredAcceptance(["review"], selected, grade, sheet)).toBe(false);
      grade.stages.review.outputPath = earliest.outputPath;
      grade.stages.review.artifactSha256 = earliest.artifactSha256;
      expect(scoredAcceptance(["review"], selected, grade, sheet)).toBe(true);
      grade.stages.review.artifactSha256 = null;
      expect(scoredAcceptance(["review"], selected, grade, sheet)).toBe(false);
      grade.stages.review.artifactSha256 = earliest.artifactSha256;
      writeFileSync(
        earliest.outputPath!,
        JSON.stringify({ artifactKind: "review", output: { changed: true } }),
      );
      expect(scoredAcceptance(["review"], selected, grade, sheet)).toBe(false);
      const after = readSemanticUnit(options);
      expect(after.stages[0]!.outputPath).toBe(later.outputPath);
      expect(after.executions[0]!.status).toBe("failed");
      expect(scoredAcceptance(["review"], after.stages, grade, sheet)).toBe(
        false,
      );
      const unbound: Partial<StageResult> = { ...later };
      delete unbound.artifactSha256;
      writeFileSync(
        join(root, "attempt-002/review/result.json"),
        JSON.stringify(unbound),
      );
      expect(readSemanticUnit(options).status).toBe("failed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("counts interrupted logical and wire repair calls without a stage result or exported receipts", () => {
    const root = mkdtempSync(join(tmpdir(), "narralume-semantic-cost-"));
    try {
      const directory = join(root, "attempt-001/review");
      mkdirSync(directory, { recursive: true });
      const db = new DatabaseSync(join(directory, "evaluation.sqlite"));
      db.exec(
        "CREATE TABLE llm_calls(status TEXT); INSERT INTO llm_calls VALUES ('started')",
      );
      db.close();
      const uninitialized = join(root, "attempt-002/review");
      mkdirSync(uninitialized, { recursive: true });
      new DatabaseSync(join(uninitialized, "evaluation.sqlite")).close();
      writeFileSync(
        join(directory, "wire-01.request.json"),
        JSON.stringify({
          body: JSON.stringify({
            messages: [{ role: "user", content: "original" }],
          }),
        }),
      );
      writeFileSync(
        join(directory, "wire-02.request.json"),
        JSON.stringify({
          body: JSON.stringify({
            messages: [
              {
                role: "user",
                content:
                  "Return the corrected JSON value only. Do not explain the repair.",
              },
            ],
          }),
        }),
      );
      writeFileSync(
        join(directory, "wire-01.transport.json"),
        JSON.stringify({ ok: false }),
      );
      writeFileSync(
        join(directory, "model-events.jsonl"),
        '{"type":"structured.attempt","mode":"prompt"}\n{"type":',
      );
      const result = readSemanticUnit({
        caseId: fixture.id,
        repeat: 1,
        unitDir: root,
        stages: ["review"],
        prepareOnly: false,
      });
      expect(result.status).toBe("failed");
      expect(result.executions[0]!.status).toBe("unfinished");
      expect(result.ledger).toEqual({
        logicalCalls: 1,
        physicalAttempts: 2,
        repairAttempts: 1,
        transportErrors: 1,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("allocates the next attempt after the largest saved number without overwriting gaps", async () => {
    const root = mkdtempSync(join(tmpdir(), "narralume-semantic-gap-"));
    try {
      const earliest = saveStage(join(root, "attempt-002/review"), "review");
      saveStage(join(root, "attempt-010/review"), "review");
      const result = await executeSemanticUnit({
        caseId: fixture.id,
        repeat: 1,
        unitDir: root,
        stages: ["review", "planner"],
        prepareOnly: false,
        signal: new AbortController().signal,
        execute: async (stage, directory) => {
          expect(stage).toBe("planner");
          saveStage(directory, stage);
        },
      });
      expect(result.attempt).toBe(11);
      expect(result.stages[0]!.outputPath).toBe(earliest.outputPath);
      expect(existsSync(join(root, "attempt-011/planner/output.json"))).toBe(
        true,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reuses prepared requests only in prepare-only runs and retains zero model cost", async () => {
    const root = mkdtempSync(join(tmpdir(), "narralume-semantic-prepared-"));
    try {
      saveStage(join(root, "attempt-001/review"), "review", "prepared", {
        logicalCalls: 0,
        physicalAttempts: 0,
        repairAttempts: 0,
        transportErrors: 0,
      });
      const options = {
        caseId: fixture.id,
        repeat: 1,
        unitDir: root,
        stages: ["review"] as const,
        signal: new AbortController().signal,
      };
      const prepared = await executeSemanticUnit({
        ...options,
        prepareOnly: true,
        execute: async () => {
          throw new Error("Prepared request should be reused");
        },
      });
      expect(prepared.status).toBe("prepared");
      expect(prepared.ledger.physicalAttempts).toBe(0);
      writeFileSync(
        join(root, "attempt-001/review/request.json"),
        JSON.stringify({ requestHash: prepared.stages[0]!.requestHash }),
      );
      expect(readSemanticUnit({ ...options, prepareOnly: true }).status).toBe(
        "failed",
      );
      const calls: EvalStage[] = [];
      const completed = await executeSemanticUnit({
        ...options,
        prepareOnly: false,
        execute: async (stage, directory) => {
          calls.push(stage);
          saveStage(directory, stage);
        },
      });
      expect(calls).toEqual(["review"]);
      expect(completed.status).toBe("completed");
      expect(completed.ledger.logicalCalls).toBe(1);
      expect(completed.ledger.physicalAttempts).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("redacts configured credentials even inside raw provider responses", () => {
    const result = redact(
      { body: "unusual-key secret-bearing-response", nested: ["unusual-key"] },
      ["unusual-key"],
    );
    expect(JSON.stringify(result)).not.toContain("unusual-key");
    expect(result).toEqual({
      body: "[REDACTED] secret-bearing-response",
      nested: ["[REDACTED]"],
    });
  });

  it("rejects source/dist drift before a subsequent model call", () => {
    const root = mkdtempSync(join(tmpdir(), "narralume-semantic-guard-"));
    try {
      mkdirSync(join(root, "scripts"), { recursive: true });
      writeFileSync(
        join(root, "scripts/narrative-memory-semantic-eval.ts"),
        "source",
      );
      writeFileSync(join(root, "tsconfig.base.json"), "{}");
      writeFileSync(join(root, "package-lock.json"), "{}");
      const sourcePaths = [
        "tsconfig.base.json",
        "package-lock.json",
        "scripts/narrative-memory-semantic-eval.ts",
      ];
      const distPaths: string[] = [];
      for (const name of [
        "contracts",
        "context",
        "domain",
        "harness",
        "llm",
        "narrative",
        "persistence",
        "services",
      ]) {
        mkdirSync(join(root, `packages/${name}/dist`), { recursive: true });
        writeFileSync(join(root, `packages/${name}/package.json`), "{}");
        writeFileSync(join(root, `packages/${name}/tsconfig.json`), "{}");
        writeFileSync(join(root, `packages/${name}/dist/index.js`), "compiled");
        sourcePaths.push(
          `packages/${name}/package.json`,
          `packages/${name}/tsconfig.json`,
        );
        distPaths.push(`packages/${name}/dist/index.js`);
      }
      const identities = (paths: string[]) =>
        paths.sort().map((path) => ({
          path,
          sha256: sha256Text(readFileSync(join(root, path))),
        }));
      const sourceFiles = identities(sourcePaths),
        distFiles = identities(distPaths);
      const identity: ProductionIdentity = {
        sourceDigest: sha256Json(sourceFiles),
        distDigest: sha256Json(distFiles),
        sourceFiles,
        distFiles,
        gitCommit: "commit",
        gitDirty: false,
        nodeVersion: process.version,
        typescriptVersion: "6",
        entrypoints: {},
      };
      expect(() => verifyProductionIdentity(root, identity)).not.toThrow();
      writeFileSync(join(root, "packages/narrative/dist/index.js"), "changed");
      expect(() => verifyProductionIdentity(root, identity)).toThrow("changed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    { stage: "review", aliasOnly: false },
    { stage: "review", aliasOnly: true },
    { stage: "planner", aliasOnly: false },
    { stage: "planner", aliasOnly: true },
  ] as const)(
    "repeats the actual $stage worker request without rubric leakage (aliasOnly=$aliasOnly)",
    async ({ stage, aliasOnly }) => {
      const input = structuredClone(fixture);
      if (aliasOnly) {
        input.entities![0]!.name = "老船长";
        input.entities![0]!.aliases = ["泽伯"];
      }
      // Put the handoff beyond review's recent full-chapter window too.
      const historical = input.chapters[0]!;
      const fillers = Array.from({ length: 5 }, (_, index) => {
        const content = "天气平静，码头上没有新的消息。";
        return {
          ...historical,
          id: `unrelated-history-${index}`,
          content,
          source: {
            ...historical.source,
            documentId: `unrelated-document-${index}`,
            versionId: `unrelated-version-${index}`,
            contentHash: sha256Text(content),
            chapterNumber: 16 + index,
          },
        };
      });
      input.chapters = [
        historical,
        ...fillers,
        {
          ...input.chapters[1]!,
          source: { ...input.chapters[1]!.source, chapterNumber: 21 },
        },
      ];
      const requests: string[] = [];
      for (let repeat = 0; repeat < 2; repeat += 1) {
        const db = new database.NodeNarrativeDatabase();
        db.migrate();
        try {
          const seeded = seedSemanticFixture(production, db, input);
          expect(
            seeded.provenance.map(
              (chapter) => chapter.evaluation.chapterNumber,
            ),
          ).toEqual([1, 2, 3, 4, 5, 6, 7]);
          expect(seeded.provenance[0]!.source.chapterNumber).toBe(15);
          const runs = new persistence.SqliteRunRepository(db);
          const runId = randomUUID();
          const recipe =
            stage === "review"
              ? harness.buildClosingReviewRecipe(runId, ["arc"])
              : harness.buildRollingOutlineRecipe(runId);
          runs.create({
            id: runId,
            projectId: seeded.projectId,
            mode: "autopilot",
            recipe: recipe.name,
            recipeVersion: recipe.version,
            targetOutlineNodeId: seeded.scopeId,
            policy: { sessionId: seeded.sessionId, arcId: seeded.scopeId },
            steps: recipe.steps,
            now: "2026-10-04T00:00:00.000Z",
          });
          runs.leaseRun(runId, "test", "2026-10-04T00:00:00.000Z", 30_000);
          const step = runs.startStep(
            runId,
            recipe.steps[0]!.id,
            "2026-10-04T00:00:00.000Z",
          );
          const model: narrative.NarrativeModelClient = {
            effectiveContextWindow: () => 64_000,
            effectiveOutputLimit: () => 16_000,
            async text() {
              throw new Error("Unexpected text call");
            },
            async structured(_run, _step, purpose, request, contract) {
              requests.push(JSON.stringify({ purpose, request, contract }));
              throw new Error("Captured actual worker request");
            },
          };
          const worker = new narrative.AutomationWorkerSuite(
            db,
            model,
          ).registry()[stage === "review" ? "arc.review" : "outline.generate"]!;
          await expect(
            worker.execute(
              runs.getSnapshot(runId),
              step,
              new AbortController().signal,
            ),
          ).rejects.toThrow("Captured actual worker request");
        } finally {
          db.close();
        }
      }
      expect(requests).toHaveLength(2);
      expect(requests[0]).toBe(requests[1]);
      for (const excluded of [
        fixture.title,
        fixture.rubric.expected[0]!,
        fixture.rubric.forbidden[0]!,
        fixture.chapters[0]!.source.database,
      ])
        expect(requests[0]).not.toContain(excluded);
      expect(requests[0]).toContain(fixture.chapters[1]!.content);
      // The generic compass mentions the ferry, not this historical handoff.
      // A known character name or alias must still retrieve its original prose.
      expect(requests[0]).toContain(fixture.chapters[0]!.content);
      if (stage === "planner") expect(requests[0]).toContain("渡口的照看者。");
    },
  );
});
