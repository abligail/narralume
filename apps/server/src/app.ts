import { randomUUID } from "node:crypto";

import cors from "@fastify/cors";
import { HealthResponseSchema } from "@narralume/contracts";
import {
  SqliteAutomationRepository,
  SqliteLlmCallRepository,
  SqliteProjectRepository,
  SqliteRunRepository,
  SqliteRunStreamRepository,
} from "@narralume/persistence";
import { NodeNarrativeDatabase } from "@narralume/persistence/node";
import { HarnessSupervisor } from "@narralume/harness";
import {
  AutomationWorkerSuite,
  AssistantWorkerSuite,
  CanonCandidateWorkerSuite,
  ChapterWorkerSuite,
  CollaborationWorkerSuite,
  DeliveryWorkerSuite,
  GatewayNarrativeModelClient,
  type NarrativeModelClient,
} from "@narralume/narrative";
import {
  AssistantToolExecutor,
  AutopilotCoordinator,
  LongGoalCoordinator,
  RunCoordinator,
  ServerEventHub,
  mapRouteError,
  registerAgentSkillRoutes,
  registerAssistantRoutes,
  registerAutomationRoutes,
  registerCanonCandidateRoutes,
  registerDeliveryRoutes,
  registerLongNovelRoutes,
  registerProjectCoverRoutes,
  registerProviderRoutes,
  registerReviewRoutes,
  registerRunRoutes,
  registerStoryRoutes,
  registerStudioRoutes,
  registerTemplateRoutes,
  seedEnvironmentModelConfig,
  seedHarnessTemplates,
} from "@narralume/services";
import Fastify, { type FastifyInstance } from "fastify";

import type { ServerConfig } from "./config.js";
import { DatabaseBackupError } from "./database-backup-service.js";
import { DatabaseBackupScheduler } from "./database-backup-scheduler.js";
import { fastifyRouteApp } from "./fastify-route-app.js";
import { registerSystemBackupRoutes } from "./system-backup-routes.js";

export interface BuildAppOptions {
  config: ServerConfig;
  database?: NodeNarrativeDatabase;
  environment?: Readonly<Record<string, string | undefined>>;
  logger?: boolean;
  narrativeModelClient?: NarrativeModelClient;
  enableRunWorker?: boolean;
}

