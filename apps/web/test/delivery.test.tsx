// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "../src/i18n";
import { DeliveryWorkspace } from "../src/workspaces/delivery";

const PROJECT_BACKUPS = [
  {
    id: "pb-1",
    projectId: "p-1",
    label: "上卷交付留底",
    bundleHash: "abc123def456abc123def456abc123def456abc",
    sizeBytes: 184 * 1024,
    createdAt: "2026-08-10T10:00:00.000Z",
    restoredProjectId: null,
  },
];

const QUALITY = {
  projectId: "p-1",
  score: 0.86,
  readiness: "needs_attention" as const,
  gates: [
    {
      id: "g-has-outline",
      label: "有大纲",
      passed: true,
      message: "骨架在",
      targetType: null,
      targetId: null,
    },
    {
      id: "g-chapter-count",
      label: "章数过底",
      passed: true,
      message: "已有 12 章",
      targetType: null,
      targetId: null,
    },
    {
      id: "g-foreshadow-resolved",
      label: "伏笔已收",
      passed: false,
      message: "仍有 2 处未收",
      targetType: "foreshadow",
      targetId: "fs-2",
    },
  ],
  metrics: {
    chaptersComplete: 12,
    chaptersPlanned: 20,
    openForeshadows: 2,
    openComments: 3,
  },
  issues: [
    {
      id: "i-1",
      category: "continuity" as const,
      severity: "warning" as const,
      message: "第五章与第十章在时间线间隙上失咬",
      targetType: "chapter",
      targetId: "ch-5",
      suggestion: "在长篇推演里做一次 dry-run",
    },
    {
      id: "i-2",
      category: "manuscript" as const,
      severity: "info" as const,
      message: "第三章还有 3 条批注未档",
      targetType: "document",
      targetId: "d-3",
      suggestion: "在审稿室逐条裁定",
    },
  ],
  generatedAt: "2026-08-11T07:30:00.000Z",
};

