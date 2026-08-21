// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { setLocale } from "../src/i18n";
import { BibleWorkspace } from "../src/workspaces/bible";

/* CR-65：故事圣经表单在资源刷新后必须重置本地字段，不能用新令牌提交旧内容。 */

const BASE_ENTITY = {
  id: "e-shenyan",
  projectId: "p-1",
  type: "character",
  name: "沈砚",
  aliases: [],
  description: "二十七岁的纸张修复师。",
  attributes: {},
  status: "active",
  createdAt: "2026-08-01T10:00:00.000Z",
  updatedAt: "2026-08-01T10:00:00.000Z",
};

function buildBible(entity: typeof BASE_ENTITY) {
  return {
    project: {
      id: "p-1",
      title: "潮汐灯塔",
      subtitle: null,
      premise: "港口每年都会遗忘一个人。",
      language: "zh-CN",
      phase: "writing",
      archivedAt: null,
      createdAt: "2026-08-01T10:00:00.000Z",
      updatedAt: "2026-08-10T10:00:00.000Z",
    },
    intent: null,
    outline: [],
    entities: [entity],
    facts: [],
    relationships: [],
    timeline: [],
    foreshadows: [],
    documents: [],
  };
}

function json(value: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    }),
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

it("实体在别处更新后，已打开的编辑表单重置为最新内容（CR-65）", async () => {
  let bible = buildBible(BASE_ENTITY);
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/projects/p-1/story-bible") return json(bible);
    if (url === "/api/projects/p-1/runs") return json([]);
    if (url.startsWith("/api/projects/p-1/canon-spreads/")) return json([]);
    throw new Error(`unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/projects/p-1/bible?spread=entities"]}>
        <Routes>
          <Route path="/projects/:projectId/bible" element={<BibleWorkspace />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

  fireEvent.change(await screen.findByRole("combobox", { name: "编辑对象" }), {
    target: { value: "e-shenyan" },
  });
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "名称" })).toHaveValue("沈砚"),
  );
  // 用户开始编辑但尚未保存。
  fireEvent.change(screen.getByRole("textbox", { name: "名称" }), {
    target: { value: "沈砚（未保存草稿）" },
  });
  expect(screen.getByRole("textbox", { name: "名称" })).toHaveValue(
    "沈砚（未保存草稿）",
  );

  // 同页 AI 候选采纳或另一标签页改了这个实体；查询刷新后表单必须重置，
  // 而不是把“新 updatedAt + 旧表单内容”提交成静默覆盖。
  bible = buildBible({
    ...BASE_ENTITY,
    description: "AI 候选刚采纳的描述。",
    updatedAt: "2026-08-10T10:00:00.000Z",
  });
  await client.invalidateQueries({ queryKey: ["project", "p-1", "bible"] });

  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "名称" })).toHaveValue("沈砚"),
  );
  await waitFor(() =>
    expect(screen.getByRole("textbox", { name: "描述" })).toHaveValue(
      "AI 候选刚采纳的描述。",
    ),
  );
});
