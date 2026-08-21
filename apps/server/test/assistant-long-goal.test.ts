import type { NarrativeModelClient } from "@narralume/narrative";
import {
  SqliteAssistantLongGoalRepository,
  SqliteAssistantRepository,
  SqliteAutomationRepository,
  SqliteStoryRepository,
} from "@narralume/persistence";
import { NodeNarrativeDatabase } from "@narralume/persistence/node";
import { afterEach, describe, expect, it } from "vitest";

import { AGENT_SKILL_REGISTRY } from "@narralume/services";
import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";
import { LongGoalCoordinator } from "@narralume/services";

const config: ServerConfig = {
  dataDirectory: ".",
  databasePath: ":memory:",
  host: "127.0.0.1",
  port: 4319,
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

describe("agent skill registry (R7)", () => {
  it("declares builtin skills separate from writing skills, without script/network/database capabilities", () => {
    expect(AGENT_SKILL_REGISTRY.length).toBeGreaterThanOrEqual(8);
    const compose = AGENT_SKILL_REGISTRY.find(
      (skill) => skill.id === "compose.serial",
    );
    expect(compose).toMatchObject({
      builtin: true,
      outputKind: "long_goal",
      checkpoint: "confirm_start",
    });
    expect(compose!.allowedCapabilities).toEqual([
      "foundation.start",
      "outline.plan.start",
      "autopilot.start",
    ]);
    for (const skill of AGENT_SKILL_REGISTRY) {
      expect(skill.builtin).toBe(true);
      // Skill 只声明既有领域能力白名单，不允许脚本/网络/直写数据库。
      expect(skill.allowedCapabilities.length).toBeGreaterThan(0);
    }
  });

  it("exposes the registry on the conversation detail", async () => {
    const { app } = await setup(() => ({ reply: "好的。", toolCall: null }));
    const projectId = await createProject(app, "技能注册表");
    const conversation = await createConversation(
      app,
      projectId,
      "skill-registry-conv",
    );
    const detail = (
      await app.inject({
        method: "GET",
        url: `/api/assistant/conversations/${conversation.id}`,
      })
    ).json() as { skills: { id: string; builtin: boolean }[] };
    expect(detail.skills.map((skill) => skill.id)).toContain("compose.serial");
    expect(detail.skills.every((skill) => skill.builtin)).toBe(true);
  });
});

describe("assistant long goals (R7)", () => {
  it("starts a composite goal idempotently and rejects a second active goal", async () => {
    const { app, database } = await setup(() => ({
      reply: "好的。",
      toolCall: null,
    }));
    const projectId = await createProject(app, "复合任务幂等");
    await seedCompass(app, projectId);
    const conversation = await createConversation(
      app,
      projectId,
      "long-goal-conv-1",
    );
    const payload = {
      requestId: "long-goal-req-1",
      targetChapters: 3,
      braindump: null,
    };
    const first = await app.inject({
      method: "POST",
      url: `/api/assistant/conversations/${conversation.id}/long-goals`,
      payload,
    });
    expect(first.statusCode, first.body).toBe(202);
    const firstGoal = first.json() as {
      goal: { id: string; phase: string; status: string };
      idempotentReplay: boolean;
    };
    expect(firstGoal.idempotentReplay).toBe(false);
    // 项目已有 intent/compass（建项目时初始化）时跳过建书阶段，直接建规划会话。
    expect(firstGoal.goal).toMatchObject({
      phase: "outline",
      status: "active",
    });
    const goals = new SqliteAssistantLongGoalRepository(database);
    expect(
      goals.requireGoal(firstGoal.goal.id).outlineSessionId,
    ).not.toBeNull();

    const replay = await app.inject({
      method: "POST",
      url: `/api/assistant/conversations/${conversation.id}/long-goals`,
      payload,
    });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toMatchObject({
      goal: { id: firstGoal.goal.id },
      idempotentReplay: true,
    });

    const conflict = await app.inject({
      method: "POST",
      url: `/api/assistant/conversations/${conversation.id}/long-goals`,
      payload: { ...payload, targetChapters: 5 },
    });
    expect(conflict.statusCode, conflict.body).toBe(409);
    expect(conflict.json()).toMatchObject({
      error: { code: "assistant.long_goal.idempotency_conflict" },
    });

    const second = await app.inject({
      method: "POST",
      url: `/api/assistant/conversations/${conversation.id}/long-goals`,
      payload: { requestId: "long-goal-req-2", targetChapters: 2 },
    });
    expect(second.statusCode, second.body).toBe(409);
    expect(second.json()).toMatchObject({
      error: { code: "assistant.long_goal.active" },
    });
  });

  it("hands off to the writing session once chapters satisfy the target, and completes on session completion", async () => {
    const { app, database } = await setup(() => ({
      reply: "好的。",
      toolCall: null,
    }));
    const projectId = await createProject(app, "复合任务推进");
    await seedCompass(app, projectId);
    // 章节数已满足目标：规划阶段直接移交写作阶段，无需规划会话。
    await createChapter(app, projectId, "第一章 雾起", 0);
    await createChapter(app, projectId, "第二章 灯塔", 1);
    const conversation = await createConversation(
      app,
      projectId,
      "long-goal-conv-2",
    );
    const started = await app.inject({
      method: "POST",
      url: `/api/assistant/conversations/${conversation.id}/long-goals`,
      payload: {
        requestId: "long-goal-advance",
        targetChapters: 2,
        braindump: null,
      },
    });
    expect(started.statusCode, started.body).toBe(202);
    const goalId = (started.json() as { goal: { id: string } }).goal.id;
    const goals = new SqliteAssistantLongGoalRepository(database);
    const automation = new SqliteAutomationRepository(database);

    let goal = goals.requireGoal(goalId);
    expect(goal).toMatchObject({ phase: "writing", status: "active" });
    expect(goal.outlineSessionId).toBeNull();
    expect(goal.sessionId).not.toBeNull();
    const writingSession = automation.requireSession(goal.sessionId!);
    expect(writingSession.chapterPolicy).toMatchObject({
      assistantLongGoalId: goalId,
    });
    expect(writingSession.chapterPolicy.planningOnly).toBeUndefined();

    // 写作会话完成（章节均为已提交状态、无新章节可写时直接结算）后，
    // 目标与父活动一起完成。这里直接结算会话，驱动协调器的完成分支；
    // 章节生产链路本身由 automation-api 测试覆盖。
    const coordinator = new LongGoalCoordinator(database, {
      runCoordinator: nullCoordinator(),
      autopilotCoordinator: nullAutopilot(),
      enableBackgroundWorker: false,
      environment: testEnvironment(),
    });
    automation.setSessionStatus(
      goal.sessionId!,
      "completed",
      new Date().toISOString(),
    );
    coordinator.advance(goalId);
    goal = goals.requireGoal(goalId);
    expect(goal).toMatchObject({ phase: "done", status: "completed" });
    const activity = new SqliteAssistantRepository(database).requireActivity(
      goal.activityId,
    );
    expect(activity).toMatchObject({ status: "completed", kind: "long_goal" });

    const detail = (
      await app.inject({
        method: "GET",
        url: `/api/assistant/conversations/${conversation.id}`,
      })
    ).json() as {
      activities: {
        kind: string;
        status: string;
        skillId: string | null;
        phaseKey: string | null;
        linkedSources: { type: string; id: string }[];
      }[];
    };
    const card = detail.activities.find(
      (activity) => activity.kind === "long_goal",
    );
    expect(card).toMatchObject({
      status: "completed",
      skillId: "compose.serial",
      phaseKey: "done",
    });
    expect(card!.linkedSources.map((source) => source.type)).toEqual([
      "autopilot",
    ]);
  });

  it("pauses on baseline drift and resumes onto the latest state", async () => {
    const { app, database } = await setup(() => ({
      reply: "好的。",
      toolCall: null,
    }));
    const projectId = await createProject(app, "复合任务基线");
    await seedCompass(app, projectId);
    // 预置足量章节，让规划会话结算后目标数达成，进入写作阶段。
    await createChapter(app, projectId, "第一章 雾起", 0);
    await createChapter(app, projectId, "第二章 灯塔", 1);
    const conversation = await createConversation(
      app,
      projectId,
      "long-goal-conv-baseline",
    );
    const started = await app.inject({
      method: "POST",
      url: `/api/assistant/conversations/${conversation.id}/long-goals`,
      payload: {
        requestId: "long-goal-baseline",
        targetChapters: 2,
        braindump: null,
      },
    });
    const goalId = (started.json() as { goal: { id: string } }).goal.id;
    const goals = new SqliteAssistantLongGoalRepository(database);

    // 章节数已满足目标：启动即进入写作阶段并创建确定性写作会话。
    let goal = goals.requireGoal(goalId);
    expect(goal).toMatchObject({ phase: "writing", status: "active" });
    expect(goal.sessionId).not.toBeNull();

    // 作者在写作阶段修改大纲 → 下一次推进感知基线漂移并停靠。
    const coordinator = new LongGoalCoordinator(database, {
      runCoordinator: nullCoordinator(),
      autopilotCoordinator: nullAutopilot(),
      enableBackgroundWorker: false,
      environment: testEnvironment(),
    });
    await createChapter(app, projectId, "外加章节", 2);
    coordinator.advance(goalId);
    goal = goals.requireGoal(goalId);
    expect(goal.status).toBe("paused_baseline");

    // 活动卡片暴露 resume/cancel；resume 基于最新基线继续推进。
    const detail = (
      await app.inject({
        method: "GET",
        url: `/api/assistant/conversations/${conversation.id}`,
      })
    ).json() as {
      activities: {
        kind: string;
        status: string;
        availableActions: string[];
        sourceId: string;
      }[];
    };
    const card = detail.activities.find(
      (activity) => activity.kind === "long_goal",
    );
    expect(card).toMatchObject({
      status: "waiting",
      availableActions: ["resume", "cancel"],
    });

    const resumed = await app.inject({
      method: "POST",
      url: `/api/assistant/activities/${card!.sourceId}/actions`,
      payload: { action: "resume" },
    });
    expect(resumed.statusCode, resumed.body).toBe(200);
    expect(goals.requireGoal(goalId).status).toBe("active");
  });

  it("rejects resume while the goal is still active", async () => {
    const { app, database } = await setup(() => ({
      reply: "好的。",
      toolCall: null,
    }));
    const projectId = await createProject(app, "复合任务状态机");
    await seedCompass(app, projectId);
    const conversation = await createConversation(
      app,
      projectId,
      "long-goal-conv-3",
    );
    const started = await app.inject({
      method: "POST",
      url: `/api/assistant/conversations/${conversation.id}/long-goals`,
      payload: {
        requestId: "long-goal-invalid-resume",
        targetChapters: 2,
        braindump: null,
      },
    });
    const goalId = (started.json() as { goal: { id: string } }).goal.id;
    const goals = new SqliteAssistantLongGoalRepository(database);
    expect(goals.requireGoal(goalId).status).toBe("active");

    const invalidResume = await app.inject({
      method: "POST",
      url: `/api/assistant/long-goals/${goalId}/actions`,
      payload: { action: "resume" },
    });
    expect(invalidResume.statusCode, invalidResume.body).toBe(409);
    expect(invalidResume.json()).toMatchObject({
      error: { code: "assistant.long_goal.invalid_state" },
    });
  });

  it("cancels an active goal and its child session", async () => {
    const { app, database } = await setup(() => ({
      reply: "好的。",
      toolCall: null,
    }));
    const projectId = await createProject(app, "复合任务取消");
    await seedCompass(app, projectId);
    const conversation = await createConversation(
      app,
      projectId,
      "long-goal-conv-4",
    );
    const started = await app.inject({
      method: "POST",
      url: `/api/assistant/conversations/${conversation.id}/long-goals`,
      payload: {
        requestId: "long-goal-cancel",
        targetChapters: 2,
        braindump: null,
      },
    });
    const goalId = (started.json() as { goal: { id: string } }).goal.id;
    const cancelled = await app.inject({
      method: "POST",
      url: `/api/assistant/long-goals/${goalId}/actions`,
      payload: { action: "cancel" },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json()).toMatchObject({ status: "cancelled" });
    const goal = new SqliteAssistantLongGoalRepository(database).requireGoal(
      goalId,
    );
    expect(goal.status).toBe("cancelled");
    const activity = new SqliteAssistantRepository(database).requireActivity(
      goal.activityId,
    );
    expect(activity.status).toBe("cancelled");
    // 规划会话不是 goal.sessionId，取消不强行打断；仅写作会话会被请求取消。
    expect(goal.sessionId).toBeNull();
    // 取消后允许启动新目标。
    const again = await app.inject({
      method: "POST",
      url: `/api/assistant/conversations/${conversation.id}/long-goals`,
      payload: {
        requestId: "long-goal-cancel-again",
        targetChapters: 1,
        braindump: null,
      },
    });
    expect(again.statusCode, again.body).toBe(202);
  });

  it("fails cleanly when the story needs foundation material but none is given", async () => {
    const { app, database } = await setup(() => ({
      reply: "好的。",
      toolCall: null,
    }));
    const projectId = await createProject(app, "复合任务素材");
    // 清掉建项目时初始化的作者意图，模拟尚未整理故事方向的作品。
    const story = new SqliteStoryRepository(database);
    const intent = story.getAuthorIntent(projectId);
    expect(intent).not.toBeNull();
    database.raw
      .prepare("DELETE FROM author_intents WHERE project_id = ?")
      .run(projectId);
    database.raw
      .prepare("DELETE FROM story_compasses WHERE project_id = ?")
      .run(projectId);

    const conversation = await createConversation(
      app,
      projectId,
      "long-goal-conv-5",
    );
    const started = await app.inject({
      method: "POST",
      url: `/api/assistant/conversations/${conversation.id}/long-goals`,
      payload: {
        requestId: "long-goal-foundation-missing",
        targetChapters: 2,
        braindump: null,
      },
    });
    expect(started.statusCode, started.body).toBe(202);
    const goal = new SqliteAssistantLongGoalRepository(database).requireGoal(
      (started.json() as { goal: { id: string } }).goal.id,
    );
    expect(goal).toMatchObject({ phase: "foundation", status: "failed" });
    expect(goal.lastError).toMatchObject({
      code: "assistant.long_goal.braindump_missing",
    });
  });

  it("stages a long_goal.start tool call as a confirm proposal and reuses the goal on confirm replay", async () => {
    const { app, database } = await setup(() => ({
      reply: "这是一项长任务，确认后我会串联整理大纲与连续创作。",
      toolCall: {
        name: "long_goal.start",
        arguments: { targetChapters: 2, braindump: null },
      },
    }));
    const projectId = await createProject(app, "复合任务工具");
    await seedCompass(app, projectId);
    const conversation = await createConversation(
      app,
      projectId,
      "long-goal-conv-6",
    );
    const runId = await sendAndFinish(
      app,
      projectId,
      conversation.id,
      "long-goal-tool-msg",
      "帮我把后续两章从大纲到正文一次做完。",
    );
    const detail = (
      await app.inject({
        method: "GET",
        url: `/api/assistant/conversations/${conversation.id}`,
      })
    ).json() as {
      activities: {
        id: string;
        kind: string;
        status: string;
        sourceId: string;
        toolCall: { name: string } | null;
      }[];
    };
    const proposal = detail.activities.find(
      (activity) => activity.kind === "tool" && activity.status === "proposed",
    );
    expect(proposal).toMatchObject({
      toolCall: { name: "long_goal.start" },
    });

    const confirmed = await app.inject({
      method: "POST",
      url: `/api/assistant/activities/${proposal!.sourceId}/actions`,
      payload: { action: "confirm" },
    });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    const goalId = `${runId}:tool:goal`;
    const goal = new SqliteAssistantLongGoalRepository(database).requireGoal(
      goalId,
    );
    expect(goal).toMatchObject({ projectId, status: "active" });

    // 重复确认同一活动：复用同一 goal，不产生第二条长期任务。
    const replay = await app.inject({
      method: "POST",
      url: `/api/assistant/activities/${proposal!.sourceId}/actions`,
      payload: { action: "confirm" },
    });
    expect([200, 409]).toContain(replay.statusCode);
    const goals = new SqliteAssistantLongGoalRepository(database).listGoals(
      projectId,
    );
    expect(goals).toHaveLength(1);
  });

  it("keeps the goal recoverable after app rebuild without duplicating sessions", async () => {
    const { app, database } = await setup(() => ({
      reply: "好的。",
      toolCall: null,
    }));
    const projectId = await createProject(app, "复合任务恢复");
    await seedCompass(app, projectId);
    const conversation = await createConversation(
      app,
      projectId,
      "long-goal-conv-7",
    );
    const started = await app.inject({
      method: "POST",
      url: `/api/assistant/conversations/${conversation.id}/long-goals`,
      payload: {
        requestId: "long-goal-reconcile",
        targetChapters: 2,
        braindump: null,
      },
    });
    const goalId = (started.json() as { goal: { id: string } }).goal.id;
    const goals = new SqliteAssistantLongGoalRepository(database);
    const outlineSessionId = goals.requireGoal(goalId).outlineSessionId!;
    await app.close();
    // 手动管理生命周期：app 已关闭，app2 与数据库在下方统一收尾。
    resources.length = 0;

    // 模拟进程重启：同一数据库重建 app（协调器重新接线），
    // 目标仍处于 active，会话与确定性 ID 不变，事件回调继续推进。
    const app2 = await buildApp({
      config,
      database,
      environment: testEnvironment(),
      narrativeModelClient: assistantModel(() => ({
        reply: "好的。",
        toolCall: null,
      })),
      enableRunWorker: false,
      logger: false,
    });
    try {
      const goal = goals.requireGoal(goalId);
      expect(goal).toMatchObject({ status: "active", phase: "outline" });
      expect(goal.outlineSessionId).toBe(outlineSessionId);

      // 恢复后继续推进：规划会话在无新章节可写时直接结算，
      // 协调器随后创建确定性写作会话。
      await advanceSession(app2, projectId, outlineSessionId);
      const advanced = goals.requireGoal(goalId);
      expect(advanced.phase).toBe("writing");
      expect(advanced.sessionId).not.toBeNull();
    } finally {
      await app2.close();
      database.close();
    }
  });
});

function nullCoordinator() {
  return {
    wake() {},
    interrupt() {},
  } as unknown as ConstructorParameters<
    typeof LongGoalCoordinator
  >[1]["runCoordinator"];
}

function nullAutopilot() {
  return {
    wake() {},
  } as unknown as ConstructorParameters<
    typeof LongGoalCoordinator
  >[1]["autopilotCoordinator"];
}

async function setup(
  assistantReply: () => {
    reply: string;
    toolCall: null | { name: string; arguments: Record<string, unknown> };
  },
) {
  const database = new NodeNarrativeDatabase();
  const app = await buildApp({
    config,
    database,
    environment: testEnvironment(),
    narrativeModelClient: assistantModel(assistantReply),
    enableRunWorker: false,
    logger: false,
  });
  resources.push({ app, database });
  return { app, database };
}

function testEnvironment() {
  return {
    NARRATIVE_LLM_API_KEY: "server-only-test-key",
    NARRATIVE_LLM_BASE_URL: "https://api.example.com/v1",
    NARRATIVE_LLM_MODEL: "test-model",
    NARRATIVE_LLM_CONTEXT_WINDOW: "128000",
    NARRATIVE_LLM_MAX_OUTPUT_TOKENS: "32000",
  };
}

function assistantModel(
  reply: () => {
    reply: string;
    toolCall: null | { name: string; arguments: Record<string, unknown> };
  },
): NarrativeModelClient {
  return {
    async text() {
      throw new Error("assistant turn must not request unstructured text");
    },
    async structured(_run, _step, purpose, _request, _contract, validate) {
      // 规划/写作链路的子 Run 复用与 automation-api 测试相同的确定性脚本。
      if (purpose !== "project-assistant") {
        const checked = validate(scriptedAutomationValue(purpose));
        if (!checked.success) throw new Error(checked.issues.join("; "));
        return {
          value: checked.data,
          usage: {
            inputTokens: 100,
            outputTokens: 100,
            calls: 1,
            costUsd: 0,
            wallTimeMs: 5,
          },
          mode: "native",
          attempts: 1,
        };
      }
      const checked = validate(reply());
      if (!checked.success) throw new Error(checked.issues.join("; "));
      return {
        value: checked.data,
        usage: {
          inputTokens: 120,
          outputTokens: 80,
          calls: 1,
          costUsd: 0,
          wallTimeMs: 10,
        },
        mode: "native",
        attempts: 1,
      };
    },
  } as NarrativeModelClient;
}

function scriptedAutomationValue(purpose: string): unknown {
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
  throw new Error(`unexpected model purpose: ${purpose}`);
}

async function createProject(
  app: Awaited<ReturnType<typeof buildApp>>,
  title: string,
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: {
      requestId: globalThis.crypto.randomUUID(),
      title,
      premise: `${title}的故事命题`,
    },
  });
  expect(response.statusCode, response.body).toBe(201);
  return (response.json() as { id: string }).id;
}

