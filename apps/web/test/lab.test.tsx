// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "../src/i18n";
import { LabWorkspace } from "../src/workspaces/lab";

/* 长篇推演：语义检索、剧情预测、故事记忆与影响预演。 */

const PREDICTIONS = [
  {
    id: "pp-1",
    projectId: "p-1",
    title: "姐姐的失踪与旧邮局刚开张时被拆掉的人为道迹也许有互证关系。",
    horizon: 3,
    summary: "基于第三章灯下潮痕的缝隙，姐姐消失前至少两次回邮局。",
    impact: ["第一章 灯下潮痕"],
    risks: ["与第 1 章 timeline 相逢不足"],
    uncertainty: 0.42,
    contextFingerprint: "fp-1",
    status: "candidate",
    stale: false,
    sourceIds: [],
    createdAt: "2026-08-10T10:00:00.000Z",
    updatedAt: "2026-08-10T10:00:00.000Z",
  },
];

const MEMORIES = [
  {
    id: "m-1",
    projectId: "p-1",
    layer: "episodic",
    scopeType: "project",
    scopeId: "p-1",
    title: "姐姐回邮局的两次证据",
    content: "第三章stamp、preface的按需印。",
    stateDelta: {},
    sourceHash: "sha-1",
    status: "active",
    refreshedAt: "2026-08-10T10:00:00.000Z",
    createdAt: "2026-08-10T10:00:00.000Z",
    updatedAt: "2026-08-10T10:00:00.000Z",
  },
];

const HITS = [
  {
    id: "h-1",
    projectId: "p-1",
    sourceType: "document",
    sourceId: "doc-1",
    title: "第一章 灯下潮痕",
    content: "第3章起邮局名字以风铃物证验证 姐姐消失前",
    authority: "confirmed",
    metadata: {},
    entityIds: [],
    createdAt: "2026-08-10T10:00:00.000Z",
    updatedAt: "2026-08-10T10:00:00.000Z",
    lexicalRank: 1,
    vectorRank: 0.8,
    entityScore: 0.6,
    vectorScore: 0.8,
    rerankScore: null,
    score: 0.82,
    reasons: ["fts", "vector"],
  },
];

function json(value: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

function renderLab(entry = "/projects/p-1/lab") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/projects/:projectId/lab" element={<LabWorkspace />} />
          <Route path="/missing" element={<LabWorkspace />} />
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

describe("长篇推演", () => {
  it("语义检索可提交问题并展示原文；剧情预测和故事记忆有卡", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects/p-1/predictions") return json(PREDICTIONS);
      if (url.startsWith("/api/projects/p-1/memories")) return json(MEMORIES);
      if (url === "/api/projects/p-1/retrieval/search")
        return json(HITS);
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderLab();

    // 检索投
    fireEvent.change(screen.getByLabelText("检索问题"), {
      target: { value: "姐姐什么时候消失" },
    });
    fireEvent.click(screen.getByRole("button", { name: "检索" }));
    await screen.findByText(/第一章 灯下潮痕/);
    expect(screen.getByText(/score 82%/)).toBeInTheDocument();

    // 预测单
    await screen.findByText(/姐姐的失踪与旧邮局/);
    expect(screen.getByText("剧情预测")).toBeInTheDocument();
    expect(screen.getByText("+3 章后")).toBeInTheDocument();
    expect(screen.getByText(/基于第三章灯下潮痕的缝隙/)).toBeInTheDocument();

    // 故事记忆
    await screen.findByText("EPISODIC");
    expect(screen.getByText(/第三章stamp、preface的按需印/)).toBeInTheDocument();
    expect(screen.getByLabelText("视野章数")).toHaveAttribute("max", "20");
    expect(screen.getByLabelText("候选数量")).toHaveAttribute("max", "5");
  });

  it("记忆查询失败时显示故障，不伪装成空仓", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects/p-1/predictions") return json([]);
      if (url.startsWith("/api/projects/p-1/memories")) {
        return json(
          { error: { code: "storage.unavailable", message: "memory unavailable" } },
          500,
        );
      }
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderLab();

    expect(await screen.findByText("记忆内容暂时无法加载")).toBeInTheDocument();
    expect(screen.queryByText("还没有记忆进仓")).not.toBeInTheDocument();
  });

  it("采纳预测调 PUT /predictions/:id；body 与决策一致，不含 profileId", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects/p-1/predictions") return json(PREDICTIONS);
      if (url.startsWith("/api/projects/p-1/memories")) return json(MEMORIES);
      if (url === "/api/projects/p-1/retrieval/search") return json(HITS);
      if (url.startsWith("/api/projects/p-1/predictions/pp-1"))
        return json({
          ...PREDICTIONS[0],
          status: "adopted",
          updatedAt: "2026-08-11T10:00:00.000Z",
        });
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderLab();

    await screen.findByText(/姐姐的失踪与旧邮局/);
    const adoptButtons = await screen.findAllByRole("button", { name: "采纳" });
    fireEvent.click(adoptButtons[0]!);

    await screen.findByText(/已采纳 ·/);
    const call = fetchMock.mock.calls.find(
      ([u, init]) =>
        String(u).includes("/api/projects/p-1/predictions/pp-1") &&
        init?.method === "PUT",
    );
    expect(call).toBeDefined();
    const body = JSON.parse(String(call?.[1]?.body));
    expect(body.status).toBe("adopted");
    expect(body).not.toHaveProperty("profileId");
    expect(body).not.toHaveProperty("outputReserve");
  });

  it("故事状态变化后的预测显示失效且不能采纳", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects/p-1/predictions")
        return json([{ ...PREDICTIONS[0], stale: true }]);
      if (url.startsWith("/api/projects/p-1/memories")) return json(MEMORIES);
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderLab();

    await screen.findByText(/姐姐的失踪与旧邮局/);
    expect(screen.getByText("已失效")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "采纳" }),
    ).not.toBeInTheDocument();
  });

  it("无项目时不发请求，藏书室回回链接在", () => {
    const fetchMock = vi.fn(() => {
      throw new Error("should not fetch");
    });
    vi.stubGlobal("fetch", fetchMock);
    renderLab("/missing");

    expect(screen.getByRole("heading", { name: "长篇推演" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回藏书室" })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
