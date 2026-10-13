import {
  StoryCompassSchema,
  StoryLineProposalChangesSchema,
  StoryLineProposalSetSchema,
  type StoryLineProgressProposal,
  type StoryLineProposalSetDto,
} from "@narralume/contracts";
import { sha256Hex } from "@narralume/domain";
import {
  SqliteAutomationRepository,
  SqliteCanonRepository,
  SqliteDocumentRepository,
  SqliteNarrativeStateRepository,
  SqliteReviewRepository,
  SqliteStoryRepository,
  type NarrativeDatabase,
} from "@narralume/persistence";
import { requireActiveProject } from "./project-guard.js";
import { currentSummaryPoints } from "./chapter-memory.js";
import { ParagraphLocator } from "./paragraph-locator.js";

/** Derived freshness is not an author decision and can change after entity adoption. */
export function storyLineDecisionFingerprint(
  sets: readonly StoryLineProposalSetDto[],
): string {
  return sha256Hex(
    JSON.stringify(
      sets.map(({ id, scopeNodeId, createdAt, evidence, items }) => ({
        id,
        scopeNodeId,
        createdAt,
        evidence,
        items,
      })),
    ),
  );
}

/** Review the target stage against manuscripts written through its last committed chapter. */
export function storyLineReviewEvidence(
  database: NarrativeDatabase,
  projectId: string,
  scopeId?: string,
) {
  const story = new SqliteStoryRepository(database);
  const outline = story.listOutline(projectId);
  const nodes = new Map(outline.map((node) => [node.id, node]));
  const scope = scopeId !== undefined ? nodes.get(scopeId) : null;
  const withinScope = (id: string, targetScopeId?: string) => {
    let node = nodes.get(id);
    let inside = false;
    while (node) {
      if (node.status === "abandoned") return false;
      if (targetScopeId === undefined || node.id === targetScopeId)
        inside = true;
      node = node.parentId ? nodes.get(node.parentId) : undefined;
    }
    return inside;
  };
  const canon = new SqliteCanonRepository(database);
  const state = new SqliteNarrativeStateRepository(database, canon, story);
  const entityCatalog = canon
    .listEntities(projectId, { includeRetired: true })
    .map(({ id, type, name, aliases, description, status }) => ({
      id,
      type,
      name,
      aliases,
      description: description?.slice(0, 240) ?? null,
      status,
    }));
  const documents = new SqliteDocumentRepository(database);
  const manuscript = documents.list(projectId);
  const committedChapters = outline.filter(
    (node) =>
      node.kind === "chapter" &&
      node.status === "committed" &&
      withinScope(node.id),
  );
  const scopeEnd =
    scopeId !== undefined && (!scope || !["arc", "volume"].includes(scope.kind))
      ? -1
      : committedChapters.findLastIndex((chapter) =>
          withinScope(chapter.id, scopeId),
        );
  const chapters = committedChapters.slice(0, scopeEnd + 1);
  const chapterNumbers = new Map(
    outline
      .filter((node) => node.kind === "chapter" && node.status !== "abandoned")
      .map((node, index) => [node.id, index + 1]),
  );
  const evidence = chapters.flatMap((chapter) => {
    const document = manuscript.find(
      (item) => item.outlineNodeId === chapter.id && item.kind === "chapter",
    );
    const version = document?.currentVersionId
      ? documents.getVersion(projectId, document.id, document.currentVersionId)
      : null;
    const summary = state.latestSummary(projectId, "chapter", chapter.id);
    if (!version) return [];
    const summaryPoints = currentSummaryPoints(
      summary,
      new ParagraphLocator(version.content, { documentVersionId: version.id }),
    );
    return [
      {
        chapterId: chapter.id,
        chapterNumber: chapterNumbers.get(chapter.id)!,
        inScope: withinScope(chapter.id, scopeId),
        title: chapter.title,
        summary: summaryPoints.length
          ? summaryPoints.map((point) => point.text).join("\n")
          : summary?.sourceHash === version.contentHash
            ? summary.summary
            : "",
        summaryPoints,
        versionId: version.id,
        sourceHash: version.contentHash,
        content: version.content,
      },
    ];
  });
  const referenced = new Set<string>();
  for (const id of [
    ...(scopeId !== undefined ? [scopeId] : []),
    ...chapters.map((chapter) => chapter.id),
  ]) {
    let node = nodes.get(id);
    while (node) {
      referenced.add(node.id);
      node = node.parentId ? nodes.get(node.parentId) : undefined;
    }
  }
  const indexes = evidence.map((chapter) => ({
    chapterId: chapter.chapterId,
    chapterNumber: chapter.chapterNumber,
    inScope: chapter.inScope,
    title: chapter.title,
    summary: chapter.summary,
    summaryPoints: chapter.summaryPoints,
    versionId: chapter.versionId,
    sourceHash: chapter.sourceHash,
  }));
  return {
    chapters: evidence,
    evidence: indexes,
    entityCatalog,
    fingerprint: sha256Hex(
      JSON.stringify({
        scopeId: scopeId ?? null,
        outline: outline
          .filter((node) => referenced.has(node.id))
          .map(({ id, parentId, ordinal, status }) => ({
            id,
            parentId,
            ordinal,
            status,
          })),
        evidence: indexes,
        // Review proposals depend on supplied identities. Planning's manuscript
        // baseline remains independent of entities it may legitimately create.
        ...(scopeId !== undefined ? { entityCatalog } : {}),
      }),
    ),
  };
}

