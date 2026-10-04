import { createServer, type Server, type ServerResponse } from "node:http";

import {
  SqliteLlmCallRepository,
  SqliteRunRepository,
  SqliteRunStreamRepository,
} from "@narralume/persistence";
import { NodeNarrativeDatabase } from "@narralume/persistence/node";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";

/**
 * End-to-end fault injection against a LOCAL fake provider HTTP server. The
 * app runs with the real GatewayNarrativeModelClient (no scripted model), so
 * every scenario exercises the full stack: server → harness → model-client →
 * transport → fake provider over real HTTP.
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
  provider: FakeProvider;
}[] = [];

afterEach(async () => {
  while (resources.length) {
    const resource = resources.pop()!;
    await resource.app.close();
    resource.database.close();
    await resource.provider.close();
  }
});

// ---------------------------------------------------------------------------
// Fake OpenAI Chat Completions provider
// ---------------------------------------------------------------------------

interface ChatCompletionRequestBody {
  model?: string;
  stream?: boolean;
  messages?: Array<{ role?: string; content?: unknown }>;
  response_format?: { type?: string; json_schema?: { name?: string } };
}

type FakePlan =
  /** 200 JSON (non-streaming) chat completion carrying `content`. */
  | { kind: "json"; content: string }
  /** 200 SSE stream: chunks, then finish_reason=stop + usage + [DONE]. */
  | { kind: "sse"; chunks: string[]; intervalMs?: number }
  /** 200 SSE stream: chunks, then silence forever (stream idle timeout). */
  | { kind: "sse-stall"; chunks: string[]; intervalMs?: number }
  /** Accept the request and never answer (request-start timeout). */
  | { kind: "hang" }
  /** Error status with a JSON error body and an x-request-id header. */
  | { kind: "status"; status: number; message: string };

type FakeHandler = (call: {
  body: ChatCompletionRequestBody;
  index: number;
}) => FakePlan;

interface FakeProvider {
  baseUrl: string;
  requests: ChatCompletionRequestBody[];
  handler: FakeHandler;
  close(): Promise<void>;
}

async function startFakeProvider(handler: FakeHandler): Promise<FakeProvider> {
  const requests: ChatCompletionRequestBody[] = [];
  const provider: FakeProvider = {
    baseUrl: "",
    requests,
    handler,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  const server: Server = createServer((request, response) => {
    request.on("error", () => {});
    response.on("error", () => {});
    if (
      request.method !== "POST" ||
      !request.url?.includes("/chat/completions")
    ) {
      response.writeHead(404).end();
      return;
    }
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      let body: ChatCompletionRequestBody;
      try {
        body = JSON.parse(raw) as ChatCompletionRequestBody;
      } catch {
        response
          .writeHead(400)
          .end(JSON.stringify({ error: { message: "bad json" } }));
        return;
      }
      requests.push(body);
      const plan = provider.handler({ body, index: requests.length - 1 });
      executePlan(plan, response, `fake-req-${requests.length}`);
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fake provider did not bind a port");
  }
  provider.baseUrl = `http://127.0.0.1:${address.port}/v1`;
  return provider;
}

function executePlan(
  plan: FakePlan,
  response: ServerResponse,
  requestId: string,
): void {
  switch (plan.kind) {
    case "hang":
      // Never answer; the socket is reclaimed by closeAllConnections or by the
      // client aborting.
      return;
    case "status":
      response.writeHead(plan.status, {
        "content-type": "application/json",
        "x-request-id": requestId,
      });
      response.end(
        JSON.stringify({ error: { message: plan.message, type: "fake" } }),
      );
      return;
    case "json":
      response.writeHead(200, {
        "content-type": "application/json",
        "x-request-id": requestId,
      });
      response.end(JSON.stringify(chatCompletion(plan.content)));
      return;
    case "sse":
    case "sse-stall": {
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        "x-request-id": requestId,
      });
      const intervalMs = plan.intervalMs ?? 1;
      let index = 0;
      const writeNext = () => {
        if (response.destroyed || response.writableEnded) return;
        if (index < plan.chunks.length) {
          response.write(sseChunk(plan.chunks[index]!));
          index += 1;
          setTimeout(writeNext, intervalMs);
          return;
        }
        if (plan.kind === "sse") {
          response.write(sseFinalChunk());
          response.write("data: [DONE]\n\n");
          response.end();
        }
        // sse-stall: keep the socket open without writing ever again.
      };
      writeNext();
      return;
    }
  }
}

