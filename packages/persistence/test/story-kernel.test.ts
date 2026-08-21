import {
  createCanonEntity,
  createCanonFact,
  createOutlineNode,
  createProject,
  type Foreshadow,
  type RelationshipEvent,
  type TimelineEvent,
} from "@narralume/domain";
import { NodeNarrativeDatabase } from "../src/node.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SqliteCanonRepository,
  SqliteNarrativeStateRepository,
  SqliteProjectRepository,
  SqliteRetrievalRepository,
  SqliteStoryRepository,
} from "../src/index.js";

const now = "2026-08-10T00:00:00.000Z";
let db: NodeNarrativeDatabase;
let projects: SqliteProjectRepository;
let story: SqliteStoryRepository;
let canon: SqliteCanonRepository;
let state: SqliteNarrativeStateRepository;
let retrieval: SqliteRetrievalRepository;

beforeEach(() => {
  db = new NodeNarrativeDatabase();
  db.migrate();
  projects = new SqliteProjectRepository(db);
  story = new SqliteStoryRepository(db);
  canon = new SqliteCanonRepository(db);
  state = new SqliteNarrativeStateRepository(db, canon, story);
  retrieval = new SqliteRetrievalRepository(db);
  projects.insert(createProject({ id: "p1", title: "潮汐灯塔", now }));
  projects.insert(createProject({ id: "p2", title: "另一部书", now }));
});

afterEach(() => db.close());

function seedOutline() {
  const book = story.insertOutlineNode(
    createOutlineNode({
      id: "book",
      projectId: "p1",
      parent: null,
      kind: "book",
      ordinal: 0,
      title: "潮汐灯塔",
      now,
    }),
  );
  const chapter1 = story.insertOutlineNode(
    createOutlineNode({
      id: "chapter-1",
      projectId: "p1",
      parent: book,
      kind: "chapter",
      ordinal: 0,
      title: "雾港",
      now,
    }),
  );
  const chapter2 = story.insertOutlineNode(
    createOutlineNode({
      id: "chapter-2",
      projectId: "p1",
      parent: book,
      kind: "chapter",
      ordinal: 1,
      title: "失灯",
      now,
    }),
  );
  return { book, chapter1, chapter2 };
}

function seedEntities() {
  const hero = canon.insertEntity(
    createCanonEntity({
      id: "hero",
      projectId: "p1",
      type: "character",
      name: "林昭",
      description: "守灯人的女儿，害怕深水。",
      now,
    }),
  );
  const harbor = canon.insertEntity(
    createCanonEntity({
      id: "harbor",
      projectId: "p1",
      type: "location",
      name: "雾港",
      aliases: ["旧港"],
      now,
    }),
  );
  return { hero, harbor };
}

describe("story and canon repositories", () => {
  it("orders outline trees and isolates every read by project", () => {
    const { book, chapter1, chapter2 } = seedOutline();
    expect(story.listOutline("p1").map((node) => node.id)).toEqual([
      book.id,
      chapter1.id,
      chapter2.id,
    ]);
    expect(story.getOutlineNode("p2", chapter1.id)).toBeNull();
  });

  it("promotes facts append-only and reports conflicting effective truths", () => {
    seedOutline();
    const { hero, harbor } = seedEntities();
    const candidate = canon.insertFact(
      createCanonFact({
        id: "fact-candidate",
        projectId: "p1",
        subjectId: hero.id,
        predicate: "当前位置",
        objectEntityId: harbor.id,
        authority: "candidate",
        sourceType: "chapter",
        sourceId: "chapter-1",
        now,
      }),
    );
    const promoted = canon.promoteFact(
      "p1",
      candidate.id,
      "fact-confirmed",
      "confirmed",
      now,
    );
    expect(promoted.supersedesFactId).toBe(candidate.id);
    expect(canon.listEffectiveFacts("p1")).toEqual([promoted]);

    const conflicting = createCanonFact({
      id: "fact-conflict",
      projectId: "p1",
      subjectId: hero.id,
      predicate: "当前位置",
      value: "灯塔顶层",
      authority: "candidate",
      sourceType: "ai",
      now,
    });
    expect(canon.findConflicts(conflicting)).toEqual([
      expect.objectContaining({ fact: promoted, reason: "different_object" }),
    ]);
    expect(
      canon.withdrawFact({
        factId: promoted.id,
        projectId: "p1",
        reason: "设定已废弃",
        withdrawnAt: "2026-08-10T00:02:00.000Z",
      }),
    ).toMatchObject({ factId: promoted.id, reason: "设定已废弃" });
    expect(canon.listEffectiveFacts("p1", { includeCandidates: true })).toEqual(
      [],
    );
    expect(canon.getFact("p1", promoted.id)).toEqual(promoted);
    expect(canon.getEntity("p2", hero.id)).toBeNull();
    expect(canon.searchEntities("p1", "守灯人的女儿")[0]?.id).toBe(hero.id);
  });
});

