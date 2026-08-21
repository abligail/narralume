import {
  CreateAutopilotSessionRequestSchema,
  extractPolicyUnknownFields,
} from "@narralume/contracts";
import type { NarrativeModelClient } from "@narralume/narrative";
import { SqliteRunRepository } from "@narralume/persistence";
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

describe("automation API", () => {
  it("lets the author reject or apply a high-impact steer and resumes the session (CR-95)", async () => {
    const { app } = await setup();
    const project = (
      await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          requestId: globalThis.crypto.randomUUID(),
          title: "创作指示裁定",
        },
      })
    ).json() as { id: string };
    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/autopilot/sessions`,
      payload: {
        requestId: "steer-decision-session",
        approvalMode: "continuous",
        targetChapters: 2,
        windowSize: 2,
      },
    });
    const sessionId = (created.json() as { id: string }).id;

    const submit = async (requestId: string, content: string) => {
      const response = await app.inject({
        method: "POST",
        url: `/api/autopilot/sessions/${sessionId}/steers`,
        payload: { requestId, content },
      });
      expect(response.statusCode, response.body).toBe(202);
      const steer = response.json() as {
        id: string;
        classificationRunId: string;
      };
      expect(await finishRun(app, project.id, steer.classificationRunId)).toBe(
        "completed",
      );
      await advanceSession(app, sessionId);
      expect((await getSession(app, sessionId)).session.status).toBe(
        "awaiting_user",
      );
      return steer;
    };

    const rejected = await submit(
      "steer-reject",
      "修改已确认设定，但这次先让我裁定。",
    );
    const reject = await app.inject({
      method: "POST",
      url: `/api/autopilot/sessions/${sessionId}/steers/${rejected.id}/decisions`,
      payload: { action: "reject" },
    });
    expect(reject.statusCode, reject.body).toBe(200);
    expect(reject.json()).toMatchObject({
      steer: { id: rejected.id, status: "rejected" },
      detail: { session: { status: "running" } },
    });

    const applied = await submit(
      "steer-apply",
      "修改已确认设定，并按这个方向重排后续章节。",
    );
    const apply = await app.inject({
      method: "POST",
      url: `/api/autopilot/sessions/${sessionId}/steers/${applied.id}/decisions`,
      payload: { action: "apply" },
    });
    expect(apply.statusCode, apply.body).toBe(200);
    expect(apply.json()).toMatchObject({
      steer: { id: applied.id, status: "applied" },
      detail: {
        session: {
          status: "running",
          replanRequested: true,
          activeNotes: ["修改已确认设定，并按这个方向重排后续章节。"],
          lastError: null,
        },
      },
    });

    const duplicate = await app.inject({
      method: "POST",
      url: `/api/autopilot/sessions/${sessionId}/steers/${applied.id}/decisions`,
      payload: { action: "apply" },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({
      error: { code: "autopilot.steer.not_decidable" },
    });
  });

  it("rejects new steers after a session reaches a terminal state (CR-91)", async () => {
    const { app } = await setup();
    const project = (
      await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          requestId: globalThis.crypto.randomUUID(),
          title: "终态指示门禁",
        },
      })
    ).json() as { id: string };
    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/autopilot/sessions`,
      payload: {
        requestId: "terminal-steer-session",
        approvalMode: "continuous",
        targetChapters: 1,
        windowSize: 1,
      },
    });
    expect(created.statusCode, created.body).toBe(202);
    const sessionId = (created.json() as { id: string }).id;
    const cancelled = await app.inject({
      method: "POST",
      url: `/api/autopilot/sessions/${sessionId}/actions`,
      payload: { action: "cancel" },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    await advanceSession(app, sessionId);
    expect((await getSession(app, sessionId)).session.status).toBe("cancelled");

    const steer = await app.inject({
      method: "POST",
      url: `/api/autopilot/sessions/${sessionId}/steers`,
      payload: {
        requestId: "terminal-steer-request",
        content: "下一章增加一封匿名信。",
      },
    });
    expect(steer.statusCode, steer.body).toBe(409);
    expect(steer.json()).toMatchObject({
      error: { code: "autopilot.steer.session_terminal" },
    });
  });

  it("settles a cancelled steer classification as not applied (CR-93)", async () => {
    const { app } = await setup();
    const project = (
      await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          requestId: globalThis.crypto.randomUUID(),
          title: "取消指示判断",
          premise: "取消分类后不能永久停在等待状态。",
        },
      })
    ).json() as { id: string };
    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/autopilot/sessions`,
      payload: {
        requestId: "cancelled-steer-session",
        approvalMode: "continuous",
        targetChapters: 2,
        windowSize: 2,
      },
    });
    expect(created.statusCode, created.body).toBe(202);
    const sessionId = (created.json() as { id: string }).id;
    const steerResponse = await app.inject({
      method: "POST",
      url: `/api/autopilot/sessions/${sessionId}/steers`,
      payload: {
        requestId: "cancelled-steer",
        content: "下一章改成雨夜追逐。",
      },
    });
    expect(steerResponse.statusCode, steerResponse.body).toBe(202);
    const steer = steerResponse.json() as {
      id: string;
      classificationRunId: string;
    };
    const cancel = await app.inject({
      method: "POST",
      url: `/api/runs/${steer.classificationRunId}/actions`,
      payload: { projectId: project.id, action: "cancel" },
    });
    expect(cancel.statusCode, cancel.body).toBe(200);
    expect(await finishRun(app, project.id, steer.classificationRunId)).toBe(
      "cancelled",
    );

    const detail = await getSession(app, sessionId);
    expect(detail.steers).toEqual([
      expect.objectContaining({
        id: steer.id,
        classification: null,
        status: "rejected",
        rationale:
          "Impact assessment was cancelled, so this steering instruction was not applied",
      }),
    ]);
  });

  it("does not classify a steer when cancellation lands during the model call", async () => {
    const context: {
      database?: NodeNarrativeDatabase;
      classificationRunId: string;
    } = { classificationRunId: "" };
    const model = automationModel({
      beforeStructured(purpose) {
        if (purpose !== "steer-classification") return;
        new SqliteRunRepository(context.database!).requestCancel(
          context.classificationRunId,
          "2026-08-19T00:00:00.000Z",
        );
      },
    });
    const setupResult = await setup(model);
    context.database = setupResult.database;
    const { app } = setupResult;
    const project = (
      await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          requestId: globalThis.crypto.randomUUID(),
          title: "分类提交边界",
        },
      })
    ).json() as { id: string };
    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/autopilot/sessions`,
      payload: {
        requestId: "classification-commit-guard-session",
        approvalMode: "continuous",
        targetChapters: 2,
        windowSize: 2,
      },
    });
    const sessionId = (created.json() as { id: string }).id;
    const steerResponse = await app.inject({
      method: "POST",
      url: `/api/autopilot/sessions/${sessionId}/steers`,
      payload: {
        requestId: "classification-commit-guard-steer",
        content: "下一章改成雨夜追逐。",
      },
    });
    const steer = steerResponse.json() as {
      id: string;
      classificationRunId: string;
    };
    context.classificationRunId = steer.classificationRunId;

    expect(await finishRun(app, project.id, context.classificationRunId)).toBe(
      "cancelled",
    );
    expect((await getSession(app, sessionId)).steers).toEqual([
      expect.objectContaining({
        id: steer.id,
        classification: null,
        status: "rejected",
      }),
    ]);
  });

  it("replays session creation and keeps one active writing session per project", async () => {
    const { app } = await setup();
    const project = (
      await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          requestId: globalThis.crypto.randomUUID(),
          title: "幂等航线",
          premise: "重复点击不会制造两条航线。",
        },
      })
    ).json() as { id: string };
    const payload = {
      requestId: "autopilot-create-idempotency",
      approvalMode: "continuous",
      targetChapters: 2,
      windowSize: 2,
    };

    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/autopilot/sessions`,
      payload,
    });
    const replay = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/autopilot/sessions`,
      payload,
    });
    expect(created.statusCode, created.body).toBe(202);
    expect(replay.statusCode, replay.body).toBe(202);
    expect(replay.json()).toMatchObject({
      id: created.json().id,
      idempotentReplay: true,
    });

    const changedReplay = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/autopilot/sessions`,
      payload: { ...payload, targetChapters: 3 },
    });
    expect(changedReplay.statusCode).toBe(409);
    expect(changedReplay.json()).toMatchObject({
      error: { code: "autopilot.session.idempotency_conflict" },
    });

    const duplicate = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/autopilot/sessions`,
      payload: { ...payload, requestId: "another-autopilot-request" },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({
      error: { code: "autopilot.session.active" },
    });
  });

  it("creates a project and its foundation task exactly once per requestId", async () => {
    const { app, database } = await setup();
    const payload = {
      requestId: "create-foundation-1",
      title: "潮汐档案",
      braindump: "灯灯旅行",
      preferences: {
        genre: "悬疑奇幻",
        audience: null,
        tone: "克制",
        targetChapters: 24,
        wordsPerChapter: 2_500,
        volumes: 1,
      },
    };

    const created = await app.inject({
      method: "POST",
      url: "/api/projects/with-foundation",
      payload,
    });
    expect(created.statusCode, created.body).toBe(202);
    const first = created.json() as {
      project: { id: string; phase: string };
      task: { run: { id: string; projectId: string } };
      idempotentReplay: boolean;
    };
    expect(first).toMatchObject({
      project: { phase: "foundation" },
      idempotentReplay: false,
    });
    expect(first.task.run.projectId).toBe(first.project.id);

    const replayed = await app.inject({
      method: "POST",
      url: "/api/projects/with-foundation",
      payload,
    });
    expect(replayed.statusCode, replayed.body).toBe(202);
    expect(replayed.json()).toMatchObject({
      project: { id: first.project.id },
      task: { run: { id: first.task.run.id } },
      idempotentReplay: true,
    });
    expect(
      (
        database.raw
          .prepare("SELECT COUNT(*) AS count FROM projects")
          .get() as {
          count: number;
        }
      ).count,
    ).toBe(1);
    expect(
      (
        database.raw.prepare("SELECT COUNT(*) AS count FROM runs").get() as {
          count: number;
        }
      ).count,
    ).toBe(1);

    const conflict = await app.inject({
      method: "POST",
      url: "/api/projects/with-foundation",
      payload: { ...payload, title: "另一本书" },
    });
    expect(conflict.statusCode, conflict.body).toBe(409);
    expect(conflict.json()).toMatchObject({
      error: { code: "project_foundation.idempotency_conflict" },
    });
  });

  it("fails a rolling outline commit when the outline changed after generation (CR-105)", async () => {
    const { app } = await setup();
    const project = (
      await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          requestId: globalThis.crypto.randomUUID(),
          title: "滚动大纲并发",
          premise: "后台规划不能覆盖人工编辑。",
        },
      })
    ).json() as { id: string };
    const projectId = project.id;

    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/autopilot/sessions`,
      payload: {
        requestId: "rolling-baseline-guard",
        approvalMode: "continuous",
        targetChapters: 2,
        windowSize: 1,
      },
    });
    expect(created.statusCode, created.body).toBe(202);
    const sessionId = (created.json() as { id: string }).id;

    await advanceSession(app, sessionId);
    const detail = await getSession(app, sessionId);
    expect(detail.session.status).toBe("planning");
    const planningRunId = detail.session.currentRunId!;

    // 只完成 outline.generate，让 outline.commit 悬停（相当于 Worker 延迟提交）。
    await app.inject({
      method: "POST",
      url: `/api/runs/${planningRunId}/advance`,
      payload: { projectId },
    });
    const generated = (
      await app.inject({
        method: "GET",
        url: `/api/runs/${planningRunId}?projectId=${projectId}`,
      })
    ).json();
    expect(generated.snapshot?.run?.status ?? generated.run?.status).not.toBe(
      "failed",
    );

    // 作者在生成后人工修改了大纲。
    const bible = (
      await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/story-bible`,
      })
    ).json() as {
      outline: { id: string; kind: string; title: string; updatedAt: string }[];
    };
    const book = bible.outline.find((node) => node.kind === "book")!;
    const renamed = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/outline/${book.id}`,
      payload: {
        title: "作者改过的全书标题",
        expectedUpdatedAt: book.updatedAt,
      },
    });
    expect(renamed.statusCode, renamed.body).toBe(200);

    // outline.commit 必须因基线漂移失败，而不是覆盖人工修改。
    expect(await finishRun(app, projectId, planningRunId)).toBe("failed");
    const bibleAfter = (
      await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/story-bible`,
      })
    ).json() as { outline: { kind: string; title: string }[] };
    expect(bibleAfter.outline.find((node) => node.kind === "book")!.title).toBe(
      "作者改过的全书标题",
    );
    expect(bibleAfter.outline.some((node) => node.title === "失灯弧")).toBe(
      false,
    );
  });

  it("stages/adopts a foundation and completes a recoverable multi-chapter voyage", async () => {
    const { app } = await setup();
    const projectResponse = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        requestId: globalThis.crypto.randomUUID(),
        title: "潮汐灯塔",
        premise: "灯灭时港口遗忘一个人。",
      },
    });
    const projectId = (projectResponse.json() as { id: string }).id;

    const foundation = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/foundation/generate`,
      payload: {
        requestId: "foundation-main",
        braindump: "灯灯旅行",
      },
    });
    expect(foundation.statusCode, foundation.body).toBe(202);
    expect(foundation.json()).toMatchObject({
      origin: { surface: "autopilot" },
      availableActions: ["pause", "cancel"],
    });
    const foundationRunId = (foundation.json() as { run: { id: string } }).run
      .id;
    const foundationReplay = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/foundation/generate`,
      payload: {
        requestId: "foundation-main",
        braindump: "灯灯旅行",
      },
    });
    expect(foundationReplay.statusCode, foundationReplay.body).toBe(202);
    expect((foundationReplay.json() as { run: { id: string } }).run.id).toBe(
      foundationRunId,
    );
    const foundationConflict = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/foundation/generate`,
      payload: {
        requestId: "foundation-main",
        braindump: "同一个键不能改成另一份脑暴",
      },
    });
    expect(foundationConflict.statusCode).toBe(409);
    expect(foundationConflict.json()).toMatchObject({
      error: { code: "foundation.idempotency_conflict" },
    });
    const activeOverview = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/overview`,
    });
    expect(activeOverview.statusCode, activeOverview.body).toBe(200);
    expect(activeOverview.json()).toMatchObject({
      activeTask: {
        kind: "foundation",
        id: foundationRunId,
        targetChapter: null,
        origin: { surface: "autopilot" },
      },
    });
    expect(await finishRun(app, projectId, foundationRunId)).toBe("completed");
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/runs/${foundationRunId}?projectId=${projectId}`,
        })
      ).json(),
    ).toMatchObject({
      result: {
        foundationCandidateSetId: `${foundationRunId}:foundation-set`,
      },
    });

    const candidateResponse = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/foundation/candidates`,
    });
    expect(candidateResponse.statusCode).toBe(200);
    const candidateSets = candidateResponse.json() as {
      set: { id: string };
      candidates: unknown[];
    }[];
    expect(candidateSets[0]?.candidates).toHaveLength(4);
    const adopted = await app.inject({
      method: "POST",
      url: `/api/candidate-sets/${candidateSets[0]!.set.id}/actions`,
      payload: { action: "adopt-all" },
    });
    expect(adopted.statusCode, adopted.body).toBe(200);
    expect(adopted.json()).toMatchObject({ set: { status: "adopted" } });
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/compass`,
        })
      ).json(),
    ).toMatchObject({ corePromise: "每次遗忘都留下代价" });

    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/autopilot/sessions`,
      payload: {
        requestId: "continuous-session",
        approvalMode: "continuous",
        targetChapters: 2,
        windowSize: 2,
        maxRevisionCycles: 0,
        chapterPolicy: {
          contextWindow: 8_000,
          draftMaxOutputTokens: 2_000,
          reviewMaxOutputTokens: 2_000,
          settlementMaxOutputTokens: 2_000,
          minChapterCharacters: 100,
        },
      },
    });
    expect(created.statusCode, created.body).toBe(202);
    const sessionId = (created.json() as { id: string }).id;

    await advanceSession(app, sessionId);
    let detail = await getSession(app, sessionId);
    expect(detail.session.status).toBe("planning");
    const planningRunId = detail.session.currentRunId!;

    await app.inject({
      method: "POST",
      url: `/api/autopilot/sessions/${sessionId}/actions`,
      payload: { action: "pause" },
    });
    await advanceSession(app, sessionId);
    await app.inject({
      method: "POST",
      url: `/api/runs/${planningRunId}/advance`,
      payload: { projectId },
    });
    await advanceSession(app, sessionId);
    detail = await getSession(app, sessionId);
    expect(detail.session.status).toBe("paused");
    expect(
      (await advanceSession(app, sessionId)) as { processed: boolean },
    ).toMatchObject({ processed: false });
    const resumed = await app.inject({
      method: "POST",
      url: `/api/autopilot/sessions/${sessionId}/actions`,
      payload: { action: "resume" },
    });
    expect(resumed.statusCode, resumed.body).toBe(200);

    const steer = await app.inject({
      method: "POST",
      url: `/api/autopilot/sessions/${sessionId}/steers`,
      payload: {
        requestId: "steer-next-chapter",
        content: "下一章让林昼主动隐瞒真相。",
      },
    });
    expect(steer.statusCode, steer.body).toBe(202);
    const steerRunId = (steer.json() as { classificationRunId: string })
      .classificationRunId;
    const steerReplay = await app.inject({
      method: "POST",
      url: `/api/autopilot/sessions/${sessionId}/steers`,
      payload: {
        requestId: "steer-next-chapter",
        content: "下一章让林昼主动隐瞒真相。",
      },
    });
    expect(steerReplay.statusCode, steerReplay.body).toBe(202);
    expect(steerReplay.json()).toMatchObject({
      id: (steer.json() as { id: string }).id,
      classificationRunId: steerRunId,
    });
    const steerConflict = await app.inject({
      method: "POST",
      url: `/api/autopilot/sessions/${sessionId}/steers`,
      payload: {
        requestId: "steer-next-chapter",
        content: "同一个键不能改成另一条指示。",
      },
    });
    expect(steerConflict.statusCode).toBe(409);
    expect(steerConflict.json()).toMatchObject({
      error: { code: "autopilot.steer.idempotency_conflict" },
    });
    expect(await finishRun(app, projectId, steerRunId)).toBe("completed");

    expect(await finishRun(app, projectId, planningRunId)).toBe("completed");
    await advanceSession(app, sessionId);
    await advanceSession(app, sessionId);
    await advanceSession(app, sessionId);
    detail = await getSession(app, sessionId);
    const interruptedChapterRunId = detail.session.currentRunId!;
    expect(detail.links.at(-1)).toMatchObject({ role: "chapter" });

    const immediateSteer = await app.inject({
      method: "POST",
      url: `/api/autopilot/sessions/${sessionId}/steers`,
      payload: {
        requestId: "steer-stop-current",
        content: "立即中止当前草稿，让林昼先藏起灯油记录。",
      },
    });
    expect(immediateSteer.statusCode, immediateSteer.body).toBe(202);
    const immediateSteerRunId = (
      immediateSteer.json() as { classificationRunId: string }
    ).classificationRunId;
    expect(await finishRun(app, projectId, immediateSteerRunId)).toBe(
      "completed",
    );
    await advanceSession(app, sessionId);
    await app.inject({
      method: "POST",
      url: `/api/runs/${interruptedChapterRunId}/advance`,
      payload: { projectId },
    });
    await advanceSession(app, sessionId);

    const interruptedBible = (
      await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/story-bible`,
      })
    ).json() as { outline: { kind: string; status: string }[] };
    expect(
      interruptedBible.outline.find(
        (node) => node.kind === "chapter" && node.status === "planned",
      ),
    ).toBeDefined();

    for (let index = 0; index < 160; index += 1) {
      detail = await getSession(app, sessionId);
      if (
        ["completed", "failed", "cancelled"].includes(detail.session.status)
      ) {
        break;
      }
      for (const run of detail.runs.filter(
        (candidate) =>
          ![
            "completed",
            "failed",
            "cancelled",
            "paused",
            "awaiting_user",
          ].includes(candidate.status),
      )) {
        await app.inject({
          method: "POST",
          url: `/api/runs/${run.id}/advance`,
          payload: { projectId },
        });
      }
      await advanceSession(app, sessionId);
    }

    detail = await getSession(app, sessionId);
    expect(detail.session).toMatchObject({
      status: "completed",
      completedChapters: 2,
    });
    expect(detail.links.map((link) => link.role)).toEqual([
      "rolling-plan",
      "chapter",
      "chapter",
      "chapter",
    ]);
    expect(detail.steers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          classification: "next_scene",
          status: "applied",
        }),
        expect.objectContaining({
          classification: "immediate_current",
          status: "applied",
        }),
      ]),
    );
    expect(detail.reviews).toEqual([]);
    expect(detail.session.chapterPolicy).toMatchObject({
      qualityPreset: "standard",
      contextWindow: 8_000,
      draftMaxOutputTokens: 2_000,
      reviewMaxOutputTokens: 2_000,
      settlementMaxOutputTokens: 2_000,
      planningMaxOutputTokens: 24_000,
      minChapterCharacters: 100,
    });
    const runsById = new Map(detail.runs.map((run) => [run.id, run]));
    const linkedRun = (role: string) => {
      const link = detail.links.find((candidate) => candidate.role === role);
      return link ? runsById.get(link.runId) : undefined;
    };
    expect(linkedRun("rolling-plan")?.policy).toMatchObject({
      sessionId,
      // 显式继承 effectivePolicy.planningMaxOutputTokens 默认值，
      // 不再由 reviewMaxOutputTokens(2_000) 推导（旧逻辑会得到 6_000）
      planningMaxOutputTokens: 24_000,
    });
    expect(linkedRun("closing-review")).toBeUndefined();
    const chapterRuns = detail.links
      .filter((link) => link.role === "chapter")
      .map((link) => runsById.get(link.runId));
    expect(chapterRuns).toHaveLength(3);
    for (const run of chapterRuns) {
      expect(run?.policy).toMatchObject({
        autopilotSessionId: sessionId,
        chapterApproved: true,
        qualityPreset: "standard",
        contextWindow: 8_000,
        draftMaxOutputTokens: 2_000,
        reviewMaxOutputTokens: 2_000,
      });
    }
    expect(
      chapterRuns.some((run) =>
        ((run?.policy.steerNotes as string[] | undefined) ?? []).includes(
          "立即中止当前草稿，让林昼先藏起灯油记录。",
        ),
      ),
    ).toBe(true);
    const bible = (
      await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/story-bible`,
      })
    ).json() as { outline: { kind: string; status: string }[] };
    expect(
      bible.outline.filter(
        (node) => node.kind === "chapter" && node.status === "committed",
      ),
    ).toHaveLength(2);
  });

  it("captures the foundation baseline before model generation (CR-54)", async () => {
    let releaseGeneration!: () => void;
    let markGenerationStarted!: () => void;
    const generationStarted = new Promise<void>((resolve) => {
      markGenerationStarted = resolve;
    });
    const generationGate = new Promise<void>((resolve) => {
      releaseGeneration = resolve;
    });
    const { app } = await setup(
      automationModel({
        beforeStructured: async (purpose) => {
          if (purpose !== "book-foundation") return;
          markGenerationStarted();
          await generationGate;
        },
      }),
    );
    const projectResponse = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        requestId: globalThis.crypto.randomUUID(),
        title: "生成期间修改基线",
      },
    });
    const projectId = (projectResponse.json() as { id: string }).id;
    const bibleBefore = (
      await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/story-bible`,
      })
    ).json() as { intent: { updatedAt: string } | null };
    const compassBeforeResponse = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/compass`,
    });
    const compassVersionBefore =
      compassBeforeResponse.statusCode === 200
        ? (compassBeforeResponse.json().version as number)
        : null;
    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/foundation/generate`,
      payload: {
        requestId: "foundation-baseline-race",
        braindump: "旧候选不应覆盖生成期间的人工修改",
      },
    });
    expect(created.statusCode, created.body).toBe(202);
    const runId = (created.json() as { run: { id: string } }).run.id;

    const generating = app.inject({
      method: "POST",
      url: `/api/runs/${runId}/advance`,
      payload: { projectId },
    });
    await generationStarted;

    const manualIntent = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/intent`,
      payload: {
        currentFocus: "作者在生成期间修改的焦点",
        expectedUpdatedAt: bibleBefore.intent?.updatedAt ?? null,
      },
    });
    expect(manualIntent.statusCode, manualIntent.body).toBe(200);
    const manualCompass = await app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/compass`,
      payload: {
        corePromise: "作者在生成期间修改的指南针",
        endingDirection: null,
        longLines: [],
        themeQuestions: [],
        target: { chapters: 12, wordsPerChapter: 2000, volumes: 1 },
        constraints: [],
        expectedVersion: compassVersionBefore,
      },
    });
    expect(manualCompass.statusCode, manualCompass.body).toBe(200);

    releaseGeneration();
    const generated = await generating;
    expect(generated.statusCode, generated.body).toBe(200);
    const staged = await app.inject({
      method: "POST",
      url: `/api/runs/${runId}/advance`,
      payload: { projectId },
    });
    expect(staged.statusCode, staged.body).toBe(200);

    const candidateSets = (
      await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/foundation/candidates`,
      })
    ).json() as Array<{
      candidates: Array<{
        id: string;
        kind: string;
        payload: { baseline?: Record<string, unknown> };
      }>;
    }>;
    const intentCandidate = candidateSets[0]!.candidates.find(
      (candidate) => candidate.kind === "intent",
    )!;
    const compassCandidate = candidateSets[0]!.candidates.find(
      (candidate) => candidate.kind === "compass",
    )!;
    expect(intentCandidate.payload.baseline).toEqual({
      intentUpdatedAt: bibleBefore.intent?.updatedAt ?? null,
    });
    expect(compassCandidate.payload.baseline).toEqual({
      compassVersion: compassVersionBefore,
    });

    const adopt = (candidateId: string) =>
      app.inject({
        method: "POST",
        url: `/api/candidates/${candidateId}/actions`,
        payload: { action: "adopt" },
      });
    const blockedIntent = await adopt(intentCandidate.id);
    expect(blockedIntent.statusCode, blockedIntent.body).toBe(409);
    expect(blockedIntent.json()).toMatchObject({
      error: { code: "foundation_candidate.intent.stale" },
    });
    const blockedCompass = await adopt(compassCandidate.id);
    expect(blockedCompass.statusCode, blockedCompass.body).toBe(409);
    expect(blockedCompass.json()).toMatchObject({
      error: { code: "foundation_candidate.compass.stale" },
    });
  });

  it("keeps planning scale in the compass instead of treating it as author intent", async () => {
    let foundationRequest: unknown = null;
    const { app, database } = await setup(
      automationModel({
        beforeStructured: (purpose, request) => {
          if (purpose === "book-foundation") foundationRequest = request;
        },
      }),
    );
    const projectResponse = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        requestId: globalThis.crypto.randomUUID(),
        title: "规划规模归位",
      },
    });
    const projectId = (projectResponse.json() as { id: string }).id;
    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/foundation/generate`,
      payload: {
        requestId: "foundation-planning-scale",
        braindump: "一个守灯人追查失踪名字的悬疑故事。",
        preferences: {
          genre: "悬疑幻想",
          audience: null,
          tone: "克制",
          targetChapters: 18,
          wordsPerChapter: 3_200,
          volumes: 2,
        },
      },
    });
    expect(created.statusCode, created.body).toBe(202);
    const runId = (created.json() as { run: { id: string } }).run.id;
    const advanced = await app.inject({
      method: "POST",
      url: `/api/runs/${runId}/advance`,
      payload: { projectId },
    });
    expect(advanced.statusCode, advanced.body).toBe(200);

    const request = foundationRequest as {
      instructions: string;
      messages: { content: string }[];
    };
    expect(request.instructions).toContain(
      "规划规模只属于故事指南针的 compass.target，不属于作者意图",
    );
    expect(request.messages[0]!.content).toContain(
      "规划规模（仅写入故事指南针 compass.target）",
    );
    const artifact = new SqliteRunRepository(database)
      .getSnapshot(runId)
      .steps.find((step) => step.kind === "foundation.generate")
      ?.outputArtifact as {
      compass?: { target?: Record<string, number> };
    } | null;
    expect(artifact?.compass?.target).toEqual({
      chapters: 18,
      wordsPerChapter: 3_200,
      volumes: 2,
    });
  });

  it("persists the normalized effectivePolicy and inherits it in child runs", async () => {
    const { app } = await setup();
    const projectResponse = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        requestId: globalThis.crypto.randomUUID(),
        title: "策略继承",
        premise: "验证自动驾驶策略继承。",
      },
    });
    const projectId = (projectResponse.json() as { id: string }).id;

    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/autopilot/sessions`,
      payload: {
        requestId: "policy-session",
        approvalMode: "continuous",
        targetChapters: 1,
        windowSize: 1,
        maxRevisionCycles: 0,
        chapterPolicy: {
          qualityPreset: "fast",
          contextWindow: 16_000,
          draftMaxOutputTokens: 1_800,
          reviewMaxOutputTokens: 2_200,
          planningMaxOutputTokens: 5_500,
          minChapterCharacters: 180,
        },
      },
    });
    expect(created.statusCode, created.body).toBe(202);
    const createdSession = created.json() as {
      id: string;
      chapterPolicy: Record<string, unknown>;
    };
    const sessionId = createdSession.id;
    expect(createdSession.chapterPolicy).toMatchObject({
      qualityPreset: "fast",
      maxRevisionCycles: 0,
      maxRepairAttempts: 0,
      semanticReview: true,
      contextWindow: 16_000,
      draftMaxOutputTokens: 1_800,
      reviewMaxOutputTokens: 2_200,
      planningMaxOutputTokens: 5_500,
      settlementMaxOutputTokens: 16_000,
      minChapterCharacters: 180,
      requestStartTimeoutMs: 120_000,
      runDeadlineMs: 1_800_000,
    });

    const listed = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/autopilot/sessions`,
    });
    expect(listed.statusCode).toBe(200);
    expect(
      (listed.json() as { chapterPolicy: unknown }[]).map(
        (session) => session.chapterPolicy,
      ),
    ).toEqual([createdSession.chapterPolicy]);

    let detail = await getSession(app, sessionId);
    expect(detail.session.chapterPolicy).toEqual(createdSession.chapterPolicy);

    await advanceSession(app, sessionId);
    detail = await getSession(app, sessionId);
    const planningLink = detail.links.find(
      (link) => link.role === "rolling-plan",
    );
    expect(planningLink).toBeDefined();
    const planningRun = detail.runs.find(
      (run) => run.id === planningLink!.runId,
    );
    expect(planningRun?.policy).toMatchObject({
      sessionId,
      qualityPreset: "fast",
      draftMaxOutputTokens: 1_800,
      // 显式继承 planningMaxOutputTokens，不由 reviewMaxOutputTokens(2_200) 推导
      planningMaxOutputTokens: 5_500,
    });

    const steer = await app.inject({
      method: "POST",
      url: `/api/autopilot/sessions/${sessionId}/steers`,
      payload: {
        requestId: "steer-policy-inheritance",
        content: "下一章收紧节奏。",
      },
    });
    expect(steer.statusCode, steer.body).toBe(202);
    const steerId = (steer.json() as { id: string }).id;
    const steerRunId = (steer.json() as { classificationRunId: string })
      .classificationRunId;
    const steerRunResponse = await app.inject({
      method: "GET",
      url: `/api/runs/${steerRunId}?projectId=${projectId}`,
    });
    expect(steerRunResponse.statusCode, steerRunResponse.body).toBe(200);
    const steerRun = (
      steerRunResponse.json() as {
        run: {
          policy: Record<string, unknown>;
        };
      }
    ).run;
    expect(steerRun.policy).toMatchObject({
      steerId,
      qualityPreset: "fast",
      planningMaxOutputTokens: 5_500,
    });

    expect(await finishRun(app, projectId, planningLink!.runId)).toBe(
      "completed",
    );
    for (let index = 0; index < 5; index += 1) {
      detail = await getSession(app, sessionId);
      if (detail.links.some((link) => link.role === "chapter")) break;
      await advanceSession(app, sessionId);
    }
    const chapterLink = detail.links.find((link) => link.role === "chapter");
    expect(chapterLink).toBeDefined();
    const chapterRun = detail.runs.find((run) => run.id === chapterLink!.runId);
    expect(chapterRun?.policy).toMatchObject({
      autopilotSessionId: sessionId,
      chapterApproved: true,
      steerNotes: [],
      qualityPreset: "fast",
      contextWindow: 16_000,
      draftMaxOutputTokens: 1_800,
      maxRevisionCycles: 0,
    });
  });

  it("rejects unknown chapterPolicy fields via the strict shared schema", () => {
    const result = CreateAutopilotSessionRequestSchema.safeParse({
      chapterPolicy: { modelRequestTimeoutMs: 45_000 },
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(
      result.error.issues.some(
        (issue) =>
          issue.code === "unrecognized_keys" &&
          issue.path.join(".") === "chapterPolicy",
      ),
    ).toBe(true);
    expect(extractPolicyUnknownFields(result.error)).toEqual([
      "modelRequestTimeoutMs",
    ]);
  });

  it("parks the session in awaiting_user when a child run fails fatally", async () => {
    const { app } = await setup(fatalModel());
    const projectResponse = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        requestId: globalThis.crypto.randomUUID(),
        title: "鉴权泊车",
        premise: "子运行致命错误时会话泊车等待处理。",
      },
    });
    const projectId = (projectResponse.json() as { id: string }).id;

    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/autopilot/sessions`,
      payload: {
        requestId: "fatal-session",
        approvalMode: "continuous",
        targetChapters: 2,
        windowSize: 2,
        maxRevisionCycles: 0,
      },
    });
    expect(created.statusCode, created.body).toBe(202);
    const sessionId = (created.json() as { id: string }).id;

    await advanceSession(app, sessionId);
    let detail = await getSession(app, sessionId);
    expect(detail.session.status).toBe("planning");
    const planningRunId = detail.session.currentRunId!;

    // The planning run's first step fails with a fatal authentication error;
    // the harness short-circuits the run instead of retrying it.
    expect(await finishRun(app, projectId, planningRunId)).toBe("failed");

    await advanceSession(app, sessionId);
    detail = await getSession(app, sessionId);
    expect(detail.session.status).toBe("awaiting_user");
    expect(detail.session.lastError).toMatchObject({
      code: "child.fatal",
      runId: planningRunId,
      category: "authentication",
    });
    expect(detail.stopReason).toBe("child.fatal");
    expect(detail.availableActions).toEqual([
      "retry-current",
      "skip-chapter",
      "replan",
      "stop",
    ]);

    // Parked sessions neither advance nor spawn further child runs.
    const runCount = detail.runs.length;
    expect(await advanceSession(app, sessionId)).toMatchObject({
      processed: false,
    });
    detail = await getSession(app, sessionId);
    expect(detail.session.status).toBe("awaiting_user");
    expect(detail.runs).toHaveLength(runCount);

    const retried = await app.inject({
      method: "POST",
      url: `/api/autopilot/sessions/${sessionId}/resolutions`,
      payload: { action: "retry-current" },
    });
    expect(retried.statusCode, retried.body).toBe(200);
    expect(retried.json()).toMatchObject({
      session: { status: "running", lastError: null },
    });
    expect(await advanceSession(app, sessionId)).toMatchObject({
      processed: true,
    });
    detail = await getSession(app, sessionId);
    expect(detail.session.status).toBe("planning");
    expect(detail.session.currentRunId).not.toBe(planningRunId);
    expect(detail.runs).toHaveLength(runCount + 1);
  });

  it("replaces a per-chapter candidate with an idempotent revision child", async () => {
    const { app } = await setup();
    const project = (
      await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          requestId: globalThis.crypto.randomUUID(),
          title: "修订航线",
          premise: "验证章节候选的任务接续。",
        },
      })
    ).json() as { id: string };
    const bible = (
      await app.inject({
        method: "GET",
        url: `/api/projects/${project.id}/story-bible`,
      })
    ).json() as { outline: Array<{ id: string; kind: string }> };
    const rootId = bible.outline.find((node) => node.kind === "book")!.id;
    const chapter = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/outline`,
      payload: {
        parentId: rootId,
        kind: "chapter",
        ordinal: 0,
        title: "第一章",
        summary: "灯塔熄灭，记忆出现缺口。",
        goal: "发现遗忘规则",
        conflict: "父亲否认失踪者存在",
        metadata: {},
      },
    });
    expect(chapter.statusCode, chapter.body).toBe(201);
    const session = (
      await app.inject({
        method: "POST",
        url: `/api/projects/${project.id}/autopilot/sessions`,
        payload: {
          requestId: "revision-session",
          approvalMode: "per_chapter",
          targetChapters: 1,
          windowSize: 1,
          maxRevisionCycles: 0,
          chapterPolicy: { minChapterCharacters: 100 },
        },
      })
    ).json() as { id: string };
    await advanceSession(app, session.id);
    let detail = await getSession(app, session.id);
    const sourceRunId = detail.session.currentRunId!;
    expect(await finishRun(app, project.id, sourceRunId)).toBe("awaiting_user");
    await advanceSession(app, session.id);

    const revisionRequest = {
      action: "request_revision",
      requestId: "session-revision-1",
      instruction: "保留事件顺序，收紧父女对话。",
    };
    const revised = await app.inject({
      method: "POST",
      url: `/api/autopilot/sessions/${session.id}/actions`,
      payload: revisionRequest,
    });
    expect(revised.statusCode, revised.body).toBe(200);
    detail = revised.json() as Awaited<ReturnType<typeof getSession>>;
    const revisionRunId = detail.session.currentRunId!;
    expect(revisionRunId).not.toBe(sourceRunId);
    expect(detail.links).toHaveLength(2);
    expect(detail.runs.find((run) => run.id === sourceRunId)?.status).toBe(
      "cancelled",
    );

    const replay = await app.inject({
      method: "POST",
      url: `/api/autopilot/sessions/${session.id}/actions`,
      payload: revisionRequest,
    });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toMatchObject({
      session: { currentRunId: revisionRunId },
    });

    expect(await finishRun(app, project.id, revisionRunId)).toBe(
      "awaiting_user",
    );
    await advanceSession(app, session.id);
    detail = await getSession(app, session.id);
    expect(detail.availableActions).toEqual([
      "accept_manuscript",
      "request_revision",
      "cancel",
    ]);
    const approvalRequest = {
      action: "accept_manuscript",
      requestId: `${revisionRunId}:accept_manuscript`,
    } as const;
    const accepted = await app.inject({
      method: "POST",
      url: `/api/autopilot/sessions/${session.id}/actions`,
      payload: approvalRequest,
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    const approvalReplay = await app.inject({
      method: "POST",
      url: `/api/autopilot/sessions/${session.id}/actions`,
      payload: approvalRequest,
    });
    expect(approvalReplay.statusCode, approvalReplay.body).toBe(200);
    expect(approvalReplay.json()).toMatchObject({
      session: { currentRunId: revisionRunId },
    });
    const approvalConflict = await app.inject({
      method: "POST",
      url: `/api/autopilot/sessions/${session.id}/actions`,
      payload: {
        action: "accept_plan",
        requestId: approvalRequest.requestId,
      },
    });
    expect(approvalConflict.statusCode, approvalConflict.body).toBe(409);
    expect(approvalConflict.json()).toMatchObject({
      error: { code: "autopilot.action.idempotency_conflict" },
    });
    expect(await finishRun(app, project.id, revisionRunId)).toBe("completed");
    await advanceSession(app, session.id);
    await advanceSession(app, session.id);
    expect((await getSession(app, session.id)).session).toMatchObject({
      status: "completed",
      completedChapters: 1,
    });
  });
});

async function setup(model: NarrativeModelClient = automationModel()) {
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
    narrativeModelClient: model,
    enableRunWorker: false,
    logger: false,
  });
  resources.push({ app, database });
  return { app, database };
}

async function finishRun(
  app: Awaited<ReturnType<typeof buildApp>>,
  projectId: string,
  runId: string,
) {
  let status = "pending";
  for (let index = 0; index < 30; index += 1) {
    const response = await app.inject({
      method: "POST",
      url: `/api/runs/${runId}/advance`,
      payload: { projectId },
    });
    expect(response.statusCode, response.body).toBe(200);
    status = (response.json() as { snapshot: { run: { status: string } } })
      .snapshot.run.status;
    if (
      ["completed", "failed", "cancelled", "awaiting_user"].includes(status)
    ) {
      break;
    }
  }
  return status;
}

async function advanceSession(
  app: Awaited<ReturnType<typeof buildApp>>,
  sessionId: string,
) {
  const response = await app.inject({
    method: "POST",
    url: `/api/autopilot/sessions/${sessionId}/advance`,
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json();
}

async function getSession(
  app: Awaited<ReturnType<typeof buildApp>>,
  sessionId: string,
) {
  const response = await app.inject({
    method: "GET",
    url: `/api/autopilot/sessions/${sessionId}`,
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as {
    session: {
      status: string;
      currentRunId: string | null;
      completedChapters: number;
      replanRequested: boolean;
      activeNotes: string[];
      chapterPolicy: Record<string, unknown>;
      lastError: Record<string, unknown> | null;
    };
    runs: {
      id: string;
      status: string;
      policy: Record<string, unknown>;
    }[];
    links: { role: string; runId: string }[];
    steers: {
      id: string;
      classification: string | null;
      status: string;
      rationale: string | null;
    }[];
    reviews: { scopeType: string }[];
    availableActions: string[];
  };
}

/** Every structured call fails with a fatal authentication error. */
function fatalModel(): NarrativeModelClient {
  return {
    async text() {
      throw {
        code: "model.authentication",
        message: "鉴权失败：API key 无效",
        retryable: false,
      };
    },
    async structured() {
      throw {
        code: "model.authentication",
        message: "鉴权失败：API key 无效",
        retryable: false,
      };
    },
  } as NarrativeModelClient;
}

function automationModel(
  options: {
    beforeStructured?: (
      purpose: string,
      request: unknown,
    ) => Promise<void> | void;
  } = {},
): NarrativeModelClient {
  const usage = {
    inputTokens: 100,
    outputTokens: 100,
    calls: 1,
    costUsd: 0,
    wallTimeMs: 5,
  };
  const manuscript =
    "雾从海面推上石阶。林昼把手按在冰冷的门上，听见灯塔深处传来第三下钟声。她沿着旋梯向上，每一级都沾着尚未干透的海水。\n\n灯灭的一刻，父亲忽然问她为何对着空椅子说话。窗外所有船铃同时沉默，仿佛港口刚刚吞掉了一个无人敢说出的名字。";
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
    async structured(_run, _step, purpose, request, _contract, validate) {
      await options.beforeStructured?.(purpose, request);
      const value = scriptedValue(purpose, request);
      const checked = validate(value);
      if (!checked.success) throw new Error(checked.issues.join("; "));
      return { value: checked.data, usage, mode: "native", attempts: 1 };
    },
  } as NarrativeModelClient;
}

function scriptedValue(purpose: string, request?: unknown): unknown {
  if (purpose === "book-foundation") {
    return {
      title: "雾港记忆候选",
      rationale: "以可验证的遗忘规则推动人物选择。",
      intent: {
        promise: "每次遗忘都留下代价",
        themes: ["记忆", "责任"],
        audience: "悬疑幻想读者",
        tone: "潮湿而克制",
        boundaries: ["不使用梦境解释"],
        endingDirection: "林昼选择记住所有失踪者",
        currentFocus: "建立规则",
      },
      compass: {
        corePromise: "每次遗忘都留下代价",
        endingDirection: "林昼选择记住所有失踪者",
        longLines: [{ title: "失踪者", promise: "找回名字", status: "open" }],
        themeQuestions: ["记住是否必然带来责任？"],
        target: { chapters: 12, wordsPerChapter: 2000, volumes: 1 },
        constraints: ["不使用梦境解释"],
      },
      entities: [
        {
          type: "character",
          name: "林昼",
          aliases: [],
          description: "守灯人的女儿。",
          attributes: {
            role: "主角",
            desire: "找回名字",
            fear: "被遗忘",
            secret: null,
          },
        },
        {
          type: "location",
          name: "雾港灯塔",
          aliases: [],
          description: "会吞掉名字的旧灯塔。",
          attributes: {
            role: "核心地点",
            desire: null,
            fear: null,
            secret: "规则源头",
          },
        },
      ],
    };
  }
  if (purpose === "rolling-outline") {
    return {
      rationale: "从熄灯异象逐步逼近代价。",
      volume: {
        title: "第一卷 雾港",
        summary: "追索失踪名字。",
        goal: "查明灯塔规则",
      },
      arc: {
        title: "失灯弧",
        summary: "第一次熄灯。",
        goal: "确认规则",
        conflict: "父亲阻拦",
        outcome: "林昼留下证据",
      },
      chapters: [
        {
          title: "雾港失灯",
          summary: "林昼目击熄灯。",
          goal: "进入灯塔",
          conflict: "父亲阻拦",
          outcome: "发现空椅子",
          povName: "林昼",
          storyTime: "第一夜",
          hook: "谁被忘了",
        },
        {
          title: "空椅之名",
          summary: "林昼追查名字。",
          goal: "确认失踪者",
          conflict: "档案被改写",
          outcome: "找到旧录音",
          povName: "林昼",
          storyTime: "第二日",
          hook: "录音喊出她的名字",
        },
      ],
      nextArc: {
        title: "回声弧",
        summary: "名字开始返回。",
        goal: "寻找规则源头",
      },
      continuityRisks: [],
    };
  }
  if (purpose === "steer-classification") {
    const immediate = JSON.stringify(request).includes("立即中止");
    const canonChange = JSON.stringify(request).includes("已确认设定");
    return {
      classification: immediate
        ? "immediate_current"
        : canonChange
          ? "canon_change"
          : "next_scene",
      effectiveBoundary: immediate
        ? "immediate"
        : canonChange
          ? "future"
          : "next_chapter",
      rationale: immediate
        ? "需要取消当前未提交草稿"
        : canonChange
          ? "涉及已确认设定，需要作者裁定"
          : "不改写已提交事实",
      risk: immediate || canonChange ? "medium" : "low",
    };
  }
  if (purpose === "scene-plan") {
    return {
      chapterGoal: "发现遗忘规则",
      povEntityId: null,
      scenes: [
        {
          title: "熄灯",
          goal: "进入灯塔",
          conflict: "父亲阻拦",
          turn: "灯塔熄灭",
          outcome: "发现空椅子",
          locationId: null,
          participants: [],
          targetCharacters: 1200,
        },
      ],
      continuityRisks: [],
    };
  }
  if (purpose === "semantic-review") {
    return {
      summary: "章节目标已经完成。",
      scores: {
        continuity: 92,
        pacing: 88,
        character: 86,
        prose: 85,
        goal: 94,
      },
      issues: [],
    };
  }
  if (purpose === "chapter-settlement") {
    return {
      summary: "林昼发现灯塔熄灭会触发遗忘。",
      stateDelta: [
        {
          key: "ruleObserved",
          before: null,
          after: "已发现",
          evidenceParagraphs: [2],
        },
      ],
      factCandidates: [],
      timelineCandidates: [],
      relationshipCandidates: [],
      foreshadowCandidates: [],
    };
  }
  if (purpose === "arc-review" || purpose === "volume-review") {
    return {
      summary: "失灯规则与人物选择形成因果链。",
      scores: {
        promise: 90,
        causality: 88,
        characterArc: 84,
        pacing: 86,
        continuity: 92,
      },
      recommendations: ["下一弧提高主动选择代价"],
      compassAdjustments: [],
    };
  }
  throw new Error(`unexpected purpose ${purpose}`);
}
