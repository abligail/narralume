import { ModelError } from "../error.js";
import { finalizeTiming } from "../timing.js";
import type {
  FinishReason,
  JsonValue,
  ModelCallTiming,
  ModelContent,
  ModelEvent,
  NormalizedUsage,
  ToolCall,
} from "../types.js";

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function textFromContent(
  content: string | readonly ModelContent[],
): string {
  if (typeof content === "string") return content;
  return content
    .filter(
      (part): part is Extract<ModelContent, { type: "text" }> =>
        part.type === "text",
    )
    .map((part) => part.text)
    .join("\n");
}

export function parseToolArguments(
  callId: string,
  name: string,
  rawArguments: string,
): ToolCall {
  const normalized = rawArguments.trim() || "{}";
  try {
    const parsed = JSON.parse(normalized) as unknown;
    if (!isJsonValue(parsed))
      throw new TypeError("Arguments are not a JSON value");
    return { callId, name, arguments: parsed, rawArguments: normalized };
  } catch (error) {
    throw new ModelError(`Tool ${name} arguments are not valid JSON`, {
      category: "protocol",
      code: "model.tool_arguments_invalid",
      cause: error,
    });
  }
}

export function stringifyToolOutput(output: JsonValue | string): string {
  return typeof output === "string" ? output : JSON.stringify(output);
}

export function normalizeFinishReason(value: unknown): FinishReason {
  switch (value) {
    case "stop":
    case "stop_sequence":
    case "end_turn":
    case "completed":
      return "stop";
    case "length":
    case "max_tokens":
    case "max_output_tokens":
      return "length";
    case "context_length":
    case "context_window_exceeded":
    case "max_context_length":
      return "context_length";
    case "tool_calls":
    case "tool_use":
      return "tool_calls";
    case "content_filter":
    case "refusal":
      return "content_filter";
    case "cancelled":
      return "cancelled";
    case "failed":
    case "error":
      return "error";
    default:
      return "unknown";
  }
}

export function usage(
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens = 0,
  reasoningTokens = 0,
  totalTokens = inputTokens + outputTokens,
): NormalizedUsage {
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cachedInputTokens,
    reasoningTokens,
  };
}

export function protocolError(message: string): ModelError {
  return new ModelError(message, { category: "protocol" });
}

/** Builds a response.started event carrying the transport timing segments. */
export function startedEvent(
  responseId: string | undefined,
  timing?: ModelCallTiming,
): ModelEvent {
  return {
    type: "response.started",
    ...(responseId === undefined ? {} : { responseId }),
    ...(timing?.timeToHeadersMs === undefined
      ? {}
      : { timeToHeadersMs: timing.timeToHeadersMs }),
    ...(timing?.timeToFirstTokenMs === undefined
      ? {}
      : { timeToFirstTokenMs: timing.timeToFirstTokenMs }),
  };
}

/**
 * Builds a response.completed event, sealing the timing record and attaching
 * it together with the provider request id.
 */
export function completedEvent(
  finishReason: FinishReason,
  timing?: ModelCallTiming,
  requestId?: string,
): ModelEvent {
  return {
    type: "response.completed",
    finishReason,
    ...(timing === undefined ? {} : { timing: finalizeTiming(timing) }),
    ...(requestId === undefined ? {} : { requestId }),
  };
}

/** True when the text mentions JSON (required by OpenAI json_object mode). */
export function mentionsJson(content: unknown): boolean {
  return typeof content === "string" && /json/i.test(content);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || ["string", "number", "boolean"].includes(typeof value))
    return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value === "object")
    return Object.values(value as Record<string, unknown>).every(isJsonValue);
  return false;
}
