import { timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";

import Fastify, { type FastifyInstance } from "fastify";

import type { BridgeConfig } from "./config.js";

export interface BuildBridgeOptions {
  config: BridgeConfig;
  fetch?: typeof fetch;
  logger?: boolean;
}

export function buildBridge(options: BuildBridgeOptions): FastifyInstance {
  const fetchUpstream = options.fetch ?? fetch;
  let activeRequests = 0;
  const app = Fastify({
    logger: options.logger ?? true,
    bodyLimit: 2 * 1024 * 1024,
    requestTimeout: 30_000,
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("cache-control", "no-store");
    reply.header("x-content-type-options", "nosniff");
    return payload;
  });

  app.get("/health", async () => ({
    status: "ok",
    service: "narralume-bridge",
    activeRequests,
    maxConcurrency: options.config.maxConcurrency,
  }));

  app.post("/v1/chat/completions", async (request, reply) => {
    const bridgeToken = request.headers["x-narrative-bridge-token"];
    if (
      typeof bridgeToken !== "string" ||
      !sameSecret(bridgeToken, options.config.sharedSecret)
    ) {
      return reply.code(401).send({
        error: {
          code: "bridge.auth_required",
          message: "Bridge authentication failed",
        },
      });
    }
    if (!isJsonObject(request.body)) {
      return reply.code(400).send({
        error: {
          code: "bridge.invalid_body",
          message: "The request body must be a JSON object",
        },
      });
    }
    if (activeRequests >= options.config.maxConcurrency) {
      return reply.code(429).send({
        error: {
          code: "bridge.busy",
          message: "The model service is busy; please try again later",
        },
      });
    }

    activeRequests += 1;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      options.config.upstreamTimeoutMs,
    );
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      clearTimeout(timeout);
      activeRequests -= 1;
    };
    reply.raw.once("close", () => {
      controller.abort();
      release();
    });

    try {
      const upstream = await fetchUpstream(
        `${options.config.upstreamBaseUrl}/chat/completions`,
        {
          method: "POST",
          headers: {
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${options.config.upstreamApiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            ...request.body,
            model: options.config.model,
          }),
          signal: controller.signal,
        },
      );

      reply.code(upstream.status);
      const contentType = upstream.headers.get("content-type");
      if (contentType) reply.header("content-type", contentType);
      const requestId = upstream.headers.get("x-request-id");
      if (requestId) reply.header("x-request-id", requestId);
      if (!upstream.body) {
        release();
        return reply.send();
      }
      const isEventStream = contentType
        ?.toLowerCase()
        .startsWith("text/event-stream");
      const stream = Readable.from(
        readWebStream(upstream.body, isEventStream === true),
      );
      stream.once("end", release);
      stream.once("error", release);
      stream.once("close", release);
      return reply.send(stream);
    } catch (error) {
      release();
      if (controller.signal.aborted) {
        return reply.code(504).send({
          error: {
            code: "bridge.upstream_timeout",
            message: "The model service timed out",
          },
        });
      }
      request.log.error(
        { err: error instanceof Error ? error.message : String(error) },
        "bridge upstream request failed",
      );
      return reply.code(502).send({
        error: {
          code: "bridge.upstream_failed",
          message: "Failed to connect to the model service",
        },
      });
    }
  });

  return app;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameSecret(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

async function* readWebStream(
  stream: ReadableStream<Uint8Array>,
  isEventStream: boolean,
): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  let totalBytes = 0;
  let frameBytes = 0;
  const maxTotalBytes = isEventStream ? 32 * 1024 * 1024 : 8 * 1024 * 1024;
  const maxFrameBytes = 8 * 1024 * 1024;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) return;
      totalBytes += result.value.byteLength;
      if (totalBytes > maxTotalBytes) {
        throw new Error("bridge response exceeds the byte limit");
      }
      if (isEventStream) {
        for (const byte of result.value) {
          frameBytes = byte === 10 ? 0 : frameBytes + 1;
          if (frameBytes > maxFrameBytes) {
            throw new Error("bridge SSE frame exceeds the byte limit");
          }
        }
      }
      yield result.value;
    }
  } finally {
    reader.releaseLock();
  }
}
