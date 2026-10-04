import { createProject } from "@narralume/domain";
import { buildChapterRecipe } from "@narralume/harness";
import type { NarrativeModelClient } from "@narralume/narrative";
import { outlineStructureFingerprint } from "@narralume/narrative";
import {
  SqliteLlmCallRepository,
  SqliteModelRepository,
  SqliteProjectRepository,
  SqliteProviderRepository,
  SqliteRunRepository,
  SqliteRunStreamRepository,
  SqliteStoryRepository,
} from "@narralume/persistence";
import { NodeNarrativeDatabase } from "@narralume/persistence/node";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";

const config: ServerConfig = {
  dataDirectory: ".",
  databasePath: ":memory:",
  host: "127.0.0.1",
  port: 4317,
  environment: "test",
};

const resources: {
  app: Awaited<ReturnType<typeof buildApp>>;
  database: NodeNarrativeDatabase;
}[] = [];

afterEach(async () => {
  while (resources.length) {
    const resource = resources.pop();
    await resource?.app.close();
    resource?.database.close();
  }
});

/** 65 characters — above the 50-character minimum viable partial length. */
const PARTIAL_PREFIX =
  "雾从海面推上石阶。林昼把手按在冰冷的门上，听见灯塔深处传来第三下钟声。她沿着旋梯向上，每一级都沾着尚未干透的海水。风从塔顶灌下来，";

const CONTINUATION_TEXT =
  "灯灭的一刻，父亲忽然问她为何对着空椅子说话。窗外所有船铃同时沉默，仿佛港口刚刚吞掉了一个无人敢说出的名字。林昼把这句话记进灯塔日志，墨迹未干，钟声又响了一下。";

const FULL_MANUSCRIPT =
  "雾从海面推上石阶。林昼把手按在冰冷的门上，听见灯塔深处传来第三下钟声。她沿着旋梯向上，每一级都沾着尚未干透的海水。\n\n灯灭的一刻，父亲忽然问她为何对着空椅子说话。窗外所有船铃同时沉默，仿佛港口刚刚吞掉了一个无人敢说出的名字。";

async function setup(model?: NarrativeModelClient) {
  const database = new NodeNarrativeDatabase();
  const environment = {
    NARRATIVE_LLM_API_KEY: "server-only-test-key",
    NARRATIVE_LLM_BASE_URL: "https://api.example.com/v1",
    NARRATIVE_LLM_MODEL: "test-model",
    NARRATIVE_LLM_CONTEXT_WINDOW: "128000",
    NARRATIVE_LLM_MAX_OUTPUT_TOKENS: "32000",
  };
  const app = await buildApp({
    config,
    database,
    environment,
    narrativeModelClient: model ?? scriptedModel(),
    enableRunWorker: false,
    logger: false,
  });
  resources.push({ app, database });
  return { app, database };
}

async function createProjectAndChapter(
  app: Awaited<ReturnType<typeof buildApp>>,
) {
  const projectResponse = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: {
      requestId: globalThis.crypto.randomUUID(),
      title: "潮汐灯塔",
      premise: "灯灭时港口遗忘一个人。",
    },
  });
  const project = projectResponse.json() as { id: string };
  const bible = (
    await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/story-bible`,
    })
  ).json() as { outline: { id: string }[] };
  const chapterResponse = await app.inject({
    method: "POST",
    url: `/api/projects/${project.id}/outline`,
    payload: {
      parentId: bible.outline[0]!.id,
      kind: "chapter",
      ordinal: 0,
      title: "雾港失灯",
      summary: "林昼回港当夜灯塔熄灭。",
      goal: "发现遗忘规则",
      conflict: "父亲否认失踪者存在",
      metadata: {},
    },
  });
  expect(chapterResponse.statusCode).toBe(201);
  return {
    projectId: project.id,
    chapterId: (chapterResponse.json() as { id: string }).id,
  };
}

async function createRun(
  app: Awaited<ReturnType<typeof buildApp>>,
  projectId: string,
  chapterId: string,
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/runs/chapter`,
    payload: {
      requestId: `partial-recovery-${chapterId}`,
      targetOutlineNodeId: chapterId,
      policy: { minChapterCharacters: 100 },
    },
  });
  expect(response.statusCode, response.body).toBe(202);
  return (response.json() as { run: { id: string } }).run.id;
}

