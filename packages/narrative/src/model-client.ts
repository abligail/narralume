import { randomUuid, sha256Hex } from "@narralume/domain";

import { estimateTokens } from "@narralume/context";
import type {
  NarrativeRun,
  NarrativeRunStep,
  RunBudgetUsage,
  RunStepError,
} from "@narralume/domain";
import {
  createModelAdapter,
  collectModelEvents,
  generateOpenAIEmbeddings,
  ModelError,
  ModelGateway,
  StructuredOutputError,
  structuredTierPlan,
  type AdapterConfig,
  type FinishReason,
  type FetchLike,
  type JsonSchemaContract,
  type ModelCallTiming,
  type ModelProtocol,
  type ModelRequest,
  type ModelEvent,
  type NormalizedUsage,
  type StructuredValidator,
  type StructuredMode,
} from "@narralume/llm";
import {
  SqliteAssignmentRepository,
  SqliteLlmCallRepository,
  SqliteModelAssignmentSnapshotRepository,
  SqliteModelRepository,
  SqliteProviderRepository,
  SqliteRunRepository,
  publicProvider,
  type AssignmentRole,
  type NarrativeDatabase,
  type ResolvedCredential,
  type ResolvedModelAssignment,
  type StoredModel,
  type StoredProvider,
} from "@narralume/persistence";

type ModelRole =
  "planning" | "drafting" | "review" | "revision" | "settlement" | "analysis";

export interface NarrativeTextResult {
  text: string;
  usage: RunBudgetUsage;
  finishReason?: FinishReason;
}

export interface NarrativeStructuredResult<T> {
  value: T;
  usage: RunBudgetUsage;
  mode: "native" | "json-mode" | "prompt" | "repair";
  attempts: number;
}

export interface NarrativeEmbeddingResult {
  vectors: number[][];
  model: string;
  modelId: string;
  usage: RunBudgetUsage;
}

export interface NarrativeModelClient {
  text(
    run: NarrativeRun,
    step: NarrativeRunStep,
    purpose: string,
    request: Omit<ModelRequest, "model">,
    signal: AbortSignal,
  ): Promise<NarrativeTextResult>;
  structured<T>(
    run: NarrativeRun,
    step: NarrativeRunStep,
    purpose: string,
    request: Omit<ModelRequest, "model" | "responseSchema">,
    contract: JsonSchemaContract,
    validate: StructuredValidator<T>,
    signal: AbortSignal,
  ): Promise<NarrativeStructuredResult<T>>;
  embed?(
    run: NarrativeRun,
    step: NarrativeRunStep,
    purpose: string,
    request: { inputs: readonly string[] },
    signal: AbortSignal,
  ): Promise<NarrativeEmbeddingResult>;
  /**
   * True when an explicit embedding assignment is configured.
   */
  hasEmbeddingAssignment?(): boolean;
  /** Model-aware context ceiling for prompt compilation. */
  effectiveContextWindow?(run: NarrativeRun, purpose: string): number;
  /** Model- and role-aware output ceiling for context reserve planning. */
  effectiveOutputLimit?(run: NarrativeRun, purpose: string): number;
  /** Stable, non-secret model declaration key for context receipt reuse. */
  contextMaterializationKey?(run: NarrativeRun, purpose: string): string;
}

export class GatewayNarrativeModelClient implements NarrativeModelClient {
  private readonly calls: SqliteLlmCallRepository;
  private readonly assignments: SqliteAssignmentRepository;
  private readonly assignmentSnapshots: SqliteModelAssignmentSnapshotRepository;
  private readonly runs: SqliteRunRepository;
  private readonly models: SqliteModelRepository;
  private readonly providers: SqliteProviderRepository;

  constructor(
    private readonly database: NarrativeDatabase,
    private readonly environment: Readonly<
      Record<string, string | undefined>
    > = {},
    private readonly observe?: (
      runId: string,
      stepId: string,
      event: ModelEvent,
    ) => void,
    private readonly fetcher?: FetchLike,
  ) {
    this.calls = new SqliteLlmCallRepository(database);
    this.assignments = new SqliteAssignmentRepository(database);
    this.assignmentSnapshots = new SqliteModelAssignmentSnapshotRepository(
      database,
    );
    this.runs = new SqliteRunRepository(database);
    this.models = new SqliteModelRepository(database);
    this.providers = new SqliteProviderRepository(database);
  }

  async text(
    run: NarrativeRun,
    step: NarrativeRunStep,
    purpose: string,
    request: Omit<ModelRequest, "model">,
    signal: AbortSignal,
  ): Promise<NarrativeTextResult> {
    const candidates = this.resolveCandidates(run, step, purpose);
    let lastError: RunStepError | null = null;
    let failedUsage = emptyBudgetUsage();
    for (const candidate of candidates) {
      const fullRequest = applyRuntimeRequest(
        run,
        purpose,
        {
          ...request,
          model: candidate.model,
          promptCacheKey:
            request.promptCacheKey ?? promptCacheKey(run.projectId, purpose),
          cacheControl: request.cacheControl ?? { type: "ephemeral" },
        },
        candidate.runtime,
      );
      candidate.recordSnapshot(
        snapshotRuntime(
          run,
          purpose,
          fullRequest,
          candidate.runtime,
          {},
          positiveInteger(request.maxOutputTokens),
        ),
      );
      const call = this.begin(run, step, purpose, fullRequest, candidate);
      const logicalCall = createLogicalCallScope(
        candidate.logicalCallDeadlineMs,
        signal,
      );
      try {
        const response = await withProviderPermit(
          candidate.providerKey,
          logicalCall.signal,
          async () => {
            const events = candidate.gateway.stream(fullRequest, {
              signal: logicalCall.signal,
              stream: true,
            });
            return collectModelEvents(this.observed(events, run.id, step.id));
          },
        );
        const durationMs = Date.now() - call.started;
        this.calls.complete(call.id, {
          ...(response.responseId ? { responseId: response.responseId } : {}),
          finishReason: response.finishReason,
          usage: response.usage,
          ttftMs: roundedTimingMs(response.timing?.timeToFirstTokenMs),
          durationMs,
          finishedAt: new Date().toISOString(),
          details: {
            physicalAttempts: candidate.physicalAttempts(),
            ...tokenEstimateDetails(fullRequest, response.usage),
            ...timingDetails(response.timing).details,
          },
        });
        candidate.recordSnapshot(
          snapshotRuntime(
            run,
            purpose,
            fullRequest,
            candidate.runtime,
            {},
            positiveInteger(request.maxOutputTokens),
          ),
        );
        logicalCall.dispose();
        return {
          text: response.text,
          finishReason: response.finishReason,
          usage: addBudgetUsage(
            failedUsage,
            budgetUsage(
              response.usage,
              durationMs,
              candidate.physicalAttempts(),
              pricingFor(run, candidate.pricingId),
            ),
          ),
        };
      } catch (error) {
        const scopedError = logicalCall.normalizeError(error, signal);
        logicalCall.dispose();
        this.recordFailure(
          call.id,
          call.started,
          scopedError,
          signal.aborted,
          candidate.physicalAttempts(),
        );
        const normalized = modelStepError(scopedError, signal.aborted);
        failedUsage = addBudgetUsage(
          failedUsage,
          pricedFailureUsage(
            scopedError,
            normalized,
            Date.now() - call.started,
            candidate.physicalAttempts(),
            pricingFor(run, candidate.pricingId),
          ),
        );
        lastError = { ...normalized, usage: failedUsage };
        if (signal.aborted) break;
      }
    }
    throw lastError!;
  }

