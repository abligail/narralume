// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProjectAssistant } from "../src/app/project-assistant";
import { setLocale } from "../src/i18n";

const CONVERSATION = {
  id: "assistant-conversation-1",
  projectId: "project-1",
  title: "项目协作",
  status: "active",
  settings: { modelId: null, reasoningEffort: null },
  createdAt: "2026-08-13T01:00:00.000Z",
  updatedAt: "2026-08-13T01:03:00.000Z",
};

const CONTEXT = {
  surface: "studio",
  documentId: "document-1",
  outlineNodeId: "chapter-1",
  canonSpread: null,
  selection: { start: 10, end: 24, text: "潮水漫过旧码头" },
} as const;

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

function renderAssistant() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ProjectAssistant
          projectId="project-1"
          context={CONTEXT}
          open
          onOpen={() => undefined}
          onClose={() => undefined}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function AssistantHarness() {
  const [open, setOpen] = useState(false);
  return (
    <ProjectAssistant
      projectId="project-1"
      context={CONTEXT}
      open={open}
      onOpen={() => setOpen(true)}
      onClose={() => setOpen(false)}
    />
  );
}

function renderAssistantHarness() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter><AssistantHarness /></MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  setLocale("zh-CN");
  window.localStorage.clear();
  window.localStorage.setItem(
    "narralume:assistant-conversation:project-1",
    CONVERSATION.id,
  );
  Element.prototype.scrollTo = vi.fn();
  EventSourceStub.instances = [];
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("项目协作侧栏", () => {
  it("关闭时卸载侧栏，并在关闭后恢复到触发按钮（CR-84）", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects/project-1/assistant/conversations") return json([CONVERSATION]);
      if (url === `/api/assistant/conversations/${CONVERSATION.id}`) return json(detail(false));
      throw new Error(`unexpected request ${url}`);
    }));
    renderAssistantHarness();

    const trigger = screen.getByRole("button", { name: "打开项目协作" });
    expect(screen.queryByRole("complementary", { name: "项目协作" })).not.toBeInTheDocument();
    fireEvent.click(trigger);
    expect(await screen.findByRole("complementary", { name: "项目协作" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭项目协作" }));
    expect(screen.queryByRole("complementary", { name: "项目协作" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开项目协作" })).toHaveFocus();
  });

  it("只在打开时订阅当前会话关联运行的事件（CR-10）", async () => {
    let detailRequests = 0;
    vi.stubGlobal("EventSource", EventSourceStub);
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/projects/project-1/assistant/conversations")
          return json([CONVERSATION]);
        if (url === `/api/assistant/conversations/${CONVERSATION.id}`) {
          detailRequests += 1;
          const current = detail(false);
          return json({
            ...current,
            activities: current.activities.slice(1),
          });
        }
        throw new Error(`unexpected request ${url}`);
      }),
    );
    renderAssistantHarness();

    expect(EventSourceStub.instances).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "打开项目协作" }));
    await screen.findByText("请按当前细纲写这一章。");
    expect(EventSourceStub.instances).toHaveLength(1);
    const source = EventSourceStub.instances[0]!;
    const initialRequests = detailRequests;

    act(() => {
      source.emit("run.event", {
        type: "run.event",
        runId: "unrelated-run",
        stepId: null,
        sequence: 1,
        eventType: "step.completed",
        payload: {},
      });
    });
    await Promise.resolve();
    expect(detailRequests).toBe(initialRequests);

    act(() => {
      source.emit("run.status", {
        type: "run.status",
        runId: "assistant-run-1",
        status: "completed",
      });
    });
    await waitFor(() => expect(detailRequests).toBeGreaterThan(initialRequests));

    fireEvent.click(screen.getByRole("button", { name: "关闭项目协作" }));
    expect(source.close).toHaveBeenCalledOnce();
  });

  it("模型胶囊只列同协议模型，思考档与模型选择写回对话设置", async () => {
    const configured: Array<Record<string, unknown>> = [];
    const settings = { modelId: null as string | null, reasoningEffort: null as string | null };
    const providers = [
      { id: "provider-chat", name: "网关 A", wireApi: "openai-chat", enabled: true },
      { id: "provider-anthropic", name: "网关 B", wireApi: "anthropic-messages", enabled: true },
    ];
    const models = [
      { id: "model-default", providerId: "provider-chat", modelId: "default-model", taskType: "writing", enabled: true },
      { id: "model-chat-2", providerId: "provider-chat", modelId: "chat-model-2", taskType: "writing", enabled: true },
      { id: "model-anthropic", providerId: "provider-anthropic", modelId: "anthropic-model", taskType: "writing", enabled: true },
    ];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/projects/project-1/assistant/conversations") {
        return json([{ ...CONVERSATION, settings }]);
      }
      if (url === `/api/assistant/conversations/${CONVERSATION.id}`) {
        return json(detail(false));
      }
      if (url === "/api/providers") return json(providers);
      if (url === "/api/models") return json(models);
      if (url === "/api/assignments")
        return json([{ role: "writing", modelId: "model-default", updatedAt: "2026-08-13T00:00:00.000Z" }]);
      if (
        url === `/api/assistant/conversations/${CONVERSATION.id}/actions` &&
        init?.method === "POST"
      ) {
        configured.push(JSON.parse(String(init.body)));
        const body = configured.at(-1)!;
        if (typeof body.modelId === "string") settings.modelId = body.modelId;
        if (body.modelId === null) settings.modelId = null;
        if (typeof body.reasoningEffort === "string") settings.reasoningEffort = body.reasoningEffort;
        return json({ ...CONVERSATION, settings });
      }
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderAssistant();

    /* 默认态：显示全局默认模型 + 默认徽标 + 思考·低。 */
    const trigger = await screen.findByRole("button", { name: /对话模型与思考档/ });
    await waitFor(() => expect(trigger).toHaveTextContent("default-model"));
    expect(trigger).toHaveTextContent("默认");
    expect(trigger).toHaveTextContent("思考·低");

    fireEvent.click(screen.getByRole("button", { name: /对话模型与思考档/ }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /对话模型与思考档/ })).toHaveAttribute("aria-expanded", "true"),
    );
    expect(screen.getByRole("listbox", { name: "对话模型" })).toBeInTheDocument();
    /* 同协议模型可见，跨协议模型（anthropic）不出现。 */
    expect(await screen.findByRole("option", { name: "chat-model-2" })).toBeInTheDocument();
    expect(screen.queryByText("anthropic-model")).not.toBeInTheDocument();

    /* 选模型 → configure 写回 modelId。 */
    fireEvent.click(screen.getByRole("option", { name: "chat-model-2" }));
    await waitFor(() =>
      expect(configured).toEqual([
        expect.objectContaining({ action: "configure", modelId: "model-chat-2" }),
      ]),
    );

    /* 重开弹层切思考档。 */
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /对话模型与思考档/ })).toHaveTextContent("chat-model-2"),
    );
    fireEvent.click(screen.getByRole("button", { name: /对话模型与思考档/ }));
    fireEvent.click(await screen.findByRole("button", { name: "高" }));
    await waitFor(() =>
      expect(configured.at(-1)).toEqual(
        expect.objectContaining({ action: "configure", reasoningEffort: "high" }),
      ),
    );
  });

  it("切换并归档协作对话后回到仍活跃的会话 (CR-11)", async () => {
    const second = {
      ...CONVERSATION,
      id: "assistant-conversation-2",
      title: "人物线讨论",
      updatedAt: "2026-08-13T02:00:00.000Z",
    };
    let conversations = [second, CONVERSATION];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/projects/project-1/assistant/conversations") {
        return json(conversations);
      }
      if (url === `/api/assistant/conversations/${CONVERSATION.id}`) {
        return json(detail(false));
      }
      if (url === `/api/assistant/conversations/${second.id}`) {
        return json({
          ...detail(false),
          conversation: second,
          messages: [
            {
              ...detail(false).messages[0],
              id: "second-message",
              conversationId: second.id,
              content: "只讨论人物线。",
            },
          ],
          activities: [],
        });
      }
      if (
        url === `/api/assistant/conversations/${second.id}/actions` &&
        init?.method === "POST"
      ) {
        conversations = [
          { ...second, status: "archived" as const },
          CONVERSATION,
        ];
        return json(conversations[0]);
      }
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderAssistant();

    /* 初始占位触发器显示“项目协作”；等数据加载、触发器可用后再点开。 */
    const trigger = await screen.findByRole("button", { name: "项目协作" });
    await waitFor(() => expect(trigger).not.toBeDisabled());
    fireEvent.click(trigger);
    const option = await screen.findByRole(
      "option",
      { name: "人物线讨论" },
      { timeout: 3_000 },
    );
    fireEvent.click(option);
    expect(await screen.findByText("只讨论人物线。")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "归档当前协作对话" }),
    );

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/assistant/conversations/${second.id}/actions`,
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ action: "archive" }),
        }),
      ),
    );
  });

  it("重命名当前协作对话并刷新列表", async () => {
    let conversations = [CONVERSATION];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/projects/project-1/assistant/conversations") {
        return json(conversations);
      }
      if (url === `/api/assistant/conversations/${CONVERSATION.id}`) {
        return json(detail(false));
      }
      if (
        url === `/api/assistant/conversations/${CONVERSATION.id}/actions` &&
        init?.method === "POST"
      ) {
        conversations = [
          { ...CONVERSATION, title: "伏笔整理", updatedAt: "2026-08-13T03:00:00.000Z" },
        ];
        return json(conversations[0]);
      }
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderAssistant();

    const trigger = await screen.findByRole("button", { name: "项目协作" });
    await waitFor(() => expect(trigger).not.toBeDisabled());
    fireEvent.click(trigger);
    fireEvent.click(
      screen.getByRole("button", { name: "重命名当前协作对话" }),
    );
    const input = screen.getByLabelText("对话新名称");
    expect(input).toHaveValue("项目协作");
    fireEvent.change(input, { target: { value: "伏笔整理" } });
    fireEvent.submit(screen.getByRole("button", { name: "保存" }).closest("form")!);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/assistant/conversations/${CONVERSATION.id}/actions`,
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ action: "rename", title: "伏笔整理" }),
        }),
      ),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "伏笔整理" })).toBeEnabled(),
    );
  });

  it("新建协作对话后保持在新对话，不被旧列表切回", async () => {
    const created = {
      ...CONVERSATION,
      id: "assistant-conversation-2",
      title: "协作对话 2",
      createdAt: "2026-08-13T04:00:00.000Z",
      updatedAt: "2026-08-13T04:00:00.000Z",
    };
    let conversations = [CONVERSATION];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (
        url === "/api/projects/project-1/assistant/conversations" &&
        init?.method === "POST"
      ) {
        conversations = [created, CONVERSATION];
        return json(created, 201);
      }
      if (url === "/api/projects/project-1/assistant/conversations") {
        return json(conversations);
      }
      if (url === `/api/assistant/conversations/${CONVERSATION.id}`) {
        return json(detail(false));
      }
      if (url === `/api/assistant/conversations/${created.id}`) {
        return json({
          ...detail(false),
          conversation: created,
          messages: [],
          activities: [],
        });
      }
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderAssistant();

    await screen.findByText("请按当前细纲写这一章。");
    fireEvent.click(screen.getByRole("button", { name: "新建协作对话" }));

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "协作对话 2" }),
      ).toBeEnabled(),
    );
    expect(
      window.localStorage.getItem(
        "narralume:assistant-conversation:project-1",
      ),
    ).toBe(created.id);
    expect(await screen.findByText("从你正在看的地方开始"))
      .toBeInTheDocument();
  });

  it("对可恢复的失败提案显示原地重试动作 (CR-104)", async () => {
    let retried = false;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/projects/project-1/assistant/conversations") {
        return json([CONVERSATION]);
      }
      if (url === `/api/assistant/conversations/${CONVERSATION.id}`) {
        return json({
          ...detail(false),
          activities: [
            {
              ...detail(false).activities[1],
              status: retried ? "completed" : "failed",
              stage: retried ? "已交给现有任务链路" : "执行失败",
              waitingReason: retried ? null : "当前有其他章节任务",
              availableActions: retried ? [] : ["retry"],
              sourceType: retried ? "run" : "assistant_tool",
              sourceId: retried ? "chapter-run-1" : "proposal-1",
            },
          ],
        });
      }
      if (
        url === "/api/assistant/activities/proposal-1/actions" &&
        init?.method === "POST"
      ) {
        retried = true;
        return json({ activity: {}, source: { type: "run", id: "chapter-run-1" } });
      }
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderAssistant();

    fireEvent.click(await screen.findByRole("button", { name: "重试执行" }));
    await waitFor(() =>
      expect(
        screen.getByRole("link", { name: /查看任务现场/ }),
      ).toBeInTheDocument(),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/assistant/activities/proposal-1/actions",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ action: "retry" }),
      }),
    );
  });

  it("在同一时间线展示上下文、回复和待确认动作，并在确认后链接原任务", async () => {
    let confirmed = false;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (
        url === "/api/projects/project-1/assistant/conversations" &&
        !init?.method
      ) {
        return json([CONVERSATION]);
      }
      if (url === `/api/assistant/conversations/${CONVERSATION.id}`) {
        return json(detail(confirmed));
      }
      if (
        url === "/api/assistant/activities/proposal-1/actions" &&
        init?.method === "POST"
      ) {
        confirmed = true;
        return json({
          activity: detail(true).activities.find(
            (activity) => activity.kind === "tool",
          ),
          source: { type: "run", id: "chapter-run-1" },
        });
      }
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderAssistant();

    expect(screen.getByText("写作台")).toBeInTheDocument();
    expect(screen.getByText("当前稿件")).toBeInTheDocument();
    expect(screen.getByText("选中 14 字")).toBeInTheDocument();
    expect(
      await screen.findByText("请按当前细纲写这一章。"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("我可以生成候选正文，确认后才会开工。"),
    ).toBeInTheDocument();
    expect(screen.getByText("生成指定章节的候选正文")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "确认执行" }));
    await waitFor(() =>
      expect(
        screen.getByRole("link", { name: /查看任务现场/ }),
      ).toHaveAttribute(
        "href",
        "/projects/project-1/runs?run=chapter-run-1",
      ),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/assistant/activities/proposal-1/actions",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ action: "confirm" }),
      }),
    );
  });

  it("等待采纳的运行卡片：文案统一渲染、引到写作台、可直接取消", async () => {
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/projects/project-1/assistant/conversations") {
          return json([CONVERSATION]);
        }
        if (url === `/api/assistant/conversations/${CONVERSATION.id}`) {
          return json({
            ...detail(true),
            activities: [
              {
                id: "run:chapter-run-1",
                conversationId: CONVERSATION.id,
                kind: "task",
                layer: "primary",
                status: "waiting",
                goal: "完成《潮汐第一章》",
                stage: "等待你确认",
                summary: null,
                waitingReason: "chapter_commit_approval_required",
                availableActions: [
                  "accept_manuscript",
                  "request_revision",
                  "discard_manuscript",
                  "cancel",
                ],
                sourceType: "run",
                sourceId: "chapter-run-1",
                origin: CONTEXT,
                result: {},
                toolCall: null,
                createdAt: "2026-08-13T01:01:00.000Z",
                updatedAt: "2026-08-13T01:02:00.000Z",
              },
            ],
          });
        }
        if (
          url === "/api/runs/chapter-run-1/actions" &&
          init?.method === "POST"
        ) {
          return json({ run: { id: "chapter-run-1" } });
        }
        throw new Error(`unexpected request ${url}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    renderAssistant();

    const link = await screen.findByRole("link", { name: /前往处理/ });
    expect(link).toHaveAttribute(
      "href",
      "/projects/project-1/studio?run=chapter-run-1&document=document-1",
    );
    // waitingReason 现在是机器码，由前端标签表统一渲染成中文。
    expect(await screen.findByText("正文候选等待采纳")).toBeInTheDocument();

    // 低风险取消动作直接在卡片上执行，不需要跳页。
    fireEvent.click(screen.getByRole("button", { name: "取消任务" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/runs/chapter-run-1/actions",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ action: "cancel", projectId: "project-1" }),
        }),
      ),
    );
  });

  it("失败的章节运行卡片可直接重试本章", async () => {
    const fetchMock = vi.fn(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/projects/project-1/assistant/conversations") {
          return json([CONVERSATION]);
        }
        if (url === `/api/assistant/conversations/${CONVERSATION.id}`) {
          return json({
            ...detail(true),
            activities: [
              {
                id: "run:failed-run-1",
                conversationId: CONVERSATION.id,
                kind: "task",
                layer: "primary",
                status: "failed",
                goal: "完成《潮汐第一章》",
                stage: "需要处理失败",
                summary: null,
                waitingReason: null,
                availableActions: ["retry_chapter"],
                sourceType: "run",
                sourceId: "failed-run-1",
                origin: CONTEXT,
                result: {},
                toolCall: null,
                createdAt: "2026-08-13T01:01:00.000Z",
                updatedAt: "2026-08-13T01:02:00.000Z",
              },
            ],
          });
        }
        if (
          url === "/api/runs/failed-run-1/actions" &&
          init?.method === "POST"
        ) {
          return json({ run: { id: "retry-run-9" } });
        }
        throw new Error(`unexpected request ${url}`);
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    renderAssistant();

    const retry = await screen.findByRole("button", { name: "重试本章" });
    fireEvent.click(retry);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/runs/failed-run-1/actions",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining('"action":"retry_chapter"'),
        }),
      ),
    );
  });

  it("发送消息时保留当前稿件、章节和选区上下文", async () => {
    const messageBodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/projects/project-1/assistant/conversations") {
        return json([CONVERSATION]);
      }
      if (url === `/api/assistant/conversations/${CONVERSATION.id}`) {
        return json(detail(false));
      }
      if (
        url === `/api/assistant/conversations/${CONVERSATION.id}/messages` &&
        init?.method === "POST"
      ) {
        messageBodies.push(
          JSON.parse(String(init.body)) as Record<string, unknown>,
        );
        if (messageBodies.length === 1) {
          return Promise.reject(new Error("response lost"));
        }
        return json({
          message: {
            id: "message-new",
            conversationId: CONVERSATION.id,
            role: "user",
            content: "这段是否泄露了伏笔？",
            context: CONTEXT,
            sourceRunId: "assistant-run-new",
            replyToMessageId: null,
            createdAt: "2026-08-13T01:04:00.000Z",
          },
          runId: "assistant-run-new",
          idempotentReplay: false,
        });
      }
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderAssistant();
    await screen.findByText("请按当前细纲写这一章。");
    fireEvent.change(screen.getByPlaceholderText("询问作品，或明确交代一项任务…"), {
      target: { value: "这段是否泄露了伏笔？" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(messageBodies).toHaveLength(1));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "发送消息" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(messageBodies).toHaveLength(2));
    expect(messageBodies[0]).toMatchObject({
      content: "这段是否泄露了伏笔？",
      context: CONTEXT,
    });
    expect(messageBodies[1]?.requestId).toBe(messageBodies[0]?.requestId);
  });

  it("允许把后续消息切换为项目全局上下文", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/projects/project-1/assistant/conversations") {
        return json([CONVERSATION]);
      }
      if (url === `/api/assistant/conversations/${CONVERSATION.id}`) {
        return json(detail(false));
      }
      if (
        url === `/api/assistant/conversations/${CONVERSATION.id}/messages` &&
        init?.method === "POST"
      ) {
        return json({
          message: {
            id: "message-project",
            conversationId: CONVERSATION.id,
            role: "user",
            content: "只看整个项目。",
            context: PROJECT_CONTEXT,
            sourceRunId: "assistant-run-project",
            replyToMessageId: null,
            createdAt: "2026-08-13T01:05:00.000Z",
          },
          runId: "assistant-run-project",
          idempotentReplay: false,
        });
      }
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderAssistant();
    await screen.findByText("请按当前细纲写这一章。");
    fireEvent.click(screen.getByRole("button", { name: "仅看项目" }));
    expect(screen.getByText("项目全局")).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("询问作品，或明确交代一项任务…"), {
      target: { value: "只看整个项目。" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url) ===
            `/api/assistant/conversations/${CONVERSATION.id}/messages` &&
          (init as RequestInit | undefined)?.method === "POST",
      );
      expect(call).toBeDefined();
      expect(JSON.parse((call![1] as RequestInit).body as string)).toMatchObject({
        content: "只看整个项目。",
        context: PROJECT_CONTEXT,
      });
    });
  });

  it("Enter 发送，Ctrl+Enter 保留为换行", async () => {
    const messageBodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/projects/project-1/assistant/conversations") return json([CONVERSATION]);
      if (url === `/api/assistant/conversations/${CONVERSATION.id}`) return json(detail(false));
      if (url === `/api/assistant/conversations/${CONVERSATION.id}/messages` && init?.method === "POST") {
        messageBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return json({ message: { id: "message-enter", conversationId: CONVERSATION.id, role: "user", content: "继续写", context: CONTEXT, sourceRunId: "assistant-run-enter", replyToMessageId: null, createdAt: "2026-08-13T01:06:00.000Z" }, runId: "assistant-run-enter", idempotentReplay: false });
      }
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderAssistant();
    await screen.findByText("请按当前细纲写这一章。");
    const composer = screen.getByPlaceholderText("询问作品，或明确交代一项任务…");
    fireEvent.change(composer, { target: { value: "继续写" } });
    fireEvent.keyDown(composer, { key: "Enter", ctrlKey: true });
    expect(messageBodies).toHaveLength(0);
    fireEvent.keyDown(composer, { key: "Enter" });
    await waitFor(() => expect(messageBodies).toHaveLength(1));
  });
});

const PROJECT_CONTEXT = {
  surface: "project",
  documentId: null,
  outlineNodeId: null,
  canonSpread: null,
  selection: null,
} as const;

function detail(confirmed: boolean) {
  return {
    conversation: CONVERSATION,
    messages: [
      {
        id: "message-user-1",
        conversationId: CONVERSATION.id,
        role: "user",
        content: "请按当前细纲写这一章。",
        context: CONTEXT,
        sourceRunId: "assistant-run-1",
        replyToMessageId: null,
        createdAt: "2026-08-13T01:01:00.000Z",
      },
      {
        id: "message-assistant-1",
        conversationId: CONVERSATION.id,
        role: "assistant",
        content: "我可以生成候选正文，确认后才会开工。",
        context: CONTEXT,
        sourceRunId: "assistant-run-1",
        replyToMessageId: "message-user-1",
        createdAt: "2026-08-13T01:02:00.000Z",
      },
    ],
    activities: [
      {
        id: "run:assistant-run-1",
        conversationId: CONVERSATION.id,
        kind: "assistant_response",
        layer: "assistant",
        status: "completed",
        goal: "理解你的请求",
        stage: "已完成",
        summary: "任务已经完成",
        waitingReason: null,
        availableActions: [],
        sourceType: "run",
        sourceId: "assistant-run-1",
        origin: CONTEXT,
        result: {},
        toolCall: null,
        createdAt: "2026-08-13T01:01:00.000Z",
        updatedAt: "2026-08-13T01:02:00.000Z",
      },
      {
        id: "assistant_tool:proposal-1",
        conversationId: CONVERSATION.id,
        kind: "tool",
        layer: "local",
        status: confirmed ? "completed" : "proposed",
        goal: "生成指定章节的候选正文",
        stage: confirmed ? "已交给现有任务链路" : "等待你确认",
        summary: confirmed ? "已创建并关联任务" : null,
        waitingReason: null,
        availableActions: confirmed ? [] : ["confirm", "reject"],
        sourceType: confirmed ? "run" : "assistant_tool",
        sourceId: confirmed ? "chapter-run-1" : "proposal-1",
        origin: CONTEXT,
        result: confirmed ? { recipe: "chapter-production" } : null,
        toolCall: {
          name: "chapter.start",
          arguments: { targetOutlineNodeId: "chapter-1" },
        },
        createdAt: "2026-08-13T01:02:00.000Z",
        updatedAt: confirmed
          ? "2026-08-13T01:03:00.000Z"
          : "2026-08-13T01:02:00.000Z",
      },
    ],
    tools: [],
  };
}
