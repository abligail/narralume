import type {
  AdapterConfig,
  FinishReason,
  ModelAdapter,
  ModelCallTiming,
  ModelEvent,
  ModelMessage,
  ModelRequest,
  StreamOptions,
  ToolChoice,
} from "../types.js";
import { isEventStream, postJson, readJsonObject } from "../transport.js";
import { parseSseJson } from "../sse.js";
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  completedEvent,
  mentionsJson,
  normalizeFinishReason,
  parseToolArguments,
  protocolError,
  startedEvent,
  stringifyToolOutput,
  textFromContent,
  usage,
} from "./shared.js";

interface PendingChatTool {
  callId: string;
  name: string;
  arguments: string;
  started: boolean;
}

export class OpenAIChatAdapter implements ModelAdapter {
  readonly protocol = "openai-chat" as const;

  constructor(private readonly config: AdapterConfig) {}

  supportsStructuredMode(): boolean {
    return true;
  }

  async *stream(
    request: ModelRequest,
    options: StreamOptions = {},
  ): AsyncGenerator<ModelEvent> {
    const wantsStream = options.stream ?? true;
    const { response, timing, requestId } = await postJson(
      this.config,
      "chat/completions",
      buildChatBody(request, wantsStream),
      {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        headers: { authorization: `Bearer ${this.config.apiKey}` },
      },
    );

    if (!wantsStream || !isEventStream(response)) {
      yield* parseChatResponse(
        await readJsonObject(response, timing),
        timing,
        requestId,
      );
      return;
    }
    if (!response.body)
      throw protocolError("Chat Completions stream has no response body");

    const tools = new Map<number, PendingChatTool>();
    let started = false;
    let finishReason: FinishReason = "unknown";
    let completed = false;

    for await (const { value } of parseSseJson(response.body, {
      ...(this.config.streamIdleTimeoutMs === undefined
        ? {}
        : { idleTimeoutMs: this.config.streamIdleTimeoutMs }),
      timing,
      ...(requestId === undefined ? {} : { requestId }),
    })) {
      if (!started) {
        const responseId = asString(value.id);
        yield startedEvent(responseId, timing);
        started = true;
      }

      const responseUsage = asRecord(value.usage);
      if (responseUsage)
        yield { type: "usage", usage: chatUsage(responseUsage) };

      for (const choiceValue of asArray(value.choices)) {
        const choice = asRecord(choiceValue);
        if (!choice) continue;
        const delta = asRecord(choice.delta);
        const text = asString(delta?.content);
        if (text) yield { type: "text.delta", text };
        const reasoning =
          asString(delta?.reasoning_content) ?? asString(delta?.reasoning);
        if (reasoning) yield { type: "reasoning.delta", text: reasoning };

        for (const toolValue of asArray(delta?.tool_calls)) {
          const tool = asRecord(toolValue);
          if (!tool) continue;
          const index = asNumber(tool.index);
          const fn = asRecord(tool.function);
          const existing = tools.get(index) ?? {
            callId: "",
            name: "",
            arguments: "",
            started: false,
          };
          existing.callId ||= asString(tool.id) ?? "";
          existing.name ||= asString(fn?.name) ?? "";
          const argumentDelta = asString(fn?.arguments) ?? "";
          existing.arguments += argumentDelta;
          tools.set(index, existing);

          if (!existing.started && existing.callId && existing.name) {
            yield {
              type: "tool.started",
              callId: existing.callId,
              name: existing.name,
            };
            existing.started = true;
            if (existing.arguments) {
              yield {
                type: "tool.arguments.delta",
                callId: existing.callId,
                json: existing.arguments,
              };
            }
          } else if (existing.started && argumentDelta) {
            yield {
              type: "tool.arguments.delta",
              callId: existing.callId,
              json: argumentDelta,
            };
          }
        }

        if (choice.finish_reason != null)
          finishReason = normalizeFinishReason(choice.finish_reason);
      }
    }

    if (!started) yield startedEvent(undefined, timing);
    for (const [index, tool] of [...tools.entries()].sort(
      (a, b) => a[0] - b[0],
    )) {
      const callId = tool.callId || `chat-tool-${index}`;
      const name = tool.name || "unknown_tool";
      if (!tool.started) yield { type: "tool.started", callId, name };
      yield {
        type: "tool.completed",
        call: parseToolArguments(callId, name, tool.arguments),
      };
      completed = true;
    }
    if (finishReason === "unknown" && completed) finishReason = "tool_calls";
    yield completedEvent(finishReason, timing, requestId);
  }
}

