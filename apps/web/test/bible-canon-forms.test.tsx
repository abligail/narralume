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
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CanonEntityTypeSchema } from "@narralume/contracts";

import { setLocale } from "../src/i18n";
import { BibleWorkspace } from "../src/workspaces/bible";

/* CR-17/CR-18：实体表单枚举与事实表单宾语必须以后端契约为准。 */

const ENTITIES = [
  {
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
  },
  {
    id: "e-post-office",
    projectId: "p-1",
    type: "location",
    name: "回声邮局",
    aliases: [],
    description: null,
    attributes: {},
    status: "active",
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
  },
];

const FACT_ENTITY = {
  id: "f-entity",
  projectId: "p-1",
  subjectId: "e-shenyan",
  predicate: "常去",
  objectEntityId: "e-post-office",
  value: null,
  validFromNodeId: null,
  validToNodeId: null,
  knowledgeScope: "omniscient",
  knowledgeSubjectId: null,
  authority: "confirmed",
  confidence: 1,
  sourceType: "import",
  sourceId: null,
  supersedesFactId: null,
  createdAt: "2026-08-01T10:00:00.000Z",
};

const FACT_LOCKED = {
  ...FACT_ENTITY,
  id: "f-locked",
  predicate: "身份",
  objectEntityId: null,
  value: "灯塔守望者",
  authority: "locked",
};

const OUTLINE = [
  {
    id: "book-1", projectId: "p-1", parentId: null, kind: "book", path: "/book-1", depth: 0, ordinal: 0,
    title: "全书", summary: null, goal: null, conflict: null, outcome: null, povEntityId: null, storyTime: null,
    status: "planned", metadata: {}, createdAt: "2026-08-01T10:00:00.000Z", updatedAt: "2026-08-01T10:00:00.000Z",
  },
  {
    id: "volume-1", projectId: "p-1", parentId: "book-1", kind: "volume", path: "/book-1/volume-1", depth: 1, ordinal: 0,
    title: "第一卷", summary: null, goal: null, conflict: null, outcome: null, povEntityId: null, storyTime: null,
    status: "planned", metadata: {}, createdAt: "2026-08-01T10:00:00.000Z", updatedAt: "2026-08-01T10:00:00.000Z",
  },
  {
    id: "chapter-1", projectId: "p-1", parentId: "volume-1", kind: "chapter", path: "/book-1/volume-1/chapter-1", depth: 2, ordinal: 0,
    title: "第一章", summary: null, goal: null, conflict: null, outcome: null, povEntityId: null, storyTime: null,
    status: "planned", metadata: {}, createdAt: "2026-08-01T10:00:00.000Z", updatedAt: "2026-08-01T10:00:00.000Z",
  },
  {
    id: "beat-1", projectId: "p-1", parentId: "chapter-1", kind: "beat", path: "/book-1/volume-1/chapter-1/beat-1", depth: 3, ordinal: 0,
    title: "开场节拍", summary: null, goal: null, conflict: null, outcome: null, povEntityId: null, storyTime: null,
    status: "planned", metadata: {}, createdAt: "2026-08-01T10:00:00.000Z", updatedAt: "2026-08-01T10:00:00.000Z",
  },
] as const;

