import type {
  ModelCallTiming,
  ModelErrorCategory,
  SerializedModelError,
} from "./types.js";

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{8,}\b/g,
  /((?:api[_-]?key|authorization|x-api-key)["'\s:=]+)([^\s,"'}]+)/gi,
] as const;

export interface ModelErrorOptions {
  category: ModelErrorCategory;
  retryable?: boolean;
  /** Stable machine-readable reason, e.g. "request_start_timeout". */
  code?: string;
  status?: number;
  requestId?: string;
  retryAfterMs?: number;
  partialText?: string;
  timing?: ModelCallTiming;
  cause?: unknown;
}

export class ModelError extends Error {
  readonly category: ModelErrorCategory;
  readonly retryable: boolean;
  readonly code?: string;
  readonly status?: number;
  readonly requestId?: string;
  readonly retryAfterMs?: number;
  readonly partialText?: string;
  /**
   * Latency breakdown of the failed call. Mutable so the layer that detects
   * the failure can attach it to an error created elsewhere.
   */
  timing?: ModelCallTiming;
  override readonly cause?: unknown;

  constructor(message: string, options: ModelErrorOptions) {
    super(scrubSecrets(message));
    this.name = "ModelError";
    this.category = options.category;
    this.retryable = options.retryable ?? false;
    if (options.code !== undefined) this.code = options.code;
    if (options.status !== undefined) this.status = options.status;
    if (options.requestId !== undefined) this.requestId = options.requestId;
    if (options.retryAfterMs !== undefined)
      this.retryAfterMs = options.retryAfterMs;
    if (options.partialText !== undefined)
      this.partialText = options.partialText;
    if (options.timing !== undefined) this.timing = options.timing;
    if (options.cause !== undefined) this.cause = options.cause;
  }

  serialize(): SerializedModelError {
    const result: SerializedModelError = {
      category: this.category,
      message: this.message,
      retryable: this.retryable,
    };
    if (this.code !== undefined) result.code = this.code;
    if (this.status !== undefined) result.status = this.status;
    if (this.requestId !== undefined) result.requestId = this.requestId;
    if (this.retryAfterMs !== undefined)
      result.retryAfterMs = this.retryAfterMs;
    if (this.partialText !== undefined) result.partialText = this.partialText;
    if (this.timing !== undefined) result.timing = this.timing;
    return result;
  }
}

export function scrubSecrets(input: string): string {
  let result = input;
  result = result.replace(SECRET_PATTERNS[0], "[REDACTED_KEY]");
  result = result.replace(SECRET_PATTERNS[1], "[REDACTED_KEY]");
  result = result.replace(SECRET_PATTERNS[2], "$1[REDACTED]");
  return result;
}

export function asModelError(error: unknown, partialText?: string): ModelError {
  if (error instanceof ModelError) {
    if (partialText && !error.partialText) {
      return new ModelError(error.message, {
        category: error.category,
        retryable: error.retryable,
        ...(error.code === undefined ? {} : { code: error.code }),
        ...(error.status === undefined ? {} : { status: error.status }),
        ...(error.requestId === undefined
          ? {}
          : { requestId: error.requestId }),
        ...(error.retryAfterMs === undefined
          ? {}
          : { retryAfterMs: error.retryAfterMs }),
        ...(error.timing === undefined ? {} : { timing: error.timing }),
        partialText,
        cause: error.cause,
      });
    }
    return error;
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return new ModelError("Request cancelled", {
      category: "cancelled",
      code: "model.cancelled",
      ...(partialText === undefined ? {} : { partialText }),
      cause: error,
    });
  }
  return new ModelError(
    error instanceof Error ? error.message : String(error),
    {
      category: "network",
      retryable: true,
      ...(partialText === undefined ? {} : { partialText }),
      cause: error,
    },
  );
}