/**
 * Simulates an interrupted streaming attempt: context.compile and scene.plan
 * succeeded, the draft step was started (attempt 1), partial text was
 * persisted, and the stream ended up interrupted.
 */
function seedPartial(
  database: NodeNarrativeDatabase,
  runId: string,
  chapterId: string,
  text: string,
): { stepId: string; attempt: number } {
  const runs = new SqliteRunRepository(database);
  const steps = runs.getSnapshot(runId).steps;
  const now = new Date().toISOString();
  const contextStep = steps.find(
    (candidate) => candidate.kind === "context.compile",
  )!;
  runs.startStep(runId, contextStep.id, now);
  runs.succeedStep(
    runId,
    contextStep.id,
    {
      text: "编译上下文",
      outlineStructureFingerprint: outlineStructureFingerprint(
        new SqliteStoryRepository(database).listOutline(
          runs.getSnapshot(runId).run.projectId,
        ),
      ),
      targetOutlineNodeId: chapterId,
      contexts: Object.fromEntries(
        [
          "scene-plan",
          "chapter-draft",
          "semantic-review",
          "chapter-revision",
          "chapter-settlement",
        ].map((purpose) => [purpose, { text: "compiled context" }]),
      ),
      baseDocumentId: null,
      baseVersionId: null,
    },
    "compiled-context",
    now,
  );
  const planStep = steps.find((candidate) => candidate.kind === "scene.plan")!;
  runs.startStep(runId, planStep.id, now);
  runs.succeedStep(runId, planStep.id, { scenes: [] }, "scene-plan", now);
  const draftStep = steps.find(
    (candidate) => candidate.kind === "draft.generate",
  )!;
  runs.startStep(runId, draftStep.id, now);
  const streams = new SqliteRunStreamRepository(database);
  streams.appendText(runId, draftStep.id, text, now);
  streams.markStatus(runId, draftStep.id, "interrupted", now);
  runs.failStep(
    runId,
    draftStep.id,
    { code: "stream_idle_timeout", message: "流空闲超时", retryable: true },
    now,
  );
  return { stepId: draftStep.id, attempt: 1 };
}

/** Drives a run to completion, approving the chapter-gate commit boundary. */
async function completeRun(
  app: Awaited<ReturnType<typeof buildApp>>,
  runId: string,
  projectId: string,
): Promise<string> {
  let status = "pending";
  for (let index = 0; index < 40 && status !== "completed"; index += 1) {
    const advanced = await app.inject({
      method: "POST",
      url: `/api/runs/${runId}/advance`,
      payload: { projectId },
    });
    expect(advanced.statusCode).toBe(200);
    status = (advanced.json() as { snapshot: { run: { status: string } } })
      .snapshot.run.status;
    if (status === "awaiting_user") {
      const approval = await app.inject({
        method: "POST",
        url: `/api/runs/${runId}/actions`,
        payload: { action: "accept_manuscript", projectId },
      });
      expect(approval.statusCode, approval.body).toBe(200);
      status = "running";
    }
  }
  return status;
}

