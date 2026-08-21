import {
  CanonCandidateSetSchema,
  type CanonCandidateItemDto,
  type CanonCandidateSetDto,
  type CanonSpread,
} from "@narralume/contracts";
import {
  createCanonEntity,
  createCanonFact,
  createOutlineNode,
  type CanonEntity,
  type CanonFact,
  type Foreshadow,
  type RelationshipEvent,
  type TimelineEvent,
} from "@narralume/domain";
import {
  SqliteCanonRepository,
  SqliteNarrativeStateRepository,
  SqliteReviewRepository,
  SqliteStoryRepository,
  type CanonChangeSetView,
  type NarrativeDatabase,
} from "@narralume/persistence";

import { fingerprint, readCanonSpread } from "./canon-candidate-context.js";
import {
  CanonCandidateChangesSchema,
  type CanonCandidateChanges,
} from "./canon-candidate-schemas.js";

export class CanonCandidateService {
  private readonly canon: SqliteCanonRepository;
  private readonly reviews: SqliteReviewRepository;
  private readonly state: SqliteNarrativeStateRepository;
  private readonly story: SqliteStoryRepository;

  constructor(
    private readonly database: NarrativeDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.canon = new SqliteCanonRepository(database);
    this.reviews = new SqliteReviewRepository(database);
    this.story = new SqliteStoryRepository(database);
    this.state = new SqliteNarrativeStateRepository(
      database,
      this.canon,
      this.story,
    );
  }

  list(projectId: string, spread?: CanonSpread): CanonCandidateSetDto[] {
    return this.reviews.listCanonChangeSets(projectId).flatMap((changeSet) => {
      const parsed = CanonCandidateChangesSchema.safeParse(changeSet.changes);
      if (!parsed.success || (spread && parsed.data.spread !== spread))
        return [];
      return [this.view(changeSet, parsed.data)];
    });
  }

  get(projectId: string, changeSetId: string): CanonCandidateSetDto {
    const changeSet = this.reviews.getCanonChangeSet(projectId, changeSetId);
    if (!changeSet)
      throw new CanonCandidateError(
        "canon_candidate.not_found",
        "Canon Spread candidate set not found",
        404,
      );
    const changes = CanonCandidateChangesSchema.safeParse(changeSet.changes);
    if (!changes.success)
      throw new CanonCandidateError(
        "canon_candidate.not_found",
        "This change set is not a Canon Spread candidate set",
        404,
      );
    return this.view(changeSet, changes.data);
  }

  decideItem(input: {
    projectId: string;
    changeSetId: string;
    itemId: string;
    action: "apply" | "reject";
    confirmLocked: boolean;
  }): { candidateSet: CanonCandidateSetDto; item: CanonCandidateItemDto } {
    const changeSet = this.reviews.getCanonChangeSet(
      input.projectId,
      input.changeSetId,
    );
    if (!changeSet)
      throw new CanonCandidateError(
        "canon_candidate.not_found",
        "Canon Spread candidate set not found",
        404,
      );
    const changes = CanonCandidateChangesSchema.safeParse(changeSet.changes);
    if (!changes.success)
      throw new CanonCandidateError(
        "canon_candidate.not_found",
        "This change set is not a Canon Spread candidate set",
        404,
      );
    const item = changes.data.items.find(
      (candidate) => candidate.id === input.itemId,
    );
    if (!item)
      throw new CanonCandidateError(
        "canon_candidate.item.not_found",
        "Candidate item not found",
        404,
      );
    const prior = this.reviews.getCanonItemDecision(changeSet.id, item.id);
    if (prior) {
      if (prior.action !== input.action)
        throw new CanonCandidateError(
          "canon_candidate.item.decision_conflict",
          "This candidate already has a different decision",
          409,
        );
      return this.resultFor(input.projectId, changeSet.id, item.id);
    }
    if (
      input.action === "apply" &&
      item.requiresLockedConfirmation &&
      !input.confirmLocked
    ) {
      throw new CanonCandidateError(
        "canon_candidate.locked_confirmation_required",
        "This candidate modifies locked content and requires explicit confirmation again",
        409,
      );
    }

    this.database.transaction(() => {
      const now = this.now().toISOString();
      const result =
        input.action === "apply"
          ? this.applyItem(input.projectId, changeSet, changes.data, item, now)
          : { rejected: true };
      this.reviews.insertCanonItemDecision({
        changeSetId: changeSet.id,
        itemId: item.id,
        action: input.action,
        result,
        createdAt: now,
      });
      this.syncStatus(input.projectId, changeSet.id, changes.data, now);
    });
    return this.resultFor(input.projectId, changeSet.id, item.id);
  }

