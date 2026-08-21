// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "../src/i18n";
import { StudioWorkspace } from "../src/workspaces/studio";

/* 写作台：目录 + 稿编辑器 + 批注/版本印记。 */

const DOC_LIST = [
  {
    id: "doc-ch-1",
    projectId: "p-1",
    kind: "chapter",
    title: "第一章 灯下潮痕",
    outlineNodeId: "node-ch-1",
    currentVersionId: "ver-1",
    createdAt: "2026-08-09T10:00:00.000Z",
    updatedAt: "2026-08-10T10:00:00.000Z",
  },
  {
    id: "doc-synopsis",
    projectId: "p-1",
    kind: "synopsis",
    title: "全书要约",
    outlineNodeId: null,
    currentVersionId: null,
    createdAt: "2026-08-09T10:00:00.000Z",
    updatedAt: "2026-08-09T10:00:00.000Z",
  },
];

const DOC_DETAIL = {
  document: DOC_LIST[0],
  currentVersion: {
    id: "ver-1",
    documentId: "doc-ch-1",
    parentVersionId: null,
    content: "# 第一章 灯下潮痕\n\n潮水在午夜越过旧钟楼。",
    contentHash: "hash-1",
    source: "manual",
    runId: null,
    createdAt: "2026-08-10T10:00:00.000Z",
  },
  draft: {
    projectId: "p-1",
    documentId: "doc-ch-1",
    baseVersionId: "ver-1",
    content: "# 第一章 灯下潮痕\n\n潮水在午夜越过旧钟楼。",
    contentHash: "hash-1",
    updatedAt: "2026-08-10T10:00:00.000Z",
  },
  versions: [
    {
      id: "ver-0",
      documentId: "doc-ch-1",
      parentVersionId: null,
      content: "空白大僵",
      contentHash: "hash-0",
      source: "manual",
      runId: null,
      createdAt: "2026-08-09T10:00:00.000Z",
    },
    {
      id: "ver-1",
      documentId: "doc-ch-1",
      parentVersionId: "ver-0",
      content: "# 第一章 灯下潮痕\n\n潮水在午夜越过旧钟楼。",
      contentHash: "hash-1",
      source: "manual",
      runId: null,
      createdAt: "2026-08-10T10:00:00.000Z",
    },
  ],
  comments: [
    {
      id: "cmt-1",
      projectId: "p-1",
      documentId: "doc-ch-1",
      versionId: "ver-1",
      startOffset: 10,
      endOffset: 42,
      quote: "潮水在午夜越过旧钟楼。",
      body: "「越过」动了不够透；要么加重浪错词，要么改成贴住塌道？",
      status: "open",
      createdAt: "2026-08-10T10:00:00.000Z",
      updatedAt: "2026-08-10T10:00:00.000Z",
    },
  ],
  proposals: [],
};

class EventSourceStub {
  static instances: EventSourceStub[] = [];
  readonly close = vi.fn();
  private readonly listeners = new Map<string, EventListener[]>();

