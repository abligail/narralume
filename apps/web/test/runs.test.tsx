// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "../src/i18n";
import { RunsWorkspace } from "../src/workspaces/runs";

const NOW = Date.now();

const RUN_COMPLETED = {
  id: "run-1",
  projectId: "p-1",
  recipe: "chapter-production",
  recipeVersion: 1,
  mode: "chapter-gate",
  status: "completed",
  targetOutlineNodeId: "n-ch-1",
  policy: {},
  budgetLimit: {
    maxInputTokens: 10_000,
    maxOutputTokens: 4_000,
    maxCalls: 8,
    maxCostUsd: 0.5,
    maxWallTimeMs: 300_000,
  },
  budgetUsage: {
    inputTokens: 1620,
    outputTokens: 1400,
    calls: 3,
    costUsd: 0.01,
    wallTimeMs: 4_200,
  },
  revisionCycle: 0,
  pauseRequested: false,
  cancelRequested: false,
  currentStepId: null,
  startedAt: new Date(NOW - 3_000).toISOString(),
  finishedAt: new Date(NOW).toISOString(),
  createdAt: "2026-08-10T10:00:00.000Z",
  updatedAt: "2026-08-10T12:00:00.000Z",
  version: 1,
};

const RUN_RUNNING = {
  ...RUN_COMPLETED,
  id: "run-2",
  status: "running",
  revisionCycle: 1,
  startedAt: null,
  finishedAt: null,
  createdAt: "2026-08-11T09:00:00.000Z",
};

const RUN_DETAIL = {
  run: RUN_COMPLETED,
  steps: [
    { id: "step-1", runId: "run-1", ordinal: 0, kind: "draft.generate", status: "succeeded", attempt: 2, maxAttempts: 3, error: null },
    { id: "step-2", runId: "run-1", ordinal: 1, kind: "chapter.commit", status: "succeeded", attempt: 1, maxAttempts: 1, error: null },
  ],
  events: [],
  latestCheckpoint: null,
  origin: null,
  parentTask: null,
  result: { kind: "none" },
  availableActions: [],
  llmCalls: [],
  contextReceipts: [],
  modelSnapshots: [],
  reviews: [],
  streams: [],
  effectivePolicy: null,
};

function json(value: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

function renderRuns(entry = "/projects/p-1/runs") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/projects/:projectId/runs" element={<RunsWorkspace />} />
          <Route path="/missing" element={<RunsWorkspace />} />
          <Route path="/shelf" element={<p>已入馆：藏书室</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

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
  vi.unstubAllGlobals();
});

describe("运行中心", () => {
  it("电影期号目录 + 期主档按 ISSUE NO. 组合", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects/p-1/runs") return json([RUN_COMPLETED, RUN_RUNNING]);
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderRuns();

    await screen.findByText("ISSUE NO. 202608");
    expect(screen.getByText(/ISSUE NO\. 202608/)).toBeInTheDocument();
    // 左栏期号索引
    expect(screen.getByRole("button", { name: /2026-08 月刊/ })).toBeInTheDocument();
    // 行项
    expect(screen.getAllByText(/chapter-production/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/完成|执行中/).length).toBeGreaterThan(0);
    expect(screen.getByText(/run-2/)).toBeInTheDocument();
    expect(screen.getByText(/run-1/)).toBeInTheDocument();
    expect(screen.getAllByText(/模型调用 3 次/)).toHaveLength(2);
    expect(screen.queryByText(/3\/8 调/)).not.toBeInTheDocument();
  });

  it("运行详情把流程进度与包含重试的模型调用拆开显示", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects/p-1/runs") return json([RUN_COMPLETED]);
      if (url === "/api/runs/run-1?projectId=p-1") return json(RUN_DETAIL);
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderRuns("/projects/p-1/runs?run=run-1");

    expect(await screen.findByText("流程 2/2")).toBeInTheDocument();
    expect(screen.getAllByText("模型调用 3 次").length).toBeGreaterThan(0);
    expect(screen.queryByText("步骤 2")).not.toBeInTheDocument();
  });

  it("可恢复故障单列为等待重试，且没有服务端动作时不猜测推进按钮", async () => {
    const recoverable = {
      ...RUN_RUNNING,
      id: "run-retry",
      status: "failed_recoverable",
    };
    const detail = {
      ...RUN_DETAIL,
      run: recoverable,
      availableActions: [],
    };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects/p-1/runs") return json([recoverable]);
      if (url === "/api/runs/run-retry?projectId=p-1") return json(detail);
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderRuns("/projects/p-1/runs?run=run-retry");

    expect(await screen.findByText(/等待重试 1/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "推进一步" })).not.toBeInTheDocument();
  });

  it("快速创作子任务回到所属任务，不显示独立重试", async () => {
    const failed = {
      ...RUN_COMPLETED,
      id: "run-owned",
      status: "failed",
    };
    const detail = {
      ...RUN_DETAIL,
      run: failed,
      parentTask: { kind: "autopilot", id: "session-1" },
      availableActions: [],
    };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects/p-1/runs") return json([failed]);
      if (url === "/api/runs/run-owned?projectId=p-1") return json(detail);
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderRuns("/projects/p-1/runs?run=run-owned");

    expect(await screen.findByRole("link", { name: "返回快速创作任务" })).toHaveAttribute(
      "href",
      "/projects/p-1/autopilot?session=session-1",
    );
    expect(screen.queryByRole("button", { name: "重试本章" })).not.toBeInTheDocument();
  });

  it("运行列表正在轮询问于运行中（轮询1.25s），且 body 不带 policy/profile", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects/p-1/runs") return json([RUN_RUNNING]);
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderRuns();

    await screen.findByText(/ISSUE NO\. 202608/);
    // 检查轮询已发起
    await new Promise((resolve) => setTimeout(resolve, 1800));
    const calls = fetchMock.mock.calls.filter(([u]) =>
      String(u).includes("/api/projects/p-1/runs"),
    );
    expect(calls.length).toBeGreaterThanOrEqual(2);
    // 反断言：无 profileId/policy 字段
    for (const call of calls) {
      expect(String(call[1]?.body ?? "")).not.toContain("profileId");
      expect(String(call[1]?.body ?? "")).not.toContain("outputReserve");
    }
  });

  it("无作品时藏起空馆态且不发请求", () => {
    const fetchMock = vi.fn(() => {
      throw new Error("should not fetch");
    });
    vi.stubGlobal("fetch", fetchMock);
    renderRuns("/missing");

    expect(screen.getByRole("heading", { name: "运行中心" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回藏书室" })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
