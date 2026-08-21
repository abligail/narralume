/// <reference lib="webworker" />
/**
 * M3 浏览器内核 Worker：镜像 app.ts 的装配，但宿主是 RouteTable +
 * postMessage 事件桥，而不是 Fastify + SSE。同一批 register*Routes 在
 * 两个宿主注册——HTTP 契约是唯一 API 面（D1）。
 *
 * 消息协议：
 * - 请求 {type:"request", id, method, path, query, body, headers}
 * - 响应 {type:"response", id, ok, status, body|error:{code,message,details}}
 *   （二进制 body 以 Uint8Array 结构化克隆传输）
 * - 事件 {type:"event", eventName, payload}（run/model/autopilot 状态四类）
 * - 就绪 {type:"ready"} / 失败 {type:"fatal", message}
 */
import {
  NarrativeDatabase,
  createOpfsSahpoolDriver,
} from "@narralume/persistence/browser";
import {
  SqliteAutomationRepository,
  SqliteAssignmentRepository,
  SqliteModelRepository,
  SqliteRunStreamRepository,
  SqliteRunRepository,
  SqliteProjectRepository,
} from "@narralume/persistence/browser";
import {
  AssistantToolExecutor,
  AutopilotCoordinator,
  LongGoalCoordinator,
  RouteTable,
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
  seedDemoRelayProvider,
  seedEnvironmentModelConfig,
  seedHarnessTemplates,
  type RouteMethod,
} from "@narralume/services";
import {
  AssistantWorkerSuite,
  AutomationWorkerSuite,
  CanonCandidateWorkerSuite,
  ChapterWorkerSuite,
  CollaborationWorkerSuite,
  DeliveryWorkerSuite,
  GatewayNarrativeModelClient,
} from "@narralume/narrative";
import { HarnessSupervisor } from "@narralume/harness";

import { createRelayFetch } from "./relay-fetch";
import { exceedsTrialRelayAutopilotLimit } from "../lib/trial-policy";

interface KernelRequest {
  type: "request";
  id: string;
  method: RouteMethod;
  path: string;
  query: Record<string, unknown>;
  body: unknown;
  headers: Record<string, string>;
}

type KernelInbound = KernelRequest;

const post = (message: unknown, transfer?: Transferable[]) =>
  transfer ? self.postMessage(message, transfer) : self.postMessage(message);

/* 在线体验站（VITE_TRIAL_MODE）构建期开关（M5）。 */
const trialMode = import.meta.env.VITE_TRIAL_MODE === "1";

const noopLog = {
  warn: (): void => {},
};

