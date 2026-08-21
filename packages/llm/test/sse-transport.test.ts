import { describe, expect, it, vi } from "vitest";

import {
  ModelError,
  OpenAIChatAdapter,
  ModelGateway,
  parseSseStream,
  resolveEndpoint,
  scrubSecrets,
} from "../src/index.js";
import type { ModelEvent } from "../src/index.js";
import { frame, jsonResponse, sseResponse } from "./helpers.js";

describe("SSE parser", () => {
  it("handles CRLF, comments, multiline data, UTF-8 split across bytes, and EOF dispatch", async () => {
    const source =
      ': keepalive\r\nevent: sample\r\nid: 7\r\ndata: {"text":"灯"}\r\n\r\ndata: first\ndata: second';
    const bytes = new TextEncoder().encode(source);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    });

    const frames = [];
    for await (const parsed of parseSseStream(stream)) frames.push(parsed);
    expect(frames).toEqual([
      { event: "sample", id: "7", data: '{"text":"灯"}' },
      { data: "first\nsecond" },
    ]);
  });

  it("rejects an oversized SSE frame before buffering it", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(`data: ${"x".repeat(8 * 1024 * 1024)}\n`),
        );
        controller.close();
      },
    });
    const error = await (async () => {
      try {
        for await (const frame of parseSseStream(stream)) {
          // The parser must reject before yielding a frame.
          void frame;
        }
        return null;
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toMatchObject({
      code: "model.response_too_large",
      category: "protocol",
      retryable: false,
    });
  });

  it("accepts more than 10,000 small events within the byte limits", async () => {
    const eventCount = 10_250;
    const payload = Array.from(
      { length: eventCount },
      (_, index) => `data: ${index}\n\n`,
    ).join("");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payload));
        controller.close();
      },
    });

    let parsed = 0;
    for await (const frame of parseSseStream(stream)) {
      expect(frame.data).toBe(String(parsed));
      parsed += 1;
    }
    expect(parsed).toBe(eventCount);
  });
});

