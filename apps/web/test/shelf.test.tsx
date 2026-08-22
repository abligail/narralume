// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "../src/i18n";
import { ShelfWorkspace } from "../src/workspaces/shelf";

/* fetch stub 纪律：vi.stubGlobal + URL 匹配，QueryClient 关 retry。 */

const PROJECTS = [
  {
    id: "p-1-tides",
    title: "潮汐灯塔",
    subtitle: null,
    premise: "港口每年都会遗忘一个人。",
    language: "zh-CN",
    phase: "writing",
    archivedAt: null,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-10T10:00:00.000Z",
    committedChapters: 12,
    totalChapters: 40,
    wordCount: 24860,
    cover: null,
  },
  {
    id: "p-2-mountain",
    title: "山中回信",
    subtitle: null,
    premise: null,
    language: "zh-CN",
    phase: "idea",
    archivedAt: null,
    createdAt: "2026-07-01T10:00:00.000Z",
    updatedAt: "2026-08-09T10:00:00.000Z",
    committedChapters: 0,
    totalChapters: 0,
    wordCount: 0,
    cover: {
      projectId: "p-2-mountain",
      mediaType: "image/webp",
      byteSize: 20344,
      width: 1200,
      height: 1800,
      crop: { x: 0.4, y: 0.55, zoom: 1.2 },
      updatedAt: "2026-08-09T11:00:00.000Z",
    },
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

function stubBaseFetch(createEcho?: (body: unknown) => unknown) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/projects" && init?.method === "POST") {
      return json(createEcho?.(JSON.parse(String(init.body))));
    }
    if (url === "/api/projects") return json(PROJECTS);
    if (url === "/api/projects?includeArchived=true") return json(PROJECTS);
    throw new Error(`unexpected request ${url}`);
  });
}