  hasEmbeddingAssignment(): boolean {
    return this.assignments.resolve("embedding") !== null;
  }

  effectiveContextWindow(run: NarrativeRun, purpose: string): number {
    const requested = positiveInteger(run.policy.contextWindow) ?? 64_000;
    const role = modelRoleForPurpose(purpose);
    const assigned = this.resolveRunAssignment(run, purpose, role);
    if (!assigned?.model.contextWindow) return requested;
    return Math.min(requested, assigned.model.contextWindow);
  }

  effectiveOutputLimit(run: NarrativeRun, purpose: string): number {
    const role = modelRoleForPurpose(purpose);
    const assigned = this.resolveRunAssignment(run, purpose, role);
    const workLimit = roleOutputLimit(run, purpose) ?? 16_000;
    return assigned?.model.maxOutputTokens
      ? Math.min(workLimit, assigned.model.maxOutputTokens)
      : workLimit;
  }

  contextMaterializationKey(run: NarrativeRun, purpose: string): string {
    const role = modelRoleForPurpose(purpose);
    const alreadyFrozen = this.assignmentSnapshots.get(run.id, purpose);
    const resolved = this.resolveRunAssignment(run, purpose, role);
    if (!resolved) return `unassigned:${role}`;
    if (!alreadyFrozen) {
      this.recordAssignmentSnapshot(run, purpose, role, resolved);
    }
    return stableJson({
      requestedRole: role,
      assignmentRole: resolved.role,
      modelId: resolved.model.id,
      contextWindow: resolved.model.contextWindow,
      maxOutputTokens: resolved.model.maxOutputTokens,
      metadataSource: resolved.model.metadataSource,
      metadataVerifiedAt: resolved.model.metadataVerifiedAt,
      modelUpdatedAt: resolved.model.updatedAt,
    });
  }

  async embed(
    run: NarrativeRun,
    step: NarrativeRunStep,
    purpose: string,
    request: { inputs: readonly string[] },
    signal: AbortSignal,
  ): Promise<NarrativeEmbeddingResult> {
    const snapshotPurpose = `${purpose}:embedding`;
    const resolved = this.resolveSnapshotAssignment(
      run,
      snapshotPurpose,
      "embedding",
    );
    if (!resolved)
      throw <RunStepError>{
        code: "model.embedding_assignment.unavailable",
        message: "No usable embedding model assignment is configured",
        retryable: false,
      };
    return this.embedViaAssignment(
      run,
      step,
      purpose,
      request,
      resolved,
      signal,
      snapshotPurpose,
    );
  }

  private async embedViaAssignment(
    run: NarrativeRun,
    step: NarrativeRunStep,
    purpose: string,
    request: { inputs: readonly string[] },
    resolved: ResolvedModelAssignment,
    signal: AbortSignal,
    snapshotPurpose: string,
  ): Promise<NarrativeEmbeddingResult> {
    const { model, provider } = resolved;
    if (provider.wireApi === "anthropic-messages") {
      throw <RunStepError>{
        code: "model.embedding_profile.unavailable",
        message: `Provider "${provider.name}" with the ${provider.wireApi} wire API does not support embeddings`,
        retryable: false,
      };
    }
    const credential = resolveCredentialForEnvironment(
      provider,
      this.environment,
    );
    if (!credential.ok) throw credentialStepError(provider, credential);
    const physicalAttempts = createPhysicalAttemptCounter();
    const call = this.beginEmbedding(
      run,
      step,
      purpose,
      { model: model.modelId, inputs: request.inputs },
      { callModelId: model.id, callProtocol: provider.wireApi },
    );
    const logicalCall = createLogicalCallScope(
      resolveRuntimeTimeouts(run, provider).logicalCallDeadlineMs.value,
      signal,
    );
    try {
      const response = await withProviderPermit(
        provider.id,
        logicalCall.signal,
        () =>
          generateOpenAIEmbeddings(
            this.assignmentAdapterConfig(
              run,
              step,
              provider,
              credential.apiKey,
              physicalAttempts,
            ),
            model.modelId,
            request.inputs,
            logicalCall.signal,
          ),
      );
      const durationMs = Date.now() - call.started;
      this.calls.complete(call.id, {
        finishReason: "stop",
        usage: response.usage,
        durationMs,
        finishedAt: new Date().toISOString(),
        details: { physicalAttempts: physicalAttempts.count },
      });
      this.recordAssignmentSnapshot(
        run,
        snapshotPurpose,
        "embedding",
        resolved,
      );
      logicalCall.dispose();
      return {
        vectors: response.vectors,
        model: model.modelId,
        modelId: model.id,
        usage: budgetUsage(
          response.usage,
          durationMs,
          physicalAttempts.count,
          pricingFor(run, model.id),
        ),
      };
    } catch (error) {
      const scopedError = logicalCall.normalizeError(error, signal);
      logicalCall.dispose();
      this.recordFailure(
        call.id,
        call.started,
        scopedError,
        signal.aborted,
        physicalAttempts.count,
      );
      const normalized = modelStepError(scopedError, signal.aborted);
      throw {
        ...normalized,
        usage: pricedFailureUsage(
          scopedError,
          normalized,
          Date.now() - call.started,
          physicalAttempts.count,
          pricingFor(run, model.id),
        ),
      };
    }
  }

  private async *observed(
    events: AsyncIterable<ModelEvent>,
    runId: string,
    stepId: string,
  ): AsyncGenerator<ModelEvent> {
    for await (const event of events) {
      this.observe?.(runId, stepId, event);
      yield event;
    }
  }