describe("endpoint and transport safety", () => {
  it("normalizes root, version root, and complete endpoints without duplicating v1", () => {
    expect(
      resolveEndpoint("https://api.example.com", undefined, "responses"),
    ).toBe("https://api.example.com/v1/responses");
    expect(
      resolveEndpoint("https://api.example.com/v1", undefined, "responses"),
    ).toBe("https://api.example.com/v1/responses");
    expect(
      resolveEndpoint(
        "https://api.example.com/v1/responses",
        undefined,
        "responses",
      ),
    ).toBe("https://api.example.com/v1/responses");
    expect(() =>
      resolveEndpoint("ftp://api.example.com", undefined, "responses"),
    ).toThrow(ModelError);
    expect(() =>
      resolveEndpoint("https://key@api.example.com", undefined, "responses"),
    ).toThrow("without embedded credentials");
  });

  it("merges provider query parameters into inferred and explicit endpoints", () => {
    expect(
      resolveEndpoint(
        "https://api.example.com/v1?existing=base",
        undefined,
        "responses",
        { "api-version": "2026-01-01", region: "cn" },
      ),
    ).toBe(
      "https://api.example.com/v1/responses?api-version=2026-01-01&region=cn",
    );
    expect(
      resolveEndpoint(
        "https://api.example.com/root",
        "custom?existing=1",
        "responses",
        { existing: "overridden", region: "cn" },
      ),
    ).toBe("https://api.example.com/root/custom?existing=overridden&region=cn");
    expect(() =>
      resolveEndpoint(
        "https://api.example.com/v1",
        "https://collector.invalid/steal",
        "responses",
      ),
    ).toThrow("under the base URL origin");
  });

  it("scrubs common credential shapes", () => {
    expect(
      scrubSecrets("authorization: Bearer-secret api_key=sk-1234567890abcdef"),
    ).not.toContain("1234567890abcdef");
  });

  it("retries a rate limit response and returns the successful attempt", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ error: { message: "slow down" } }, 429, {
          "retry-after": "0",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: "chat-1",
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    const gateway = new ModelGateway(
      new OpenAIChatAdapter({
        protocol: "openai-chat",
        baseUrl: "https://api.example.com/v1",
        apiKey: "test-key",
        fetch,
        maxRetries: 1,
        retryBaseDelayMs: 0,
      }),
    );

    await expect(
      gateway.generate({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).resolves.toMatchObject({ text: "ok" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("normalizes and scrubs provider HTTP errors", async () => {
    const gateway = new ModelGateway(
      new OpenAIChatAdapter({
        protocol: "openai-chat",
        baseUrl: "https://api.example.com/v1",
        apiKey: "test-key",
        fetch: async () =>
          jsonResponse(
            { error: { message: "bad api_key=sk-1234567890abcdef" } },
            401,
          ),
        maxRetries: 0,
      }),
    );

    const error = await gateway
      .generate({ model: "m", messages: [{ role: "user", content: "hi" }] })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ModelError);
    expect(error).toMatchObject({
      category: "authentication",
      retryable: false,
      status: 401,
    });
    expect((error as Error).message).not.toContain("1234567890abcdef");
  });

  it.each([
    [403, "forbidden", "permission", false],
    [404, "model missing", "model_not_found", false],
    [408, "request timeout", "timeout", true],
    [409, "conflict", "timeout", true],
    [500, "upstream failed", "server", true],
    [400, "maximum context length exceeded", "context_length", false],
    [400, "blocked by content filter safety policy", "content_filter", false],
  ] as const)(
    "maps HTTP %s into %s semantics",
    async (status, message, category, retryable) => {
      const gateway = new ModelGateway(
        new OpenAIChatAdapter({
          protocol: "openai-chat",
          baseUrl: "https://api.example.com/v1",
          apiKey: "test-key",
          fetch: async () => jsonResponse({ error: { message } }, status),
          maxRetries: 0,
        }),
      );
      const error = await gateway
        .generate({ model: "m", messages: [{ role: "user", content: "hi" }] })
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({ category, retryable, status });
    },
  );

  it("cancels the upstream request through AbortSignal", async () => {
    const fetch = vi.fn(
      async (
        _input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    const gateway = new ModelGateway(
      new OpenAIChatAdapter({
        protocol: "openai-chat",
        baseUrl: "https://api.example.com/v1",
        apiKey: "test-key",
        fetch,
        maxRetries: 0,
      }),
    );
    const controller = new AbortController();
    const pending = gateway.generate(
      { model: "m", messages: [{ role: "user", content: "hi" }] },
      { signal: controller.signal },
    );
    controller.abort();
    const error = await pending.catch((caught: unknown) => caught);
    expect(error).toMatchObject({ category: "cancelled", retryable: false });
  });

  it("preserves partial text when an SSE stream is interrupted", async () => {
    const event = new TextEncoder().encode(
      'data: {"id":"chat-partial","choices":[{"delta":{"content":"灯"},"finish_reason":null}]}\n\n',
    );
    let pullCount = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pullCount === 0) controller.enqueue(event);
        else controller.error(new Error("socket reset"));
        pullCount += 1;
      },
    });
    const gateway = new ModelGateway(
      new OpenAIChatAdapter({
        protocol: "openai-chat",
        baseUrl: "https://api.example.com/v1",
        apiKey: "test-key",
        fetch: async () =>
          new Response(body, {
            headers: { "content-type": "text/event-stream" },
          }),
        maxRetries: 0,
      }),
    );
    const error = await gateway
      .generate(
        { model: "m", messages: [{ role: "user", content: "hi" }] },
        { stream: true },
      )
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      category: "stream_interrupted",
      partialText: "灯",
    });
  });

  it("rejects an empty successful response as a protocol error", async () => {
    const gateway = new ModelGateway(
      new OpenAIChatAdapter({
        protocol: "openai-chat",
        baseUrl: "https://api.example.com/v1",
        apiKey: "test-key",
        fetch: async () =>
          new Response("", { headers: { "content-type": "application/json" } }),
        maxRetries: 0,
      }),
    );
    const error = await gateway
      .generate({ model: "m", messages: [{ role: "user", content: "hi" }] })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ category: "protocol" });
  });

  it("rejects an oversized non-streaming response before JSON parsing", async () => {
    const gateway = new ModelGateway(
      new OpenAIChatAdapter({
        protocol: "openai-chat",
        baseUrl: "https://api.example.com/v1",
        apiKey: "test-key",
        fetch: async () =>
          new Response(
            JSON.stringify({ content: "x".repeat(8 * 1024 * 1024) }),
            {
              headers: { "content-type": "application/json" },
            },
          ),
        maxRetries: 0,
      }),
    );
    const error = await gateway
      .generate({ model: "m", messages: [{ role: "user", content: "hi" }] })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "model.response_too_large",
      category: "protocol",
      retryable: false,
    });
  });
});