describe("startup recovery", () => {
  it("terminates leftover leases, call receipts and stream attempts at buildApp", async () => {
    const database = new NodeNarrativeDatabase();
    database.migrate();
    const now = "2026-08-10T00:00:00.000Z";
    new SqliteProjectRepository(database).insert(
      createProject({ id: "p1", title: "潮汐灯塔", now }),
    );
    new SqliteProviderRepository(database).upsert({
      id: "profile",
      name: "test",
      wireApi: "openai-chat",
      baseUrl: "https://api.example.com/v1",
      endpoint: null,
      credentialRef: "env:TEST_KEY",
      anthropicVersion: null,
      headers: {},
      queryParams: {},
      requestStartTimeoutMs: null,
      streamIdleTimeoutMs: null,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
    new SqliteModelRepository(database).upsert({
      id: "profile",
      providerId: "profile",
      modelId: "test-model",
      taskType: "writing",
      contextWindow: null,
      maxOutputTokens: null,
      sampling: {},
      capabilities: {},
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
    const runs = new SqliteRunRepository(database);
    const recipe = buildChapterRecipe("run-orphan", 1);
    runs.create({
      id: "run-orphan",
      projectId: "p1",
      recipe: recipe.name,
      recipeVersion: recipe.version,
      mode: "autopilot",
      modelId: "profile",
      targetOutlineNodeId: null,
      policy: {},
      budgetLimit: {
        maxInputTokens: 100_000,
        maxOutputTokens: 50_000,
        maxCalls: 50,
        maxCostUsd: null,
        maxWallTimeMs: 3_600_000,
      },
      steps: recipe.steps,
      now,
    });
    // A dead worker holds an expired lease while its step is still running.
    expect(
      runs.leaseRun("run-orphan", "worker-dead", now, 60_000),
    ).not.toBeNull();
    const stepId = recipe.steps[0]!.id;
    runs.startStep("run-orphan", stepId, now);
    database.raw
      .prepare("UPDATE run_jobs SET lease_expires_at = ? WHERE run_id = ?")
      .run("2000-01-01T00:00:00.000Z", "run-orphan");
    new SqliteLlmCallRepository(database).start({
      id: "call-orphan",
      projectId: "p1",
      runId: "run-orphan",
      stepId,
      modelId: "profile",
      protocol: "openai-chat",
      model: "test-model",
      purpose: "chapter-draft",
      requestHash: "hash-call-orphan",
      startedAt: now,
    });
    new SqliteRunStreamRepository(database).appendText(
      "run-orphan",
      stepId,
      "雾从海面推上石阶。",
      now,
    );

    const app = await buildApp({
      config,
      database,
      environment: {
        NARRATIVE_LLM_API_KEY: "server-only-test-key",
        NARRATIVE_LLM_BASE_URL: "https://api.example.com/v1",
        NARRATIVE_LLM_MODEL: "test-model",
        NARRATIVE_LLM_CONTEXT_WINDOW: "128000",
        NARRATIVE_LLM_MAX_OUTPUT_TOKENS: "32000",
      },
      narrativeModelClient: scriptedModel(),
      enableRunWorker: false,
      logger: false,
    });
    resources.push({ app, database });

    expect(
      database.raw
        .prepare("SELECT status, lease_owner FROM run_jobs WHERE run_id = ?")
        .get("run-orphan"),
    ).toEqual({ status: "queued", lease_owner: null });
    const step = database.raw
      .prepare(
        "SELECT status, error_json FROM run_steps WHERE run_id = ? AND id = ?",
      )
      .get("run-orphan", stepId) as { status: string; error_json: string };
    expect(step.status).toBe("failed");
    expect(JSON.parse(step.error_json)).toMatchObject({
      code: "run.lease_expired",
      retryable: true,
    });
    expect(runs.getRun("run-orphan")?.status).toBe("failed_recoverable");
    expect(
      database.raw
        .prepare("SELECT status, finished_at FROM llm_calls WHERE id = ?")
        .get("call-orphan"),
    ).toMatchObject({ status: "interrupted" });
    expect(
      new SqliteRunStreamRepository(database).get("run-orphan", stepId, 1),
    ).toMatchObject({ status: "interrupted", content: "雾从海面推上石阶。" });
  });
});

describe("partial stream continue", () => {
  it("creates a continuation run carrying the partial as prefix, idempotently", async () => {
    const { app, database } = await setup();
    const target = await createProjectAndChapter(app);
    const runId = await createRun(app, target.projectId, target.chapterId);
    const partial = seedPartial(
      database,
      runId,
      target.chapterId,
      PARTIAL_PREFIX,
    );
    // The source run was approved at its commit gate; the approval is a
    // one-time decision and must not leak into the continuation run.
    new SqliteRunRepository(database).mergePolicy(
      runId,
      { chapterApproved: true },
      new Date().toISOString(),
    );

    const created = await app.inject({
      method: "POST",
      url: `/api/runs/${runId}/streams/continue`,
      payload: { ...partial, projectId: target.projectId },
    });
    expect(created.statusCode, created.body).toBe(202);
    const body = created.json() as {
      run: {
        id: string;
        recipe: string;
        recipeVersion: number;
        targetOutlineNodeId: string;
        policy: Record<string, unknown>;
      };
      steps: unknown[];
      effectivePolicy: Record<string, unknown>;
    };
    const source = new SqliteRunRepository(database).getRun(runId)!;
    expect(body.run.id).not.toBe(runId);
    expect(body.run.recipe).toBe(source.recipe);
    expect(body.run.recipeVersion).toBe(source.recipeVersion);
    expect(body.run.targetOutlineNodeId).toBe(target.chapterId);
    expect(body.steps).toHaveLength(
      new SqliteRunRepository(database).getSnapshot(runId).steps.length,
    );
    expect(body.run.policy.continuationPrefix).toBe(PARTIAL_PREFIX);
    expect(body.run.policy.continuedFrom).toEqual({
      runId,
      stepId: partial.stepId,
      attempt: 1,
    });
    // The source run's one-time commit approval is not inherited.
    expect(body.run.policy.chapterApproved).toBeUndefined();
    expect(body.effectivePolicy.minChapterCharacters).toBe(100);
    expect(new SqliteRunRepository(database).getRun(runId)?.status).toBe(
      "cancelled",
    );
    expect(
      database.raw
        .prepare("SELECT status FROM run_jobs WHERE run_id = ?")
        .get(runId),
    ).toEqual({ status: "finished" });

    const repeated = await app.inject({
      method: "POST",
      url: `/api/runs/${runId}/streams/continue`,
      payload: { ...partial, projectId: target.projectId },
    });
    expect(repeated.statusCode).toBe(202);
    expect((repeated.json() as { run: { id: string } }).run.id).toBe(
      body.run.id,
    );
    const list = await app.inject({
      method: "GET",
      url: `/api/projects/${target.projectId}/runs`,
    });
    expect(list.json()).toHaveLength(2);
    const sourceAdvance = await app.inject({
      method: "POST",
      url: `/api/runs/${runId}/advance`,
      payload: { projectId: target.projectId },
    });
    expect(sourceAdvance.json()).toMatchObject({
      processed: false,
      snapshot: { run: { status: "cancelled" } },
    });
  });

  it("rejects continue for short partials (422) and missing streams (404)", async () => {
    const { app, database } = await setup();
    const target = await createProjectAndChapter(app);
    const runId = await createRun(app, target.projectId, target.chapterId);
    const partial = seedPartial(database, runId, target.chapterId, "太短了");

    const tooShort = await app.inject({
      method: "POST",
      url: `/api/runs/${runId}/streams/continue`,
      payload: { ...partial, projectId: target.projectId },
    });
    expect(tooShort.statusCode).toBe(422);
    expect(tooShort.json()).toMatchObject({
      error: { code: "run.stream.too_short" },
    });

    const missing = await app.inject({
      method: "POST",
      url: `/api/runs/${runId}/streams/continue`,
      payload: {
        stepId: partial.stepId,
        attempt: 99,
        projectId: target.projectId,
      },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({
      error: { code: "run.stream.not_found" },
    });
    expect(new SqliteRunRepository(database).getRun(runId)?.status).toBe(
      "failed_recoverable",
    );
    expect(
      database.raw
        .prepare("SELECT status FROM run_jobs WHERE run_id = ?")
        .get(runId),
    ).toEqual({ status: "queued" });
  });

  it("continues the draft from the prefix and commits through the normal path", async () => {
    const captured: { draftPrompts: string[] } = { draftPrompts: [] };
    const { app, database } = await setup(
      scriptedModel({ captured, draftText: CONTINUATION_TEXT }),
    );
    const target = await createProjectAndChapter(app);
    const runId = await createRun(app, target.projectId, target.chapterId);
    const partial = seedPartial(
      database,
      runId,
      target.chapterId,
      PARTIAL_PREFIX,
    );

    const created = await app.inject({
      method: "POST",
      url: `/api/runs/${runId}/streams/continue`,
      payload: { ...partial, projectId: target.projectId },
    });
    expect(created.statusCode, created.body).toBe(202);
    const continuedRunId = (created.json() as { run: { id: string } }).run.id;

    expect(await completeRun(app, continuedRunId, target.projectId)).toBe(
      "completed",
    );

    // The draft prompt carries the partial as an explicitly-marked existing
    // beginning, and the committed manuscript is prefix + generated part.
    expect(captured.draftPrompts).toHaveLength(1);
    expect(captured.draftPrompts[0]).toContain("<existing-beginning>");
    expect(captured.draftPrompts[0]).toContain(PARTIAL_PREFIX);
    expect(captured.draftPrompts[0]).toContain("只输出新增的续写部分");
    const version = database.raw
      .prepare("SELECT content, source, run_id FROM document_versions")
      .get() as { content: string; source: string; run_id: string };
    expect(version.content).toBe(PARTIAL_PREFIX + CONTINUATION_TEXT);
    expect(version).toMatchObject({
      source: `run:${continuedRunId}`,
      run_id: continuedRunId,
    });
    // Canon settlement went through the normal commit path for the
    // continuation run.
    expect(
      database.raw
        .prepare(
          "SELECT COUNT(*) AS count FROM canon_change_sets WHERE run_id = ?",
        )
        .get(continuedRunId),
    ).toEqual({ count: 1 });
  });

  it("does not duplicate document versions or canon when a commit is replayed", async () => {
    const { app, database } = await setup();
    const target = await createProjectAndChapter(app);
    const runId = await createRun(app, target.projectId, target.chapterId);
    const partial = seedPartial(
      database,
      runId,
      target.chapterId,
      PARTIAL_PREFIX,
    );
    const created = await app.inject({
      method: "POST",
      url: `/api/runs/${runId}/streams/continue`,
      payload: { ...partial, projectId: target.projectId },
    });
    const continuedRunId = (created.json() as { run: { id: string } }).run.id;
    expect(await completeRun(app, continuedRunId, target.projectId)).toBe(
      "completed",
    );

    const counts = () => ({
      versions: (
        database.raw
          .prepare("SELECT COUNT(*) AS count FROM document_versions")
          .get() as { count: number }
      ).count,
      changeSets: (
        database.raw
          .prepare(
            "SELECT COUNT(*) AS count FROM canon_change_sets WHERE run_id = ?",
          )
          .get(continuedRunId) as { count: number }
      ).count,
    });
    expect(counts()).toEqual({ versions: 1, changeSets: 1 });

    // Simulate a lost success record: the commit step is re-executed and must
    // hit the worker's idempotent replay path instead of committing twice.
    const commitStep = new SqliteRunRepository(database)
      .getSnapshot(continuedRunId)
      .steps.find((step) => step.kind === "chapter.commit")!;
    database.raw
      .prepare(
        `UPDATE run_steps SET status = 'pending', attempt = 0, output_artifact_json = NULL,
           output_hash = NULL, finished_at = NULL WHERE run_id = ? AND id = ?`,
      )
      .run(continuedRunId, commitStep.id);
    database.raw
      .prepare(
        "UPDATE runs SET status = 'running', finished_at = NULL WHERE id = ?",
      )
      .run(continuedRunId);
    database.raw
      .prepare(
        `UPDATE run_jobs SET status = 'queued', available_at = ?, lease_owner = NULL,
           lease_expires_at = NULL WHERE run_id = ?`,
      )
      .run(new Date().toISOString(), continuedRunId);

    await app.inject({
      method: "POST",
      url: `/api/runs/${continuedRunId}/advance`,
      payload: { projectId: target.projectId },
    });
    const replayed = new SqliteRunRepository(database)
      .getSnapshot(continuedRunId)
      .steps.find((step) => step.kind === "chapter.commit");
    expect(replayed?.status).toBe("succeeded");
    expect(replayed?.outputArtifact).toMatchObject({ idempotentReplay: true });
    expect(counts()).toEqual({ versions: 1, changeSets: 1 });
  });
});

describe("partial stream adopt", () => {
  it("appends the partial to the chapter document version chain, idempotently", async () => {
    const { app, database } = await setup();
    const target = await createProjectAndChapter(app);
    const runId = await createRun(app, target.projectId, target.chapterId);
    const partial = seedPartial(
      database,
      runId,
      target.chapterId,
      PARTIAL_PREFIX,
    );

    const adopted = await app.inject({
      method: "POST",
      url: `/api/runs/${runId}/streams/adopt`,
      payload: { ...partial, projectId: target.projectId },
    });
    expect(adopted.statusCode, adopted.body).toBe(200);
    const first = adopted.json() as {
      documentId: string;
      versionId: string;
      idempotentReplay: boolean;
    };
    expect(first.idempotentReplay).toBe(false);
    expect(first.documentId).toBe(`${runId}:chapter-document`);

    // Repeating the adopt replays instead of duplicating the version — even
    // after the partial row itself is discarded.
    const repeated = await app.inject({
      method: "POST",
      url: `/api/runs/${runId}/streams/adopt`,
      payload: { ...partial, projectId: target.projectId },
    });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json()).toMatchObject({
      documentId: first.documentId,
      versionId: first.versionId,
      idempotentReplay: true,
    });
    await app.inject({
      method: "POST",
      url: `/api/runs/${runId}/streams/discard`,
      payload: { ...partial, projectId: target.projectId },
    });
    const afterDiscard = await app.inject({
      method: "POST",
      url: `/api/runs/${runId}/streams/adopt`,
      payload: { ...partial, projectId: target.projectId },
    });
    expect(afterDiscard.statusCode).toBe(200);
    expect(afterDiscard.json()).toMatchObject({ idempotentReplay: true });
    expect(
      database.raw
        .prepare("SELECT COUNT(*) AS count FROM document_versions")
        .get(),
    ).toEqual({ count: 1 });
    expect(new SqliteRunRepository(database).getRun(runId)?.status).toBe(
      "cancelled",
    );
    expect(
      database.raw
        .prepare("SELECT status FROM run_jobs WHERE run_id = ?")
        .get(runId),
    ).toEqual({ status: "finished" });
    const sourceAdvance = await app.inject({
      method: "POST",
      url: `/api/runs/${runId}/advance`,
      payload: { projectId: target.projectId },
    });
    expect(sourceAdvance.json()).toMatchObject({
      processed: false,
      snapshot: { run: { status: "cancelled" } },
    });
  });

  it("rejects adopt for short partials (422)", async () => {
    const { app, database } = await setup();
    const target = await createProjectAndChapter(app);
    const runId = await createRun(app, target.projectId, target.chapterId);
    const partial = seedPartial(database, runId, target.chapterId, "太短了");

    const response = await app.inject({
      method: "POST",
      url: `/api/runs/${runId}/streams/adopt`,
      payload: { ...partial, projectId: target.projectId },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: { code: "run.stream.too_short" },
    });
  });
});

describe("partial stream regenerate", () => {
  it("discards the partial and re-executes the source step, idempotently", async () => {
    const { app, database } = await setup();
    const target = await createProjectAndChapter(app);
    const runId = await createRun(app, target.projectId, target.chapterId);
    const partial = seedPartial(
      database,
      runId,
      target.chapterId,
      PARTIAL_PREFIX,
    );
    // The interrupted attempt left the step failed and the run recoverable.
    const recoverable = await app.inject({
      method: "GET",
      url: `/api/runs/${runId}?projectId=${target.projectId}`,
    });
    expect(recoverable.statusCode, recoverable.body).toBe(200);
    expect(recoverable.json()).toMatchObject({
      result: {
        partialRecovery: {
          stepId: partial.stepId,
          attempt: partial.attempt,
          canAdopt: true,
        },
      },
      availableActions: ["use_partial", "regenerate", "cancel"],
    });

    const regenerated = await app.inject({
      method: "POST",
      url: `/api/runs/${runId}/streams/regenerate`,
      payload: { ...partial, projectId: target.projectId },
    });
    expect(regenerated.statusCode, regenerated.body).toBe(200);
    expect(regenerated.json()).toMatchObject({
      discarded: true,
      snapshot: { run: { status: "failed_recoverable" } },
    });

    // Idempotent repeat: the partial row is already gone.
    const repeated = await app.inject({
      method: "POST",
      url: `/api/runs/${runId}/streams/regenerate`,
      payload: { ...partial, projectId: target.projectId },
    });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json()).toMatchObject({ discarded: false });
    expect(
      new SqliteRunStreamRepository(database).listForRun(runId),
    ).toHaveLength(0);

    // The normal retry/advance path re-executes the draft step from scratch.
    await app.inject({
      method: "POST",
      url: `/api/runs/${runId}/advance`,
      payload: { projectId: target.projectId },
    });
    database.raw
      .prepare("UPDATE run_jobs SET available_at = ? WHERE run_id = ?")
      .run("2000-01-01T00:00:00.000Z", runId);
    expect(
      await completeRun(app, runId, target.projectId),
      JSON.stringify(
        new SqliteRunRepository(database).getSnapshot(runId).steps,
      ),
    ).toBe("completed");
    const step = new SqliteRunRepository(database)
      .getSnapshot(runId)
      .steps.find((candidate) => candidate.kind === "draft.generate");
    expect(step).toMatchObject({ status: "succeeded", attempt: 2 });
    const version = database.raw
      .prepare("SELECT content FROM document_versions")
      .get() as { content: string };
    expect(version.content).toBe(FULL_MANUSCRIPT);
  });

  it("rejects regenerate on terminal runs (409)", async () => {
    const { app, database } = await setup();
    const target = await createProjectAndChapter(app);
    const runId = await createRun(app, target.projectId, target.chapterId);
    const partial = seedPartial(
      database,
      runId,
      target.chapterId,
      PARTIAL_PREFIX,
    );
    await app.inject({
      method: "POST",
      url: `/api/runs/${runId}/actions`,
      payload: { action: "cancel", projectId: target.projectId },
    });
    await app.inject({
      method: "POST",
      url: `/api/runs/${runId}/advance`,
      payload: { projectId: target.projectId },
    });
    expect(new SqliteRunRepository(database).getRun(runId)?.status).toBe(
      "cancelled",
    );

    const response = await app.inject({
      method: "POST",
      url: `/api/runs/${runId}/streams/regenerate`,
      payload: { ...partial, projectId: target.projectId },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: "run.terminal" } });
  });
});

function scriptedModel(options?: {
  captured?: { draftPrompts: string[] };
  draftText?: string;
}): NarrativeModelClient {
  const usage = {
    inputTokens: 100,
    outputTokens: 100,
    calls: 1,
    costUsd: 0,
    wallTimeMs: 5,
  };
  return {
    async text(_run, _step, purpose, request) {
      if (purpose === "chapter-draft") {
        const message = request.messages[0]?.content;
        options?.captured?.draftPrompts.push(
          typeof message === "string" ? message : JSON.stringify(message),
        );
        return { text: options?.draftText ?? FULL_MANUSCRIPT, usage };
      }
      return { text: FULL_MANUSCRIPT, usage };
    },
    async structured(_run, _step, purpose, _request, _contract, validate) {
      const value =
        purpose === "scene-plan"
          ? {
              chapterGoal: "发现遗忘规则",
              povEntityId: null,
              scenes: [
                {
                  title: "熄灯",
                  goal: "进入灯塔",
                  conflict: "父亲阻拦",
                  turn: "灯塔自行熄灭",
                  outcome: "父亲遗忘一人",
                  locationId: null,
                  participants: [],
                  targetCharacters: 1_200,
                },
              ],
              continuityRisks: [],
            }
          : purpose === "semantic-review"
            ? {
                summary: "章节目标已经完成。",
                scores: {
                  continuity: 92,
                  pacing: 88,
                  character: 86,
                  prose: 85,
                  goal: 94,
                },
                issues: [],
              }
            : {
                summaryPoints: [
                  {
                    text: "林昼发现灯塔熄灭会触发遗忘。",
                    basis: "observed",
                    evidenceParagraphs: [1],
                  },
                ],
                stateDelta: [
                  {
                    key: "ruleObserved",
                    before: null,
                    after: "林昼发现熄灯触发遗忘",
                    evidenceParagraphs: [1],
                  },
                ],
                factCandidates: [],
                timelineCandidates: [],
                relationshipCandidates: [],
                foreshadowCandidates: [],
              };
      const checked = validate(value);
      if (!checked.success) throw new Error(checked.issues.join("; "));
      return {
        value: checked.data,
        usage,
        mode: "native",
        attempts: 1,
      };
    },
  } as NarrativeModelClient;
}
