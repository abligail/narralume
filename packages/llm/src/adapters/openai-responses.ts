import { ModelError } from "../error.js";
import { parseSseJson } from "../sse.js";
import { finalizeTiming } from "../timing.js";
import { isEventStream, postJson, readJsonObject } from "../transport.js";
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

interface PendingResponseTool {
  callId: string;
  name: string;
  arguments: string;
  completed: boolean;
}

export class OpenAIResponsesAdapter implements ModelAdapter {
  readonly protocol = "openai-responses" as const;

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
      "responses",
      buildResponsesBody(request, wantsStream),
      {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        headers: { authorization: `Bearer ${this.config.apiKey}` },
      },
    );

    if (!wantsStream || !isEventStream(response)) {
      yield* parseResponsesResponse(
        await readJsonObject(response, timing),
        timing,
        requestId,
      );
      return;
    }
    if (!response.body)
      throw protocolError("Responses stream has no response body");

    const tools = new Map<string, PendingResponseTool>();
    let started = false;
    let completed = false;
    let emittedText = false;
    for await (const frame of parseSseJson(response.body, {
      ...(this.config.streamIdleTimeoutMs === undefined
        ? {}
        : { idleTimeoutMs: this.config.streamIdleTimeoutMs }),
      timing,
      ...(requestId === undefined ? {} : { requestId }),
    })) {
      const eventType = asString(frame.value.type) ?? frame.event ?? "";
      const value = frame.value;

      if (
        eventType === "response.created" ||
        eventType === "response.in_progress"
      ) {
        if (!started) {
          const responseObject = asRecord(value.response);
          const responseId =
            asString(responseObject?.id) ?? asString(value.response_id);
          yield startedEvent(responseId, timing);
          started = true;
        }
        continue;
      }
      if (!started) {
        const responseId = asString(value.response_id);
        yield startedEvent(responseId, timing);
        started = true;
      }

      if (eventType === "response.output_text.delta") {
        const text = asString(value.delta);
        if (text) {
          yield { type: "text.delta", text };
          emittedText = true;
        }
      } else if (eventType === "response.output_text.done") {
        const text = asString(value.text);
        if (text && !emittedText) {
          yield { type: "text.delta", text };
          emittedText = true;
        }
      } else if (eventType === "response.content_part.done") {
        const part = asRecord(value.part);
        const text = asString(part?.text);
        if (
          text &&
          !emittedText &&
          ["output_text", "text"].includes(asString(part?.type) ?? "")
        ) {
          yield { type: "text.delta", text };
          emittedText = true;
        }
      } else if (
        eventType === "response.reasoning_text.delta" ||
        eventType === "response.reasoning_summary_text.delta"
      ) {
        const text = asString(value.delta);
        if (text) yield { type: "reasoning.delta", text };
      } else if (eventType === "response.output_item.added") {
        const item = asRecord(value.item);
        if (asString(item?.type) === "function_call") {
          const key = responseToolKey(value, item);
          const tool = {
            callId: asString(item?.call_id) ?? asString(item?.id) ?? key,
            name: asString(item?.name) ?? "unknown_tool",
            arguments: asString(item?.arguments) ?? "",
            completed: false,
          };
          tools.set(key, tool);
          yield { type: "tool.started", callId: tool.callId, name: tool.name };
          if (tool.arguments) {
            yield {
              type: "tool.arguments.delta",
              callId: tool.callId,
              json: tool.arguments,
            };
          }
        }
      } else if (eventType === "response.function_call_arguments.delta") {
        const key = responseToolKey(value);
        const tool = tools.get(key) ?? {
          callId: asString(value.call_id) ?? key,
          name: asString(value.name) ?? "unknown_tool",
          arguments: "",
          completed: false,
        };
        if (!tools.has(key)) {
          tools.set(key, tool);
          yield { type: "tool.started", callId: tool.callId, name: tool.name };
        }
        const delta = asString(value.delta) ?? "";
        tool.arguments += delta;
        if (delta)
          yield {
            type: "tool.arguments.delta",
            callId: tool.callId,
            json: delta,
          };
      } else if (eventType === "response.output_item.done") {
        const item = asRecord(value.item);
        if (asString(item?.type) === "function_call") {
          const key = responseToolKey(value, item);
          const tool = tools.get(key) ?? {
            callId: asString(item?.call_id) ?? asString(item?.id) ?? key,
            name: asString(item?.name) ?? "unknown_tool",
            arguments: "",
            completed: false,
          };
          tool.arguments = asString(item?.arguments) ?? tool.arguments;
          if (!tools.has(key)) {
            yield {
              type: "tool.started",
              callId: tool.callId,
              name: tool.name,
            };
            tools.set(key, tool);
          }
          if (!tool.completed) {
            yield {
              type: "tool.completed",
              call: parseToolArguments(tool.callId, tool.name, tool.arguments),
            };
            tool.completed = true;
          }
        }
      } else if (
        eventType === "response.completed" ||
        eventType === "response.incomplete"
      ) {
        const responseObject = asRecord(value.response) ?? value;
        if (!emittedText) {
          for (const text of responseTextParts(responseObject)) {
            yield { type: "text.delta", text };
            emittedText = true;
          }
        }
        const responseUsage = asRecord(responseObject.usage);
        if (responseUsage)
          yield { type: "usage", usage: responsesUsage(responseUsage) };
        const incomplete = asRecord(responseObject.incomplete_details);
        const finishReason =
          eventType === "response.incomplete"
            ? normalizeFinishReason(
                asString(incomplete?.reason) ?? "max_output_tokens",
              )
            : finishFromResponse(responseObject, tools.size > 0);
        yield completedEvent(finishReason, timing, requestId);
        completed = true;
      } else if (eventType === "response.failed" || eventType === "error") {
        const responseObject = asRecord(value.response);
        const error = asRecord(value.error) ?? asRecord(responseObject?.error);
        throw new ModelError(
          asString(error?.message) ?? "Responses API returned a failed event",
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
        tools.size > 0 ? "tool_calls" : "unknown",
        timing,
        requestId,
      );
    }
  }
}

