// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "../src/i18n";
import type { CoCreateSession, CoCreateSessionDetail, StoryPersona, StoryTurn } from "../src/lib/api";
import { CoCreateWorkspace } from "../src/workspaces/studio/cocreate";

/* 共创沙盒：故事房 + 回合 + Swipe/分支。 */

const PERSONA: StoryPersona = {
  id: "persona-1",
  projectId: "p-1",
  kind: "narrator",
  entityId: null,
  name: "旁白",
  description: null,
  instructions: "克制、具体",
  voice: {},
  status: "active",
  createdAt: "2026-08-10T10:00:00.000Z",
  updatedAt: "2026-08-10T10:00:00.000Z",
  version: 0,
};

function makeSession(
  id: string,
  title: string,
  status: CoCreateSession["status"] = "active",
): CoCreateSession {
  return {
    id,
    projectId: "p-1",
    title,
    status,
    speakerPolicy: "manual",
    activeBranchId: `branch-${id}`,
    targetOutlineNodeId: null,
    authorPersonaId: null,
    directorNote: null,
    contextTurns: 20,
    createdAt: "2026-08-10T10:00:00.000Z",
    updatedAt: "2026-08-10T10:00:00.000Z",
    version: 1,
  };
}

function makeTurn(sessionId: string, id: string, ordinal: number, role: StoryTurn["role"], content: string): StoryTurn {
  return {
    id,
    projectId: "p-1",
    sessionId,
    branchId: `branch-${sessionId}`,
    parentTurnId: null,
    ordinal,
    role,
    personaId: role === "assistant" ? PERSONA.id : null,
    content,
    status: "active",
    selectedSwipeId: null,
    sourceRunId: null,
    metadata: {},
    createdAt: "2026-08-10T10:00:00.000Z",
    updatedAt: "2026-08-10T10:00:00.000Z",
    swipes: [],
  };
}

function makeDetail(
  sessionId: string,
  title: string,
  turns: StoryTurn[],
  status: CoCreateSession["status"] = "active",
): CoCreateSessionDetail {
  return {
    session: makeSession(sessionId, title, status),
    participants: [
      {
        sessionId,
        personaId: PERSONA.id,
        position: 0,
        enabled: true,
        talkativeness: 0.5,
        createdAt: "2026-08-10T10:00:00.000Z",
        persona: PERSONA,
      },
    ],
    branches: [
      {
        id: `branch-${sessionId}`,
        sessionId,
        parentBranchId: null,
        forkedFromTurnId: null,
        name: "主线",
        status: "active",
        headTurnId: null,
        createdAt: "2026-08-10T10:00:00.000Z",
        updatedAt: "2026-08-10T10:00:00.000Z",
      },
    ],
    turns,
    adoptions: [],
  };
}

const DETAILS: Record<string, CoCreateSessionDetail> = {
  "s-a": makeDetail("s-a", "房间A", [
    makeTurn("s-a", "t-a-0", 0, "user", "第一段。"),
    makeTurn("s-a", "t-a-1", 1, "assistant", "旁白接一段。"),
  ]),
  "s-b": makeDetail("s-b", "房间B", [makeTurn("s-b", "t-b-0", 0, "user", "另一本书。")]),
};

