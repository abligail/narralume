import { ModelError } from "./error.js";
import { finalizeTiming, markTimingEvent } from "./timing.js";
import type { ModelCallTiming } from "./types.js";

export interface SseFrame {
  event?: string;
  data: string;
  id?: string;
  retry?: number;
}

export interface SseStreamOptions {
  /**
   * Idle budget (ms) between streamed events. When no new event arrives
   * within the budget the stream is cancelled and a retryable
   * `stream_idle_timeout` ModelError is thrown.
   */
  idleTimeoutMs?: number;
  /** Timing record updated as events arrive and attached to stream errors. */
  timing?: ModelCallTiming;
  /** Provider request id attached to stream errors. */
  requestId?: string;
}

const MAX_SSE_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_SSE_FRAME_BYTES = 8 * 1024 * 1024;

export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
  options: SseStreamOptions = {},
): AsyncGenerator<SseFrame> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let buffer = "";
  let frame = createFrameBuilder();
  let totalBytes = 0;
  let frameBytes = 0;

  const idleTimeoutMs = options.idleTimeoutMs;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let idleReject: ((error: ModelError) => void) | undefined;
  const idle =
    idleTimeoutMs !== undefined && idleTimeoutMs > 0
      ? new Promise<never>((_resolve, reject) => {
          idleReject = reject;
        })
      : undefined;
  const armIdleTimer = () => {
    if (idleTimeoutMs === undefined || idleTimeoutMs <= 0) return;
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      const error = new ModelError("SSE stream idle timeout", {
        category: "timeout",
        code: "stream_idle_timeout",
        retryable: true,
        ...(options.timing === undefined
          ? {}
          : { timing: finalizeTiming(options.timing) }),
        ...(options.requestId === undefined
          ? {}
          : { requestId: options.requestId }),
      });
      idleReject?.(error);
      void reader.cancel().catch(() => {});
    }, idleTimeoutMs);
  };
  armIdleTimer();

  try {
    while (true) {
      const { done, value } = idle
        ? await Promise.race([reader.read(), idle])
        : await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      frameBytes += value.byteLength;
      if (
        totalBytes > MAX_SSE_RESPONSE_BYTES ||
        frameBytes > MAX_SSE_FRAME_BYTES
      ) {
        await reader.cancel();
        throw new ModelError("SSE response exceeded the size limit", {
          category: "protocol",
          code: "model.response_too_large",
          retryable: false,
          ...(options.timing === undefined
            ? {}
            : { timing: finalizeTiming(options.timing) }),
          ...(options.requestId === undefined
            ? {}
            : { requestId: options.requestId }),
        });
      }
      buffer += decoder.decode(value, { stream: true });

      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        let line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);

        if (line.length === 0) {
          const emitted = buildFrame(frame);
          frame = createFrameBuilder();
          frameBytes = 0;
          if (emitted) {
            if (options.timing) markTimingEvent(options.timing);
            armIdleTimer();
            yield emitted;
          }
        } else {
          acceptLine(frame, line);
        }
        newline = buffer.indexOf("\n");
      }
    }

    buffer += decoder.decode();
    if (buffer.length > 0) {
      if (buffer.endsWith("\r")) buffer = buffer.slice(0, -1);
      acceptLine(frame, buffer);
    }
    const emitted = buildFrame(frame);
    if (emitted) {
      if (options.timing) markTimingEvent(options.timing);
      yield emitted;
    }
  } catch (error) {
    if (error instanceof ModelError) throw error;
    throw new ModelError("SSE stream ended before completion", {
      category: "stream_interrupted",
      code: "model.stream_interrupted",
      retryable: true,
      ...(options.timing === undefined
        ? {}
        : { timing: finalizeTiming(options.timing) }),
      ...(options.requestId === undefined
        ? {}
        : { requestId: options.requestId }),
      cause: error,
    });
  } finally {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    reader.releaseLock();
  }
}

export async function* parseSseJson(
  stream: ReadableStream<Uint8Array>,
  options: SseStreamOptions = {},
): AsyncGenerator<{ event?: string; value: Record<string, unknown> }> {
  for await (const frame of parseSseStream(stream, options)) {
    if (frame.data.trim().length === 0 || frame.data.trim() === "[DONE]")
      continue;
    try {
      const value = JSON.parse(frame.data) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError("SSE data is not an object");
      }
      yield {
        ...(frame.event === undefined ? {} : { event: frame.event }),
        value: value as Record<string, unknown>,
      };
    } catch (error) {
      throw new ModelError("Received an unparseable SSE JSON event", {
        category: "protocol",
        code: "model.sse_invalid_json",
        retryable: false,
        ...(options.timing === undefined
          ? {}
          : { timing: finalizeTiming(options.timing) }),
        ...(options.requestId === undefined
          ? {}
          : { requestId: options.requestId }),
        cause: error,
      });
    }
  }
}

interface FrameBuilder {
  event?: string;
  data: string[];
  id?: string;
  retry?: number;
  touched: boolean;
}

function createFrameBuilder(): FrameBuilder {
  return { data: [], touched: false };
}

function acceptLine(frame: FrameBuilder, line: string): void {
  if (line.startsWith(":")) return;
  const colon = line.indexOf(":");
  const field = colon < 0 ? line : line.slice(0, colon);
  let value = colon < 0 ? "" : line.slice(colon + 1);
  if (value.startsWith(" ")) value = value.slice(1);
  frame.touched = true;

  switch (field) {
    case "event":
      frame.event = value;
      break;
    case "data":
      frame.data.push(value);
      break;
    case "id":
      if (!value.includes("\0")) frame.id = value;
      break;
    case "retry": {
      const parsed = Number(value);
      if (Number.isInteger(parsed) && parsed >= 0) frame.retry = parsed;
      break;
    }
    default:
      break;
  }
}

function buildFrame(frame: FrameBuilder): SseFrame | null {
  if (!frame.touched || frame.data.length === 0) return null;
  const built: SseFrame = { data: frame.data.join("\n") };
  if (frame.event !== undefined) built.event = frame.event;
  if (frame.id !== undefined) built.id = frame.id;
  if (frame.retry !== undefined) built.retry = frame.retry;
  return built;
}