  private view(
    changeSet: CanonChangeSetView,
    changes: CanonCandidateChanges,
  ): CanonCandidateSetDto {
    const current = readCanonSpread(
      this.database,
      changeSet.projectId,
      changes.spread,
    );
    const decisions = new Map(
      this.reviews
        .listCanonItemDecisions(changeSet.id)
        .map((decision) => [decision.itemId, decision]),
    );
    return CanonCandidateSetSchema.parse({
      id: changeSet.id,
      projectId: changeSet.projectId,
      runId: changeSet.runId,
      stepId: changeSet.stepId,
      spread: changes.spread,
      instruction: changes.instruction,
      summary: changes.summary,
      baseFingerprint: changes.baseFingerprint,
      currentFingerprint: current.fingerprint,
      stale: changes.baseFingerprint !== current.fingerprint,
      status: changeSet.status,
      items: changes.items.map((item) => {
        const decision = decisions.get(item.id);
        return {
          ...item,
          decision: decision
            ? {
                action: decision.action,
                result: decision.result,
                decidedAt: decision.createdAt,
              }
            : null,
        };
      }),
      createdAt: changeSet.createdAt,
      decidedAt: changeSet.decidedAt,
    });
  }

  private resultFor(projectId: string, changeSetId: string, itemId: string) {
    const candidateSet = this.get(projectId, changeSetId);
    const item = candidateSet.items.find(
      (candidate) => candidate.id === itemId,
    );
    if (!item)
      throw new CanonCandidateError(
        "canon_candidate.item.not_found",
        "Candidate item not found",
        404,
      );
    return { candidateSet, item };
  }

  private syncStatus(
    projectId: string,
    changeSetId: string,
    changes: CanonCandidateChanges,
    now: string,
  ): void {
    const decisions = this.reviews.listCanonItemDecisions(changeSetId);
    const hasApplied = decisions.some(
      (decision) => decision.action === "apply",
    );
    const status =
      decisions.length < changes.items.length
        ? hasApplied
          ? "partially_applied"
          : "candidate"
        : decisions.every((decision) => decision.action === "reject")
          ? "rejected"
          : "applied";
    this.reviews.updateCanonChangeSetStatus({
      projectId,
      changeSetId,
      status,
      decidedAt: now,
    });
  }

  private applyItem(
    projectId: string,
    changeSet: CanonChangeSetView,
    changes: CanonCandidateChanges,
    item: CanonCandidateChanges["items"][number],
    now: string,
  ): Record<string, unknown> {
    const current = currentTarget(
      this.database,
      projectId,
      changes.spread,
      item.targetId,
    );
    if (
      item.operation !== "create" &&
      fingerprint(current) !== fingerprint(item.before)
    ) {
      throw new CanonCandidateError(
        "canon_candidate.item.version_conflict",
        "The canon content has changed since the candidates were generated; keep the current content and regenerate candidates",
        409,
      );
    }
    if (changes.spread === "intent")
      return this.applyIntent(projectId, item, now);
    if (changes.spread === "outline")
      return this.applyOutline(projectId, changeSet.id, item, now);
    if (changes.spread === "entities")
      return this.applyEntity(projectId, changeSet.id, item, now);
    if (changes.spread === "facts")
      return this.applyFact(projectId, changeSet.id, item, now);
    if (changes.spread === "relations")
      return this.applyRelationship(projectId, changeSet.id, item, now);
    if (changes.spread === "timeline")
      return this.applyTimeline(projectId, changeSet.id, item, now);
    return this.applyForeshadow(projectId, changeSet.id, item, now);
  }