function sseChunk(text: string): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-fake",
    object: "chat.completion.chunk",
    created: 1_700_000_000,
    model: "fake-model",
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  })}\n\n`;
}

function sseFinalChunk(): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-fake",
    object: "chat.completion.chunk",
    created: 1_700_000_000,
    model: "fake-model",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 },
  })}\n\n`;
}

function chatCompletion(content: string): Record<string, unknown> {
  return {
    id: "chatcmpl-fake",
    object: "chat.completion",
    created: 1_700_000_000,
    model: "fake-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 },
  };
}

// ---------------------------------------------------------------------------
// Healthy fake output
// ---------------------------------------------------------------------------

/** ~200 chars of varied prose: passes minChapterCharacters=100 and the
 * deterministic checks (no repeated phrases, duplicate paragraphs, cliches). */
const MANUSCRIPT =
  "雾从海面推上石阶，林昼把手按在冰冷的门上，听见灯塔深处传来第三下钟声。她沿着旋梯向上，每一级都沾着尚未干透的海水。\n\n" +
  "塔顶的灯室空着，透镜蒙了一层盐霜。林昼点亮备用的油灯，火光舔上玻璃罩，把她的影子投在墙上，像另一个守塔人。\n\n" +
  "灯灭的一刻，父亲忽然问她为何对着空椅子说话。窗外所有船铃同时沉默，港口刚刚吞掉了一个无人敢说出的名字。林昼把这句话记进灯塔日志，墨迹未干，钟声又响了一下。\n\n" +
  "她合上日志，吹熄油灯，摸黑走下旋梯。海面在脚下翻涌，雾里没有一艘船亮着灯。";

const SCENE_PLAN = {
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
};

const REVIEW_PASS = {
  summary: "章节目标已经完成。",
  scores: { continuity: 92, pacing: 88, character: 86, prose: 85, goal: 94 },
  issues: [],
};

const SETTLEMENT = {
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
};

function chunkText(text: string, size: number): string[] {
  const chars = [...text];
  const chunks: string[] = [];
  for (let index = 0; index < chars.length; index += size) {
    chunks.push(chars.slice(index, index + size).join(""));
  }
  return chunks;
}

/** Structured calls are non-streaming; the schema name rides in
 * response_format (native/json-mode attempts) or the system instructions
 * (prompt/repair fallback attempts). */
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

function healthyStructuredPayload(body: ChatCompletionRequestBody): string {
  switch (schemaNameOf(body)) {
    case "chapter_scene_plan":
      return JSON.stringify(SCENE_PLAN);
    case "evidence_grounded_chapter_review":
      return JSON.stringify(REVIEW_PASS);
    case "chapter_settlement_candidates":
      return JSON.stringify(SETTLEMENT);
    default:
      return JSON.stringify(SCENE_PLAN);
  }
}

/** Default behavior: valid output for every call. */
function healthyHandler({
  body,
}: {
  body: ChatCompletionRequestBody;
}): FakePlan {
  if (body.stream) {
    return { kind: "sse", chunks: chunkText(MANUSCRIPT, 30), intervalMs: 1 };
  }
  return { kind: "json", content: healthyStructuredPayload(body) };
}

// ---------------------------------------------------------------------------
// App / API helpers
// ---------------------------------------------------------------------------