function buildChatBody(
  request: ModelRequest,
  stream: boolean,
): Record<string, unknown> {
  const messages = request.messages.flatMap(mapChatMessage);
  if (request.instructions)
    messages.unshift({ role: "system", content: request.instructions });
  const body: Record<string, unknown> = {
    model: request.model,
    messages,
    stream,
  };
  if (stream) body.stream_options = { include_usage: true };
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.topP !== undefined) body.top_p = request.topP;
  if (request.reasoningEffort !== undefined) {
    body.reasoning_effort = request.reasoningEffort;
  }
  if (request.maxOutputTokens !== undefined)
    body.max_tokens = request.maxOutputTokens;
  if (request.stopSequences?.length) body.stop = request.stopSequences;
  if (request.promptCacheKey) body.prompt_cache_key = request.promptCacheKey;
  if (request.tools?.length) {
    body.tools = request.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
        ...(tool.strict === undefined ? {} : { strict: tool.strict }),
      },
    }));
    body.tool_choice = mapChatToolChoice(request.toolChoice ?? "auto");
  }
  if (request.responseSchema && request.structuredMode !== "prompt") {
    if (request.structuredMode === "json-mode") {
      body.response_format = { type: "json_object" };
      // json_object requires the word "json" in some message; add a minimal
      // system instruction unless the request already mentions JSON.
      if (!messages.some((message) => mentionsJson(message.content))) {
        messages.unshift({
          role: "system",
          content: "Respond with a single JSON object.",
        });
      }
    } else {
      body.response_format = {
        type: "json_schema",
        json_schema: {
          name: request.responseSchema.name,
          schema: request.responseSchema.schema,
          strict: request.responseSchema.strict ?? true,
          ...(request.responseSchema.description === undefined
            ? {}
            : { description: request.responseSchema.description }),
        },
      };
    }
  }
  return body;
}

function mapChatMessage(message: ModelMessage): Record<string, unknown>[] {
  if (typeof message.content === "string")
    return [{ role: message.role, content: message.content }];
  const text = textFromContent(message.content);
  const toolCalls = message.content.filter((part) => part.type === "tool-call");
  const toolResults = message.content.filter(
    (part) => part.type === "tool-result",
  );
  const result: Record<string, unknown>[] = [];

  if (text || toolCalls.length || toolResults.length === 0) {
    const mapped: Record<string, unknown> = {
      role: message.role === "tool" ? "user" : message.role,
      content: text || null,
    };
    if (toolCalls.length) {
      mapped.tool_calls = toolCalls.map((call) => ({
        id: call.callId,
        type: "function",
        function: {
          name: call.name,
          arguments: JSON.stringify(call.arguments),
        },
      }));
    }
    result.push(mapped);
  }
  for (const toolResult of toolResults) {
    result.push({
      role: "tool",
      tool_call_id: toolResult.callId,
      content: stringifyToolOutput(toolResult.output),
    });
  }
  return result;
}

function mapChatToolChoice(choice: ToolChoice): unknown {
  if (typeof choice === "string") return choice;
  return { type: "function", function: { name: choice.name } };
}

function* parseChatResponse(
  value: Record<string, unknown>,
  timing?: ModelCallTiming,
  requestId?: string,
): Generator<ModelEvent> {
  const responseId = asString(value.id);
  yield startedEvent(responseId, timing);
  let finishReason: FinishReason = "unknown";
  const choice = asRecord(asArray(value.choices)[0]);
  if (choice) {
    const message = asRecord(choice.message);
    const content = asString(message?.content);
    if (content) yield { type: "text.delta", text: content };
    const reasoning =
      asString(message?.reasoning_content) ?? asString(message?.reasoning);
    if (reasoning) yield { type: "reasoning.delta", text: reasoning };
    for (const toolValue of asArray(message?.tool_calls)) {
      const tool = asRecord(toolValue);
      const fn = asRecord(tool?.function);
      const callId = asString(tool?.id) ?? "chat-tool";
      const name = asString(fn?.name) ?? "unknown_tool";
      const args = asString(fn?.arguments) ?? "{}";
      yield { type: "tool.started", callId, name };
      yield { type: "tool.arguments.delta", callId, json: args };
      yield {
        type: "tool.completed",
        call: parseToolArguments(callId, name, args),
      };
    }
    finishReason = normalizeFinishReason(choice.finish_reason);
  }
  const responseUsage = asRecord(value.usage);
  if (responseUsage) yield { type: "usage", usage: chatUsage(responseUsage) };
  yield completedEvent(finishReason, timing, requestId);
}

function chatUsage(value: Record<string, unknown>) {
  const input = asNumber(value.prompt_tokens);
  const output = asNumber(value.completion_tokens);
  const promptDetails = asRecord(value.prompt_tokens_details);
  const completionDetails = asRecord(value.completion_tokens_details);
  return usage(
    input,
    output,
    asNumber(promptDetails?.cached_tokens),
    asNumber(completionDetails?.reasoning_tokens),
    asNumber(value.total_tokens) || input + output,
  );
}
