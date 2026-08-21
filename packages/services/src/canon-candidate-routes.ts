import { sha256Hex } from "@narralume/domain";

import {
  CanonCandidateRunAcceptedSchema,
  CanonCandidateSetSchema,
  CanonSpreadSchema,
  CreateCanonCandidateRequestSchema,
  DecideCanonCandidateItemRequestSchema,
  DecideCanonCandidateItemResponseSchema,
} from "@narralume/contracts";
import { buildCanonCandidateRecipe } from "@narralume/harness";
import { CanonCandidateService } from "@narralume/narrative";
import {
  SqliteProjectRepository,
  SqliteRunRepository,
  type NarrativeDatabase,
} from "@narralume/persistence";
import { z } from "zod";

import type { RunCoordinator, RouteApp } from "@narralume/services";
import {
  requireWritingAssignment,
  withRuntimeModelPolicy,
} from "@narralume/services";

const SpreadParamsSchema = z.object({
  projectId: z.string().trim().min(1),
  spread: CanonSpreadSchema,
});
const CandidateParamsSchema = z.object({
  projectId: z.string().trim().min(1),
  candidateSetId: z.string().trim().min(1),
});
const CandidateItemParamsSchema = CandidateParamsSchema.extend({
  itemId: z.string().trim().min(1),
});

export interface RegisterCanonCandidateRouteOptions {
  runCoordinator: RunCoordinator;
  enableBackgroundWorker: boolean;
  environment: Readonly<Record<string, string | undefined>>;
}

export function registerCanonCandidateRoutes(
  app: RouteApp,
  database: NarrativeDatabase,
  options: RegisterCanonCandidateRouteOptions,
): void {
  const projects = new SqliteProjectRepository(database);
  const runs = new SqliteRunRepository(database);
  const candidates = new CanonCandidateService(database);

  app.route(
    "POST",
    "/api/projects/:projectId/canon-spreads/:spread/candidates",
    async (request) => {
      const { projectId, spread } = SpreadParamsSchema.parse(request.params);
      requireProject(projects, projectId);
      const input = CreateCanonCandidateRequestSchema.parse(request.body);
      const requestHash = hashStable({
        spread,
        instruction: input.instruction,
      });
      const runId = deterministicId(
        "canon-spread-candidate",
        `${projectId}:${spread}`,
        input.requestId,
      );
      const accepted = database.transaction(() => {
        const replay = runs.getRun(runId);
        if (replay) {
          if (
            replay.projectId !== projectId ||
            replay.policy.creationRequestHash !== requestHash
          ) {
            throw new CanonCandidateRouteError(
              "canon_candidate.idempotency_conflict",
              "The same requestId was already used for a different Canon candidate request",
              409,
            );
          }
          return { idempotentReplay: true };
        }

        const activeRun = runs
          .listActiveRuns(projectId)
          .find(
            (candidate) =>
              candidate.recipe === "canon-spread-candidate" &&
              candidate.policy.canonSpread === spread,
          );
        if (activeRun) {
          throw new CanonCandidateRouteError(
            "canon_candidate.active_run_exists",
            `The current Canon spread already has an active candidate run: ${activeRun.id}`,
            409,
          );
        }

        requireWritingAssignment(database, options.environment);
        const recipe = buildCanonCandidateRecipe(runId);
        const policy = withRuntimeModelPolicy(
          {
            canonSpread: spread,
            canonInstruction: input.instruction,
            canonMaxOutputTokens: 6_000,
            creationRequestId: input.requestId,
            creationRequestHash: requestHash,
            origin: { surface: "bible", canonSpread: spread },
          },
          options.environment,
        );
        runs.create({
          id: runId,
          projectId,
          recipe: recipe.name,
          recipeVersion: recipe.version,
          mode: "manual",
          targetOutlineNodeId: null,
          policy,
          steps: recipe.steps,
          now: new Date().toISOString(),
        });
        return { idempotentReplay: false };
      });
      if (!accepted.idempotentReplay && options.enableBackgroundWorker) {
        options.runCoordinator.wake();
      }
      return {
        status: 202,
        body: CanonCandidateRunAcceptedSchema.parse({
          runId,
          idempotentReplay: accepted.idempotentReplay,
        }),
      };
    },
  );

  app.route(
    "GET",
    "/api/projects/:projectId/canon-spreads/:spread/candidates",
    async (request) => {
      const { projectId, spread } = SpreadParamsSchema.parse(request.params);
      requireProject(projects, projectId);
      return candidates
        .list(projectId, spread)
        .map((candidate) => CanonCandidateSetSchema.parse(candidate));
    },
  );

  app.route(
    "GET",
    "/api/projects/:projectId/canon-candidates/:candidateSetId",
    async (request) => {
      const { projectId, candidateSetId } = CandidateParamsSchema.parse(
        request.params,
      );
      requireProject(projects, projectId);
      return CanonCandidateSetSchema.parse(
        candidates.get(projectId, candidateSetId),
      );
    },
  );

  app.route(
    "POST",
    "/api/projects/:projectId/canon-candidates/:candidateSetId/items/:itemId/decisions",
    async (request) => {
      const { projectId, candidateSetId, itemId } =
        CandidateItemParamsSchema.parse(request.params);
      requireProject(projects, projectId);
      const input = DecideCanonCandidateItemRequestSchema.parse(request.body);
      return DecideCanonCandidateItemResponseSchema.parse(
        candidates.decideItem({
          projectId,
          changeSetId: candidateSetId,
          itemId,
          action: input.action,
          confirmLocked: input.confirmLocked,
        }),
      );
    },
  );
}

function requireProject(projects: SqliteProjectRepository, projectId: string) {
  const project = projects.get(projectId);
  if (!project)
    throw new CanonCandidateRouteError(
      "project.not_found",
      "Project not found",
      404,
    );
  return project;
}

function deterministicId(
  kind: string,
  scope: string,
  requestId: string,
): string {
  const hex = sha256Hex(`${kind}\0${scope}\0${requestId}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function hashStable(value: unknown): string {
  return sha256Hex(stableJson(value));
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}

export class CanonCandidateRouteError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "CanonCandidateRouteError";
  }
}