describe("narrative state and retrieval", () => {
  it("projects latest relationships and round-trips timeline causal links", () => {
    const { chapter1, chapter2 } = seedOutline();
    const { hero, harbor } = seedEntities();
    const first: RelationshipEvent = {
      id: "rel-1",
      projectId: "p1",
      fromEntityId: hero.id,
      toEntityId: harbor.id,
      relation: "归属",
      intensity: 0.4,
      state: { voluntary: false },
      outlineNodeId: chapter1.id,
      storyTime: "第1日",
      sourceId: chapter1.id,
      supersedesEventId: null,
      createdAt: now,
    };
    state.insertRelationship(first);
    state.insertRelationship({
      ...first,
      id: "rel-2",
      intensity: 0.9,
      supersedesEventId: first.id,
      createdAt: "2026-08-10T00:01:00.000Z",
    });
    expect(state.listCurrentRelationships("p1")).toEqual([
      expect.objectContaining({ id: "rel-2", intensity: 0.9 }),
    ]);

    const arrival: TimelineEvent = {
      id: "event-1",
      projectId: "p1",
      title: "林昭抵达雾港",
      description: null,
      outlineNodeId: chapter1.id,
      storyTimeStart: "第1日 黄昏",
      storyTimeEnd: null,
      sequence: 1,
      participants: [hero.id, harbor.id],
      causes: [],
      visibility: "reader",
      sourceId: chapter1.id,
      createdAt: now,
      updatedAt: now,
    };
    const loss: TimelineEvent = {
      ...arrival,
      id: "event-2",
      title: "主灯熄灭",
      outlineNodeId: chapter2.id,
      sequence: 2,
      causes: [arrival.id],
    };
    state.insertTimelineEvent(arrival);
    state.insertTimelineEvent(loss);
    expect(state.listTimeline("p1")[1]).toMatchObject({
      id: "event-2",
      causes: ["event-1"],
      participants: ["harbor", "hero"],
    });
    state.updateTimelineEvent({ ...loss, title: "主灯彻底熄灭" });
    expect(state.listRevisions("p1", "timeline", loss.id)).toEqual([
      expect.objectContaining({ operation: "create", before: null }),
      expect.objectContaining({
        operation: "update",
        before: expect.objectContaining({ title: loss.title }),
        after: expect.objectContaining({ title: "主灯彻底熄灭" }),
      }),
    ]);
    const aftermath: TimelineEvent = {
      ...loss,
      id: "event-3",
      title: "港口封锁",
      sequence: 3,
      causes: [loss.id],
    };
    state.insertTimelineEvent(aftermath);
    expect(() =>
      state.updateTimelineEvent({ ...arrival, causes: [aftermath.id] }),
    ).toThrowError(/cycle/u);
    expect(
      state.listTimeline("p1").find((event) => event.id === arrival.id)?.causes,
    ).toEqual([]);
  });

  it("keeps the current causal projection closed after voiding a cause", () => {
    const { chapter1, chapter2 } = seedOutline();
    const cause: TimelineEvent = {
      id: "voided-cause",
      projectId: "p1",
      title: "已作废前件",
      description: null,
      outlineNodeId: chapter1.id,
      storyTimeStart: null,
      storyTimeEnd: null,
      sequence: 1,
      participants: [],
      causes: [],
      visibility: "omniscient",
      sourceId: "chapter-1",
      createdAt: now,
      updatedAt: now,
    };
    const effect: TimelineEvent = {
      ...cause,
      id: "visible-effect",
      title: "仍然可见的后件",
      outlineNodeId: chapter2.id,
      sequence: 2,
      causes: [cause.id],
    };
    state.insertTimelineEvent(cause);
    state.insertTimelineEvent(effect);

    expect(
      state.removeTimelineEvent("p1", cause.id, "2026-08-19T00:01:00Z"),
    ).toMatchObject({ disposition: "voided" });
    expect(state.listTimeline("p1")).toEqual([
      expect.objectContaining({ id: effect.id, causes: [] }),
    ]);
    expect(() =>
      state.insertTimelineEvent({
        ...effect,
        id: "new-effect",
        sequence: 3,
        causes: [cause.id],
      }),
    ).toThrowError(/does not exist/u);
    expect(() =>
      state.updateTimelineEvent({ ...effect, causes: [cause.id] }),
    ).toThrowError(/does not exist/u);
    expect(state.listTimeline("p1")).toEqual([
      expect.objectContaining({ id: effect.id, causes: [] }),
    ]);
  });

  it("stores foreshadow DAG data, summaries, and retrieves Chinese text by FTS plus entity", () => {
    const { chapter1, chapter2 } = seedOutline();
    const { hero, harbor } = seedEntities();
    const clue: Foreshadow = {
      id: "clue-1",
      projectId: "p1",
      title: "铜钥匙上的盐",
      description: "暗示钥匙来自被淹没的旧港仓库。",
      status: "planted",
      importance: 4,
      targetFromNodeId: chapter2.id,
      targetToNodeId: null,
      dependencies: [],
      evidenceNodeIds: [chapter1.id],
      resolutionNodeId: null,
      createdAt: now,
      updatedAt: now,
      updatedAt: now,
    };
    state.insertForeshadow(clue);
    state.insertForeshadow({
      ...clue,
      id: "clue-2",
      title: "潮汐密室",
      dependencies: [clue.id],
      evidenceNodeIds: [chapter2.id],
    });
    state.insertForeshadow({
      ...clue,
      id: "clue-3",
      title: "第三层线索",
      dependencies: ["clue-2"],
      evidenceNodeIds: [chapter2.id],
    });
    expect(() =>
      state.updateForeshadow({ ...clue, dependencies: ["clue-3"] }),
    ).toThrowError(/cycle/u);
    expect(state.listRevisions("p1", "foreshadow", clue.id)).toEqual([
      expect.objectContaining({ operation: "create" }),
    ]);
    expect(
      state.listForeshadows("p1").find((item) => item.id === "clue-2")
        ?.dependencies,
    ).toEqual(["clue-1"]);

    state.upsertSummary({
      id: "sum-1",
      projectId: "p1",
      scopeType: "chapter",
      scopeId: chapter1.id,
      summary: "林昭在浓雾中抵达港口。",
      stateDelta: { location: harbor.id },
      sourceHash: "hash-1",
      createdAt: now,
    });
    expect(
      state.latestSummary("p1", "chapter", chapter1.id)?.summary,
    ).toContain("浓雾");

    retrieval.upsertSegment({
      id: "segment-1",
      projectId: "p1",
      sourceType: "chapter",
      sourceId: chapter1.id,
      title: "雾港抵达",
      content: "林昭穿过潮湿的石门，看见守灯人的旧徽记。",
      authority: "confirmed",
      metadata: { chapter: 1 },
      entityIds: [hero.id, harbor.id],
      createdAt: now,
      updatedAt: now,
    });
    retrieval.upsertEmbedding({
      segmentId: "segment-1",
      model: "test-semantic-v1",
      embedding: [1, 0, 0],
      updatedAt: now,
    });
    expect(
      retrieval.search("p1", "潮湿的石门", {
        entityIds: [hero.id],
        queryEmbedding: [1, 0, 0],
        embeddingModel: "test-semantic-v1",
      })[0],
    ).toMatchObject({
      id: "segment-1",
      reasons: ["fts", "entity", "vector"],
      entityIds: ["harbor", "hero"],
    });
    expect(
      retrieval.search("p1", "守灯人徽记", {
        rerank: true,
        queryEmbedding: [1, 0, 0],
        embeddingModel: "test-semantic-v1",
      })[0],
    ).toMatchObject({
      id: "segment-1",
      reasons: expect.arrayContaining(["vector", "rerank"]),
      vectorScore: expect.any(Number),
      rerankScore: expect.any(Number),
    });
    expect(retrieval.search("p2", "潮湿的石门")).toEqual([]);
  });
});
