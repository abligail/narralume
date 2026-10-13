import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  readSemanticUnit,
  scoredAcceptance,
  sha256Json,
  sha256Text,
  type StageResult,
} from "../../../scripts/narrative-memory-semantic-eval.js";

function completedReview(directory: string): StageResult {
  mkdirSync(directory, { recursive: true });
  const outputPath = join(directory, "output.json");
  writeFileSync(
    outputPath,
    JSON.stringify({
      artifactKind: "arc-review",
      output: { observations: [] },
    }),
  );
  const request = {
    purpose: "arc-review",
    request: { messages: [{ role: "user", content: "Frozen source prose" }] },
    contract: { name: "review" },
  };
  const requestHash = sha256Json(request);
  writeFileSync(
    join(directory, "request.json"),
    JSON.stringify({ ...request, requestHash }),
  );
  const result: StageResult = {
    stage: "review",
    status: "completed",
    runId: "run",
    requestHash,
    outputPath,
    artifactSha256: sha256Text(readFileSync(outputPath)),
    receiptPath: join(directory, "context-receipts.json"),
    ledger: {
      logicalCalls: 1,
      physicalAttempts: 2,
      repairAttempts: 1,
      transportErrors: 1,
    },
    error: null,
  };
  writeFileSync(join(directory, "result.json"), JSON.stringify(result));
  return result;
}

function accepted(result: StageResult): boolean {
  const grade = {
    caseId: "fixed-case",
    repeat: 1,
    stages: {
      review: {
        verdict: "pass" as const,
        notes: "Reviewed the complete input and output",
        outputPath: result.outputPath,
        artifactSha256: result.artifactSha256,
      },
    },
  };
  return scoredAcceptance(["review"], [result], grade, {
    reviewer: "Reviewer",
    reviewedAt: "2026-10-13T00:00:00Z",
    units: [grade],
  });
}

describe("semantic evaluation input integrity", () => {
  it.each(["missing", "changed-body", "changed-hash", "missing-result-hash"])(
    "rejects a completed stage with %s input evidence while preserving its output and cost",
    (corruption) => {
      const root = mkdtempSync(join(tmpdir(), "narralume-eval-input-"));
      try {
        const directory = join(root, "attempt-001", "review");
        const original = completedReview(directory);
        const outputBefore = readFileSync(original.outputPath!);
        expect(accepted(original)).toBe(true);
        const requestPath = join(directory, "request.json");
        if (corruption === "missing") rmSync(requestPath);
        else if (corruption === "missing-result-hash") {
          original.requestHash = null;
          writeFileSync(
            join(directory, "result.json"),
            JSON.stringify(original),
          );
        } else {
          const captured = JSON.parse(readFileSync(requestPath, "utf8")) as {
            request: { messages: { content: string }[] };
            requestHash: string;
          };
          if (corruption === "changed-body")
            captured.request.messages[0]!.content = "Different source prose";
          else captured.requestHash = "incorrect-hash";
          writeFileSync(requestPath, JSON.stringify(captured));
        }
        // A previously selected result must fail acceptance even before the unit
        // is re-read, if its saved input evidence has since changed.
        expect(accepted(original)).toBe(false);
        const unit = readSemanticUnit({
          caseId: "fixed-case",
          repeat: 1,
          unitDir: root,
          stages: ["review"],
          prepareOnly: false,
        });
        expect(unit.status).toBe("failed");
        expect(unit.executions[0]!.status).toBe("failed");
        expect(unit.stages[0]!.error).toMatchObject({
          code: "semantic_eval.output_invalid",
        });
        expect(unit.ledger).toEqual(original.ledger);
        expect(existsSync(original.outputPath!)).toBe(true);
        expect(readFileSync(original.outputPath!)).toEqual(outputBefore);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("selects the earliest completion with verifiable input and counts every saved attempt", () => {
    const root = mkdtempSync(join(tmpdir(), "narralume-eval-input-selection-"));
    try {
      const first = completedReview(join(root, "attempt-001", "review"));
      const valid = completedReview(join(root, "attempt-002", "review"));
      completedReview(join(root, "attempt-003", "review"));
      rmSync(join(root, "attempt-001", "review", "request.json"));
      const unit = readSemanticUnit({
        caseId: "fixed-case",
        repeat: 1,
        unitDir: root,
        stages: ["review"],
        prepareOnly: false,
      });
      expect(unit.status).toBe("completed");
      expect(unit.stages[0]!.outputPath).toBe(valid.outputPath);
      expect(unit.executions.map((execution) => execution.status)).toEqual([
        "failed",
        "completed",
        "completed",
      ]);
      expect(unit.ledger).toEqual({
        logicalCalls: 3,
        physicalAttempts: 6,
        repairAttempts: 3,
        transportErrors: 3,
      });
      expect(accepted(first)).toBe(false);
      expect(accepted(unit.stages[0]!)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
