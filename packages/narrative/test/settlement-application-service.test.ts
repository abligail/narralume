import {
  createCanonEntity,
  createCanonFact,
  createOutlineNode,
  createProject,
} from "@narralume/domain";
import { buildChapterRecipe } from "@narralume/harness";
import {
  SqliteCanonRepository,
  SqliteNarrativeStateRepository,
  SqliteProjectRepository,
  SqliteReviewRepository,
  SqliteRunRepository,
  SqliteStoryRepository,
} from "@narralume/persistence";
import { NodeNarrativeDatabase } from "@narralume/persistence/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SettlementApplicationService,
  SettlementConflictError,
} from "../src/settlement-application-service.js";

const now = "2026-08-10T00:00:00.000Z";
let database: NodeNarrativeDatabase;
let canon: SqliteCanonRepository;
let state: SqliteNarrativeStateRepository;
let reviews: SqliteReviewRepository;

beforeEach(() => {
  database = new NodeNarrativeDatabase();
  database.migrate();
  new SqliteProjectRepository(database).insert(
    createProject({ id: "p1", title: "Settlement", now }),
  );
  const story = new SqliteStoryRepository(database);
  const root = story.insertOutlineNode(
    createOutlineNode({
      id: "book",
      projectId: "p1",
      parent: null,
      kind: "book",
      ordinal: 0,
      title: "Book",
      now,
    }),
  );
  story.insertOutlineNode(
    createOutlineNode({
      id: "chapter-1",
      projectId: "p1",
      parent: root,
      kind: "chapter",
      ordinal: 0,
      title: "Chapter",
      now,
    }),
  );
  story.insertOutlineNode(
    createOutlineNode({
      id: "chapter-2",
      projectId: "p1",
      parent: root,
      kind: "chapter",
      ordinal: 1,
      title: "Chapter 2",
      now,
    }),
  );
  canon = new SqliteCanonRepository(database);
  for (const [id, name] of [
    ["hero", "Hero"],
    ["rival", "Rival"],
  ] as const) {
    canon.insertEntity(
      createCanonEntity({
        id,
        projectId: "p1",
        type: "character",
        name,
        now,
      }),
    );
  }
  const recipe = buildChapterRecipe("run-1", 0);
  new SqliteRunRepository(database).create({
    id: "run-1",
    projectId: "p1",
    recipe: recipe.name,
    recipeVersion: recipe.version,
    mode: "manual",
    targetOutlineNodeId: "chapter-1",
    policy: {},
    budgetLimit: {
      maxInputTokens: 10_000,
      maxOutputTokens: 10_000,
      maxCalls: 10,
      maxCostUsd: null,
      maxWallTimeMs: 60_000,
    },
    steps: recipe.steps,
    now,
  });
  const secondRecipe = buildChapterRecipe("run-2", 0);
  new SqliteRunRepository(database).create({
    id: "run-2",
    projectId: "p1",
    recipe: secondRecipe.name,
    recipeVersion: secondRecipe.version,
    mode: "manual",
    targetOutlineNodeId: "chapter-2",
    policy: {},
    budgetLimit: {
      maxInputTokens: 10_000,
      maxOutputTokens: 10_000,
      maxCalls: 10,
      maxCostUsd: null,
      maxWallTimeMs: 60_000,
    },
    steps: secondRecipe.steps,
    now,
  });
  state = new SqliteNarrativeStateRepository(database, canon, story);
  reviews = new SqliteReviewRepository(database);
});

afterEach(() => database.close());

