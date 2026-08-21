// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { setLocale } from "../src/i18n";
import { StudioWorkspace } from "../src/workspaces/studio";

/* CR-24：正式版本变化后，编辑器必须随新的 currentVersion 重新装载正文。 */

const DOCUMENT = {
  id: "doc-1",
  projectId: "p-1",
  kind: "note",
  title: "正文稿",
  outlineNodeId: null,
  currentVersionId: "ver-2",
  createdAt: "2026-08-09T10:00:00.000Z",
  updatedAt: "2026-08-10T10:00:00.000Z",
};

const VERSIONS = [
  {
    id: "ver-1",
    documentId: "doc-1",
    parentVersionId: null,
    content: "VERSION-ONE",
    contentHash: "hash-1",
    source: "manual",
    runId: null,
    createdAt: "2026-08-09T10:00:00.000Z",
  },
  {
    id: "ver-2",
    documentId: "doc-1",
    parentVersionId: "ver-1",
    content: "VERSION-TWO",
    contentHash: "hash-2",
    source: "manual",
    runId: null,
    createdAt: "2026-08-10T10:00:00.000Z",
  },
];

let detail = buildDetail(VERSIONS[1]!);

function buildDetail(currentVersion: (typeof VERSIONS)[number], versions = VERSIONS) {
  return {
    document: { ...DOCUMENT, currentVersionId: currentVersion.id },
    currentVersion,
    draft: null,
    versions,
    comments: [],
    proposals: [],
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
  detail = buildDetail(VERSIONS[1]!);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("恢复历史版本后编辑器正文随新 currentVersion 重新装载（CR-24）", async () => {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/projects/p-1/studio/documents") return json([DOCUMENT]);
    if (url === "/api/projects/p-1/studio/documents/doc-1") return json(detail);
    if (url === "/api/projects/p-1/reviews")
      return json({ reports: [], proposals: [] });
    if (url === "/api/projects/p-1/canon-change-sets")
      return json({ changeSets: [] });
    if (
      url === "/api/projects/p-1/documents/doc-1/restore" &&
      init?.method === "POST"
    ) {
      const restored = {
        id: "ver-3",
        documentId: "doc-1",
        parentVersionId: "ver-2",
        content: "VERSION-ONE",
        contentHash: "hash-3",
        source: "restore:ver-1",
        runId: null,
        createdAt: "2026-08-11T10:00:00.000Z",
      };
      detail = buildDetail(restored, [restored, ...VERSIONS]);
      return json(restored, 201);
    }
    throw new Error(`unexpected request ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/projects/p-1/studio"]}>
        <Routes>
          <Route path="/projects/:projectId/studio" element={<StudioWorkspace />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

  const editor = await screen.findByLabelText<HTMLTextAreaElement>(
    "Markdown 正文编辑器",
  );
  await waitFor(() => expect(editor.value).toBe("VERSION-TWO"));
  expect(screen.getByText("草稿已同步")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("tab", { name: /版本/ }));
  fireEvent.click(screen.getByRole("button", { name: /恢复/ }));
  fireEvent.click(screen.getByRole("button", { name: "恢复为新版本" }));

  await waitFor(() => expect(editor.value).toBe("VERSION-ONE"));
  await waitFor(() =>
    expect(screen.getByText("草稿已同步")).toBeInTheDocument(),
  );
});
