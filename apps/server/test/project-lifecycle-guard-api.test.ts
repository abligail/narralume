import type { NarrativeModelClient } from "@narralume/narrative";
import {
  SqliteProjectRepository,
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

type App = Awaited<ReturnType<typeof buildApp>>;

const ENVIRONMENT = {
  NARRATIVE_LLM_API_KEY: "server-only-test-key",
  NARRATIVE_LLM_BASE_URL: "https://api.example.com/v1",
  NARRATIVE_LLM_MODEL: "test-model",
};

async function setup(model?: NarrativeModelClient) {
  const database = new NodeNarrativeDatabase();
  const app = await buildApp({
    config,
    database,
    environment: ENVIRONMENT,
    ...(model ? { narrativeModelClient: model } : {}),
    enableRunWorker: false,
    logger: false,
  });
  resources.push({ app, database });
  return { app, database };
}

interface ProjectDto {
  id: string;
  title: string;
  updatedAt: string;
}

async function createProject(app: App, title: string): Promise<ProjectDto> {
  const response = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: {
      requestId: globalThis.crypto.randomUUID(),
      title,
      premise: `${title}的前提。`,
    },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json() as ProjectDto;
}

async function createChapter(
  app: App,
  projectId: string,
  title: string,
): Promise<string> {
  const bible = (
    await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/story-bible`,
    })
  ).json() as { outline: { id: string }[] };
  const response = await app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/outline`,
    payload: {
      parentId: bible.outline[0]!.id,
      kind: "chapter",
      ordinal: 0,
      title,
    },
  });
  expect(response.statusCode, response.body).toBe(201);
  return (response.json() as { id: string }).id;
}