export function storyLineProposalIssues(
  items: readonly StoryLineProgressProposal[],
  lineCount: number,
  evidenceIds: ReadonlySet<string>,
): string[] {
  const seen = new Set<number>();
  return items.flatMap((item) => {
    const issues: string[] = [];
    if (item.lineIndex >= lineCount || seen.has(item.lineIndex))
      issues.push(
        "Each proposal must reference a different existing lineIndex",
      );
    seen.add(item.lineIndex);
    if (
      new Set(item.evidenceChapterIds).size !==
        item.evidenceChapterIds.length ||
      item.evidenceChapterIds.some((id) => !evidenceIds.has(id))
    )
      issues.push(
        "Evidence must use unique chapter IDs from the supplied current manuscripts",
      );
    return issues;
  });
}

type Changes = ReturnType<typeof StoryLineProposalChangesSchema.parse>;
function proposedLine(changes: Changes, item: StoryLineProgressProposal) {
  const before = changes.compass.longLines[item.lineIndex]!;
  return {
    ...before,
    status: item.status,
    development: {
      scopeNodeId: before.development?.scopeNodeId ?? null,
      stageGoal: before.development?.stageGoal ?? "",
      progress: item.progress,
      openPromises: item.openPromises,
      nextDevelopment: item.nextDevelopment,
      evidenceChapterIds: item.evidenceChapterIds,
    },
  };
}