async function setup(handler: FakeHandler = healthyHandler) {
  const provider = await startFakeProvider(handler);
  const database = new NodeNarrativeDatabase();
  const app = await buildApp({
    config,
    database,
    environment: {},
    enableRunWorker: false,
    logger: false,
  });
  resources.push({ app, database, provider });

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

  for (const role of ["writing"]) {
    const assigned = await app.inject({
      method: "PUT",
      url: `/api/assignments/${role}`,
      payload: { modelId },
    });
    expect(assigned.statusCode, assigned.body).toBe(200);
  }
  return { app, database, provider };
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
  policy: Record<string, unknown> = {},
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/runs/chapter`,
    payload: {
      requestId: `fault-run-${chapterId}`,
      targetOutlineNodeId: chapterId,
      maxRevisionCycles: 0,
      policy: { minChapterCharacters: 100, retryBaseDelayMs: 1, ...policy },
    },
  });
  expect(response.statusCode, response.body).toBe(202);
  return (response.json() as { run: { id: string } }).run.id;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Drives a run via the advance endpoint until it reaches a terminal status
 * (or awaits user, when approvals are disabled). Backoff-delayed retries make
 * the job briefly unavailable, so unprocessed advances retry after a short
 * real wait (retryBaseDelayMs=1 keeps the backoff at ~1ms).
 */
async function driveRun(
  app: Awaited<ReturnType<typeof buildApp>>,
  runId: string,
  projectId: string,
  options: { approve?: boolean; maxIterations?: number } = {},
): Promise<string> {
  let status = "pending";
  for (let index = 0; index < (options.maxIterations ?? 40); index += 1) {
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
    if (status === "awaiting_user") {
      if (!options.approve) return status;
      const approval = await app.inject({
        method: "POST",
        url: `/api/runs/${runId}/actions`,
        payload: { action: "accept_manuscript", projectId },
      });
      expect(approval.statusCode, approval.body).toBe(200);
      continue;
    }
    if (!body.processed) await sleep(15);
  }
  return status;
}

function runEvents(database: NodeNarrativeDatabase, runId: string) {
  return new SqliteRunRepository(database).getSnapshot(runId).events;
}

function eventTypes(database: NodeNarrativeDatabase, runId: string): string[] {
  return runEvents(database, runId).map((event) => event.type);
}

function llmCalls(database: NodeNarrativeDatabase, runId: string) {
  return new SqliteLlmCallRepository(database).listForRun(runId);
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

describe("fault injection: HTTP status faults", () => {
  it("401 fails the run fast: fatal shortcut, no retry, exactly one call", async () => {
    const { app, database } = await setup(() => ({
      kind: "status",
      status: 401,
      message: "invalid api key",
    }));
    const target = await createProjectAndChapter(app);
    const runId = await createRun(app, target.projectId, target.chapterId);

    expect(await driveRun(app, runId, target.projectId)).toBe("failed");

    const types = eventTypes(database, runId);
    expect(types).not.toContain("run.step.retry_scheduled");
    expect(types).not.toContain("run.step.retry_exhausted");
    const fatal = runEvents(database, runId).find(
      (event) => event.type === "run.fatal_shortcut",
    );
    expect(fatal).toBeDefined();
    expect(fatal!.payload).toMatchObject({ category: "authentication" });

    const calls = llmCalls(database, runId);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      purpose: "scene-plan",
      status: "failed",
    });
    expect(calls[0]!.error).toMatchObject({
      code: "model.authentication",
      retryable: false,
      status: 401,
      requestId: "fake-req-1",
    });
    const snapshot = new SqliteRunRepository(database).getSnapshot(runId);
    const planStep = snapshot.steps.find((step) => step.kind === "scene.plan")!;
    expect(planStep.status).toBe("failed");
    expect(planStep.attempt).toBe(1);
    expect(planStep.error).toMatchObject({ code: "model.authentication" });
  });

  it("429 then success: one retry_scheduled with waitMs/nextAttemptAt, run completes", async () => {
    // The first draft request fails. The transport does not retry; the Harness
    // schedules the second logical call, which succeeds.
    let draftRequests = 0;
    const { app, database, provider } = await setup((call) => {
      if (call.body.stream) {
        draftRequests += 1;
        if (draftRequests <= 1) {
          return { kind: "status", status: 429, message: "rate limited" };
        }
      }
      return healthyHandler(call);
    });
    const target = await createProjectAndChapter(app);
    const runId = await createRun(app, target.projectId, target.chapterId);

    expect(
      await driveRun(app, runId, target.projectId, { approve: true }),
    ).toBe("completed");

    // Exactly one harness retry was scheduled, carrying the backoff audit
    // trail (waitMs/nextAttemptAt).
    const retries = runEvents(database, runId).filter(
      (event) => event.type === "run.step.retry_scheduled",
    );
    expect(retries).toHaveLength(1);
    expect(retries[0]!.payload).toMatchObject({
      attempt: 1,
      maxAttempts: 5,
      reason: "model.rate_limit",
      category: "rate_limit",
    });
    expect(retries[0]!.payload.waitMs).toEqual(expect.any(Number));
    expect(typeof retries[0]!.payload.nextAttemptAt).toBe("string");
    expect(eventTypes(database, runId)).not.toContain(
      "run.step.retry_exhausted",
    );

    // Two logical draft calls, each containing exactly one physical request.
    const draft = llmCalls(database, runId).filter(
      (call) => call.purpose === "chapter-draft",
    );
    expect(draft).toHaveLength(2);
    expect(draft[0]).toMatchObject({ status: "failed" });
    expect(draft[0]!.error).toMatchObject({
      code: "model.rate_limit",
      status: 429,
    });
    expect(draft[1]).toMatchObject({ status: "completed" });
    expect(provider.requests.filter((request) => request.stream)).toHaveLength(
      2,
    );
    expect(draft.map((call) => call.details?.physicalAttempts)).toEqual([1, 1]);
    // The whole run went through: plan + draft×2 + review + settle.
    expect(llmCalls(database, runId)).toHaveLength(5);
    expect(provider.requests.length).toBe(5);
    expect(
      new SqliteRunRepository(database).getRun(runId)?.budgetUsage.calls,
    ).toBe(5);
  });

  it("500 always: retry budget exhausts and the run fails with retry_exhausted", async () => {
    const { app, database, provider } = await setup(() => ({
      kind: "status",
      status: 500,
      message: "upstream exploded",
    }));
    const target = await createProjectAndChapter(app);
    const runId = await createRun(app, target.projectId, target.chapterId);

    expect(await driveRun(app, runId, target.projectId)).toBe("failed");

    const events = runEvents(database, runId);
    const retries = events.filter(
      (event) => event.type === "run.step.retry_scheduled",
    );
    expect(retries).toHaveLength(4);
    expect(retries[0]!.payload).toMatchObject({
      attempt: 1,
      maxAttempts: 5,
      category: "server",
      reason: "model.server",
    });
    const exhausted = events.find(
      (event) => event.type === "run.step.retry_exhausted",
    );
    expect(exhausted).toBeDefined();
    expect(exhausted!.payload).toMatchObject({
      attempts: 5,
      reason: "attempts_exhausted",
    });

    // Harness retry is the only retry layer: five logical calls, five requests.
    expect(provider.requests).toHaveLength(5);
    const calls = llmCalls(database, runId);
    expect(calls).toHaveLength(5);
    expect(calls.map((call) => call.status)).toEqual([
      "failed",
      "failed",
      "failed",
      "failed",
      "failed",
    ]);
    expect(calls.map((call) => call.details?.physicalAttempts)).toEqual([
      1, 1, 1, 1, 1,
    ]);
    expect(calls[0]!.error).toMatchObject({
      code: "model.server",
      status: 500,
    });
    expect(calls[4]!.error).toMatchObject({
      code: "model.server",
      status: 500,
    });
    const snapshot = new SqliteRunRepository(database).getSnapshot(runId);
    expect(snapshot.run.budgetUsage.calls).toBe(5);
    expect(
      snapshot.steps.find((step) => step.kind === "scene.plan"),
    ).toMatchObject({ status: "failed", attempt: 5 });
  });
});

describe("fault injection: timeouts", () => {
  it("request-start timeout: hang before headers is bounded, classified retryable, retried", async () => {
    const { app, database, provider } = await setup(() => ({ kind: "hang" }));
    const target = await createProjectAndChapter(app);
    // policy.requestStartTimeoutMs bounds the dispatch→headers phase. It also
    // flows through the shared execution policy into the transport's
    // per-attempt timeout, so on this path the harness-observable step error is
    // the generic retryable timeout (the transport's dedicated
    // request_start_timeout reason only fires when the start budget is strictly
    // smaller than the attempt timeout). The contract we assert: a provider
    // that hangs before headers is cut after ~300ms (not the default 120s),
    // the timeout is classified retryable, and the harness schedules retries.
    const runId = await createRun(app, target.projectId, target.chapterId, {
      requestStartTimeoutMs: 300,
    });

    expect(await driveRun(app, runId, target.projectId)).toBe("failed");

    const events = runEvents(database, runId);
    const retries = events.filter(
      (event) => event.type === "run.step.retry_scheduled",
    );
    expect(retries.length).toBeGreaterThanOrEqual(1);
    expect(retries[0]!.payload).toMatchObject({
      category: "request_start_timeout",
      reason: "request_start_timeout",
    });
    expect(
      events.find((event) => event.type === "run.step.retry_exhausted"),
    ).toBeDefined();

    const calls = llmCalls(database, runId);
    expect(calls).toHaveLength(5);
    for (const call of calls) {
      expect(call.status).toBe("failed");
      expect(call.error).toMatchObject({
        code: "request_start_timeout",
        retryable: true,
      });
      // Each hung attempt was bounded by the 300ms start budget, not by the
      // default 120s attempt timeout.
      expect(call.durationMs).toBeGreaterThanOrEqual(200);
      expect(call.durationMs).toBeLessThan(5_000);
    }
    expect(provider.requests).toHaveLength(5);
    const snapshot = new SqliteRunRepository(database).getSnapshot(runId);
    expect(snapshot.run.budgetUsage.calls).toBe(5);
    expect(
      snapshot.steps.find((step) => step.kind === "scene.plan"),
    ).toMatchObject({ status: "failed", attempt: 5 });
  });

  it("stream-idle timeout: partial text is preserved and the step is retried", async () => {
    const PARTIAL = "雾从海面推上石阶，林昼把手按在冰冷的门上。";
    const { app, database } = await setup((call) => {
      if (call.body.stream) {
        return { kind: "sse-stall", chunks: [PARTIAL] };
      }
      return healthyHandler(call);
    });
    const target = await createProjectAndChapter(app);
    const runId = await createRun(app, target.projectId, target.chapterId, {
      streamIdleTimeoutMs: 300,
    });

    // The draft's stream stalls every attempt, so the retry budget exhausts.
    expect(await driveRun(app, runId, target.projectId)).toBe("failed");

    // stream_idle_timeout on the wire is classified retryable, so the harness
    // schedules a retry before exhausting the budget.
    const retries = runEvents(database, runId).filter(
      (event) => event.type === "run.step.retry_scheduled",
    );
    expect(retries).toHaveLength(4);
    expect(retries[0]!.payload).toMatchObject({
      category: "stream_idle_timeout",
      reason: "stream_idle_timeout",
    });
    expect(
      runEvents(database, runId).find(
        (event) => event.type === "run.step.retry_exhausted",
      ),
    ).toBeDefined();

    const snapshot = new SqliteRunRepository(database).getSnapshot(runId);
    // One successful scene-plan request plus five stalled draft requests.
    expect(snapshot.run.budgetUsage.calls).toBe(6);
    const draftStep = snapshot.steps.find(
      (step) => step.kind === "draft.generate",
    )!;
    expect(draftStep).toMatchObject({ status: "failed", attempt: 5 });
    expect(draftStep.error).toMatchObject({
      code: "stream_idle_timeout",
      retryable: true,
    });

    // Each stalled attempt preserved its partial text, marked interrupted.
    const streams = new SqliteRunStreamRepository(database);
    const first = streams.get(runId, draftStep.id, 1);
    expect(first).toMatchObject({ status: "interrupted" });
    expect(first!.content).toContain(PARTIAL);
    const second = streams.get(runId, draftStep.id, 2);
    expect(second).toMatchObject({ status: "interrupted" });
    expect(second!.content).toContain(PARTIAL);

    const draft = llmCalls(database, runId).filter(
      (call) => call.purpose === "chapter-draft",
    );
    expect(draft).toHaveLength(5);
    expect(draft[0]).toMatchObject({ status: "failed" });
    expect(draft[0]!.error).toMatchObject({
      code: "stream_idle_timeout",
      reason: "stream_idle_timeout",
      retryable: true,
    });
    expect(draft[4]).toMatchObject({ status: "failed" });
  });
});

describe("fault injection: protocol faults", () => {
  it("invalid structured output: repair attempt persisted, step-level retry exhausts with retry_exhausted", async () => {
    const { app, database, provider } = await setup((call) => {
      if (call.body.stream) return healthyHandler(call);
      // Garbage that neither parses as JSON nor validates. This model has no
      // verified structured capability, so the production tier plan is
      // prompt-only; maxRepairAttempts adds one repair round.
      return { kind: "json", content: "抱歉，我无法完成这个请求。" };
    });
    const target = await createProjectAndChapter(app);
    const runId = await createRun(app, target.projectId, target.chapterId, {
      maxRepairAttempts: 1,
    });

    expect(await driveRun(app, runId, target.projectId)).toBe("failed");

    const events = runEvents(database, runId);
    const repairs = events.filter(
      (event) => event.type === "run.llm.repair_attempt",
    );
    expect(repairs).toHaveLength(5);
    expect(repairs[0]!.payload).toMatchObject({
      purpose: "scene-plan",
      attempt: 2,
      mode: "repair",
      valid: false,
    });
    // 校验失败是随机采样问题：harness 把它当 step 级可重试错误退避重试，
    // 配方 maxAttempts=5 封顶。
    const retries = events.filter(
      (event) => event.type === "run.step.retry_scheduled",
    );
    expect(retries).toHaveLength(4);
    expect(retries[0]!.payload).toMatchObject({
      reason: "model.structured_output",
      // "protocol" 不在已知类别集合里：归类 unknown，retryable 由错误自身携带。
      category: null,
    });
    expect(
      events.find((event) => event.type === "run.step.retry_exhausted"),
    ).toBeDefined();

    // 每个逻辑调用内部烧 2 次物理尝试（prompt/repair）。
    const calls = llmCalls(database, runId);
    expect(calls).toHaveLength(5);
    expect(calls.map((call) => call.status)).toEqual([
      "failed",
      "failed",
      "failed",
      "failed",
      "failed",
    ]);
    expect(calls[0]!.error).toMatchObject({
      code: "model.structured_output",
      retryable: true,
    });
    expect(calls[0]!.details).toMatchObject({
      physicalAttempts: 2,
      repairAttempts: 1,
    });
    expect(provider.requests.length).toBe(10);
    const snapshot = new SqliteRunRepository(database).getSnapshot(runId);
    expect(snapshot.run.budgetUsage.calls).toBe(10);
    expect(
      snapshot.steps.find((step) => step.kind === "scene.plan"),
    ).toMatchObject({ status: "failed", attempt: 5 });
    expect(snapshot.run.status).toBe("failed");
  });

  it("settlement validation issue then recovery: step retry adopts the next valid output", async () => {
    // 第一次结算输出带语义违规（非 character 认知携带 knowledgeSubjectId），
    // 第二个逻辑调用恢复健康——证明随机采样类校验失败值得 step 级重试。
    // 未知能力只走 prompt；第一次逻辑调用返回违规内容并失败，随后由
    // harness 进行 step 级重试，第二次逻辑调用拿到健康输出。
    let settlementRequests = 0;
    const { app, database } = await setup((call) => {
      if (schemaNameOf(call.body) === "chapter_settlement_candidates") {
        settlementRequests += 1;
        if (settlementRequests === 1) {
          const invalid = {
            ...SETTLEMENT,
            factCandidates: [
              {
                operation: "assert",
                factId: null,
                subjectId: "entity-1",
                predicate: "层出口规则",
                objectEntityId: null,
                value: "每层出口需要愿望钥匙",
                knowledgeScope: "omniscient",
                knowledgeSubjectId: "entity-1",
                belief: "known",
                evidenceParagraphs: [1],
              },
            ],
          };
          return { kind: "json", content: JSON.stringify(invalid) };
        }
        return { kind: "json", content: JSON.stringify(SETTLEMENT) };
      }
      return healthyHandler(call);
    });
    const target = await createProjectAndChapter(app);
    const runId = await createRun(app, target.projectId, target.chapterId, {
      maxRepairAttempts: 0,
    });

    expect(
      await driveRun(app, runId, target.projectId, { approve: true }),
    ).toBe("completed");

    const settleStep = new SqliteRunRepository(database)
      .getSnapshot(runId)
      .steps.find((step) => step.kind === "chapter.settle");
    // 违规输出触发 step 级重试，第二次尝试成功。
    expect(settleStep).toMatchObject({ status: "succeeded", attempt: 2 });
    expect(settleStep!.outputArtifact).toMatchObject({
      generation: { mode: "prompt", attempts: 1 },
    });

    const settleCalls = llmCalls(database, runId).filter(
      (call) => call.purpose === "chapter-settlement",
    );
    expect(settleCalls).toHaveLength(2);
    expect(settleCalls.map((call) => call.status)).toEqual([
      "failed",
      "completed",
    ]);
  });
});

describe("fault injection: cancellation and deadlines", () => {
  it("cancel mid-stream aborts the active HTTP call promptly and preserves the partial", async () => {
    // 60 chunks × 100ms ≈ 6s of streaming if left alone.
    const { app, database, provider } = await setup((call) => {
      if (call.body.stream) {
        return {
          kind: "sse",
          chunks: chunkText(MANUSCRIPT.padEnd(1_800, "。"), 30),
          intervalMs: 100,
        };
      }
      return healthyHandler(call);
    });
    const target = await createProjectAndChapter(app);
    const runId = await createRun(app, target.projectId, target.chapterId);

    // Drive context.compile and scene.plan, then start the draft step without
    // awaiting it so we can cancel while the stream is in flight.
    await app.inject({
      method: "POST",
      url: `/api/runs/${runId}/advance`,
      payload: { projectId: target.projectId },
    });
    await app.inject({
      method: "POST",
      url: `/api/runs/${runId}/advance`,
      payload: { projectId: target.projectId },
    });
    const advancing = app.inject({
      method: "POST",
      url: `/api/runs/${runId}/advance`,
      payload: { projectId: target.projectId },
    });

    // Wait until the draft stream has actually started producing text.
    const streams = new SqliteRunStreamRepository(database);
    const deadline = Date.now() + 5_000;
    let partial = "";
    while (Date.now() < deadline) {
      partial = streams
        .listForRun(runId)
        .map((stream) => stream.content)
        .join("");
      if (partial.length > 0) break;
      await sleep(25);
    }
    expect(partial.length).toBeGreaterThan(0);

    const cancelStarted = Date.now();
    const cancelled = await app.inject({
      method: "POST",
      url: `/api/runs/${runId}/actions`,
      payload: { action: "cancel", projectId: target.projectId },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    const advanced = await advancing;
    const cancelElapsed = Date.now() - cancelStarted;
    expect(advanced.statusCode, advanced.body).toBe(200);
    // The in-flight HTTP call was aborted promptly instead of running the
    // full ~6s stream.
    expect(cancelElapsed).toBeLessThan(2_000);

    const snapshot = new SqliteRunRepository(database).getSnapshot(runId);
    const draftStep = snapshot.steps.find(
      (step) => step.kind === "draft.generate",
    )!;
    expect(draftStep.status).toBe("failed");
    expect(draftStep.error).toMatchObject({ code: "model.cancelled" });

    const draft = llmCalls(database, runId).find(
      (call) => call.purpose === "chapter-draft",
    );
    expect(draft).toMatchObject({ status: "cancelled" });

    const stream = streams.get(runId, draftStep.id, 1);
    expect(stream).toMatchObject({ status: "interrupted" });
    expect(stream!.content.length).toBeGreaterThan(0);
    expect(stream!.content.length).toBeLessThan(MANUSCRIPT.length + 1_800);

    // The cancel routes to a terminal cancelled run without any retry.
    expect(await driveRun(app, runId, target.projectId)).toBe("cancelled");
    expect(eventTypes(database, runId)).not.toContain(
      "run.step.retry_scheduled",
    );
    expect(provider.requests.filter((request) => request.stream)).toHaveLength(
      1,
    );
  });

  it("step deadline: slow-but-healthy stream is cut by stepDeadlineMs as a fatal deadline_exceeded", async () => {
    const { app, database } = await setup((call) => {
      if (call.body.stream) {
        return {
          kind: "sse",
          chunks: chunkText(MANUSCRIPT.padEnd(1_800, "。"), 30),
          intervalMs: 100,
        };
      }
      return healthyHandler(call);
    });
    const target = await createProjectAndChapter(app);
    const runId = await createRun(app, target.projectId, target.chapterId, {
      stepDeadlineMs: 800,
    });

    expect(await driveRun(app, runId, target.projectId)).toBe("failed");

    const events = runEvents(database, runId);
    const deadlineEvent = events.find(
      (event) => event.type === "run.step.deadline_exceeded",
    );
    expect(deadlineEvent).toBeDefined();
    expect(deadlineEvent!.payload).toMatchObject({ deadlineScope: "step" });
    const fatal = events.find((event) => event.type === "run.fatal_shortcut");
    expect(fatal).toBeDefined();
    expect(fatal!.payload).toMatchObject({ category: "deadline_exceeded" });
    expect(eventTypes(database, runId)).not.toContain(
      "run.step.retry_scheduled",
    );

    const snapshot = new SqliteRunRepository(database).getSnapshot(runId);
    const draftStep = snapshot.steps.find(
      (step) => step.kind === "draft.generate",
    )!;
    expect(draftStep.status).toBe("failed");
    expect(draftStep.attempt).toBe(1);
    expect(draftStep.error).toMatchObject({
      code: "deadline_exceeded",
      retryable: false,
    });
    expect(draftStep.error?.details).toMatchObject({ deadlineScope: "step" });
  });
});

// ---------------------------------------------------------------------------
// Scenario (i): autopilot failure exits at the API level
// ---------------------------------------------------------------------------

interface AutopilotDetail {
  session: {
    id: string;
    status: string;
    currentRunId: string | null;
    completedChapters: number;
    skippedChapters: number;
    lastError: Record<string, unknown> | null;
  };
  links: {
    runId: string;
    role: string;
    outlineNodeId: string | null;
    outcome: string | null;
  }[];
  runs: { id: string; status: string }[];
}

async function getSession(
  app: Awaited<ReturnType<typeof buildApp>>,
  sessionId: string,
): Promise<AutopilotDetail> {
  const response = await app.inject({
    method: "GET",
    url: `/api/autopilot/sessions/${sessionId}`,
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as AutopilotDetail;
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
  return response.json() as { processed: boolean };
}

async function resolveSession(
  app: Awaited<ReturnType<typeof buildApp>>,
  sessionId: string,
  action: "retry-current" | "skip-chapter" | "replan" | "stop",
) {
  const response = await app.inject({
    method: "POST",
    url: `/api/autopilot/sessions/${sessionId}/resolutions`,
    payload: { action },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as AutopilotDetail;
}

/**
 * Drives an autopilot session whose chapter draft always fails with a 500
 * until the child run's retry budget exhausts and the session is marked
 * failed with a child.failed note, then returns the detail. The fake provider
 * serves healthy structured output and a failing draft stream.
 */
async function driveSessionToFailure(
  app: Awaited<ReturnType<typeof buildApp>>,
  projectId: string,
): Promise<{ sessionId: string; detail: AutopilotDetail }> {
  const created = await app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/autopilot/sessions`,
    payload: {
      requestId: `fault-session-${projectId}`,
      approvalMode: "continuous",
      targetChapters: 1,
      windowSize: 1,
      maxRevisionCycles: 0,
      chapterPolicy: { minChapterCharacters: 100, retryBaseDelayMs: 1 },
    },
  });
  expect(created.statusCode, created.body).toBe(202);
  const sessionId = (created.json() as { id: string }).id;

  // Advance until the session fails on the exhausted child run.
  let detail = await getSession(app, sessionId);
  for (let index = 0; index < 40; index += 1) {
    if (["failed", "cancelled", "completed"].includes(detail.session.status)) {
      break;
    }
    const childId = detail.session.currentRunId;
    if (childId) {
      const child = detail.runs.find((run) => run.id === childId);
      if (
        child &&
        !["completed", "failed", "cancelled"].includes(child.status)
      ) {
        await driveRun(app, childId, projectId);
      }
    }
    await advanceSession(app, sessionId);
    detail = await getSession(app, sessionId);
  }
  return { sessionId, detail };
}