  private applyIntent(
    projectId: string,
    item: CanonCandidateChanges["items"][number],
    now: string,
  ) {
    const current = this.story.getAuthorIntent(projectId);
    if (!current || !item.after)
      throw invalidItem(
        "Intent candidate is missing the current value or modified content",
      );
    const updated = this.story.upsertAuthorIntent({
      ...current,
      ...item.after,
      projectId,
      lockedFields: current.lockedFields,
      updatedAt: now,
    });
    return { spread: "intent", value: updated };
  }

  private applyOutline(
    projectId: string,
    changeSetId: string,
    item: CanonCandidateChanges["items"][number],
    now: string,
  ) {
    if (!item.after)
      throw invalidItem("Outline candidate is missing modified content");
    if (item.operation === "create") {
      const parentId = nullableString(item.after.parentId);
      const parent = parentId
        ? this.story.requireOutlineNode(projectId, parentId)
        : null;
      const ordinal = integerValue(item.after.ordinal);
      // create 候选也必须检查生成基线：同父节点同序号的节点已存在时，
      // 说明候选生成后的大纲已变化，不能盲目提交否则只会撞上唯一约束。
      const siblings = this.story
        .listOutline(projectId)
        .filter((node) => node.parentId === (parent?.id ?? null));
      if (siblings.some((node) => node.ordinal === ordinal)) {
        throw new CanonCandidateError(
          "canon_candidate.item.conflict",
          "The outline has changed since the candidates were generated (a sibling with the same ordinal already exists); keep the current content and regenerate candidates",
          409,
        );
      }
      const node = createOutlineNode({
        id: `${changeSetId}:${item.id}:outline`,
        projectId,
        parent,
        kind: enumValue(item.after.kind, [
          "book",
          "volume",
          "arc",
          "chapter",
          "scene",
          "beat",
        ]),
        ordinal,
        title: stringValue(item.after.title),
        summary: nullableString(item.after.summary),
        goal: nullableString(item.after.goal),
        conflict: nullableString(item.after.conflict),
        outcome: nullableString(item.after.outcome),
        povEntityId: nullableString(item.after.povEntityId),
        storyTime: nullableString(item.after.storyTime),
        metadata: recordValue(item.after.metadata, {}),
        now,
      });
      let stored = this.story.insertOutlineNode(node);
      const status = optionalEnum(item.after.status, [
        "planned",
        "drafting",
        "review",
        "committed",
        "abandoned",
      ]);
      if (status && status !== stored.status)
        stored = this.story.updateOutlineStatus(
          projectId,
          stored.id,
          status,
          now,
        );
      return { spread: "outline", value: stored };
    }
    const current = this.story.requireOutlineNode(
      projectId,
      requiredTarget(item),
    );
    for (const immutable of ["parentId", "kind", "ordinal"] as const) {
      if (
        immutable in item.after &&
        item.after[immutable] !== current[immutable]
      )
        throw invalidItem(
          `An existing outline node cannot change ${immutable} through a candidate`,
        );
    }
    let stored = this.story.updateOutlineDetails(
      projectId,
      current.id,
      {
        ...(item.after.title === undefined
          ? {}
          : { title: stringValue(item.after.title) }),
        ...(item.after.summary === undefined
          ? {}
          : { summary: nullableString(item.after.summary) }),
        ...(item.after.goal === undefined
          ? {}
          : { goal: nullableString(item.after.goal) }),
        ...(item.after.conflict === undefined
          ? {}
          : { conflict: nullableString(item.after.conflict) }),
        ...(item.after.outcome === undefined
          ? {}
          : { outcome: nullableString(item.after.outcome) }),
        ...(item.after.povEntityId === undefined
          ? {}
          : { povEntityId: nullableString(item.after.povEntityId) }),
        ...(item.after.storyTime === undefined
          ? {}
          : { storyTime: nullableString(item.after.storyTime) }),
        ...(item.after.metadata === undefined
          ? {}
          : { metadata: recordValue(item.after.metadata, {}) }),
      },
      now,
    );
    const status = optionalEnum(item.after.status, [
      "planned",
      "drafting",
      "review",
      "committed",
      "abandoned",
    ]);
    if (status && status !== stored.status)
      stored = this.story.updateOutlineStatus(
        projectId,
        stored.id,
        status,
        now,
      );
    return { spread: "outline", value: stored };
  }

