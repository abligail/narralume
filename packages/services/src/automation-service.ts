import {
  CreateCanonEntityRequestSchema,
  UpdateCompassRequestSchema,
  resolveEffectivePolicy,
  type EffectivePolicy,
  type ModelExecutionPolicy,
} from "@narralume/contracts";
import { createCanonEntity } from "@narralume/domain";
import type { AutopilotSession, RunSnapshot } from "@narralume/domain";
import { buildFoundationRecipe } from "@narralume/harness";
import {
  type SqliteAutomationRepository,
  type SqliteCanonRepository,
  type SqliteProjectRepository,
  type SqliteRunRepository,
  type SqliteStoryRepository,
  type NarrativeDatabase,
} from "@narralume/persistence";
import { z } from "zod";

import { randomUuid } from "./internal/crypto.js";
import { isRecord, withRuntimeModelPolicy } from "./run-policy.js";
import { ServiceError } from "./service-error.js";

export class AutomationServiceError extends ServiceError {
  constructor(code: string, message: string, statusCode: number) {
    super(code, message, statusCode);
    this.name = "AutomationServiceError";
  }
}

const IntentCandidatePayloadSchema = z.object({
  promise: z.string().min(1),
  themes: z.array(z.string()),
  audience: z.string().nullable(),
  tone: z.string().nullable(),
  boundaries: z.array(z.string()),
  endingDirection: z.string().nullable(),
  currentFocus: z.string().nullable(),
});

/** 从会话 chapterPolicy 还原生效策略（含创建时显式字段与停靠模式）。 */
export function resolveSessionEffectivePolicy(
  session: Pick<AutopilotSession, "chapterPolicy">,
): EffectivePolicy & {
  explicitPolicyFields?: string[];
  planningMode?: "auto" | "confirm";
  origin?: Readonly<Record<string, unknown>> | null;
} {
  const effectivePolicy = resolveEffectivePolicy(
    session.chapterPolicy as ModelExecutionPolicy,
  ).effectivePolicy;
  // chapterPolicy 的运行时字段是宽松 Record，这里逐字段校形后收窄。
  const raw = session.chapterPolicy as Readonly<Record<string, unknown>>;
  const explicitPolicyFields: string[] | undefined = Array.isArray(
    raw.explicitPolicyFields,
  )
    ? (raw.explicitPolicyFields as string[])
    : undefined;
  const planningMode: "auto" | "confirm" | undefined =
    raw.planningMode === "auto" || raw.planningMode === "confirm"
      ? raw.planningMode
      : undefined;
  const origin: Readonly<Record<string, unknown>> | null | undefined = isRecord(
    raw.origin,
  )
    ? raw.origin
    : raw.origin === null
      ? null
      : undefined;
  const resolved: EffectivePolicy & {
    explicitPolicyFields?: string[];
    planningMode?: "auto" | "confirm";
    origin?: Readonly<Record<string, unknown>> | null;
  } = { ...effectivePolicy };
  if (explicitPolicyFields)
    resolved.explicitPolicyFields = explicitPolicyFields;
  if (planningMode) resolved.planningMode = planningMode;
  if (origin !== undefined) resolved.origin = origin;
  return resolved;
}

export function createFoundationRun(input: {
  runs: SqliteRunRepository;
  runId: string;
  projectId: string;
  rootOutlineNodeId: string | null;
  braindump: string;
  preferences: Readonly<Record<string, unknown>>;
  policy: Readonly<Record<string, unknown>>;
  origin?: {
    surface: string;
    documentId: string | null;
    selection: { start: number; end: number } | null;
  };
  environment: Readonly<Record<string, string | undefined>>;
  now: string;
}) {
  const recipe = buildFoundationRecipe(input.runId);
  return input.runs.create({
    id: input.runId,
    projectId: input.projectId,
    recipe: recipe.name,
    recipeVersion: recipe.version,
    mode: "manual",
    targetOutlineNodeId: input.rootOutlineNodeId,
    policy: withRuntimeModelPolicy(
      {
        contextWindow: 16_000,
        foundationMaxOutputTokens: 8_000,
        ...input.policy,
        braindump: input.braindump,
        preferences: input.preferences,
        origin: input.origin ?? {
          surface: "autopilot",
          documentId: null,
          selection: null,
        },
      },
      input.environment,
    ),
    steps: recipe.steps,
    now: input.now,
  });
}