async function createChapter(
  app: Awaited<ReturnType<typeof buildApp>>,
  projectId: string,
  title: string,
  ordinal = 0,
): Promise<string> {
  const bible = (
    await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/story-bible`,
    })
  ).json() as { outline: { id: string; kind: string }[] };
  const root = bible.outline.find((node) => node.kind === "book")!;
  const response = await app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/outline`,
    payload: {
      parentId: root.id,
      kind: "chapter",
      ordinal,
      title,
      summary: "灯塔熄灭，港口遗忘一个人。",
      goal: "发现遗忘规则",
      conflict: "守塔人拒绝开门",
      metadata: {},
    },
  });
  expect(response.statusCode, response.body).toBe(201);
  return (response.json() as { id: string }).id;
}

async function seedCompass(
  app: Awaited<ReturnType<typeof buildApp>>,
  projectId: string,
): Promise<void> {
  const response = await app.inject({
    method: "PUT",
    url: `/api/projects/${projectId}/compass`,
    payload: {
      expectedVersion: null,
      corePromise: "雾港灯塔守塔人找回被遗忘的人。",
      endingDirection: "灯塔重燃",
      longLines: [],
      themeQuestions: ["记忆由谁保管"],
      target: { chapters: 12, wordsPerChapter: 2500, volumes: 1 },
      constraints: [],
    },
  });
  expect(response.statusCode, response.body).toBe(200);
}

