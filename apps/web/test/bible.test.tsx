// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "../src/i18n";
import { BibleWorkspace } from "../src/workspaces/bible";

/* 故事圣经摊开的整本 spread：intent 首语、大纲、实体、事实、关系、时间线、伏笔七大板块。 */

const BIBLE = {
  project: {
    id: "p-1-tides",
    title: "潮汐灯塔",
    subtitle: null,
    premise: "港口每年都会遗忘一个人。",
    language: "zh-CN",
    phase: "writing",
    archivedAt: null,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-10T10:00:00.000Z",
  },
  intent: {
    projectId: "p-1-tides",
    promise: "每一次取回记忆，都要付出可见且不可逆的代价。",
    themes: ["记忆与责任", "失去与见证"],
    audience: "偏好人物驱动悬疑奇幻的成年读者",
    tone: "克制、潮湿、带有物证感",
    boundaries: ["不使用无代价复活"],
    endingDirection: "沈砚选择保留他人的记忆，接受自己被遗忘。",
    currentFocus: "验证空白信受热显名的规则",
    lockedFields: ["promise"],
    updatedAt: "2026-08-10T10:00:00.000Z",
  },
  outline: [
    {
      id: "n-book",
      projectId: "p-1-tides",
      parentId: null,
      kind: "book",
      path: "/n-book",
      depth: 0,
      ordinal: 0,
      title: "潮汐灯塔",
      summary: null,
      goal: null,
      conflict: null,
      outcome: null,
      povEntityId: null,
      storyTime: null,
      status: "planned",
      metadata: {},
      createdAt: "2026-08-01T10:00:00.000Z",
      updatedAt: "2026-08-01T10:00:00.000Z",
    },
    {
      id: "n-ch-1",
      projectId: "p-1-tides",
      parentId: "n-book",
      kind: "chapter",
      path: "/n-book/n-ch-1",
      depth: 1,
      ordinal: 0,
      title: "第一章 灯下潮痕",
      summary: "沈砚用煤油灯验证姐姐留下的空白信。",
      goal: "建立信纸受热显名的可复验规则",
      conflict: "父亲否认失踪者存在",
      outcome: null,
      povEntityId: null,
      storyTime: "第 1 日 23:17",
      status: "committed",
      metadata: {},
      createdAt: "2026-08-01T10:00:00.000Z",
      updatedAt: "2026-08-01T10:00:00.000Z",
    },
  ],
  entities: [
    {
      id: "e-shenyan",
      projectId: "p-1-tides",
      type: "character",
      name: "沈砚",
      aliases: [],
      description: "二十七岁的纸张修复师。",
      attributes: {},
      status: "active",
      createdAt: "2026-08-01T10:00:00.000Z",
      updatedAt: "2026-08-01T10:00:00.000Z",
    },
    {
      id: "e-post-office",
      projectId: "p-1-tides",
      type: "location",
      name: "回声邮局",
      aliases: ["退潮邮局"],
      description: null,
      attributes: {},
      status: "active",
      createdAt: "2026-08-01T10:00:00.000Z",
      updatedAt: "2026-08-01T10:00:00.000Z",
    },
  ],
  facts: [
    {
      id: "f-1",
      projectId: "p-1-tides",
      subjectId: "e-shenyan",
      predicate: "职业",
      objectEntityId: null,
      value: "纸张修复师",
      validFromNodeId: null,
      validToNodeId: null,
      knowledgeScope: "omniscient",
      knowledgeSubjectId: null,
      authority: "locked",
      confidence: 1,
      sourceType: "manual",
      sourceId: null,
      supersedesFactId: null,
      createdAt: "2026-08-01T10:00:00.000Z",
    },
  ],
  relationships: [
    {
      id: "r-1",
      projectId: "p-1-tides",
      fromEntityId: "e-shenyan",
      toEntityId: "e-post-office",
      relation: "常客",
      intensity: null,
      state: {},
      outlineNodeId: null,
      storyTime: "第 1 日",
      sourceId: null,
      createdAt: "2026-08-01T10:00:00.000Z",
    },
  ],
  timeline: [
    {
      id: "t-1",
      projectId: "p-1-tides",
      title: "空白信首次显名",
      description: "煤油灯下浮现寄信人姓名。",
      outlineNodeId: null,
      storyTimeStart: "第 1 日 23:41",
      storyTimeEnd: null,
      sequence: 1,
      participants: [],
      causes: [],
      visibility: "omniscient",
      sourceId: null,
      createdAt: "2026-08-01T10:00:00.000Z",
    },
  ],
  foreshadows: [
    {
      id: "fs-1",
      projectId: "p-1-tides",
      title: "空白信与消失的记忆",
      description: "每封取回的信都会抹去一段寄信人的相关记忆。",
      status: "planted",
      importance: 4,
      dependencies: [],
      evidenceNodeIds: [],
      targetFromNodeId: null,
      targetToNodeId: null,
      resolutionNodeId: null,
      createdAt: "2026-08-01T10:00:00.000Z",
      updatedAt: "2026-08-01T10:00:00.000Z",
    },
  ],
  documents: [],
};