  async structured<T>(
    run: NarrativeRun,
    step: NarrativeRunStep,
    purpose: string,
    request: Omit<ModelRequest, "model" | "responseSchema">,
    contract: JsonSchemaContract,
    validate: StructuredValidator<T>,
    signal: AbortSignal,
  ): Promise<NarrativeStructuredResult<T>> {
    const candidates = this.resolveCandidates(run, step, purpose);
    let lastError: RunStepError | null = null;
    let failedUsage = emptyBudgetUsage();
    for (const candidate of candidates) {
      const fullRequest = applyRuntimeRequest(
        run,
        purpose,
        {
          ...request,
          model: candidate.model,
          responseSchema: contract,
          promptCacheKey:
            request.promptCacheKey ?? promptCacheKey(run.projectId, purpose),
          cacheControl: request.cacheControl ?? { type: "ephemeral" },
        },
        candidate.runtime,
      );
      const allowedModes = structuredTierPlan(candidate.runtime.capabilities);
      candidate.recordSnapshot(
        snapshotRuntime(
          run,
          purpose,
          fullRequest,
          candidate.runtime,
          {
            structuredTierPlan: allowedModes,
          },
          positiveInteger(request.maxOutputTokens),
        ),
      );
      const call = this.begin(run, step, purpose, fullRequest, candidate);
      const logicalCall = createLogicalCallScope(
        candidate.logicalCallDeadlineMs,
        signal,
      );
      // Physical repair calls are not individually ledgered (one llm_calls
      // row per logical structured call), so repairs are first-class run
      // events and their count lands in the row's details_json.
      let repairAttempts = 0;
      try {
        const result = await withProviderPermit(
          candidate.providerKey,
          logicalCall.signal,
          () =>
            candidate.gateway.generateStructured(fullRequest, validate, {
              signal: logicalCall.signal,
              maxRepairAttempts: structuredMaxRepairAttempts(run),
              allowedModes,
              onAttempt: (event) => {
                if (event.mode === "repair") {
                  repairAttempts += 1;
                  this.runs.appendRunEvent(
                    run.id,
                    step.id,
                    "run.llm.repair_attempt",
                    {
                      purpose,
                      attempt: event.attempt,
                      mode: event.mode,
                      valid: event.valid,
                      issues: event.issues.slice(0, 10),
                    },
                    new Date().toISOString(),
                  );
                }
                this.observe?.(run.id, step.id, {
                  type: "structured.attempt",
                  attempt: event.attempt,
                  mode: event.mode,
                  valid: event.valid,
                  ...(event.issues.length > 0
                    ? { issues: event.issues.slice(0, 10) }
                    : {}),
                });
              },
            }),
        );
        const durationMs = Date.now() - call.started;
        this.calls.complete(call.id, {
          ...(result.response.responseId
            ? { responseId: result.response.responseId }
            : {}),
          finishReason: result.response.finishReason,
          usage: result.usage,
          ttftMs: roundedTimingMs(result.response.timing?.timeToFirstTokenMs),
          durationMs,
          finishedAt: new Date().toISOString(),
          details: {
            repairAttempts,
            physicalAttempts: candidate.physicalAttempts(),
            ...tokenEstimateDetails(fullRequest, result.usage),
            ...timingDetails(result.response.timing).details,
          },
        });
        candidate.recordSnapshot(
          snapshotRuntime(
            run,
            purpose,
            fullRequest,
            candidate.runtime,
            {
              structuredTier: result.mode,
              structuredTierPlan: allowedModes,
            },
            positiveInteger(request.maxOutputTokens),
          ),
        );
        logicalCall.dispose();
        return {
          value: result.value,
          usage: addBudgetUsage(
            failedUsage,
            budgetUsage(
              result.usage,
              durationMs,
              candidate.physicalAttempts(),
              pricingFor(run, candidate.pricingId),
            ),
          ),
          mode: result.mode,
          attempts: result.attempts,
        };
      } catch (error) {
        const scopedError = logicalCall.normalizeError(error, signal);
        logicalCall.dispose();
        this.recordFailure(
          call.id,
          call.started,
          scopedError,
          signal.aborted,
          candidate.physicalAttempts(),
          repairAttempts,
        );
        const normalized = modelStepError(scopedError, signal.aborted);
        failedUsage = addBudgetUsage(
          failedUsage,
          pricedFailureUsage(
            scopedError,
            normalized,
            Date.now() - call.started,
            candidate.physicalAttempts(),
            pricingFor(run, candidate.pricingId),
          ),
        );
        lastError = { ...normalized, usage: failedUsage };
        if (signal.aborted) break;
      }
    }
    throw lastError!;
  }

  /**
   * Resolves the call target for a purpose: purpose → six-role → assignment
   * role → model_assignments → models → providers. planning/review fallback
   * to writing is resolved by the assignment repository; every other missing
   * assignment is an explicit unavailable/degraded capability.
   */
  private resolveCandidates(
    run: NarrativeRun,
    step: NarrativeRunStep,
    purpose: string,
  ): ResolvedCandidate[] {
    const role = modelRoleForPurpose(purpose);
    const resolved = this.resolveRunAssignment(run, purpose, role);
    if (resolved) {
      const credential = resolveCredentialForEnvironment(
        resolved.provider,
        this.environment,
      );
      if (!credential.ok)
        throw credentialStepError(resolved.provider, credential);
      const physicalAttempts = createPhysicalAttemptCounter();
      return [
        {
          model: resolved.model.modelId,
          gateway: new ModelGateway(
            createModelAdapter(
              this.assignmentAdapterConfig(
                run,
                step,
                resolved.provider,
                credential.apiKey,
                physicalAttempts,
              ),
            ),
          ),
          callModelId: resolved.model.id,
          callProtocol: resolved.provider.wireApi,
          pricingId: resolved.model.id,
          providerKey: resolved.provider.id,
          runtime: modelRuntime(
            resolved.model,
            resolved.provider.wireApi,
            resolved.provider.id,
          ),
          logicalCallDeadlineMs: resolveRuntimeTimeouts(run, resolved.provider)
            .logicalCallDeadlineMs.value,
          physicalAttempts: () => physicalAttempts.count,
          recordSnapshot: (applied) =>
            this.recordAssignmentSnapshot(
              run,
              purpose,
              role,
              resolved,
              applied,
            ),
        },
      ];
    }
    throw <RunStepError>{
      code: "model.assignment.unavailable",
      message: `No model assignment is available for ${role}`,
      retryable: false,
      details: {
        purpose,
        role,
        assignmentRole: ASSIGNMENT_ROLE_FOR_ROLE[role],
      },
    };
  }

  private resolveRunAssignment(
    run: NarrativeRun,
    purpose: string,
    role: ModelRole,
  ): ResolvedModelAssignment | null {
    return this.resolveSnapshotAssignment(
      run,
      purpose,
      ASSIGNMENT_ROLE_FOR_ROLE[role],
    );
  }

  private resolveSnapshotAssignment(
    run: NarrativeRun,
    purpose: string,
    requestedRole: AssignmentRole,
  ): ResolvedModelAssignment | null {
    const frozen = this.assignmentSnapshots.get(run.id, purpose);
    if (!frozen) {
      const override = this.resolvePolicyModelOverride(run);
      if (override) {
        return {
          requestedRole,
          role: requestedRole,
          model: override.model,
          provider: override.provider,
        };
      }
      return this.assignments.resolve(requestedRole);
    }
    const currentModel = this.models.get(frozen.modelId);
    if (!currentModel?.enabled) return null;
    const frozenProviderId =
      typeof frozen.model.providerId === "string"
        ? frozen.model.providerId
        : currentModel.providerId;
    const currentProvider = this.providers.get(frozenProviderId);
    if (!currentProvider?.enabled) return null;
    const model = frozenStoredModel(currentModel, frozen.model);
    const provider = frozenStoredProvider(currentProvider, frozen.provider);
    return {
      requestedRole,
      role: frozen.assignmentRole as AssignmentRole,
      model,
      provider,
    };
  }

  /**
   * Per-conversation model override for assistant turns:
   * `policy.assistantModelId` points at a `models.id` row. A dead override
   * fails loudly (the author re-picks in the sidebar) instead of silently
   * falling back to the role assignment.
   */
  private resolvePolicyModelOverride(run: NarrativeRun): {
    model: StoredModel;
    provider: StoredProvider;
  } | null {
    const modelId = run.policy.assistantModelId;
    if (typeof modelId !== "string" || modelId === "") return null;
    const model = this.models.get(modelId);
    const provider = model ? this.providers.get(model.providerId) : null;
    if (!model?.enabled || !provider?.enabled) {
      throw <RunStepError>{
        code: "model.override.unavailable",
        message: `The model selected for this conversation is unavailable (${modelId}); pick another one in the assistant sidebar`,
        retryable: false,
      };
    }
    return { model, provider };
  }

  private assignmentAdapterConfig(
    run: NarrativeRun,
    step: NarrativeRunStep,
    provider: StoredProvider,
    apiKey: string,
    physicalAttempts: PhysicalAttemptCounter,
  ): AdapterConfig {
    return this.adapterConfig(
      run,
      step,
      {
        protocol: provider.wireApi,
        baseUrl: provider.baseUrl,
        apiKey,
        endpoint: provider.endpoint,
        anthropicVersion: provider.anthropicVersion,
        headers: provider.headers,
        queryParams: provider.queryParams,
      },
      provider,
      physicalAttempts,
    );
  }

