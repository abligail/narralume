// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "../src/i18n";
import { SettingsWorkspace } from "../src/workspaces/settings";

const PROVIDERS = [
  {
    id: "env-deepseek",
    name: "环境 · DeepSeek",
    wireApi: "openai-chat",
    baseUrl: "https://api.example.com/v1",
    endpoint: null,
    credentialRef: "env:DEEPSEEK_API_KEY",
    anthropicVersion: null,
    headers: {},
    queryParams: {},
    requestStartTimeoutMs: null,
    streamIdleTimeoutMs: null,
    enabled: true,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
  },
];

const MODELS = [
  {
    id: "m-1",
    providerId: "env-deepseek",
    modelId: "deepseek-chat",
    taskType: "writing",
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    sampling: {},
    capabilities: [],
    enabled: true,
    metadataSource: "environment",
    metadataVerifiedAt: null,
    metadataStale: false,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
  },
  {
    id: "m-2",
    providerId: "env-deepseek",
    modelId: "deepseek-reasoner",
    taskType: "planning",
    contextWindow: null,
    maxOutputTokens: null,
    sampling: {},
    capabilities: [],
    enabled: true,
    metadataSource: "manual",
    metadataVerifiedAt: "2026-08-10T10:00:00.000Z",
    metadataStale: true,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
  },
];

const PROJECTS = [
  {
    id: "p-1",
    title: "潮汐灯塔",
    subtitle: null,
    premise: null,
    language: "zh-CN",
    phase: "writing",
    archivedAt: null,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
  },
];

const BACKUPS = [
  {
    id: "b-1",
    label: "定期整备",
    databaseFile: "narralume.sqlite",
    createdAt: "2026-08-01T10:00:00.000Z",
    sizeBytes: 1024,
    sha256: "abc123def456",
    migration: 12,
    pageCount: 3,
    projectCount: 1,
  },
];