const BACKUPS = [
  {
    id: "bk-1",
    label: "交付前整备 2026-08-11",
    databaseFile: "narralume.sqlite",
    createdAt: "2026-08-11T06:00:00.000Z",
    sizeBytes: 184 * 1024 * 1024,
    sha256:
      "abc123def456abc123def456abc123def456abc123def456abc123def456abc1",
    migration: 7,
    pageCount: 812,
    projectCount: 3,
  },
  {
    id: "bk-2",
    label: "上卷交付留底",
    databaseFile: "narralume.sqlite",
    createdAt: "2026-08-01T00:00:00.000Z",
    sizeBytes: 92 * 1024 * 1024,
    sha256:
      "fff000eee111fff000eee111fff000eee111fff000eee111fff000eee111fff0",
    migration: 7,
    pageCount: 420,
    projectCount: 2,
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

function renderDelivery(entry = "/projects/p-1/delivery") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/delivery" element={<DeliveryWorkspace />} />
          <Route path="/projects/:projectId/delivery" element={<DeliveryWorkspace />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
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
  // jsdom 不实现 createObjectURL；断言只需拦截
  if (!URL.createObjectURL) {
    // @ts-expect-error 测试替身
    URL.createObjectURL = vi.fn(() => "blob:mock");
  }
  if (!URL.revokeObjectURL) {
    // @ts-expect-error 测试替身
    URL.revokeObjectURL = vi.fn();
  }
  window.localStorage.clear();setLocale("zh-CN");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("交付", () => {
  it("未选择作品时显示交付页自己的朱印空状态", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderDelivery("/delivery");

    expect(screen.getByRole("heading", { name: "交付" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回藏书室" })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("质量门 / 校样注 / 五格出厂 / 备份档 同步出现", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects/p-1/quality") return json(QUALITY);
      if (url === "/api/projects/p-1/backups") return json(PROJECT_BACKUPS);
      if (url === "/api/system/backups") return json(BACKUPS);
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderDelivery();

    await screen.findByText("有大纲");
    // readiness 印 + 通过率
    const readiness = document.querySelector(".delivery__readiness");
    expect(readiness?.textContent).toMatch(/建议检查/);
    expect(readiness?.textContent).toMatch(/2\/3/);
    expect(screen.getByText("伏笔已收")).toBeInTheDocument();
    expect(screen.getByText(/仍有 2 处未收/)).toBeInTheDocument();

    // issues 校样注出现
    expect(screen.getByText(/第五章与第十章/)).toBeInTheDocument();
    expect(screen.getByText(/第三章还有 3 条批注未档/)).toBeInTheDocument();

    // 五格式
    expect(await screen.findByText("导出格式")).toBeInTheDocument();
    expect(screen.getByText("Markdown")).toBeInTheDocument();
    expect(screen.getByText("DOCX")).toBeInTheDocument();
    expect(screen.getByText("EPUB")).toBeInTheDocument();
    expect(screen.getByText("作品包")).toBeInTheDocument();

    // 创作内容快照区（完整系统备份档已迁设置，不在本页）
    expect(screen.getByText("创作内容快照")).toBeInTheDocument();
    expect(screen.getByText(/完整包含故事设定、正文与草稿、批注、封面、审稿记录、共创会话和助手协作历史/)).toBeInTheDocument();
    expect(screen.getByText(/上卷交付留底/)).toBeInTheDocument();
    expect(screen.queryByText("备份档")).not.toBeInTheDocument();
    // 至少见到一份备份的哈希（正断言）
    const hashSpans = document.querySelectorAll(".delivery__backup-hash");
    expect(hashSpans.length).toBeGreaterThan(0);
    expect(hashSpans[0]?.textContent).toMatch(/abc123de/);

    // 反断言：全列表请求都不携带禁字段
    for (const call of fetchMock.mock.calls) {
      const bodyAsString = String(call[1]?.body ?? "");
      expect(bodyAsString).not.toContain("profileId");
    }
  });

  it("出厂五格点任一格都走 /projects/:id/exports/:format，不携带 profileId", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects/p-1/quality") return json(QUALITY);
      if (url === "/api/projects/p-1/backups") return json(PROJECT_BACKUPS);
      if (url === "/api/system/backups") return json(BACKUPS);
      if (url.startsWith("/api/projects/p-1/exports/epub")) {
        return Promise.resolve(
          new Response(new Blob(["fake-epub"]), {
            status: 200,
            headers: {
              "content-disposition": `attachment; filename*=UTF-8''tide.epub`,
            },
          }),
        );
      }
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderDelivery();

    // 等质量门落地后再按
    await screen.findByText(/建议检查 · 2\/3/);
    const epubBtn = await screen.findByRole("button", {
      name: /以 EPUB 导出当前作品/,
    });
    fireEvent.click(epubBtn);

    const call = await vi.waitFor(() => {
      const found = fetchMock.mock.calls.find(([u]) =>
        String(u).startsWith("/api/projects/p-1/exports/epub"),
      );
      if (!found) throw new Error("export call not yet made");
      return found;
    });
    expect(call).toBeDefined();
    // GET 请求，body 为空，自然不含 profileId
    const init = call[1];
    expect(String(init?.method ?? "GET")).toBe("GET");
    const bodyAsString = String(init?.body ?? "");
    expect(bodyAsString).not.toContain("profileId");
    expect(bodyAsString).not.toContain("policy");
  });

  it("创建内容快照 POST /api/projects/:id/backups，body 仅 { label }", async () => {
    let created = false;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/projects/p-1/quality") return json(QUALITY);
      if (url === "/api/projects/p-1/backups") {
        if (init?.method === "POST") {
          created = true;
          return json({
            id: "pb-3",
            projectId: "p-1",
            label: "临时备份",
            bundleHash: "rep".repeat(22),
            sizeBytes: 1024,
            createdAt: "2026-08-11T08:00:00.000Z",
            restoredProjectId: null,
          });
        }
        return json(
          created
            ? [...PROJECT_BACKUPS, { ...PROJECT_BACKUPS[0], id: "pb-3", label: "临时备份" }]
            : PROJECT_BACKUPS,
        );
      }
      throw new Error(`unexpected request ${url} ${init?.method ?? "GET"}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderDelivery();

    await screen.findByText(/建议检查 · 2\/3/);
    const input = await screen.findByPlaceholderText("交付前版本");
    fireEvent.change(input, { target: { value: "临时备份" } });
    fireEvent.click(screen.getByRole("button", { name: /创建内容快照/ }));

    const call = await vi.waitFor(() => {
      const found = fetchMock.mock.calls.find(
        ([u, i]) =>
          String(u) === "/api/projects/p-1/backups" && i?.method === "POST",
      );
      if (!found) throw new Error("create call not yet made");
      return found;
    });
    const init = call[1];
    const body = JSON.parse(String(init?.body));
    expect(Object.keys(body)).toEqual(["label"]);
    expect(body.label).toBe("临时备份");
  });
});