describe("M3 transport retry defaults, timeouts, and timing", () => {
  const chatRequest = {
    model: "m",
    messages: [{ role: "user" as const, content: "hi" }],
  };

  function chatGateway(
    fetch: (...args: never[]) => Promise<Response>,
    config: Record<string, unknown> = {},
  ): ModelGateway {
    return new ModelGateway(
      new OpenAIChatAdapter({
        protocol: "openai-chat",
        baseUrl: "https://api.example.com/v1",
        apiKey: "test-key",
        fetch,
        ...config,
      }),
    );
  }

  it("does not retry by default: a 500 is thrown after one attempt", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({ error: { message: "upstream failed" } }, 500),
    );
    const gateway = chatGateway(fetch);

    const error = await gateway
      .generate(chatRequest)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ModelError);
    expect(error).toMatchObject({
      category: "server",
      retryable: true,
      status: 500,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("still retries when maxRetries is passed explicitly", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ error: { message: "upstream failed" } }, 500),
      )
      .mockResolvedValueOnce(
        jsonResponse({ error: { message: "still broken" } }, 500),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: "chat-1",
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    const onRequestAttempt = vi.fn();
    const gateway = chatGateway(fetch, {
      maxRetries: 2,
      retryBaseDelayMs: 0,
      onRequestAttempt,
    });

    await expect(gateway.generate(chatRequest)).resolves.toMatchObject({
      text: "ok",
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(onRequestAttempt.mock.calls).toEqual([[1], [2], [3]]);
  });

  it("aborts with request_start_timeout when headers never arrive", async () => {
    const fetch = vi.fn(
      () => new Promise<Response>(() => {}), // never settles
    );
    const gateway = chatGateway(fetch, { requestStartTimeoutMs: 30 });

    const error = await gateway
      .generate(chatRequest)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ModelError);
    expect(error).toMatchObject({
      category: "timeout",
      code: "request_start_timeout",
      retryable: true,
    });
    const timing = (error as ModelError).timing;
    expect(timing?.dispatchedAt).toEqual(expect.any(Number));
    expect(timing?.headersAt).toBeUndefined();
    expect(timing?.totalDurationMs).toEqual(expect.any(Number));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retries a request_start_timeout when retries remain", async () => {
    const fetch = vi
      .fn()
      .mockImplementationOnce(() => new Promise<Response>(() => {}))
      .mockResolvedValueOnce(
        jsonResponse({
          id: "chat-1",
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    const gateway = chatGateway(fetch, {
      requestStartTimeoutMs: 30,
      maxRetries: 1,
      retryBaseDelayMs: 0,
    });

    await expect(gateway.generate(chatRequest)).resolves.toMatchObject({
      text: "ok",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("aborts a stalled stream with stream_idle_timeout and keeps partial text", async () => {
    const first = new TextEncoder().encode(
      frame({
        id: "chat-partial",
        choices: [{ delta: { content: "灯" }, finish_reason: null }],
      }),
    );
    const fetch = vi.fn(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(first);
          // Never enqueues again: the stream stalls mid-flight.
        },
      });
      return new Response(body, {
        headers: {
          "content-type": "text/event-stream",
          "x-request-id": "req-idle",
        },
      });
    });
    const gateway = chatGateway(fetch, { streamIdleTimeoutMs: 30 });

    const error = await gateway
      .generate(chatRequest, { stream: true })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ModelError);
    expect(error).toMatchObject({
      category: "timeout",
      code: "stream_idle_timeout",
      retryable: true,
      partialText: "灯",
      requestId: "req-idle",
    });
    const timing = (error as ModelError).timing;
    expect(timing?.headersAt).toEqual(expect.any(Number));
    expect(timing?.firstEventAt).toEqual(expect.any(Number));
    expect(timing?.totalDurationMs).toEqual(expect.any(Number));
  });

  it("carries timing segments and request id on started/completed events", async () => {
    const fetch = vi.fn(async () => {
      const response = sseResponse([
        frame({
          id: "chat-1",
          choices: [{ delta: { content: "灯" }, finish_reason: null }],
        }),
        frame({
          id: "chat-1",
          choices: [{ delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      ]);
      return new Response(response.body, {
        headers: {
          "content-type": "text/event-stream",
          "x-request-id": "req-stream",
        },
      });
    });
    const gateway = chatGateway(fetch);

    const events: ModelEvent[] = [];
    for await (const event of gateway.stream(chatRequest, { stream: true })) {
      events.push(event);
    }

    const started = events.find((event) => event.type === "response.started");
    expect(started).toMatchObject({
      responseId: "chat-1",
      timeToHeadersMs: expect.any(Number),
      timeToFirstTokenMs: expect.any(Number),
    });
    const completed = events.find(
      (event) => event.type === "response.completed",
    );
    expect(completed).toMatchObject({
      finishReason: "stop",
      requestId: "req-stream",
    });
    const timing =
      completed?.type === "response.completed" ? completed.timing : undefined;
    expect(timing).toBeDefined();
    expect(timing?.dispatchedAt).toEqual(expect.any(Number));
    expect(timing?.headersAt).toEqual(expect.any(Number));
    expect(timing?.firstEventAt).toEqual(expect.any(Number));
    expect(timing?.lastEventAt).toEqual(expect.any(Number));
    expect(timing?.finishedAt).toEqual(expect.any(Number));
    expect(timing?.streamActiveMs).toEqual(expect.any(Number));
    expect(timing?.totalDurationMs).toEqual(expect.any(Number));
  });

  it("passes timing and request id through collectModelEvents", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse(
        {
          id: "chat-1",
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
        200,
        { "x-request-id": "req-json" },
      ),
    );
    const gateway = chatGateway(fetch);

    const response = await gateway.generate(chatRequest);
    expect(response.requestId).toBe("req-json");
    expect(response.timing?.timeToHeadersMs).toEqual(expect.any(Number));
    expect(response.timing?.timeToFirstTokenMs).toEqual(expect.any(Number));
    expect(response.timing?.totalDurationMs).toEqual(expect.any(Number));
  });

  it("keeps the provider request id on failure errors", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({ error: { message: "upstream failed" } }, 500, {
        "x-request-id": "req-failed",
      }),
    );
    const gateway = chatGateway(fetch);

    const error = await gateway
      .generate(chatRequest)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ModelError);
    expect(error).toMatchObject({
      category: "server",
      status: 500,
      requestId: "req-failed",
    });
    expect((error as ModelError).timing?.totalDurationMs).toEqual(
      expect.any(Number),
    );
    const serialized = (error as ModelError).serialize();
    expect(serialized.requestId).toBe("req-failed");
    expect(serialized.timing?.dispatchedAt).toEqual(expect.any(Number));
  });
});