async function createChapterRun(
  app: App,
  projectId: string,
  chapterId: string,
  requestId: string,
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/runs/chapter`,
    payload: {
      requestId,
      targetOutlineNodeId: chapterId,
      policy: { minChapterCharacters: 100 },
      maxRevisionCycles: 0,
    },
  });
  expect(response.statusCode, response.body).toBe(202);
  return (response.json() as { run: { id: string } }).run.id;
}

async function advanceOnce(app: App, projectId: string, runId: string) {
  const response = await app.inject({
    method: "POST",
    url: `/api/runs/${runId}/advance`,
    payload: { projectId },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as {
    snapshot: {
      run: { status: string };
      steps: { kind: string; status: string; error: { code: string } | null }[];
    };
  };
}

describe("project lifecycle guards (M3)", () => {
  it("cancels active runs when the project is deleted (CR-77)", async () => {
    const { app } = await setup();
    const project = await createProject(app, "将被删除");
    const chapterId = await createChapter(app, project.id, "第一章");
    const runId = await createChapterRun(app, project.id, chapterId, "del-1");

    const archived = await app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}`,
      payload: {
        title: project.title,
        subtitle: null,
        premise: null,
        archived: true,
        expectedUpdatedAt: project.updatedAt,
      },
    });
    expect(archived.statusCode, archived.body).toBe(200);
    const archivedProject = archived.json() as ProjectDto;

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}`,
      payload: {
        confirmationTitle: project.title,
        expectedUpdatedAt: archivedProject.updatedAt,
      },
    });
    expect(deleted.statusCode, deleted.body).toBe(202);

    // 活动 Run 被直接置为 cancelled，而不是等 Worker 路由。
    const detail = await app.inject({
      method: "GET",
      url: `/api/runs/${runId}?projectId=${project.id}`,
    });
    expect(detail.statusCode, detail.body).toBe(200);
    expect((detail.json() as { run: { status: string } }).run.status).toBe(
      "cancelled",
    );
  });

  it("fails leased steps with project.not_found after deletion (CR-77)", async () => {
    const { app, database } = await setup();
    const project = await createProject(app, "绕过路由删除");
    const chapterId = await createChapter(app, project.id, "第一章");
    const runId = await createChapterRun(app, project.id, chapterId, "del-2");

    // 绕过删除路由直接软删除（模拟删除与 Worker 租约的竞态）。
    new SqliteProjectRepository(database).softDelete(
      project.id,
      project.updatedAt,
      new Date().toISOString(),
    );

    let snapshot = (await advanceOnce(app, project.id, runId)).snapshot;
    for (
      let index = 0;
      index < 10 && snapshot.run.status !== "failed";
      index += 1
    ) {
      snapshot = (await advanceOnce(app, project.id, runId)).snapshot;
    }
    expect(snapshot.run.status).toBe("failed");
    const step = snapshot.steps.find(
      (candidate) => candidate.status === "failed",
    );
    expect(step?.error?.code).toBe("project.not_found");

    // 删除后没有正文文档被写入。
    const documents = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/studio/documents`,
    });
    expect(documents.statusCode).toBe(404);
  });

  it("rejects project and run writes after soft deletion", async () => {
    const { app, database } = await setup();
    const project = await createProject(app, "删除后禁止写入");
    const chapterId = await createChapter(app, project.id, "第一章");
    const runId = await createChapterRun(
      app,
      project.id,
      chapterId,
      "del-guard",
    );

    new SqliteProjectRepository(database).softDelete(
      project.id,
      project.updatedAt,
      new Date().toISOString(),
    );

    const timeline = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/timeline`,
      payload: {
        title: "不应写入的事件",
        description: null,
        outlineNodeId: null,
        storyTimeStart: "第一日",
        storyTimeEnd: null,
        sequence: 1,
        participants: [],
        causes: [],
        visibility: "reader",
        sourceId: null,
      },
    });
    expect(timeline.statusCode, timeline.body).toBe(404);
    expect(timeline.json()).toMatchObject({
      error: { code: "project.not_found" },
    });
    expect(
      database.raw
        .prepare(
          "SELECT COUNT(*) AS count FROM timeline_events WHERE project_id = ?",
        )
        .get(project.id),
    ).toEqual({ count: 0 });

    const runAction = await app.inject({
      method: "POST",
      url: `/api/runs/${runId}/actions`,
      payload: { action: "cancel", projectId: project.id },
    });
    expect(runAction.statusCode, runAction.body).toBe(404);
    expect(runAction.json()).toMatchObject({
      error: { code: "run.not_found" },
    });
  });

  it("does not commit a chapter deleted while embedding is in flight (CR-77)", async () => {
    let markEmbeddingStarted!: () => void;
    const embeddingStarted = new Promise<void>((resolve) => {
      markEmbeddingStarted = resolve;
    });
    const model = chapterModel({
      beforeEmbed: async (purpose, signal) => {
        if (purpose !== "chapter-index") return;
        markEmbeddingStarted();
        await new Promise<never>((_resolve, reject) => {
          const abort = () =>
            reject(new DOMException("project deleted", "AbortError"));
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
      },
    });
    const { app, database } = await setup(model);
    const project = await createProject(app, "Embedding 期间删除");
    const chapterId = await createChapter(app, project.id, "第一章");
    const runId = await createChapterRun(
      app,
      project.id,
      chapterId,
      "del-embed",
    );
    const runs = new SqliteRunRepository(database);

    for (let index = 0; index < 30; index += 1) {
      const snapshot = runs.getSnapshot(runId);
      const commitIndex = snapshot.steps.findIndex(
        (step) => step.kind === "chapter.commit",
      );
      const commit = snapshot.steps[commitIndex];
      const priorStepsDone = snapshot.steps
        .slice(0, commitIndex)
        .every((step) => ["succeeded", "skipped"].includes(step.status));
      if (snapshot.run.status === "awaiting_user") {
        const detail = (
          await app.inject({
            method: "GET",
            url: `/api/runs/${runId}?projectId=${project.id}`,
          })
        ).json() as { availableActions: string[] };
        expect(detail.availableActions).toContain("accept_manuscript");
        const accepted = await app.inject({
          method: "POST",
          url: `/api/runs/${runId}/actions`,
          payload: { action: "accept_manuscript", projectId: project.id },
        });
        expect(accepted.statusCode, accepted.body).toBe(200);
      } else if (commit?.status === "pending" && priorStepsDone) {
        break;
      } else {
        await advanceOnce(app, project.id, runId);
      }
    }
    const ready = runs.getSnapshot(runId);
    const commitIndex = ready.steps.findIndex(
      (step) => step.kind === "chapter.commit",
    );
    expect(ready.steps[commitIndex]?.status).toBe("pending");
    expect(
      ready.steps.slice(0, commitIndex).map((step) => [step.kind, step.status]),
    ).toEqual(
      ready.steps
        .slice(0, commitIndex)
        .map((step) => [step.kind, expect.stringMatching(/succeeded|skipped/)]),
    );
    const versionCountBefore = countProjectDocumentVersions(
      database,
      project.id,
    );

    const awaitingApproval = await advanceOnce(app, project.id, runId);
    expect(awaitingApproval.snapshot.run.status).toBe("awaiting_user");
    const accepted = await app.inject({
      method: "POST",
      url: `/api/runs/${runId}/actions`,
      payload: { action: "accept_manuscript", projectId: project.id },
    });
    expect(accepted.statusCode, accepted.body).toBe(200);

    const committing = app.inject({
      method: "POST",
      url: `/api/runs/${runId}/advance`,
      payload: { projectId: project.id },
    });
    await within(embeddingStarted, "chapter commit did not start embedding");
    const archived = await app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}`,
      payload: {
        title: project.title,
        subtitle: null,
        premise: null,
        archived: true,
        expectedUpdatedAt: project.updatedAt,
      },
    });
    expect(archived.statusCode, archived.body).toBe(200);
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}`,
      payload: {
        confirmationTitle: project.title,
        expectedUpdatedAt: (archived.json() as ProjectDto).updatedAt,
      },
    });
    expect(deleted.statusCode, deleted.body).toBe(202);
    const interrupted = await within(
      committing,
      "chapter commit did not unwind after project deletion",
    );
    expect(interrupted.statusCode, interrupted.body).toBe(200);

    expect(runs.getRun(runId)?.status).toBe("cancelled");
    expect(countProjectDocumentVersions(database, project.id)).toBe(
      versionCountBefore,
    );
  });

  it("detects an active run beyond the 100-row display window (CR-80)", async () => {
    const { app, database } = await setup();
    const project = await createProject(app, "窗口之外");
    const chapterId = await createChapter(app, project.id, "第一章");
    const runs = new SqliteRunRepository(database);
    const now = new Date().toISOString();
    // 105 条已完成的旧 Run 把活动 Run 挤出 listRuns 的 100 条展示窗口。
    for (let index = 0; index < 105; index += 1) {
      runs.create({
        id: `history-${index}`,
        projectId: project.id,
        recipe: "chapter-production",
        recipeVersion: 1,
        mode: "chapter-gate",
        targetOutlineNodeId: chapterId,
        policy: {},
        budgetLimit: {
          maxCalls: 1,
          maxInputTokens: 1,
          maxOutputTokens: 1,
          maxCostUsd: null,
          maxWallTimeMs: 1,
        },
        steps: [],
        now,
      });
      runs.setRunStatus(`history-${index}`, "completed", now);
    }
    const active = runs.create({
      id: "active-beyond-window",
      projectId: project.id,
      recipe: "chapter-production",
      recipeVersion: 1,
      mode: "chapter-gate",
      targetOutlineNodeId: chapterId,
      policy: {},
      budgetLimit: {
        maxCalls: 1,
        maxInputTokens: 1,
        maxOutputTokens: 1,
        maxCostUsd: null,
        maxWallTimeMs: 1,
      },
      steps: [],
      now,
    });
    //  sanity：展示窗口确实看不到这条活动 Run
    expect(
      runs.listRuns(project.id).some((run) => run.id === active.run.id),
    ).toBe(false);

    const blocked = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/runs/chapter`,
      payload: {
        requestId: "blocked-1",
        targetOutlineNodeId: chapterId,
        policy: {},
        maxRevisionCycles: 0,
      },
    });
    expect(blocked.statusCode, blocked.body).toBe(409);
    expect(blocked.json()).toMatchObject({
      error: { code: "project.writing_task.active" },
    });
  });

  it("rejects run detail and control from another project (CR-98)", async () => {
    const { app } = await setup();
    const projectA = await createProject(app, "作品A");
    const projectB = await createProject(app, "作品B");
    const chapterA = await createChapter(app, projectA.id, "A第一章");
    const runId = await createChapterRun(app, projectA.id, chapterA, "own-1");

    const foreignDetail = await app.inject({
      method: "GET",
      url: `/api/runs/${runId}?projectId=${projectB.id}`,
    });
    expect(foreignDetail.statusCode, foreignDetail.body).toBe(404);
    expect(foreignDetail.json()).toMatchObject({
      error: { code: "run.not_found" },
    });

    const missingProject = await app.inject({
      method: "GET",
      url: `/api/runs/${runId}`,
    });
    expect(missingProject.statusCode).toBe(400);

    const foreignAction = await app.inject({
      method: "POST",
      url: `/api/runs/${runId}/actions`,
      payload: { action: "cancel", projectId: projectB.id },
    });
    expect(foreignAction.statusCode, foreignAction.body).toBe(404);

    const foreignStream = await app.inject({
      method: "POST",
      url: `/api/runs/${runId}/streams/discard`,
      payload: { projectId: projectB.id, stepId: "s-1", attempt: 1 },
    });
    expect(foreignStream.statusCode, foreignStream.body).toBe(404);

    // 归属正确时可以正常控制。
    const ownAction = await app.inject({
      method: "POST",
      url: `/api/runs/${runId}/actions`,
      payload: { action: "cancel", projectId: projectA.id },
    });
    expect(ownAction.statusCode, ownAction.body).toBe(200);
    expect(
      (ownAction.json() as { run: { cancelRequested: boolean } }).run
        .cancelRequested,
    ).toBe(true);
  });
});