describe("fault injection: autopilot failure exits", () => {
  it("child draft 500 fails the session; retry-current, skip-chapter and stop all resolve it", async () => {
    // The draft stream always 500s; structured calls stay healthy so the run
    // reaches the draft step before failing.
    const { app, database } = await setup((call) => {
      if (call.body.stream) {
        return { kind: "status", status: 500, message: "draft exploded" };
      }
      return healthyHandler(call);
    });
    const target = await createProjectAndChapter(app);

    // --- retry-current: the failed session is actionable and re-runs the chapter ---
    const retry = await driveSessionToFailure(app, target.projectId);
    expect(retry.detail.session.status).toBe("failed");
    expect(retry.detail.session.lastError).toMatchObject({
      code: "child.failed",
    });
    const failedOverview = await app.inject({
      method: "GET",
      url: `/api/projects/${target.projectId}/overview`,
    });
    expect(failedOverview.statusCode, failedOverview.body).toBe(200);
    expect(failedOverview.json()).toMatchObject({
      activeTask: {
        kind: "quick_creation",
        id: retry.sessionId,
        status: "failed",
        availableActions: ["retry-current", "skip-chapter", "replan", "stop"],
      },
      nextAction: { kind: "continue_task", targetId: retry.sessionId },
    });
    const failedLink = retry.detail.links.find(
      (link) => link.role === "chapter",
    )!;
    expect(failedLink.outcome).toBe("failed");

    const retried = await resolveSession(app, retry.sessionId, "retry-current");
    expect(retried.session.status).toBe("running");
    // The failed chapter is re-queued: a fresh child run is attached.
    await advanceSession(app, retry.sessionId);
    const afterRetry = await getSession(app, retry.sessionId);
    const retryLinks = afterRetry.links.filter(
      (link) => link.role === "chapter",
    );
    expect(retryLinks.length).toBeGreaterThanOrEqual(2);
    expect(afterRetry.session.status).not.toBe("failed");

    // --- skip-chapter: the session advances past the failed chapter ---
    const skip = await driveSessionToFailure(app, target.projectId);
    expect(skip.detail.session.status).toBe("failed");
    const skipped = await resolveSession(app, skip.sessionId, "skip-chapter");
    expect(skipped.session.status).toBe("running");
    expect(skipped.session.skippedChapters).toBe(1);
    // With the only chapter skipped, the session moves on (re-planning the
    // outline or completing) instead of stalling on the failure.
    await advanceSession(app, skip.sessionId);
    const afterSkip = await getSession(app, skip.sessionId);
    expect(["running", "planning", "completed"]).toContain(
      afterSkip.session.status,
    );

    // --- stop: the session terminates and spawns no further work ---
    const stop = await driveSessionToFailure(app, target.projectId);
    expect(stop.detail.session.status).toBe("failed");
    await resolveSession(app, stop.sessionId, "stop");
    const stoppedDetail = await getSession(app, stop.sessionId);
    // stop closes the recoverable failed session, so it no longer blocks a
    // future writing task; advancing the closed session is a no-op.
    const advanceResult = await advanceSession(app, stop.sessionId);
    expect(advanceResult.processed).toBe(false);
    const afterStop = await getSession(app, stop.sessionId);
    expect(afterStop.session.status).toBe("cancelled");
    // No new child run was created after the stop resolution.
    expect(afterStop.links).toHaveLength(stoppedDetail.links.length);

    // The failing draft never produced a committed chapter version.
    expect(
      database.raw
        .prepare("SELECT COUNT(*) AS count FROM document_versions")
        .get(),
    ).toEqual({ count: 0 });
  });
});