export class StoryLineProposalService {
  private readonly reviews: SqliteReviewRepository;
  private readonly automation: SqliteAutomationRepository;
  constructor(private readonly database: NarrativeDatabase) {
    this.reviews = new SqliteReviewRepository(database);
    this.automation = new SqliteAutomationRepository(database);
  }
  list(projectId: string) {
    return this.reviews.listCanonChangeSets(projectId).flatMap((set) => {
      const parsed = StoryLineProposalChangesSchema.safeParse(set.changes);
      return parsed.success
        ? [this.view(projectId, set.id, set.createdAt, parsed.data)]
        : [];
    });
  }
  private isCurrent(projectId: string, setId: string, changes: Changes) {
    const current = this.automation.getCompass(projectId);
    if (!current) return false;
    const expected = structuredClone(changes.compass);
    for (const decision of this.reviews.listCanonItemDecisions(setId)) {
      if (decision.action !== "apply") continue;
      const item = changes.items.find(
        (candidate) => String(candidate.lineIndex) === decision.itemId,
      );
      if (!item) return false;
      expected.longLines[item.lineIndex] = proposedLine(changes, item);
      expected.version += 1;
    }
    // Timestamp is not a version. Every accepted sibling advances the same baseline.
    expected.updatedAt = current.updatedAt;
    return (
      JSON.stringify(StoryCompassSchema.parse(current)) ===
        JSON.stringify(expected) &&
      storyLineReviewEvidence(this.database, projectId, changes.scopeNodeId)
        .fingerprint === changes.evidenceFingerprint
    );
  }
  private view(
    projectId: string,
    id: string,
    createdAt: string,
    changes: Changes,
  ) {
    return StoryLineProposalSetSchema.parse({
      id,
      scopeNodeId: changes.scopeNodeId,
      createdAt,
      stale: !this.isCurrent(projectId, id, changes),
      evidence: changes.evidence,
      items: changes.items.map((item) => {
        const decision = this.reviews.getCanonItemDecision(
          id,
          String(item.lineIndex),
        );
        return {
          id: String(item.lineIndex),
          rationale: item.rationale,
          before: changes.compass.longLines[item.lineIndex],
          after: proposedLine(changes, item),
          decision: decision
            ? {
                action: decision.action,
                result: decision.result,
                decidedAt: decision.createdAt,
              }
            : null,
        };
      }),
    });
  }
  decide(
    projectId: string,
    setId: string,
    itemId: string,
    action: "apply" | "reject",
  ) {
    return this.database.transaction(() => {
      requireActiveProject(this.database, projectId);
      const set = this.reviews.getCanonChangeSet(projectId, setId);
      const parsed = StoryLineProposalChangesSchema.safeParse(set?.changes);
      if (!set || !parsed.success)
        throw new StoryLineProposalError(
          "story_line_proposal.not_found",
          "Story line proposal not found",
          404,
        );
      const changes = parsed.data;
      const item = changes.items.find(
        (candidate) => String(candidate.lineIndex) === itemId,
      );
      if (!item)
        throw new StoryLineProposalError(
          "story_line_proposal.not_found",
          "Story line proposal item not found",
          404,
        );
      const prior = this.reviews.getCanonItemDecision(setId, itemId);
      if (prior && prior.action !== action)
        throw new StoryLineProposalError(
          "story_line_proposal.decision_conflict",
          "This proposal already has a different decision",
          409,
        );
      if (!prior) {
        const now = new Date().toISOString();
        let result: Record<string, unknown> = { rejected: true };
        if (action === "apply") {
          if (!this.isCurrent(projectId, setId, changes))
            throw new StoryLineProposalError(
              "story_line_proposal.stale",
              "The compass or manuscript evidence changed; review a new proposal",
              409,
            );
          const compass = this.automation.requireCompass(projectId);
          const line = proposedLine(changes, item);
          const updated = this.automation.upsertCompass({
            ...compass,
            longLines: compass.longLines.map((value, index) =>
              index === item.lineIndex ? line : value,
            ),
            updatedAt: now,
          });
          result = {
            lineIndex: item.lineIndex,
            line,
            compassVersion: updated.version,
          };
        }
        this.reviews.insertCanonItemDecision({
          changeSetId: setId,
          itemId,
          action,
          result,
          createdAt: now,
        });
        const decisions = this.reviews.listCanonItemDecisions(setId);
        this.reviews.updateCanonChangeSetStatus({
          projectId,
          changeSetId: setId,
          status:
            decisions.length < changes.items.length
              ? "partially_applied"
              : decisions.some((d) => d.action === "apply")
                ? "applied"
                : "rejected",
          decidedAt: now,
        });
      }
      return this.view(projectId, setId, set.createdAt, changes);
    });
  }
}

export class StoryLineProposalError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}