const ASSIGNMENTS = [
  {
    id: "assign-writing",
    role: "writing",
    modelId: "m-1",
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
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

function renderSettings() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const rendered = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/settings"]}>
        <Routes>
          <Route path="/settings" element={<SettingsWorkspace />} />
          <Route path="/shelf" element={<p>已入馆：藏书室</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { client, rendered };
}

async function openChannelManagement() {
  const title = await screen.findByText("渠道与模型管理");
  const summary = title.closest("summary");
  expect(summary).not.toBeNull();
  fireEvent.click(summary!);
  expect(summary!.closest("details")).toHaveAttribute("open");
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

describe("设置（默认生成模型与岗位继承）", () => {
  it("Provider/模型/派岗全到齐，队伍不出现反排；请求体不带 profileId / outputReserve", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/providers") return json(PROVIDERS);
      if (url === "/api/models")
        return json(MODELS);
      if (url === "/api/assignments") return json(ASSIGNMENTS);
      if (url === "/api/projects") return json(PROJECTS);
      if (url === "/api/system/backups") return json(BACKUPS);
      if (url === "/api/assignments/writing" && init?.method === "PUT") {
        const body = JSON.parse(String(init.body));
        return json({ ...ASSIGNMENTS[0], modelId: body.modelId });
      }
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSettings();

    const defaultRole = await screen.findByRole("group", { name: "默认生成模型" });
    const channelManagement = screen.getByText("渠道与模型管理");
    expect(channelManagement.closest("details")).not.toHaveAttribute("open");

    expect(within(defaultRole).getByText("环境 · DeepSeek · deepseek-chat", { selector: ".supply__role-model strong" })).toBeInTheDocument();
    expect(within(defaultRole).getByRole("button", { name: /环境 · DeepSeek · deepseek-reasoner/ })).toBeEnabled();

    await openChannelManagement();
    // 高级管理中的渠道卡
    await screen.findByText("环境 · DeepSeek", { selector: ".supply__provider-name" });
    // 模型条
    const cards = await screen.findAllByRole("article", { name: /模型 deepseek-/ });
    expect(cards.length).toBeGreaterThan(1);
    expect(screen.getByText("128k")).toBeInTheDocument();
    expect(screen.getByText("8k")).toBeInTheDocument();
    expect(screen.getByText("规格待复核")).toBeInTheDocument();
    expect(screen.getByText(/可以正常使用，运行时会采用保守预算/)).toBeInTheDocument();

    // 岗位分配：默认生成模型已派；队伍不出现重排
    expect(screen.getAllByText("默认生成模型").length).toBeGreaterThan(0);
    expect(screen.getByText("已派")).toBeInTheDocument();
    expect(screen.queryByText("重排")).not.toBeInTheDocument();

    // 未声明物理上限的规划模型也可成为默认生成模型；生成类模型不再按岗位互斥。
    const reasonerButton = within(defaultRole).getByRole("button", { name: /deepseek-reasoner/ });
    expect(reasonerButton).toBeEnabled();
    fireEvent.click(reasonerButton);
    await screen.findByText("岗位分配已保存。");
    const assignmentCall = fetchMock.mock.calls.find(([url, init]) =>
      String(url) === "/api/assignments/writing" && init?.method === "PUT",
    );
    expect(JSON.parse(String(assignmentCall?.[1]?.body))).toEqual({ modelId: "m-2" });

    // 反断言：全列表请求都不包含禁用字段
    for (const call of fetchMock.mock.calls) {
      const bodyAsString = String(call[1]?.body ?? "");
      expect(bodyAsString).not.toContain("profileId");
      expect(bodyAsString).not.toContain("outputReserve");
    }
  });

  it("探测调 POST /api/providers/test 并渲染四阶段报告", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/providers") return json(PROVIDERS);
      if (url === "/api/models")
        return json(MODELS);
      if (url === "/api/assignments") return json(ASSIGNMENTS);
      if (url === "/api/providers/test")
        return json({
          providerId: "env-deepseek",
          modelId: "m-1",
          startedAt: "2026-08-11T10:00:00.000Z",
          finishedAt: "2026-08-11T10:00:01.400Z",
          stages: [
            { stage: "text", status: "passed", latencyMs: 320, detail: "ok" },
            { stage: "stream", status: "passed", latencyMs: 210, detail: "ok" },
            { stage: "tool", status: "unsupported", latencyMs: 0, detail: "skip" },
            {
              stage: "structured-output",
              status: "passed",
              latencyMs: 310,
              detail: "ok",
              capability: "native",
            },
          ],
        });
      if (url === "/api/projects") return json(PROJECTS);
      if (url === "/api/system/backups") return json(BACKUPS);
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSettings();

    await openChannelManagement();
    await screen.findByText("环境 · DeepSeek", { selector: ".supply__provider-name" });
    // 等模型卡落地
    await screen.findAllByRole("article", { name: /模型 deepseek-/ });

    const probeButtons = screen.getAllByRole("button", { name: /探测/ });
    fireEvent.click(probeButtons[0]!);

    await screen.findByText("探测结果");
    expect(screen.getByText("基础文本")).toBeInTheDocument();
    expect(screen.getByText("流式事件")).toBeInTheDocument();
    expect(screen.getByText("工具调用")).toBeInTheDocument();
    expect(screen.getByText("结构输出")).toBeInTheDocument();

    const call = fetchMock.mock.calls.find(([u]) =>
      String(u) === "/api/providers/test",
    );
    expect(call).toBeDefined();
    const body = JSON.parse(String(call?.[1]?.body));
    expect(body.providerId).toBe("env-deepseek");
    expect(body.modelId).toBe("m-1");
    expect(body).not.toHaveProperty("profileId");
  });

  it("编辑渠道和模型时提交当前 updatedAt（CR-48）", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/providers/env-deepseek" && init?.method === "PUT") {
        const body = JSON.parse(String(init.body));
        return json({
          ...PROVIDERS[0],
          ...body,
          updatedAt: "2026-08-11T10:00:00.000Z",
        });
      }
      if (url === "/api/models/m-1" && init?.method === "PUT") {
        const body = JSON.parse(String(init.body));
        return json({
          ...MODELS[0],
          ...body,
          updatedAt: "2026-08-11T10:00:00.000Z",
        });
      }
      if (url === "/api/providers") return json(PROVIDERS);
      if (url === "/api/models") return json(MODELS);
      if (url === "/api/assignments") return json(ASSIGNMENTS);
      if (url === "/api/projects") return json(PROJECTS);
      if (url === "/api/system/backups") return json(BACKUPS);
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSettings();

    await openChannelManagement();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "编辑模型渠道 环境 · DeepSeek",
      }),
    );
    const providerForm = screen.getByText("编辑模型渠道").closest("form")!;
    fireEvent.change(within(providerForm).getByLabelText("渠道名称"), {
      target: { value: "DeepSeek 主渠道" },
    });
    fireEvent.click(within(providerForm).getByRole("button", { name: "保存" }));
    await screen.findByText(/模型渠道已保存/);

    const modelCard = await screen.findByRole("article", {
      name: "模型 deepseek-chat",
    });
    fireEvent.click(within(modelCard).getByRole("button", { name: /编辑/ }));
    const modelForm = screen.getByText("编辑模型").closest("form")!;
    fireEvent.change(within(modelForm).getByLabelText("上下文上限"), {
      target: { value: "256000" },
    });
    fireEvent.click(within(modelForm).getByRole("button", { name: "保存" }));
    await screen.findByText("模型规格已保存。");

    const providerCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url) === "/api/providers/env-deepseek" &&
        init?.method === "PUT",
    );
    expect(JSON.parse(String(providerCall?.[1]?.body))).toMatchObject({
      name: "DeepSeek 主渠道",
      expectedUpdatedAt: PROVIDERS[0]!.updatedAt,
    });
    const modelCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url) === "/api/models/m-1" && init?.method === "PUT",
    );
    expect(JSON.parse(String(modelCall?.[1]?.body))).toMatchObject({
      contextWindow: 256_000,
      expectedUpdatedAt: MODELS[0]!.updatedAt,
    });
  });

  it("岗派 PUT /api/assignments/:role 且 body 仅 { modelId }", async () => {
    let assigned = false;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/providers") return json(PROVIDERS);
      if (url === "/api/models")
        return json(MODELS);
      if (url === "/api/assignments")
        return json(
          assigned
            ? [
                {
                  id: "a-1",
                  role: "writing",
                  modelId: "m-1",
                  createdAt: "2026-08-01T10:00:00.000Z",
                  updatedAt: "2026-08-01T10:00:00.000Z",
                },
              ]
            : [],
        );
      if (url === "/api/assignments/writing") {
        assigned = true;
        return json({ id: "a-1", role: "writing", modelId: "m-1" });
      }
      if (url === "/api/projects") return json(PROJECTS);
      if (url === "/api/system/backups") return json(BACKUPS);
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSettings();

    await openChannelManagement();
    await screen.findByText("环境 · DeepSeek", { selector: ".supply__provider-name" });
    // 等待模型卡真的渲染（role 按钮存在才可选）
    await screen.findAllByRole("article", { name: /模型 deepseek-/ });
    // 在「写作」列挑一个可指派的Model（其 arised 同时包含 modelId）
    const deepseekBtns = screen.getAllByRole("button", { name: /deepseek-chat/, });
    const assignButton = deepseekBtns.find((b) =>
      b.className.includes("supply__role-assign-btn"),
    );
    expect(assignButton).toBeDefined();
    fireEvent.click(assignButton!);

    // 同步骤推 assigned 到设甲 produce
    await screen.findByText("已派", undefined, { timeout: 3_000 });
    const call = fetchMock.mock.calls.find(([u]) =>
      String(u) === "/api/assignments/writing",
    );
    expect(call).toBeDefined();
    const body = JSON.parse(String(call?.[1]?.body));
    expect(body).toEqual({ modelId: "m-1" });
    // 反断言：不带禁用字段
    for (const forbidden of ["profileId", "outputReserve", "policy"]) {
      expect(JSON.stringify(body)).not.toContain(forbidden);
    }
  });
});