function responseTextParts(value: Record<string, unknown>): string[] {
  const texts: string[] = [];
  for (const itemValue of asArray(value.output)) {
    const item = asRecord(itemValue);
    if (asString(item?.type) !== "message") continue;
    for (const partValue of asArray(item?.content)) {
      const part = asRecord(partValue);
      const partType = asString(part?.type);
      const text = asString(part?.text);
      if ((partType === "output_text" || partType === "text") && text) {
        texts.push(text);
      }
    }
  }
  return texts;
}

function buildResponsesBody(
  request: ModelRequest,
  stream: boolean,
): Record<string, unknown> {
  const { instructions, input } = mapResponsesInput(request);
  const jsonMode =
    request.responseSchema !== undefined &&
    request.structuredMode === "json-mode";
  let effectiveInstructions = instructions;
  // json_object requires the word "json" somewhere in the input; append a
  // minimal instruction unless the request already mentions JSON.
  if (
    jsonMode &&
    !mentionsJson(instructions) &&
    !input.some((item) => mentionsJson(item.content))
  ) {
    effectiveInstructions = [instructions, "Respond with a single JSON object."]
      .filter(Boolean)
      .join("\n\n");
  }
  const body: Record<string, unknown> = {
    model: request.model,
    input,
    stream,
  };
  if (effectiveInstructions) body.instructions = effectiveInstructions;
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.topP !== undefined) body.top_p = request.topP;
  if (request.reasoningEffort !== undefined) {
    body.reasoning = { effort: request.reasoningEffort };
  }
  if (request.maxOutputTokens !== undefined)
    body.max_output_tokens = request.maxOutputTokens;
  if (request.metadata) body.metadata = request.metadata;
  if (request.promptCacheKey) body.prompt_cache_key = request.promptCacheKey;
  if (request.tools?.length) {
    body.tools = request.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      strict: tool.strict ?? true,
    }));
    body.tool_choice = mapResponsesToolChoice(request.toolChoice ?? "auto");
  }
  if (request.responseSchema && request.structuredMode !== "prompt") {
    if (request.structuredMode === "json-mode") {
      // The Responses API documents text.format json_object alongside
      // json_schema. Providers that reject it answer with an invalid_request
      // error, which the structured pipeline treats as a compatibility
      // signal and downgrades to prompt mode.
      body.text = { format: { type: "json_object" } };
    } else {
      body.text = {
        format: {
          type: "json_schema",
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

function mapResponsesInput(request: ModelRequest): {
  instructions: string;
  input: Record<string, unknown>[];
} {
  const system: string[] = request.instructions ? [request.instructions] : [];
  const input: Record<string, unknown>[] = [];
  for (const message of request.messages) {
    if (message.role === "system") {
      system.push(textFromContent(message.content));
      continue;
    }
    input.push(...mapResponsesMessage(message));
  }
  return { instructions: system.filter(Boolean).join("\n\n"), input };
}

function mapResponsesMessage(message: ModelMessage): Record<string, unknown>[] {
  if (typeof message.content === "string") {
    return [
      {
        role: message.role === "tool" ? "user" : message.role,
        content: message.content,
      },
    ];
  }
  const result: Record<string, unknown>[] = [];
  const text = textFromContent(message.content);
  if (text)
    result.push({
      role: message.role === "tool" ? "user" : message.role,
      content: text,
    });
  for (const part of message.content) {
    if (part.type === "tool-call") {
      result.push({
        type: "function_call",
        call_id: part.callId,
        name: part.name,
        arguments: JSON.stringify(part.arguments),
      });
    } else if (part.type === "tool-result") {
      result.push({
        type: "function_call_output",
        call_id: part.callId,
        output: stringifyToolOutput(part.output),
      });
    }
  }
  return result;
}

function mapResponsesToolChoice(choice: ToolChoice): unknown {
  if (choice === "required") return "required";
  if (typeof choice === "string") return choice;
  return { type: "function", name: choice.name };
}

function* parseResponsesResponse(
  value: Record<string, unknown>,
  timing?: ModelCallTiming,
  requestId?: string,
): Generator<ModelEvent> {
  const responseId = asString(value.id);
  yield startedEvent(responseId, timing);
  let hasTools = false;
  for (const itemValue of asArray(value.output)) {
    const item = asRecord(itemValue);
    const type = asString(item?.type);
    if (type === "message") {
      for (const partValue of asArray(item?.content)) {
        const part = asRecord(partValue);
        const partType = asString(part?.type);
        const text = asString(part?.text);
        if ((partType === "output_text" || partType === "text") && text) {
          yield { type: "text.delta", text };
        } else if (partType?.includes("reasoning") && text) {
          yield { type: "reasoning.delta", text };
        }
      }
    } else if (type === "function_call") {
      hasTools = true;
      const callId =
        asString(item?.call_id) ?? asString(item?.id) ?? "response-tool";
      const name = asString(item?.name) ?? "unknown_tool";
      const args = asString(item?.arguments) ?? "{}";
      yield { type: "tool.started", callId, name };
      yield { type: "tool.arguments.delta", callId, json: args };
      yield {
        type: "tool.completed",
        call: parseToolArguments(callId, name, args),
      };
    } else if (type === "reasoning") {
      for (const summary of asArray(item?.summary)) {
        const part = asRecord(summary);
        const text = asString(part?.text);
        if (text) yield { type: "reasoning.delta", text };
      }
    }
  }
  const responseUsage = asRecord(value.usage);
  if (responseUsage)
    yield { type: "usage", usage: responsesUsage(responseUsage) };
  yield completedEvent(finishFromResponse(value, hasTools), timing, requestId);
}

function responsesUsage(value: Record<string, unknown>) {
  const input = asNumber(value.input_tokens);
  const output = asNumber(value.output_tokens);
  const inputDetails = asRecord(value.input_tokens_details);
  const outputDetails = asRecord(value.output_tokens_details);
  return usage(
    input,
    output,
    asNumber(inputDetails?.cached_tokens),
    asNumber(outputDetails?.reasoning_tokens),
    asNumber(value.total_tokens) || input + output,
  );
}

function finishFromResponse(
  value: Record<string, unknown>,
  hasTools: boolean,
): FinishReason {
  if (hasTools) return "tool_calls";
  const status = asString(value.status);
  if (status === "completed") return "stop";
  const incomplete = asRecord(value.incomplete_details);
  if (status === "incomplete") return normalizeFinishReason(incomplete?.reason);
  if (status === "failed") return "error";
  return normalizeFinishReason(status);
}

function responseToolKey(
  event: Record<string, unknown>,
  item?: Record<string, unknown>,
): string {
  return (
    asString(event.item_id) ??
    asString(item?.id) ??
    asString(item?.call_id) ??
    asString(event.call_id) ??
    `output-${asNumber(event.output_index)}`
  );
}