describe("SettlementApplicationService", () => {
  it("applies all grounded chapter-state candidates in one transaction", () => {
    seedChangeSet("change-1", settlementPayload("awake"));
    const result = new SettlementApplicationService(database).apply({
      projectId: "p1",
      changeSetId: "change-1",
      now,
    });
    expect(result.changeSet.status).toBe("applied");
    expect(canon.listEffectiveFacts("p1")).toEqual([
      expect.objectContaining({
        predicate: "condition",
        value: "awake",
        authority: "confirmed",
      }),
    ]);
    expect(state.listTimeline("p1")).toEqual([
      expect.objectContaining({ title: "Hero wakes" }),
    ]);
    expect(state.listCurrentRelationships("p1")).toEqual([
      expect.objectContaining({ relation: "trusts" }),
    ]);
    expect(state.listForeshadows("p1")).toEqual([
      expect.objectContaining({ title: "Broken key", status: "planted" }),
    ]);
    expect(state.listKnowledge("p1")).toEqual([
      expect.objectContaining({
        knowerType: "character",
        knowerEntityId: "hero",
        factId: "change-1:fact:0",
        belief: "known",
      }),
      expect.objectContaining({
        knowerType: "character",
        knowerEntityId: "rival",
        timelineEventId: "change-1:timeline:0",
        belief: "suspected",
      }),
    ]);
  });

  it("updates relationships and foreshadows by stable id and preserves timeline causality", () => {
    seedChangeSet("change-1", settlementPayload("awake"));
    new SettlementApplicationService(database).apply({
      projectId: "p1",
      changeSetId: "change-1",
      now,
    });
    seedChangeSet(
      "change-3",
      {
        summary: "Trust deepens while the key clue develops.",
        summaryPoints: [
          {
            text: "Trust deepens while the key clue develops.",
            basis: "observed",
            evidenceParagraphs: [1],
            evidence: [groundedEvidence("becomes alert")],
          },
        ],
        stateDelta: [
          {
            key: "hero.condition",
            before: "awake",
            after: "alert",
            evidenceParagraphs: [1],
            evidence: [groundedEvidence("becomes alert")],
          },
        ],
        factCandidates: [
          {
            operation: "supersede",
            factId: "change-1:fact:0",
            subjectId: "hero",
            predicate: "condition",
            objectEntityId: null,
            value: "alert",
            knowledgeScope: "character",
            knowledgeSubjectId: "hero",
            belief: "known",
            evidenceParagraphs: [1],
            evidence: [groundedEvidence("becomes alert")],
          },
        ],
        timelineCandidates: [
          {
            title: "Rival reveals the map",
            description: null,
            storyTime: "noon",
            participantIds: ["hero", "rival"],
            causeEventIds: ["change-1:timeline:0"],
            visibility: "author_secret",
            knownBy: [{ entityId: "hero", belief: "known" }],
            evidenceParagraphs: [1],
            evidence: [groundedEvidence("reveals the map")],
          },
        ],
        relationshipCandidates: [
          {
            action: "update",
            relationshipId: "change-1:relationship:0",
            fromEntityId: "hero",
            toEntityId: "rival",
            relation: "allies",
            change: "mutual trust becomes an alliance",
            evidenceParagraphs: [1],
            evidence: [groundedEvidence("alliance")],
          },
        ],
        foreshadowCandidates: [
          {
            foreshadowId: "change-1:foreshadow:0",
            title: "Broken key",
            action: "develop",
            expectedStatus: "planted",
            importance: 3,
            targetFromNodeId: "chapter-1",
            targetToNodeId: null,
            evidenceParagraphs: [1],
            evidence: [groundedEvidence("key fits the map")],
          },
        ],
      },
      "run-2",
    );

    new SettlementApplicationService(database).apply({
      projectId: "p1",
      changeSetId: "change-3",
      now: "2026-08-10T00:02:00.000Z",
    });

    expect(state.listCurrentRelationships("p1")).toEqual([
      expect.objectContaining({
        id: "change-3:relationship:0",
        relation: "allies",
        supersedesEventId: "change-1:relationship:0",
      }),
    ]);
    expect(canon.listEffectiveFacts("p1")).toEqual([
      expect.objectContaining({
        id: "change-3:fact:0",
        value: "alert",
        supersedesFactId: "change-1:fact:0",
      }),
    ]);
    expect(state.listTimeline("p1")).toEqual([
      expect.objectContaining({ id: "change-1:timeline:0", causes: [] }),
      expect.objectContaining({
        id: "change-3:timeline:0",
        causes: ["change-1:timeline:0"],
        visibility: "author_secret",
      }),
    ]);
    expect(state.listForeshadows("p1")).toEqual([
      expect.objectContaining({
        id: "change-1:foreshadow:0",
        status: "developing",
        evidenceNodeIds: ["chapter-1", "chapter-2"],
      }),
    ]);
    expect(state.listKnowledge("p1")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          timelineEventId: "change-3:timeline:0",
          learnedAtNodeId: "chapter-2",
        }),
      ]),
    );

    seedChangeSet(
      "change-5",
      {
        summary: "The broken key clue is resolved.",
        summaryPoints: [
          {
            text: "The broken key clue is resolved.",
            basis: "observed",
            evidenceParagraphs: [1],
            evidence: [groundedEvidence("the key opens the chart case")],
          },
        ],
        stateDelta: [],
        factCandidates: [],
        timelineCandidates: [],
        relationshipCandidates: [],
        foreshadowCandidates: [
          {
            foreshadowId: "change-1:foreshadow:0",
            title: "Broken key",
            action: "resolve",
            expectedStatus: "developing",
            importance: 3,
            targetFromNodeId: "chapter-1",
            targetToNodeId: null,
            evidenceParagraphs: [1],
            evidence: [groundedEvidence("the key opens the chart case")],
          },
        ],
      },
      "run-2",
    );
    new SettlementApplicationService(database).apply({
      projectId: "p1",
      changeSetId: "change-5",
      now: "2026-08-10T00:03:00.000Z",
    });
    expect(state.listForeshadows("p1")).toEqual([
      expect.objectContaining({
        id: "change-1:foreshadow:0",
        status: "resolved",
        resolutionNodeId: "chapter-2",
      }),
    ]);
  });

  it("rolls back on locked conflicts, then applies an explicitly confirmed supersede", () => {
    canon.insertFact(
      createCanonFact({
        id: "existing-condition",
        projectId: "p1",
        subjectId: "hero",
        predicate: "condition",
        value: "asleep",
        authority: "locked",
        sourceType: "test",
        now,
      }),
    );
    seedChangeSet(
      "change-2",
      settlementPayload("awake", {
        operation: "supersede",
        factId: "existing-condition",
      }),
    );
    const service = new SettlementApplicationService(database);
    expect(() =>
      service.apply({ projectId: "p1", changeSetId: "change-2", now }),
    ).toThrow(SettlementConflictError);
    expect(state.listTimeline("p1")).toHaveLength(0);
    expect(reviews.requireCanonChangeSet("p1", "change-2").status).toBe(
      "candidate",
    );

    const completed = service.apply({
      projectId: "p1",
      changeSetId: "change-2",
      conflictPolicy: "force",
      now: "2026-08-10T00:01:00.000Z",
    });
    expect(completed.changeSet.status).toBe("applied");
    expect(canon.listEffectiveFacts("p1")).toEqual([
      expect.objectContaining({
        value: "awake",
        supersedesFactId: "existing-condition",
      }),
    ]);
    expect(state.listTimeline("p1")).toHaveLength(1);
  });

  it("adds an asserted proposition without guessing a supersession target", () => {
    canon.insertFact(
      createCanonFact({
        id: "existing-condition",
        projectId: "p1",
        subjectId: "hero",
        predicate: "condition",
        value: "asleep",
        authority: "confirmed",
        sourceType: "test",
        now,
      }),
    );
    seedChangeSet("change-4", settlementPayload("awake"));

    new SettlementApplicationService(database).apply({
      projectId: "p1",
      changeSetId: "change-4",
      now,
    });
    expect(canon.listEffectiveFacts("p1")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "existing-condition", value: "asleep" }),
        expect.objectContaining({ id: "change-4:fact:0", value: "awake" }),
      ]),
    );
    expect(state.listTimeline("p1")).toHaveLength(1);
  });

  it("reuses an identical proposition while recording new knowledge", () => {
    seedChangeSet("change-1", settlementPayload("awake"));
    const service = new SettlementApplicationService(database);
    service.apply({ projectId: "p1", changeSetId: "change-1", now });
    seedChangeSet("change-4", settlementPayload("awake"), "run-2");

    service.apply({
      projectId: "p1",
      changeSetId: "change-4",
      now: "2026-08-10T00:01:00.000Z",
    });

    expect(
      canon
        .listEffectiveFacts("p1")
        .filter(
          (fact) => fact.predicate === "condition" && fact.value === "awake",
        ),
    ).toHaveLength(1);
    expect(state.listKnowledge("p1")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "change-1:knowledge:fact:0",
          factId: "change-1:fact:0",
        }),
        expect.objectContaining({
          id: "change-4:knowledge:fact:0",
          factId: "change-1:fact:0",
        }),
      ]),
    );
  });
});