/* ---- 回归：CR-43 / CR-92 / CR-100 --------------------------------------- */

const DISABLED_PROVIDER = {
  id: "prov-disabled",
  name: "已停用渠道",
  wireApi: "openai-chat",
  baseUrl: "https://api.disabled.example.com/v1",
  endpoint: null,
  credentialRef: "env:DISABLED_KEY",
  anthropicVersion: null,
  headers: {},
  queryParams: {},
  requestStartTimeoutMs: null,
  streamIdleTimeoutMs: null,
  enabled: false,
  createdAt: "2026-08-01T10:00:00.000Z",
  updatedAt: "2026-08-01T10:00:00.000Z",
};

const DISABLED_PROVIDER_MODELS = [
  {
    id: "m-disabled-chat",
    providerId: "prov-disabled",
    modelId: "disabled-chat",
    taskType: "writing",
    contextWindow: 32_000,
    maxOutputTokens: 4_096,
    sampling: {},
    capabilities: [],
    enabled: true,
    metadataSource: "manual",
    metadataVerifiedAt: null,
    metadataStale: false,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
  },
  {
    id: "m-disabled-embedding",
    providerId: "prov-disabled",
    modelId: "disabled-embedding",
    taskType: "embedding",
    contextWindow: null,
    maxOutputTokens: null,
    sampling: {},
    capabilities: [],
    enabled: true,
    metadataSource: "manual",
    metadataVerifiedAt: null,
    metadataStale: false,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
  },
];

