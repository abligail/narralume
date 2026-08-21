/**
 * 公网 Relay 的纯判定层。
 *
 * 浏览器只允许调用 OpenAI Chat Completions。Relay 强制模型、剥掉客户端
 * 鉴权与任意自定义头，再注入 Cloudflare Access service token 和本地 Bridge
 * 共享密钥。上游 API Key 不进入 Cloudflare。
 */

const CHAT_COMPLETIONS_PATH = "/v1/chat/completions";

export interface RelayEnv {
  upstreamBaseUrl: string;
  model: string;
  bridgeAccessClientId: string;
  bridgeAccessClientSecret: string;
  bridgeSharedSecret: string;
}

export interface RelayRequestContext {
  method: string;
  url: string;
  body: unknown;
}

export interface RelayDecisionForward {
  action: "forward";
  upstreamUrl: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export interface RelayDecisionReject {
  action: "reject";
  status: number;
  code: string;
  message: string;
}

export type RelayDecision = RelayDecisionForward | RelayDecisionReject;

export function decideRelay(
  env: RelayEnv,
  context: RelayRequestContext,
): RelayDecision {
  if (context.method !== "POST") {
    return {
      action: "reject",
      status: 405,
      code: "method_not_allowed",
      message: "The relay only accepts POST requests.",
    };
  }
  if (normalizePath(context.url) !== CHAT_COMPLETIONS_PATH) {
    return {
      action: "reject",
      status: 404,
      code: "path_not_allowed",
      message: "The path is not in the relay allowlist.",
    };
  }
  if (!isJsonObject(context.body)) {
    return {
      action: "reject",
      status: 400,
      code: "invalid_body",
      message: "The request body must be a JSON object.",
    };
  }

  return {
    action: "forward",
    upstreamUrl: new URL(
      "chat/completions",
      `${env.upstreamBaseUrl.replace(/\/+$/u, "")}/`,
    ).toString(),
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "cf-access-client-id": env.bridgeAccessClientId,
      "cf-access-client-secret": env.bridgeAccessClientSecret,
      "x-narrative-bridge-token": env.bridgeSharedSecret,
    },
    body: {
      ...context.body,
      model: env.model,
    },
  };
}

export function responseHeadersForRelay(
  upstreamHeaders: Iterable<[string, string]>,
  allowedOrigin: string | null,
): Record<string, string> {
  const source = new Map<string, string>();
  for (const [name, value] of upstreamHeaders) {
    source.set(name.toLowerCase(), value);
  }
  const headers: Record<string, string> = {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };
  const contentType = source.get("content-type");
  if (contentType) headers["content-type"] = contentType;
  const requestId = source.get("x-request-id");
  if (requestId) headers["x-request-id"] = requestId;
  if (allowedOrigin) {
    headers["access-control-allow-origin"] = allowedOrigin;
    headers["access-control-allow-credentials"] = "true";
    headers.vary = "origin";
  }
  return headers;
}

function normalizePath(url: string): string {
  let pathname = url.split("?")[0] ?? url;
  if (!pathname.startsWith("/v1/")) pathname = `/v1${pathname}`;
  return pathname.toLowerCase();
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