export async function buildApp(
  options: BuildAppOptions,
): Promise<FastifyInstance> {
  assertExposureBoundary(options.config);
  const environment = options.environment ?? process.env;
  const enableBackgroundWorker =
    options.enableRunWorker ?? options.config.environment !== "test";
  const ownsDatabase = options.database === undefined;
  const database =
    options.database ?? new NodeNarrativeDatabase(options.config.databasePath);
  database.migrate();
  seedEnvironmentModelConfig(database, environment);
  seedHarnessTemplates(database);
  const events = new ServerEventHub();
  const streams = new SqliteRunStreamRepository(database);
  const modelClient =
    options.narrativeModelClient ??
    new GatewayNarrativeModelClient(
      database,
      environment,
      (runId, stepId, event) => {
        const now = new Date().toISOString();
        if (event.type === "text.delta")
          streams.appendText(runId, stepId, event.text, now);
        if (event.type === "response.completed")
          streams.markStatus(runId, stepId, "completed", now);
        if (event.type === "error")
          streams.markStatus(runId, stepId, "interrupted", now);
        events.broadcast(
          { type: "model.event", runId, event: { stepId, ...event } },
          "model.event",
        );
      },
    );
  const workers = {
    ...new AssistantWorkerSuite(database, modelClient).registry(),
    ...new CanonCandidateWorkerSuite(database, modelClient).registry(),
    ...new ChapterWorkerSuite(database, modelClient).registry(),
    ...new AutomationWorkerSuite(database, modelClient).registry(),
    ...new CollaborationWorkerSuite(database, modelClient).registry(),
    ...new DeliveryWorkerSuite(database, modelClient).registry(),
  };
  const runStore = new SqliteRunRepository(database);
  // Database-level subscription: every persisted run_events row is broadcast,
  // regardless of which repository instance (supervisor, routes, workers,
  // model client) wrote it.
  database.onRunEvent((event) => {
    events.broadcast(
      {
        type: "run.event",
        runId: event.runId,
        stepId: event.stepId,
        sequence: event.sequence,
        eventType: event.type,
        payload: event.payload,
      },
      "run.event",
    );
  });

  const app = Fastify({
    logger: options.logger ?? options.config.environment !== "test",
    genReqId: () => randomUUID(),
    bodyLimit: 70 * 1024 * 1024,
    requestTimeout: 60_000,
  });

  // Startup recovery runs before any worker wake: expired leases are
  // requeued (their running steps fail as run.lease_expired) and orphaned
  // call receipts / stream attempts from a previous process are terminated,
  // without relying on a worker poll to notice them.
  const recoveryNow = new Date().toISOString();
  const recovery = {
    recoveredLeases: runStore.recoverExpiredLeases(recoveryNow),
    interruptedCalls: new SqliteLlmCallRepository(database).interruptOrphaned(
      recoveryNow,
    ),
    interruptedStreams: streams.interruptOrphaned(recoveryNow),
  };
  app.log.info(
    recovery,
    "startup recovery: expired leases requeued, orphaned calls/streams interrupted",
  );
  let autopilotCoordinator: AutopilotCoordinator | null = null;
  let backupScheduler: DatabaseBackupScheduler | null = null;
  let assistantAutoExecutor: AssistantToolExecutor | null = null;
  let longGoalCoordinatorRef: LongGoalCoordinator | null = null;
  const supervisor = new HarnessSupervisor(runStore, workers, {
    onAction: (runId, action) => {
      events.broadcast(
        { type: "run.status", runId, status: action.type, action },
        "run.status",
      );
      if (enableBackgroundWorker) autopilotCoordinator?.wake();
      if (action.type === "complete_run" && assistantAutoExecutor) {
        try {
          assistantAutoExecutor.runAutoActivitiesForTurn(runId);
        } catch (error) {
          app.log.error({ err: error }, "assistant auto execution failed");
        }
      }
      if (
        (action.type === "complete_run" || action.type === "fail_run") &&
        longGoalCoordinatorRef
      ) {
        try {
          const run = runStore.getRun(runId);
          const goalId =
            run && typeof run.policy.assistantLongGoalId === "string"
              ? run.policy.assistantLongGoalId
              : null;
          if (goalId) longGoalCoordinatorRef.advance(goalId);
        } catch (error) {
          app.log.error({ err: error }, "long goal advance failed");
        }
      }
    },
  });
  const coordinator = new RunCoordinator(
    supervisor,
    (error) => {
      app.log.error({ err: error }, "run coordinator failed");
    },
    () => runStore.nextQueuedAvailableAt(),
  );
  autopilotCoordinator = new AutopilotCoordinator(
    database,
    coordinator,
    (sessionId, action) => {
      events.broadcast(
        { type: "autopilot.status", sessionId, action },
        "autopilot.status",
      );
      if (longGoalCoordinatorRef) {
        try {
          const session = new SqliteAutomationRepository(database).getSession(
            sessionId,
          );
          const goalId =
            session &&
            typeof session.chapterPolicy.assistantLongGoalId === "string"
              ? session.chapterPolicy.assistantLongGoalId
              : null;
          if (goalId) longGoalCoordinatorRef.advance(goalId);
        } catch (error) {
          app.log.error({ err: error }, "long goal session advance failed");
        }
      }
    },
    (error) => app.log.error({ err: error }, "autopilot coordinator failed"),
    () => new Date(),
    enableBackgroundWorker,
    environment,
  );
  const longGoalCoordinator = new LongGoalCoordinator(database, {
    runCoordinator: coordinator,
    autopilotCoordinator,
    enableBackgroundWorker,
    environment,
  });
  longGoalCoordinatorRef = longGoalCoordinator;
  assistantAutoExecutor = new AssistantToolExecutor(database, {
    runCoordinator: coordinator,
    autopilotCoordinator,
    longGoalCoordinator,
    enableBackgroundWorker,
    environment,
  });

  await app.register(cors, {
    origin:
      options.config.environment === "production"
        ? false
        : /^http:\/\/(127\.0\.0\.1|localhost):\d+$/,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });

  app.addHook("onRequest", async (request, reply) => {
    const authToken = options.config.authToken;
    if (!authToken || request.url === "/api/health") return;
    if (request.headers.authorization !== `Bearer ${authToken}`)
      return reply.code(401).send({
        error: {
          code: "auth.required",
          message: "A valid local service token is required",
        },
      });
  });

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
    const servesWeb =
      Boolean(options.config.staticDirectory) &&
      !request.url.startsWith("/api/");
    reply.header(
      "content-security-policy",
      servesWeb
        ? "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' https: http:; worker-src 'self' blob:; frame-src https://challenges.cloudflare.com; frame-ancestors 'none'; base-uri 'none'; object-src 'none'"
        : "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    );
    reply.header(
      "permissions-policy",
      "camera=(), microphone=(), geolocation=()",
    );
    return payload;
  });

  app.get("/api/health", async () =>
    HealthResponseSchema.parse({
      status: "ok",
      service: "narralume",
      version: "0.1.0",
      database: { status: "ready", migration: database.currentMigration() },
      now: new Date().toISOString(),
    }),
  );

  app.get("/api/events", async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const remove = events.add(
      (frame) => {
        reply.raw.write(frame);
      },
      () => {
        reply.raw.end();
      },
    );
    reply.raw.write(
      `event: connected\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`,
    );
    const heartbeat = setInterval(() => {
      if (!reply.raw.destroyed) {
        reply.raw.write(
          `event: heartbeat\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`,
        );
      }
    }, 20_000);
    request.raw.once("close", () => {
      clearInterval(heartbeat);
      remove();
    });
  });

  const routes = fastifyRouteApp(app);
  registerStoryRoutes(routes, database, {
    coordinator,
    enableBackgroundWorker,
    environment,
  });
  registerProjectCoverRoutes(routes, database);
  registerAgentSkillRoutes(routes, database);
  registerProviderRoutes(routes, database, { environment });
  registerRunRoutes(routes, database, {
    coordinator,
    enableBackgroundWorker,
    environment,
  });
  registerReviewRoutes(routes, database, {
    onSettlementDecisionResolved: () => {
      if (enableBackgroundWorker) {
        coordinator.wake();
        autopilotCoordinator.wake();
      }
    },
  });
  registerLongNovelRoutes(routes, database);
  registerTemplateRoutes(routes, database);
  registerAutomationRoutes(routes, database, {
    coordinator: autopilotCoordinator,
    runCoordinator: coordinator,
    enableBackgroundWorker,
    environment,
  });
  registerAssistantRoutes(routes, database, {
    runCoordinator: coordinator,
    autopilotCoordinator,
    longGoalCoordinator,
    enableBackgroundWorker,
    environment,
  });
  registerCanonCandidateRoutes(routes, database, {
    runCoordinator: coordinator,
    enableBackgroundWorker,
    environment,
  });
  registerStudioRoutes(routes, database, {
    coordinator,
    enableBackgroundWorker,
    environment,
  });
  registerDeliveryRoutes(routes, database, {
    coordinator,
    enableBackgroundWorker,
    environment,
  });
  const backupService = registerSystemBackupRoutes(
    routes,
    database,
    options.config,
  );

  if (enableBackgroundWorker) {
    // 刷新/重启恢复：接管所有活动复合任务，按当前持久状态继续推进。
    longGoalCoordinator.reconcileAll();
    coordinator.wake();
    autopilotCoordinator.wake();
    if (backupService) {
      const projects = new SqliteProjectRepository(database);
      backupScheduler = new DatabaseBackupScheduler(
        backupService,
        (options.config.backupIntervalMinutes ?? 360) * 60_000,
        () => {
          projects.purgeExpired(new Date().toISOString());
        },
        (error) => app.log.error({ err: error }, "scheduled backup failed"),
      );
      backupScheduler.start(options.config.backupOnStartup ?? false);
    }
  }

  if (options.config.staticDirectory) {
    // M4 生产本地模式：一条命令托管 web 静态产物（NARRATIVE_STATIC_DIR 指向
    // apps/web/dist）。/api 之外的未命中路径回落 index.html（SPA 路由）。
    const { default: fastifyStatic } = await import("@fastify/static");
    await app.register(fastifyStatic, {
      root: options.config.staticDirectory,
      prefix: "/",
      wildcard: false,
    });
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({
          error: { code: "route.not_found", message: "Route not found" },
        });
      }
      return reply.sendFile("index.html");
    });
  } else {
    app.setNotFoundHandler(async (_request, reply) =>
      reply.code(404).send({
        error: { code: "route.not_found", message: "Route not found" },
      }),
    );
  }

  app.setErrorHandler(async (error, request, reply) => {
    const requestId = request.id;
    // 与浏览器内核共用同一份错误映射（services/route-error-mapper），
    // Fastify 侧额外携带 requestId 与 ZodError 原始日志。
    const mapped = mapRouteError(error, (payload, message) =>
      request.log.error({ err: payload, requestId }, message),
    );
    if (error instanceof DatabaseBackupError) {
      const status = error.code.endsWith("not_found") ? 404 : 422;
      return reply.code(status).send({
        error: { code: error.code, message: error.message, requestId },
      });
    }
    return reply.code(mapped.status).send({
      error: {
        code: mapped.code,
        message: mapped.message,
        requestId,
        ...(mapped.fields ? { fields: mapped.fields } : {}),
        ...(mapped.details !== undefined ? { details: mapped.details } : {}),
      },
    });
  });

  app.addHook("onClose", async () => {
    await backupScheduler?.stop();
    await autopilotCoordinator?.stop();
    await coordinator.stop();
    events.close();
    if (ownsDatabase) database.close();
  });

  return app;
}

function assertExposureBoundary(config: ServerConfig) {
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(config.host);
  if (loopback) return;
  if (
    config.environment === "production" &&
    config.allowRemote &&
    config.authToken
  )
    return;
  throw new Error(
    "Remote listening is disabled by default; production requires both NARRATIVE_ALLOW_REMOTE=true and NARRATIVE_AUTH_TOKEN",
  );
}