const SECOND_PROVIDER = {
  ...PROVIDERS[0],
  id: "prov-second",
  name: "第二渠道",
  baseUrl: "https://api.second.example.com/v1",
};

const PROJECTS_TWO = [
  PROJECTS[0],
  { ...PROJECTS[0], id: "proj-b", title: "灯塔副本" },
];

function stubSettingsFetch(routes: Record<string, unknown>) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url in routes) return json(routes[url]);
    throw new Error(`unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("设置回归（CR-43 / CR-92 / CR-100）", () => {
  it("同名作品在生产资产选择器中显示稳定身份（CR-78）", async () => {
    const duplicateProjects = [
      { ...PROJECTS[0], id: "alpha-project", title: "同名作品", subtitle: "主线版" },
      { ...PROJECTS[0], id: "beta-project", title: "同名作品", subtitle: null },
    ];
    stubSettingsFetch({
      "/api/providers": PROVIDERS,
      "/api/models": MODELS,
      "/api/assignments": ASSIGNMENTS,
      "/api/projects": duplicateProjects,
      "/api/system/backups": BACKUPS,
      "/api/projects/alpha-project/styles": [],
      "/api/projects/alpha-project/writing-skills": [],
    });
    renderSettings();

    const selector = await screen.findByRole("combobox", { name: "生产资产所属项目" });
    expect(within(selector).getByRole("option", { name: "同名作品 · 主线版 · alpha-pr" })).toBeInTheDocument();
    expect(within(selector).getByRole("option", { name: "同名作品 · beta-pro" })).toBeInTheDocument();
  });

  it("模型组合查询失败时不把已有派岗误报为失效", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/providers") return json(PROVIDERS);
      if (url === "/api/models") {
        return json(
          { error: { code: "storage.unavailable", message: "models unavailable" } },
          500,
        );
      }
      if (url === "/api/assignments") return json(ASSIGNMENTS);
      if (url === "/api/projects") return json(PROJECTS);
      if (url === "/api/system/backups") return json(BACKUPS);
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSettings();

    expect(await screen.findByText("默认模型配置暂时无法加载")).toBeInTheDocument();
    expect(screen.queryByText("配置已失效")).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "默认生成模型" })).not.toBeInTheDocument();
  });

  it("项目与生产资产查询失败时显示错误并隐藏依赖写入", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/providers") return json(PROVIDERS);
      if (url === "/api/models") return json(MODELS);
      if (url === "/api/assignments") return json(ASSIGNMENTS);
      if (url === "/api/projects") {
        return json(
          { error: { code: "storage.unavailable", message: "projects unavailable" } },
          500,
        );
      }
      if (url === "/api/system/backups") return json(BACKUPS);
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSettings();

    expect(await screen.findByText("项目清单暂时无法加载")).toBeInTheDocument();
    expect(screen.queryByLabelText("生产资产所属项目")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "保存风格" })).not.toBeInTheDocument();
  });

  it("风格和 Writing Skill 查询失败时不显示空白创建表单", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/providers") return json(PROVIDERS);
      if (url === "/api/models") return json(MODELS);
      if (url === "/api/assignments") return json(ASSIGNMENTS);
      if (url === "/api/projects") return json(PROJECTS);
      if (url === "/api/system/backups") return json(BACKUPS);
      if (url === "/api/projects/p-1/styles" || url === "/api/projects/p-1/writing-skills") {
        return json(
          { error: { code: "storage.unavailable", message: "asset unavailable" } },
          500,
        );
      }
      if (url === "/api/projects/p-1/imports") return json([]);
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSettings();

    expect(await screen.findByText("风格列表暂时无法加载")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "保存风格" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Writing Skill" }));
    expect(await screen.findByText("Writing Skill 列表暂时无法加载")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "保存 Skill" })).not.toBeInTheDocument();
  });

  it("已停用渠道下的启用模型不出现在岗位候选中", async () => {
    stubSettingsFetch({
      "/api/providers": [...PROVIDERS, DISABLED_PROVIDER],
      "/api/models": [...MODELS, ...DISABLED_PROVIDER_MODELS],
      "/api/assignments": ASSIGNMENTS,
      "/api/projects": PROJECTS,
      "/api/system/backups": BACKUPS,
      "/api/projects/p-1/styles": [],
      "/api/projects/p-1/writing-skills": [],
    });
    renderSettings();

    const defaultRole = await screen.findByRole("group", { name: "默认生成模型" });
    await within(defaultRole).findByRole("button", { name: /deepseek-reasoner/ });
    expect(
      within(defaultRole).queryByRole("button", { name: /disabled-chat/ }),
    ).not.toBeInTheDocument();

    const embeddingRole = screen.getByRole("group", { name: "嵌入模型" });
    expect(
      within(embeddingRole).queryByRole("button", { name: /disabled-embedding/ }),
    ).not.toBeInTheDocument();
  });

  it("切换生产资产所属项目后风格与 Skill 表单草稿重置", async () => {
    stubSettingsFetch({
      "/api/providers": PROVIDERS,
      "/api/models": MODELS,
      "/api/assignments": ASSIGNMENTS,
      "/api/projects": PROJECTS_TWO,
      "/api/system/backups": BACKUPS,
      "/api/projects/p-1/styles": [],
      "/api/projects/proj-b/styles": [],
      "/api/projects/p-1/writing-skills": [],
      "/api/projects/proj-b/writing-skills": [],
    });
    renderSettings();

    const styleForm = (await screen.findByText("创建风格")).closest("form");
    fireEvent.change(within(styleForm!).getByLabelText("名称"), {
      target: { value: "项目A风格草稿" },
    });

    fireEvent.change(screen.getByLabelText("生产资产所属项目"), {
      target: { value: "proj-b" },
    });
    await screen.findByRole("link", { name: "运行中心 · 灯塔副本" });

    const nextStyleForm = (await screen.findAllByText("创建风格")).at(-1)!.closest("form");
    expect(within(nextStyleForm!).getByLabelText("名称")).toHaveValue("");
    fireEvent.click(screen.getByRole("tab", { name: "Writing Skill" }));
    const nextSkillForm = (await screen.findByText("创建 Writing Skill")).closest("form");
    expect(within(nextSkillForm!).getByLabelText("名称")).toHaveValue("");
  });

  it("生产资产刷新到新版本时重载表单内容，避免用新令牌覆盖旧草稿", async () => {
    let styles = [{
      id: "style-1", projectId: "p-1", name: "旧风格", description: null,
      rules: ["旧规则"], examples: [], negativeRules: [], source: "manual",
      active: true, status: "active", createdAt: "2026-08-01T10:00:00.000Z",
      updatedAt: "2026-08-01T10:00:00.000Z", version: 0,
    }];
    let skills = [{
      id: "skill-1", projectId: "p-1", name: "旧 Skill", description: null,
      instructions: "旧指令内容足够长，可以通过现有校验。", scopes: ["all"],
      priority: 0, enabled: true, source: "manual",
      createdAt: "2026-08-01T10:00:00.000Z",
      updatedAt: "2026-08-01T10:00:00.000Z", version: 0,
    }];
    stubSettingsFetch({
      "/api/providers": PROVIDERS,
      "/api/models": MODELS,
      "/api/assignments": ASSIGNMENTS,
      "/api/projects": PROJECTS,
      "/api/system/backups": BACKUPS,
      get "/api/projects/p-1/styles"() { return styles; },
      get "/api/projects/p-1/writing-skills"() { return skills; },
    });
    const { client } = renderSettings();

    fireEvent.click(await screen.findByRole("button", { name: /旧风格/ }));
    const styleForm = screen.getByText("编辑风格").closest("form")!;
    fireEvent.change(within(styleForm).getByLabelText("名称"), { target: { value: "本地旧风格草稿" } });

    styles = [{ ...styles[0]!, name: "远端新风格", rules: ["远端新规则"], version: 1, updatedAt: "2026-08-01T10:01:00.000Z" }];
    await client.invalidateQueries({ queryKey: ["project", "p-1", "styles"] });

    await waitFor(() => {
      expect(within(screen.getByText("编辑风格").closest("form")!).getByLabelText("名称")).toHaveValue("远端新风格");
    });

    fireEvent.click(screen.getByRole("tab", { name: "Writing Skill" }));
    fireEvent.click(await screen.findByRole("button", { name: /旧 Skill/ }));
    const skillForm = screen.getByText("编辑 Writing Skill").closest("form")!;
    fireEvent.change(within(skillForm).getByLabelText("名称"), { target: { value: "本地旧 Skill 草稿" } });
    skills = [{ ...skills[0]!, name: "远端新 Skill", instructions: "远端已经更新后的完整指令内容。", version: 1, updatedAt: "2026-08-01T10:01:00.000Z" }];
    await client.invalidateQueries({ queryKey: ["project", "p-1", "writing-skills"] });
    await waitFor(() => {
      expect(within(screen.getByText("编辑 Writing Skill").closest("form")!).getByLabelText("名称")).toHaveValue("远端新 Skill");
    });
  });

  it("切换编辑渠道后表单字段重置为目标渠道", async () => {
    stubSettingsFetch({
      "/api/providers": [PROVIDERS[0], SECOND_PROVIDER],
      "/api/models": MODELS,
      "/api/assignments": ASSIGNMENTS,
      "/api/projects": PROJECTS,
      "/api/system/backups": BACKUPS,
      "/api/projects/p-1/styles": [],
      "/api/projects/p-1/writing-skills": [],
    });
    renderSettings();
    await openChannelManagement();
    await screen.findByText("环境 · DeepSeek", { selector: ".supply__provider-name" });

    fireEvent.click(
      screen.getByRole("button", { name: "编辑模型渠道 环境 · DeepSeek" }),
    );
    const draftForm = (await screen.findByText("编辑模型渠道")).closest("form");
    expect(within(draftForm!).getByLabelText("渠道名称")).toHaveValue("环境 · DeepSeek");
    fireEvent.change(within(draftForm!).getByLabelText("渠道名称"), {
      target: { value: "未保存草稿名" },
    });

    fireEvent.click(
      screen.getByRole("button", { name: "编辑模型渠道 第二渠道" }),
    );
    const switchedForm = (await screen.findByText("编辑模型渠道")).closest("form");
    expect(within(switchedForm!).getByLabelText("渠道名称")).toHaveValue("第二渠道");
    expect(within(switchedForm!).getByLabelText("Base URL")).toHaveValue(
      "https://api.second.example.com/v1",
    );
  });

  it("模型编辑器随切换模型或渠道重置", async () => {
    stubSettingsFetch({
      "/api/providers": [PROVIDERS[0], SECOND_PROVIDER],
      "/api/models": MODELS,
      "/api/assignments": ASSIGNMENTS,
      "/api/projects": PROJECTS,
      "/api/system/backups": BACKUPS,
      "/api/projects/p-1/styles": [],
      "/api/projects/p-1/writing-skills": [],
    });
    renderSettings();
    await openChannelManagement();
    await screen.findByText("环境 · DeepSeek", { selector: ".supply__provider-name" });
    await screen.findAllByRole("article", { name: /模型 deepseek-/ });

    // 编辑模型 A，留下未保存草稿，再切到模型 B
    fireEvent.click(
      within(screen.getByRole("article", { name: "模型 deepseek-chat" })).getByRole("button", { name: "编辑" }),
    );
    const draftForm = (await screen.findByText("编辑模型")).closest("form");
    expect(within(draftForm!).getByLabelText("上游模型名")).toHaveValue("deepseek-chat");
    fireEvent.change(within(draftForm!).getByLabelText("上游模型名"), {
      target: { value: "草稿模型名" },
    });
    fireEvent.click(
      within(screen.getByRole("article", { name: "模型 deepseek-reasoner" })).getByRole("button", { name: "编辑" }),
    );
    const switchedForm = (await screen.findByText("编辑模型")).closest("form");
    expect(within(switchedForm!).getByLabelText("上游模型名")).toHaveValue("deepseek-reasoner");

    // 新建表单随渠道切换重置
    fireEvent.click(within(switchedForm!).getByRole("button", { name: "取消" }));
    const modelSection = screen.getByRole("region", { name: "模型" });
    fireEvent.click(within(modelSection).getByRole("button", { name: /新建/ }));
    const newForm = (await screen.findByText("新建模型")).closest("form");
    fireEvent.change(within(newForm!).getByLabelText("上游模型名"), {
      target: { value: "draft-x" },
    });
    fireEvent.click(
      screen.getByText("第二渠道", { selector: ".supply__provider-name" }).closest("button")!,
    );
    const resetForm = (await screen.findByText("新建模型")).closest("form");
    expect(within(resetForm!).getByLabelText("上游模型名")).toHaveValue("");
  });
});