  private adapterConfig(
    run: NarrativeRun,
    step: NarrativeRunStep,
    base: {
      protocol: ModelProtocol;
      baseUrl: string;
      apiKey: string;
      endpoint: string | null;
      anthropicVersion: string | null;
      headers: Record<string, string>;
      queryParams?: Record<string, string>;
    },
    provider: StoredProvider,
    physicalAttempts?: PhysicalAttemptCounter,
  ): AdapterConfig {
    const timeouts = resolveRuntimeTimeouts(run, provider);
    const requestStartTimeoutMs = timeouts.requestStartTimeoutMs.value;
    const streamIdleTimeoutMs = timeouts.streamIdleTimeoutMs.value;
    const logicalCallDeadlineMs = timeouts.logicalCallDeadlineMs.value;
    return {
      protocol: base.protocol,
      baseUrl: base.baseUrl,
      apiKey: base.apiKey,
      ...(base.endpoint ? { endpoint: base.endpoint } : {}),
      ...(base.anthropicVersion
        ? { anthropicVersion: base.anthropicVersion }
        : {}),
      headers: base.headers,
      ...(base.queryParams === undefined
        ? {}
        : { queryParams: base.queryParams }),
      // Whole-attempt lifetime is bounded only by the logical call deadline.
      // requestStartTimeoutMs independently ends when response headers/the
      // first stream event arrive and must never terminate a healthy stream.
      ...(logicalCallDeadlineMs === null
        ? {}
        : { timeoutMs: logicalCallDeadlineMs }),
      // The Harness is the only retry owner for narrative execution. The LLM
      // transport still supports explicit retries for standalone callers, but
      // this production path always dispatches exactly one request per tier.
      maxRetries: 0,
      ...(this.fetcher ? { fetch: this.fetcher } : {}),
      ...(physicalAttempts === undefined
        ? {}
        : {
            onRequestAttempt: () => {
              physicalAttempts.count += 1;
            },
          }),
      requestStartTimeoutMs,
      streamIdleTimeoutMs,
      ...(logicalCallDeadlineMs === null ? {} : { logicalCallDeadlineMs }),
    };
  }

  /**
   * Records the run model snapshot for an assignment-resolved call. The
   * provider is stored in its masked publicProvider shape, so the raw
   * credential_ref never enters the immutable assignment snapshot.
   */
  private recordAssignmentSnapshot(
    run: NarrativeRun,
    purpose: string,
    role: ModelRole | AssignmentRole,
    resolved: ResolvedModelAssignment,
    applied?: AppliedModelRuntime,
  ): void {
    const id = `model-snapshot-${sha256Hex(`${run.id}\0${purpose}`).slice(0, 24)}`;
    const runtimeEvidence = {
      ...applied,
      timeoutPolicy: resolveRuntimeTimeouts(run, resolved.provider),
    };
    this.assignmentSnapshots.upsert({
      id,
      runId: run.id,
      purpose,
      requestedRole: role,
      assignmentRole: resolved.role,
      modelId: resolved.model.id,
      provider: publicProvider(resolved.provider),
      model: {
        id: resolved.model.id,
        providerId: resolved.model.providerId,
        modelId: resolved.model.modelId,
        taskType: resolved.model.taskType,
        contextWindow: resolved.model.contextWindow,
        maxOutputTokens: resolved.model.maxOutputTokens,
        sampling: resolved.model.sampling,
        capabilities: resolved.model.capabilities,
        metadataSource: resolved.model.metadataSource,
        metadataVerifiedAt: resolved.model.metadataVerifiedAt,
        enabled: resolved.model.enabled,
        createdAt: resolved.model.createdAt,
        updatedAt: resolved.model.updatedAt,
        wireApi: resolved.provider.wireApi,
      },
      applied: runtimeEvidence,
      createdAt: new Date().toISOString(),
    });
  }

  private begin(
    run: NarrativeRun,
    step: NarrativeRunStep,
    purpose: string,
    request: ModelRequest,
    target: { callModelId: string; callProtocol: ModelProtocol },
  ) {
    const id = randomUuid();
    const started = Date.now();
    this.calls.start({
      id,
      projectId: run.projectId,
      runId: run.id,
      stepId: step.id,
      modelId: target.callModelId,
      protocol: target.callProtocol,
      model: request.model,
      purpose,
      requestHash: sha256Hex(stableJson(request)),
      startedAt: new Date(started).toISOString(),
    });
    return { id, started };
  }

  private beginEmbedding(
    run: NarrativeRun,
    step: NarrativeRunStep,
    purpose: string,
    request: { model: string; inputs: readonly string[] },
    target: { callModelId: string; callProtocol: ModelProtocol },
  ) {
    const id = randomUuid();
    const started = Date.now();
    this.calls.start({
      id,
      projectId: run.projectId,
      runId: run.id,
      stepId: step.id,
      modelId: target.callModelId,
      protocol: target.callProtocol,
      model: request.model,
      purpose: `${purpose}:embedding`,
      requestHash: sha256Hex(stableJson(request)),
      startedAt: new Date(started).toISOString(),
    });
    return { id, started };
  }

  private recordFailure(
    id: string,
    started: number,
    error: unknown,
    cancelled: boolean,
    physicalAttempts: number,
    repairAttempts = 0,
  ): void {
    this.calls.fail(
      id,
      safeError(error),
      Date.now() - started,
      new Date().toISOString(),
      cancelled,
      error instanceof StructuredOutputError ? error.usage : undefined,
      { physicalAttempts, repairAttempts },
    );
  }
}

function budgetUsage(
  usage: NormalizedUsage,
  wallTimeMs: number,
  calls = 1,
  pricing: ModelPricing | null = null,
): RunBudgetUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    calls,
    costUsd: pricing
      ? ((usage.inputTokens - usage.cachedInputTokens) * pricing.input +
          usage.cachedInputTokens * pricing.cachedInput +
          usage.outputTokens * pricing.output) /
        1_000_000
      : 0,
    wallTimeMs,
  };
}

interface ModelPricing {
  input: number;
  output: number;
  cachedInput: number;
}

/** Maps the six narrative model roles onto the five assignment roles. */
const ASSIGNMENT_ROLE_FOR_ROLE: Record<ModelRole, AssignmentRole> = {
  planning: "planning",
  review: "review",
  drafting: "writing",
  revision: "writing",
  settlement: "writing",
  analysis: "writing",
};

function modelRoleForPurpose(purpose: string): ModelRole {
  const normalized = purpose.toLocaleLowerCase();
  if (normalized.includes("review") || normalized.includes("check"))
    return "review";
  if (normalized.includes("revision") || normalized.includes("edit"))
    return "revision";
  if (normalized.includes("settle") || normalized.includes("extract"))
    return "settlement";
  if (normalized.includes("plan") || normalized.includes("outline"))
    return "planning";
  if (normalized.includes("analy") || normalized.includes("import"))
    return "analysis";
  return "drafting";
}

interface ResolvedCandidate {
  /** Model name sent on the wire request. */
  model: string;
  gateway: ModelGateway;
  /** Recorded as llm_calls.model_id. */
  callModelId: string;
  callProtocol: ModelProtocol;
  /** Key into policy.modelPricingUsdPerMillion. */
  pricingId: string;
  /** Stable provider-scoped semaphore key shared across runs. */
  providerKey: string;
  logicalCallDeadlineMs: number | null;
  runtime: CandidateRuntime;
  /** Number of real HTTP requests dispatched by this logical call. */
  physicalAttempts(): number;
  recordSnapshot(applied: AppliedModelRuntime): void;
}

