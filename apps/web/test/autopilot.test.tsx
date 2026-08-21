// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "../src/i18n";
import { AutopilotWorkspace } from "../src/workspaces/autopilot";

const SESSION = {
  id: "session-1",
  projectId: "p-1",
  mode: "autopilot",
  approvalMode: "continuous",
  status: "running",
  targetChapters: 6,
  windowSize: 3,
  maxRevisionCycles: 2,
  completedChapters: 2,
  skippedChapters: 0,
  pauseRequested: false,
  cancelRequested: false,
  replanRequested: false,
  activeNotes: ["第三章引入新证人，不超过 500 句。"],
  lastError: null,
  createdAt: "2026-08-10T10:00:00.000Z",
  updatedAt: "2026-08-10T12:00:00.000Z",
  finishedAt: null,
  version: 3,
  currentRunId: "run-abc123",
  currentOutlineNodeId: "n-ch-3",
  chapterPolicy: {},
  childBudget: {
    maxInputTokens: 100_000,
    maxOutputTokens: 32_000,
    maxCalls: 25,
    maxCostUsd: 2,
    maxWallTimeMs: 600_000,
  },
};

const SESSION_DETAIL = {
  session: SESSION,
  links: [
    {
      sessionId: "session-1",
      runId: "run-aaa",
      role: "rolling-plan",
      outlineNodeId: null,
      sequence: 0,
      createdAt: "2026-08-10T10:00:00.000Z",
      processedAt: "2026-08-10T11:00:00.000Z",
      outcome: null,
    },
    {
      sessionId: "session-1",
      runId: "run-abc123",
      role: "chapter",
      outlineNodeId: "n-ch-3",
      sequence: 1,
      createdAt: "2026-08-10T11:00:00.000Z",
      processedAt: null,
      outcome: null,
    },
  ],
  runs: [],
  steers: [],
  reviews: [],
  origin: { surface: "autopilot", documentId: null, selection: null },
  approvalMode: "continuous",
  currentChapter: { id: "n-ch-3", title: "第三章 潮声", runId: "run-abc123" },
  stopReason: "running",
  availableActions: ["pause", "cancel"],
};