function countProjectDocumentVersions(
  database: NodeNarrativeDatabase,
  projectId: string,
): number {
  const row = database.raw
    .prepare(
      `SELECT COUNT(*) AS count
       FROM document_versions v
       JOIN documents d ON d.id = v.document_id
       WHERE d.project_id = ?`,
    )
    .get(projectId) as { count: number };
  return row.count;
}

async function within<T>(promise: Promise<T>, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), 1_000);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function chapterModel(
  options: {
    beforeEmbed?: (purpose: string, signal: AbortSignal) => Promise<void>;
  } = {},
): NarrativeModelClient {
  const usage = {
    inputTokens: 10,
    outputTokens: 10,
    calls: 1,
    costUsd: 0,
    wallTimeMs: 1,
  };
  const manuscript =
    "Fog climbed the harbor steps before dawn. Lin checked the brass latch, counted three silent bells, and found a salt-stained letter beneath the threshold. The handwriting belonged to her missing father, but the date was tomorrow.\n\nShe crossed the empty gallery while rain tapped different rhythms on every window. At the tower door, a warm current carried the smell of burnt cedar upward. Lin opened the lock, entered the dark stairwell, and heard someone above whisper the name nobody in town remembered.";
  return {
    async text() {
      return { text: manuscript, usage };
    },
    async structured(_run, _step, purpose, _request, _contract, validate) {
      const value =
        purpose === "scene-plan"
          ? {
              chapterGoal: "Enter the tower",
              povEntityId: null,
              scenes: [
                {
                  title: "Dark lamp",
                  goal: "Reach the tower",
                  conflict: "The tide blocks the road",
                  turn: "The lamp goes dark",
                  outcome: "The keeper enters",
                  locationId: null,
                  participants: [],
                  targetCharacters: 300,
                },
              ],
              continuityRisks: [],
            }
          : purpose === "semantic-review"
            ? {
                summary: "The chapter goal is complete.",
                scores: {
                  continuity: 90,
                  pacing: 90,
                  character: 90,
                  prose: 90,
                  goal: 90,
                },
                issues: [],
              }
            : {
                summaryPoints: [
                  {
                    text: "The keeper entered the dark tower.",
                    basis: "observed",
                    evidenceParagraphs: [1],
                  },
                ],
                stateDelta: [],
                factCandidates: [],
                timelineCandidates: [],
                relationshipCandidates: [],
                foreshadowCandidates: [],
              };
      const checked = validate(value);
      if (!checked.success) throw new Error(checked.issues.join("; "));
      return { value: checked.data, usage, mode: "native", attempts: 1 };
    },
    hasEmbeddingAssignment: () => true,
    async embed(_run, _step, purpose, _request, signal) {
      await options.beforeEmbed?.(purpose, signal);
      return {
        vectors: [[1, 0, 0]],
        model: "test-embedding",
        modelId: "test-embedding",
        usage,
      };
    },
  } as NarrativeModelClient;
}