export function resolveSessionFailure(
  automation: SqliteAutomationRepository,
  runs: SqliteRunRepository,
  story: SqliteStoryRepository,
  sessionId: string,
  action: "retry-current" | "skip-chapter" | "replan" | "stop",
): void {
  const session = automation.requireSession(sessionId);
  const now = new Date().toISOString();
  if (action === "stop") {
    automation.setSessionStatus(sessionId, "cancelled", now, {
      code: "session.stopped",
    });
    return;
  }
  const link = session.currentRunId
    ? automation.findRunLink(session.currentRunId)
    : ([...automation.listRunLinks(sessionId)]
        .reverse()
        .find(
          (candidate) =>
            candidate.role === "chapter" && candidate.outcome === "failed",
        ) ?? null);
  if (session.currentRunId) {
    const child = runs.getSnapshot(session.currentRunId).run;
    if (
      !["failed", "cancelled", "awaiting_user", "paused"].includes(child.status)
    ) {
      throw new AutomationServiceError(
        "autopilot.resolution.unsafe",
        "A resolution is only allowed when the chapter has failed, is paused, or is waiting for the author",
        409,
      );
    }
    automation.markRunProcessed(sessionId, child.id, action, now);
  }
  if (link?.outlineNodeId) {
    story.updateOutlineStatus(
      session.projectId,
      link.outlineNodeId,
      action === "skip-chapter" || action === "replan"
        ? "abandoned"
        : "planned",
      now,
    );
  }
  if (action === "skip-chapter") {
    automation.recordChapterOutcome(sessionId, "skipped", now);
  }
  if (action === "replan") {
    automation.requestSessionControl(sessionId, "replan", now);
  }
  automation.setSessionStatus(sessionId, "running", now);
}

/**
 * 采纳地基候选：intent/compass 走基线防覆盖检查（生成后人工改过的内容
 * 不被旧候选覆盖），canon 实体按 (type,name) 去重插入。editedPayload 为
 * 用户在采纳前编辑过的载荷；不传则用候选当前载荷。
 */
export function adoptCandidate(
  database: NarrativeDatabase,
  automation: SqliteAutomationRepository,
  projects: SqliteProjectRepository,
  story: SqliteStoryRepository,
  canon: SqliteCanonRepository,
  candidateId: string,
  editedPayload?: Readonly<Record<string, unknown>>,
) {
  return database.transaction(() => {
    const candidate = automation.requireCandidate(candidateId);
    if (candidate.status !== "pending") return candidate;
    const payload =
      editedPayload ?? candidate.editedPayload ?? candidate.payload;
    const now = new Date().toISOString();
    let adoptedRefType: string;
    let adoptedRefId: string;
    if (candidate.kind === "intent") {
      const input = IntentCandidatePayloadSchema.parse(payload);
      const current = story.getAuthorIntent(candidate.projectId);
      // 候选保存了生成时的意图基线；生成后人工修改过的意图不能被旧候选覆盖。
      if (
        (current?.updatedAt ?? null) !==
        baselineValue(candidate.payload, "intentUpdatedAt")
      ) {
        throw new AutomationServiceError(
          "foundation_candidate.intent.stale",
          "The author intent changed after the candidate was generated; keep the current content and regenerate the candidate",
          409,
        );
      }
      const locked = new Set(current?.lockedFields ?? []);
      story.upsertAuthorIntent({
        projectId: candidate.projectId,
        promise: locked.has("promise")
          ? (current?.promise ?? null)
          : input.promise,
        themes: locked.has("themes") ? (current?.themes ?? []) : input.themes,
        audience: locked.has("audience")
          ? (current?.audience ?? null)
          : input.audience,
        tone: locked.has("tone") ? (current?.tone ?? null) : input.tone,
        boundaries: locked.has("boundaries")
          ? (current?.boundaries ?? [])
          : input.boundaries,
        endingDirection: locked.has("endingDirection")
          ? (current?.endingDirection ?? null)
          : input.endingDirection,
        currentFocus: locked.has("currentFocus")
          ? (current?.currentFocus ?? null)
          : input.currentFocus,
        lockedFields: current?.lockedFields ?? [],
        updatedAt: now,
      });
      adoptedRefType = "author_intent";
      adoptedRefId = candidate.projectId;
    } else if (candidate.kind === "compass") {
      const input = UpdateCompassRequestSchema.parse(payload);
      const currentCompass = automation.getCompass(candidate.projectId);
      // 候选保存了生成时的指南针版本；生成后人工修改过的指南针不能被旧候选覆盖。
      if (
        (currentCompass?.version ?? null) !==
        baselineValue(candidate.payload, "compassVersion")
      ) {
        throw new AutomationServiceError(
          "foundation_candidate.compass.stale",
          "The story compass changed after the candidate was generated; keep the current content and regenerate the candidate",
          409,
        );
      }
      const compass = automation.upsertCompass({
        projectId: candidate.projectId,
        ...input,
        version: currentCompass?.version ?? 1,
        updatedAt: now,
      });
      adoptedRefType = "story_compass";
      adoptedRefId = compass.projectId;
    } else {
      const input = CreateCanonEntityRequestSchema.parse(payload);
      const existing = canon
        .listEntities(candidate.projectId, { includeRetired: true })
        .find(
          (entity) => entity.type === input.type && entity.name === input.name,
        );
      const entity =
        existing ??
        canon.insertEntity(
          createCanonEntity({
            id: randomUuid(),
            projectId: candidate.projectId,
            type: input.type,
            name: input.name,
            aliases: input.aliases,
            description: input.description ?? null,
            attributes: input.attributes,
            now,
          }),
        );
      adoptedRefType = "canon_entity";
      adoptedRefId = entity.id;
    }
    const project = projects.get(candidate.projectId);
    if (!project) {
      throw new AutomationServiceError(
        "project.not_found",
        "Project not found",
        404,
      );
    }
    if (project.phase === "idea") {
      projects.update({ ...project, phase: "foundation", updatedAt: now });
    }
    return automation.resolveCandidate(candidateId, {
      status: "adopted",
      ...(editedPayload ? { editedPayload } : {}),
      adoptedRefType,
      adoptedRefId,
      now,
    });
  });
}

