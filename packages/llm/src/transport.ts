import { ModelError, asModelError, scrubSecrets } from "./error.js";
import {
  createTiming,
  finalizeTiming,
  markHeadersArrived,
  markTimingEvent,
} from "./timing.js";
import type { AdapterConfig, FetchLike, ModelCallTiming } from "./types.js";

export type EndpointKind =
  "chat/completions" | "responses" | "messages" | "embeddings";

export const MAX_MODEL_RESPONSE_BYTES = 8 * 1024 * 1024;

export interface PostJsonOptions {
  signal?: AbortSignal;
  headers?: Readonly<Record<string, string>>;
}

export interface PostJsonResult {
  response: Response;
  /**
   * Timing record for the successful attempt. The streaming layer keeps
   * updating it (first/last event) until the call finishes.
   */
  timing: ModelCallTiming;
  /** Provider request id extracted from response headers, when present. */
  requestId?: string;
}

/**
 * POSTs a JSON body and returns the response plus its timing record.
 *
 * Retries are opt-in: the default is 0 attempts beyond the first, leaving
 * retry decisions to the Harness. `config.requestStartTimeoutMs` bounds the
 * dispatch→headers phase of each attempt; the whole attempt is still bounded
 * by `config.timeoutMs`.
 */
export async function postJson(
  config: AdapterConfig,
  endpointKind: EndpointKind,
  body: unknown,
  options: PostJsonOptions = {},
): Promise<PostJsonResult> {
  const url = resolveEndpoint(
    config.baseUrl,
    config.endpoint,
    endpointKind,
    config.queryParams,
  );
  const fetcher: FetchLike = config.fetch ?? globalThis.fetch.bind(globalThis);
  const maxRetries = Math.max(0, config.maxRetries ?? 0);
  let attempt = 0;

  while (true) {
    const timing = createTiming();
    const timeout = AbortSignal.timeout(config.timeoutMs ?? 120_000);
    const startController = new AbortController();
    const signal = AbortSignal.any(
      options.signal
        ? [options.signal, timeout, startController.signal]
        : [timeout, startController.signal],
    );
    const startTimeoutMs = config.requestStartTimeoutMs;
    const startTimer =
      startTimeoutMs !== undefined && startTimeoutMs > 0
        ? setTimeout(() => startController.abort(), startTimeoutMs)
        : undefined;
    try {
      config.onRequestAttempt?.(attempt + 1);
      const response = await raceAbort(
        fetcher(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            ...config.headers,
            ...options.headers,
          },
          body: JSON.stringify(body),
          signal,
        }),
        signal,
      );
      if (startTimer !== undefined) clearTimeout(startTimer);
      markHeadersArrived(timing);
      const requestId = requestIdFromHeaders(response.headers);

      if (response.ok) {
        return {
          response,
          timing,
          ...(requestId === undefined ? {} : { requestId }),
        };
      }
      const modelError = await errorFromResponse(response);
      modelError.timing ??= finalizeTiming(timing);
      if (!modelError.retryable || attempt >= maxRetries) throw modelError;
      await cancelBody(response);
      await abortableDelay(
        retryDelay(config, attempt, modelError.retryAfterMs),
        options.signal,
      );
      attempt += 1;
    } catch (error) {
      if (startTimer !== undefined) clearTimeout(startTimer);
      if (startController.signal.aborted && !options.signal?.aborted) {
        // The dispatch→headers budget expired before the provider answered.
        const startError = new ModelError(
          "Timed out waiting for response headers",
          {
            category: "timeout",
            code: "request_start_timeout",
            retryable: true,
            timing: finalizeTiming(timing),
            cause: error,
          },
        );
        if (attempt >= maxRetries) throw startError;
        await abortableDelay(retryDelay(config, attempt), options.signal);
        attempt += 1;
        continue;
      }
      if (error instanceof ModelError) throw error;
      if (options.signal?.aborted) {
        throw new ModelError("Request cancelled by user", {
          category: "cancelled",
          code: "model.cancelled",
          cause: error,
        });
      }
      if (timeout.aborted) {
        const timeoutError = new ModelError("Model request timed out", {
          category: "timeout",
          code: "model.request_timeout",
          retryable: true,
          timing: finalizeTiming(timing),
          cause: error,
        });
        if (attempt >= maxRetries) throw timeoutError;
      } else if (attempt >= maxRetries) {
        const converted = asModelError(error);
        converted.timing ??= finalizeTiming(timing);
        throw converted;
      }
      await abortableDelay(retryDelay(config, attempt), options.signal);
      attempt += 1;
    }
  }
}