interface CandidateRuntime {
  protocol: ModelProtocol;
  providerId: string;
  modelContextWindow: number | null;
  modelMaxOutputTokens: number | null;
  sampling: Readonly<Record<string, unknown>>;
  capabilities: Readonly<Record<string, boolean>>;
  metadataSource: StoredModel["metadataSource"] | null;
  metadataVerifiedAt: string | null;
}

interface AppliedModelRuntime extends Record<string, unknown> {
  protocol: ModelProtocol;
  providerId: string;
  contextWindow: number;
  policyContextWindow: number;
  modelContextWindow: number;
  estimatedInputRawTokens: number;
  estimatedInputTokens: number;
  inputSafetyTokens: number;
  contextWindowPolicySource: string;
  contextWindowAppliedBy: "policy" | "model";
  requestedMaxOutputTokens: number | null;
  roleMaxOutputTokens: number | null;
  modelMaxOutputTokens: number;
  maxOutputTokens: number;
  roleMaxOutputTokensSource: string;
  maxOutputTokensAppliedBy: readonly string[];
  remainingContextTokens: number;
  modelMetadataSource: StoredModel["metadataSource"] | null;
  modelMetadataVerifiedAt: string | null;
  sampling: Readonly<Record<string, unknown>>;
  capabilities: Readonly<Record<string, boolean>>;
  structuredTier?: string;
  structuredTierPlan?: readonly StructuredMode[];
}

function modelRuntime(
  model: StoredModel | null,
  protocol: ModelProtocol,
  providerId: string,
  overrides: { capabilities?: Readonly<Record<string, boolean>> } = {},
): CandidateRuntime {
  return {
    protocol,
    providerId,
    modelContextWindow: model?.contextWindow ?? null,
    modelMaxOutputTokens: model?.maxOutputTokens ?? null,
    sampling: model?.sampling ?? {},
    capabilities: overrides.capabilities ?? model?.capabilities ?? {},
    metadataSource: model?.metadataSource ?? null,
    metadataVerifiedAt: model?.metadataVerifiedAt ?? null,
  };
}

function frozenStoredModel(
  current: StoredModel,
  snapshot: Readonly<Record<string, unknown>>,
): StoredModel {
  const taskType = [
    "writing",
    "planning",
    "review",
    "embedding",
    "rerank",
  ].includes(String(snapshot.taskType))
    ? (snapshot.taskType as StoredModel["taskType"])
    : current.taskType;
  const metadataSource = [
    "manual",
    "environment",
    "catalog",
    "migration",
  ].includes(String(snapshot.metadataSource))
    ? (snapshot.metadataSource as StoredModel["metadataSource"])
    : current.metadataSource;
  return {
    ...current,
    providerId:
      typeof snapshot.providerId === "string"
        ? snapshot.providerId
        : current.providerId,
    modelId:
      typeof snapshot.modelId === "string" ? snapshot.modelId : current.modelId,
    taskType,
    contextWindow:
      typeof snapshot.contextWindow === "number"
        ? snapshot.contextWindow
        : current.contextWindow,
    maxOutputTokens:
      typeof snapshot.maxOutputTokens === "number"
        ? snapshot.maxOutputTokens
        : current.maxOutputTokens,
    sampling: isRecordValue(snapshot.sampling)
      ? snapshot.sampling
      : current.sampling,
    capabilities: isBooleanRecord(snapshot.capabilities)
      ? snapshot.capabilities
      : current.capabilities,
    metadataSource,
    metadataVerifiedAt:
      typeof snapshot.metadataVerifiedAt === "string"
        ? snapshot.metadataVerifiedAt
        : snapshot.metadataVerifiedAt === null
          ? null
          : current.metadataVerifiedAt,
    enabled:
      typeof snapshot.enabled === "boolean"
        ? snapshot.enabled
        : current.enabled,
    createdAt:
      typeof snapshot.createdAt === "string"
        ? snapshot.createdAt
        : current.createdAt,
    updatedAt:
      typeof snapshot.updatedAt === "string"
        ? snapshot.updatedAt
        : current.updatedAt,
  };
}

/**
 * Reuses the immutable transport configuration from the first purpose call
 * while resolving the current credential secret from storage. Credentials
 * are deliberately absent from snapshots, and a later provider/model disable
 * still stops new I/O.
 */
