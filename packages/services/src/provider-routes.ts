import { randomUuid } from "@narralume/domain";

import {
  AssignmentRoleSchema,
  ModelAssignmentSchema,
  ModelConfigSchema,
  ProviderConnectionTestRequestSchema,
  PublicProviderSchema,
  SetAssignmentRequestSchema,
  UpdateModelRequestSchema,
  UpdateProviderRequestSchema,
  UpsertModelRequestSchema,
  UpsertProviderRequestSchema,
} from "@narralume/contracts";
import {
  ConfigurationVersionConflictError,
  PersistenceNotFoundError,
  SqliteAssignmentRepository,
  SqliteModelRepository,
  SqliteProviderRepository,
  publicProvider,
  type AssignmentRole,
  type NarrativeDatabase,
  type StoredModel,
  type StoredProvider,
} from "@narralume/persistence";
import { z } from "zod";

import type { RouteApp } from "@narralume/services";
import {
  testModelConnection,
  type ConnectionTestProfile,
  type ConnectionTestStage,
} from "@narralume/services";
import {
  requireProviderDeletable,
  requireProviderDisablable,
} from "@narralume/services";

const ProviderParamsSchema = z.object({ providerId: z.string().trim().min(1) });
const ModelParamsSchema = z.object({ modelId: z.string().trim().min(1) });
const AssignmentParamsSchema = z.object({ role: AssignmentRoleSchema });
const ModelListQuerySchema = z.object({
  providerId: z.string().trim().min(1).optional(),
});

/** Environment-seeded rows are managed by the server and cannot be deleted. */
const ENVIRONMENT_MANAGED_PREFIX = "environment-";
const MODEL_METADATA_STALE_MS = 90 * 24 * 60 * 60 * 1_000;

export interface RegisterProviderRouteOptions {
  environment: Readonly<Record<string, string | undefined>>;
}

