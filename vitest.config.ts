import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Package exports point to dist, which coverage excludes. Resolve workspace
// imports to the same sources as direct unit-test imports, including subpaths.
const workspaceEntries = [
  "context",
  "contracts",
  "domain",
  "harness",
  "llm",
  "narrative",
  "persistence",
  "persistence/browser",
  "persistence/node",
  "services",
];

export default defineConfig({
  resolve: {
    alias: workspaceEntries.map((name) => {
      const [packageName, entry = "index"] = name.split("/");
      return {
        find: new RegExp(`^@narralume/${name}$`),
        replacement: fileURLToPath(
          new URL(`./packages/${packageName}/src/${entry}.ts`, import.meta.url),
        ),
      };
    }),
  },
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      reportsDirectory: "./coverage",
      reportOnFailure: true,
      // Keep the backend production-code denominator stable as tests change.
      // Coverage is a review aid; correctness is enforced by the test results.
      include: ["apps/*/src/**/*.{ts,tsx}", "packages/*/src/**/*.{ts,tsx}"],
      exclude: ["**/dist/**", "apps/web/**", "**/*.d.ts"],
    },
    include: [
      "apps/**/test/**/*.test.{ts,tsx}",
      "packages/**/test/**/*.test.{ts,tsx}",
    ],
    passWithNoTests: false,
    restoreMocks: true,
    testTimeout: 10_000,
  },
});