function json(value: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

function renderBible(entry = "/projects/p-1-tides/bible") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/projects/:projectId/bible" element={<BibleWorkspace />} />
          <Route path="/missing" element={<BibleWorkspace />} />
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

describe("故事圣经", () => {
  it("每次只摊开一个 Canon Spread，并在同一纸幅编辑", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects/p-1-tides/story-bible") return json(BIBLE);
      if (url === "/api/projects/p-1-tides/runs") return json([]);
      if (
        url.startsWith(
          "/api/projects/p-1-tides/canon-spreads/",
        ) && url.endsWith("/candidates")
      )
        return json([]);
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderBible();

    await screen.findAllByText("每一次取回记忆，都要付出可见且不可逆的代价。");
    expect(screen.getAllByText("潮汐灯塔").length).toBeGreaterThan(0);
    const intentSpread = screen.getByRole("article", {
      name: "意图阅读与编辑",
    });
    expect(within(intentSpread).getByRole("heading", { name: "作者意图" })).toBeInTheDocument();
    expect(within(intentSpread).getByRole("heading", { name: "编辑此页" })).toBeInTheDocument();
    expect(screen.queryByText("大纲纲目")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "查看意图" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "查看大纲" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    fireEvent.click(screen.getByRole("button", { name: "查看大纲" }));
    expect(screen.getByRole("article", { name: "大纲阅读与编辑" })).toBeInTheDocument();
    expect(screen.getByText("大纲纲目")).toBeInTheDocument();
    expect(screen.getAllByText("第一章 灯下潮痕").length).toBeGreaterThan(0);
    expect(
      screen.queryByText("每一次取回记忆，都要付出可见且不可逆的代价。"),
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "编辑对象" }), { target: { value: "n-ch-1" } });
    expect(await screen.findByRole("link", { name: /去写作台写本章/ })).toHaveAttribute(
      "href",
      "/projects/p-1-tides/studio?outline=n-ch-1",
    );
    expect(screen.queryByRole("button", { name: /生成本章/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "查看实体" }));
    expect(screen.getByText("实体册")).toBeInTheDocument();
    expect(screen.getAllByText(/纸张修复师/).length).toBeGreaterThan(0);
    expect(screen.queryByText("大纲纲目")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "查看关系" }));
    expect(screen.getByText("关系谱")).toBeInTheDocument();
    expect(screen.getByText("沈砚 · 常客 · 回声邮局")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "查看伏笔" }));
    expect(screen.getByText("伏笔谱")).toBeInTheDocument();
    expect(screen.getAllByText("空白信与消失的记忆").length).toBeGreaterThan(0);
  });

  it("未选择作品时给出空馆态且不拉取 story-bible", () => {
    const fetchMock = vi.fn(() => {
      throw new Error("should not fetch");
    });
    vi.stubGlobal("fetch", fetchMock);
    renderBible("/missing");

    expect(screen.getByRole("heading", { name: "故事" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回藏书室" })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("请求失败时给出错误注记而非摊书页", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ error: { code: "route.not_found", message: "接口不存在" } }),
          { status: 404, headers: { "content-type": "application/json" } },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderBible();

    await screen.findByText("接口不存在");
    // 反断言：不渲染板块
    expect(screen.queryByText("作者意图")).not.toBeInTheDocument();
    expect(screen.queryByText("大纲纲目")).not.toBeInTheDocument();
  });

  it("在当前分页面内展示候选差异，并对锁定内容进行二次确认", async () => {
    const item = {
      id: "item-1",
      operation: "update",
      targetId: "intent",
      title: "收紧创作承诺",
      rationale: "让记忆代价在每章都能被读者观察到。",
      impact: ["后续轻量审稿将据此检查代价是否可见"],
      before: { promise: BIBLE.intent.promise },
      after: { promise: "每封信都留下可见且不可逆的记忆代价。" },
      diff: [
        {
          field: "promise",
          before: BIBLE.intent.promise,
          after: "每封信都留下可见且不可逆的记忆代价。",
        },
      ],
      requiresLockedConfirmation: true,
      decision: null,
    };
    const candidate = {
      id: "set-1",
      projectId: "p-1-tides",
      runId: "run-1",
      stepId: "step-1",
      spread: "intent",
      instruction: "让创作承诺更具体",
      summary: "把抽象代价改成可以在正文中验证的约束。",
      baseFingerprint: "base",
      currentFingerprint: "base",
      stale: false,
      status: "candidate",
      items: [item],
      createdAt: "2026-08-13T00:00:00.000Z",
      decidedAt: null,
    };
    const decisionBodies: unknown[] = [];
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/projects/p-1-tides/story-bible") return json(BIBLE);
        if (url === "/api/projects/p-1-tides/runs") return json([]);
        if (
          url ===
          "/api/projects/p-1-tides/canon-spreads/intent/candidates"
        )
          return json([candidate]);
        if (
          url ===
          "/api/projects/p-1-tides/canon-candidates/set-1/items/item-1/decisions"
        ) {
          decisionBodies.push(JSON.parse(String(init?.body)));
          return json({
            candidateSet: { ...candidate, status: "applied" },
            item: {
              ...item,
              decision: {
                action: "apply",
                result: {},
                decidedAt: "2026-08-13T00:01:00.000Z",
              },
            },
          });
        }
        if (url.includes("/canon-spreads/") && url.endsWith("/candidates"))
          return json([]);
        throw new Error(`unexpected request ${url}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    renderBible();

    expect(
      await screen.findByRole("heading", { name: "收紧创作承诺" }),
    ).toBeInTheDocument();
    expect(screen.getByText("每封信都留下可见且不可逆的记忆代价。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "采纳此项" }));
    expect(decisionBodies).toHaveLength(0);
    expect(
      screen.getByText("这项会改变锁定内容。再次点击确认，或选择拒绝。"),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "确认修改锁定内容" }),
    );
    await waitFor(() =>
      expect(decisionBodies).toEqual([
        { action: "apply", confirmLocked: true },
      ]),
    );
  });
});
