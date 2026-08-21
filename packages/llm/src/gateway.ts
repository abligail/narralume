import { ModelError, asModelError } from "./error.js";
import type {
  ModelAdapter,
  ModelEvent,
  ModelRequest,
  ModelResponse,
  NormalizedUsage,
  StreamOptions,
  StructuredMode,
  ToolCall,
} from "./types.js";
import { EMPTY_USAGE } from "./types.js";
import {
  generateStructured,
  type StructuredGenerationOptions,
  type StructuredGenerationResult,
  type StructuredValidator,
} from "./structured.js";

export class ModelGateway {
  constructor(private readonly adapter: ModelAdapter) {}

  get protocol(): ModelAdapter["protocol"] {
    return this.adapter.protocol;
  }

  supportsStructuredMode(mode: StructuredMode): boolean {
    return this.adapter.supportsStructuredMode?.(mode) ?? mode !== "json-mode";
  }

  async *stream(
    request: ModelRequest,
    options: StreamOptions = {},
  ): AsyncGenerator<ModelEvent> {
    let partialText = "";
    try {
      for await (const event of this.adapter.stream(request, options)) {
        if (event.type === "text.delta") partialText += event.text;
        yield event;
      }
    } catch (error) {
      const normalized = asModelError(error, partialText || undefined);
      yield { type: "error", error: normalized.serialize() };
    }
  }

  async generate(
    request: ModelRequest,
    options: StreamOptions = {},
  ): Promise<ModelResponse> {
    return collectModelEvents(
      this.stream(request, { ...options, stream: options.stream ?? false }),
    );
  }

  async generateStructured<T>(
    request: ModelRequest,
    validate: StructuredValidator<T>,
    options: StructuredGenerationOptions = {},
  ): Promise<StructuredGenerationResult<T>> {
    return generateStructured(this, request, validate, options);
  }
}

export async function collectModelEvents(
  events: AsyncIterable<ModelEvent>,
): Promise<ModelResponse> {
  let responseId: string | undefined;
  let text = "";
  let reasoning = "";
  let usage: NormalizedUsage = { ...EMPTY_USAGE };
  let finishReason: ModelResponse["finishReason"] = "unknown";
  let timing: ModelResponse["timing"];
  let requestId: string | undefined;
  const toolCalls: ToolCall[] = [];
  let completed = false;

  for await (const event of events) {
    switch (event.type) {
      case "response.started":
        if (event.responseId !== undefined) responseId = event.responseId;
        break;
      case "text.delta":
        text += event.text;
        break;
      case "reasoning.delta":
        reasoning += event.text;
        break;
      case "tool.completed":
        toolCalls.push(event.call);
        break;
      case "usage":
        usage = event.usage;
        break;
      case "response.completed":
        finishReason = event.finishReason;
        if (event.timing !== undefined) timing = event.timing;
        if (event.requestId !== undefined) requestId = event.requestId;
        completed = true;
        break;
      case "error":
        throw new ModelError(event.error.message, {
          category: event.error.category,
          retryable: event.error.retryable,
          ...(event.error.code === undefined ? {} : { code: event.error.code }),
          ...(event.error.status === undefined
            ? {}
            : { status: event.error.status }),
          ...(event.error.requestId === undefined
            ? {}
            : { requestId: event.error.requestId }),
          ...(event.error.retryAfterMs === undefined
            ? {}
            : { retryAfterMs: event.error.retryAfterMs }),
          ...(event.error.partialText === undefined
            ? {}
            : { partialText: event.error.partialText }),
          ...(event.error.timing === undefined
            ? {}
            : { timing: event.error.timing }),
        });
      default:
        break;
    }
  }

  if (!completed) {
    throw new ModelError(
      "Model event stream ended without a completion event",
      {
        category: "stream_interrupted",
        code: "model.stream_incomplete",
        retryable: true,
        ...(text ? { partialText: text } : {}),
      },
    );
  }

  return {
    ...(responseId === undefined ? {} : { responseId }),
    text,
    reasoning,
    toolCalls,
    usage,
    finishReason,
    ...(timing === undefined ? {} : { timing }),
    ...(requestId === undefined ? {} : { requestId }),
  };
}