function seedChangeSet(
  id: string,
  changes: Record<string, unknown>,
  runId = "run-1",
): void {
  reviews.insertCanonChangeSet({
    id,
    projectId: "p1",
    runId,
    stepId: `${runId}:commit`,
    changes,
    status: "candidate",
    createdAt: now,
  });
}

function settlementPayload(
  value: string,
  factOperation: {
    operation: "assert" | "supersede";
    factId: string | null;
  } = {
    operation: "assert",
    factId: null,
  },
): Record<string, unknown> {
  return {
    summary: "The hero wakes and trusts the rival.",
    summaryPoints: [
      {
        text: "The hero wakes and trusts the rival.",
        basis: "observed",
        evidenceParagraphs: [1],
        evidence: [groundedEvidence("wakes")],
      },
    ],
    stateDelta: [
      {
        key: "hero.condition",
        before: "asleep",
        after: value,
        evidenceParagraphs: [1],
        evidence: [groundedEvidence("wakes")],
      },
    ],
    factCandidates: [
      {
        ...factOperation,
        subjectId: "hero",
        predicate: "condition",
        objectEntityId: null,
        value,
        knowledgeScope: "character",
        knowledgeSubjectId: "hero",
        belief: "known",
        evidenceParagraphs: [1],
        evidence: [groundedEvidence("wakes")],
      },
    ],
    timelineCandidates: [
      {
        title: "Hero wakes",
        description: null,
        storyTime: "dawn",
        participantIds: ["hero"],
        causeEventIds: [],
        visibility: "reader",
        knownBy: [{ entityId: "rival", belief: "suspected" }],
        evidenceParagraphs: [1],
        evidence: [groundedEvidence("wakes")],
      },
    ],
    relationshipCandidates: [
      {
        action: "start",
        relationshipId: null,
        fromEntityId: "hero",
        toEntityId: "rival",
        relation: "trusts",
        change: "trust increases",
        evidenceParagraphs: [1],
        evidence: [groundedEvidence("trusts")],
      },
    ],
    foreshadowCandidates: [
      {
        foreshadowId: null,
        title: "Broken key",
        action: "plant",
        expectedStatus: null,
        importance: 3,
        targetFromNodeId: "chapter-1",
        targetToNodeId: null,
        evidenceParagraphs: [1],
        evidence: [groundedEvidence("broken key")],
      },
    ],
  };
}

function groundedEvidence(quote: string) {
  return {
    quote,
    start: 0,
    end: quote.length,
    documentVersionId: null,
    contentHash: "a".repeat(64),
    paragraphOrdinal: 1,
  };
}