  private applyEntity(
    projectId: string,
    changeSetId: string,
    item: CanonCandidateChanges["items"][number],
    now: string,
  ) {
    if (!item.after)
      throw invalidItem("Entity candidate is missing modified content");
    if (item.operation === "create") {
      const type = enumValue(item.after.type, [
        "character",
        "location",
        "organization",
        "item",
        "rule",
        "concept",
      ]);
      const name = stringValue(item.after.name);
      // create 候选也必须检查生成基线：候选生成后同名同类型实体已存在时，
      // 说明正典已被人为修改，应显式冲突而不是撞上唯一约束（泛化 500）。
      if (
        this.canon
          .listEntities(projectId, { includeRetired: true })
          .some((entity) => entity.type === type && entity.name === name)
      ) {
        throw new CanonCandidateError(
          "canon_candidate.item.conflict",
          "The canon has changed since the candidates were generated (an entity with the same type and name already exists); keep the current content and regenerate candidates",
          409,
        );
      }
      let entity = createCanonEntity({
        id: `${changeSetId}:${item.id}:entity`,
        projectId,
        type,
        name,
        aliases: stringArray(item.after.aliases),
        description: nullableString(item.after.description),
        attributes: recordValue(item.after.attributes, {}),
        now,
      });
      entity = this.canon.insertEntity(entity);
      if (item.after.status === "retired")
        entity = this.canon.updateEntity({
          ...entity,
          status: "retired",
          updatedAt: now,
        });
      return { spread: "entities", value: entity };
    }
    const current = this.canon.requireEntity(projectId, requiredTarget(item));
    if (item.after.type !== undefined && item.after.type !== current.type)
      throw invalidItem("An existing entity cannot change its type");
    const updated: CanonEntity = {
      ...current,
      name: optionalString(item.after.name) ?? current.name,
      aliases:
        item.after.aliases === undefined
          ? current.aliases
          : stringArray(item.after.aliases),
      description:
        item.after.description === undefined
          ? current.description
          : nullableString(item.after.description),
      attributes:
        item.after.attributes === undefined
          ? current.attributes
          : recordValue(item.after.attributes, {}),
      status:
        optionalEnum(item.after.status, ["active", "retired"]) ??
        current.status,
      updatedAt: now,
    };
    return { spread: "entities", value: this.canon.updateEntity(updated) };
  }

