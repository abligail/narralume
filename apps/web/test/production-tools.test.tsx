// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "../src/i18n";
import { ImportManager } from "../src/workspaces/delivery/production-tools";

function json(value: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

function renderImportManager() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ImportManager projectId="p-1" />
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

describe("导入管理", () => {
  it.each(["applied", "discarded"])(
    "%s 批次只允许刷新，不能再修改候选或重新执行",
    async (status) => {
      const detail = {
        batch: {
          id: "batch-1",
          targetProjectId: "p-1",
          filename: "旧稿.md",
          format: "markdown",
          sourceHash: "source-hash",
          sourceCharacters: 12,
          status,
          metadata: {},
          analysisRunId: null,
          appliedProjectId: status === "applied" ? "p-1" : null,
          createdAt: "2026-08-14T10:00:00.000Z",
          updatedAt: "2026-08-14T10:00:00.000Z",
        },
        candidates: [
          {
            id: "candidate-1",
            batchId: "batch-1",
            kind: "intent",
            ordinal: 0,
            title: "创作方向",
            payload: {},
            status: "pending",
            createdAt: "2026-08-14T10:00:00.000Z",
            updatedAt: "2026-08-14T10:00:00.000Z",
          },
        ],
      };
      const fetchMock = vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/projects/p-1/imports") return json([]);
        if (url === "/api/imports/preview") return json(detail, 201);
        if (url === "/api/imports/batch-1") return json(detail);
        throw new Error(`unexpected request ${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);
      const view = renderImportManager();
      const fileInput = view.container.querySelector<HTMLInputElement>(
        'input[type="file"]',
      )!;
      fireEvent.change(fileInput, {
        target: { files: [new File(["# 旧稿"], "旧稿.md")] },
      });

      await screen.findByText("旧稿.md");
      expect(screen.getByRole("checkbox")).toBeDisabled();
      expect(screen.getByRole("button", { name: "AI 分析" })).toBeDisabled();
      expect(screen.getByRole("button", { name: /应用 1 项/ })).toBeDisabled();
      expect(screen.getByRole("button", { name: "丢弃批次" })).toBeDisabled();
      await vi.waitFor(() =>
        expect(
          screen.getByRole("button", { name: "从服务端刷新" }),
        ).toBeEnabled(),
      );
    },
  );

  it("刷新后恢复历史批次，并持续轮询正在分析的批次", async () => {
    vi.useFakeTimers();
    const analyzing = {
      batch: {
        id: "batch-history",
        targetProjectId: "p-1",
        filename: "长篇旧稿.md",
        format: "markdown",
        sourceHash: "history-hash",
        sourceCharacters: 120_000,
        status: "analyzing",
        metadata: {},
        analysisRunId: "run-import",
        appliedProjectId: null,
        createdAt: "2026-08-14T10:00:00.000Z",
        updatedAt: "2026-08-14T10:00:00.000Z",
      },
      candidates: [],
    } as const;
    const ready = {
      ...analyzing,
      batch: { ...analyzing.batch, status: "ready" as const },
      candidates: [
        {
          id: "candidate-history",
          batchId: "batch-history",
          kind: "outline",
          ordinal: 0,
          title: "第一卷大纲",
          payload: {},
          status: "pending",
          createdAt: "2026-08-14T10:00:00.000Z",
          updatedAt: "2026-08-14T10:00:00.000Z",
        },
      ],
    };
    let detailReads = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects/p-1/imports") return json([analyzing.batch]);
      if (url === "/api/imports/batch-history") {
        detailReads += 1;
        return json(detailReads === 1 ? analyzing : ready);
      }
      throw new Error(`unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderImportManager();

    await vi.waitFor(() => {
      expect(screen.queryByText("长篇旧稿.md")).not.toBeNull();
      expect(screen.queryByText("analyzing")).not.toBeNull();
    });
    await vi.advanceTimersByTimeAsync(1_600);
    await vi.waitFor(() => expect(screen.queryByText("第一卷大纲")).not.toBeNull());
    expect(detailReads).toBeGreaterThanOrEqual(2);
  });
});
