import type { NarrativeModelClient } from "@narralume/narrative";
import {
  SqliteAssignmentRepository,
  SqliteAutomationRepository,
  SqliteModelRepository,
  SqliteProviderRepository,
  SqliteRunRepository,
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

async function setup() {
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
    narrativeModelClient: scriptedModel(),
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

describe("chapter run API", () => {
  it("replays the same creation request and allows only one active chapter run per project", async () => {
    const { app } = await setup();
    const target = await createProjectAndChapter(app);
    const payload = {
      requestId: "chapter-create-idempotency",
      targetOutlineNodeId: target.chapterId,
      maxRevisionCycles: 1,
    };

    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${target.projectId}/runs/chapter`,
      payload,
    });
    const replay = await app.inject({
      method: "POST",
      url: `/api/projects/${target.projectId}/runs/chapter`,
      payload,
    });
    expect(created.statusCode, created.body).toBe(202);
    expect(replay.statusCode, replay.body).toBe(202);
    expect(replay.json()).toMatchObject({
      run: { id: created.json().run.id },
      idempotentReplay: true,
    });
    const overview = await app.inject({
      method: "GET",
      url: `/api/projects/${target.projectId}/overview`,
    });
    expect(overview.statusCode, overview.body).toBe(200);
    expect(overview.json()).toMatchObject({
      activeTask: {
        kind: "chapter",
        id: created.json().run.id,
        targetChapter: { outlineNodeId: target.chapterId },
        availableActions: ["pause", "cancel"],
      },
      nextAction: {
        kind: "continue_task",
        targetId: created.json().run.id,
      },
    });

    const changedReplay = await app.inject({
      method: "POST",
      url: `/api/projects/${target.projectId}/runs/chapter`,
      payload: { ...payload, maxRevisionCycles: 2 },
    });
    expect(changedReplay.statusCode).toBe(409);
    expect(changedReplay.json()).toMatchObject({
      error: { code: "chapter.run.idempotency_conflict" },
    });

    const duplicate = await app.inject({
      method: "POST",
      url: `/api/projects/${target.projectId}/runs/chapter`,
      payload: { ...payload, requestId: "another-chapter-request" },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({
      error: { code: "project.writing_task.active" },
    });

    const bible = (
      await app.inject({
        method: "GET",
        url: `/api/projects/${target.projectId}/story-bible`,
      })
    ).json() as { outline: Array<{ id: string; kind: string }> };
    const secondChapter = await app.inject({
      method: "POST",
      url: `/api/projects/${target.projectId}/outline`,
      payload: {
        parentId: bible.outline.find((node) => node.kind === "book")!.id,
        kind: "chapter",
        ordinal: 1,
        title: "第二章",
      },
    });
    expect(secondChapter.statusCode, secondChapter.body).toBe(201);
    const parallelChapter = await app.inject({
      method: "POST",
      url: `/api/projects/${target.projectId}/runs/chapter`,
      payload: {
        ...payload,
        requestId: "parallel-chapter-request",
        targetOutlineNodeId: secondChapter.json().id,
      },
    });
    expect(parallelChapter.statusCode).toBe(409);
    expect(parallelChapter.json()).toMatchObject({
      error: { code: "project.writing_task.active" },
    });
  });

  it("失败的章节任务暴露 retry_chapter：新建同章节 run 且重复点击幂等", async () => {
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
      // 结算结构化输出永远无效：烧完重试预算，run 落到终态 failed。
      narrativeModelClient: scriptedModel({
        settlementInvalid: true,
      }),
      enableRunWorker: false,
      logger: false,
    });
    resources.push({ app, database });
    const target = await createProjectAndChapter(app);
    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${target.projectId}/runs/chapter`,
      payload: {
        requestId: "retry-source",
        targetOutlineNodeId: target.chapterId,
        maxRevisionCycles: 0,
        policy: {
          minChapterCharacters: 100,
          retryBaseDelayMs: 1,
          maxRetries: 0,
        },
      },
    });
    expect(created.statusCode, created.body).toBe(202);
    const sourceRunId = (created.json() as { run: { id: string } }).run.id;

    let status = "pending";
    for (
      let index = 0;
      index < 40 && !["failed"].includes(status);
      index += 1
    ) {
      const advanced = await app.inject({
        method: "POST",
        url: `/api/runs/${sourceRunId}/advance`,
        payload: { projectId: target.projectId },
      });
      status = (advanced.json() as { snapshot: { run: { status: string } } })
        .snapshot.run.status;
    }
    expect(status).toBe("failed");

    const detail = (
      await app.inject({
        method: "GET",
        url: `/api/runs/${sourceRunId}?projectId=${target.projectId}`,
      })
    ).json();
    expect(detail.availableActions).toEqual(["retry_chapter"]);
    expect(detail.parentTask).toBeNull();

    const retryPayload = {
      action: "retry_chapter",
      projectId: target.projectId,
      requestId: "user-retry-1",
    };
    const retried = await app.inject({
      method: "POST",
      url: `/api/runs/${sourceRunId}/actions`,
      payload: retryPayload,
    });
    expect(retried.statusCode, retried.body).toBe(202);
    const retryRun = (retried.json() as { run: { id: string; status: string } })
      .run;
    expect(retryRun.status).toBe("pending");
    expect(retryRun.id).not.toBe(sourceRunId);

    // 重复点击：同一 requestId 回到同一个新 run，不翻倍。
    const replay = await app.inject({
      method: "POST",
      url: `/api/runs/${sourceRunId}/actions`,
      payload: retryPayload,
    });
    expect(replay.statusCode, replay.body).toBe(202);
    expect(replay.json()).toMatchObject({
      run: { id: retryRun.id },
      idempotentReplay: true,
    });

    // 有了进行中的重试任务后，源 run 的重试入口被活跃检查挡住。
    const blocked = await app.inject({
      method: "POST",
      url: `/api/runs/${sourceRunId}/actions`,
      payload: { ...retryPayload, requestId: "user-retry-2" },
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({
      error: { code: "project.writing_task.active" },
    });

    const automation = new SqliteAutomationRepository(database);
    automation.createSession({
      id: "owning-autopilot-session",
      projectId: target.projectId,
      mode: "autopilot",
      targetChapters: 1,
      windowSize: 1,
      maxRevisionCycles: 0,
      chapterPolicy: {},
      now: "2026-08-19T00:00:00.000Z",
    });
    automation.attachRun("owning-autopilot-session", {
      runId: sourceRunId,
      role: "chapter",
      outlineNodeId: target.chapterId,
      now: "2026-08-19T00:00:01.000Z",
    });
    const ownedDetail = (
      await app.inject({
        method: "GET",
        url: `/api/runs/${sourceRunId}?projectId=${target.projectId}`,
      })
    ).json();
    expect(ownedDetail).toMatchObject({
      parentTask: { kind: "autopilot", id: "owning-autopilot-session" },
      availableActions: [],
    });
    const ownedRetry = await app.inject({
      method: "POST",
      url: `/api/runs/${sourceRunId}/actions`,
      payload: { ...retryPayload, requestId: "user-retry-owned" },
    });
    expect(ownedRetry.statusCode, ownedRetry.body).toBe(409);
    expect(ownedRetry.json()).toMatchObject({
      error: { code: "run.retry.owned_by_autopilot" },
    });
  });

  it("requires the owning project when advancing a run (CR-98)", async () => {
    const { app } = await setup();
    const owner = await createProjectAndChapter(app);
    const foreign = await createProjectAndChapter(app);
    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${owner.projectId}/runs/chapter`,
      payload: {
        requestId: "advance-project-ownership",
        targetOutlineNodeId: owner.chapterId,
        maxRevisionCycles: 0,
      },
    });
    expect(created.statusCode, created.body).toBe(202);
    const runId = (created.json() as { run: { id: string } }).run.id;

    const rejected = await app.inject({
      method: "POST",
      url: `/api/runs/${runId}/advance`,
      payload: { projectId: foreign.projectId },
    });
    expect(rejected.statusCode, rejected.body).toBe(404);
    expect(rejected.json()).toMatchObject({ error: { code: "run.not_found" } });

    const advanced = await app.inject({
      method: "POST",
      url: `/api/runs/${runId}/advance`,
      payload: { projectId: owner.projectId },
    });
    expect(advanced.statusCode, advanced.body).toBe(200);
  });

  it("executes validated stored recipe overrides instead of inert template text", async () => {
    const { app } = await setup();
    const target = await createProjectAndChapter(app);
    const templates = (
      await app.inject({ method: "GET", url: "/api/harness/templates" })
    ).json() as Array<{ key: string; version: number }>;
    const chapterTemplate = templates.find(
      (template) => template.key === "recipe.chapter-production",
    )!;
    const content = JSON.stringify({
      maxRevisionCycles: 0,
      steps: [
        { kind: "context.compile", maxAttempts: 5 },
        "scene.plan",
        "draft.generate",
        "deterministic.check",
        "semantic.review",
        "revision.generate?",
        "chapter.settle",
        "chapter.commit",
      ],
    });
    const updated = await app.inject({
      method: "PUT",
      url: "/api/harness/templates/recipe.chapter-production",
      payload: { content, expectedVersion: chapterTemplate.version },
    });
    expect(updated.statusCode).toBe(200);
    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${target.projectId}/runs/chapter`,
      payload: {
        requestId: "recipe-override",
        targetOutlineNodeId: target.chapterId,
        maxRevisionCycles: 3,
      },
    });
    expect(created.statusCode, created.body).toBe(202);
    expect(created.json().run.recipeVersion).toBe(2);
    expect(created.json().steps[0]).toMatchObject({
      kind: "context.compile",
      maxAttempts: 5,
    });
    expect(
      created
        .json()
        .steps.some(
          (step: { kind: string }) => step.kind === "revision.generate",
        ),
    ).toBe(false);
    const invalid = await app.inject({
      method: "PUT",
      url: "/api/harness/templates/recipe.chapter-production",
      payload: {
        content: content.replace(
          '"chapter.settle","chapter.commit"',
          '"chapter.commit","chapter.settle"',
        ),
        expectedVersion: updated.json().version,
      },
    });
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json()).toMatchObject({
      error: { code: "recipe.template.invariant" },
    });
  });

  it("executes an evidence-gated chapter recipe and exposes its receipts", async () => {
    const { app, database } = await setup();
    const target = await createProjectAndChapter(app);
    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${target.projectId}/runs/chapter`,
      payload: {
        requestId: "evidence-gated",
        targetOutlineNodeId: target.chapterId,
        maxRevisionCycles: 1,
        policy: {
          minChapterCharacters: 100,
        },
      },
    });
    expect(created.statusCode, created.body).toBe(202);
    const runId = (created.json() as { run: { id: string } }).run.id;

    let status = "pending";
    for (let index = 0; index < 30 && status !== "completed"; index += 1) {
      const advanced = await app.inject({
        method: "POST",
        url: `/api/runs/${runId}/advance`,
        payload: { projectId: target.projectId },
      });
      expect(advanced.statusCode).toBe(200);
      status = (advanced.json() as { snapshot: { run: { status: string } } })
        .snapshot.run.status;
      if (status === "awaiting_user") {
        const approval = await app.inject({
          method: "POST",
          url: `/api/runs/${runId}/actions`,
          payload: { action: "accept_manuscript", projectId: target.projectId },
        });
        expect(approval.statusCode, approval.body).toBe(200);
        status = "running";
      }
    }

    expect(
      status,
      JSON.stringify(new SqliteRunRepository(database).getSnapshot(runId)),
    ).toBe("completed");
    const detailResponse = await app.inject({
      method: "GET",
      url: `/api/runs/${runId}?projectId=${target.projectId}`,
    });
    expect(detailResponse.statusCode).toBe(200);
    expect(detailResponse.json()).toMatchObject({
      run: { id: runId, status: "completed", revisionCycle: 1 },
      reviews: [{ verdict: "pass", summary: "章节目标已经完成。" }],
      latestCheckpoint: { kind: "after:chapter.commit" },
    });
    const detail = detailResponse.json() as {
      steps: { kind: string; status: string }[];
      events: { sequence: number }[];
      llmCalls: unknown[];
    };
    expect(
      detail.steps.find((step) => step.kind === "revision.generate")?.status,
    ).toBe("skipped");
    expect(detail.events.map((event) => event.sequence)).toEqual(
      detail.events.map((_event, index) => index),
    );
    expect(detail.llmCalls).toEqual([]);
    expect(
      database.raw
        .prepare("SELECT COUNT(*) AS count FROM document_versions")
        .get(),
    ).toEqual({ count: 1 });
  });

  it("persists the resolved effective policy and rejects unknown policy fields", async () => {
    const { app } = await setup();
    const target = await createProjectAndChapter(app);
    const fullPolicy = {
      requestStartTimeoutMs: 30_000,
      streamIdleTimeoutMs: 90_000,
      logicalCallDeadlineMs: 300_000,
      stepDeadlineMs: 420_000,
      runDeadlineMs: 10_800_000,
      maxRetries: 2,
      retryBaseDelayMs: 1_500,
      maxRepairAttempts: 2,
      minChapterCharacters: 800,
    };
    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${target.projectId}/runs/chapter`,
      payload: {
        requestId: "full-policy",
        targetOutlineNodeId: target.chapterId,
        policy: fullPolicy,
      },
    });
    expect(created.statusCode, created.body).toBe(202);
    const createdBody = created.json() as {
      run: { id: string };
      effectivePolicy: Record<string, unknown>;
    };
    expect(createdBody.effectivePolicy).toMatchObject(fullPolicy);

    const detail = await app.inject({
      method: "GET",
      url: `/api/runs/${createdBody.run.id}?projectId=${target.projectId}`,
    });
    expect(detail.statusCode).toBe(200);
    const detailBody = detail.json() as {
      run: { policy: Record<string, unknown> };
      effectivePolicy: Record<string, unknown> | null;
    };
    expect(detailBody.effectivePolicy).toMatchObject(fullPolicy);
    // Every policy field from the request lands in the persisted run.policy.
    for (const [key, value] of Object.entries(fullPolicy)) {
      expect(detailBody.run.policy[key]).toEqual(value);
    }

    const unknown = await app.inject({
      method: "POST",
      url: `/api/projects/${target.projectId}/runs/chapter`,
      payload: {
        requestId: "unknown-policy",
        targetOutlineNodeId: target.chapterId,
        policy: { minChapterCharacters: 100, unknownKnob: true },
      },
    });
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json()).toMatchObject({
      error: { code: "policy.unknown_field", fields: ["unknownKnob"] },
    });

    const obsolete = await app.inject({
      method: "POST",
      url: `/api/projects/${target.projectId}/runs/chapter`,
      payload: {
        requestId: "obsolete-profile",
        targetOutlineNodeId: target.chapterId,
        profileId: "removed-profile",
      },
    });
    expect(obsolete.statusCode).toBe(422);
    expect(obsolete.json()).toMatchObject({
      error: { code: "request.unknown_field", fields: ["profileId"] },
    });

    // Out-of-range values on known policy fields stay a plain 400.
    const invalid = await app.inject({
      method: "POST",
      url: `/api/projects/${target.projectId}/runs/chapter`,
      payload: {
        requestId: "invalid-policy",
        targetOutlineNodeId: target.chapterId,
        policy: { maxRetries: 99 },
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({
      error: { code: "request.invalid" },
    });
  });

  it("flags only a missing embedding assignment via setupHint at run creation", async () => {
    const { app, database } = await setup();
    const target = await createProjectAndChapter(app);
    let requestSequence = 0;
    const createRun = async () => {
      const response = await app.inject({
        method: "POST",
        url: `/api/projects/${target.projectId}/runs/chapter`,
        payload: {
          requestId: `setup-hint-${requestSequence++}`,
          targetOutlineNodeId: target.chapterId,
        },
      });
      expect(response.statusCode, response.body).toBe(202);
      return response.json() as { setupHint?: string };
    };

    // No embedding capability configured anywhere.
    expect((await createRun()).setupHint).toBe("embedding_not_configured");

    const firstRun = (
      await app.inject({
        method: "GET",
        url: `/api/projects/${target.projectId}/runs`,
      })
    ).json() as Array<{ id: string }>;
    await app.inject({
      method: "POST",
      url: `/api/runs/${firstRun[0]!.id}/actions`,
      payload: { action: "cancel", projectId: target.projectId },
    });
    await app.inject({
      method: "POST",
      url: `/api/runs/${firstRun[0]!.id}/advance`,
      payload: { projectId: target.projectId },
    });

    // Rerank is not part of the default product chain, so embedding is the
    // only optional setup hint.
    seedTaskModel(database, "emb-provider", "emb-model", "emb-v1", "embedding");
    expect((await createRun()).setupHint).toBeUndefined();
  });

  it("returns product-facing origin, plan result, and only valid continuation actions", async () => {
    const { app } = await setup();
    const target = await createProjectAndChapter(app);
    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${target.projectId}/runs/chapter`,
      payload: {
        requestId: "product-projection",
        targetOutlineNodeId: target.chapterId,
        planningMode: "confirm",
        origin: { surface: "writing", documentId: null, selection: null },
        policy: { minChapterCharacters: 100 },
      },
    });
    expect(created.statusCode, created.body).toBe(202);
    expect(created.json()).toMatchObject({
      origin: { surface: "writing", documentId: null, selection: null },
      result: {
        planCandidate: null,
        manuscriptCandidate: null,
        reviewSummary: null,
        canonChangeSetId: null,
      },
      availableActions: ["pause", "cancel"],
    });
    const runId = (created.json() as { run: { id: string } }).run.id;

    let detail: {
      run?: { status: string };
      result?: Record<string, unknown>;
      availableActions?: string[];
    } = {};
    for (let index = 0; index < 8; index += 1) {
      await app.inject({
        method: "POST",
        url: `/api/runs/${runId}/advance`,
        payload: { projectId: target.projectId },
      });
      detail = (
        await app.inject({
          method: "GET",
          url: `/api/runs/${runId}?projectId=${target.projectId}`,
        })
      ).json();
      if (detail.run?.status === "awaiting_user") break;
    }
    expect(detail).toMatchObject({
      run: { status: "awaiting_user" },
      result: {
        planCandidate: { chapterGoal: "发现遗忘规则" },
        manuscriptCandidate: null,
      },
      availableActions: ["accept_plan", "switch_to_manual", "cancel"],
    });

    const invalid = await app.inject({
      method: "POST",
      url: `/api/runs/${runId}/actions`,
      payload: { action: "accept_manuscript", projectId: target.projectId },
    });
    expect(invalid.statusCode).toBe(409);
    expect(invalid.json()).toMatchObject({
      error: { code: "run.action.not_available" },
    });

    const accepted = await app.inject({
      method: "POST",
      url: `/api/runs/${runId}/actions`,
      payload: { action: "accept_plan", projectId: target.projectId },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({ run: { status: "running" } });
  });

  it("continues a pending manuscript as an idempotent requested-revision run", async () => {
    const { app, database } = await setup();
    const target = await createProjectAndChapter(app);
    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${target.projectId}/runs/chapter`,
      payload: {
        requestId: "requested-revision-source",
        targetOutlineNodeId: target.chapterId,
        maxRevisionCycles: 0,
        policy: { minChapterCharacters: 100 },
      },
    });
    const sourceRunId = (created.json() as { run: { id: string } }).run.id;
    let sourceDetail: {
      run: { status: string };
      availableActions: string[];
    } | null = null;
    for (let index = 0; index < 20; index += 1) {
      await app.inject({
        method: "POST",
        url: `/api/runs/${sourceRunId}/advance`,
        payload: { projectId: target.projectId },
      });
      sourceDetail = (
        await app.inject({
          method: "GET",
          url: `/api/runs/${sourceRunId}?projectId=${target.projectId}`,
        })
      ).json();
      if (sourceDetail.run.status === "awaiting_user") break;
    }
    expect(sourceDetail).toMatchObject({
      run: { status: "awaiting_user" },
      availableActions: [
        "accept_manuscript",
        "request_revision",
        "discard_manuscript",
        "cancel",
      ],
    });

    const requestPayload = {
      action: "request_revision",
      projectId: target.projectId,
      requestId: "revision-request-1",
      instruction: "保留事件顺序，但让父女对话更克制。",
    };
    const requested = await app.inject({
      method: "POST",
      url: `/api/runs/${sourceRunId}/actions`,
      payload: requestPayload,
    });
    expect(requested.statusCode, requested.body).toBe(202);
    const requestedBody = requested.json() as {
      run: { id: string; recipe: string; policy: Record<string, unknown> };
      idempotentReplay: boolean;
    };
    expect(requestedBody).toMatchObject({
      run: {
        recipe: "chapter-candidate-revision",
        policy: {
          revisionSourceRunId: sourceRunId,
          revisionRequestId: "revision-request-1",
          revisionInstruction: "保留事件顺序，但让父女对话更克制。",
        },
      },
      idempotentReplay: false,
    });
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/runs/${sourceRunId}?projectId=${target.projectId}`,
        })
      ).json(),
    ).toMatchObject({ run: { status: "cancelled" } });

    const replay = await app.inject({
      method: "POST",
      url: `/api/runs/${sourceRunId}/actions`,
      payload: requestPayload,
    });
    expect(replay.statusCode, replay.body).toBe(202);
    expect(replay.json()).toMatchObject({
      run: { id: requestedBody.run.id },
      idempotentReplay: true,
    });

    let revisionStatus = "pending";
    for (let index = 0; index < 20; index += 1) {
      const advanced = await app.inject({
        method: "POST",
        url: `/api/runs/${requestedBody.run.id}/advance`,
        payload: { projectId: target.projectId },
      });
      revisionStatus = (
        advanced.json() as { snapshot: { run: { status: string } } }
      ).snapshot.run.status;
      if (revisionStatus === "awaiting_user") break;
    }
    expect(
      revisionStatus,
      JSON.stringify(
        new SqliteRunRepository(database).getSnapshot(requestedBody.run.id),
      ),
    ).toBe("awaiting_user");
    const revisionDetail = (
      await app.inject({
        method: "GET",
        url: `/api/runs/${requestedBody.run.id}?projectId=${target.projectId}`,
      })
    ).json() as {
      steps: Array<{ id: string; kind: string; status: string }>;
      result: { manuscriptCandidate: Record<string, unknown> | null };
    };
    expect(
      revisionDetail.steps.find((step) =>
        step.id.endsWith(":revise:requested"),
      ),
    ).toMatchObject({ kind: "revision.generate", status: "succeeded" });
    expect(revisionDetail.result.manuscriptCandidate).not.toBeNull();
  });

  it("applies pause, resume, and cancel commands at safe boundaries", async () => {
    const { app } = await setup();
    const target = await createProjectAndChapter(app);
    let requestSequence = 0;
    const createRun = async () => {
      const response = await app.inject({
        method: "POST",
        url: `/api/projects/${target.projectId}/runs/chapter`,
        payload: {
          requestId: `control-${requestSequence++}`,
          targetOutlineNodeId: target.chapterId,
          policy: { minChapterCharacters: 100 },
        },
      });
      expect(response.statusCode, response.body).toBe(202);
      return (response.json() as { run: { id: string } }).run.id;
    };

    const pausedRunId = await createRun();
    await app.inject({
      method: "POST",
      url: `/api/runs/${pausedRunId}/actions`,
      payload: { action: "pause", projectId: target.projectId },
    });
    await app.inject({
      method: "POST",
      url: `/api/runs/${pausedRunId}/advance`,
      payload: { projectId: target.projectId },
    });
    const paused = await app.inject({
      method: "GET",
      url: `/api/runs/${pausedRunId}?projectId=${target.projectId}`,
    });
    expect(paused.json()).toMatchObject({ run: { status: "paused" } });

    const resumed = await app.inject({
      method: "POST",
      url: `/api/runs/${pausedRunId}/actions`,
      payload: { action: "resume", projectId: target.projectId },
    });
    expect(resumed.json()).toMatchObject({ run: { status: "running" } });

    await app.inject({
      method: "POST",
      url: `/api/runs/${pausedRunId}/actions`,
      payload: { action: "cancel", projectId: target.projectId },
    });
    await app.inject({
      method: "POST",
      url: `/api/runs/${pausedRunId}/advance`,
      payload: { projectId: target.projectId },
    });

    const cancelledRunId = await createRun();
    await app.inject({
      method: "POST",
      url: `/api/runs/${cancelledRunId}/actions`,
      payload: { action: "cancel", projectId: target.projectId },
    });
    let cancelledStatus = "pending";
    for (
      let index = 0;
      index < 5 && cancelledStatus !== "cancelled";
      index += 1
    ) {
      await app.inject({
        method: "POST",
        url: `/api/runs/${cancelledRunId}/advance`,
        payload: { projectId: target.projectId },
      });
      const cancelled = await app.inject({
        method: "GET",
        url: `/api/runs/${cancelledRunId}?projectId=${target.projectId}`,
      });
      cancelledStatus = (cancelled.json() as { run: { status: string } }).run
        .status;
    }
    expect(cancelledStatus).toBe("cancelled");
  });
});

function scriptedModel(
  options: { settlementInvalid?: boolean } = {},
): NarrativeModelClient {
  const manuscript =
    "雾从海面推上石阶。林昼把手按在冰冷的门上，听见灯塔深处传来第三下钟声。她沿着旋梯向上，每一级都沾着尚未干透的海水。\n\n灯灭的一刻，父亲忽然问她为何对着空椅子说话。窗外所有船铃同时沉默，仿佛港口刚刚吞掉了一个无人敢说出的名字。";
  const usage = {
    inputTokens: 100,
    outputTokens: 100,
    calls: 1,
    costUsd: 0,
    wallTimeMs: 5,
  };
  return {
    async text(_run, _step, purpose) {
      return {
        text:
          purpose === "chapter-revision"
            ? manuscript.replace("父亲忽然问她", "父亲移开目光，低声问她")
            : manuscript,
        usage,
      };
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
            : options.settlementInvalid
              ? {
                  summaryPoints: [
                    {
                      text: "永远无效的结算输出。",
                      basis: "observed",
                      evidenceParagraphs: [1],
                    },
                  ],
                  stateDelta: [],
                  factCandidates: [],
                  timelineCandidates: [],
                  relationshipCandidates: [],
                  // plant 却带 foreshadowId：确定性触发语义校验失败。
                  foreshadowCandidates: [
                    {
                      foreshadowId: "nonexistent-foreshadow",
                      title: "无效伏笔",
                      action: "resolve",
                      expectedStatus: "planted",
                      importance: 3,
                      targetFromNodeId: null,
                      targetToNodeId: null,
                      evidenceParagraphs: [1],
                    },
                  ],
                }
              : {
                  summaryPoints: [
                    {
                      text: "林昼发现灯塔熄灭会触发遗忘。",
                      basis: "observed",
                      evidenceParagraphs: [2],
                    },
                  ],
                  stateDelta: [
                    {
                      key: "ruleObserved",
                      before: null,
                      after: "林昼发现熄灯触发遗忘",
                      evidenceParagraphs: [2],
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

/** Seeds a provider + model + assignment for an auxiliary task role. */
function seedTaskModel(
  database: NodeNarrativeDatabase,
  providerId: string,
  modelRowId: string,
  wireModelId: string,
  role: "embedding" | "rerank",
): void {
  const now = new Date().toISOString();
  new SqliteProviderRepository(database).upsert({
    id: providerId,
    name: providerId,
    wireApi: "openai-chat",
    baseUrl: `https://${providerId}.example/v1`,
    endpoint: null,
    credentialRef: "raw-task-key-123456",
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
    id: modelRowId,
    providerId,
    modelId: wireModelId,
    taskType: role,
    contextWindow: null,
    maxOutputTokens: null,
    sampling: {},
    capabilities: {},
    enabled: true,
    createdAt: now,
    updatedAt: now,
  });
  new SqliteAssignmentRepository(database).set(role, modelRowId, now);
}
