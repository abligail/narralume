import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "../src/i18n";

beforeEach(() => {
  setLocale("zh-CN");
});

class FakeWorker {
  static instances: FakeWorker[] = [];
  terminated = false;
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  readonly posted: unknown[] = [];

  constructor() {
    FakeWorker.instances.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  postMessage(frame: unknown) {
    this.posted.push(frame);
  }

  terminate() {
    this.terminated = true;
  }

  emit(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

describe("kernel client worker lifecycle", () => {
  afterEach(() => {
    FakeWorker.instances = [];
    vi.unstubAllGlobals();
  });

  it("rejects pending requests and rebuilds the singleton after a ready worker crashes", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const { kernelRequest } = await import("../src/kernel/kernel-client");

    const first = kernelRequest({ method: "GET", path: "/api/health" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const firstWorker = FakeWorker.instances[0]!;
    firstWorker.emit("message", { data: { type: "ready" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(firstWorker.posted).toHaveLength(1);

    firstWorker.emit("error", { message: "worker crashed" });
    expect(firstWorker.terminated).toBe(true);
    await expect(first).rejects.toThrow("worker crashed");

    const second = kernelRequest({ method: "GET", path: "/api/health" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const secondWorker = FakeWorker.instances[1]!;
    expect(secondWorker).not.toBe(firstWorker);
    secondWorker.emit("message", { data: { type: "ready" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const request = secondWorker.posted[0] as { id: string };
    secondWorker.emit("message", {
      data: {
        type: "response",
        id: request.id,
        ok: true,
        status: 200,
        headers: {},
        body: { status: "ok" },
      },
    });
    await expect(second).resolves.toMatchObject({
      status: 200,
      body: { status: "ok" },
    });
  });
});
