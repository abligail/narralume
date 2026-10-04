import {
  entityNamesOverlap,
  sha256Hex,
  type CanonEntity,
  type OutlineNode,
  type RunSnapshot,
} from "@narralume/domain";
import {
  SqliteAutomationRepository,
  SqliteCanonRepository,
  SqliteReviewRepository,
  SqliteRunRepository,
  SqliteStoryRepository,
  type NarrativeDatabase,
} from "@narralume/persistence";

import {
  RollingOutlineProposalSchema,
  type RollingOutlineProposal,
} from "./automation-schemas.js";
import {
  StoryLineProposalService,
  storyLineReviewEvidence,
} from "./story-line-proposals.js";
import {
  fingerprint,
  materializeCandidateItems,
  readCanonSpread,
} from "./canon-candidate-context.js";
import { CanonCandidateChangesSchema } from "./canon-candidate-schemas.js";

export function outlineFingerprint(outline: readonly OutlineNode[]): string {
  return fingerprint(
    outline
      .map((node) => ({
        id: node.id,
        parentId: node.parentId,
        kind: node.kind,
        ordinal: node.ordinal,
        title: node.title,
        summary: node.summary,
        goal: node.goal,
        conflict: node.conflict,
        outcome: node.outcome,
        status: node.status,
        updatedAt: node.updatedAt,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  );
}

export class PlanningEntityError extends Error {
  readonly statusCode = 409;
  readonly retryable = false;
  constructor(
    readonly code: string,
    override readonly message: string,
  ) {
    super(message);
  }
}

export function requirePlanningBaseline(
  database: NarrativeDatabase,
  snapshot: RunSnapshot,
): void {
  const generated = snapshot.steps.find(
    (step) => step.kind === "outline.generate" && step.status === "succeeded",
  )?.outputArtifact;
  const generation = generated?.generation as
    | {
        compassVersion: number | null;
        outlineFingerprint: string;
        manuscriptFingerprint: string;
        decisionFingerprint: string;
      }
    | undefined;
  if (
    !generation ||
    generation.compassVersion !==
      (new SqliteAutomationRepository(database).getCompass(
        snapshot.run.projectId,
      )?.version ?? null)
  ) {
    throw new PlanningEntityError(
      "compass.baseline.conflict",
      "The story compass changed after planning; generate a new plan",
    );
  }
  if (
    generation.outlineFingerprint !==
    outlineFingerprint(
      new SqliteStoryRepository(database).listOutline(snapshot.run.projectId),
    )
  ) {
    throw new PlanningEntityError(
      "outline.baseline.conflict",
      "The outline changed after planning; generate a new plan",
    );
  }
  if (
    generation.manuscriptFingerprint !==
      storyLineReviewEvidence(database, snapshot.run.projectId).fingerprint ||
    generation.decisionFingerprint !==
      sha256Hex(
        JSON.stringify(
          new StoryLineProposalService(database)
            .list(snapshot.run.projectId)
            .slice(0, 12),
        ),
      )
  ) {
    throw new PlanningEntityError(
      "planning.memory.stale",
      "Manuscripts or author decisions changed after planning; generate a new plan",
    );
  }
}

export function planningEntityIssues(
  plan: RollingOutlineProposal,
  entities: readonly CanonEntity[],
  checkNewNames = true,
): string[] {
  const issues: string[] = [];
  const proposals = new Map(
    plan.entityProposals.map((proposal) => [proposal.key, proposal]),
  );
  if (proposals.size !== plan.entityProposals.length)
    issues.push("entityProposals keys must be unique");
  plan.entityProposals.forEach((proposal, index) => {
    const duplicate = checkNewNames
      ? entities.find((entity) => entityNamesOverlap(entity, proposal))
      : undefined;
    if (duplicate)
      issues.push(
        `entityProposals.${index}: name or alias already belongs to ${duplicate.id} (${duplicate.status}); use its existing ID when active, never create a duplicate`,
      );
    if (
      plan.entityProposals
        .slice(0, index)
        .some((prior) => entityNamesOverlap(prior, proposal))
    )
      issues.push(
        `entityProposals.${index}: duplicates another proposed name or alias`,
      );
  });
  const used = new Set<string>();
  plan.chapters.forEach((chapter, index) => {
    for (const ref of [
      ...chapter.entityRefs,
      ...(chapter.pov ? [chapter.pov] : []),
    ]) {
      const entity =
        ref.kind === "existing"
          ? entities.find(
              (entity) => entity.id === ref.id && entity.status === "active",
            )
          : proposals.get(ref.id);
      if (!entity)
        issues.push(
          `chapters.${index}: unknown or inactive ${ref.kind} entity ${ref.id}`,
        );
      if (ref === chapter.pov && entity && entity.type !== "character")
        issues.push(`chapters.${index}.pov must reference a character`);
      if (ref.kind === "proposed") used.add(ref.id);
    }
  });
  for (const key of proposals.keys())
    if (!used.has(key))
      issues.push(
        `Proposal ${key} must serve a chapter in this window; omit unrelated future entries`,
      );
  return issues;
}

export function stagePlanningEntities(
  database: NarrativeDatabase,
  snapshot: RunSnapshot,
  stepId: string,
  now: string,
) {
  return database.transaction(() => {
    requirePlanningBaseline(database, snapshot);
    const artifact = snapshot.steps.find(
      (step) => step.kind === "outline.generate" && step.status === "succeeded",
    )!.outputArtifact!;
    const plan = RollingOutlineProposalSchema.parse(artifact);
    if (!plan.entityProposals.length) return { candidateSetId: null };
    const reviews = new SqliteReviewRepository(database);
    const id = `${snapshot.run.id}:planning-entities`;
    // Replaying staging must preserve the original candidates and decisions.
    if (reviews.getCanonChangeSet(snapshot.run.projectId, id))
      return { candidateSetId: id };
    const entities = new SqliteCanonRepository(database).listEntities(
      snapshot.run.projectId,
      { includeRetired: true },
    );
    const issues = planningEntityIssues(plan, entities);
    if (issues.length)
      throw new PlanningEntityError(
        "planning.entities.conflict",
        issues.join("; "),
      );
    const current = readCanonSpread(
      database,
      snapshot.run.projectId,
      "entities",
    );
    const items = materializeCandidateItems(
      snapshot.run.projectId,
      "entities",
      current.value,
      {
        summary: plan.rationale,
        items: plan.entityProposals.map((proposal) => ({
          operation: "create",
          targetId: null,
          title: proposal.name,
          rationale: proposal.rationale,
          impact: [proposal.narrativeRole],
          afterJson: JSON.stringify({
            type: proposal.type,
            name: proposal.name,
            aliases: proposal.aliases,
            description: proposal.description,
            attributes: { narrativeRole: proposal.narrativeRole },
          }),
        })),
      },
    ).map((item, index) => ({ ...item, id: plan.entityProposals[index]!.key }));
    reviews.insertCanonChangeSet({
      id,
      projectId: snapshot.run.projectId,
      runId: snapshot.run.id,
      stepId,
      changes: {
        kind: "canon_spread_revision",
        spread: "entities",
        instruction: plan.rationale,
        summary: plan.arc.title,
        baseFingerprint: current.fingerprint,
        items,
      },
      status: "candidate",
      createdAt: now,
    });
    return { candidateSetId: id };
  });
}

/** Recheck decisions at commit as well as at the UI continuation boundary. */
export function requirePlanningEntitiesReady(
  database: NarrativeDatabase,
  snapshot: RunSnapshot,
): Map<string, string> {
  requirePlanningBaseline(database, snapshot);
  const artifact = snapshot.steps.find(
    (step) => step.kind === "outline.generate" && step.status === "succeeded",
  )!.outputArtifact!;
  const plan = RollingOutlineProposalSchema.parse(artifact);
  const staged = snapshot.steps.find(
    (step) => step.kind === "outline.entities" && step.status === "succeeded",
  );
  if (!staged)
    throw new PlanningEntityError(
      "planning.entities.pending",
      "Entity candidates have not been prepared",
    );
  const entities = new SqliteCanonRepository(database).listEntities(
    snapshot.run.projectId,
    { includeRetired: true },
  );
  const issues = planningEntityIssues(plan, entities, false);
  if (issues.length)
    throw new PlanningEntityError(
      "planning.entities.conflict",
      issues.join("; "),
    );
  const bindings = new Map<string, string>();
  if (!plan.entityProposals.length) return bindings;
  const setId = `${snapshot.run.id}:planning-entities`;
  const reviews = new SqliteReviewRepository(database);
  const set = reviews.getCanonChangeSet(snapshot.run.projectId, setId);
  if (!set || staged.outputArtifact?.candidateSetId !== setId)
    throw new PlanningEntityError(
      "planning.entities.pending",
      "Entity candidates are unavailable",
    );
  const decisions = reviews.listCanonItemDecisions(setId);
  if (
    decisions.some(
      (item) =>
        item.action === "reject" &&
        plan.entityProposals.some((proposal) => proposal.key === item.itemId),
    )
  ) {
    throw new PlanningEntityError(
      "planning.entities.rejected",
      "A proposed entity was rejected; replan before creating chapters",
    );
  }
  for (const proposal of plan.entityProposals) {
    const decision = decisions.find((item) => item.itemId === proposal.key);
    if (!decision)
      throw new PlanningEntityError(
        "planning.entities.pending",
        "Decide all entity candidates before continuing",
      );
    const entityId = `${setId}:${proposal.key}:entity`;
    const entity = entities.find(
      (entity) =>
        entity.id === entityId &&
        entity.status === "active" &&
        entity.type === proposal.type,
    );
    if (!entity)
      throw new PlanningEntityError(
        "planning.entities.conflict",
        "An adopted entity is no longer available; replan",
      );
    bindings.set(proposal.key, entityId);
  }
  return bindings;
}

export function planningRejections(
  database: NarrativeDatabase,
  projectId: string,
) {
  const reviews = new SqliteReviewRepository(database);
  const runs = new SqliteRunRepository(database);
  return reviews
    .listCanonChangeSets(projectId)
    .flatMap((set) => {
      if (runs.getRun(set.runId)?.recipe !== "rolling-outline") return [];
      const parsed = CanonCandidateChangesSchema.safeParse(set.changes);
      if (!parsed.success) return [];
      const rejected = new Set(
        reviews
          .listCanonItemDecisions(set.id)
          .filter((item) => item.action === "reject")
          .map((item) => item.itemId),
      );
      return parsed.data.items
        .filter((item) => rejected.has(item.id))
        .map((item) => ({
          name: item.title,
          rationale: item.rationale,
          narrativeRole: item.impact,
          type: item.after?.type,
        }));
    })
    .slice(0, 20);
}
