import { sha256Hex, randomUuid } from "@narralume/domain";

import {
  AnalyzeImportRequestSchema,
  ApplyImportRequestSchema,
  BackgroundRunCreatedSchema,
  CreateBackupRequestSchema,
  CreateImportPreviewRequestSchema,
  CreateImportUploadRequestSchema,
  CreateStyleProfileRequestSchema,
  CreateWritingSkillRequestSchema,
  DecideImportCandidateRequestSchema,
  ImportBatchDetailSchema,
  ImportBatchSchema,
  ImportUploadSessionSchema,
  PutImportChunkRequestSchema,
  ProjectBackupSchema,
  ProjectQualityReportSchema,
  RestoreBackupRequestSchema,
  StyleProfileSchema,
  UpdateStyleProfileRequestSchema,
  UpdateWritingSkillRequestSchema,
  WritingSkillSchema,
  ImportWritingSkillPackageRequestSchema,
  ValidateWritingSkillRequestSchema,
  WritingSkillPackageSchema,
  WritingSkillValidationSchema,
} from "@narralume/contracts";
import type { StyleProfile, WritingSkill } from "@narralume/domain";
import { buildImportAnalysisRecipe } from "@narralume/harness";
import {
  SqliteDeliveryRepository,
  SqliteProjectRepository,
  SqliteRequestReplayRepository,
  SqliteRunRepository,
  type NarrativeDatabase,
} from "@narralume/persistence";
import { z } from "zod";

import {
  DeliveryService,
  type DeliveryServiceError,
} from "@narralume/services";
import type { RunCoordinator, RouteApp } from "@narralume/services";
import {
  deterministicRequestId,
  hashRequest,
  requireWritingAssignment,
  runProductProjection,
  withRuntimeModelPolicy,
  buildWritingSkillZip,
  parseWritingSkillPackage,
} from "@narralume/services";

const ProjectParamsSchema = z.object({ projectId: z.string().trim().min(1) });
const StyleParamsSchema = z.object({ styleId: z.string().trim().min(1) });
const SkillParamsSchema = z.object({ skillId: z.string().trim().min(1) });
const ImportParamsSchema = z.object({ batchId: z.string().trim().min(1) });
const CandidateParamsSchema = z.object({
  candidateId: z.string().trim().min(1),
});
const BackupParamsSchema = z.object({ backupId: z.string().trim().min(1) });
const ExportParamsSchema = z.object({
  projectId: z.string().trim().min(1),
  format: z.enum(["markdown", "text", "docx", "epub", "narrative-bundle"]),
});
const QueryBooleanSchema = z.preprocess(
  (value) => (value === "true" ? true : value === "false" ? false : value),
  z.boolean(),
);
const ExportQuerySchema = z.object({
  versionMode: z.enum(["current", "history"]).default("current"),
  includeAnnotations: QueryBooleanSchema.default(false),
  includeRuns: QueryBooleanSchema.default(false),
});
const UploadParamsSchema = z.object({ uploadId: z.string().trim().min(1) });
const UploadChunkParamsSchema = UploadParamsSchema.extend({
  chunkIndex: z.coerce.number().int().nonnegative(),
});

