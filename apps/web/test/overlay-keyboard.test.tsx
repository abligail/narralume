// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter } from "react-router";
import { beforeEach, expect, it, vi } from "vitest";

import { CommandPalette } from "../src/app/command-palette";
import { ConfirmDialog } from "../src/components/confirm-dialog";
import { setLocale } from "../src/i18n";

beforeEach(() => setLocale("zh-CN"));

function Harness() {
  const [open, setOpen] = useState(false);
  return <><button type="button" onClick={() => setOpen(true)}>删除</button>{open ? <ConfirmDialog title="确认删除" confirmLabel="确认" onCancel={() => setOpen(false)} onConfirm={() => setOpen(false)}><p>确认这次操作。</p></ConfirmDialog> : null}</>;
}

it("对话框按 Esc 关闭后恢复触发点焦点（CR-107）", () => {
  render(<Harness />);
  const trigger = screen.getByRole("button", { name: "删除" });
  trigger.focus();
  fireEvent.click(trigger);
  const dialog = screen.getByRole("alertdialog", { name: "确认删除" });
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

it("命令面板用 combobox 关联活动选项", () => {
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  render(
    <MemoryRouter>
      <CommandPalette projectId="p-1" onClose={vi.fn()} />
    </MemoryRouter>,
  );
  const input = screen.getByRole("combobox", { name: "搜索命令" });
  const listbox = screen.getByRole("listbox");
  expect(input).toHaveAttribute("aria-controls", listbox.id);
  expect(input).toHaveAttribute("aria-expanded", "true");
  const initial = input.getAttribute("aria-activedescendant");
  expect(initial).toBeTruthy();
  expect(document.getElementById(initial!)).toHaveAttribute("role", "option");
  fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(input.getAttribute("aria-activedescendant")).not.toBe(initial);
});
