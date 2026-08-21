import { describe, expect, it } from "vitest";

import { readBridgeConfig } from "../src/config.js";

function environment(upstream: string) {
  return {
    UPSTREAM_API_KEY: "upstream-secret",
    BRIDGE_SHARED_SECRET: "bridge-secret-at-least-24-characters",
    UPSTREAM_BASE_URL: upstream,
    UPSTREAM_MODEL: "example-model",
  };
}

describe("Bridge upstream configuration", () => {
  it.each(["file:///tmp/model", "ftp://example.com/model"])(
    "rejects non-HTTP protocols: %s",
    (upstream) => {
      expect(() => readBridgeConfig(environment(upstream))).toThrow("HTTP(S)");
    },
  );

  it("rejects embedded credentials and public HTTP", () => {
    expect(() =>
      readBridgeConfig(environment("https://user:pass@example.com/v1")),
    ).toThrow("embedded credentials");
    expect(() =>
      readBridgeConfig(environment("http://example.com/v1")),
    ).toThrow("HTTPS");
  });

  it.each(["http://127.0.0.1:11434/v1", "https://api.example.com/v1"])(
    "allows safe upstream URL: %s",
    (upstream) => {
      expect(readBridgeConfig(environment(upstream)).upstreamBaseUrl).toBe(
        upstream,
      );
    },
  );
});
