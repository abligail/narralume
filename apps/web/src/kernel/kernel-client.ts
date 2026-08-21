/**
 * M3 内核主线程客户端：懒加载 kernel-worker，把 HTTP 形状的请求
 * （method + path + query + body）经 postMessage 送进内核，等待同 id
 * 响应；事件帧（type:"sse"）以回调集合分发，供 sse.ts 的 local 分支复用。
 *
 * 协议见 kernel-worker.ts 头注释。单例——Worker 与 OPFS sahpool 连接
 * 每 origin 只允许一个。
 */

import { getLocale, translate } from "../i18n";

export type KernelEventListener = (frame: string) => void;

interface KernelResponseFrame {
  type: "response";
  id: string;
  ok: boolean;
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  error?: { code: string; message: string; details?: unknown };
}

type KernelFrame =
  | KernelResponseFrame
  | { type: "ready" }
  | { type: "fatal"; message: string }
  | { type: "sse"; frame: string };

export interface KernelHttpError {
  status: number;
  code: string;
  message: string;
  details?: unknown;
}

let worker: Worker | null = null;
let bootPromise: Promise<void> | null = null;
let kernelLockPromise: Promise<void> | null = null;
let releaseKernelLock: (() => void) | null = null;
let sequence = 0;
const pending = new Map<
  string,
  { resolve: (frame: KernelResponseFrame) => void; reject: (error: unknown) => void }
>();
const listeners = new Set<KernelEventListener>();

function failWorker(instance: Worker, error: Error): void {
  if (worker !== instance) return;
  instance.terminate();
  worker = null;
  bootPromise = null;
  releaseKernelLock?.();
  releaseKernelLock = null;
  kernelLockPromise = null;
  for (const entry of pending.values()) entry.reject(error);
  pending.clear();
}

function acquireKernelLock(): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.locks) {
    return Promise.resolve();
  }
  if (kernelLockPromise) return kernelLockPromise;

  kernelLockPromise = new Promise<void>((resolve, reject) => {
    void navigator.locks
      .request("narralume-kernel", { ifAvailable: true }, (lock) => {
        if (!lock) {
          reject(new Error(translate(getLocale(), "components.kernel.lockBusy")));
          return;
        }
        resolve();
        return new Promise<void>((release) => {
          releaseKernelLock = release;
        });
      })
      .catch((error: unknown) => {
        kernelLockPromise = null;
        reject(error);
      });
  });
  return kernelLockPromise;
}

function ensureWorker(): Worker {
  if (worker) return worker;
  const instance = new Worker(new URL("./kernel-worker.ts", import.meta.url), {
    type: "module",
  });
  instance.addEventListener("message", (event: MessageEvent<KernelFrame>) => {
    const frame = event.data;
    if (!frame || typeof frame !== "object") return;
    if (frame.type === "sse") {
      for (const listener of listeners) {
        try {
          listener(frame.frame);
        } catch {
          // 单个订阅者异常不应中断其他订阅者。
        }
      }
      return;
    }
    if (frame.type === "response") {
      const entry = pending.get(frame.id);
      if (!entry) return;
      pending.delete(frame.id);
      entry.resolve(frame);
      return;
    }
    // ready / fatal 在 bootPromise 里处理。
  });
  instance.addEventListener("messageerror", () =>
    failWorker(
      instance,
      new Error(translate(getLocale(), "components.kernel.deserializeFailed")),
    ),
  );
  instance.addEventListener("error", (event: ErrorEvent) =>
    failWorker(
      instance,
      new Error(
        event.message ||
          translate(getLocale(), "components.kernel.workerTerminated"),
      ),
    ),
  );
  worker = instance;
  return instance;
}

