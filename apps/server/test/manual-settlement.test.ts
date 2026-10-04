import { createServer, type Server } from "node:http";

import { NodeNarrativeDatabase } from "@narralume/persistence/node";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";

/**
 * 手动章节结算：作者正式提交正文版本（source=manual）、恢复版本后自动开
 * manual-settlement Run；没有可用写作模型时静默跳过，手动写作不被阻塞。
 */

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
  provider: FakeProvider | null;
}[] = [];

afterEach(async () => {
  while (resources.length) {
    const resource = resources.pop()!;
    await resource.app.close();
    resource.database.close();
    await resource.provider?.close();
  }
});

/** 结算结构化调用的返回体；subjectId 在实体创建后动态注入。 */
let settlementSubjectId: string | null = null;
let settlementWithCandidates = true;

const MANUSCRIPT =
  "雾从海面推上石阶，林昼把手按在冰冷的门上，听见灯塔深处传来第三下钟声。\n\n" +
  "灯灭的一刻，父亲忽然问她为何对着空椅子说话。窗外所有船铃同时沉默。\n\n" +
  "她合上日志，吹熄油灯，摸黑走下旋梯。海面在脚下翻涌，雾里没有一艘船亮着灯。";

function settlementPayload(): string {
  if (!settlementWithCandidates || !settlementSubjectId) {
    return JSON.stringify({
      summaryPoints: [
        {
          text: "林昼发现灯塔熄灭会触发遗忘。",
          basis: "observed",
          evidenceParagraphs: [1],
        },
      ],
      stateDelta: [],
      factCandidates: [],
      timelineCandidates: [],
      relationshipCandidates: [],
      foreshadowCandidates: [],
    });
  }
  return JSON.stringify({
    summaryPoints: [
      {
        text: "林昼发现灯塔熄灭会触发遗忘。",
        basis: "observed",
        evidenceParagraphs: [1],
      },
    ],
    stateDelta: [],
    factCandidates: [
      {
        operation: "assert",
        factId: null,
        subjectId: settlementSubjectId,
        predicate: "守夜状态",
        objectEntityId: null,
        value: "独自守塔",
        knowledgeScope: "omniscient",
        knowledgeSubjectId: null,
        belief: "known",
        evidenceParagraphs: [1],
      },
    ],
    timelineCandidates: [],
    relationshipCandidates: [],
    foreshadowCandidates: [],
  });
}

interface ChatCompletionRequestBody {
  messages?: Array<{ role?: string; content?: unknown }>;
  response_format?: { json_schema?: { name?: string } };
}

function schemaNameOf(body: ChatCompletionRequestBody): string | null {
  const fromFormat = body.response_format?.json_schema?.name;
  if (fromFormat) return fromFormat;
  for (const message of body.messages ?? []) {
    if (typeof message.content !== "string") continue;
    const match = /schema named (\w+)/.exec(message.content);
    if (match) return match[1]!;
  }
  return null;
}

interface FakeProvider {
  baseUrl: string;
  close(): Promise<void>;
}

async function startFakeProvider(): Promise<FakeProvider> {
  const server: Server = createServer((request, response) => {
    request.on("error", () => {});
    response.on("error", () => {});
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      const body = JSON.parse(raw) as ChatCompletionRequestBody;
      const schema = schemaNameOf(body);
      if (schema !== "chapter_settlement_candidates") {
        response.writeHead(500).end(
          JSON.stringify({
            error: { message: `unexpected schema ${schema}` },
          }),
        );
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "chatcmpl-fake",
          object: "chat.completion",
          created: 1_700_000_000,
          model: "fake-model",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: settlementPayload() },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 120,
            completion_tokens: 80,
            total_tokens: 200,
          },
        }),
      );
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fake provider did not bind a port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function setup(withProvider = true) {
  const provider = withProvider ? await startFakeProvider() : null;
  const database = new NodeNarrativeDatabase();
  const app = await buildApp({
    config,
    database,
    environment: {},
    enableRunWorker: false,
    logger: false,
  });
  resources.push({ app, database, provider });

  if (!provider) return { app, database };

  const providerResponse = await app.inject({
    method: "POST",
    url: "/api/providers",
    payload: {
      name: "本地假 Provider",
      wireApi: "openai-chat",
      baseUrl: provider.baseUrl,
      credentialRef: "fake-provider-key",
    },
  });
  expect(providerResponse.statusCode, providerResponse.body).toBe(201);
  const providerId = (providerResponse.json() as { id: string }).id;

  const modelResponse = await app.inject({
    method: "POST",
    url: "/api/models",
    payload: {
      providerId,
      modelId: "fake-model",
      taskType: "writing",
      contextWindow: 128_000,
      maxOutputTokens: 32_000,
    },
  });
  expect(modelResponse.statusCode, modelResponse.body).toBe(201);
  const modelId = (modelResponse.json() as { id: string }).id;

  const assigned = await app.inject({
    method: "PUT",
    url: "/api/assignments/writing",
    payload: { modelId },
  });
  expect(assigned.statusCode, assigned.body).toBe(200);
  return { app, database };
}