/**
 * Rejects when the signal aborts even if the wrapped promise never settles,
 * so request-start timeouts fire for non-compliant fetch implementations.
 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason as unknown);
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason as unknown), {
        once: true,
      });
    }),
  ]);
}

export function resolveEndpoint(
  baseUrl: string,
  explicitEndpoint: string | undefined,
  kind: EndpointKind,
  queryParams: Readonly<Record<string, string>> = {},
): string {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch (error) {
    throw new ModelError("Invalid model base URL", {
      category: "invalid_request",
      code: "model.base_url.invalid",
      cause: error,
    });
  }
  if (
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password
  ) {
    throw new ModelError(
      "Model base URL must be an HTTP(S) address without embedded credentials",
      {
        category: "invalid_request",
        code: "model.base_url.invalid",
      },
    );
  }

  if (explicitEndpoint) {
    const resolved = new URL(explicitEndpoint, ensureDirectoryUrl(base));
    if (resolved.origin !== base.origin) {
      throw new ModelError(
        "Model endpoint must stay under the base URL origin",
        {
          category: "invalid_request",
          code: "model.endpoint.origin",
        },
      );
    }
    applyQueryParams(resolved, queryParams);
    return resolved.toString();
  }

  const cleanPath = base.pathname.replace(/\/+$/, "");
  if (cleanPath.endsWith(`/${kind}`)) {
    applyQueryParams(base, queryParams);
    return base.toString();
  }
  const hasVersionPath = /\/v\d+(?:beta)?$/i.test(cleanPath);
  const suffix = hasVersionPath || cleanPath.length > 0 ? kind : `v1/${kind}`;
  const joined = `${cleanPath}/${suffix}`.replace(/\/+/g, "/");
  base.pathname = joined;
  base.search = "";
  base.hash = "";
  applyQueryParams(base, queryParams);
  return base.toString();
}

function applyQueryParams(
  url: URL,
  queryParams: Readonly<Record<string, string>>,
): void {
  for (const [key, value] of Object.entries(queryParams)) {
    url.searchParams.set(key, value);
  }
}

export async function readJsonObject(
  response: Response,
  timing?: ModelCallTiming,
): Promise<Record<string, unknown>> {
  const text = await readResponseTextLimited(
    response,
    MAX_MODEL_RESPONSE_BYTES,
  );
  // For non-streaming calls the body arrival is the first (and last) event.
  if (timing) markTimingEvent(timing);
  if (text.trim().length === 0) {
    throw new ModelError("Model returned an empty response", {
      category: "protocol",
      code: "model.empty_response",
      ...(timing === undefined ? {} : { timing: finalizeTiming(timing) }),
    });
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TypeError("Response is not a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new ModelError("Model returned invalid JSON", {
      category: "protocol",
      code: "model.invalid_json",
      ...(timing === undefined ? {} : { timing: finalizeTiming(timing) }),
      cause: error,
    });
  }
}

export async function readResponseTextLimited(
  response: Response,
  maxBytes: number,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new ModelError("Model response exceeded the size limit", {
          category: "protocol",
          code: "model.response_too_large",
          retryable: false,
        });
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

export function isEventStream(response: Response): boolean {
  return (
    response.headers
      .get("content-type")
      ?.toLowerCase()
      .includes("text/event-stream") ?? false
  );
}

async function errorFromResponse(response: Response): Promise<ModelError> {
  const requestId = requestIdFromHeaders(response.headers);
  const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
  const raw = (await response.text()).slice(0, 65_536);
  let message = raw || response.statusText || `HTTP ${response.status}`;
  try {
    const body = JSON.parse(raw) as Record<string, unknown>;
    const error = body.error;
    if (typeof error === "string") message = error;
    else if (error && typeof error === "object") {
      const inner = error as Record<string, unknown>;
      if (typeof inner.message === "string") message = inner.message;
    } else if (typeof body.message === "string") message = body.message;
  } catch {
    // Plain text and gateway HTML errors are retained after scrubbing.
  }

  const category = categorizeHttpError(response.status, message);
  const retryable = ["rate_limit", "timeout", "server", "network"].includes(
    category,
  );
  return new ModelError(scrubSecrets(message), {
    category,
    retryable,
    status: response.status,
    ...(requestId === undefined ? {} : { requestId }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}

function requestIdFromHeaders(headers: Headers): string | undefined {
  return (
    headers.get("x-request-id") ??
    headers.get("request-id") ??
    headers.get("anthropic-request-id") ??
    undefined
  );
}

function categorizeHttpError(
  status: number,
  message: string,
): ModelError["category"] {
  const lower = message.toLowerCase();
  if (status === 401) return "authentication";
  if (status === 403) return "permission";
  if (status === 404) return "model_not_found";
  if (status === 408 || status === 409) return "timeout";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "server";
  if (
    lower.includes("context") &&
    (lower.includes("length") || lower.includes("token"))
  ) {
    return "context_length";
  }
  if (lower.includes("content filter") || lower.includes("safety"))
    return "content_filter";
  return "invalid_request";
}

function retryDelay(
  config: AdapterConfig,
  attempt: number,
  serverDelay?: number,
): number {
  if (serverDelay !== undefined) return Math.min(serverDelay, 60_000);
  const base = config.retryBaseDelayMs ?? 250;
  const exponential = base * 2 ** attempt;
  const jitter = Math.floor(exponential * 0.2 * Math.random());
  return Math.min(exponential + jitter, 10_000);
}

async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    const abort = () => {
      clearTimeout(timeout);
      reject(
        new ModelError("Retry wait cancelled", {
          category: "cancelled",
          code: "model.cancelled",
        }),
      );
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // A failed cleanup must not replace the original provider error.
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.round(seconds * 1_000);
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - Date.now());
}

function ensureDirectoryUrl(url: URL): URL {
  const clone = new URL(url);
  if (!clone.pathname.endsWith("/")) clone.pathname += "/";
  return clone;
}
