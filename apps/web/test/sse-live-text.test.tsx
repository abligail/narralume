// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "../src/i18n";
import { useRunLiveText } from "../src/lib/sse";

class EventSourceStub {
  static current: EventSourceStub | null = null;
  private readonly listeners = new Map<string, EventListener[]>();

  constructor() {
    EventSourceStub.current = this;
  }

  addEventListener(type: string, listener: EventListener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  removeEventListener() {}
  close() {}

  emit(type: string, data: unknown) {
    const event = new MessageEvent(type, { data: JSON.stringify(data) });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function Probe({ clearSignal }: { clearSignal: string | null }) {
  return <p>{useRunLiveText("run-1", clearSignal) || "empty"}</p>;
}

beforeEach(() => {
  setLocale("zh-CN");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  EventSourceStub.current = null;
});
describe("运行实时文本", () => {
  it("持久化流到达后清空同一运行的本地增量", () => {
    vi.stubGlobal("EventSource", EventSourceStub);
    const view = render(<Probe clearSignal={null} />);

    act(() => {
      EventSourceStub.current?.emit("model.event", {
        type: "model.event",
        runId: "run-1",
        event: { type: "text.delta", text: "潮声" },
      });
      EventSourceStub.current?.emit("model.event", {
        type: "model.event",
        runId: "background-run",
        event: { type: "text.delta", text: "后台正文不应进入当前页" },
      });
    });
    expect(screen.getByText("潮声")).toBeInTheDocument();

    view.rerender(<Probe clearSignal="step-1:1:2026-08-15T00:00:00.000Z" />);
    expect(screen.getByText("empty")).toBeInTheDocument();
  });
});