interface ChapterFixture {
  projectId: string;
  chapterId: string;
  documentId: string;
  entityId: string;
}

async function createChapterWorld(
  app: Awaited<ReturnType<typeof buildApp>>,
): Promise<ChapterFixture> {
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
  const bible = (
    await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/story-bible`,
    })
  ).json() as { outline: { id: string }[] };
  const chapterResponse = await app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/outline`,
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
  const chapterId = (chapterResponse.json() as { id: string }).id;
  const entityResponse = await app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/entities`,
    payload: {
      type: "character",
      name: "林昼",
      aliases: [],
      description: "守灯人的女儿。",
    },
  });
  expect(entityResponse.statusCode).toBe(201);
  const entityId = (entityResponse.json() as { id: string }).id;
  settlementSubjectId = entityId;
  const documentResponse = await app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/documents`,
    payload: {
      requestId: globalThis.crypto.randomUUID(),
      kind: "chapter",
      title: "雾港失灯",
      outlineNodeId: chapterId,
    },
  });
  expect(documentResponse.statusCode, documentResponse.body).toBe(201);
  return {
    projectId,
    chapterId,
    documentId: (documentResponse.json() as { id: string }).id,
    entityId,
  };
}

async function appendVersion(
  app: Awaited<ReturnType<typeof buildApp>>,
  projectId: string,
  documentId: string,
  source: string,
  content = MANUSCRIPT,
): Promise<string> {
  /* 版本列表是新→旧排序，第一个即当前版本。 */
  const versions = (
    await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/documents/${documentId}/versions`,
    })
  ).json() as { id: string }[];
  const current = versions[0]?.id ?? null;
  const response = await app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/documents/${documentId}/versions`,
    payload: { content, source, expectedCurrentVersionId: current },
  });
  expect(response.statusCode, response.body).toBe(201);
  return (response.json() as { id: string }).id;
}

async function listRuns(
  app: Awaited<ReturnType<typeof buildApp>>,
  projectId: string,
): Promise<
  Array<{
    id: string;
    recipe: string;
    status: string;
    targetOutlineNodeId: string | null;
    policy: Record<string, unknown>;
  }>
> {
  const response = await app.inject({
    method: "GET",
    url: `/api/projects/${projectId}/runs`,
  });
  return response.json() as never;
}

async function driveRun(
  app: Awaited<ReturnType<typeof buildApp>>,
  runId: string,
  projectId: string,
): Promise<string> {
  let status = "pending";
  for (let index = 0; index < 40; index += 1) {
    const advanced = await app.inject({
      method: "POST",
      url: `/api/runs/${runId}/advance`,
      payload: { projectId },
    });
    expect(advanced.statusCode, advanced.body).toBe(200);
    const body = advanced.json() as {
      processed: boolean;
      snapshot: { run: { status: string } };
    };
    status = body.snapshot.run.status;
    if (["completed", "failed", "cancelled"].includes(status)) return status;
    if (!body.processed)
      await new Promise((resolve) => setTimeout(resolve, 15));
  }
  return status;
}