  constructor() {
    EventSourceStub.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  emit(type: string, data: unknown) {
    const event = new MessageEvent(type, { data: JSON.stringify(data) });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function json(value: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

function renderStudio(entry = "/projects/p-1/studio") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/projects/:projectId/studio" element={<StudioWorkspace />} />
          <Route path="/missing" element={<StudioWorkspace />} />
          <Route path="/shelf" element={<p>已入馆：藏书室</p>} />
          <Route path="/bible" element={<p>已入馆：故事圣经</p>} />
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
  EventSourceStub.instances = [];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("写作台", () => {
  it("没有稿件时在真实三栏中给出开卷引导", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/projects/p-1/studio/documents") return json([]);
        throw new Error(`unexpected request ${url}`);
      }),
    );
    renderStudio();

    expect(await screen.findByText("稿纸还未开卷")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "新建第一件稿件" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "去故事页规划章节" })).toHaveAttribute("href", "/projects/p-1/bible");
  });

  it("场景稿只开放局部 AI 编辑，不显示章节生产入口", async () => {
    const sceneDocument = {
      ...DOC_LIST[0]!,
      id: "doc-scene",
      kind: "scene",
      title: "钟楼门前",
      outlineNodeId: "node-scene",
    };
    const sceneDetail = {
      ...DOC_DETAIL,
      document: sceneDocument,
      currentVersion: { ...DOC_DETAIL.currentVersion, documentId: "doc-scene" },
      versions: [{ ...DOC_DETAIL.currentVersion, documentId: "doc-scene" }],
    };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects/p-1/studio/documents") return json([sceneDocument]);
      if (url === "/api/projects/p-1/studio/documents/doc-scene") return json(sceneDetail);
      if (url === "/api/projects/p-1/reviews") return json({ reports: [], proposals: [] });
      if (url === "/api/projects/p-1/canon-change-sets") return json({ changeSets: [] });
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderStudio();

    expect(await screen.findByText(/场景稿可使用右侧选区 AI 编辑/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /交给 AI/ })).not.toBeInTheDocument();
  });

  it("空章节给出有效的起笔提示，不再显示只聚焦编辑器的按钮", async () => {
    const emptyDetail = {
      ...DOC_DETAIL,
      currentVersion: { ...DOC_DETAIL.currentVersion, content: "", contentHash: "empty" },
      draft: { ...DOC_DETAIL.draft, content: "", contentHash: "empty" },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/projects/p-1/studio/documents") return json(DOC_LIST);
        if (url === "/api/projects/p-1/studio/documents/doc-ch-1") return json(emptyDetail);
        if (url === "/api/projects/p-1/reviews") return json({ reports: [], proposals: [] });
        if (url === "/api/projects/p-1/overview") return json({ activeTask: null });
        throw new Error(`unexpected request ${url}`);
      }),
    );
    renderStudio();

    expect(await screen.findByText("从一个具体的画面开始")).toBeInTheDocument();
    expect(screen.getByText(/把本章交给下方的 AI 起草/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "落下第一行" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /交给 AI/ })).toBeInTheDocument();
  });

  it("返回写作台时从任务台账恢复当前章节候选稿和采纳入口", async () => {
    const targetDocument = {
      ...DOC_LIST[0]!,
      id: "doc-ch-2",
      title: "第二章 雾门回声",
      outlineNodeId: "node-ch-2",
    };
    const targetDetail = {
      ...DOC_DETAIL,
      document: targetDocument,
      currentVersion: {
        ...DOC_DETAIL.currentVersion,
        documentId: targetDocument.id,
      },
      draft: { ...DOC_DETAIL.draft, documentId: targetDocument.id },
      versions: DOC_DETAIL.versions.map((version) => ({
        ...version,
        documentId: targetDocument.id,
      })),
    };
    window.localStorage.setItem(
      "narralume:task-ledger",
      JSON.stringify([
        {
          projectId: "p-1",
          kind: "chapter",
          taskId: "run-returned",
          label: "交给 AI：《第二章 雾门回声》",
          createdAt: "2026-08-10T10:00:00.000Z",
          origin: { surface: "writing", documentId: targetDocument.id },
          documentId: targetDocument.id,
        },
      ]),
    );
    const candidate = "潮水推开雾门，旧钟楼在远处响了一声。";
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects/p-1/studio/documents") {
        return json([...DOC_LIST, targetDocument]);
      }
      if (url === "/api/projects/p-1/studio/documents/doc-ch-1") return json(DOC_DETAIL);
      if (url === "/api/projects/p-1/studio/documents/doc-ch-2") return json(targetDetail);
      if (url === "/api/projects/p-1/reviews") return json({ reports: [], proposals: [] });
      if (url === "/api/projects/p-1/overview") return json({ activeTask: null });
      if (url === "/api/runs/run-returned?projectId=p-1") return json({
        run: {
          id: "run-returned",
          projectId: "p-1",
          recipe: "chapter-production",
          status: "awaiting_user",
        },
        result: {
          manuscriptCandidate: { content: candidate },
          planCandidate: null,
          reviewSummary: null,
          settlementCandidate: null,
        },
        availableActions: ["accept_manuscript", "request_revision", "discard_manuscript"],
      });
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderStudio("/projects/p-1/studio");

    expect(await screen.findByText(candidate)).toBeInTheDocument();
    expect(screen.getAllByText("第二章 雾门回声").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "采纳为正文版本" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/runs/run-returned?projectId=p-1",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("单章任务可恢复故障明确显示等待自动重试", async () => {
    const run = {
      id: "run-recoverable",
      projectId: "p-1",
      recipe: "chapter-production",
      recipeVersion: 1,
      mode: "chapter-gate",
      status: "failed_recoverable",
      targetOutlineNodeId: "node-ch-1",
      policy: {},
      budgetLimit: { maxInputTokens: 10_000, maxOutputTokens: 4_000, maxCalls: 8, maxCostUsd: null, maxWallTimeMs: 300_000 },
      budgetUsage: { inputTokens: 0, outputTokens: 0, calls: 1, costUsd: 0, wallTimeMs: 30_000 },
      revisionCycle: 0,
      pauseRequested: false,
      cancelRequested: false,
      currentStepId: null,
      startedAt: null,
      finishedAt: null,
      createdAt: "2026-08-10T10:00:00.000Z",
      updatedAt: "2026-08-10T10:00:30.000Z",
      version: 1,
    };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects/p-1/studio/documents") return json(DOC_LIST);
      if (url === "/api/projects/p-1/studio/documents/doc-ch-1") return json(DOC_DETAIL);
      if (url === "/api/projects/p-1/reviews") return json({ reports: [], proposals: [] });
      if (url === "/api/projects/p-1/canon-change-sets") return json({ changeSets: [] });
      if (url === "/api/runs/run-recoverable?projectId=p-1") {
        return json({
          run,
          steps: [],
          events: [],
          latestCheckpoint: null,
          origin: { surface: "writing", documentId: "doc-ch-1", selection: null },
          result: {},
          availableActions: [],
          llmCalls: [],
          contextReceipts: [],
          modelSnapshots: [],
          reviews: [],
          streams: [],
          effectivePolicy: null,
        });
      }
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderStudio("/projects/p-1/studio?run=run-recoverable");

    expect(await screen.findAllByText("等待自动重试")).toHaveLength(2);
    expect(screen.queryByText("AI 正在完成本章")).not.toBeInTheDocument();
  });

  it("终态失败的单章任务展示失败原因，重试本章发起新 run", async () => {
    const failedRun = {
      id: "run-failed",
      projectId: "p-1",
      recipe: "chapter-production",
      recipeVersion: 1,
      mode: "chapter-gate",
      status: "failed",
      targetOutlineNodeId: "node-ch-1",
      policy: { origin: { surface: "writing", documentId: "doc-ch-1", selection: null } },
      budgetLimit: { maxInputTokens: 10_000, maxOutputTokens: 4_000, maxCalls: 8, maxCostUsd: null, maxWallTimeMs: 300_000 },
      budgetUsage: { inputTokens: 0, outputTokens: 0, calls: 5, costUsd: 0, wallTimeMs: 90_000 },
      revisionCycle: 0,
      pauseRequested: false,
      cancelRequested: false,
      currentStepId: null,
      startedAt: null,
      finishedAt: "2026-08-10T10:01:30.000Z",
      createdAt: "2026-08-10T10:00:00.000Z",
      updatedAt: "2026-08-10T10:01:30.000Z",
      version: 1,
    };
    const failedDetail = {
      run: failedRun,
      steps: [
        {
          id: "run-failed:draft",
          ordinal: 2,
          kind: "draft.generate",
          cycle: 0,
          status: "failed",
          attempt: 5,
          maxAttempts: 5,
          error: { code: "model.network", message: "fetch failed", retryable: true },
        },
      ],
      events: [],
      latestCheckpoint: null,
      origin: { surface: "writing", documentId: "doc-ch-1", selection: null },
      parentTask: null,
      result: {},
      availableActions: ["retry_chapter"],
      llmCalls: [],
      contextReceipts: [],
      modelSnapshots: [],
      reviews: [],
      streams: [],
      effectivePolicy: { maxRetries: 4 },
    };
    const retriedDetail = {
      ...failedDetail,
      run: { ...failedRun, id: "run-retry-1", status: "pending", finishedAt: null, policy: {} },
      steps: [],
    };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/projects/p-1/studio/documents") return json(DOC_LIST);
      if (url === "/api/projects/p-1/studio/documents/doc-ch-1") return json(DOC_DETAIL);
      if (url === "/api/projects/p-1/reviews") return json({ reports: [], proposals: [] });
      if (url === "/api/projects/p-1/canon-change-sets") return json({ changeSets: [] });
      if (url === "/api/runs/run-failed?projectId=p-1") return json(failedDetail);
      if (url === "/api/runs/run-retry-1?projectId=p-1") return json(retriedDetail);
      if (url === "/api/runs/run-failed/actions" && init?.method === "POST") {
        return json({ run: { id: "run-retry-1" } }, 202);
      }
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderStudio("/projects/p-1/studio?run=run-failed");

    expect(await screen.findByText("本章生成失败")).toBeInTheDocument();
    expect(screen.getByText("model.network · fetch failed")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试本章" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/runs/run-failed/actions",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining('"action":"retry_chapter"'),
        }),
      ),
    );
    const retryBody = JSON.parse(
      fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url) === "/api/runs/run-failed/actions" && init?.method === "POST",
      )![1]!.body as string,
    );
    expect(retryBody).toMatchObject({
      action: "retry_chapter",
      projectId: "p-1",
    });
    expect(await screen.findByText("AI 正在完成本章")).toBeInTheDocument();
  });

  it("目录 + 中央编辑器 + 一次只展开一项的右侧工具坞", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects/p-1/studio/documents") return json(DOC_LIST);
      if (url === "/api/projects/p-1/studio/documents/doc-ch-1")
        return json(DOC_DETAIL);
      if (url === "/api/projects/p-1/reviews")
        return json({ reports: [], proposals: [] });
      if (url === "/api/projects/p-1/canon-change-sets")
        return json({ changeSets: [] });
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderStudio();

    await screen.findByRole(
      "button",
      { name: /第一章 灯下潮痕/ },
      { timeout: 3_000 },
    );
    expect(screen.getAllByText("第一章 灯下潮痕").length).toBeGreaterThan(0);
    expect(
      screen.getByRole("button", { name: /全书要约/ }),
    ).toBeInTheDocument();
    // 编辑器默认带现稿正文
    const editor = await screen.findByLabelText<HTMLTextAreaElement>(
      "Markdown 正文编辑器",
    );
    expect(editor).toBeInTheDocument();
    expect(editor.value).toContain("潮水在午夜越过旧钟楼。");
    expect(screen.getByText("保存新版本")).toBeInTheDocument();
    expect(screen.getByRole("tabpanel", { name: "审稿工具" })).toBeInTheDocument();
    expect(screen.queryByText(/「越过」动了不够透/)).not.toBeInTheDocument();
    expect(screen.queryByText("v1")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /批注/ }));
    expect(screen.getByText(/「越过」动了不够透/)).toBeInTheDocument();
    expect(screen.queryByText("本稿尚无审稿报告")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /版本/ }));
    expect(screen.getByText("v1")).toBeInTheDocument();
    expect(screen.getByText("v2")).toBeInTheDocument();
    expect(screen.queryByText(/「越过」动了不够透/)).not.toBeInTheDocument();
  });

  it("保存新版本 POST /versions；body 不含 profileId/outputReserve", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/projects/p-1/studio/documents") return json(DOC_LIST);
      if (url === "/api/projects/p-1/studio/documents/doc-ch-1")
        return json(DOC_DETAIL);
      if (
        url === "/api/projects/p-1/documents/doc-ch-1/versions" &&
        init?.method === "POST"
      ) {
        return json({
          id: "ver-2",
          documentId: "doc-ch-1",
          parentVersionId: "ver-1",
          content: String(
            JSON.parse(String(init?.body)).content,
          ),
          contentHash: "hash-2",
          source: "manual",
          runId: null,
          createdAt: "2026-08-11T10:00:00.000Z",
        });
      }
      if (url === "/api/projects/p-1/reviews")
        return json({ reports: [], proposals: [] });
      if (url === "/api/projects/p-1/canon-change-sets")
        return json({ changeSets: [] });
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderStudio();

    await screen.findByLabelText("Markdown 正文编辑器");
    fireEvent.change(screen.getByLabelText("Markdown 正文编辑器"), {
      target: { value: "# 第一章 灯下潮痕\n\n潮水在午夜越过旧钟楼。\n信上名字渐渐显影。" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存新版本" }));

    await screen.findByText("版本已写入");
    // 反断言
    const call = fetchMock.mock.calls.find(
      ([u, init]) =>
        String(u) === "/api/projects/p-1/documents/doc-ch-1/versions" &&
        init?.method === "POST",
    );
    expect(call).toBeDefined();
    const body = JSON.parse(String(call?.[1]?.body));
    expect(body.source).toBe("manual");
    expect(body).not.toHaveProperty("profileId");
    expect(body).not.toHaveProperty("outputReserve");
  });

  it("手动结算运行中在故事变化面板显示提取状态，失败时给出排查入口", async () => {
    const settlementRun = (status: string) => ({
      id: `run-settle-${status}`,
      projectId: "p-1",
      recipe: "manual-settlement",
      recipeVersion: 1,
      mode: "manual",
      status,
      targetOutlineNodeId: null,
      policy: {
        documentId: "doc-ch-1",
        documentVersionId: "ver-2",
        origin: { surface: "writing", documentId: "doc-ch-1" },
      },
      budgetLimit: { maxInputTokens: 400_000, maxOutputTokens: 24_000, maxCalls: 8, maxCostUsd: null, maxWallTimeMs: 1_800_000 },
      budgetUsage: { inputTokens: 0, outputTokens: 0, calls: 1, costUsd: 0, wallTimeMs: 1_000 },
      revisionCycle: 0,
      pauseRequested: false,
      cancelRequested: false,
      currentStepId: null,
      startedAt: "2026-08-16T10:00:00.000Z",
      finishedAt: null,
      createdAt: "2026-08-16T10:00:00.000Z",
      updatedAt: "2026-08-16T10:00:30.000Z",
      version: 1,
    });
    const renderWithRuns = async (runs: unknown[]) => {
      const fetchMock = vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/projects/p-1/studio/documents") return json(DOC_LIST);
        if (url === "/api/projects/p-1/studio/documents/doc-ch-1") return json(DOC_DETAIL);
        if (url === "/api/projects/p-1/reviews") return json({ reports: [], proposals: [] });
        if (url === "/api/projects/p-1/canon-change-sets") return json({ changeSets: [] });
        if (url === "/api/projects/p-1/runs") return json(runs);
        if (url === "/api/projects/p-1/story-bible") return json({ outline: [], entities: [] });
        throw new Error(`unexpected request ${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);
      renderStudio();
      fireEvent.click(await screen.findByRole("tab", { name: /故事变化/ }));
      return fetchMock;
    };

    await renderWithRuns([settlementRun("running")]);
    expect(await screen.findByText(/正在从本章正文提取故事变化/)).toBeInTheDocument();
    expect(screen.queryByText(/当前正文没有待裁定的故事变化/)).not.toBeInTheDocument();
    cleanup();

    await renderWithRuns([settlementRun("failed")]);
    expect(await screen.findByText(/最近一次变化提取失败/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /查看任务详情/ })).toHaveAttribute(
      "href",
      "/projects/p-1/runs?run=run-settle-failed",
    );
  });

  it("新建章节必须选择尚未绑定的章节大纲节点", async () => {
    const createBodies: Array<Record<string, unknown>> = [];
    const createdDocument = {
      ...DOC_LIST[0],
      id: "doc-ch-2",
      title: "第二章 雾中来信",
      outlineNodeId: "node-ch-2",
      currentVersionId: null,
    };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/projects/p-1/studio/documents") return json(DOC_LIST);
      if (url === "/api/projects/p-1/studio/documents/doc-ch-1") return json(DOC_DETAIL);
      if (url === "/api/projects/p-1/studio/documents/doc-ch-2") return json({ document: createdDocument, currentVersion: null, draft: null, versions: [], comments: [], proposals: [] });
      if (url === "/api/projects/p-1/story-bible") return json({ occupiedOutlineNodeIds: ["node-ch-1"], outline: [{ id: "node-ch-1", projectId: "p-1", parentId: null, kind: "chapter", path: "001", depth: 0, ordinal: 1, title: "第一章 灯下潮痕", summary: null, goal: null, conflict: null, outcome: null, povEntityId: null, storyTime: null, status: "planned", metadata: {}, createdAt: "2026-08-10T00:00:00.000Z", updatedAt: "2026-08-10T00:00:00.000Z" }, { id: "node-ch-2", projectId: "p-1", parentId: null, kind: "chapter", path: "002", depth: 0, ordinal: 2, title: "第二章 雾中来信", summary: null, goal: null, conflict: null, outcome: null, povEntityId: null, storyTime: null, status: "planned", metadata: {}, createdAt: "2026-08-10T00:00:00.000Z", updatedAt: "2026-08-10T00:00:00.000Z" }] });
      if (url === "/api/projects/p-1/documents" && init?.method === "POST") {
        createBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        if (createBodies.length === 1) {
          return Promise.reject(new Error("response lost"));
        }
        return json(createdDocument, 201);
      }
      if (url === "/api/projects/p-1/reviews") return json({ reports: [], proposals: [] });
      if (url === "/api/projects/p-1/canon-change-sets") return json({ changeSets: [] });
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderStudio();

    fireEvent.click(await screen.findByRole("button", { name: "新建" }));
    const outlineSelect = await screen.findByLabelText<HTMLSelectElement>("对应大纲节点");
    await waitFor(() => expect(outlineSelect).toHaveValue("node-ch-2"));
    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() => expect(createBodies).toHaveLength(1));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "创建" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    await waitFor(() => expect(createBodies).toHaveLength(2));
    expect(createBodies[0]).toEqual({
      kind: "chapter",
      title: "第二章 雾中来信",
      outlineNodeId: "node-ch-2",
      requestId: expect.any(String),
    });
    expect(createBodies[1]?.requestId).toBe(createBodies[0]?.requestId);
  });

  it("切换稿件前强制同步当前草稿，并在切回时保留最新正文", async () => {
    const changed = "# 第一章 灯下潮痕\n\n这一行必须先保存，再允许切换。";
    const secondDetail = { document: DOC_LIST[1], currentVersion: null, draft: null, versions: [], comments: [], proposals: [] };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/projects/p-1/studio/documents") return json(DOC_LIST);
      if (url === "/api/projects/p-1/studio/documents/doc-ch-1") return json(DOC_DETAIL);
      if (url === "/api/projects/p-1/studio/documents/doc-synopsis") return json(secondDetail);
      if (url === "/api/projects/p-1/studio/documents/doc-ch-1/draft" && init?.method === "PUT") return json({ ...DOC_DETAIL.draft, content: changed, contentHash: "a".repeat(64) });
      if (url === "/api/projects/p-1/reviews") return json({ reports: [], proposals: [] });
      if (url === "/api/projects/p-1/canon-change-sets") return json({ changeSets: [] });
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderStudio();

    const editor = await screen.findByLabelText<HTMLTextAreaElement>("Markdown 正文编辑器");
    fireEvent.change(editor, { target: { value: changed } });
    fireEvent.click(screen.getByRole("button", { name: /全书要约/ }));
    await waitFor(() => expect(screen.getByLabelText<HTMLTextAreaElement>("Markdown 正文编辑器")).toHaveValue(""));

    const urls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(urls.indexOf("/api/projects/p-1/studio/documents/doc-ch-1/draft")).toBeLessThan(urls.indexOf("/api/projects/p-1/studio/documents/doc-synopsis"));
    fireEvent.click(screen.getByRole("button", { name: /第一章 灯下潮痕/ }));
    await waitFor(() => expect(screen.getByLabelText<HTMLTextAreaElement>("Markdown 正文编辑器")).toHaveValue(changed));
  });

  it("草稿选区批注会先建立稳定版本，再把批注锚定到新版本", async () => {
    const changed = `${DOC_DETAIL.currentVersion.content}\n新写的一句。`;
    let commentBody: Record<string, unknown> | null = null;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/projects/p-1/studio/documents") return json(DOC_LIST);
      if (url === "/api/projects/p-1/studio/documents/doc-ch-1") return json(DOC_DETAIL);
      if (url === "/api/projects/p-1/documents/doc-ch-1/versions" && init?.method === "POST") return json({ ...DOC_DETAIL.currentVersion, id: "ver-comment", content: changed, contentHash: "b".repeat(64) }, 201);
      if (url === "/api/projects/p-1/studio/documents/doc-ch-1/comments" && init?.method === "POST") {
        commentBody = JSON.parse(String(init.body));
        return json({ id: "comment-2", projectId: "p-1", documentId: "doc-ch-1", status: "open", createdAt: "2026-08-12T00:00:00.000Z", updatedAt: "2026-08-12T00:00:00.000Z", ...commentBody }, 201);
      }
      if (url === "/api/projects/p-1/reviews") return json({ reports: [], proposals: [] });
      if (url === "/api/projects/p-1/canon-change-sets") return json({ changeSets: [] });
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderStudio();

    const editor = await screen.findByLabelText<HTMLTextAreaElement>("Markdown 正文编辑器");
    fireEvent.change(editor, { target: { value: changed } });
    editor.setSelectionRange(changed.length - 6, changed.length);
    fireEvent.select(editor);
    fireEvent.click(screen.getByRole("tab", { name: /选区/ }));
    fireEvent.change(screen.getByLabelText("批注"), { target: { value: "这里需要回看。" } });
    fireEvent.click(screen.getByRole("button", { name: "保存版本并批注" }));

    await waitFor(() => expect(commentBody).not.toBeNull());
    expect(commentBody).toMatchObject({ versionId: "ver-comment", body: "这里需要回看。" });
  });

  it("AI 选区修改同步最新草稿并提交 draftContentHash", async () => {
    const changed = `${DOC_DETAIL.currentVersion.content}\n等待 AI 改写。`;
    const draftHash = "c".repeat(64);
    let editBody: Record<string, unknown> | null = null;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/projects/p-1/studio/documents") return json(DOC_LIST);
      if (url === "/api/projects/p-1/studio/documents/doc-ch-1") return json(DOC_DETAIL);
      if (url === "/api/projects/p-1/studio/documents/doc-ch-1/draft" && init?.method === "PUT") return json({ ...DOC_DETAIL.draft, content: changed, contentHash: draftHash });
      if (url === "/api/projects/p-1/studio/documents/doc-ch-1/selection-edits" && init?.method === "POST") {
        editBody = JSON.parse(String(init.body));
        return json({ run: { id: "run-edit" }, steps: [], events: [], latestCheckpoint: null }, 202);
      }
      if (url === "/api/projects/p-1/reviews") return json({ reports: [], proposals: [] });
      if (url === "/api/projects/p-1/canon-change-sets") return json({ changeSets: [] });
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderStudio();

    const editor = await screen.findByLabelText<HTMLTextAreaElement>("Markdown 正文编辑器");
    fireEvent.change(editor, { target: { value: changed } });
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/draft"))).toBe(true), { timeout: 2_000 });
    editor.setSelectionRange(changed.length - 8, changed.length);
    fireEvent.select(editor);
    fireEvent.click(screen.getByRole("tab", { name: /选区/ }));
    fireEvent.change(screen.getByLabelText("AI 编辑指令"), { target: { value: "让句子更克制。" } });
    fireEvent.click(screen.getByRole("button", { name: "生成编辑提案" }));

    await waitFor(() => expect(editBody).not.toBeNull());
    expect(editBody).toMatchObject({ baseVersionId: "ver-1", draftContentHash: draftHash, instruction: "让句子更克制。" });
  });

  it("空态 + 无项目时不拉接口", () => {
    const fetchMock = vi.fn(() => {
      throw new Error("should not fetch");
    });
    vi.stubGlobal("fetch", fetchMock);
    renderStudio("/missing");

    expect(screen.getByRole("heading", { name: "写作" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回藏书室" })).toBeInTheDocument();
    // 反断言：骨架、目录都不必渲染；fetchides也不为故事圣经发请求
    expect(screen.queryByText("稿目")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/* ---- 合并：审稿 + 修订提案 + 故事变化 + 单章「交给 AI」 ----------------------- */

const REPORT = {
  id: "rev-1",
  projectId: "p-1",
  runId: "run-1",
  stepId: "step-1",
  documentVersionId: "ver-1",
  documentId: "doc-ch-1",
  documentTitle: "第一章 灯下潮痕",
  verdict: "revise",
  summary: "两处以主角视角写到了他尚不知道的真相；其余结构成立。",
  scores: { continuity: 7, pov: 4, prose: 8 },
  reviewedContent:
    "潮水在午夜越过旧钟楼。\n沈砚并不知道灯塔已被他父亲的谎言熄灭。\n她把信纸放进煤油灯下，名字缓缓显影。",
  reviewedContentHash: "abc123def456",
  issues: [
    {
      id: "iss-1",
      category: "pov",
      severity: "major",
      message: "从沈砚视角叙述了他尚不知道的真相——视角泄漏。",
      evidence: [
        { quote: "沈砚并不知道灯塔已被他父亲的谎言熄灭。", start: 16, end: 38 },
      ],
      suggestedDirection: "把「父亲的谎言」改成可被沈砚当场验证的细节。",
      status: "open",
      decision: null,
    },
  ],
  createdAt: "2026-08-10T10:00:00.000Z",
};

it("可以只审当前正式版本且不会触发正文改写", async () => {
  let reviewPayload: Record<string, unknown> | null = null;
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/projects/p-1/studio/documents") return json(DOC_LIST);
    if (url === "/api/projects/p-1/studio/documents/doc-ch-1")
      return json(DOC_DETAIL);
    if (url === "/api/projects/p-1/reviews")
      return json({ reports: [], proposals: [] });
    if (
      url === "/api/projects/p-1/documents/doc-ch-1/reviews" &&
      init?.method === "POST"
    ) {
      reviewPayload = JSON.parse(String(init.body)) as Record<string, unknown>;
      return json({ run: { id: "run-review-current" } }, 202);
    }
    throw new Error(`unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  renderStudio();

  fireEvent.click(
    await screen.findByRole("button", { name: "审稿当前版本" }),
  );
  expect(
    await screen.findByText("当前版本已送审，完成后报告会自动回到这里"),
  ).toBeInTheDocument();
  expect(reviewPayload).toMatchObject({
    documentVersionId: "ver-1",
    origin: { surface: "writing", documentId: "doc-ch-1" },
  });
  expect(reviewPayload?.requestId).toEqual(expect.any(String));
  expect(
    fetchMock.mock.calls.some(
      ([url, init]) =>
        String(url).includes("/versions") &&
        (init as RequestInit | undefined)?.method === "POST",
    ),
  ).toBe(false);
});

it("后台章节完成后刷新稿件与审稿，不再停留在连续创作前的缓存", async () => {
  let reviewRequests = 0;
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/projects/p-1/studio/documents") return json(DOC_LIST);
    if (url === "/api/projects/p-1/studio/documents/doc-ch-1")
      return json(DOC_DETAIL);
    if (url === "/api/projects/p-1/reviews") {
      reviewRequests += 1;
      return json({
        reports: reviewRequests === 1 ? [] : [REPORT],
        proposals: [],
      });
    }
    if (url === "/api/projects/p-1/canon-change-sets")
      return json({ changeSets: [] });
    throw new Error(`unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", EventSourceStub);
  renderStudio();

  await screen.findByText(/本稿尚无审稿报告/);
  expect(EventSourceStub.instances).toHaveLength(1);
  act(() => {
    EventSourceStub.instances[0]!.emit("run.status", {
      type: "run.status",
      runId: "run-chapter-2",
      status: "completed",
    });
  });

  expect(
    await screen.findByText("两处以主角视角写到了他尚不知道的真相；其余结构成立。"),
  ).toBeInTheDocument();
  expect(reviewRequests).toBe(2);
  expect(
    fetchMock.mock.calls.filter(
      ([url]) => String(url) === "/api/projects/p-1/studio/documents",
    ),
  ).toHaveLength(2);
});

const PROPOSAL = {
  id: "prop-1",
  runId: "run-1",
  stepId: "step-2",
  documentId: "doc-ch-1",
  baseDocumentVersionId: "ver-1",
  baseContent: "潮水在午夜越过旧钟楼。",
  revisedContent: "潮水在午夜越过旧钟楼。沈砚把信纸放进煤油灯下，名字显影。",
  diff: { hunks: 1 },
  addressedIssueIds: ["iss-1"],
  status: "proposed",
  createdAt: "2026-08-10T10:00:00.000Z",
  decidedAt: null,
};

const CHANGE_SET = {
  id: "ccs-1",
  projectId: "p-1",
  runId: "run-1",
  stepId: "step-3",
  changes: {
    factCandidates: [
      { subjectId: "entity-letter", predicate: "空信遇热显名", value: true },
    ],
  },
  status: "candidate",
  createdAt: "2026-08-10T10:00:00.000Z",
  decidedAt: null,
};

it("审稿内容完整展开：summary/scores/被审正文全文 + issue 裁定", async () => {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/projects/p-1/studio/documents") return json(DOC_LIST);
    if (url === "/api/projects/p-1/studio/documents/doc-ch-1")
      return json(DOC_DETAIL);
    if (url === "/api/projects/p-1/reviews")
      return json({ reports: [REPORT], proposals: [PROPOSAL] });
    if (url === "/api/projects/p-1/canon-change-sets")
      return json({ changeSets: [CHANGE_SET] });
    if (url.includes("/review-issues/iss-1/decisions")) {
      const body = JSON.parse(String(init?.body)) as { action: string };
      return json({
        id: "dec-1",
        issueId: "iss-1",
        action: body.action,
        note: null,
        priorStatus: "open",
        resultingStatus: "resolved",
        createdAt: "2026-08-11T00:00:00.000Z",
      });
    }
    throw new Error(`unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  renderStudio();

  // 审稿内容不得被截断：全文字符都在 DOM 里
  await screen.findByText("两处以主角视角写到了他尚不知道的真相；其余结构成立。");
  const deskBodies = document.querySelectorAll(".review__doc-body--desk");
  const joined = [...deskBodies].map((node) => node.textContent).join("\n");
  for (const fragment of [
    "潮水在午夜越过旧钟楼。",
    "沈砚并不知道灯塔已被他父亲的谎言熄灭。",
    "她把信纸放进煤油灯下，名字缓缓显影。",
  ]) {
    expect(joined).toContain(fragment);
  }
  // 证据提警元素存在
  expect(document.querySelector(".review__doc-body--desk mark")).not.toBeNull();
  // 评分细项
  expect(screen.getByText("视角 · 4")).toBeInTheDocument();
  // 裁定调用
  fireEvent.click(screen.getAllByRole("button", { name: "接受" })[0]!);
  await screen.findByText(/已接受/);
  const call = fetchMock.mock.calls.find(([u]) =>
    String(u).includes("/review-issues/iss-1/decisions"),
  );
  const body = JSON.parse(String(call?.[1]?.body));
  expect(body.action).toBe("accept");
  expect(body.requestId).toBe("iss-1:accept");
  expect(body).not.toHaveProperty("profileId");
});

it("修订提案完整 revised + apply/reject 决策端点", async () => {
  let propStatus: string = "proposed";
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/projects/p-1/studio/documents") return json(DOC_LIST);
    if (url === "/api/projects/p-1/studio/documents/doc-ch-1")
      return json(DOC_DETAIL);
    if (url === "/api/projects/p-1/reviews")
      return json({ reports: [REPORT], proposals: [{ ...PROPOSAL, status: propStatus, decidedAt: propStatus === "proposed" ? null : "2026-08-11T00:00:00.000Z" }] });
    if (url === "/api/projects/p-1/canon-change-sets")
      return json({ changeSets: [CHANGE_SET] });
    if (url.includes("/revision-proposals/prop-1/decisions")) {
      const body = JSON.parse(String(init?.body)) as { action: string };
      propStatus = body.action === "apply" ? "accepted" : "rejected";
      return json({
        proposal: {
          ...PROPOSAL,
          status: propStatus,
          decidedAt: "2026-08-11T00:00:00.000Z",
        },
      });
    }
    throw new Error(`unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  renderStudio();

  // 修改差异完整展开
  fireEvent.click(await screen.findByRole("tab", { name: "修订" }));
  await screen.findByLabelText(/修订后正文（完整）/);
  expect(
    screen.getByText(
      "潮水在午夜越过旧钟楼。沈砚把信纸放进煤油灯下，名字显影。",
    ),
  ).toBeInTheDocument();
  // 先走 reject（决策后按钮隐去），再重渲染走 apply。
  fireEvent.click(
    await screen.findByRole("button", { name: "拒绝" }),
  );
  await screen.findAllByText(/已拒绝/);
  expect(
    JSON.parse(
      String(
        fetchMock.mock.calls.find(([u]) =>
          String(u).includes("/revision-proposals/prop-1/decisions"),
        )?.[1]?.body,
      ),
    ),
  ).toMatchObject({ action: "reject", requestId: "prop-1:reject" });

  propStatus = "proposed";
  cleanup();
  renderStudio();
  fireEvent.click(await screen.findByRole("tab", { name: "修订" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "应用为新版本" }),
  );
  await screen.findAllByText(/已采纳/);
  const call = fetchMock.mock.calls
    .filter(([u]) => String(u).includes("/revision-proposals/prop-1/decisions"))
    .at(-1);
  expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({
    action: "apply",
    requestId: "prop-1:apply",
  });
});

it("故事变化裁定：apply/reject 带 expectedStatus 与 conflictPolicy", async () => {
  let setStatus: string = "candidate";
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/projects/p-1/studio/documents") return json(DOC_LIST);
    if (url === "/api/projects/p-1/studio/documents/doc-ch-1")
      return json(DOC_DETAIL);
    if (url === "/api/projects/p-1/reviews")
      return json({ reports: [], proposals: [] });
    if (url === "/api/projects/p-1/runs")
      return json([{ id: "run-1", targetOutlineNodeId: "node-ch-1" }]);
    if (url === "/api/projects/p-1/story-bible")
      return json({ entities: [] });
    if (url === "/api/projects/p-1/canon-change-sets")
      return json({ changeSets: [{ ...CHANGE_SET, status: setStatus, decidedAt: setStatus === "candidate" ? null : "2026-08-11T00:00:00.000Z" }] });
    if (url.includes("/canon-change-sets/ccs-1/decisions")) {
      const body = JSON.parse(String(init?.body)) as { action: string };
      setStatus = body.action === "apply" ? "applied" : "rejected";
      return json({
        changeSet: {
          ...CHANGE_SET,
          status: setStatus,
          decidedAt: "2026-08-11T00:00:00.000Z",
        },
      });
    }
    throw new Error(`unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  renderStudio();

  fireEvent.click(await screen.findByRole("tab", { name: "故事变化" }));
  await screen.findByText(/空信遇热显名/);
  expect(screen.getByText(/空信遇热显名/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "采纳这些变化" }));
  await waitFor(() => expect(screen.queryByText(/空信遇热显名/)).not.toBeInTheDocument());
  const call = fetchMock.mock.calls.find(([u]) =>
    String(u).includes("/canon-change-sets/ccs-1/decisions"),
  );
  const body = JSON.parse(String(call?.[1]?.body));
  expect(body).toEqual({
    action: "apply",
    requestId: "ccs-1:apply:reject",
    expectedStatus: "candidate",
    conflictPolicy: "reject",
  });
});

it("故事变化冲突只在服务端允许时提供强制采纳", async () => {
  let applied = false;
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/projects/p-1/studio/documents") return json(DOC_LIST);
    if (url === "/api/projects/p-1/studio/documents/doc-ch-1") return json(DOC_DETAIL);
    if (url === "/api/projects/p-1/reviews") return json({ reports: [], proposals: [] });
    if (url === "/api/projects/p-1/runs") return json([{ id: "run-1", targetOutlineNodeId: "node-ch-1" }]);
    if (url === "/api/projects/p-1/story-bible") return json({ entities: [] });
    if (url === "/api/projects/p-1/canon-change-sets") {
      return json({ changeSets: applied ? [] : [CHANGE_SET] });
    }
    if (url.includes("/canon-change-sets/ccs-1/decisions")) {
      const body = JSON.parse(String(init?.body)) as { conflictPolicy: string };
      if (body.conflictPolicy === "reject") {
        return json({
          error: {
            code: "settlement.conflict",
            message: "这些故事变化与当前正典存在冲突",
            details: {
              conflicts: [{ path: "factCandidates.0", existingIds: ["fact-locked"], reason: "target_locked" }],
              forceAllowed: true,
            },
          },
        }, 409);
      }
      applied = true;
      return json({ changeSet: { ...CHANGE_SET, status: "applied" } });
    }
    throw new Error(`unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  renderStudio();

  fireEvent.click(await screen.findByRole("tab", { name: "故事变化" }));
  fireEvent.click(await screen.findByRole("button", { name: "采纳这些变化" }));
  expect(await screen.findByText(/目标记录已锁定/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "强制采纳" }));
  fireEvent.click(screen.getByRole("button", { name: "确认强制采纳" }));
  await waitFor(() => expect(applied).toBe(true));
  const forceCall = fetchMock.mock.calls.find(([, init]) =>
    String(init?.body).includes('"conflictPolicy":"force"'),
  );
  expect(JSON.parse(String(forceCall?.[1]?.body))).toMatchObject({
    action: "apply",
    requestId: "ccs-1:apply:force",
    conflictPolicy: "force",
  });
});

it("交给 AI 发起单章 chapter run，并在失败重试时复用 requestId", async () => {
  const requestBodies: Array<Record<string, unknown>> = [];
  const detail = {
    ...DOC_DETAIL,
    document: { ...DOC_LIST[0]!, outlineNodeId: "n-ch-1" },
  };
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/projects/p-1/studio/documents") return json(DOC_LIST);
    if (url === "/api/projects/p-1/studio/documents/doc-ch-1")
      return json(detail);
    if (url === "/api/projects/p-1/reviews")
      return json({ reports: [], proposals: [] });
    if (url === "/api/projects/p-1/canon-change-sets")
      return json({ changeSets: [] });
    if (url === "/api/runs/run-ai-1?projectId=p-1") {
      return json({
        run: { id: "run-ai-1", projectId: "p-1", recipe: "chapter-production", status: "pending" },
        result: {
          planCandidate: null,
          manuscriptCandidate: null,
          reviewSummary: null,
          settlementCandidate: null,
          canonChangeSetId: null,
          foundationCandidateSetId: null,
          editProposalId: null,
          cocreateTurnId: null,
          cocreateSwipeId: null,
          sceneAdoptionId: null,
          documentId: null,
          documentVersionId: null,
          importBatchId: null,
          partialRecovery: null,
        },
        availableActions: ["pause", "cancel"],
      });
    }
    if (url === "/api/projects/p-1/runs/chapter" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      requestBodies.push(body);
      if (requestBodies.length === 1) {
        return Promise.reject(new Error("response lost"));
      }
      return json({
        run: {
          id: "run-ai-1",
          projectId: "p-1",
          recipe: "chapter-production",
          recipeVersion: 1,
          mode: "manual",
          status: "pending",
          targetOutlineNodeId: body.targetOutlineNodeId,
          policy: {},
          budgetLimit: {
            maxInputTokens: 1,
            maxOutputTokens: 1,
            maxCalls: 1,
            maxCostUsd: null,
            maxWallTimeMs: 1,
          },
          budgetUsage: {
            inputTokens: 0,
            outputTokens: 0,
            calls: 0,
            costUsd: 0,
            wallTimeMs: 0,
          },
          revisionCycle: 0,
          pauseRequested: false,
          cancelRequested: false,
          currentStepId: null,
          startedAt: null,
          finishedAt: null,
          createdAt: "2026-08-10T10:00:00.000Z",
          updatedAt: "2026-08-10T10:00:00.000Z",
          version: 0,
        },
        steps: [],
        events: [],
        latestCheckpoint: null,
        origin: body.origin,
        result: {
          planCandidate: null,
          manuscriptCandidate: null,
          reviewSummary: null,
          settlementCandidate: null,
          canonChangeSetId: null,
          foundationCandidateSetId: null,
          editProposalId: null,
          cocreateTurnId: null,
          cocreateSwipeId: null,
          sceneAdoptionId: null,
          documentId: null,
          documentVersionId: null,
          importBatchId: null,
          partialRecovery: null,
        },
        availableActions: ["pause", "cancel"],
        effectivePolicy: {},
        idempotentReplay: false,
      });
    }
    throw new Error(`unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  renderStudio();

  fireEvent.click(
    await screen.findByRole("button", { name: /交给 AI/ }),
  );
  await waitFor(() => expect(requestBodies).toHaveLength(1));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /交给 AI/ })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: /交给 AI/ }));
  await screen.findByRole("region", { name: "AI 写作任务" });
  expect(await screen.findByText("AI 正在完成本章")).toBeInTheDocument();
  const call = fetchMock.mock.calls.find(([u, init]) =>
    String(u) === "/api/projects/p-1/runs/chapter" && init?.method === "POST",
  );
  const body = JSON.parse(String(call?.[1]?.body));
  expect(body.targetOutlineNodeId).toBe("n-ch-1");
  expect(typeof body.requestId).toBe("string");
  expect(body.requestId.length).toBeGreaterThan(30);
  expect(requestBodies).toHaveLength(2);
  expect(requestBodies[1]?.requestId).toBe(requestBodies[0]?.requestId);
  expect(body.planningMode).toBe("auto");
  expect(body.origin).toEqual({ surface: "writing", documentId: "doc-ch-1" });
  expect(body).not.toHaveProperty("mode");
  // 台账已登记（离页恢复）
  const ledger = JSON.parse(
    window.localStorage.getItem("narralume:task-ledger") ?? "[]",
  ) as Array<{ taskId: string; kind: string }>;
  expect(
    ledger.some((entry) => entry.taskId === "run-ai-1" && entry.kind === "chapter"),
  ).toBe(true);
    // 普通用户留在写作台；任务详情仍可按需进入。
  expect(
    screen.getByRole("link", { name: /查看任务详情/ }),
  ).toHaveAttribute("href", "/projects/p-1/runs?run=run-ai-1");
});

it("从任务深链在写作台展示候选正文、轻量审稿并完成采纳", async () => {
  let accepted = false;
  const candidate = "潮水越过旧钟楼，沈砚在回声里拆开那封信。";
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/projects/p-1/studio/documents") return json(DOC_LIST);
    if (url === "/api/projects/p-1/studio/documents/doc-ch-1") return json(DOC_DETAIL);
    if (url === "/api/projects/p-1/reviews") return json({ reports: [], proposals: [] });
    if (url === "/api/projects/p-1/canon-change-sets") return json({ changeSets: [] });
    if (url === "/api/runs/run-candidate?projectId=p-1" && (!init?.method || init.method === "GET")) return json({
      run: { id: "run-candidate", projectId: "p-1", recipe: "chapter-production", status: accepted ? "completed" : "awaiting_user" },
      result: {
        planCandidate: { chapterGoal: "让沈砚收到第一封不会被遗忘的信" },
        manuscriptCandidate: { content: candidate },
        reviewSummary: { verdict: "revise", summary: "结构成立，但一处信息释放略早。", issues: [{ id: "issue-1", message: "父亲身份出现得太早", suggestedDirection: "把明确身份换成物件线索" }] },
        settlementCandidate: { facts: [] },
        canonChangeSetId: "canon-1",
        foundationCandidateSetId: null,
        editProposalId: null,
        cocreateTurnId: null,
        cocreateSwipeId: null,
        sceneAdoptionId: null,
        documentId: null,
        documentVersionId: null,
        importBatchId: null,
        partialRecovery: null,
      },
      availableActions: accepted ? [] : ["accept_manuscript", "request_revision", "discard_manuscript", "cancel"],
    });
    if (url === "/api/runs/run-candidate/actions" && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      if (body.action === "accept_manuscript") accepted = true;
      return json({ run: { id: "run-candidate", status: "completed" }, steps: [], events: [], latestCheckpoint: null });
    }
    throw new Error(`unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  renderStudio("/projects/p-1/studio?document=doc-ch-1&run=run-candidate");

  await screen.findByText(candidate);
  expect(screen.getByText("结构成立，但一处信息释放略早。")).toBeInTheDocument();
  expect(screen.getByText("父亲身份出现得太早")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "采纳为正文版本" }));
  await screen.findByText(/候选正文已采纳为正式版本/);
  await waitFor(() => expect(screen.queryByRole("region", { name: "AI 写作任务" })).not.toBeInTheDocument());
  expect(screen.queryByText(candidate)).not.toBeInTheDocument();
  const actionCall = fetchMock.mock.calls.find(([url, init]) => String(url) === "/api/runs/run-candidate/actions" && init?.method === "POST");
  expect(JSON.parse(String(actionCall?.[1]?.body))).toEqual({ action: "accept_manuscript", projectId: "p-1" });
});