export function registerDeliveryRoutes(
  app: RouteApp,
  database: NarrativeDatabase,
  options: {
    coordinator: RunCoordinator;
    enableBackgroundWorker: boolean;
    environment: Readonly<Record<string, string | undefined>>;
  },
): void {
  const delivery = new SqliteDeliveryRepository(database);
  const projects = new SqliteProjectRepository(database);
  const requestReplays = new SqliteRequestReplayRepository(database);
  const runs = new SqliteRunRepository(database);
  const service = new DeliveryService(database);

  app.route("GET", "/api/projects/:projectId/styles", async (request) => {
    const { projectId } = ProjectParamsSchema.parse(request.params);
    requireProject(projects, projectId);
    return delivery
      .listStyleProfiles(projectId, true)
      .map((profile) => StyleProfileSchema.parse(profile));
  });

  app.route("POST", "/api/projects/:projectId/styles", async (request) => {
    const { projectId } = ProjectParamsSchema.parse(request.params);
    requireProject(projects, projectId);
    const input = CreateStyleProfileRequestSchema.parse(request.body);
    const now = new Date().toISOString();
    const profile: StyleProfile = {
      id: randomUuid(),
      projectId,
      ...input,
      source: "manual",
      status: "active",
      createdAt: now,
      updatedAt: now,
      version: 0,
    };
    return {
      status: 201,
      body: StyleProfileSchema.parse(delivery.insertStyleProfile(profile)),
    };
  });

  app.route("PUT", "/api/styles/:styleId", async (request) => {
    const { styleId } = StyleParamsSchema.parse(request.params);
    const { expectedVersion, ...input } = UpdateStyleProfileRequestSchema.parse(
      request.body,
    );
    return StyleProfileSchema.parse(
      delivery.updateStyleProfile(
        styleId,
        input,
        expectedVersion,
        new Date().toISOString(),
      ),
    );
  });

  app.route(
    "GET",
    "/api/projects/:projectId/writing-skills",
    async (request) => {
      const { projectId } = ProjectParamsSchema.parse(request.params);
      requireProject(projects, projectId);
      return delivery
        .listWritingSkills(projectId)
        .map((skill) => WritingSkillSchema.parse(skill));
    },
  );

  app.route(
    "POST",
    "/api/projects/:projectId/writing-skills",
    async (request) => {
      const { projectId } = ProjectParamsSchema.parse(request.params);
      requireProject(projects, projectId);
      const input = CreateWritingSkillRequestSchema.parse(request.body);
      const now = new Date().toISOString();
      const skill: WritingSkill = {
        id: randomUuid(),
        projectId,
        ...input,
        source: "manual",
        createdAt: now,
        updatedAt: now,
        version: 0,
      };
      return {
        status: 201,
        body: WritingSkillSchema.parse(delivery.insertWritingSkill(skill)),
      };
    },
  );

  app.route("PUT", "/api/writing-skills/:skillId", async (request) => {
    const { skillId } = SkillParamsSchema.parse(request.params);
    const { expectedVersion, ...input } = UpdateWritingSkillRequestSchema.parse(
      request.body,
    );
    return WritingSkillSchema.parse(
      delivery.updateWritingSkill(
        skillId,
        input,
        expectedVersion,
        new Date().toISOString(),
      ),
    );
  });

  app.route("DELETE", "/api/writing-skills/:skillId", async (request) => {
    const { skillId } = SkillParamsSchema.parse(request.params);
    if (!delivery.getWritingSkill(skillId))
      throw new DeliveryRouteError(
        "skill.not_found",
        "Writing skill not found",
        404,
      );
    delivery.deleteWritingSkill(skillId);
    return { status: 204 };
  });

  app.route(
    "POST",
    "/api/projects/:projectId/writing-skills/import",
    async (request) => {
      const { projectId } = ProjectParamsSchema.parse(request.params);
      requireProject(projects, projectId);
      const input = ImportWritingSkillPackageRequestSchema.parse(request.body);
      const parsed = await parseWritingSkillPackage(
        input.filename,
        Buffer.from(input.contentBase64, "base64"),
      );
      const now = new Date().toISOString();
      const skill: WritingSkill = {
        id: randomUuid(),
        projectId,
        name: parsed.name,
        description: parsed.description,
        instructions: parsed.instructions,
        scopes: parsed.scopes,
        priority: parsed.priority,
        enabled: true,
        source: `skill-package:${input.filename}`,
        createdAt: now,
        updatedAt: now,
        version: 0,
      };
      const references = parsed.references.map((reference) => ({
        id: randomUuid(),
        path: reference.path,
        content: reference.content,
        contentHash: sha256Hex(reference.content),
        createdAt: now,
      }));
      database.transaction(() => {
        delivery.insertWritingSkill(skill);
        delivery.replaceWritingSkillReferences(skill.id, references);
      });
      return {
        status: 201,
        body: WritingSkillPackageSchema.parse({
          skill,
          references: delivery.listWritingSkillReferences(skill.id),
        }),
      };
    },
  );

  app.route("GET", "/api/writing-skills/:skillId/package", async (request) => {
    const { skillId } = SkillParamsSchema.parse(request.params);
    const skill = delivery.getWritingSkill(skillId);
    if (!skill)
      throw new DeliveryRouteError(
        "skill.not_found",
        "Writing skill not found",
        404,
      );
    const bytes = await buildWritingSkillZip(
      skill,
      delivery.listWritingSkillReferences(skill.id),
    );
    return {
      status: 200,
      body: bytes,
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${skill.name}.skill.zip`)}`,
      },
    };
  });

  app.route(
    "POST",
    "/api/writing-skills/:skillId/validate",
    async (request) => {
      const { skillId } = SkillParamsSchema.parse(request.params);
      const input = ValidateWritingSkillRequestSchema.parse(request.body);
      const skill = delivery.getWritingSkill(skillId);
      if (!skill)
        throw new DeliveryRouteError(
          "skill.not_found",
          "Writing skill not found",
          404,
        );
      const applicable =
        skill.scopes.includes("all") || skill.scopes.includes(input.scope);
      const checks = [
        {
          id: "instructions",
          passed: skill.instructions.trim().length >= 20,
          message:
            skill.instructions.trim().length >= 20
              ? "Instructions are long enough to assemble"
              : "Instructions are too short",
        },
        {
          id: "scope",
          passed: applicable,
          message: applicable
            ? `Will be assembled in the "${input.scope}" scope`
            : `Will not be assembled in the "${input.scope}" scope`,
        },
        {
          id: "references",
          passed: delivery
            .listWritingSkillReferences(skill.id)
            .every((reference) => reference.contentHash.length === 64),
          message: "All references have a content hash",
        },
      ];
      return WritingSkillValidationSchema.parse({
        valid: checks.every((check) => check.passed),
        applicable,
        scope: input.scope,
        checks,
      });
    },
  );

  app.route("POST", "/api/imports/preview", async (request) => {
    const input = CreateImportPreviewRequestSchema.parse(request.body);
    const detail = await service.previewImport({
      ...input,
      now: new Date().toISOString(),
    });
    return { status: 201, body: ImportBatchDetailSchema.parse(detail) };
  });

  app.route("POST", "/api/import-uploads", async (request) => {
    const input = CreateImportUploadRequestSchema.parse(request.body);
    const session = service.createUpload({
      id: randomUuid(),
      ...input,
      now: new Date().toISOString(),
    });
    return { status: 201, body: ImportUploadSessionSchema.parse(session) };
  });

  app.route(
    "PUT",
    "/api/import-uploads/:uploadId/chunks/:chunkIndex",
    async (request) => {
      const { uploadId, chunkIndex } = UploadChunkParamsSchema.parse(
        request.params,
      );
      const input = PutImportChunkRequestSchema.parse(request.body);
      return ImportUploadSessionSchema.parse(
        service.putUploadChunk({
          sessionId: uploadId,
          chunkIndex,
          ...input,
          now: new Date().toISOString(),
        }),
      );
    },
  );

  app.route(
    "POST",
    "/api/import-uploads/:uploadId/complete",
    async (request) => {
      const { uploadId } = UploadParamsSchema.parse(request.params);
      const result = await service.completeUpload(
        uploadId,
        new Date().toISOString(),
      );
      return {
        status: 201,
        body: {
          session: ImportUploadSessionSchema.parse(result.session),
          detail: ImportBatchDetailSchema.parse(result.detail),
        },
      };
    },
  );

  app.route("GET", "/api/projects/:projectId/imports", async (request) => {
    const { projectId } = ProjectParamsSchema.parse(request.params);
    requireProject(projects, projectId);
    return delivery
      .listImportBatches(projectId)
      .map((batch) => ImportBatchSchema.parse(batch));
  });

  app.route("GET", "/api/imports/:batchId", async (request) => {
    const { batchId } = ImportParamsSchema.parse(request.params);
    const detail = delivery.getImportBatchDetail(batchId);
    if (!detail)
      throw new DeliveryRouteError(
        "import.not_found",
        "Import batch not found",
        404,
      );
    return ImportBatchDetailSchema.parse(detail);
  });

  app.route("PUT", "/api/import-candidates/:candidateId", async (request) => {
    const { candidateId } = CandidateParamsSchema.parse(request.params);
    const input = DecideImportCandidateRequestSchema.parse(request.body);
    return database.transaction(() => {
      const candidate = delivery.requireImportCandidate(candidateId);
      const batch = delivery.requireImportBatch(candidate.batchId);
      if (["applied", "discarded"].includes(batch.status)) {
        throw new DeliveryRouteError(
          "import.candidate.batch_terminal",
          "The import batch has ended and candidate states can no longer be changed",
          409,
        );
      }
      delivery.setCandidateStatus(
        candidateId,
        input.status,
        new Date().toISOString(),
      );
      return ImportBatchDetailSchema.parse(
        delivery.getImportBatchDetail(candidate.batchId),
      );
    });
  });

  app.route("POST", "/api/imports/:batchId/analyze", async (request) => {
    const { batchId } = ImportParamsSchema.parse(request.params);
    const input = AnalyzeImportRequestSchema.parse(request.body);
    const batch = delivery.requireImportBatch(batchId);
    const requestHash = hashRequest(input);
    const runId = deterministicRequestId(
      "import-analysis-run",
      batchId,
      input.requestId,
    );
    const replay = runs.getRun(runId) ? runs.getSnapshot(runId) : null;
    if (replay) {
      if (replay.run.policy.creationRequestHash !== requestHash) {
        throw new DeliveryRouteError(
          "import.analysis.idempotency_conflict",
          "The same requestId was already used for a different import analysis request",
          409,
        );
      }
      return {
        status: 202,
        body: BackgroundRunCreatedSchema.parse({
          ...replay,
          ...runProductProjection(replay),
        }),
      };
    }
    if (!batch.targetProjectId) {
      throw new DeliveryRouteError(
        "import.analysis.target_required",
        "AI splitting requires a target project",
        409,
      );
    }
    const targetProjectId = batch.targetProjectId;
    if (batch.format === "narrative-bundle") {
      throw new DeliveryRouteError(
        "import.analysis.not_needed",
        "A complete project bundle does not need splitting",
        409,
      );
    }
    const previousRun = batch.analysisRunId
      ? runs.getRun(batch.analysisRunId)
      : null;
    const retryingFailedAnalysis =
      batch.status === "analyzing" &&
      previousRun !== null &&
      ["failed", "cancelled"].includes(previousRun.status);
    if (batch.status !== "previewed" && !retryingFailedAnalysis) {
      throw new DeliveryRouteError(
        "import.analysis.not_available",
        batch.status === "analyzing"
          ? "The import batch already has an analysis run in progress"
          : "The import batch cannot be re-analyzed right now",
        409,
      );
    }
    requireWritingAssignment(database, options.environment);
    const recipe = buildImportAnalysisRecipe(runId);
    const importChunkCharacters = 60_000;
    const now = new Date().toISOString();
    const snapshot = database.transaction(() => {
      const created = runs.create({
        id: runId,
        projectId: targetProjectId,
        recipe: recipe.name,
        recipeVersion: recipe.version,
        mode: "manual",
        targetOutlineNodeId: null,
        policy: withRuntimeModelPolicy(
          {
            batchId,
            creationRequestId: input.requestId,
            creationRequestHash: requestHash,
            contextWindow: 32_000,
            analysisMaxOutputTokens: 16_000,
            importChunkCharacters,
            origin: {
              surface: "import",
              documentId: null,
              selection: null,
            },
            ...input.policy,
          },
          options.environment,
        ),
        steps: recipe.steps,
        now,
      });
      delivery.updateImportBatch(
        batchId,
        { status: "analyzing", analysisRunId: runId },
        now,
      );
      return created;
    });
    if (options.enableBackgroundWorker) options.coordinator.wake();
    return {
      status: 202,
      body: BackgroundRunCreatedSchema.parse({
        ...snapshot,
        ...runProductProjection(snapshot),
      }),
    };
  });

  app.route("POST", "/api/imports/:batchId/actions", async (request) => {
    const { batchId } = ImportParamsSchema.parse(request.params);
    const input = ApplyImportRequestSchema.parse(request.body);
    if (input.action === "discard") {
      const batch = delivery.requireImportBatch(batchId);
      const now = new Date().toISOString();
      const detail = database.transaction(() => {
        if (batch.analysisRunId) {
          const run = runs.getRun(batch.analysisRunId);
          if (
            run &&
            !["completed", "failed", "cancelled"].includes(run.status)
          ) {
            runs.requestCancel(run.id, now);
          }
        }
        return service.discardImport(batchId, now);
      });
      if (batch.analysisRunId) {
        options.coordinator.interrupt(batch.analysisRunId, "import_discarded");
      }
      return ImportBatchDetailSchema.parse(detail);
    }
    const result = service.applyImport({
      batchId,
      selectedCandidateIds: input.selectedCandidateIds,
      ...(input.projectTitle ? { projectTitle: input.projectTitle } : {}),
      now: new Date().toISOString(),
    });
    return {
      projectId: result.projectId,
      detail: ImportBatchDetailSchema.parse(result.detail),
    };
  });

  app.route(
    "GET",
    "/api/projects/:projectId/exports/:format",
    async (request) => {
      const { projectId, format } = ExportParamsSchema.parse(request.params);
      const exportOptions = ExportQuerySchema.parse(request.query);
      const result = await service.exportProject(
        projectId,
        format,
        new Date().toISOString(),
        exportOptions,
      );
      return {
        status: 200,
        body: result.bytes,
        headers: {
          "content-type": result.mimeType,
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`,
          "content-length": String(result.bytes.length),
        },
      };
    },
  );

  app.route("GET", "/api/projects/:projectId/backups", async (request) => {
    const { projectId } = ProjectParamsSchema.parse(request.params);
    requireProject(projects, projectId);
    return delivery
      .listBackups(projectId)
      .map((backup) => ProjectBackupSchema.parse(backup));
  });

  app.route("POST", "/api/projects/:projectId/backups", async (request) => {
    const { projectId } = ProjectParamsSchema.parse(request.params);
    requireProject(projects, projectId);
    const input = CreateBackupRequestSchema.parse(request.body);
    return {
      status: 201,
      body: ProjectBackupSchema.parse(
        service.createBackup(projectId, input.label, new Date().toISOString()),
      ),
    };
  });

  app.route("POST", "/api/backups/:backupId/restore", async (request) => {
    const { backupId } = BackupParamsSchema.parse(request.params);
    const input = RestoreBackupRequestSchema.parse(request.body);
    const value = database.transaction(() => {
      const scope = `backup:${backupId}:restore`;
      const requestHash = hashRequest({ title: input.title ?? null });
      const replay = requestReplays.get<{
        projectId: string;
        backup: unknown;
        counts: unknown;
      }>(scope, input.requestId);
      if (replay) {
        if (replay.requestHash !== requestHash) {
          throw new DeliveryRouteError(
            "backup.restore.idempotency_conflict",
            "The same requestId was already used for a different backup restore request",
            409,
          );
        }
        return {
          projectId: replay.result.projectId,
          backup: ProjectBackupSchema.parse(replay.result.backup),
          counts: replay.result.counts,
        };
      }
      const result = service.restoreBackup(
        backupId,
        input.title,
        new Date().toISOString(),
      );
      const response = {
        projectId: result.projectId,
        backup: ProjectBackupSchema.parse(result.backup),
        counts: result.counts,
      };
      requestReplays.insert({
        scope,
        requestId: input.requestId,
        requestHash,
        result: response,
        createdAt: new Date().toISOString(),
      });
      return response;
    });
    return { status: 201, body: value };
  });

  app.route("GET", "/api/projects/:projectId/quality", async (request) => {
    const { projectId } = ProjectParamsSchema.parse(request.params);
    return ProjectQualityReportSchema.parse(
      service.qualityReport(projectId, new Date().toISOString()),
    );
  });
}

export class DeliveryRouteError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "DeliveryRouteError";
  }
}

export function deliveryErrorStatus(error: DeliveryServiceError) {
  return error.code.endsWith("not_found") ? 404 : 422;
}

function requireProject(projects: SqliteProjectRepository, projectId: string) {
  if (!projects.get(projectId)) {
    throw new DeliveryRouteError("project.not_found", "Project not found", 404);
  }
}