function frozenStoredProvider(
  current: StoredProvider,
  snapshot: Readonly<Record<string, unknown>>,
): StoredProvider {
  const wireApi = [
    "openai-chat",
    "openai-responses",
    "anthropic-messages",
  ].includes(String(snapshot.wireApi))
    ? (snapshot.wireApi as StoredProvider["wireApi"])
    : current.wireApi;
  return {
    ...current,
    name: typeof snapshot.name === "string" ? snapshot.name : current.name,
    wireApi,
    baseUrl:
      typeof snapshot.baseUrl === "string" ? snapshot.baseUrl : current.baseUrl,
    endpoint:
      typeof snapshot.endpoint === "string" || snapshot.endpoint === null
        ? snapshot.endpoint
        : current.endpoint,
    credentialRef: current.credentialRef,
    anthropicVersion:
      typeof snapshot.anthropicVersion === "string" ||
      snapshot.anthropicVersion === null
        ? snapshot.anthropicVersion
        : current.anthropicVersion,
    headers: isStringRecord(snapshot.headers)
      ? snapshot.headers
      : current.headers,
    queryParams: isStringRecord(snapshot.queryParams)
      ? snapshot.queryParams
      : current.queryParams,
    requestStartTimeoutMs: nullablePositiveInteger(
      snapshot.requestStartTimeoutMs,
      current.requestStartTimeoutMs,
    ),
    streamIdleTimeoutMs: nullablePositiveInteger(
      snapshot.streamIdleTimeoutMs,
      current.streamIdleTimeoutMs,
    ),
    enabled: current.enabled,
    createdAt:
      typeof snapshot.createdAt === "string"
        ? snapshot.createdAt
        : current.createdAt,
    updatedAt:
      typeof snapshot.updatedAt === "string"
        ? snapshot.updatedAt
        : current.updatedAt,
  };
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isBooleanRecord(value: unknown): value is Record<string, boolean> {
  return (
    isRecordValue(value) &&
    Object.values(value).every((entry) => typeof entry === "boolean")
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecordValue(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function nullablePositiveInteger(
  value: unknown,
  fallback: number | null,
): number | null {
  return value === null
    ? null
    : typeof value === "number" && Number.isSafeInteger(value) && value > 0
      ? value
      : fallback;
}

function applyRuntimeRequest(
  run: NarrativeRun,
  purpose: string,
  request: ModelRequest,
  runtime: CandidateRuntime,
): ModelRequest {
  const policyContextWindow =
    positiveInteger(run.policy.contextWindow) ?? 64_000;
  // Provider metadata is advisory. Unknown physical limits fall back to the
  // bounded run policy instead of making an otherwise usable model
  // unassignable.
  const modelContextWindow = runtime.modelContextWindow ?? policyContextWindow;
  const contextWindow = Math.min(policyContextWindow, modelContextWindow);
  const estimate = requestTokenEstimate(request, contextWindow);
  const remainingContextTokens =
    contextWindow - estimate.conservative - estimate.safety;
  if (remainingContextTokens < 1) {
    throw <RunStepError>{
      code: "model.context_length",
      message: `The conservative input budget of ${estimate.conservative + estimate.safety} tokens exceeds the effective context window ${contextWindow}`,
      retryable: false,
      details: {
        purpose,
        estimatedInputTokens: estimate.conservative,
        inputSafetyTokens: estimate.safety,
        contextWindow,
      },
    };
  }

  const requested = positiveInteger(request.maxOutputTokens);
  const rolePolicy = roleOutputLimit(run, purpose);
  const outputCandidates = [
    requested,
    rolePolicy,
    runtime.modelMaxOutputTokens,
    remainingContextTokens,
  ].filter((value): value is number => value !== null);
  const maxOutputTokens = Math.max(1, Math.min(...outputCandidates));
  const sampling = mergedSampling(runtime.protocol, runtime.sampling, request);
  return {
    ...request,
    maxOutputTokens,
    ...sampling,
  };
}

function snapshotRuntime(
  run: NarrativeRun,
  purpose: string,
  request: ModelRequest,
  runtime: CandidateRuntime,
  structured: {
    structuredTier?: string;
    structuredTierPlan?: readonly StructuredMode[];
  } = {},
  requestedMaxOutputTokens: number | null = null,
): AppliedModelRuntime {
  const policyContextWindow =
    positiveInteger(run.policy.contextWindow) ?? 64_000;
  const modelContextWindow = runtime.modelContextWindow ?? policyContextWindow;
  const modelMaxOutputTokens =
    runtime.modelMaxOutputTokens ?? request.maxOutputTokens!;
  const contextWindow = Math.min(policyContextWindow, modelContextWindow);
  const estimate = requestTokenEstimate(request, contextWindow);
  const remainingContextTokens =
    contextWindow - estimate.conservative - estimate.safety;
  const finalOutputTokens = request.maxOutputTokens!;
  const roleLimit = roleOutputLimit(run, purpose);
  const appliedBy = [
    ...(requestedMaxOutputTokens === finalOutputTokens ? ["purpose"] : []),
    ...(roleLimit === finalOutputTokens ? ["role-policy"] : []),
    ...(modelMaxOutputTokens === finalOutputTokens ? ["model"] : []),
    ...(remainingContextTokens === finalOutputTokens
      ? ["remaining-context"]
      : []),
  ];
  return {
    protocol: runtime.protocol,
    providerId: runtime.providerId,
    contextWindow,
    policyContextWindow,
    modelContextWindow,
    estimatedInputRawTokens: estimate.raw,
    estimatedInputTokens: estimate.conservative,
    inputSafetyTokens: estimate.safety,
    contextWindowPolicySource: policyFieldSource(run, "contextWindow"),
    contextWindowAppliedBy:
      modelContextWindow < policyContextWindow ? "model" : "policy",
    requestedMaxOutputTokens,
    roleMaxOutputTokens: roleLimit,
    modelMaxOutputTokens,
    maxOutputTokens: finalOutputTokens,
    roleMaxOutputTokensSource: policyFieldSource(
      run,
      roleOutputPolicyKey(purpose),
    ),
    maxOutputTokensAppliedBy: appliedBy,
    remainingContextTokens,
    modelMetadataSource: runtime.metadataSource,
    modelMetadataVerifiedAt: runtime.metadataVerifiedAt,
    sampling: samplingFromRequest(request),
    capabilities: runtime.capabilities,
    ...structured,
  };
}

function mergedSampling(
  protocol: ModelProtocol,
  model: Readonly<Record<string, unknown>>,
  request: ModelRequest,
): Pick<
  ModelRequest,
  "temperature" | "topP" | "reasoningEffort" | "stopSequences"
> {
  const adapter = adapterSamplingDefaults(protocol);
  const modelSampling = normalizeSampling(model);
  return {
    ...adapter,
    ...modelSampling,
    ...(request.temperature === undefined
      ? {}
      : { temperature: request.temperature }),
    ...(request.topP === undefined ? {} : { topP: request.topP }),
    ...(request.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: request.reasoningEffort }),
    ...(request.stopSequences === undefined
      ? {}
      : { stopSequences: request.stopSequences }),
  };
}

function adapterSamplingDefaults(
  protocol: ModelProtocol,
): Pick<ModelRequest, "temperature" | "topP"> {
  // Provider defaults are intentionally left on the provider unless the
  // adapter needs a stable override. Keeping this explicit makes the merge
  // order deterministic without inventing sampling values.
  // Referencing the protocol is deliberate: future adapter defaults belong
  // in this switch point, before model and step overrides are merged.
  void protocol;
  return {};
}

function normalizeSampling(
  sampling: Readonly<Record<string, unknown>>,
): Pick<
  ModelRequest,
  "temperature" | "topP" | "reasoningEffort" | "stopSequences"
> {
  const temperature = finiteInRange(sampling.temperature, 0, 2);
  const topP = finiteInRange(sampling.topP ?? sampling.top_p, 0, 1);
  const reasoningEffort = ["none", "minimal", "low", "medium", "high"].includes(
    String(sampling.reasoningEffort),
  )
    ? (sampling.reasoningEffort as ModelRequest["reasoningEffort"])
    : undefined;
  const stopSequences = Array.isArray(sampling.stopSequences)
    ? sampling.stopSequences.filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.length > 0,
      )
    : undefined;
  return {
    ...(temperature === null ? {} : { temperature }),
    ...(topP === null ? {} : { topP }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(stopSequences === undefined ? {} : { stopSequences }),
  };
}

function samplingFromRequest(
  request: ModelRequest,
): Readonly<Record<string, unknown>> {
  return {
    ...(request.temperature === undefined
      ? {}
      : { temperature: request.temperature }),
    ...(request.topP === undefined ? {} : { topP: request.topP }),
    ...(request.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: request.reasoningEffort }),
    ...(request.stopSequences === undefined
      ? {}
      : { stopSequences: request.stopSequences }),
  };
}

function estimateRequestInputTokens(request: ModelRequest): number {
  const content = [
    request.instructions ?? "",
    stableJson(request.messages),
    stableJson(request.tools ?? []),
    stableJson(request.responseSchema ?? null),
  ].join("\n");
  return estimateTokens(content);
}

function requestTokenEstimate(
  request: ModelRequest,
  contextWindow: number,
): { raw: number; conservative: number; safety: number } {
  const raw = estimateRequestInputTokens(request);
  // Unknown compatible endpoints do not expose a reliable count API. Keep a
  // modest wrapper/tokenizer margin instead of maintaining a home-grown full
  // tokenizer, then retain a separate context safety band.
  const conservative = Math.ceil(raw * 1.12) + 256;
  const safety = Math.max(1_024, Math.ceil(contextWindow * 0.02));
  return { raw, conservative, safety };
}

function tokenEstimateDetails(
  request: ModelRequest,
  usage: NormalizedUsage,
): Record<string, unknown> {
  const raw = estimateRequestInputTokens(request);
  const estimated = Math.ceil(raw * 1.12) + 256;
  return {
    estimatedInputTokens: estimated,
    actualInputTokens: usage.inputTokens,
    inputEstimateErrorTokens: usage.inputTokens - estimated,
    inputEstimateErrorRatio:
      usage.inputTokens === 0
        ? null
        : Number(
            ((estimated - usage.inputTokens) / usage.inputTokens).toFixed(4),
          ),
  };
}

function roleOutputLimit(run: NarrativeRun, purpose: string): number | null {
  return positiveInteger(run.policy[roleOutputPolicyKey(purpose)]);
}

function roleOutputPolicyKey(purpose: string): string {
  const role = modelRoleForPurpose(purpose);
  return role === "planning"
    ? "planningMaxOutputTokens"
    : role === "review"
      ? "reviewMaxOutputTokens"
      : role === "settlement"
        ? "settlementMaxOutputTokens"
        : role === "analysis"
          ? "analysisMaxOutputTokens"
          : "draftMaxOutputTokens";
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

function finiteInRange(
  value: unknown,
  min: number,
  max: number,
): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
    ? value
    : null;
}

interface PhysicalAttemptCounter {
  count: number;
}

interface LogicalCallScope {
  signal: AbortSignal;
  dispose(): void;
  normalizeError(error: unknown, callerSignal: AbortSignal): unknown;
}

/** One deadline shared by provider queuing, structured tiers and repairs. */
function createLogicalCallScope(
  deadlineMs: number | null,
  callerSignal: AbortSignal,
): LogicalCallScope {
  if (deadlineMs === null) {
    return {
      signal: callerSignal,
      dispose() {},
      normalizeError: (error) => error,
    };
  }
  const startedAt = Date.now();
  const deadlineController = new AbortController();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    deadlineController.abort(
      new DOMException("Logical model call deadline exceeded", "TimeoutError"),
    );
  }, deadlineMs);
  return {
    signal: AbortSignal.any([callerSignal, deadlineController.signal]),
    dispose: () => clearTimeout(timer),
    normalizeError: (error, externalSignal) =>
      expired && !externalSignal.aborted
        ? <RunStepError>{
            code: "model.logical_call_timeout",
            message: `The logical model call exceeded the overall deadline of ${deadlineMs}ms`,
            retryable: true,
            details: {
              scope: "logical-call",
              deadlineMs,
              elapsedMs: Date.now() - startedAt,
            },
          }
        : error,
  };
}