  private applyFact(
    projectId: string,
    changeSetId: string,
    item: CanonCandidateChanges["items"][number],
    now: string,
  ) {
    if (item.operation === "withdraw") {
      const current = this.canon.requireFact(projectId, requiredTarget(item));
      const withdrawal = this.canon.withdrawFact({
        factId: current.id,
        projectId,
        reason: `Canon candidate ${changeSetId}: ${item.rationale}`,
        withdrawnAt: now,
      });
      return { spread: "facts", value: withdrawal };
    }
    if (!item.after)
      throw invalidItem("Fact candidate is missing modified content");
    const current =
      item.operation === "update"
        ? this.canon.requireFact(projectId, requiredTarget(item))
        : null;
    const desired = mergeFact(current, item.after);
    const fact = createCanonFact({
      id: `${changeSetId}:${item.id}:fact`,
      projectId,
      subjectId: stringValue(desired.subjectId),
      predicate: stringValue(desired.predicate),
      ...(desired.objectEntityId
        ? { objectEntityId: stringValue(desired.objectEntityId) }
        : { value: desired.value }),
      validFromNodeId: nullableString(desired.validFromNodeId),
      validToNodeId: nullableString(desired.validToNodeId),
      knowledgeScope:
        optionalEnum(desired.knowledgeScope, [
          "omniscient",
          "reader",
          "character",
          "author_secret",
        ]) ?? "omniscient",
      knowledgeSubjectId: nullableString(desired.knowledgeSubjectId),
      authority: current?.authority ?? "confirmed",
      confidence: numberValue(desired.confidence, current?.confidence ?? 1),
      sourceType: "canon-candidate",
      sourceId: changeSetId,
      supersedesFactId: current?.id ?? null,
      now,
    });
    return { spread: "facts", value: this.canon.insertFact(fact) };
  }

  private applyRelationship(
    projectId: string,
    changeSetId: string,
    item: CanonCandidateChanges["items"][number],
    now: string,
  ) {
    if (!item.after)
      throw invalidItem("Relationship candidate is missing modified content");
    const current =
      item.operation === "update"
        ? this.state.getRelationship(projectId, requiredTarget(item))
        : null;
    if (item.operation === "update" && !current)
      throw new CanonCandidateError(
        "canon_candidate.item.version_conflict",
        "The relationship has changed",
        409,
      );
    const desired = { ...(current ?? {}), ...item.after };
    const event: RelationshipEvent = {
      id: `${changeSetId}:${item.id}:relationship`,
      projectId,
      fromEntityId: stringValue(desired.fromEntityId),
      toEntityId: stringValue(desired.toEntityId),
      relation: stringValue(desired.relation),
      intensity: nullableNumber(desired.intensity),
      state: recordValue(desired.state, {}),
      outlineNodeId: nullableString(desired.outlineNodeId),
      storyTime: nullableString(desired.storyTime),
      sourceId: changeSetId,
      supersedesEventId: current?.id ?? null,
      createdAt: now,
    };
    return { spread: "relations", value: this.state.insertRelationship(event) };
  }