export function registerProviderRoutes(
  app: RouteApp,
  database: NarrativeDatabase,
  options: RegisterProviderRouteOptions,
): void {
  const providers = new SqliteProviderRepository(database);
  const models = new SqliteModelRepository(database);
  const assignments = new SqliteAssignmentRepository(database);

  app.route("GET", "/api/providers", async () =>
    providers
      .list()
      .map((provider) => PublicProviderSchema.parse(publicProvider(provider))),
  );

  app.route("POST", "/api/providers", async (request) => {
    const input = UpsertProviderRequestSchema.parse(request.body);
    if (!input.credentialRef) {
      throw new ProviderRouteError(
        "provider.credential.required",
        "Creating a provider requires a credentialRef (a raw key or an env:NAME reference)",
        422,
      );
    }
    const now = new Date().toISOString();
    const provider = providers.upsert({
      id: randomUuid(),
      ...input,
      credentialRef: input.credentialRef,
      createdAt: now,
      updatedAt: now,
    });
    return {
      status: 201,
      body: PublicProviderSchema.parse(publicProvider(provider)),
    };
  });

  app.route("PUT", "/api/providers/:providerId", async (request) => {
    const { providerId } = ProviderParamsSchema.parse(request.params);
    const { expectedUpdatedAt, ...input } = UpdateProviderRequestSchema.parse(
      request.body,
    );
    const current = providers.get(providerId);
    if (!current) throw new PersistenceNotFoundError("provider", providerId);
    if (current.updatedAt !== expectedUpdatedAt) {
      throw new ConfigurationVersionConflictError("provider", providerId);
    }
    const next = {
      ...current,
      ...input,
      headers: preserveMaskedSecrets(input.headers, current.headers),
      queryParams: preserveMaskedSecrets(
        input.queryParams,
        current.queryParams,
      ),
      // An omitted credentialRef keeps the stored credential.
      credentialRef: input.credentialRef ?? current.credentialRef,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: nextUpdatedAt(current.updatedAt),
    };
    if (!next.enabled) {
      requireProviderDisablable(models, assignments, providerId);
    }
    const provider = providers.update(next, expectedUpdatedAt);
    return PublicProviderSchema.parse(publicProvider(provider));
  });

  app.route("DELETE", "/api/providers/:providerId", async (request) => {
    const { providerId } = ProviderParamsSchema.parse(request.params);
    requireProviderDeletable(
      providers,
      models,
      assignments,
      providerId,
      ENVIRONMENT_MANAGED_PREFIX,
    );
    const provider = providers.get(providerId);
    if (!provider) throw new PersistenceNotFoundError("provider", providerId);
    providers.delete(providerId);
    return { status: 204 };
  });

  app.route("POST", "/api/providers/test", async (request) => {
    const input = ProviderConnectionTestRequestSchema.parse(request.body);
    const provider = providers.get(input.providerId);
    if (!provider)
      throw new PersistenceNotFoundError("provider", input.providerId);
    const model = models.get(input.modelId);
    if (!model || model.providerId !== provider.id) {
      throw new PersistenceNotFoundError("model", input.modelId);
    }
    const startedAt = new Date().toISOString();
    const credential = resolveCredentialFromEnvironment(
      provider.credentialRef,
      options.environment,
    );
    if (!credential.ok) {
      return {
        providerId: provider.id,
        modelId: model.id,
        startedAt,
        finishedAt: new Date().toISOString(),
        stages: [
          {
            stage: "text",
            status: "failed",
            latencyMs: 0,
            detail: credential.reason,
          },
        ],
      };
    }
    const stages = await testModelConnection(
      toProbeProfile(provider, model),
      input,
      {
        ...options.environment,
        [PROBE_KEY_ENV]: credential.apiKey,
      },
    );
    // The probe only refreshes capability flags on the model row; wireApi and
    // every other stored field stay as configured. The probed structured tier
    // (native | json-mode | prompt | none) is stored additively as flags:
    // native/json-mode map to their own key, "prompt" is structuredOutput
    // without either flag, "none" is all three false.
    const structuredCapability = stages.find(
      (stage) => stage.stage === "structured-output",
    )?.capability;
    models.update(
      {
        ...model,
        capabilities: {
          ...model.capabilities,
          streaming: passed(stages, "stream"),
          tools: passed(stages, "tool"),
          structuredOutput: passed(stages, "structured-output"),
          structuredOutputNative: structuredCapability === "native",
          structuredOutputJsonMode: structuredCapability === "json-mode",
        },
        updatedAt: nextUpdatedAt(model.updatedAt),
      },
      model.updatedAt,
    );
    return {
      providerId: provider.id,
      modelId: model.id,
      startedAt,
      finishedAt: new Date().toISOString(),
      stages,
    };
  });

  app.route("GET", "/api/models", async (request) => {
    const query = ModelListQuerySchema.parse(request.query);
    const rows = query.providerId
      ? models.listByProvider(query.providerId)
      : models.list();
    return rows.map(modelResponse);
  });

  app.route("POST", "/api/models", async (request) => {
    const input = UpsertModelRequestSchema.parse(request.body);
    if (!providers.get(input.providerId)) {
      throw new PersistenceNotFoundError("provider", input.providerId);
    }
    ensureUniqueModel(models, input, null);
    const now = new Date().toISOString();
    const model = models.upsert({
      id: randomUuid(),
      ...input,
      metadataSource: "manual",
      metadataVerifiedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    return { status: 201, body: modelResponse(model) };
  });

  app.route("PUT", "/api/models/:modelId", async (request) => {
    const { modelId } = ModelParamsSchema.parse(request.params);
    const { expectedUpdatedAt, ...input } = UpdateModelRequestSchema.parse(
      request.body,
    );
    const current = models.get(modelId);
    if (!current) throw new PersistenceNotFoundError("model", modelId);
    if (current.updatedAt !== expectedUpdatedAt) {
      throw new ConfigurationVersionConflictError("model", modelId);
    }
    if (!providers.get(input.providerId)) {
      throw new PersistenceNotFoundError("provider", input.providerId);
    }
    ensureUniqueModel(models, input, modelId);
    if (
      modelHasRuntimeHistory(database, modelId) &&
      (input.providerId !== current.providerId ||
        input.modelId !== current.modelId ||
        input.taskType !== current.taskType)
    ) {
      throw new ProviderRouteError(
        "model.identity_in_use",
        "The model has run history, so its Provider, upstream model name, or task type cannot be changed; create a new model instead",
        409,
      );
    }
    const updatedAt = nextUpdatedAt(current.updatedAt);
    const next = {
      ...current,
      ...input,
      metadataSource: "manual" as const,
      metadataVerifiedAt: updatedAt,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt,
    };
    const assignedRoles = assignments
      .list()
      .filter((assignment) => assignment.modelId === modelId)
      .map((assignment) => assignment.role);
    for (const role of assignedRoles)
      assertAssignmentTarget(role, next, providers);
    return modelResponse(models.update(next, expectedUpdatedAt));
  });

  app.route("DELETE", "/api/models/:modelId", async (request) => {
    const { modelId } = ModelParamsSchema.parse(request.params);
    if (modelId.startsWith(ENVIRONMENT_MANAGED_PREFIX)) {
      throw new ProviderRouteError(
        "model.environment_managed",
        "Environment-managed models cannot be deleted; you can disable them instead",
        409,
      );
    }
    if (!models.get(modelId))
      throw new PersistenceNotFoundError("model", modelId);
    if (
      assignments.list().some((assignment) => assignment.modelId === modelId)
    ) {
      throw new ProviderRouteError(
        "model.assignment_in_use",
        "The model is still referenced by a model assignment; adjust the assignment first",
        409,
      );
    }
    if (modelHasRuntimeHistory(database, modelId)) {
      throw new ProviderRouteError(
        "model.history_in_use",
        "The model has run history and cannot be deleted; you can disable it instead",
        409,
      );
    }
    models.delete(modelId);
    return { status: 204 };
  });

  app.route("GET", "/api/assignments", async () =>
    assignments
      .list()
      .map((assignment) => ModelAssignmentSchema.parse(assignment)),
  );

  app.route("PUT", "/api/assignments/:role", async (request) => {
    const { role } = AssignmentParamsSchema.parse(request.params);
    const input = SetAssignmentRequestSchema.parse(request.body);
    return ModelAssignmentSchema.parse(
      assignments.set(role, input.modelId, new Date().toISOString()),
    );
  });

  app.route("DELETE", "/api/assignments/:role", async (request) => {
    const { role } = AssignmentParamsSchema.parse(request.params);
    if (!assignments.remove(role)) {
      throw new PersistenceNotFoundError("assignment", role);
    }
    return { status: 204 };
  });
}

function preserveMaskedSecrets(
  next: Record<string, string>,
  current: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(next).map(([key, value]) => [
      key,
      value.startsWith("••••") && key in current
        ? (current[key] ?? value)
        : value,
    ]),
  );
}

function nextUpdatedAt(current: string): string {
  const currentTime = Date.parse(current);
  return new Date(
    Math.max(Date.now(), Number.isFinite(currentTime) ? currentTime + 1 : 0),
  ).toISOString();
}

function modelResponse(model: StoredModel) {
  const verifiedAt = model.metadataVerifiedAt
    ? Date.parse(model.metadataVerifiedAt)
    : Number.NaN;
  return ModelConfigSchema.parse({
    ...model,
    metadataStale:
      !Number.isFinite(verifiedAt) ||
      Date.now() - verifiedAt > MODEL_METADATA_STALE_MS,
  });
}

function modelHasRuntimeHistory(
  database: NarrativeDatabase,
  modelId: string,
): boolean {
  return Boolean(
    database.raw
      .prepare(
        `SELECT 1 AS present FROM model_assignment_snapshots WHERE model_id = ?
         UNION ALL
         SELECT 1 AS present FROM llm_calls WHERE model_id = ?
         LIMIT 1`,
      )
      .get(modelId, modelId),
  );
}

function assertAssignmentTarget(
  role: AssignmentRole,
  model: StoredModel,
  providers: SqliteProviderRepository,
): void {
  const provider = providers.get(model.providerId);
  if (!model.enabled)
    throw new ProviderRouteError(
      "assignment.model.disabled",
      "An assigned model cannot be disabled",
      409,
    );
  if (!provider?.enabled)
    throw new ProviderRouteError(
      "assignment.provider.disabled",
      "The assigned model's Provider is disabled",
      409,
    );
  if (!assignmentCompatible(role, model.taskType))
    throw new ProviderRouteError(
      "assignment.task_type.mismatch",
      `A model with task type ${model.taskType} cannot be used for ${role}`,
      422,
    );
}

function assignmentCompatible(
  role: AssignmentRole,
  taskType: StoredModel["taskType"],
): boolean {
  const generation = new Set(["writing", "planning", "review"]);
  return (
    role === taskType || (generation.has(role) && generation.has(taskType))
  );
}

export class ProviderRouteError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "ProviderRouteError";
  }
}