function createPhysicalAttemptCounter(): PhysicalAttemptCounter {
  return { count: 0 };
}

function credentialStepError(
  provider: StoredProvider,
  credential: Exclude<ResolvedCredential, { ok: true }>,
): RunStepError {
  if (credential.reason === "missing_env") {
    return {
      code: "model.credential.missing_env",
      message: `The credential of provider "${provider.name}" references the unset environment variable ${credential.name}`,
      retryable: false,
    };
  }
  return {
    code: "model.credential.empty",
    message: `The credential of provider "${provider.name}" is empty`,
    retryable: false,
  };
}

function resolveCredentialForEnvironment(
  provider: StoredProvider,
  environment: Readonly<Record<string, string | undefined>>,
): ResolvedCredential {
  if (provider.credentialRef.startsWith("relay:")) {
    // 中继 provider（D5）：真实 key 只在中继环境变量里，浏览器端拿哑 key。
    // 中继会剥掉这个头并注入服务端 key，哑值只满足非空校验。
    return { ok: true, apiKey: `relay:${provider.credentialRef.slice(6)}` };
  }
  if (!provider.credentialRef.startsWith("env:")) {
    return provider.credentialRef.length > 0
      ? { ok: true, apiKey: provider.credentialRef }
      : { ok: false, reason: "empty" };
  }
  const name = provider.credentialRef.slice("env:".length);
  const value = environment[name];
  if (value === undefined) return { ok: false, reason: "missing_env", name };
  if (value.length === 0) return { ok: false, reason: "empty" };
  return { ok: true, apiKey: value };
}

function pricingFor(run: NarrativeRun, modelId: string): ModelPricing | null {
  const table = run.policy.modelPricingUsdPerMillion;
  if (!table || typeof table !== "object" || Array.isArray(table)) return null;
  const entry = (table as Record<string, unknown>)[modelId];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const pricing = entry as Record<string, unknown>;
  const input = finiteNonNegative(pricing.input);
  const output = finiteNonNegative(pricing.output);
  if (input === null || output === null) return null;
  return {
    input,
    output,
    cachedInput: finiteNonNegative(pricing.cachedInput) ?? input,
  };
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function pricedFailureUsage(
  rawError: unknown,
  error: RunStepError,
  wallTimeMs: number,
  calls: number,
  pricing: ModelPricing | null,
): RunBudgetUsage {
  if (rawError instanceof StructuredOutputError) {
    return budgetUsage(rawError.usage, wallTimeMs, calls, pricing);
  }
  if (!error.usage) {
    return {
      inputTokens: 0,
      outputTokens: 0,
      calls,
      costUsd: 0,
      wallTimeMs,
    };
  }
  const normalized: NormalizedUsage = {
    inputTokens: error.usage.inputTokens,
    outputTokens: error.usage.outputTokens,
    totalTokens: error.usage.inputTokens + error.usage.outputTokens,
    cachedInputTokens: 0,
    reasoningTokens: 0,
  };
  return budgetUsage(normalized, wallTimeMs, calls, pricing);
}

function emptyBudgetUsage(): RunBudgetUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    calls: 0,
    costUsd: 0,
    wallTimeMs: 0,
  };
}

function addBudgetUsage(
  left: RunBudgetUsage,
  right: RunBudgetUsage,
): RunBudgetUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    calls: left.calls + right.calls,
    costUsd: left.costUsd + right.costUsd,
    wallTimeMs: left.wallTimeMs + right.wallTimeMs,
  };
}

function modelStepError(error: unknown, cancelled: boolean): RunStepError {
  if (cancelled) {
    // Preserve the partial output accumulated before the abort so recovery
    // can offer continue/adopt/regenerate on top of it.
    const partialText =
      error instanceof ModelError ? error.partialText : undefined;
    return {
      code: "model.cancelled",
      message: "The model call was cancelled",
      retryable: true,
      ...(partialText
        ? { details: { partialText: redactDiagnostic(partialText) } }
        : {}),
    };
  }
  if (isStepError(error)) {
    // A RunStepError is spread into a fresh object at every call site (to
    // attach usage). Return a plain object so non-enumerable Error fields —
    // message on a ModelError instance — are not silently dropped, and so the
    // step error retains the message every RunStepError must carry.
    return {
      code: error.code,
      message:
        typeof error.message === "string" && error.message.length > 0
          ? error.message
          : error.code,
      retryable: error.retryable,
      ...(error.details === undefined ? {} : { details: error.details }),
      ...(error.usage === undefined ? {} : { usage: error.usage }),
    };
  }
  if (error instanceof StructuredOutputError) {
    const outputLimited =
      error.finishReason === "length" ||
      error.finishReason === "context_length";
    return {
      code: outputLimited
        ? "model.structured_output_limit"
        : "model.structured_output",
      message: outputLimited
        ? "Structured output still hit the model output/context limit after repair; raise the effective limit or shrink the input"
        : error.message,
      // 校验失败是随机采样问题：随 StructuredOutputError 的可重试语义
      // 走 step 级退避重试；只有输出/上下文上限例外——重掷同样会撞上限。
      retryable: outputLimited ? false : error.retryable,
      details: {
        attempts: error.attempts,
        ...(error.finishReason ? { finishReason: error.finishReason } : {}),
        validationIssues: error.validationIssues.slice(0, 20),
        ...(error.invalidText
          ? {
              invalidOutputHash: sha256Hex(error.invalidText),
              invalidOutputExcerpt: redactDiagnostic(error.invalidText).slice(
                0,
                2_048,
              ),
            }
          : {}),
      },
      usage: budgetUsage(error.usage, 0, error.attempts),
    };
  }
  if (error instanceof ModelError) {
    return {
      code: `model.${error.category}`,
      message: error.message,
      retryable: error.retryable,
    };
  }
  return {
    code: "model.failed",
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
}

const PROVIDER_CONCURRENCY = 2;
const PROVIDER_SEMAPHORES = new Map<string, ProviderSemaphore>();

async function withProviderPermit<T>(
  providerKey: string,
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  let semaphore = PROVIDER_SEMAPHORES.get(providerKey);
  if (!semaphore) {
    semaphore = new ProviderSemaphore(PROVIDER_CONCURRENCY);
    PROVIDER_SEMAPHORES.set(providerKey, semaphore);
  }
  const release = await semaphore.acquire(signal);
  try {
    return await operation();
  } finally {
    release();
  }
}

class ProviderSemaphore {
  private active = 0;
  private readonly queue: Array<{
    resolve: (release: () => void) => void;
    reject: (error: unknown) => void;
    signal: AbortSignal;
    abort: () => void;
  }> = [];

  constructor(private readonly limit: number) {}

  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(cancelledModelError());
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.releaseFactory());
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        signal,
        abort: () => {
          const index = this.queue.indexOf(waiter);
          if (index >= 0) this.queue.splice(index, 1);
          reject(cancelledModelError());
        },
      };
      signal.addEventListener("abort", waiter.abort, { once: true });
      this.queue.push(waiter);
    });
  }

  private releaseFactory(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.dispatch();
    };
  }

  private dispatch(): void {
    while (this.active < this.limit && this.queue.length > 0) {
      const waiter = this.queue.shift()!;
      waiter.signal.removeEventListener("abort", waiter.abort);
      if (waiter.signal.aborted) {
        waiter.reject(cancelledModelError());
        continue;
      }
      this.active += 1;
      waiter.resolve(this.releaseFactory());
    }
  }
}