  private applyTimeline(
    projectId: string,
    changeSetId: string,
    item: CanonCandidateChanges["items"][number],
    now: string,
  ) {
    if (!item.after)
      throw invalidItem("Timeline candidate is missing modified content");
    const current =
      item.operation === "update"
        ? (this.state
            .listTimeline(projectId)
            .find((event) => event.id === requiredTarget(item)) ?? null)
        : null;
    if (item.operation === "update" && !current)
      throw new CanonCandidateError(
        "canon_candidate.item.version_conflict",
        "The timeline event has changed",
        409,
      );
    const desired = { ...(current ?? {}), ...item.after };
    const event: TimelineEvent = {
      id: current?.id ?? `${changeSetId}:${item.id}:timeline`,
      projectId,
      title: stringValue(desired.title),
      description: nullableString(desired.description),
      outlineNodeId: nullableString(desired.outlineNodeId),
      storyTimeStart: nullableString(desired.storyTimeStart),
      storyTimeEnd: nullableString(desired.storyTimeEnd),
      sequence: integerValue(desired.sequence),
      participants: stringArray(desired.participants),
      causes: stringArray(desired.causes),
      visibility:
        optionalEnum(desired.visibility, [
          "omniscient",
          "reader",
          "author_secret",
        ]) ?? "omniscient",
      sourceId: changeSetId,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    return {
      spread: "timeline",
      value: current
        ? this.state.updateTimelineEvent(event)
        : this.state.insertTimelineEvent(event),
    };
  }

  private applyForeshadow(
    projectId: string,
    changeSetId: string,
    item: CanonCandidateChanges["items"][number],
    now: string,
  ) {
    if (!item.after)
      throw invalidItem("Foreshadow candidate is missing modified content");
    const current =
      item.operation === "update"
        ? (this.state
            .listForeshadows(projectId)
            .find((entry) => entry.id === requiredTarget(item)) ?? null)
        : null;
    if (item.operation === "update" && !current)
      throw new CanonCandidateError(
        "canon_candidate.item.version_conflict",
        "The foreshadow has changed",
        409,
      );
    const desired = { ...(current ?? {}), ...item.after };
    const foreshadow: Foreshadow = {
      id: current?.id ?? `${changeSetId}:${item.id}:foreshadow`,
      projectId,
      title: stringValue(desired.title),
      description: stringValue(desired.description),
      status:
        optionalEnum(desired.status, [
          "planned",
          "planted",
          "developing",
          "resolved",
          "abandoned",
        ]) ?? "planned",
      importance: enumValue(desired.importance, [1, 2, 3, 4, 5]),
      targetFromNodeId: nullableString(desired.targetFromNodeId),
      targetToNodeId: nullableString(desired.targetToNodeId),
      dependencies: stringArray(desired.dependencies),
      evidenceNodeIds: stringArray(desired.evidenceNodeIds),
      resolutionNodeId: nullableString(desired.resolutionNodeId),
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    return {
      spread: "foreshadows",
      value: current
        ? this.state.updateForeshadow(foreshadow)
        : this.state.insertForeshadow(foreshadow),
    };
  }
}

function currentTarget(
  database: NarrativeDatabase,
  projectId: string,
  spread: CanonSpread,
  targetId: string | null,
): Record<string, unknown> | null {
  if (!targetId) return null;
  const value = readCanonSpread(database, projectId, spread).value;
  if (spread === "intent")
    return targetId === "intent" && value && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  if (!Array.isArray(value)) return null;
  return (value.find(
    (entry) =>
      entry &&
      typeof entry === "object" &&
      (entry as Record<string, unknown>).id === targetId,
  ) ?? null) as Record<string, unknown> | null;
}

function mergeFact(current: CanonFact | null, patch: Record<string, unknown>) {
  const desired: Record<string, unknown> = { ...(current ?? {}), ...patch };
  if ("value" in patch) desired.objectEntityId = null;
  if (typeof patch.objectEntityId === "string") delete desired.value;
  return desired;
}

function requiredTarget(item: { targetId: string | null }): string {
  if (!item.targetId) throw invalidItem("Candidate is missing a target ID");
  return item.targetId;
}

function invalidItem(message: string): CanonCandidateError {
  return new CanonCandidateError("canon_candidate.item.invalid", message, 422);
}

function stringValue(value: unknown): string {
  if (typeof value !== "string" || !value.trim())
    throw invalidItem("Candidate is missing required text");
  return value.trim();
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : stringValue(value);
}

function integerValue(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value))
    throw invalidItem("Candidate is missing a valid integer");
  return value;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw invalidItem("Candidate number is invalid");
  return value;
}

function stringArray(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))
    throw invalidItem("Candidate list must contain text only");
  return [...new Set(value.map((entry) => entry.trim()).filter(Boolean))];
}

function recordValue(
  value: unknown,
  fallback: Record<string, unknown>,
): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : fallback;
}

function enumValue<T extends string | number>(
  value: unknown,
  values: readonly T[],
): T {
  if (!values.includes(value as T))
    throw invalidItem("Candidate enum value is invalid");
  return value as T;
}

function optionalEnum<T extends string | number>(
  value: unknown,
  values: readonly T[],
): T | null {
  return value === undefined ? null : enumValue(value, values);
}

export class CanonCandidateError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "CanonCandidateError";
  }
}
