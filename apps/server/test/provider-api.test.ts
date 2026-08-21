import { NodeNarrativeDatabase } from "@narralume/persistence/node";
import { afterEach, describe, expect, it, vi } from "vitest";

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
    enableRunWorker: false,
    logger: false,
  });
  resources.push({ app, database });
  return { app, database };
}

async function createProvider(
  app: Awaited<ReturnType<typeof buildApp>>,
  credentialRef = "raw-secret-key-abcdef",
) {
  const response = await app.inject({
    method: "POST",
    url: "/api/providers",
    payload: {
      name: "自建 Provider",
      wireApi: "openai-chat",
      baseUrl: "https://custom.example.com/v1",
      credentialRef,
    },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json() as {
    id: string;
    credentialRef: string;
    updatedAt: string;
  };
}

describe("provider/model/assignment API", () => {
  it("creates and updates providers without ever exposing the raw credential", async () => {
    const { app } = await setup();
    const created = await createProvider(app);
    expect(created.credentialRef).toBe("••••cdef");

    const listed = await app.inject({ method: "GET", url: "/api/providers" });
    expect(listed.statusCode).toBe(200);
    expect(listed.body).not.toContain("raw-secret-key-abcdef");
    const row = (listed.json() as { id: string; credentialRef: string }[]).find(
      (provider) => provider.id === created.id,
    )!;
    expect(row.credentialRef).toBe("••••cdef");

    // Omitting credentialRef keeps the stored credential.
    const updated = await app.inject({
      method: "PUT",
      url: `/api/providers/${created.id}`,
      payload: {
        name: "自建 Provider（改名）",
        wireApi: "openai-chat",
        baseUrl: "https://custom.example.com/v2",
        expectedUpdatedAt: created.updatedAt,
      },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json()).toMatchObject({
      id: created.id,
      name: "自建 Provider（改名）",
      baseUrl: "https://custom.example.com/v2",
      credentialRef: "••••cdef",
    });

    // A short replacement credential is fully masked.
    const rotated = await app.inject({
      method: "PUT",
      url: `/api/providers/${created.id}`,
      payload: {
        name: "自建 Provider（改名）",
        wireApi: "openai-chat",
        baseUrl: "https://custom.example.com/v2",
        credentialRef: "short",
        expectedUpdatedAt: updated.json().updatedAt,
      },
    });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json().credentialRef).toBe("••••••••");
    expect(rotated.body).not.toContain("short");

    const stale = await app.inject({
      method: "PUT",
      url: `/api/providers/${created.id}`,
      payload: {
        name: "旧页面覆盖",
        wireApi: "openai-chat",
        baseUrl: "https://stale.example.com/v1",
        expectedUpdatedAt: created.updatedAt,
      },
    });
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json()).toMatchObject({
      error: { code: "provider.version.conflict" },
    });

    const missing = await app.inject({
      method: "PUT",
      url: "/api/providers/does-not-exist",
      payload: {
        name: "不存在",
        wireApi: "openai-chat",
        baseUrl: "https://custom.example.com/v1",
        expectedUpdatedAt: "missing",
      },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({
      error: { code: "provider.not_found" },
    });
  });

  it("requires a credentialRef when creating a provider", async () => {
    const { app } = await setup();
    const response = await app.inject({
      method: "POST",
      url: "/api/providers",
      payload: {
        name: "缺密钥",
        wireApi: "openai-chat",
        baseUrl: "https://custom.example.com/v1",
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: { code: "provider.credential.required" },
    });
  });

  it("manages models with duplicate and reference checks", async () => {
    const { app } = await setup();
    const provider = await createProvider(app);

    const missingProvider = await app.inject({
      method: "POST",
      url: "/api/models",
      payload: { providerId: "nope", modelId: "m" },
    });
    expect(missingProvider.statusCode).toBe(404);
    expect(missingProvider.json()).toMatchObject({
      error: { code: "provider.not_found" },
    });

    const created = await app.inject({
      method: "POST",
      url: "/api/models",
      payload: {
        providerId: provider.id,
        modelId: "writer-v1",
        taskType: "writing",
        contextWindow: 32_000,
        maxOutputTokens: 8_000,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({
      metadataSource: "manual",
      metadataVerifiedAt: expect.any(String),
    });
    const createdModel = created.json() as { id: string; updatedAt: string };
    const modelId = createdModel.id;

    const duplicate = await app.inject({
      method: "POST",
      url: "/api/models",
      payload: { providerId: provider.id, modelId: "writer-v1" },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({
      error: { code: "model.duplicate" },
    });

    const filtered = await app.inject({
      method: "GET",
      url: `/api/models?providerId=${provider.id}`,
    });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json()).toEqual([
      expect.objectContaining({ id: modelId, modelId: "writer-v1" }),
    ]);

    const updated = await app.inject({
      method: "PUT",
      url: `/api/models/${modelId}`,
      payload: {
        providerId: provider.id,
        modelId: "writer-v1",
        taskType: "writing",
        contextWindow: 64_000,
        maxOutputTokens: 16_000,
        enabled: true,
        expectedUpdatedAt: createdModel.updatedAt,
      },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json()).toMatchObject({ id: modelId, enabled: true });

    const staleModel = await app.inject({
      method: "PUT",
      url: `/api/models/${modelId}`,
      payload: {
        providerId: provider.id,
        modelId: "writer-v1",
        taskType: "writing",
        contextWindow: 1_000,
        maxOutputTokens: 1_000,
        enabled: true,
        expectedUpdatedAt: createdModel.updatedAt,
      },
    });
    expect(staleModel.statusCode, staleModel.body).toBe(409);
    expect(staleModel.json()).toMatchObject({
      error: { code: "model.version.conflict" },
    });

    // Assignments reference the model and block its deletion.
    const assigned = await app.inject({
      method: "PUT",
      url: "/api/assignments/writing",
      payload: { modelId },
    });
    expect(assigned.statusCode, assigned.body).toBe(200);
    expect(assigned.json()).toMatchObject({ role: "writing", modelId });

    for (const role of ["planning", "review"] as const) {
      const inheritedModel = await app.inject({
        method: "PUT",
        url: `/api/assignments/${role}`,
        payload: { modelId },
      });
      expect(inheritedModel.statusCode, inheritedModel.body).toBe(200);
      expect(inheritedModel.json()).toMatchObject({ role, modelId });
    }

    const blocked = await app.inject({
      method: "DELETE",
      url: `/api/models/${modelId}`,
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({
      error: { code: "model.assignment_in_use" },
    });

    const removedAssignment = await app.inject({
      method: "DELETE",
      url: "/api/assignments/writing",
    });
    expect(removedAssignment.statusCode).toBe(204);
    for (const role of ["planning", "review"] as const) {
      const removed = await app.inject({
        method: "DELETE",
        url: `/api/assignments/${role}`,
      });
      expect(removed.statusCode).toBe(204);
    }

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/models/${modelId}`,
    });
    expect(deleted.statusCode).toBe(204);

    const missingAssignment = await app.inject({
      method: "PUT",
      url: "/api/assignments/review",
      payload: { modelId: "missing-model" },
    });
    expect(missingAssignment.statusCode).toBe(422);
    expect(missingAssignment.json()).toMatchObject({
      error: { code: "assignment.model.not_found" },
    });
  });

  it("refuses to delete environment-managed providers and models", async () => {
    const { app } = await setup();
    const provider = await app.inject({
      method: "DELETE",
      url: "/api/providers/environment-chat",
    });
    expect(provider.statusCode).toBe(409);
    expect(provider.json()).toMatchObject({
      error: { code: "provider.environment_managed" },
    });
    const model = await app.inject({
      method: "DELETE",
      url: "/api/models/environment-chat",
    });
    expect(model.statusCode).toBe(409);
    expect(model.json()).toMatchObject({
      error: { code: "model.environment_managed" },
    });
  });

  it("blocks provider deletion while its models are assignment targets", async () => {
    const { app } = await setup();
    const provider = await createProvider(app);
    const model = await app.inject({
      method: "POST",
      url: "/api/models",
      payload: {
        providerId: provider.id,
        modelId: "writer-v1",
        contextWindow: 64_000,
        maxOutputTokens: 16_000,
      },
    });
    const modelId = (model.json() as { id: string }).id;
    await app.inject({
      method: "PUT",
      url: "/api/assignments/writing",
      payload: { modelId },
    });
    const blocked = await app.inject({
      method: "DELETE",
      url: `/api/providers/${provider.id}`,
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({
      error: { code: "provider.assignment_in_use" },
    });
  });

  it("blocks provider deletion while it still owns an unassigned model", async () => {
    const { app } = await setup();
    const provider = await createProvider(app);
    await app.inject({
      method: "POST",
      url: "/api/models",
      payload: { providerId: provider.id, modelId: "unassigned-v1" },
    });

    const blocked = await app.inject({
      method: "DELETE",
      url: `/api/providers/${provider.id}`,
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({
      error: { code: "provider.models_in_use" },
    });
  });

  it("probes a provider/model pair and reports credential failures without network", async () => {
    const { app } = await setup();
    const missingProvider = await app.inject({
      method: "POST",
      url: "/api/providers/test",
      payload: { providerId: "nope", modelId: "nope" },
    });
    expect(missingProvider.statusCode).toBe(404);
    expect(missingProvider.json()).toMatchObject({
      error: { code: "provider.not_found" },
    });

    const provider = await createProvider(app, "env:NARRATIVE_UNSET_PROBE_KEY");
    const model = await app.inject({
      method: "POST",
      url: "/api/models",
      payload: { providerId: provider.id, modelId: "writer-v1" },
    });
    const modelId = (model.json() as { id: string }).id;

    const missingModel = await app.inject({
      method: "POST",
      url: "/api/providers/test",
      payload: { providerId: provider.id, modelId: "nope" },
    });
    expect(missingModel.statusCode).toBe(404);
    expect(missingModel.json()).toMatchObject({
      error: { code: "model.not_found" },
    });

    const probed = await app.inject({
      method: "POST",
      url: "/api/providers/test",
      payload: { providerId: provider.id, modelId },
    });
    expect(probed.statusCode, probed.body).toBe(200);
    expect(probed.json()).toMatchObject({
      providerId: provider.id,
      modelId,
      stages: [
        {
          stage: "text",
          status: "failed",
          detail:
            "Environment variable NARRATIVE_UNSET_PROBE_KEY is not configured",
        },
      ],
    });
  });

  it("probe refreshes capability flags but never rewrites wireApi or modelId", async () => {
    const { app } = await setup();
    const provider = await createProvider(app);
    const created = await app.inject({
      method: "POST",
      url: "/api/models",
      payload: { providerId: provider.id, modelId: "writer-v1" },
    });
    expect(created.statusCode, created.body).toBe(201);
    const modelId = (created.json() as { id: string }).id;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        const body = JSON.parse(
          typeof init?.body === "string" ? init.body : "{}",
        ) as Record<string, unknown>;
        if (body.stream === true) return probeStreamResponse();
        if (Array.isArray(body.tools)) {
          return probeChatResponse({
            id: "chatcmpl-tool",
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: "call-1",
                      type: "function",
                      function: {
                        name: "echo_probe",
                        arguments: '{"value":"lantern"}',
                      },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
          });
        }
        if (body.response_format)
          return probeChatResponse(probeText('{"ok":true}'));
        return probeChatResponse(probeText("OK"));
      }),
    );
    try {
      const probed = await app.inject({
        method: "POST",
        url: "/api/providers/test",
        payload: { providerId: provider.id, modelId },
      });
      expect(probed.statusCode, probed.body).toBe(200);
      const stages = (
        probed.json() as { stages: { stage: string; status: string }[] }
      ).stages;
      expect(stages).toEqual([
        expect.objectContaining({ stage: "text", status: "passed" }),
        expect.objectContaining({ stage: "stream", status: "passed" }),
        expect.objectContaining({ stage: "tool", status: "passed" }),
        expect.objectContaining({
          stage: "structured-output",
          status: "passed",
        }),
      ]);
    } finally {
      vi.unstubAllGlobals();
    }

    // The probe must only touch capability flags: wire identity is unchanged.
    const providers = await app.inject({
      method: "GET",
      url: "/api/providers",
    });
    const storedProvider = (
      providers.json() as Array<Record<string, unknown>>
    ).find((candidate) => candidate.id === provider.id)!;
    expect(storedProvider).toMatchObject({
      wireApi: "openai-chat",
      baseUrl: "https://custom.example.com/v1",
    });
    const models = await app.inject({ method: "GET", url: "/api/models" });
    const storedModel = (models.json() as Array<Record<string, unknown>>).find(
      (candidate) => candidate.id === modelId,
    )!;
    expect(storedModel.modelId).toBe("writer-v1");
    expect(storedModel.capabilities).toMatchObject({
      streaming: true,
      tools: true,
      structuredOutput: true,
      structuredOutputNative: true,
      structuredOutputJsonMode: false,
    });
  });

  it("does not overwrite a model edited while its connection probe is running (CR-48)", async () => {
    const { app } = await setup();
    const provider = await createProvider(app);
    const created = await app.inject({
      method: "POST",
      url: "/api/models",
      payload: { providerId: provider.id, modelId: "writer-v1" },
    });
    expect(created.statusCode, created.body).toBe(201);
    const model = created.json() as { id: string; updatedAt: string };

    let markStarted!: () => void;
    let releaseProbe!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        markStarted();
        await gate;
        return probeChatResponse(probeText("OK"));
      }),
    );
    try {
      const probing = app.inject({
        method: "POST",
        url: "/api/providers/test",
        payload: {
          providerId: provider.id,
          modelId: model.id,
          includeStreaming: false,
          includeTools: false,
          includeStructuredOutput: false,
        },
      });
      await started;
      const edited = await app.inject({
        method: "PUT",
        url: `/api/models/${model.id}`,
        payload: {
          providerId: provider.id,
          modelId: "writer-v1",
          taskType: "writing",
          contextWindow: 64_000,
          maxOutputTokens: 8_000,
          enabled: true,
          expectedUpdatedAt: model.updatedAt,
        },
      });
      expect(edited.statusCode, edited.body).toBe(200);
      releaseProbe();

      const result = await probing;
      expect(result.statusCode, result.body).toBe(409);
      expect(result.json()).toMatchObject({
        error: { code: "model.version.conflict" },
      });
      const listed = await app.inject({ method: "GET", url: "/api/models" });
      expect(
        listed
          .json()
          .find((candidate: { id: string }) => candidate.id === model.id),
      ).toMatchObject({
        contextWindow: 64_000,
        maxOutputTokens: 8_000,
        capabilities: {},
      });
    } finally {
      releaseProbe();
      vi.unstubAllGlobals();
    }
  });
});

function probeText(content: string) {
  return {
    id: "chatcmpl-probe",
    choices: [{ message: { content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
  };
}

function probeChatResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function probeStreamResponse(): Response {
  const frames = [
    `data: ${JSON.stringify({
      id: "chatcmpl-stream",
      choices: [{ delta: { content: "OK" }, finish_reason: null }],
    })}\n\n`,
    `data: ${JSON.stringify({
      id: "chatcmpl-stream",
      choices: [{ delta: {}, finish_reason: "stop" }],
    })}\n\n`,
    `data: ${JSON.stringify({
      id: "chatcmpl-stream",
      choices: [],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    })}\n\n`,
    "data: [DONE]\n\n",
  ];
  return new Response(new TextEncoder().encode(frames.join("")), {
    headers: { "content-type": "text/event-stream" },
  });
}
