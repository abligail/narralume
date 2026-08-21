import { ModelError } from "../error.js";
import { parseSseJson } from "../sse.js";
import { finalizeTiming } from "../timing.js";
import { isEventStream, postJson, readJsonObject } from "../transport.js";
import type {
  AdapterConfig,
  FinishReason,
  ModelAdapter,
  ModelCallTiming,
  ModelContent,
  ModelEvent,
  ModelMessage,
  ModelRequest,
  StreamOptions,
  StructuredMode,
  ToolChoice,
} from "../types.js";
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  completedEvent,
  normalizeFinishReason,
  parseToolArguments,
  protocolError,
  startedEvent,
  stringifyToolOutput,
  textFromContent,
  usage,
} from "./shared.js";

interface PendingAnthropicTool {
  callId: string;
  name: string;
  arguments: string;
  completed: boolean;
}

export class AnthropicMessagesAdapter implements ModelAdapter {
  readonly protocol = "anthropic-messages" as const;

  constructor(private readonly config: AdapterConfig) {}

  supportsStructuredMode(mode: StructuredMode): boolean {
    // Anthropic has no JSON mode; the pipeline skips that tier for us.
    return mode !== "json-mode";
  }

  async *stream(
    request: ModelRequest,
    options: StreamOptions = {},
  ): AsyncGenerator<ModelEvent> {
    const wantsStream = options.stream ?? true;
    const { response, timing, requestId } = await postJson(
      this.config,
      "messages",
      buildAnthropicBody(request, wantsStream),
      {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        headers: {
          "x-api-key": this.config.apiKey,
          "anthropic-version": this.config.anthropicVersion ?? "2023-06-01",
        },
      },
    );

    if (!wantsStream || !isEventStream(response)) {
      yield* parseAnthropicResponse(
        await readJsonObject(response, timing),
        timing,
        requestId,
      );
      return;
    }
    if (!response.body)
      throw protocolError("Anthropic Messages stream has no response body");

    const tools = new Map<number, PendingAnthropicTool>();
    let started = false;
    let completed = false;
    let finishReason: FinishReason = "unknown";
    let inputTokens = 0;
    let cacheTokens = 0;
    let outputTokens = 0;

    for await (const frame of parseSseJson(response.body, {
      ...(this.config.streamIdleTimeoutMs === undefined
        ? {}
        : { idleTimeoutMs: this.config.streamIdleTimeoutMs }),
      timing,
      ...(requestId === undefined ? {} : { requestId }),
    })) {
      const eventType = asString(frame.value.type) ?? frame.event ?? "";
      const value = frame.value;
      if (eventType === "ping") continue;

      if (eventType === "message_start") {
        const message = asRecord(value.message);
        const responseId = asString(message?.id);
        yield startedEvent(responseId, timing);
        started = true;
        const startUsage = asRecord(message?.usage);
        inputTokens = asNumber(startUsage?.input_tokens);
        cacheTokens =
          asNumber(startUsage?.cache_read_input_tokens) +
          asNumber(startUsage?.cache_creation_input_tokens);
      } else if (eventType === "content_block_start") {
        const index = asNumber(value.index);
        const block = asRecord(value.content_block);
        if (asString(block?.type) === "tool_use") {
          const tool = {
            callId: asString(block?.id) ?? `anthropic-tool-${index}`,
            name: asString(block?.name) ?? "unknown_tool",
            arguments: initialToolJson(block?.input),
            completed: false,
          };
          tools.set(index, tool);
          yield { type: "tool.started", callId: tool.callId, name: tool.name };
          if (tool.arguments && tool.arguments !== "{}") {
            yield {
              type: "tool.arguments.delta",
              callId: tool.callId,
              json: tool.arguments,
            };
          }
        }
      } else if (eventType === "content_block_delta") {
        const delta = asRecord(value.delta);
        const deltaType = asString(delta?.type);
        if (deltaType === "text_delta") {
          const text = asString(delta?.text);
          if (text) yield { type: "text.delta", text };
        } else if (
          deltaType === "thinking_delta" ||
          deltaType === "reasoning_delta"
        ) {
          const text = asString(delta?.thinking) ?? asString(delta?.text);
          if (text) yield { type: "reasoning.delta", text };
        } else if (deltaType === "input_json_delta") {
          const index = asNumber(value.index);
          const tool = tools.get(index);
          if (!tool)
            throw protocolError(
              "Anthropic tool argument delta is missing content_block_start",
            );
          const json = asString(delta?.partial_json) ?? "";
          tool.arguments =
            tool.arguments === "{}" ? json : tool.arguments + json;
          if (json)
            yield { type: "tool.arguments.delta", callId: tool.callId, json };
        }
      } else if (eventType === "content_block_stop") {
        const tool = tools.get(asNumber(value.index));
        if (tool && !tool.completed) {
          yield {
            type: "tool.completed",
            call: parseToolArguments(tool.callId, tool.name, tool.arguments),
          };
          tool.completed = true;
        }
      } else if (eventType === "message_delta") {
        const delta = asRecord(value.delta);
        finishReason = normalizeFinishReason(delta?.stop_reason);
        const deltaUsage = asRecord(value.usage);
        outputTokens = asNumber(deltaUsage?.output_tokens) || outputTokens;
      } else if (eventType === "message_stop") {
        const totalInputTokens = inputTokens + cacheTokens;
        yield {
          type: "usage",
          usage: usage(
            totalInputTokens,
            outputTokens,
            cacheTokens,
            0,
            totalInputTokens + outputTokens,
          ),
        };
        yield completedEvent(
          finishReason === "unknown" && tools.size > 0
            ? "tool_calls"
            : finishReason,
          timing,
          requestId,
        );
        completed = true;
      } else if (eventType === "error") {
        const error = asRecord(value.error);
        throw new ModelError(
          asString(error?.message) ?? "Anthropic stream error event",
          {
            category: "server",
            retryable: true,
            timing: finalizeTiming(timing),
            ...(requestId === undefined ? {} : { requestId }),
          },
        );
      }
    }

    if (!started) yield startedEvent(undefined, timing);
    for (const tool of tools.values()) {
      if (!tool.completed) {
        yield {
          type: "tool.completed",
          call: parseToolArguments(tool.callId, tool.name, tool.arguments),
        };
      }
    }
    if (!completed) {
      yield completedEvent(
        tools.size > 0 ? "tool_calls" : finishReason,
        timing,
        requestId,
      );
    }
  }
}