async function boot(): Promise<void> {
  const driver = await createOpfsSahpoolDriver("narralume.sqlite");
  const database = new NarrativeDatabase("narralume.sqlite", driver);
  database.migrate();
  const projects = new SqliteProjectRepository(database);
  const purgeExpiredProjects = () =>
    projects.purgeExpired(new Date().toISOString());
  purgeExpiredProjects();
  setInterval(purgeExpiredProjects, 60 * 60 * 1000);
  // 浏览器内核没有进程环境变量；模型配置完全来自用户显式录入。
  seedEnvironmentModelConfig(database, {});
  seedHarnessTemplates(database);
  // M4 demo 中继 provider：credentialRef=relay:demo（哑 key，D5），
  // 真实 key 只在中继环境变量。中继地址经构建期注入，未配置则跳过。
  const relayUrl = import.meta.env.VITE_DEMO_RELAY_URL as string | undefined;
  const relayModel = import.meta.env.VITE_DEMO_RELAY_MODEL as string | undefined;
  if (relayUrl && relayModel)
    seedDemoRelayProvider(database, { relayBaseUrl: relayUrl, model: relayModel });
  const relayOrigin = relayUrl ? new URL(relayUrl).origin : null;
  const credentialedModelFetch = relayOrigin
    ? createRelayFetch(relayOrigin)
    : undefined;

  const events = new ServerEventHub();
  events.add((frame) => post({ type: "sse", frame }));

  const streams = new SqliteRunStreamRepository(database);
  const modelClient = new GatewayNarrativeModelClient(
    database,
    {},
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
    credentialedModelFetch,
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

  // 刷新恢复：与 app.ts 相同的孤儿回收（无跨进程残留，防御性保留）。
  const recoveryNow = new Date().toISOString();
  runStore.recoverExpiredLeases(recoveryNow);

  let autopilotCoordinator: AutopilotCoordinator | null = null;
  let assistantAutoExecutor: AssistantToolExecutor | null = null;
  let longGoalCoordinatorRef: LongGoalCoordinator | null = null;
  const supervisor = new HarnessSupervisor(runStore, workers, {
    onAction: (runId, action) => {
      events.broadcast(
        { type: "run.status", runId, status: action.type, action },
        "run.status",
      );
      autopilotCoordinator?.wake();
      if (action.type === "complete_run" && assistantAutoExecutor) {
        try {
          assistantAutoExecutor.runAutoActivitiesForTurn(runId);
        } catch (error) {
          console.error("assistant auto execution failed", error);
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
          console.error("long goal advance failed", error);
        }
      }
    },
  });
  const coordinator = new RunCoordinator(
    supervisor,
    (error) => console.error("run coordinator failed", error),
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
          console.error("long goal session advance failed", error);
        }
      }
    },
    (error) => console.error("autopilot coordinator failed", error),
    () => new Date(),
    true,
    {},
  );
  const longGoalCoordinator = new LongGoalCoordinator(database, {
    runCoordinator: coordinator,
    autopilotCoordinator,
    enableBackgroundWorker: true,
    environment: {},
  });
  longGoalCoordinatorRef = longGoalCoordinator;
  assistantAutoExecutor = new AssistantToolExecutor(database, {
    runCoordinator: coordinator,
    autopilotCoordinator,
    longGoalCoordinator,
    enableBackgroundWorker: true,
    environment: {},
  });

  const table = new RouteTable();
  registerStoryRoutes(table, database, {
    coordinator,
    enableBackgroundWorker: true,
    environment: {},
  });
  registerProjectCoverRoutes(table, database);
  registerAgentSkillRoutes(table, database);
  registerProviderRoutes(table, database, { environment: {} });
  registerRunRoutes(table, database, {
    coordinator,
    enableBackgroundWorker: true,
    environment: {},
  });
  registerReviewRoutes(table, database, {
    onSettlementDecisionResolved: () => {
      coordinator.wake();
      autopilotCoordinator.wake();
    },
  });
  registerLongNovelRoutes(table, database);
  registerTemplateRoutes(table, database);
  registerAutomationRoutes(table, database, {
    coordinator: autopilotCoordinator,
    runCoordinator: coordinator,
    enableBackgroundWorker: true,
    environment: {},
    ...(trialMode
      ? {
          beforeCreateAutopilotSession: (input: {
            targetChapters: number;
          }) => {
          const assignment = new SqliteAssignmentRepository(database).get("writing");
          const model = assignment
            ? new SqliteModelRepository(database).get(assignment.modelId)
            : null;
          if (
            exceedsTrialRelayAutopilotLimit(model?.providerId, input.targetChapters)
          ) {
            throw {
              code: "trial.autopilot_chapter_limit",
              statusCode: 403,
              message:
                "The built-in trial model writes at most 3 chapters per run; add your own model channel in Settings to continue.",
            };
          }
          },
        }
      : {}),
  });
  registerAssistantRoutes(table, database, {
    runCoordinator: coordinator,
    autopilotCoordinator,
    longGoalCoordinator,
    enableBackgroundWorker: true,
    environment: {},
  });
  registerCanonCandidateRoutes(table, database, {
    runCoordinator: coordinator,
    enableBackgroundWorker: true,
    environment: {},
  });
  registerStudioRoutes(table, database, {
    coordinator,
    enableBackgroundWorker: true,
    environment: {},
  });
  registerDeliveryRoutes(table, database, {
    coordinator,
    enableBackgroundWorker: true,
    environment: {},
  });

  // 健康 + 事件端点（镜像 app.ts 的 /api/health 与 /api/events）。
  table.route("GET", "/api/health", async () => ({
    status: 200,
    body: {
      status: "ok",
      service: "narralume",
      version: "0.1.0",
      database: { status: "ready", migration: database.currentMigration() },
      now: new Date().toISOString(),
    },
  }));
  table.route("GET", "/api/events", async () => ({
    status: 200,
    body: { at: new Date().toISOString() },
  }));
  // 下载我的库（D6）：导出 OPFS 数据库完整字节（sahpool exportFile）。
  // server 模式同名端点在 Node 侧走备份文件；两驱动的 UI 都从这取 bytes。
  table.route("GET", "/api/system/database-download", async () => {
    const bytes = await database.raw.exportBytes?.();
    if (!bytes) {
      return {
        status: 501,
        body: {
          error: {
            code: "download.unsupported",
            message: "The current driver does not support library export",
          },
        },
      };
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return {
      status: 200,
      body: bytes,
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="narralume-${stamp}.sqlite"`,
      },
    };
  });

  longGoalCoordinator.reconcileAll();
  coordinator.wake();
  autopilotCoordinator.wake();

  post({ type: "ready" });

  self.addEventListener("message", (event: MessageEvent<KernelInbound>) => {
    const message = event.data;
    if (!message || message.type !== "request") return;
    void (async () => {
      try {
        const response = await table.dispatch(message.method, message.path, {
          query: message.query,
          body: message.body,
          headers: message.headers,
          log: noopLog,
        });
        const transfer: Transferable[] = [];
        if (response.body instanceof Uint8Array) {
          transfer.push(response.body.buffer as ArrayBuffer);
        }
        post(
          {
            type: "response",
            id: message.id,
            ok: true,
            status: response.status,
            headers: response.headers,
            body: response.body,
          },
          transfer,
        );
      } catch (error) {
        post({
          type: "response",
          id: message.id,
          ok: false,
          error: mapRouteError(error),
        });
      }
    })();
  });
}

boot().catch((error: unknown) => {
  post({
    type: "fatal",
    message: error instanceof Error ? error.message : String(error),
  });
});