const BIBLE = {
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
  entities: ENTITIES,
  facts: [FACT_ENTITY],
  relationships: [],
  timeline: [],
  foreshadows: [],
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

type CapturedRequest = {
  url: string;
  method: string;
  body: Record<string, unknown>;
};

function renderBible(entry: string, requests: CapturedRequest[], bible = BIBLE) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/projects/p-1/story-bible") return json(bible);
    if (url === "/api/projects/p-1/runs") return json([]);
    if (url.startsWith("/api/projects/p-1/canon-spreads/")) return json([]);
    if (init?.body) {
      requests.push({
        url,
        method: init.method ?? "GET",
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
      });
      if (url.endsWith("/facts") || url.includes("/facts/"))
        return json({ fact: {}, conflicts: [] });
      return json({});
    }
    throw new Error(`unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/projects/:projectId/bible" element={<BibleWorkspace />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function optionValues(combobox: HTMLElement) {
  return within(combobox)
    .getAllByRole("option")
    .map((option) => option.getAttribute("value"));
}

// 编辑面板里还有上下文预览表单的“保存”，板块表单的在 DOM 中排第一。
function clickSave() {
  const button = screen.getAllByRole("button", { name: "保存" })[0];
  expect(button).toBeDefined();
  fireEvent.click(button as HTMLElement);
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

it("实体表单的类型/状态选项与契约枚举一致（CR-17）", async () => {
  renderBible("/projects/p-1/bible?spread=entities", []);

  const typeSelect = await screen.findByRole("combobox", { name: "类型" });
  expect(optionValues(typeSelect)).toEqual([...CanonEntityTypeSchema.options]);

  fireEvent.change(screen.getByRole("combobox", { name: "编辑对象" }), {
    target: { value: "e-shenyan" },
  });
  const statusSelect = await screen.findByRole("combobox", { name: "状态" });
  expect(optionValues(statusSelect)).toEqual(["active", "retired"]);
});

it("新建/更新实体只提交契约内的枚举值（CR-17）", async () => {
  const requests: CapturedRequest[] = [];
  renderBible("/projects/p-1/bible?spread=entities", requests);

  fireEvent.change(await screen.findByRole("combobox", { name: "类型" }), {
    target: { value: "item" },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "名称" }), {
    target: { value: "空白信" },
  });
  clickSave();
  await waitFor(() =>
    expect(
      requests.some(
        (request) =>
          request.url === "/api/projects/p-1/entities" &&
          request.method === "POST" &&
          request.body.type === "item",
      ),
    ).toBe(true),
  );

  fireEvent.change(screen.getByRole("combobox", { name: "编辑对象" }), {
    target: { value: "e-shenyan" },
  });
  fireEvent.change(await screen.findByRole("combobox", { name: "状态" }), {
    target: { value: "retired" },
  });
  clickSave();
  await waitFor(() =>
    expect(
      requests.some(
        (request) =>
          request.url === "/api/projects/p-1/entities/e-shenyan" &&
          request.method === "PUT" &&
          request.body.status === "retired",
      ),
    ).toBe(true),
  );
});

it("新建事实默认提交文本值，objectEntityId 置 null（CR-18）", async () => {
  const requests: CapturedRequest[] = [];
  renderBible("/projects/p-1/bible?spread=facts", requests);

  expect(await screen.findByRole("combobox", { name: "宾语" })).toHaveValue(
    "value",
  );
  fireEvent.change(screen.getByRole("textbox", { name: "谓词" }), {
    target: { value: "职业" },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "值" }), {
    target: { value: "纸张修复师" },
  });
  clickSave();

  await waitFor(() => expect(requests).toHaveLength(1));
  expect(requests[0]).toMatchObject({
    url: "/api/projects/p-1/facts",
    method: "POST",
  });
  expect(requests[0]?.body).toMatchObject({
    subjectId: "e-shenyan",
    predicate: "职业",
    value: "纸张修复师",
    objectEntityId: null,
  });
});

it("新建事实可选择实体作为宾语，value 不随请求提交（CR-18）", async () => {
  const requests: CapturedRequest[] = [];
  renderBible("/projects/p-1/bible?spread=facts", requests);

  fireEvent.change(await screen.findByRole("combobox", { name: "宾语" }), {
    target: { value: "entity" },
  });
  fireEvent.change(screen.getByRole("combobox", { name: "宾语实体" }), {
    target: { value: "e-post-office" },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "谓词" }), {
    target: { value: "常去" },
  });
  expect(screen.queryByRole("textbox", { name: "值" })).not.toBeInTheDocument();
  clickSave();

  await waitFor(() => expect(requests).toHaveLength(1));
  expect(requests[0]?.body).toMatchObject({
    subjectId: "e-shenyan",
    predicate: "常去",
    objectEntityId: "e-post-office",
  });
  expect("value" in (requests[0]?.body ?? {})).toBe(false);
});

it("修订实体宾语事实时可保留实体宾语或改回文本值（CR-18）", async () => {
  const requests: CapturedRequest[] = [];
  renderBible("/projects/p-1/bible?spread=facts", requests);

  fireEvent.change(await screen.findByRole("combobox", { name: "编辑对象" }), {
    target: { value: "f-entity" },
  });
  // 既有实体宾语事实进入实体模式，不再被迫填写文本值。
  expect(await screen.findByRole("combobox", { name: "宾语" })).toHaveValue(
    "entity",
  );
  expect(screen.getByRole("combobox", { name: "宾语实体" })).toHaveValue(
    "e-post-office",
  );

  clickSave();
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(requests[0]).toMatchObject({
    url: "/api/projects/p-1/facts/f-entity",
    method: "PUT",
  });
  expect(requests[0]?.body.objectEntityId).toBe("e-post-office");
  expect("value" in (requests[0]?.body ?? {})).toBe(false);

  // 切换为文本值后，objectEntityId 置 null、提交新文本。
  fireEvent.change(screen.getByRole("combobox", { name: "宾语" }), {
    target: { value: "value" },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "值" }), {
    target: { value: "灯塔看守人" },
  });
  clickSave();
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(requests[1]?.body).toMatchObject({
    objectEntityId: null,
    value: "灯塔看守人",
  });
});

it("新建大纲时只允许领域树规定的父子层级（CR-20）", async () => {
  renderBible("/projects/p-1/bible?spread=outline", [], { ...BIBLE, outline: [...OUTLINE] });

  const parent = await screen.findByRole("combobox", { name: "父节点" });
  expect(optionValues(parent)).toEqual(["book-1", "volume-1", "chapter-1"]);
  expect(optionValues(screen.getByRole("combobox", { name: "类型" }))).toEqual([
    "volume",
    "arc",
    "chapter",
  ]);

  fireEvent.change(parent, { target: { value: "chapter-1" } });
  await waitFor(() =>
    expect(optionValues(screen.getByRole("combobox", { name: "类型" }))).toEqual([
      "scene",
      "beat",
    ]),
  );
  expect(screen.getByText("章节下可建：场景、节拍")).toBeInTheDocument();
});

it("修改或撤回锁定事实前要求用户明确确认（CR-19）", async () => {
  const requests: CapturedRequest[] = [];
  renderBible("/projects/p-1/bible?spread=facts", requests, { ...BIBLE, facts: [FACT_ENTITY, FACT_LOCKED] });

  fireEvent.change(await screen.findByRole("combobox", { name: "编辑对象" }), {
    target: { value: "f-locked" },
  });
  clickSave();
  expect(await screen.findByRole("alertdialog", { name: "修改锁定事实" })).toBeInTheDocument();
  expect(requests).toHaveLength(0);
  fireEvent.click(screen.getByRole("button", { name: "确认修改" }));
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(requests[0]?.body.confirmLockedRevision).toBe(true);

  fireEvent.change(screen.getByRole("textbox", { name: "撤回原因" }), {
    target: { value: "设定已废弃" },
  });
  fireEvent.click(screen.getByRole("button", { name: "撤回事实" }));
  expect(await screen.findByRole("alertdialog", { name: "撤回锁定事实" })).toBeInTheDocument();
  expect(requests).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "确认撤回" }));
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(requests[1]?.body).toMatchObject({
    reason: "设定已废弃",
    confirmLockedWithdrawal: true,
  });
});