function buildAnthropicBody(
  request: ModelRequest,
  stream: boolean,
): Record<string, unknown> {
  const system = [request.instructions];
  const messages: Record<string, unknown>[] = [];
  for (const message of request.messages) {
    if (message.role === "system")
      system.push(textFromContent(message.content));
    else messages.push(...mapAnthropicMessage(message));
  }
  const body: Record<string, unknown> = {
    model: request.model,
    max_tokens: request.maxOutputTokens ?? 4_096,
    messages,
    stream,
  };
  const systemText = system
    .filter((value): value is string => Boolean(value))
    .join("\n\n");
  if (systemText)
    body.system = request.cacheControl
      ? [
          {
            type: "text",
            text: systemText,
            cache_control: request.cacheControl,
          },
        ]
      : systemText;
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.topP !== undefined) body.top_p = request.topP;
  if (request.stopSequences?.length)
    body.stop_sequences = request.stopSequences;
  if (request.tools?.length) {
    body.tools = request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
      ...(tool.strict === undefined ? {} : { strict: tool.strict }),
    }));
    body.tool_choice = mapAnthropicToolChoice(request.toolChoice ?? "auto");
  }
  const outputConfig: Record<string, unknown> = {};
  if (request.reasoningEffort !== undefined) {
    outputConfig.effort = anthropicEffort(request.reasoningEffort);
  }
  // Only the native tier maps to output_config.format. A direct
  // structuredMode "json-mode"/"prompt" request degrades to a plain call
  // (no format), matching the tier support reported above.
  if (
    request.responseSchema &&
    (request.structuredMode === undefined ||
      request.structuredMode === "native")
  ) {
    outputConfig.format = {
      type: "json_schema",
      schema: request.responseSchema.schema,
    };
  }
  if (Object.keys(outputConfig).length) body.output_config = outputConfig;
  return body;
}

function anthropicEffort(
  effort: NonNullable<ModelRequest["reasoningEffort"]>,
): "low" | "medium" | "high" {
  if (effort === "none" || effort === "minimal") return "low";
  return effort === "low" || effort === "medium" ? effort : "high";
}

function mapAnthropicMessage(message: ModelMessage): Record<string, unknown>[] {
  const role = message.role === "assistant" ? "assistant" : "user";
  if (typeof message.content === "string")
    return [{ role, content: message.content }];
  const content = message.content.flatMap(mapAnthropicContent);
  return content.length > 0 ? [{ role, content }] : [];
}

function mapAnthropicContent(part: ModelContent): Record<string, unknown>[] {
  if (part.type === "text") return [{ type: "text", text: part.text }];
  if (part.type === "tool-call") {
    return [
      {
        type: "tool_use",
        id: part.callId,
        name: part.name,
        input: part.arguments,
      },
    ];
  }
  return [
    {
      type: "tool_result",
      tool_use_id: part.callId,
      content: stringifyToolOutput(part.output),
      is_error: part.isError ?? false,
    },
  ];
}

function mapAnthropicToolChoice(choice: ToolChoice): unknown {
  if (choice === "required") return { type: "any" };
  if (choice === "none") return { type: "none" };
  if (choice === "auto") return { type: "auto" };
  return { type: "tool", name: choice.name };
}

function* parseAnthropicResponse(
  value: Record<string, unknown>,
  timing?: ModelCallTiming,
  requestId?: string,
): Generator<ModelEvent> {
  const responseId = asString(value.id);
  yield startedEvent(responseId, timing);
  let hasTools = false;
  for (const blockValue of asArray(value.content)) {
    const block = asRecord(blockValue);
    const type = asString(block?.type);
    if (type === "text") {
      const text = asString(block?.text);
      if (text) yield { type: "text.delta", text };
    } else if (type === "thinking") {
      const text = asString(block?.thinking);
      if (text) yield { type: "reasoning.delta", text };
    } else if (type === "tool_use") {
      hasTools = true;
      const callId = asString(block?.id) ?? "anthropic-tool";
      const name = asString(block?.name) ?? "unknown_tool";
      const args = initialToolJson(block?.input);
      yield { type: "tool.started", callId, name };
      yield { type: "tool.arguments.delta", callId, json: args };
      yield {
        type: "tool.completed",
        call: parseToolArguments(callId, name, args),
      };
    }
  }
  const responseUsage = asRecord(value.usage);
  if (responseUsage) {
    const input = asNumber(responseUsage.input_tokens);
    const output = asNumber(responseUsage.output_tokens);
    const cached =
      asNumber(responseUsage.cache_read_input_tokens) +
      asNumber(responseUsage.cache_creation_input_tokens);
    const totalInput = input + cached;
    yield {
      type: "usage",
      usage: usage(totalInput, output, cached, 0, totalInput + output),
    };
  }
  const finishReason = hasTools
    ? "tool_calls"
    : normalizeFinishReason(value.stop_reason);
  yield completedEvent(finishReason, timing, requestId);
}

function initialToolJson(input: unknown): string {
  if (input == null) return "";
  return JSON.stringify(input);
}
