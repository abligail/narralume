import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadDotEnv } from "dotenv";
import { z } from "zod";

const bridgeRoot = fileURLToPath(new URL("../", import.meta.url));

loadDotEnv({
  path: resolve(bridgeRoot, ".env.local"),
  quiet: true,
});

const BridgeEnvironmentSchema = z.object({
  UPSTREAM_API_KEY: z.string().trim().min(1),
  BRIDGE_SHARED_SECRET: z.string().min(24),
  UPSTREAM_BASE_URL: z.url(),
  UPSTREAM_MODEL: z.string().trim().min(1),
  BRIDGE_PORT: z.coerce.number().int().min(1).max(65_535).default(4320),
  BRIDGE_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(128).default(8),
  BRIDGE_UPSTREAM_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(3_600_000)
    .default(600_000),
});

export interface BridgeConfig {
  host: "127.0.0.1";
  port: number;
  upstreamBaseUrl: string;
  upstreamApiKey: string;
  model: string;
  sharedSecret: string;
  maxConcurrency: number;
  upstreamTimeoutMs: number;
}

export function readBridgeConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): BridgeConfig {
  const parsed = BridgeEnvironmentSchema.parse(environment);
  const upstreamUrl = new URL(parsed.UPSTREAM_BASE_URL);
  if (!/^https?:$/u.test(upstreamUrl.protocol)) {
    throw new Error("UPSTREAM_BASE_URL must be an HTTP(S) URL");
  }
  if (upstreamUrl.username || upstreamUrl.password) {
    throw new Error("UPSTREAM_BASE_URL must not contain embedded credentials");
  }
  if (
    upstreamUrl.protocol === "http:" &&
    !isLoopbackHost(upstreamUrl.hostname)
  ) {
    throw new Error("A public UPSTREAM_BASE_URL must use HTTPS");
  }
  return {
    host: "127.0.0.1",
    port: parsed.BRIDGE_PORT,
    upstreamBaseUrl: parsed.UPSTREAM_BASE_URL.replace(/\/+$/u, ""),
    upstreamApiKey: parsed.UPSTREAM_API_KEY,
    model: parsed.UPSTREAM_MODEL,
    sharedSecret: parsed.BRIDGE_SHARED_SECRET,
    maxConcurrency: parsed.BRIDGE_MAX_CONCURRENCY,
    upstreamTimeoutMs: parsed.BRIDGE_UPSTREAM_TIMEOUT_MS,
  };
}

function isLoopbackHost(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(hostname.toLowerCase());
}