export function sessionProductProjection(
  session: AutopilotSession,
  runs: SqliteRunRepository,
  story: SqliteStoryRepository,
) {
  const child = session.currentRunId
    ? runs.getSnapshot(session.currentRunId)
    : null;
  const currentNode = session.currentOutlineNodeId
    ? story.getOutlineNode(session.projectId, session.currentOutlineNodeId)
    : null;
  const sessionErrorCode =
    typeof session.lastError?.code === "string" ? session.lastError.code : null;
  const stopReason =
    sessionErrorCode === "child.fatal"
      ? sessionErrorCode
      : child
        ? latestRunReason(child)
        : sessionErrorCode;
  let availableActions: string[] = [];
  if (["pending", "planning", "running"].includes(session.status)) {
    availableActions = ["pause", "cancel"];
  } else if (session.status === "paused") {
    availableActions = ["resume", "cancel"];
  } else if (session.status === "awaiting_user") {
    availableActions =
      stopReason === "child.fatal"
        ? ["retry-current", "skip-chapter", "replan", "stop"]
        : stopReason === "chapter_commit_approval_required"
          ? ["accept_manuscript", "request_revision", "cancel"]
          : [
                "critical_review_unresolved",
                "quality_gate_blocked",
                "semantic_review_blocked",
                "revision_limit_reached",
              ].includes(stopReason ?? "")
            ? ["request_revision", "cancel"]
            : stopReason === "scene_plan_approval_required"
              ? ["accept_plan", "cancel"]
              : stopReason === "settlement_conflict_requires_resolution"
                ? ["cancel"]
                : ["cancel"];
  } else if (session.status === "failed") {
    availableActions = ["retry-current", "skip-chapter", "replan", "stop"];
  }
  return {
    origin: isRecord(session.chapterPolicy.origin)
      ? session.chapterPolicy.origin
      : null,
    approvalMode: session.mode === "autopilot" ? "continuous" : "per_chapter",
    currentChapter: currentNode
      ? {
          id: currentNode.id,
          title: currentNode.title,
          runId: session.currentRunId,
        }
      : null,
    stopReason,
    availableActions,
  };
}

/** 最近一次 run 状态事件的原因；没有事件时退回 run 状态本身。 */
export function latestRunReason(snapshot: RunSnapshot): string | null {
  const event = [...snapshot.events]
    .reverse()
    .find((candidate) => candidate.type === `run.${snapshot.run.status}`);
  return typeof event?.payload.reason === "string"
    ? event.payload.reason
    : snapshot.run.status;
}

/** 读取候选生成时保存的基线值；缺失时返回 null（等价于“生成时尚不存在”）。 */
function baselineValue(
  payload: Readonly<Record<string, unknown>>,
  key: string,
): string | number | null {
  const baseline = payload.baseline;
  if (!isRecord(baseline)) return null;
  const value = baseline[key];
  return typeof value === "string" || typeof value === "number" ? value : null;
}