function json(value: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

function stubFetch(
  sessions: CoCreateSession[],
  details: Record<string, CoCreateSessionDetail> = DETAILS,
) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/projects/p-1/personas") return json([PERSONA]);
    if (url === "/api/projects/p-1/cocreate/sessions") return json(sessions);
    const detailMatch = url.match(/^\/api\/cocreate\/sessions\/([^/]+)$/);
    if (detailMatch && init?.method === "PUT" && details[detailMatch[1]!]) {
      return json({
        ...details[detailMatch[1]!]!.session,
        status: "paused",
        version: 2,
      });
    }
    if (detailMatch && details[detailMatch[1]!]) return json(details[detailMatch[1]!]);
    throw new Error(`unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderCoCreate(requestedSessionId?: string | null) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <CoCreateWorkspace projectId="p-1" requestedSessionId={requestedSessionId} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  setLocale("zh-CN");
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("共创沙盒", () => {
  it("Persona 查询失败时显示错误并禁用依赖写入", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects/p-1/personas") {
        return json(
          { error: { code: "storage.unavailable", message: "personas unavailable" } },
          500,
        );
      }
      if (url === "/api/projects/p-1/cocreate/sessions") return json([]);
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderCoCreate();

    expect(await screen.findByText("角色设定暂时无法加载")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "创建 Persona" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "创建故事房" })).not.toBeInTheDocument();
  });

  it("可按 URL 提供的会话身份直接恢复故事房", async () => {
    stubFetch([makeSession("s-a", "房间A"), makeSession("s-b", "房间B")]);
    renderCoCreate("s-b");

    expect(await screen.findByText("另一本书。")).toBeInTheDocument();
    expect(screen.getByLabelText("选择共创会话")).toHaveValue("s-b");
  });

  it("暂停会话只保留阅读和重新激活动作（CR-63）", async () => {
    const paused = makeDetail(
      "s-paused",
      "暂停房间",
      [
        makeTurn("s-paused", "t-paused-0", 0, "user", "第一段。"),
        makeTurn("s-paused", "t-paused-1", 1, "assistant", "旁白接一段。"),
      ],
      "paused",
    );
    stubFetch([paused.session], { "s-paused": paused });
    renderCoCreate();

    await screen.findByText(/paused · 分支/);
    const room = within(document.querySelector(".cocreate__room")!);
    expect(room.getByRole("button", { name: "active" })).toBeEnabled();
    expect(room.getByRole("button", { name: "paused" })).toBeDisabled();
    expect(room.getAllByRole("checkbox", { name: "旁白" }).at(-1)).toBeDisabled();
    expect(room.getByPlaceholderText(/写下一回合/)).toBeDisabled();
    expect(room.getByRole("button", { name: /发送并生成回复/ })).toBeDisabled();
    expect(room.getByRole("button", { name: /再生 Swipe/ })).toBeDisabled();
    expect(room.getAllByRole("button", { name: /回退到此/ }).at(-1)).toBeDisabled();
    expect(room.getByRole("button", { name: /建分支/ })).toBeDisabled();
    expect(room.getByRole("button", { name: "采纳范围" })).toBeDisabled();
  });

  it("只为 assistant 回合渲染「再生 Swipe」（CR-86）", async () => {
    stubFetch([makeSession("s-a", "房间A")]);
    renderCoCreate();

    const userCard = (await screen.findByText("#0 · user")).closest("article")!;
    const assistantCard = (await screen.findByText("#1 · 旁白")).closest("article")!;
    expect(within(userCard).queryByRole("button", { name: /再生 Swipe/ })).not.toBeInTheDocument();
    expect(within(assistantCard).getByRole("button", { name: /再生 Swipe/ })).toBeInTheDocument();
    // 两个回合都保留「回退到此」以外的动作区
    expect(within(userCard).getByRole("button", { name: /回退到此/ })).toBeInTheDocument();
  });

  it("切换故事房后重置未发送草稿与发言者选择（CR-87）", async () => {
    stubFetch([makeSession("s-a", "房间A"), makeSession("s-b", "房间B")]);
    renderCoCreate();

    const composer = await screen.findByPlaceholderText(/写下一回合/);
    fireEvent.change(composer, { target: { value: "未发送的草稿" } });
    fireEvent.change(screen.getByDisplayValue("由策略选发言者"), { target: { value: PERSONA.id } });
    expect(screen.getByDisplayValue("旁白")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("选择共创会话"), { target: { value: "s-b" } });
    await screen.findByText("另一本书。");

    expect(screen.getByPlaceholderText(/写下一回合/)).toHaveValue("");
    expect(screen.getByDisplayValue("由策略选发言者")).toBeInTheDocument();
  });

  it("manual 策略零参与者时禁用创建故事房（CR-85）", async () => {
    stubFetch([]);
    renderCoCreate();

    fireEvent.change(await screen.findByLabelText("房间名"), { target: { value: "新房间" } });
    const submit = screen.getByRole("button", { name: "创建故事房" });
    expect(submit).toBeDisabled();

    // 选择参与者后可用；切回自动策略零参与者也可用
    const checkbox = await screen.findByRole("checkbox", { name: "旁白" });
    fireEvent.click(checkbox);
    expect(submit).toBeEnabled();
    fireEvent.click(checkbox);
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText("发言策略"), { target: { value: "auto" } });
    expect(submit).toBeEnabled();
  });

  it("manual 策略未选发言者时禁用发送（CR-85）", async () => {
    stubFetch([makeSession("s-a", "房间A")]);
    renderCoCreate();

    const composer = await screen.findByPlaceholderText(/写下一回合/);
    fireEvent.change(composer, { target: { value: "写一段潮声。" } });
    const send = screen.getByRole("button", { name: /发送并生成回复/ });
    expect(send).toBeDisabled();

    fireEvent.change(screen.getByDisplayValue("由策略选发言者"), { target: { value: PERSONA.id } });
    expect(send).toBeEnabled();
  });

  it("房间配置写请求携带当前版本（CR-27）", async () => {
    const fetchMock = stubFetch([makeSession("s-a", "房间A")]);
    renderCoCreate();

    fireEvent.click(await screen.findByRole("button", { name: "paused" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/cocreate/sessions/s-a",
        expect.objectContaining({ method: "PUT" }),
      );
    });
    const call = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url) === "/api/cocreate/sessions/s-a" && init?.method === "PUT",
    );
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      status: "paused",
      expectedVersion: 1,
    });
  });

  it("生成 Run 完成后自动刷新故事房并显示 AI 回合", async () => {
    const initial = makeDetail("s-a", "房间A", [
      makeTurn("s-a", "t-a-0", 0, "user", "第一段。"),
    ]);
    const completed = makeDetail("s-a", "房间A", [
      ...initial.turns,
      makeTurn("s-a", "t-a-1", 1, "assistant", "潮声从门缝里漫进来。"),
    ]);
    let runReads = 0;
    let settled = false;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/projects/p-1/personas") return json([PERSONA]);
      if (url === "/api/projects/p-1/cocreate/sessions") return json([initial.session]);
      if (url === "/api/cocreate/sessions/s-a/turns" && init?.method === "POST") {
        return json({
          turn: makeTurn("s-a", "t-user", 1, "user", "继续。"),
          run: { id: "run-reply", status: "pending" },
        }, 202);
      }
      if (url === "/api/runs/run-reply?projectId=p-1") {
        runReads += 1;
        settled = runReads >= 2;
        return json({ run: { id: "run-reply", status: settled ? "completed" : "running" } });
      }
      if (url === "/api/cocreate/sessions/s-a") return json(settled ? completed : initial);
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderCoCreate();

    fireEvent.change(await screen.findByPlaceholderText(/写下一回合/), {
      target: { value: "继续。" },
    });
    fireEvent.change(screen.getByDisplayValue("由策略选发言者"), {
      target: { value: PERSONA.id },
    });
    fireEvent.click(screen.getByRole("button", { name: /发送并生成回复/ }));
    await waitFor(() => expect(runReads).toBe(1));
    expect(
      await screen.findByText("潮声从门缝里漫进来。", {}, { timeout: 4_000 }),
    ).toBeInTheDocument();
  });

  it("退役参与者仍可从房间移除，但不能再被选作发言者", async () => {
    const retired = { ...PERSONA, status: "retired" as const, version: 1 };
    const detail = makeDetail("s-retired", "旧角色房间", []);
    detail.participants = [{
      ...detail.participants[0]!,
      sessionId: "s-retired",
      persona: retired,
    }];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/projects/p-1/personas") return json([retired]);
      if (url === "/api/projects/p-1/cocreate/sessions") return json([detail.session]);
      if (url === "/api/cocreate/sessions/s-retired") return json(detail);
      if (url === "/api/cocreate/sessions/s-retired/participants" && init?.method === "PUT") {
        return json({ ...detail, participants: [], session: { ...detail.session, version: 2 } });
      }
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderCoCreate();

    const retiredCheckbox = await screen.findByRole("checkbox", {
      name: "旁白（已退役，可移除）",
    });
    expect(retiredCheckbox).toBeChecked();
    expect(retiredCheckbox).toBeEnabled();
    const composer = screen.getByPlaceholderText(/写下一回合/).closest("form")!;
    expect(within(composer).queryByRole("option", { name: "旁白" })).not.toBeInTheDocument();
    fireEvent.click(retiredCheckbox);
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url, init]) =>
        String(url) === "/api/cocreate/sessions/s-retired/participants" && init?.method === "PUT");
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({
        expectedVersion: 1,
        participants: [],
      });
    });
  });
});