function json(value: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

function setupResponse(url: string) {
  if (url === "/api/projects/p-1/foundation/candidates") return json([]);
  if (url === "/api/projects/p-1/runs") return json([]);
  if (url === "/api/projects/p-1/compass") return json(null);
  if (url === "/api/projects/p-1/reviews")
    return json({ reports: [], proposals: [] });
  return null;
}

function renderAutopilot(entry = "/projects/p-1/autopilot") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/projects/:projectId/autopilot" element={<AutopilotWorkspace />} />
          <Route path="/missing" element={<AutopilotWorkspace />} />
          <Route path="/shelf" element={<p>已入馆：藏书室</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/* 慢启动会话：首轮读回 pending，等待协调器推进。 */
const PENDING_SESSION = { ...SESSION, id: "session-slow", status: "pending", completedChapters: 0, currentRunId: null, currentOutlineNodeId: null };
const RUNNING_SESSION = { ...SESSION, id: "session-slow", status: "running", completedChapters: 1 };
const COMPLETED_SESSION = { ...SESSION, id: "session-slow", status: "completed", completedChapters: 6, currentRunId: null, currentOutlineNodeId: null };

function detailFor(session: typeof PENDING_SESSION) {
  return {
    ...SESSION_DETAIL,
    session,
    links: [],
    currentChapter: null,
    availableActions: session.status === "pending" ? ["cancel"] : ["pause", "cancel"],
    stopReason: null,
  };
}

const FOUNDATION_RUN_PENDING = {
  id: "run-foundation",
  projectId: "p-1",
  recipe: "book-foundation",
  recipeVersion: 1,
  mode: "manual",
  status: "pending",
  targetOutlineNodeId: "book-root",
  policy: { braindump: "灯灯在异世界旅行" },
  budgetLimit: { maxInputTokens: 100_000, maxOutputTokens: 24_000, maxCalls: 6, maxCostUsd: null, maxWallTimeMs: 600_000 },
  budgetUsage: { inputTokens: 0, outputTokens: 0, calls: 1, costUsd: 0, wallTimeMs: 45_000 },
  revisionCycle: 0,
  pauseRequested: false,
  cancelRequested: false,
  currentStepId: null,
  startedAt: "2026-08-10T10:00:00.000Z",
  finishedAt: null,
  createdAt: "2026-08-10T10:00:00.000Z",
  updatedAt: "2026-08-10T10:00:45.000Z",
  version: 2,
};

const FOUNDATION_SET = {
  set: {
    id: "set-1",
    projectId: "p-1",
    sourceRunId: "run-foundation",
    title: "灯灯的方向",
    status: "open",
    createdAt: "2026-08-10T10:01:00.000Z",
    updatedAt: "2026-08-10T10:01:00.000Z",
  },
  candidates: [
    {
      id: "cand-1",
      setId: "set-1",
      projectId: "p-1",
      kind: "intent",
      label: "异世界灯旅",
      payload: { promise: "灯灯在异世界学会告别。", themes: ["告别"], tone: "温柔", endingDirection: "回到原点" },
      editedPayload: null,
      status: "pending",
      adoptedRefType: null,
      adoptedRefId: null,
      createdAt: "2026-08-10T10:01:00.000Z",
      updatedAt: "2026-08-10T10:01:00.000Z",
    },
  ],
};

beforeEach(() => {
  setLocale("zh-CN");
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn((queryText: string) => ({
      matches: true,
      media: queryText,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("自动驾驶", () => {
  it("创作记录显示时间、完成进度、当前章节与稳定短 ID（CR-96）", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const setup = setupResponse(url);
      if (setup) return setup;
      if (url === "/api/projects/p-1/autopilot/sessions") return json([SESSION]);
      if (url === "/api/autopilot/sessions/session-1") return json(SESSION_DETAIL);
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderAutopilot();

    const record = await screen.findByRole("button", { name: /2\/6 章 · 连续创作/ });
    expect(record).toHaveTextContent("08/10");
    expect(record).toHaveTextContent("任务 session-");
    expect(record).toHaveTextContent("当前章节 n-ch-3");
  });

  it("表单使用共享资源边界，但不限制每章参考字数", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const setup = setupResponse(url);
      if (setup) return setup;
      if (url === "/api/projects/p-1/autopilot/sessions") return json([]);
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderAutopilot();

    expect(await screen.findByLabelText("目标章数")).toHaveAttribute("max", "500");
    expect(screen.getByLabelText("卷数")).toHaveAttribute("max", "20");
    expect(screen.getByLabelText("每章参考字数")).not.toHaveAttribute("max");
    expect(screen.getByLabelText("这次写几章")).toHaveAttribute("max", "500");
    fireEvent.click(screen.getByText("高级选项"));
    expect(screen.getByLabelText("向前规划章数")).toHaveAttribute("max", "20");
  });

  it("快速创作参数变化后使用新的 requestId", async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const compass = {
      projectId: "p-1",
      corePromise: "每次寄信都要付出记忆代价。",
      endingDirection: null,
      longLines: [],
      themeQuestions: [],
      target: { chapters: 6, wordsPerChapter: 3_000, volumes: 1 },
      constraints: [],
      version: 1,
      updatedAt: "2026-08-10T10:00:00.000Z",
    };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/projects/p-1/foundation/candidates") return json([]);
      if (url === "/api/projects/p-1/runs") return json([]);
      if (url === "/api/projects/p-1/compass") return json(compass);
      if (url === "/api/projects/p-1/autopilot/sessions" && init?.method === "POST") {
        requestBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return Promise.reject(new Error("response lost"));
      }
      if (url === "/api/projects/p-1/autopilot/sessions") return json([]);
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderAutopilot();

    const startButton = await screen.findByRole("button", {
      name: "开始 AI 快速创作",
    });
    fireEvent.submit(startButton.closest("form")!);
    await waitFor(() => expect(requestBodies).toHaveLength(1));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "开始 AI 快速创作" }),
      ).toBeEnabled(),
    );
    fireEvent.change(screen.getByLabelText("这次写几章"), {
      target: { value: "4" },
    });
    fireEvent.submit(
      screen
        .getByRole("button", { name: "开始 AI 快速创作" })
        .closest("form")!,
    );

    await waitFor(() => expect(requestBodies).toHaveLength(2));
    expect(requestBodies[1]?.requestId).not.toBe(requestBodies[0]?.requestId);
  });

  it("指南针异步到达时同步未编辑的目标章数", async () => {
    const compass = {
      projectId: "p-1",
      corePromise: "异步抵达的方向",
      endingDirection: null,
      longLines: [],
      themeQuestions: [],
      target: { chapters: 12, wordsPerChapter: 3_000, volumes: 1 },
      constraints: [],
      version: 2,
      updatedAt: "2026-08-10T10:00:00.000Z",
    };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects/p-1/foundation/candidates") return json([]);
      if (url === "/api/projects/p-1/runs") return json([]);
      if (url === "/api/projects/p-1/autopilot/sessions") return json([]);
      if (url === "/api/projects/p-1/compass") {
        return new Promise<Response>((resolve) => window.setTimeout(() => void json(compass).then(resolve), 20));
      }
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderAutopilot();

    expect(screen.getByLabelText("这次写几章")).toHaveValue(3);
    await waitFor(() => expect(screen.getByLabelText("这次写几章")).toHaveValue(12));
  });

  it("指南针异步到达时不覆盖作者已经修改的目标章数", async () => {
    const compass = {
      projectId: "p-1",
      corePromise: "异步抵达的方向",
      endingDirection: null,
      longLines: [],
      themeQuestions: [],
      target: { chapters: 12, wordsPerChapter: 3_000, volumes: 1 },
      constraints: [],
      version: 2,
      updatedAt: "2026-08-10T10:00:00.000Z",
    };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects/p-1/foundation/candidates") return json([]);
      if (url === "/api/projects/p-1/runs") return json([]);
      if (url === "/api/projects/p-1/autopilot/sessions") return json([]);
      if (url === "/api/projects/p-1/compass") {
        return new Promise<Response>((resolve) => window.setTimeout(() => void json(compass).then(resolve), 20));
      }
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderAutopilot();

    const target = screen.getByLabelText("这次写几章");
    fireEvent.change(target, { target: { value: "5" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "开始 AI 快速创作" })).toBeEnabled());
    expect(target).toHaveValue(5);
  });

  it("提交过的「这次写几章」按项目记忆，重进页面不被罗盘覆盖", async () => {
    const compass = {
      projectId: "p-1",
      corePromise: "每次寄信都要付出记忆代价。",
      endingDirection: null,
      longLines: [],
      themeQuestions: [],
      target: { chapters: 12, wordsPerChapter: 3_000, volumes: 1 },
      constraints: [],
      version: 1,
      updatedAt: "2026-08-10T10:00:00.000Z",
    };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/projects/p-1/foundation/candidates") return json([]);
      if (url === "/api/projects/p-1/runs") return json([]);
      if (url === "/api/projects/p-1/compass") return json(compass);
      if (url === "/api/projects/p-1/autopilot/sessions" && init?.method === "POST") {
        return Promise.reject(new Error("response lost"));
      }
      if (url === "/api/projects/p-1/autopilot/sessions") return json([]);
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const first = renderAutopilot();

    const startButton = await screen.findByRole("button", { name: "开始 AI 快速创作" });
    await waitFor(() => expect(screen.getByLabelText("这次写几章")).toHaveValue(12));
    fireEvent.change(screen.getByLabelText("这次写几章"), { target: { value: "5" } });
    fireEvent.submit(startButton.closest("form")!);
    await waitFor(() =>
      expect(window.localStorage.getItem("narralume:autopilot-target:p-1")).toBe("5"),
    );
    first.unmount();
    renderAutopilot();

    expect(await screen.findByLabelText("这次写几章")).toHaveValue(5);
  });

  it("数字输入清空时不被 0 占位，失焦后回到有效值", async () => {
    const compass = {
      projectId: "p-1",
      corePromise: "每次寄信都要付出记忆代价。",
      endingDirection: null,
      longLines: [],
      themeQuestions: [],
      target: { chapters: 12, wordsPerChapter: 3_000, volumes: 1 },
      constraints: [],
      version: 1,
      updatedAt: "2026-08-10T10:00:00.000Z",
    };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects/p-1/foundation/candidates") return json([]);
      if (url === "/api/projects/p-1/runs") return json([]);
      if (url === "/api/projects/p-1/autopilot/sessions") return json([]);
      if (url === "/api/projects/p-1/compass") return json(compass);
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderAutopilot();

    const input = await screen.findByLabelText("目标章数");
    expect(input).toHaveValue(12);
    fireEvent.change(input, { target: { value: "" } });
    expect(input).toHaveValue(null);
    fireEvent.blur(input);
    expect(input).toHaveValue(12);
  });

  it("会话没有服务端动作时不显示客户端猜测的继续处理", async () => {
    const pending = { ...PENDING_SESSION, id: "session-no-action" };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const setup = setupResponse(url);
      if (setup) return setup;
      if (url === "/api/projects/p-1/autopilot/sessions") return json([pending]);
      if (url === "/api/autopilot/sessions/session-no-action") {
        return json({ ...detailFor(pending), availableActions: [] });
      }
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderAutopilot();

    await screen.findByText(/计划创作 6 章/);
    expect(screen.queryByRole("button", { name: "继续处理" })).not.toBeInTheDocument();
  });

  it("罗盘画面 + 航次簿 + 指令口全到齐", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const setup = setupResponse(url);
      if (setup) return setup;
      if (url === "/api/projects/p-1/autopilot/sessions") return json([SESSION]);
      if (url === "/api/autopilot/sessions/session-1")
        return json(SESSION_DETAIL);
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderAutopilot();

    await screen.findByText(/计划创作 6 章/);
    expect(screen.getByText("创作记录")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /应用到后续创作/ })).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "连续创作进度" })).toBeInTheDocument();
    expect(screen.getAllByText(/后续章节规划|本章写作|正在进行/).length).toBeGreaterThan(0);
    expect(screen.getByLabelText("新创作指示")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "当前快速创作" })).toHaveTextContent("AI 正在连续创作");
    expect(screen.queryByRole("button", { name: "开始 AI 快速创作" })).not.toBeInTheDocument();
    expect(screen.queryByText("暂停原因")).not.toBeInTheDocument();
  });

  it("汇总连续创作已完成章节的最终审稿状态", async () => {
    const completedLinks = [
      {
        sessionId: "session-1",
        runId: "run-pass",
        role: "chapter",
        outlineNodeId: "n-ch-1",
        sequence: 1,
        createdAt: "2026-08-10T10:00:00.000Z",
        processedAt: "2026-08-10T10:10:00.000Z",
        outcome: "completed",
      },
      {
        sessionId: "session-1",
        runId: "run-revise",
        role: "chapter",
        outlineNodeId: "n-ch-2",
        sequence: 2,
        createdAt: "2026-08-10T10:10:00.000Z",
        processedAt: "2026-08-10T10:20:00.000Z",
        outcome: "completed",
      },
    ];
    const reports = [
      {
        id: "report-pass",
        projectId: "p-1",
        runId: "run-pass",
        stepId: "run-pass:review:1",
        documentVersionId: "version-pass",
        documentId: "document-pass",
        documentTitle: "第一章",
        verdict: "pass",
        summary: "通过",
        scores: {},
        reviewedContent: "正文一",
        reviewedContentHash: "hash-pass",
        issues: [],
        createdAt: "2026-08-10T10:09:00.000Z",
      },
      {
        id: "report-revise",
        projectId: "p-1",
        runId: "run-revise",
        stepId: "run-revise:review:2",
        documentVersionId: "version-revise",
        documentId: "document-revise",
        documentTitle: "第二章",
        verdict: "revise",
        summary: "尚有普通问题",
        scores: {},
        reviewedContent: "正文二",
        reviewedContentHash: "hash-revise",
        issues: [],
        createdAt: "2026-08-10T10:19:00.000Z",
      },
    ];
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects/p-1/reviews")
        return json({ reports, proposals: [] });
      const setup = setupResponse(url);
      if (setup) return setup;
      if (url === "/api/projects/p-1/autopilot/sessions") return json([SESSION]);
      if (url === "/api/autopilot/sessions/session-1")
        return json({ ...SESSION_DETAIL, links: completedLinks });
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderAutopilot();

    const summary = await screen.findByLabelText("本次创作质量汇总");
    expect(summary).toHaveTextContent("1 已通过");
    expect(summary).toHaveTextContent("1 待复看");
    expect(summary).toHaveTextContent("0 已阻断");
    expect(summary).not.toHaveTextContent("未形成报告");
  });

  it("分类任务取消后把创作指示显示为未应用", async () => {
    const detail = {
      ...SESSION_DETAIL,
      steers: [
        {
          id: "steer-cancelled",
          projectId: "p-1",
          sessionId: "session-1",
          targetRunId: "run-abc123",
          content: "下一章改成雨夜追逐。",
          classification: null,
          status: "rejected",
          effectiveBoundary: "future",
          rationale: "影响范围判断已取消，这条创作指示未应用",
          risk: null,
          classificationRunId: "run-steer-cancelled",
          appliedAt: null,
          createdAt: "2026-08-10T12:10:00.000Z",
          updatedAt: "2026-08-10T12:11:00.000Z",
        },
      ],
    };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const setup = setupResponse(url);
      if (setup) return setup;
      if (url === "/api/projects/p-1/autopilot/sessions") return json([SESSION]);
      if (url === "/api/autopilot/sessions/session-1") return json(detail);
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderAutopilot();

    await screen.findByText("下一章改成雨夜追逐。");
    fireEvent.click(screen.getByText("历史创作指示"));
    expect(screen.getByText("未应用")).toBeInTheDocument();
    expect(
      screen.getByText(/影响范围判断已取消，这条创作指示未应用/),
    ).toBeInTheDocument();
  });

  it("致命子任务中断后显示恢复动作而不是无效推进", async () => {
    const awaitingSession = {
      ...SESSION,
      status: "awaiting_user",
      currentRunId: null,
      currentOutlineNodeId: null,
      lastError: {
        code: "child.fatal",
        runId: "run-fatal",
        category: "authentication",
        message: "invalid api key",
      },
    };
    const detail = {
      ...SESSION_DETAIL,
      session: awaitingSession,
      currentChapter: null,
      stopReason: "child.fatal",
      availableActions: [
        "retry-current",
        "skip-chapter",
        "replan",
        "stop",
      ],
    };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const setup = setupResponse(url);
      if (setup) return setup;
      if (url === "/api/projects/p-1/autopilot/sessions") {
        return json([awaitingSession]);
      }
      if (url === "/api/autopilot/sessions/session-1") return json(detail);
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderAutopilot();

    expect(
      await screen.findByRole("button", { name: "重试当前章节" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "跳过本章" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新规划" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "终止并结算" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "继续处理" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("模型调用中断，请修复默认模型后选择恢复方式"),
    ).toBeInTheDocument();
  });

  it("章节确认使用当前子任务生成稳定 requestId", async () => {
    const awaitingSession = { ...SESSION, status: "awaiting_user" };
    const awaitingDetail = {
      ...SESSION_DETAIL,
      session: awaitingSession,
      stopReason: "chapter_commit_approval_required",
      availableActions: ["accept_manuscript", "request_revision", "cancel"],
    };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        const setup = setupResponse(url);
        if (setup) return setup;
        if (url === "/api/projects/p-1/autopilot/sessions") {
          return json([awaitingSession]);
        }
        if (url === "/api/autopilot/sessions/session-1") {
          return json(awaitingDetail);
        }
        if (url === "/api/autopilot/sessions/session-1/actions") {
          return json(awaitingDetail);
        }
        throw new Error(`unexpected request ${url}`);
      });
    vi.stubGlobal("fetch", fetchMock);
    renderAutopilot();

    fireEvent.click(
      await screen.findByRole("button", { name: "确认本章正文" }),
    );
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url]) =>
            String(url) === "/api/autopilot/sessions/session-1/actions",
        ),
      ).toBe(true),
    );
    const actionCall = fetchMock.mock.calls.find(
      ([url]) => String(url) === "/api/autopilot/sessions/session-1/actions",
    );
    expect(JSON.parse(String(actionCall?.[1]?.body))).toEqual({
      action: "accept_manuscript",
      requestId: "run-abc123:accept_manuscript",
    });
  });

  it("推舵令 POST /steers，目标 session id 与船身份取至当页，不含 profileId", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const setup = setupResponse(url);
      if (setup) return setup;
      if (url === "/api/projects/p-1/autopilot/sessions") return json([SESSION]);
      if (url === "/api/autopilot/sessions/session-1")
        return json(SESSION_DETAIL);
      if (url === "/api/autopilot/sessions/session-1/steers")
        return json({
          id: "steer-1",
          content: "三位合信少于百字",
          classification: null,
          status: "pending",
          effectiveBoundary: "next_chapter",
          rationale: null,
          risk: null,
          createdAt: "2026-08-11T00:00:00.000Z",
        });
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderAutopilot();

    // 舵令推进后服务端返回即可；火 steer 接口
    // 必须等 session detail 加载齐，才能选定 selectedSessionId
    await screen.findByText(/计划创作 6 章/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    fireEvent.change(screen.getByLabelText("新创作指示"), {
      target: { value: "三位合信少于百字" },
    });
    fireEvent.click(screen.getByRole("button", { name: /应用到后续创作/ }));

    await new Promise((resolve) => setTimeout(resolve, 200));
    const call = fetchMock.mock.calls.find(
      ([u]) => String(u) === "/api/autopilot/sessions/session-1/steers",
    );
    expect(call).toBeDefined();
    const body = JSON.parse(String(call?.[1]?.body));
    expect(body.content).toBe("三位合信少于百字");
    expect(body).not.toHaveProperty("profileId");
    expect(body).not.toHaveProperty("outputReserve");
  });

  it("从任务入口按 session 参数回到对应航次", async () => {
    const olderSession = {
      ...SESSION,
      id: "session-older",
      targetChapters: 3,
      completedChapters: 3,
      status: "completed",
      currentRunId: null,
      currentOutlineNodeId: null,
    };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const setup = setupResponse(url);
      if (setup) return setup;
      if (url === "/api/projects/p-1/autopilot/sessions") {
        return json([SESSION, olderSession]);
      }
      if (url === "/api/autopilot/sessions/session-older") {
        return json({ ...SESSION_DETAIL, session: olderSession, links: [] });
      }
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderAutopilot("/projects/p-1/autopilot?session=session-older");

    await screen.findByText(/计划创作 3 章/);
    expect(screen.getByRole("button", { name: "回到正在进行的创作" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "开始 AI 快速创作" })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/autopilot/sessions/session-1",
      expect.anything(),
    );
  });

  it("刷新后从服务端恢复建书任务，并明确正在等待自动重试", async () => {
    const failedRun = {
      id: "run-foundation",
      projectId: "p-1",
      recipe: "book-foundation",
      recipeVersion: 1,
      mode: "manual",
      status: "failed_recoverable",
      targetOutlineNodeId: "book-root",
      policy: { braindump: "灯灯在异世界旅行" },
      budgetLimit: { maxInputTokens: 100_000, maxOutputTokens: 24_000, maxCalls: 6, maxCostUsd: null, maxWallTimeMs: 600_000 },
      budgetUsage: { inputTokens: 0, outputTokens: 0, calls: 1, costUsd: 0, wallTimeMs: 45_000 },
      revisionCycle: 0,
      pauseRequested: false,
      cancelRequested: false,
      currentStepId: null,
      startedAt: "2026-08-10T10:00:00.000Z",
      finishedAt: null,
      createdAt: "2026-08-10T10:00:00.000Z",
      updatedAt: "2026-08-10T10:00:45.000Z",
      version: 2,
    };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects/p-1/foundation/candidates") return json([]);
      if (url === "/api/projects/p-1/runs") return json([failedRun]);
      if (url === "/api/projects/p-1/compass") return json(null);
      if (url === "/api/projects/p-1/autopilot/sessions") return json([]);
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderAutopilot("/projects/p-1/autopilot?foundation=run-foundation");

    expect(await screen.findByText("本次响应超时，等待自动重试")).toBeInTheDocument();
    expect(screen.getByLabelText("故事想法")).toHaveValue("灯灯在异世界旅行");
    expect(screen.getByRole("button", { name: "当前任务尚未结束" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "重新尝试" })).not.toBeInTheDocument();
  });

  it("无作品时可点击回藏书室，不拉会话", () => {
    const fetchMock = vi.fn(() => {
      throw new Error("should not fetch");
    });
    vi.stubGlobal("fetch", fetchMock);
    renderAutopilot("/missing");

    expect(screen.getByRole("heading", { name: "AI 快速创作" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回藏书室" })).toHaveAttribute("href", "/shelf");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("慢启动会话首读 pending 仍持续轮询，推进后停轮", async () => {
    vi.useFakeTimers();
    const sessionByRead = [PENDING_SESSION, RUNNING_SESSION, COMPLETED_SESSION, COMPLETED_SESSION];
    let readIndex = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects/p-1/foundation/candidates") return json([]);
      if (url === "/api/projects/p-1/runs") return json([]);
      if (url === "/api/projects/p-1/compass") return json(null);
      if (url === "/api/projects/p-1/autopilot/sessions") return json([sessionByRead[Math.min(readIndex, 3)]]);
      if (url === "/api/autopilot/sessions/session-slow") {
        const session = sessionByRead[Math.min(readIndex, 3)];
        readIndex += 1;
        return json(detailFor(session));
      }
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderAutopilot();

    await vi.waitFor(() => {
      expect(screen.queryByText("等待开始")).not.toBeNull();
      expect(readIndex).toBe(1);
    });

    /* pending 首读后仍轮询：1.4s 后读到 running */
    await vi.advanceTimersByTimeAsync(1_500);
    await vi.waitFor(() => expect(readIndex).toBe(2));
    await vi.waitFor(() => expect(screen.queryByText(/计划创作 6 章/)).not.toBeNull());

    /* running 继续轮询；读到 completed（终态）后停止 */
    await vi.advanceTimersByTimeAsync(1_500);
    await vi.waitFor(() => expect(readIndex).toBe(3));
    await vi.waitFor(() => expect(screen.queryByText("已完成")).not.toBeNull());
    await vi.advanceTimersByTimeAsync(6_000);
    expect(readIndex).toBe(3);
  });

  it("候选生成 Run 进行期间候选列表持续轮询，Run 落定后补拉并停轮", async () => {
    vi.useFakeTimers();
    let runStatus = "pending";
    let candidatesFetchCount = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects/p-1/foundation/candidates") {
        candidatesFetchCount += 1;
        return json(runStatus === "completed" ? [FOUNDATION_SET] : []);
      }
      if (url === "/api/projects/p-1/runs") return json([{ ...FOUNDATION_RUN_PENDING, status: runStatus }]);
      if (url === "/api/projects/p-1/compass") return json(null);
      if (url === "/api/projects/p-1/autopilot/sessions") return json([]);
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderAutopilot();

    await vi.waitFor(() => {
      expect(screen.queryByText("AI 正在整理创作方向")).not.toBeNull();
      expect(candidatesFetchCount).toBe(1);
    });

    /* 空候选列表也随进行中的 Run 轮询 */
    await vi.advanceTimersByTimeAsync(2_100);
    await vi.waitFor(() => expect(candidatesFetchCount).toBeGreaterThanOrEqual(2));

    /* Run 落定：轮询补拉到已写入的候选，随后停止轮询 */
    runStatus = "completed";
    await vi.advanceTimersByTimeAsync(2_100);
    await vi.waitFor(() => expect(screen.queryByText("灯灯的方向")).not.toBeNull());
    /* 候选进入 open 态：按既有契约继续轮询，直到作者处理候选集 */
    await vi.advanceTimersByTimeAsync(6_000);
    expect(candidatesFetchCount).toBeGreaterThan(3);
  });

  it("指南针查询失败时显示错误，不渲染可提交的空白表单", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const setup = setupResponse(url);
      if (url === "/api/projects/p-1/compass") {
        return json({ error: { code: "storage.unavailable", message: "compass 读取失败" } }, 500);
      }
      if (setup) return setup;
      if (url === "/api/projects/p-1/autopilot/sessions") return json([]);
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderAutopilot();

    await vi.waitFor(() => expect(screen.queryByText("创作方向读取失败")).not.toBeNull());
    expect(screen.queryByRole("button", { name: /确认创作方向|更新创作方向/ })).not.toBeInTheDocument();
  });

  it("新书尚无指南针时展示正常的创作方向表单", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const setup = setupResponse(url);
      if (url === "/api/projects/p-1/compass") {
        return json({ error: { code: "story_compass.not_found", message: "尚未建立故事指南针" } }, 404);
      }
      if (setup) return setup;
      if (url === "/api/projects/p-1/autopilot/sessions") return json([]);
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderAutopilot();

    expect(await screen.findByRole("button", { name: "确认创作方向" })).toBeInTheDocument();
    expect(screen.queryByText("创作方向读取失败")).not.toBeInTheDocument();
  });

  it("切换到终态创作记录后隐藏舵令，返回活动记录时草稿已清空", async () => {
    const completedSession = { ...SESSION, id: "session-done", status: "completed", targetChapters: 3, completedChapters: 3, currentRunId: null, currentOutlineNodeId: null };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const setup = setupResponse(url);
      if (setup) return setup;
      if (url === "/api/projects/p-1/autopilot/sessions") return json([SESSION, completedSession]);
      if (url === "/api/autopilot/sessions/session-1") return json(SESSION_DETAIL);
      if (url === "/api/autopilot/sessions/session-done") return json({ ...SESSION_DETAIL, session: completedSession, links: [], currentChapter: null, availableActions: [] });
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderAutopilot();

    await vi.waitFor(() => expect(screen.queryByText(/计划创作 6 章/)).not.toBeNull());
    const steerBox = screen.getByLabelText("新创作指示");
    fireEvent.change(steerBox, { target: { value: "写给会话一的指示" } });
    expect(steerBox).toHaveValue("写给会话一的指示");

    fireEvent.click(screen.getByRole("button", { name: /已完成 3\/3 章/ }));
    await vi.waitFor(() => expect(screen.queryByText(/计划创作 3 章/)).not.toBeNull());
    expect(screen.queryByLabelText("新创作指示")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /6 章/ }));
    await vi.waitFor(() => expect(screen.queryByText(/计划创作 6 章/)).not.toBeNull());
    expect(screen.getByLabelText("新创作指示")).toHaveValue("");
  });

  it("高影响创作指示显示采纳重排和拒绝继续动作", async () => {
    const awaiting = {
      ...SESSION_DETAIL,
      session: {
        ...SESSION,
        status: "awaiting_user",
        lastError: { code: "steer.canon_change", steerId: "steer-canon" },
      },
      steers: [
        {
          id: "steer-canon",
          projectId: "p-1",
          sessionId: "session-1",
          targetRunId: "run-abc123",
          content: "把父亲改成主动隐瞒灯塔规则。",
          classification: "canon_change",
          status: "awaiting_confirmation",
          effectiveBoundary: "future",
          rationale: "涉及已确认设定，需要作者裁定",
          risk: "medium",
          classificationRunId: "run-steer",
          appliedAt: null,
          createdAt: "2026-08-10T12:00:00.000Z",
          updatedAt: "2026-08-10T12:00:00.000Z",
        },
      ],
      stopReason: "steer.canon_change",
      availableActions: ["cancel"],
    };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const setup = setupResponse(url);
      if (setup) return setup;
      if (url === "/api/projects/p-1/autopilot/sessions") return json([awaiting.session]);
      if (url === "/api/autopilot/sessions/session-1") return json(awaiting);
      if (url === "/api/autopilot/sessions/session-1/steers/steer-canon/decisions") {
        return json({ steer: { ...awaiting.steers[0], status: "applied" }, detail: awaiting });
      }
      throw new Error(`unexpected request ${url} ${init?.method ?? "GET"}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderAutopilot("/projects/p-1/autopilot?session=session-1");

    expect(await screen.findByText("待裁定的创作指示")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "采纳并重排" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/autopilot/sessions/session-1/steers/steer-canon/decisions",
        expect.objectContaining({ method: "POST", body: JSON.stringify({ action: "apply" }) }),
      ),
    );
    expect(screen.getByRole("button", { name: "不采用，继续创作" })).toBeInTheDocument();
  });
});
