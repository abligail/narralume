// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { followSystemTheme, useTheme } from "../src/app/theme";
import { setLocale } from "../src/i18n";

beforeEach(() => setLocale("zh-CN"));

function stubThemeMedia(matches = false) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const media = {
    matches,
    addEventListener: vi.fn(
      (_type: string, listener: (event: MediaQueryListEvent) => void) =>
        listeners.add(listener),
    ),
    removeEventListener: vi.fn(
      (_type: string, listener: (event: MediaQueryListEvent) => void) =>
        listeners.delete(listener),
    ),
  };
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => media as unknown as MediaQueryList),
  );
  return { listeners, media };
}

describe("system theme", () => {
  afterEach(() => {
    delete document.documentElement.dataset.theme;
    window.localStorage.clear();
    useTheme.setState({ preference: "system", theme: "light" });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("follows the initial system preference and later changes", () => {
    const { listeners } = stubThemeMedia();

    const stop = followSystemTheme();
    expect(document.documentElement.dataset.theme).toBe("light");

    for (const listener of listeners) {
      listener({ matches: true } as MediaQueryListEvent);
    }
    expect(document.documentElement.dataset.theme).toBe("dark");

    stop();
    expect(listeners).toHaveLength(0);
  });

  it("toggles to the opposite theme and then restores system following", () => {
    const { listeners } = stubThemeMedia();
    const stop = followSystemTheme();

    useTheme.getState().toggleTheme();
    expect(useTheme.getState()).toMatchObject({
      preference: "dark",
      theme: "dark",
    });
    expect(document.documentElement.dataset.theme).toBe("dark");

    for (const listener of listeners) {
      listener({ matches: false } as MediaQueryListEvent);
    }
    expect(document.documentElement.dataset.theme).toBe("dark");

    useTheme.getState().toggleTheme();
    expect(useTheme.getState()).toMatchObject({
      preference: "system",
      theme: "light",
    });
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(window.localStorage.length).toBe(0);

    stop();
  });
});