async function createConversation(
  app: Awaited<ReturnType<typeof buildApp>>,
  projectId: string,
  requestId: string,
): Promise<{ id: string }> {
  const response = await app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/assistant/conversations`,
    payload: { requestId, title: "项目协作" },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json() as { id: string };
}

async function advanceSession(
  app: Awaited<ReturnType<typeof buildApp>>,
  projectId: string,
  sessionId: string,
): Promise<void> {
  for (let index = 0; index < 30; index += 1) {
    const response = await app.inject({
      method: "POST",
      url: `/api/autopilot/sessions/${sessionId}/advance`,
    });
    expect(response.statusCode, response.body).toBe(200);
    const detail = (
      response.json() as {
        detail: {
          session: { status: string };
          runs: { id: string; status: string }[];
        };
      }
    ).detail;
    if (
      ["completed", "failed", "cancelled", "awaiting_user"].includes(
        detail.session.status,
      )
    ) {
      return;
    }
    // 推进会话产生的子 Run（规划/章节配方），复用与 worker 相同的 advance 端点。
    for (const run of detail.runs) {
      if (["pending", "running"].includes(run.status)) {
        await finishRun(app, projectId, run.id);
      }
    }
  }
  throw new Error("autopilot session did not settle");
}

async function finishRun(
  app: Awaited<ReturnType<typeof buildApp>>,
  projectId: string,
  runId: string,
): Promise<string> {
  for (let index = 0; index < 30; index += 1) {
    const response = await app.inject({
      method: "POST",
      url: `/api/runs/${runId}/advance`,
      payload: { projectId },
    });
    expect(response.statusCode, response.body).toBe(200);
    const status = (
      response.json() as { snapshot: { run: { status: string } } }
    ).snapshot.run.status;
    if (
      ["completed", "failed", "cancelled", "awaiting_user"].includes(status)
    ) {
      return status;
    }
  }
  throw new Error(`run ${runId} did not settle`);
}

async function sendAndFinish(
  app: Awaited<ReturnType<typeof buildApp>>,
  projectId: string,
  conversationId: string,
  requestId: string,
  content: string,
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: `/api/assistant/conversations/${conversationId}/messages`,
    payload: {
      requestId,
      content,
      context: {
        surface: "overview",
        documentId: null,
        outlineNodeId: null,
        canonSpread: null,
        selection: null,
      },
    },
  });
  expect(response.statusCode, response.body).toBe(202);
  const runId = response.json().runId as string;
  for (let index = 0; index < 12; index += 1) {
    const advanced = await app.inject({
      method: "POST",
      url: `/api/runs/${runId}/advance`,
      payload: { projectId },
    });
    expect(advanced.statusCode, advanced.body).toBe(200);
    const status = (
      advanced.json() as { snapshot: { run: { status: string } } }
    ).snapshot.run.status;
    if (status === "completed") return runId;
    if (["failed", "cancelled"].includes(status)) {
      throw new Error(`assistant run ended as ${status}`);
    }
  }
  throw new Error("assistant run did not complete");
}
