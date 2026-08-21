// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NaviLink, RepositoryLink } from "../src/app/shell";
import { WORKSPACES, workspaceByPath } from "../src/app/workspaces";
import { setLocale } from "../src/i18n";

afterEach(cleanup);
beforeEach(() => setLocale("zh-CN"));

describe("项目导航", () => {
  const shelf = WORKSPACES.find((item) => item.id === "shelf")!;
  const studio = WORKSPACES.find((item) => item.id === "studio")!;

  it("未选择作品时进入目标工作区的空状态", () => {
    const view = render(<MemoryRouter>{NaviLink(studio, null, shelf, "/shelf")}</MemoryRouter>);
    expect(view.getByRole("link", { name: "前往写作" })).toHaveAttribute("href", "/studio");
    expect(workspaceByPath("/studio")).toBe(studio);
  });

  it("选择作品后生成真实工作区链接", () => {
    const view = render(<MemoryRouter>{NaviLink(studio, "project-1", shelf, "/shelf")}</MemoryRouter>);
    expect(view.getByRole("link", { name: "前往写作" })).toHaveAttribute("href", "/projects/project-1/studio");
  });
});

describe("源码入口", () => {
  it("指向公开仓库并在新窗口打开", () => {
    const view = render(<RepositoryLink />);
    const link = view.getByRole("link", { name: "在 GitHub 查看源代码" });

    expect(link).toHaveAttribute("href", "https://github.com/abligail/narralume");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");
  });
});