describe("手动章节结算", () => {
  it("正式提交版本自动开结算 Run，落候选变更集且不追加版本", async () => {
    settlementWithCandidates = true;
    const { app } = await setup();
    const world = await createChapterWorld(app);
    const versionId = await appendVersion(
      app,
      world.projectId,
      world.documentId,
      "manual",
    );

    const runs = await listRuns(app, world.projectId);
    const settlementRuns = runs.filter(
      (run) => run.recipe === "manual-settlement",
    );
    expect(settlementRuns).toHaveLength(1);
    expect(settlementRuns[0]!.targetOutlineNodeId).toBeNull();
    expect(settlementRuns[0]!.policy.documentId).toBe(world.documentId);
    expect(settlementRuns[0]!.policy.documentVersionId).toBe(versionId);

    expect(await driveRun(app, settlementRuns[0]!.id, world.projectId)).toBe(
      "completed",
    );

    const changeSets = (
      await app.inject({
        method: "GET",
        url: `/api/projects/${world.projectId}/canon-change-sets`,
      })
    ).json() as {
      changeSets: Array<{
        id: string;
        status: string;
        runId: string;
        changes: Record<string, unknown>;
      }>;
    };
    const created = changeSets.changeSets.filter(
      (set) => set.runId === settlementRuns[0]!.id,
    );
    expect(created).toHaveLength(1);
    expect(created[0]!.status).toBe("candidate");
    const facts = created[0]!.changes.factCandidates as Array<{
      subjectId: string;
      evidence: Array<{ documentVersionId: string }>;
    }>;
    expect(facts[0]!.subjectId).toBe(world.entityId);
    expect(facts[0]!.evidence[0]!.documentVersionId).toBe(versionId);

    /* 结算不追加正文版本：仍只有作者提交的那一版。 */
    const versions = (
      await app.inject({
        method: "GET",
        url: `/api/projects/${world.projectId}/documents/${world.documentId}/versions`,
      })
    ).json() as unknown[];
    expect(versions).toHaveLength(1);
  });

  it("空结算不建变更集（避免裁定面板噪音）", async () => {
    settlementWithCandidates = false;
    const { app } = await setup();
    const world = await createChapterWorld(app);
    await appendVersion(app, world.projectId, world.documentId, "manual");

    const runs = await listRuns(app, world.projectId);
    const settlementRuns = runs.filter(
      (run) => run.recipe === "manual-settlement",
    );
    expect(settlementRuns).toHaveLength(1);
    const finalStatus = await driveRun(
      app,
      settlementRuns[0]!.id,
      world.projectId,
    );
    expect(finalStatus).toBe("completed");

    const changeSets = (
      await app.inject({
        method: "GET",
        url: `/api/projects/${world.projectId}/canon-change-sets`,
      })
    ).json() as { changeSets: unknown[] };
    expect(changeSets.changeSets).toHaveLength(0);
  });

  it("批注存档点与选区基线不触发结算", async () => {
    settlementWithCandidates = false;
    const { app } = await setup();
    const world = await createChapterWorld(app);
    await appendVersion(
      app,
      world.projectId,
      world.documentId,
      "manual:comment-checkpoint",
    );
    await appendVersion(
      app,
      world.projectId,
      world.documentId,
      "manual:selection-baseline",
    );

    const runs = await listRuns(app, world.projectId);
    expect(
      runs.filter((run) => run.recipe === "manual-settlement"),
    ).toHaveLength(0);
  });

  it("恢复历史版本同样触发结算，且钉住恢复后的版本", async () => {
    settlementWithCandidates = false;
    const { app } = await setup();
    const world = await createChapterWorld(app);
    await appendVersion(
      app,
      world.projectId,
      world.documentId,
      "seed",
      MANUSCRIPT,
    );
    await appendVersion(
      app,
      world.projectId,
      world.documentId,
      "manual",
      `${MANUSCRIPT}\n\n尾声一句。`,
    );
    let runs = await listRuns(app, world.projectId);
    expect(
      runs.filter((run) => run.recipe === "manual-settlement"),
    ).toHaveLength(1);

    const versions = (
      await app.inject({
        method: "GET",
        url: `/api/projects/${world.projectId}/documents/${world.documentId}/versions`,
      })
    ).json() as { id: string }[];
    const restoreResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${world.projectId}/documents/${world.documentId}/restore`,
      payload: {
        /* 列表新→旧：[0] 是当前版本，最后一项是最早的种子版本。 */
        targetVersionId: versions.at(-1)!.id,
        expectedCurrentVersionId: versions[0]!.id,
      },
    });
    expect(restoreResponse.statusCode, restoreResponse.body).toBe(201);
    const restoredVersionId = (restoreResponse.json() as { id: string }).id;

    runs = await listRuns(app, world.projectId);
    const settlementRuns = runs.filter(
      (run) => run.recipe === "manual-settlement",
    );
    expect(settlementRuns).toHaveLength(2);
    const restoreRun = settlementRuns.find(
      (run) => run.policy.documentVersionId === restoredVersionId,
    );
    expect(restoreRun).toBeTruthy();
  });

  it("没有可用写作模型时提交照常成功、静默跳过结算", async () => {
    settlementWithCandidates = false;
    const { app } = await setup(false);
    const world = await createChapterWorld(app);
    const versionId = await appendVersion(
      app,
      world.projectId,
      world.documentId,
      "manual",
    );
    expect(versionId).toBeTruthy();
    const runs = await listRuns(app, world.projectId);
    expect(
      runs.filter((run) => run.recipe === "manual-settlement"),
    ).toHaveLength(0);
  });

  it("非章节文档（笔记）不触发结算", async () => {
    settlementWithCandidates = false;
    const { app } = await setup();
    const world = await createChapterWorld(app);
    const noteResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${world.projectId}/documents`,
      payload: {
        requestId: globalThis.crypto.randomUUID(),
        kind: "note",
        title: "创作笔记",
      },
    });
    expect(noteResponse.statusCode).toBe(201);
    const noteId = (noteResponse.json() as { id: string }).id;
    await appendVersion(app, world.projectId, noteId, "manual");

    const runs = await listRuns(app, world.projectId);
    expect(
      runs.filter((run) => run.recipe === "manual-settlement"),
    ).toHaveLength(0);
  });
});
