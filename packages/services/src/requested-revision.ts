import type { RunSnapshot } from "@narralume/domain";
import { buildRequestedRevisionRecipe } from "@narralume/harness";
import {
  SqliteAutomationRepository,
  SqliteReviewRepository,
  SqliteRunRepository,
  type NarrativeDatabase,
} from "@narralume/persistence";

import { sha256Hex } from "./internal/crypto.js";
import { latestAwaitReason, RunServiceError } from "./run-policy.js";

export interface RequestedRevisionResult {
  snapshot: RunSnapshot;
  idempotentReplay: boolean;
  sessionId: string | null;
}

export function requestManuscriptRevision(
  database: NarrativeDatabase,
  input: {
    sourceRunId: string;
    requestId: string;
    instruction: string;
    now: string;
  },
): RequestedRevisionResult {
  const runs = new SqliteRunRepository(database);
  const automation = new SqliteAutomationRepository(database);
  const reviews = new SqliteReviewRepository(database);
  const revisionRunId = requestedRevisionRunId(
    input.sourceRunId,
    input.requestId,
  );
  const existing = runs.getRun(revisionRunId);
  if (existing) {
    if (
      existing.policy.revisionSourceRunId !== input.sourceRunId ||
      existing.policy.revisionRequestId !== input.requestId ||
      existing.policy.revisionInstruction !== input.instruction
    ) {
      throw new RunServiceError(
        "revision.idempotency_conflict",
        "The same requestId was already used for a different revision request",
        409,
      );
    }
    return {
      snapshot: runs.getSnapshot(revisionRunId),
      idempotentReplay: true,
      sessionId: automation.findRunLink(revisionRunId)?.sessionId ?? null,
    };
  }

  const source = runs.getSnapshot(input.sourceRunId);
  const sourceAwaitReason = latestAwaitReason(source);
  if (
    source.run.status !== "awaiting_user" ||
    ![
      "chapter_commit_approval_required",
      "critical_review_unresolved",
      "quality_gate_blocked",
      "semantic_review_blocked",
      "revision_limit_reached",
    ].includes(sourceAwaitReason ?? "")
  ) {
    throw new RunServiceError(
      "revision.source.not_awaiting_manuscript",
      "Only a chapter manuscript waiting for the author can be sent for another AI revision",
      409,
    );
  }
  if (!source.run.targetOutlineNodeId || !manuscriptContent(source)) {
    throw new RunServiceError(
      "revision.source.manuscript_missing",
      "The source run has no complete manuscript to revise",
      409,
    );
  }
  const link = automation.findRunLink(source.run.id);
  const inheritedPolicy: Record<string, unknown> = { ...source.run.policy };
  delete inheritedPolicy.chapterApproved;
  delete inheritedPolicy.planApproved;
  const recipe = buildRequestedRevisionRecipe(revisionRunId);

  const snapshot = database.transaction(() => {
    runs.setRunStatus(
      source.run.id,
      "cancelled",
      input.now,
      "manuscript_revision_requested",
    );
    reviews.supersedeRunRevisionProposals(source.run.id, input.now);
    const created = runs.create({
      id: revisionRunId,
      recipe: recipe.name,
      recipeVersion: recipe.version,
      mode: source.run.mode,
      projectId: source.run.projectId,
      targetOutlineNodeId: source.run.targetOutlineNodeId,
      policy: {
        ...inheritedPolicy,
        requestedRevision: true,
        revisionSourceRunId: source.run.id,
        revisionRequestId: input.requestId,
        revisionInstruction: input.instruction,
      },
      steps: recipe.steps,
      now: input.now,
    });
    if (link) {
      const session = automation.requireSession(link.sessionId);
      if (session.currentRunId !== source.run.id) {
        throw new RunServiceError(
          "revision.session.source_not_current",
          "The source manuscript is no longer the current chapter of the writing session",
          409,
        );
      }
      automation.markRunProcessed(
        link.sessionId,
        source.run.id,
        "revision_requested",
        input.now,
      );
      automation.attachRun(link.sessionId, {
        runId: revisionRunId,
        role: link.role,
        outlineNodeId: link.outlineNodeId,
        now: input.now,
      });
    }
    return created;
  });
  return {
    snapshot,
    idempotentReplay: false,
    sessionId: link?.sessionId ?? null,
  };
}

function requestedRevisionRunId(
  sourceRunId: string,
  requestId: string,
): string {
  const digest = sha256Hex(`${sourceRunId}\0${requestId}`);
  return `revision:${digest}`;
}

function manuscriptContent(snapshot: RunSnapshot): string {
  const output = [...snapshot.steps]
    .reverse()
    .find(
      (step) =>
        step.status === "succeeded" &&
        (step.kind === "revision.generate" || step.kind === "draft.generate"),
    )?.outputArtifact;
  return typeof output?.content === "string" ? output.content.trim() : "";
}