function renderShelf(entry = "/shelf") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/shelf" element={<ShelfWorkspace />} />
          <Route path="/projects/:projectId/overview" element={<p>已入馆：项目概览</p>} />
          <Route path="/projects/:projectId/autopilot" element={<p>已入馆：自动驾驶</p>} />
          <Route path="/projects/:projectId/studio" element={<p>已入馆：写作台</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  /* 字典 zh 保留原文，测试固定中文环境（jsdom 默认 navigator.language 为 en-US）。 */
  setLocale("zh-CN");
  /* motion 的 useReducedMotion 依赖 matchMedia，jsdom 没有，统一桩掉。
     matches 置 true：reduced-motion 下 Lenis 不启、动效静态，最稳。 */
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

describe("藏书室", () => {
  it("打开作品后进入项目概览", async () => {
    vi.stubGlobal("fetch", stubBaseFetch());
    renderShelf();

    const openProject = await screen.findByRole(
      "button",
      { name: "打开《潮汐灯塔》" },
      { timeout: 5_000 },
    );
    fireEvent.click(openProject);
    expect(
      await screen.findByText("已入馆：项目概览", undefined, { timeout: 5_000 }),
    ).toBeInTheDocument();
  });

  it("更多操作菜单支持方向键、Esc 和焦点恢复（CR-107）", async () => {
    vi.stubGlobal("fetch", stubBaseFetch());
    renderShelf();

    const trigger = await screen.findByRole("button", { name: "《潮汐灯塔》的更多操作" });
    fireEvent.click(trigger);
    const first = screen.getByRole("menuitem", { name: "AI 快速创作" });
    await waitFor(() => expect(first).toHaveFocus());
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "编辑书籍与封面" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "End" });
    expect(screen.getByRole("menuitem", { name: "移入回收站" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("自动加载 100 本之后的项目页", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      ...PROJECTS[0],
      id: `project-${index}`,
      title: `分页作品 ${index}`,
      updatedAt: new Date(Date.UTC(2026, 7, 14, 0, index)).toISOString(),
    }));
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects") return json(firstPage);
      if (url === "/api/projects?offset=100")
        return json([{ ...PROJECTS[0], id: "project-100", title: "第 101 本作品" }]);
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderShelf();

    expect(
      await screen.findByRole(
        "button",
        { name: "打开《第 101 本作品》" },
        { timeout: 5_000 },
      ),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/projects?offset=100", expect.any(Object));
  });

  it("渲染默认与自定义封面书架，点击封面进入项目概览", async () => {
    vi.stubGlobal("fetch", stubBaseFetch());
    renderShelf();

    await screen.findAllByText("潮汐灯塔");
    expect(screen.getAllByText("山中回信").length).toBeGreaterThan(0);
    expect(screen.getByRole("img", { name: "《潮汐灯塔》默认封面" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "《山中回信》自定义封面" })).toHaveAttribute(
      "src",
      "/api/projects/p-2-mountain/cover?v=2026-08-09T11%3A00%3A00.000Z",
    );
    expect(screen.getByText("12 章")).toBeInTheDocument();
    expect(screen.getByText("24860 字")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "打开《潮汐灯塔》" }));

    await screen.findByText("已入馆：项目概览");
  });

  it("在同一对话框编辑书籍资料并保存（不动封面）", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/projects") return json(PROJECTS);
      if (url === "/api/projects/p-2-mountain" && init?.method === "PUT")
        return json({ ...PROJECTS[1], subtitle: "雾岭来信" });
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderShelf();

    await screen.findAllByText("山中回信");
    fireEvent.click(
      screen.getByRole("button", { name: "《山中回信》的更多操作" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "编辑书籍与封面" }));
    expect(
      await screen.findByRole("dialog", { name: "编辑书籍与封面" }),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("副题"), {
      target: { value: "雾岭来信" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存书籍" }));

    // 仅改资料时不上传封面：PUT 不携带 cover 字段（CR-83 的原子提交仍成立）。
    await waitFor(() => {
      const projectCall = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url) === "/api/projects/p-2-mountain" && init?.method === "PUT",
      );
      expect(projectCall).toBeDefined();
      expect(JSON.parse(String(projectCall?.[1]?.body))).toMatchObject({
        title: "山中回信",
        subtitle: "雾岭来信",
        premise: null,
      });
      expect(JSON.parse(String(projectCall?.[1]?.body)).cover).toBeUndefined();
    });
  });

  it("检索过滤编目行", async () => {
    vi.stubGlobal("fetch", stubBaseFetch());
    renderShelf();

    await screen.findAllByText("潮汐灯塔");
    fireEvent.change(screen.getByLabelText("检索书目"), {
      target: { value: "山中" },
    });

    expect(screen.queryAllByText("潮汐灯塔").length).toBe(0);
    expect(screen.getAllByText("山中回信").length).toBeGreaterThan(0);

    fireEvent.change(screen.getByLabelText("检索书目"), {
      target: { value: "不存在的书" },
    });
    expect(screen.getByText("没有相符的书目")).toBeInTheDocument();
  });

  it("可切换到列表与书脊视图，并记住用户选择", async () => {
    vi.stubGlobal("fetch", stubBaseFetch());
    renderShelf();

    await screen.findAllByText("潮汐灯塔");
    fireEvent.click(screen.getByRole("button", { name: "列表" }));

    expect(screen.getByText("NO.01")).toBeInTheDocument();
    expect(screen.getByText("写作")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "列表" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(window.localStorage.getItem("shelf:view")).toBe("list");

    fireEvent.click(screen.getByRole("button", { name: "封面" }));
    expect(screen.queryByText("NO.01")).not.toBeInTheDocument();
    expect(window.localStorage.getItem("shelf:view")).toBe("covers");
  });

  it("将归档作品移入回收站，并可恢复或永久删除", async () => {
    const archivedProject = {
      ...PROJECTS[0],
      archivedAt: "2026-08-14T10:00:00.000Z",
    };
    const recycledProject = {
      ...archivedProject,
      deletedAt: "2026-08-15T10:00:00.000Z",
      deletionToken: "delete-token-1",
      deleteAfter: "2026-09-14T10:00:00.000Z",
    };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/projects") return json([archivedProject]);
      if (url === "/api/projects?includeArchived=true") return json([archivedProject]);
      if (url === "/api/projects/recycle-bin") return json([recycledProject]);
      if (url === `/api/projects/${archivedProject.id}` && init?.method === "DELETE")
        return json(recycledProject, 202);
      if (url === `/api/projects/${archivedProject.id}/restore` && init?.method === "POST")
        return json(archivedProject);
      if (url === `/api/projects/${archivedProject.id}/purge` && init?.method === "DELETE")
        return Promise.resolve(new Response(null, { status: 204 }));
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderShelf();

    await screen.findAllByText("潮汐灯塔");
    fireEvent.click(screen.getByRole("button", { name: "《潮汐灯塔》的更多操作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "移入回收站" }));

    expect(await screen.findByRole("dialog", { name: "移入回收站" })).toHaveTextContent(
      "保留 30 天",
    );
    fireEvent.change(screen.getByLabelText("书名确认"), {
      target: { value: archivedProject.title },
    });
    fireEvent.click(screen.getByRole("button", { name: "移入回收站" }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url) === `/api/projects/${archivedProject.id}` && init?.method === "DELETE",
      );
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({
        confirmationTitle: archivedProject.title,
        expectedUpdatedAt: archivedProject.updatedAt,
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "回收站" }));
    expect(await screen.findByRole("dialog", { name: "回收站" })).toHaveTextContent(
      "恢复后仍保持归档状态",
    );
    fireEvent.click(await screen.findByRole("button", { name: "恢复" }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url) === `/api/projects/${archivedProject.id}/restore` &&
          init?.method === "POST",
      );
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({
        deletionToken: recycledProject.deletionToken,
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));
    const purgeButton = screen.getAllByRole("button", { name: "永久删除" }).at(-1);
    expect(purgeButton).toBeDisabled();
    fireEvent.change(screen.getByLabelText("永久删除书名确认"), {
      target: { value: archivedProject.title },
    });
    fireEvent.click(purgeButton!);
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url) === `/api/projects/${archivedProject.id}/purge` &&
          init?.method === "DELETE",
      );
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({
        deletionToken: recycledProject.deletionToken,
        confirmationTitle: archivedProject.title,
      });
    });
  });

  it("空白建书发起 POST，入藏后写 store 并进入项目概览", async () => {
    const createBodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/projects" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        createBodies.push(body);
        if (createBodies.length === 1) {
          return Promise.reject(new Error("response lost"));
        }
        return json({
          id: "p-3-fog",
          title: body.title,
          subtitle: null,
          premise: body.premise,
          language: "zh-CN",
          phase: "idea",
          archivedAt: null,
          createdAt: "2026-08-12T10:00:00.000Z",
          updatedAt: "2026-08-12T10:00:00.000Z",
        });
      }
      if (url === "/api/projects") return json(PROJECTS);
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderShelf();

    await screen.findAllByText("潮汐灯塔");
    fireEvent.click(screen.getByRole("button", { name: /空白建书/ }));
    const dialog = await screen.findByRole("dialog", { name: "空白建书" });
    expect(dialog).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("书名"), {
      target: { value: "雾中青山" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建并入藏" }));

    await waitFor(() => expect(createBodies).toHaveLength(1));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "创建并入藏" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "创建并入藏" }));

    await screen.findByText("已入馆：项目概览");
    const createCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url) === "/api/projects" && init?.method === "POST",
    );
    expect(createCall).toBeDefined();
    expect(createBodies).toHaveLength(2);
    expect(createBodies[0]).toEqual({
      title: "雾中青山",
      premise: null,
      language: "zh-CN",
      requestId: expect.any(String),
    });
    expect(createBodies[1]?.requestId).toBe(createBodies[0]?.requestId);
  });

  it("AI 建书内容变化后使用新的 requestId", async () => {
    const createBodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/projects/with-foundation" && init?.method === "POST") {
        createBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return Promise.reject(new Error("response lost"));
      }
      if (url === "/api/projects") return json(PROJECTS);
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderShelf();

    await screen.findAllByText("潮汐灯塔");
    fireEvent.click(screen.getByRole("button", { name: /AI 引导建书/ }));
    fireEvent.change(screen.getByLabelText("书名"), {
      target: { value: "雾中青山" },
    });
    fireEvent.change(screen.getByLabelText("命题与脑暴"), {
      target: { value: "山城每晚会遗忘一个名字。" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建并生成候选" }));

    await waitFor(() => expect(createBodies).toHaveLength(1));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "创建并生成候选" }),
      ).toBeEnabled(),
    );
    fireEvent.change(screen.getByLabelText("命题与脑暴"), {
      target: { value: "山城每晚会遗忘一条街。" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建并生成候选" }));

    await waitFor(() => expect(createBodies).toHaveLength(2));
    expect(createBodies[1]?.requestId).not.toBe(createBodies[0]?.requestId);
  });
});