/** 启动内核并等待 ready；失败（如 sahpool 被其他标签页占用）时 reject。 */
export function bootKernel(): Promise<void> {
  bootPromise ??= (async () => {
    await acquireKernelLock();
    await new Promise<void>((resolve, reject) => {
      const instance = ensureWorker();
      // 模块级异常会让 Worker 静默死亡（error 事件都不发），用超时兜底。
      const timer = setTimeout(() => {
        failWorker(
          instance,
          new Error(translate(getLocale(), "components.kernel.bootTimeout")),
        );
        finish();
        reject(
          new Error(translate(getLocale(), "components.kernel.bootTimeout")),
        );
      }, 30_000);
      const finish = () => {
        clearTimeout(timer);
        instance.removeEventListener("message", onMessage);
        instance.removeEventListener("error", onError);
      };
      const onMessage = (event: MessageEvent<KernelFrame>) => {
        if (event.data?.type === "ready") {
          finish();
          resolve();
        }
        if (event.data?.type === "fatal") {
          if (String(event.data.message).startsWith("boot:")) {
            // 临时启动阶段探针（诊断完成后移除）。
            console.warn("[kernel]", event.data.message);
            return;
          }
          finish();
          failWorker(instance, new Error(event.data.message));
          reject(new Error(event.data.message));
        }
      };
      const onError = (event: ErrorEvent) => {
        const message =
          event.message ||
          translate(getLocale(), "components.kernel.workerBootFailed");
        failWorker(instance, new Error(message));
        finish();
        reject(new Error(message));
      };
      instance.addEventListener("message", onMessage);
      instance.addEventListener("error", onError);
    });
  })().catch((error: unknown) => {
    bootPromise = null;
    releaseKernelLock?.();
    releaseKernelLock = null;
    kernelLockPromise = null;
    throw error;
  });
  return bootPromise;
}

function shutdownKernel(): void {
  if (worker) {
    failWorker(
      worker,
      new Error(translate(getLocale(), "components.kernel.pageClosed")),
    );
    return;
  }
  releaseKernelLock?.();
  releaseKernelLock = null;
  kernelLockPromise = null;
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", shutdownKernel);
}

/** 订阅内核事件帧（JSON 字符串，与 /api/events 的 SSE data 同构）。 */
export function addKernelEventListener(
  listener: KernelEventListener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export interface KernelRequestInit {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string> | undefined;
  body?: unknown;
  headers?: Record<string, string> | undefined;
}

/** 内核形状的 HTTP 错误（已由 mapRouteError 映射为 ApiError 形状）。 */
export class KernelApiError extends Error {
  constructor(readonly payload: KernelHttpError) {
    super(payload.message);
    this.name = "KernelApiError";
  }
}

/**
 * 向内核发起一次 HTTP 形状请求。path 可带 ?query（与 fetch 一致），
 * 返回 {status, headers, body}；非 2xx 抛 KernelApiError。
 */
export async function kernelRequest(init: KernelRequestInit): Promise<{
  status: number;
  headers: Record<string, string>;
  body: unknown;
}> {
  await bootKernel();
  const instance = ensureWorker();
  const [pathname, search] = init.path.split("?");
  const query: Record<string, unknown> = {};
  if (search) {
    for (const [key, value] of new URLSearchParams(search)) {
      query[key] = value;
    }
  }
  for (const [key, value] of Object.entries(init.query ?? {})) {
    query[key] = value;
  }
  const id = `k${(sequence += 1)}`;
  const body =
    typeof init.body === "string" ? safeParseJson(init.body) : init.body;
  const frame = await new Promise<KernelResponseFrame>(
    (resolve, reject) => {
      pending.set(id, { resolve, reject });
      instance.postMessage({
        type: "request",
        id,
        method: init.method,
        path: pathname,
        query,
        body,
        headers: init.headers ?? {},
      });
    },
  );
  if (!frame.ok) {
    const error = frame.error ?? {
      code: "internal",
      message: translate(getLocale(), "components.kernel.requestFailed"),
    };
    throw new KernelApiError({
      status: frame.status ?? 500,
      code: error.code,
      message: error.message,
      details: error.details,
    });
  }
  return {
    status: frame.status ?? 200,
    headers: frame.headers ?? {},
    body: frame.body,
  };
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