function cancelledModelError(): ModelError {
  return new ModelError(
    "Model call cancelled while waiting for provider capacity",
    {
      category: "cancelled",
    },
  );
}

function isStepError(error: unknown): error is RunStepError {
  return (
    Boolean(error) &&
    typeof error === "object" &&
    typeof (error as RunStepError).code === "string" &&
    typeof (error as RunStepError).retryable === "boolean"
  );
}

function safeError(error: unknown): Record<string, unknown> {
  const normalized = modelStepError(error, false);
  return {
    code: normalized.code,
    message: normalized.message.slice(0, 2_000),
    retryable: normalized.retryable,
    ...(normalized.details === undefined
      ? {}
      : { details: normalized.details }),
    // Full failure receipt: keep the provider request id, the stable
    // machine-readable reason (e.g. "request_start_timeout"), the HTTP
    // status, and the call timing so failures are diagnosable from
    // llm_calls alone. There are no dedicated columns, so they live in
    // error_json.
    ...(error instanceof ModelError && error.code !== undefined
      ? { reason: error.code }
      : {}),
    ...(error instanceof ModelError && error.requestId !== undefined
      ? { requestId: error.requestId }
      : {}),
    ...(error instanceof ModelError && error.status !== undefined
      ? { status: error.status }
      : {}),
    ...(error instanceof ModelError && error.timing !== undefined
      ? { timing: error.timing }
      : {}),
  };
}

/** INTEGER-column safe timing value: null when the phase was never reached. */
function roundedTimingMs(value: number | undefined): number | null {
  return value === undefined ? null : Math.round(value);
}

/**
 * Success-side details fragment carrying the transport-measured total
 * duration. llm_calls.duration_ms stays the logical wall-clock duration (it
 * also feeds budget wallTimeMs), so the transport figure is persisted under
 * details_json instead.
 */
function timingDetails(timing: ModelCallTiming | undefined): {
  details?: { totalDurationMs: number };
} {
  const totalDurationMs = roundedTimingMs(timing?.totalDurationMs);
  return totalDurationMs === null ? {} : { details: { totalDurationMs } };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}

function promptCacheKey(projectId: string, purpose: string): string {
  const purposeKey = purpose.replace(/[^a-z0-9._-]+/giu, "-").slice(0, 40);
  return `narrative-${sha256Hex(projectId).slice(0, 12)}-${purposeKey}`;
}

function explicitPolicyFields(
  policy: Readonly<Record<string, unknown>>,
): ReadonlySet<string> {
  const value = policy.explicitPolicyFields;
  return new Set(
    Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string")
      : [],
  );
}

function policyFieldSource(run: NarrativeRun, field: string): string {
  return explicitPolicyFields(run.policy).has(field)
    ? "run"
    : `quality-preset:${String(run.policy.qualityPreset ?? "standard")}`;
}

interface RuntimeTimeoutPolicy {
  requestStartTimeoutMs: {
    value: number;
    source: "run" | "provider" | "built-in";
  };
  streamIdleTimeoutMs: {
    value: number;
    source: "run" | "provider" | "built-in";
  };
  logicalCallDeadlineMs: { value: number | null; source: string };
  stepDeadlineMs: { value: number | null; source: string };
  runDeadlineMs: { value: number | null; source: string };
}

function resolveRuntimeTimeouts(
  run: NarrativeRun,
  provider: StoredProvider,
): RuntimeTimeoutPolicy {
  const explicit = explicitPolicyFields(run.policy);
  const runRequestStart = explicit.has("requestStartTimeoutMs")
    ? timeoutMsOrNull(run.policy.requestStartTimeoutMs, 600_000)
    : null;
  const providerRequestStart = timeoutMsOrNull(
    provider.requestStartTimeoutMs,
    600_000,
  );
  const runStreamIdle = explicit.has("streamIdleTimeoutMs")
    ? timeoutMsOrNull(run.policy.streamIdleTimeoutMs, 1_800_000)
    : null;
  const providerStreamIdle = timeoutMsOrNull(
    provider.streamIdleTimeoutMs,
    1_800_000,
  );
  return {
    requestStartTimeoutMs: runRequestStart
      ? { value: runRequestStart, source: "run" }
      : providerRequestStart
        ? { value: providerRequestStart, source: "provider" }
        : { value: 120_000, source: "built-in" },
    streamIdleTimeoutMs: runStreamIdle
      ? { value: runStreamIdle, source: "run" }
      : providerStreamIdle
        ? { value: providerStreamIdle, source: "provider" }
        : { value: 120_000, source: "built-in" },
    logicalCallDeadlineMs: {
      value: timeoutMsOrNull(run.policy.logicalCallDeadlineMs, 3_600_000),
      source: policyFieldSource(run, "logicalCallDeadlineMs"),
    },
    stepDeadlineMs: {
      value: timeoutMsOrNull(run.policy.stepDeadlineMs, 7_200_000),
      source: policyFieldSource(run, "stepDeadlineMs"),
    },
    runDeadlineMs: {
      value: timeoutMsOrNull(run.policy.runDeadlineMs, 14_400_000),
      source: policyFieldSource(run, "runDeadlineMs"),
    },
  };
}

/** Structured-output repair budget; defaults to the previous hardcoded 2. */
function structuredMaxRepairAttempts(run: NarrativeRun): number {
  return policyIntInRange(run.policy.maxRepairAttempts, 0, 3) ?? 2;
}

function timeoutMsOrNull(value: unknown, max: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), max)
    : null;
}

function policyIntInRange(
  value: unknown,
  min: number,
  max: number,
): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(Math.floor(value), max))
    : null;
}

function redactDiagnostic(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/giu, "Bearer [REDACTED]")
    .replace(
      /(["']?(?:api[_-]?key|authorization)["']?\s*[:=]\s*["'])[^"']+(["'])/giu,
      "$1[REDACTED]$2",
    );
}
