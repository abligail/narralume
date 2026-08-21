import { beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "../src/i18n";
import { createRelayFetch } from "../src/kernel/relay-fetch";

beforeEach(() => {
  setLocale("zh-CN");
});

describe("在线体验 Relay fetch", () => {
  it("只为 Relay 携带 Cookie 并移除哑 Authorization", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    const relayFetch = createRelayFetch("https://relay.example", fetcher);

    await relayFetch("https://relay.example/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: "Bearer relay:demo",
        "content-type": "application/json",
      },
    });

    const init = fetcher.mock.calls[0]?.[1];
    expect(init?.credentials).toBe("include");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("不改变其他模型端点的请求", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    const relayFetch = createRelayFetch("https://relay.example", fetcher);
    const init: RequestInit = {
      headers: { authorization: "Bearer user-key" },
    };

    await relayFetch("https://provider.example/v1/chat/completions", init);

    expect(fetcher).toHaveBeenCalledWith(
      "https://provider.example/v1/chat/completions",
      init,
    );
  });
});