/** Synthetic env var used to hand a resolved raw key to the probe. */
const PROBE_KEY_ENV = "NARRATIVE_CONNECTION_PROBE_API_KEY";

/**
 * Adapts a provider/model pair to the transport-neutral probe shape. The
 * credential is resolved by the caller and
 * passed through PROBE_KEY_ENV so raw keys never touch the database or logs.
 */
function toProbeProfile(
  provider: StoredProvider,
  model: StoredModel,
): ConnectionTestProfile {
  return {
    id: model.id,
    name: provider.name,
    protocol: provider.wireApi,
    baseUrl: provider.baseUrl,
    endpoint: provider.endpoint,
    model: model.modelId,
    apiKeyEnv: PROBE_KEY_ENV,
    anthropicVersion: provider.anthropicVersion,
    extraHeaders: provider.headers,
    queryParams: provider.queryParams,
    capabilities: model.capabilities,
  };
}

/**
 * resolveCredential reads process.env; routes resolve against the injected
 * environment instead so tests and embedders control configuration.
 */
function resolveCredentialFromEnvironment(
  credentialRef: string,
  environment: Readonly<Record<string, string | undefined>>,
): { ok: true; apiKey: string } | { ok: false; reason: string } {
  if (credentialRef.startsWith("env:")) {
    const name = credentialRef.slice("env:".length);
    const value = environment[name];
    if (value === undefined) {
      return {
        ok: false,
        reason: `Environment variable ${name} is not configured`,
      };
    }
    if (value.trim().length === 0) {
      return { ok: false, reason: `Environment variable ${name} is empty` };
    }
    return { ok: true, apiKey: value };
  }
  if (credentialRef.trim().length === 0) {
    return { ok: false, reason: "credentialRef is empty" };
  }
  return { ok: true, apiKey: credentialRef };
}

function ensureUniqueModel(
  models: SqliteModelRepository,
  input: { providerId: string; modelId: string; taskType: string },
  excludeId: string | null,
): void {
  const duplicate = models
    .listByProvider(input.providerId)
    .find(
      (candidate) =>
        candidate.modelId === input.modelId &&
        candidate.taskType === input.taskType &&
        candidate.id !== excludeId,
    );
  if (duplicate) {
    throw new ProviderRouteError(
      "model.duplicate",
      "A model with the same modelId and taskType already exists under this provider",
      409,
    );
  }
}

function passed(
  stages: readonly ConnectionTestStage[],
  stage: ConnectionTestStage["stage"],
): boolean {
  return stages.some(
    (candidate) => candidate.stage === stage && candidate.status === "passed",
  );
}
