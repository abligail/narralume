import type { FetchLike } from "@narralume/llm";
import { describe, expect, it, vi } from "vitest";

import {
  testModelConnection,
  type ConnectionTestProfile,
} from "@narralume/services";

describe("model connection capability fallback", () => {
  it("sends provider query parameters on connection probes", async () => {
    const urls: string[] = [];
    const fetch = vi.fn<FetchLike>(async (input) => {
      urls.push(String(input));
      return json({
        id: "chat-text",
        choices: [{ message: { content: "OK" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 2 },
      });
    });
    const profile: ConnectionTestProfile = {
      id: "test-query",
      name: "test",
      protocol: "openai-chat",
      baseUrl: "https://api.example.com/v1",
      endpoint: null,
      model: "query-model",
      apiKeyEnv: "TEST_KEY",
      anthropicVersion: null,
      extraHeaders: {},
      queryParams: { "api-version": "2026-08-01" },
      capabilities: {},
    };

    const stages = await testModelConnection(
      profile,
      {
        includeStreaming: false,
        includeTools: false,
        includeStructuredOutput: false,
      },
      { TEST_KEY: "secret" },
      { fetch },
    );

    expect(stages[0]).toMatchObject({ stage: "text", status: "passed" });
    expect(urls).toEqual([
      "https://api.example.com/v1/chat/completions?api-version=2026-08-01",
    ]);
  });

  it("falls back from forced tools and native schemas while keeping strict local validation", async () => {
    const fetch = vi.fn<FetchLike>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (
        body.tool_choice &&
        JSON.stringify(body.tool_choice).includes("echo_probe")
      ) {
        return json(
          {
            error: {
              message: "Thinking mode does not support this tool_choice",
            },
          },
          400,
        );
      }
      if (body.tools) {
        return json({
          id: "chat-tool",
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: "call-1",
                    type: "function",
                    function: {
                      name: "echo_probe",
                      arguments: '{"value":"lantern"}',
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 3 },
        });
      }
      if (body.response_format) {
        return json(
          {
            error: { message: "This response_format type is unavailable now" },
          },
          400,
        );
      }
      const isJsonFallback = JSON.stringify(body.messages).includes(
        "Return exactly one JSON value",
      );
      return json({
        id: "chat-text",
        choices: [
          {
            message: { content: isJsonFallback ? '{"ok":true}' : "OK" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 2, completion_tokens: 2 },
      });
    });
    const profile: ConnectionTestProfile = {
      id: "test-chat",
      name: "test",
      protocol: "openai-chat",
      baseUrl: "https://api.example.com/v1",
      endpoint: null,
      model: "thinking-model",
      apiKeyEnv: "TEST_KEY",
      anthropicVersion: null,
      extraHeaders: {},
      capabilities: {},
    };

    const stages = await testModelConnection(
      profile,
      {
        includeStreaming: false,
        includeTools: true,
        includeStructuredOutput: true,
      },
      { TEST_KEY: "secret" },
      { fetch },
    );

    expect(stages).toEqual([
      expect.objectContaining({ stage: "text", status: "passed" }),
      expect.objectContaining({ stage: "stream", status: "skipped" }),
      expect.objectContaining({
        stage: "tool",
        status: "passed",
        detail: expect.stringContaining("auto fallback"),
      }),
      expect.objectContaining({
        stage: "structured-output",
        status: "passed",
        detail: expect.stringContaining("strict local validation fallback"),
        capability: "prompt",
      }),
    ]);
    expect(fetch).toHaveBeenCalledTimes(6);
  });

  it("reports json-mode capability when only json_object passes", async () => {
    const fetch = vi.fn<FetchLike>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const format = body.response_format as { type?: string } | undefined;
      if (format?.type === "json_schema") {
        return json(
          { error: { message: "response_format json_schema unavailable" } },
          400,
        );
      }
      if (format?.type === "json_object") {
        return json({
          id: "chat-json-mode",
          choices: [
            { message: { content: '{"ok":true}' }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 2, completion_tokens: 2 },
        });
      }
      return json({
        id: "chat-text",
        choices: [{ message: { content: "OK" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 2 },
      });
    });
    const profile: ConnectionTestProfile = {
      id: "test-chat-json-mode",
      name: "test",
      protocol: "openai-chat",
      baseUrl: "https://api.example.com/v1",
      endpoint: null,
      model: "json-mode-model",
      apiKeyEnv: "TEST_KEY",
      anthropicVersion: null,
      extraHeaders: {},
      capabilities: {},
    };

    const stages = await testModelConnection(
      profile,
      {
        includeStreaming: false,
        includeTools: false,
        includeStructuredOutput: true,
      },
      { TEST_KEY: "secret" },
      { fetch },
    );

    expect(stages).toEqual([
      expect.objectContaining({ stage: "text", status: "passed" }),
      expect.objectContaining({ stage: "stream", status: "skipped" }),
      expect.objectContaining({ stage: "tool", status: "skipped" }),
      expect.objectContaining({
        stage: "structured-output",
        status: "passed",
        detail: expect.stringContaining("json_object"),
        capability: "json-mode",
      }),
    ]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
