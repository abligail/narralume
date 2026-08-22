import type { NarrativeModelClient } from "@narralume/narrative";
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

/* 捕获 foundation.generate 的 system instructions 后立即中止步骤：
 * 本测试只关心指令语言随项目语言切换，不关心候选内容。 */
function capturingModel(captured: {
  instructions: string | null;
}): NarrativeModelClient {
  return {
    async structured(_run, _step, _purpose, request) {
      captured.instructions = request.instructions ?? null;
      throw new Error("captured; abort step");
    },
  } as NarrativeModelClient;
}

async function setup(model: NarrativeModelClient) {
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

async function runFoundationOnce(
  app: Awaited<ReturnType<typeof buildApp>>,
  projectId: string,
) {
  const foundation = await app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/foundation/generate`,
    payload: { requestId: `foundation-${projectId}`, braindump: "灯塔与潮汐" },
  });
  expect(foundation.statusCode, foundation.body).toBe(202);
  const runId = (foundation.json() as { run: { id: string } }).run.id;
  // 单次 advance 即触发 foundation.generate；模型桩抛错后运行进入 failed。
  await app.inject({
    method: "POST",
    url: `/api/runs/${runId}/advance`,
    payload: { projectId },
  });
}

describe("project language drives AI instruction language", () => {
  it("renders English system instructions for an English project", async () => {
    const captured = { instructions: null as string | null };
    const { app } = await setup(capturingModel(captured));
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        requestId: "create-en",
        title: "Tide Lantern",
        language: "en",
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const projectId = (created.json() as { id: string }).id;

    await runFoundationOnce(app, projectId);

    expect(captured.instructions).toContain("chief planner");
    expect(captured.instructions).toMatch(/^[A-Za-z]/);
    expect(captured.instructions).not.toMatch(/[\u4e00-\u9fff]/);
  });

  it("keeps Chinese system instructions for the zh-CN default", async () => {
    const captured = { instructions: null as string | null };
    const { app } = await setup(capturingModel(captured));
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { requestId: "create-zh", title: "潮汐灯塔" },
    });
    expect(created.statusCode, created.body).toBe(201);
    const projectId = (created.json() as { id: string }).id;
    expect((created.json() as { language: string }).language).toBe("zh-CN");

    await runFoundationOnce(app, projectId);

    expect(captured.instructions).toContain("你是长篇小说总策划");
  });

  it("persists a language change through the project update route", async () => {
    const { app } = await setup(capturingModel({ instructions: null }));
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { requestId: "create-switch", title: "双语文稿" },
    });
    const project = created.json() as {
      id: string;
      updatedAt: string;
      language: string;
    };

    const updated = await app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}`,
      payload: {
        title: "双语文稿",
        subtitle: null,
        premise: null,
        language: "en",
        archived: false,
        expectedUpdatedAt: project.updatedAt,
      },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect((updated.json() as { language: string }).language).toBe("en");
  });

  it("rejects languages outside the supported enum", async () => {
    const { app } = await setup(capturingModel({ instructions: null }));
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { requestId: "create-fr", title: "Lanterne", language: "fr-FR" },
    });
    expect(created.statusCode).toBe(400);
    expect(created.json()).toMatchObject({
      error: { code: "request.invalid" },
    });
  });
});
