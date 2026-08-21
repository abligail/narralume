import { randomUUID } from "node:crypto";

import { buildCanonCandidateRecipe } from "@narralume/harness";
import { SqliteRunRepository } from "@narralume/persistence";
import { NodeNarrativeDatabase } from "@narralume/persistence/node";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";

const config: ServerConfig = {
  dataDirectory: ".",
  databasePath: ":memory:",
  host: "127.0.0.1",
  port: 4317,
  environment: "test",
};

const resources: {
  app: Awaited<ReturnType<typeof buildApp>>;
  database: NodeNarrativeDatabase;
}[] = [];

afterEach(async () => {
  while (resources.length) {
    const resource = resources.pop();
    await resource?.app.close();
    resource?.database.close();
  }
});

async function setup() {
  const database = new NodeNarrativeDatabase();
  const app = await buildApp({
    config,
    database,
    environment: {},
    logger: false,
  });
  resources.push({ app, database });
  return { app, database };
}

async function createProject(
  app: Awaited<ReturnType<typeof buildApp>>,
  title = "潮汐灯塔",
) {
  const response = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: {
      requestId: randomUUID(),
      title,
      premise: "守灯人的女儿发现每次灯塔熄灭，港口都会遗忘一个人。",
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json() as { id: string; title: string };
}

describe("story kernel API", () => {
  it("replays manual project and document creation requests", async () => {
    const { app, database } = await setup();
    const projectRequest = {
      requestId: "manual-project-replay",
      title: "重放建书",
      premise: null,
    };
    const firstProject = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: projectRequest,
    });
    const replayedProject = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: projectRequest,
    });
    expect(firstProject.statusCode).toBe(201);
    expect(replayedProject.statusCode).toBe(201);
    expect(replayedProject.json()).toEqual(firstProject.json());

    const projectConflict = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { ...projectRequest, title: "不同书名" },
    });
    expect(projectConflict.statusCode).toBe(409);
    expect(projectConflict.json()).toMatchObject({
      error: { code: "project.create.idempotency_conflict" },
    });

    const projectId = firstProject.json().id as string;
    const documentRequest = {
      requestId: "manual-document-replay",
      kind: "note",
      title: "同一份笔记",
      outlineNodeId: null,
    };
    const firstDocument = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/documents`,
      payload: documentRequest,
    });
    const replayedDocument = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/documents`,
      payload: documentRequest,
    });
    expect(firstDocument.statusCode).toBe(201);
    expect(replayedDocument.statusCode).toBe(201);
    expect(replayedDocument.json()).toEqual(firstDocument.json());

    const documentConflict = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/documents`,
      payload: { ...documentRequest, title: "另一份笔记" },
    });
    expect(documentConflict.statusCode).toBe(409);
    expect(documentConflict.json()).toMatchObject({
      error: { code: "document.create.idempotency_conflict" },
    });
    expect(
      database.raw.prepare("SELECT COUNT(*) AS count FROM projects").get(),
    ).toEqual({ count: 1 });
    expect(
      database.raw
        .prepare("SELECT COUNT(*) AS count FROM documents WHERE project_id = ?")
        .get(projectId),
    ).toEqual({ count: 1 });
  });

  it("creates a fully initialized project and story-bible snapshot", async () => {
    const { app } = await setup();
    const project = await createProject(app);
    const response = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/story-bible`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      project: { id: project.id, title: "潮汐灯塔" },
      intent: { projectId: project.id, themes: [], boundaries: [] },
      outline: [{ kind: "book", title: "潮汐灯塔", depth: 0 }],
      documents: [],
      entities: [],
      facts: [],
    });
  });

  it("reports shelf writing progress and supports optimistic rename and archive", async () => {
    const { app } = await setup();
    const project = await createProject(app, "旧书名");
    const note = (
      await app.inject({
        method: "POST",
        url: `/api/projects/${project.id}/documents`,
        payload: {
          requestId: "shelf-progress-note",
          kind: "note",
          title: "开篇笔记",
          outlineNodeId: null,
        },
      })
    ).json() as { id: string };
    await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/documents/${note.id}/versions`,
      payload: {
        content: "潮水退去，盐痕留在石阶上。",
        source: "manual",
        expectedCurrentVersionId: null,
      },
    });

    const shelf = await app.inject({ method: "GET", url: "/api/projects" });
    expect(shelf.statusCode).toBe(200);
    expect(shelf.json()).toEqual([
      expect.objectContaining({
        id: project.id,
        wordCount: 0,
        lastWritingAt: null,
        committedChapters: 0,
        totalChapters: 0,
      }),
    ]);
    const current = shelf.json()[0] as { updatedAt: string };
    const archived = await app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}`,
      payload: {
        title: "潮痕",
        subtitle: null,
        premise: "守灯人的女儿发现每次灯塔熄灭，港口都会遗忘一个人。",
        archived: true,
        expectedUpdatedAt: current.updatedAt,
      },
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json()).toMatchObject({
      title: "潮痕",
      archivedAt: expect.any(String),
    });
    expect(
      (await app.inject({ method: "GET", url: "/api/projects" })).json(),
    ).toEqual([]);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/projects?includeArchived=true",
        })
      ).json(),
    ).toEqual([expect.objectContaining({ id: project.id, title: "潮痕" })]);
  });

  it("pages the project shelf beyond the first 100 records", async () => {
    const { app, database } = await setup();
    const insert = database.raw.prepare(
      `INSERT INTO projects(
         id, title, subtitle, premise, language, phase, archived_at, created_at, updated_at
       ) VALUES (?, ?, NULL, NULL, 'zh-CN', 'idea', NULL, ?, ?)`,
    );
    database.transaction(() => {
      for (let index = 0; index < 101; index += 1) {
        const id = `project-${String(index).padStart(3, "0")}`;
        const timestamp = new Date(
          Date.UTC(2026, 7, 1, 0, index),
        ).toISOString();
        insert.run(id, `作品 ${index}`, timestamp, timestamp);
      }
    });

    const first = await app.inject({ method: "GET", url: "/api/projects" });
    const second = await app.inject({
      method: "GET",
      url: "/api/projects?offset=100",
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json()).toHaveLength(100);
    expect(second.json()).toHaveLength(1);
    expect([
      ...(first.json() as { id: string }[]),
      ...(second.json() as { id: string }[]),
    ]).toHaveLength(101);
  });

  it("returns narrative state validation errors as actionable 422 responses", async () => {
    const { app } = await setup();
    const project = await createProject(app, "因果校验");
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/timeline`,
      payload: {
        title: "不存在的因果后件",
        description: null,
        outlineNodeId: null,
        storyTimeStart: "第一日",
        storyTimeEnd: null,
        sequence: 1,
        participants: [],
        causes: ["missing-cause"],
        visibility: "reader",
        sourceId: null,
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: {
        code: "timeline.cause.not_found",
        message: "Causal antecedent missing-cause does not exist",
        requestId: expect.any(String),
      },
    });
    const bible = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/story-bible`,
    });
    expect(bible.json()).toMatchObject({ timeline: [] });
  });

  it("returns one product overview with chapter progress and the next action", async () => {
    const { app } = await setup();
    const project = await createProject(app, "总览测试");
    const bible = (
      await app.inject({
        method: "GET",
        url: `/api/projects/${project.id}/story-bible`,
      })
    ).json() as { outline: Array<{ id: string; kind: string }> };
    const chapter = (
      await app.inject({
        method: "POST",
        url: `/api/projects/${project.id}/outline`,
        payload: {
          parentId: bible.outline.find((node) => node.kind === "book")!.id,
          kind: "chapter",
          ordinal: 0,
          title: "第一章",
        },
      })
    ).json() as { id: string };

    const initial = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/overview`,
    });
    expect(initial.statusCode, initial.body).toBe(200);
    expect(initial.json()).toMatchObject({
      progress: { wordCount: 0, committedChapters: 0, totalChapters: 1 },
      currentChapter: {
        outlineNodeId: chapter.id,
        title: "第一章",
        documentId: null,
      },
      activeTask: null,
      pending: {
        foundationCandidates: 0,
        reviewIssues: 0,
        revisionProposals: 0,
        canonChangeSets: 0,
      },
      nextAction: { kind: "write_chapter", targetId: chapter.id },
    });

    const document = (
      await app.inject({
        method: "POST",
        url: `/api/projects/${project.id}/documents`,
        payload: {
          requestId: "overview-chapter-document",
          kind: "chapter",
          title: "第一章",
          outlineNodeId: chapter.id,
        },
      })
    ).json() as { id: string };
    const committed = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/documents/${document.id}/versions`,
      payload: {
        content: "第一章正文",
        source: "manual",
        expectedCurrentVersionId: null,
      },
    });
    expect(committed.statusCode, committed.body).toBe(201);

    const completed = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/overview`,
    });
    expect(completed.statusCode, completed.body).toBe(200);
    expect(completed.json()).toMatchObject({
      progress: { wordCount: 5, committedChapters: 1, totalChapters: 1 },
      currentChapter: null,
      nextAction: { kind: "complete", targetId: null },
    });
  });

  it("does not promote local AI runs to the project primary task (CR-06)", async () => {
    const { app, database } = await setup();
    const project = await createProject(app, "局部任务隔离");
    const runId = randomUUID();
    const recipe = buildCanonCandidateRecipe(runId);
    new SqliteRunRepository(database).create({
      id: runId,
      projectId: project.id,
      recipe: recipe.name,
      recipeVersion: recipe.version,
      mode: "manual",
      targetOutlineNodeId: null,
      policy: {},
      budgetLimit: {
        maxInputTokens: 10_000,
        maxOutputTokens: 2_000,
        maxCalls: 2,
        maxCostUsd: null,
        maxWallTimeMs: 60_000,
      },
      steps: recipe.steps,
      now: new Date().toISOString(),
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/overview`,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      activeTask: null,
      nextAction: { kind: "build_outline", targetId: null },
    });
  });

  it("round-trips the story bible and compiles an auditable context", async () => {
    const { app, database } = await setup();
    const project = await createProject(app);
    const initial = (
      await app.inject({
        method: "GET",
        url: `/api/projects/${project.id}/story-bible`,
      })
    ).json() as {
      outline: { id: string }[];
      documents: { id: string; currentVersionId: string | null }[];
      intent: { updatedAt: string } | null;
    };
    const bookId = initial.outline[0]!.id;

    const intent = await app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/intent`,
      payload: {
        promise: "每一次超自然异象都必须付出可见代价。",
        themes: ["记忆", "责任"],
        tone: "潮湿、克制、带微光",
        boundaries: ["不以失忆作为廉价反转"],
        lockedFields: ["promise", "boundaries"],
        expectedUpdatedAt: initial.intent?.updatedAt ?? null,
      },
    });
    expect(intent.statusCode).toBe(200);

    const heroResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/entities`,
      payload: {
        type: "character",
        name: "林昼",
        aliases: ["阿昼"],
        description: "守灯人的女儿，能记住被港口遗忘的人。",
        attributes: { age: 19 },
      },
    });
    const harborResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/entities`,
      payload: {
        type: "location",
        name: "沉雾港",
        aliases: [],
        description: "被潮汐与遗忘规则笼罩的港口。",
      },
    });
    expect(heroResponse.statusCode).toBe(201);
    expect(harborResponse.statusCode).toBe(201);
    const hero = heroResponse.json() as { id: string };
    const harbor = harborResponse.json() as { id: string };

    const chapterResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/outline`,
      payload: {
        parentId: bookId,
        kind: "chapter",
        ordinal: 0,
        title: "雾港失灯",
        summary: "林昼回港当夜，灯塔第一次在她面前熄灭。",
        goal: "让林昼发现遗忘规则",
        conflict: "父亲拒绝承认失踪者存在",
        metadata: {},
      },
    });
    expect(chapterResponse.statusCode).toBe(201);
    const chapter = chapterResponse.json() as { id: string };

    const fact1 = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/facts`,
      payload: {
        subjectId: hero.id,
        predicate: "居住于",
        objectEntityId: harbor.id,
        authority: "candidate",
        knowledgeScope: "reader",
      },
    });
    expect(fact1.statusCode).toBe(201);
    const firstFact = fact1.json() as { fact: { id: string } };
    const promotion = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/facts/${firstFact.fact.id}/promote`,
      payload: { authority: "locked" },
    });
    expect(promotion.statusCode).toBe(201);

    const conflicting = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/facts`,
      payload: {
        subjectId: hero.id,
        predicate: "居住于",
        value: "内陆旧城",
        authority: "candidate",
      },
    });
    expect(conflicting.statusCode).toBe(201);
    expect(conflicting.json()).toMatchObject({
      conflicts: [{ reason: "different_object" }],
    });

    const relationship = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/relationships`,
      payload: {
        fromEntityId: hero.id,
        toEntityId: harbor.id,
        relation: "守护",
        intensity: 0.8,
        state: { reluctant: true },
        outlineNodeId: chapter.id,
        storyTime: "海历 117 年·秋",
        sourceId: null,
      },
    });
    expect(relationship.statusCode).toBe(201);
    const relationshipEvent = relationship.json() as { id: string };
    const relationshipCorrection = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/relationships`,
      payload: {
        fromEntityId: hero.id,
        toEntityId: harbor.id,
        relation: "守护",
        intensity: 0.95,
        state: { willing: true },
        outlineNodeId: chapter.id,
        storyTime: "海历 117 年·冬",
        sourceId: null,
        supersedesEventId: relationshipEvent.id,
      },
    });
    expect(relationshipCorrection.statusCode).toBe(201);

    const timelineResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/timeline`,
      payload: {
        title: "灯塔熄灭",
        description: "第一位居民从所有人的记忆中消失。",
        outlineNodeId: chapter.id,
        storyTimeStart: "海历 117-09-03 23:40",
        storyTimeEnd: null,
        sequence: 10,
        participants: [hero.id],
        causes: [],
        visibility: "reader",
        sourceId: null,
      },
    });
    expect(timelineResponse.statusCode).toBe(201);
    const timeline = timelineResponse.json() as {
      id: string;
      createdAt: string;
      updatedAt: string;
    };

    const foreshadow = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/foreshadows`,
      payload: {
        title: "银钥匙上的盐",
        description: "钥匙来自已被淹没的旧港仓库。",
        status: "planted",
        importance: 4,
        targetFromNodeId: chapter.id,
        targetToNodeId: null,
        dependencies: [],
        evidenceNodeIds: [chapter.id],
        resolutionNodeId: null,
      },
    });
    expect(foreshadow.statusCode).toBe(201);
    const foreshadowItem = foreshadow.json() as {
      id: string;
      updatedAt: string;
    };

    const correctedTimeline = await app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/timeline/${timeline.id}`,
      payload: {
        title: "灯塔在午夜熄灭",
        description: "第一位居民从所有人的记忆中消失。",
        outlineNodeId: chapter.id,
        storyTimeStart: "海历 117-09-04 00:00",
        storyTimeEnd: null,
        sequence: 11,
        participants: [hero.id],
        causes: [],
        visibility: "reader",
        sourceId: timeline.id,
        expectedUpdatedAt: timeline.updatedAt,
      },
    });
    expect(correctedTimeline.statusCode).toBe(200);
    expect(correctedTimeline.json()).toMatchObject({
      title: "灯塔在午夜熄灭",
      sequence: 11,
    });

    const correctedForeshadow = await app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/foreshadows/${foreshadowItem.id}`,
      payload: {
        title: "银钥匙上的盐",
        description: "钥匙来自已被淹没的旧港仓库。",
        status: "developing",
        importance: 5,
        targetFromNodeId: chapter.id,
        targetToNodeId: null,
        dependencies: [],
        evidenceNodeIds: [chapter.id],
        resolutionNodeId: null,
        expectedUpdatedAt: foreshadowItem.updatedAt,
      },
    });
    expect(correctedForeshadow.statusCode).toBe(200);
    expect(correctedForeshadow.json()).toMatchObject({
      status: "developing",
      importance: 5,
    });

    const preview = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/context/preview`,
      payload: {
        purpose: "chapter-draft",
        task: "续写林昼进入熄灭的灯塔，不得改变锁定事实。",
        query: "灯塔熄灭",
        entityIds: [hero.id, harbor.id],
        currentOutlineNodeId: chapter.id,
        access: { audience: "author", includeCandidates: false },
      },
    });
    expect(preview.statusCode).toBe(200);
    const compiled = preview.json() as {
      text: string;
      sections: { kind: string }[];
      receipt: { id: string; compiledHash: string; entries: unknown[] };
    };
    expect(compiled.text).toContain("本轮任务");
    expect(compiled.sections.map((section) => section.kind)).toEqual(
      expect.arrayContaining(["author-intent", "task", "canon", "outline"]),
    );
    expect(compiled.receipt.compiledHash).toMatch(/^[a-f0-9]{64}$/);
    expect(
      database.raw
        .prepare("SELECT COUNT(*) AS count FROM context_receipts WHERE id = ?")
        .get(compiled.receipt.id),
    ).toEqual({ count: 1 });

    const snapshot = (
      await app.inject({
        method: "GET",
        url: `/api/projects/${project.id}/story-bible`,
      })
    ).json() as {
      facts: unknown[];
      relationships: unknown[];
      timeline: unknown[];
      foreshadows: unknown[];
    };
    expect(snapshot).toMatchObject({
      relationships: [{ relation: "守护", intensity: 0.95 }],
      timeline: [{ title: "灯塔在午夜熄灭" }],
      foreshadows: [{ title: "银钥匙上的盐", status: "developing" }],
    });
    expect(snapshot.facts).toHaveLength(2);
  });

  it("keeps document writes optimistic and rollback-safe", async () => {
    const { app } = await setup();
    const project = await createProject(app);
    const note = (
      await app.inject({
        method: "POST",
        url: `/api/projects/${project.id}/documents`,
        payload: {
          requestId: "optimistic-note",
          kind: "note",
          title: "乐观锁笔记",
          outlineNodeId: null,
        },
      })
    ).json() as { id: string };
    const documentId = note.id;

    const first = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/documents/${documentId}/versions`,
      payload: {
        content: "第一稿",
        source: "manual",
        expectedCurrentVersionId: null,
      },
    });
    expect(first.statusCode).toBe(201);
    const version = first.json() as { id: string };

    const stale = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/documents/${documentId}/versions`,
      payload: {
        content: "过期写入",
        source: "manual",
        expectedCurrentVersionId: null,
      },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      error: {
        code: "document.version.conflict",
        details: { actual: version.id },
      },
    });

    const restore = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/documents/${documentId}/restore`,
      payload: {
        targetVersionId: version.id,
        expectedCurrentVersionId: version.id,
      },
    });
    expect(restore.statusCode).toBe(201);
    expect(restore.json()).toMatchObject({
      content: "第一稿",
      parentVersionId: version.id,
    });
  });

  it("lets authors correct entities, outline nodes, and immutable facts with conflict protection", async () => {
    const { app } = await setup();
    const project = await createProject(app, "正典修订样本");
    const initial = (
      await app.inject({
        method: "GET",
        url: `/api/projects/${project.id}/story-bible`,
      })
    ).json() as { outline: { id: string }[] };
    const entityResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/entities`,
      payload: {
        type: "character",
        name: "旧名",
        aliases: [],
        description: "待修订",
        attributes: {},
      },
    });
    const entity = entityResponse.json() as {
      id: string;
      updatedAt: string;
    };
    const updatedEntityResponse = await app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/entities/${entity.id}`,
      payload: {
        name: "林昼",
        aliases: ["阿昼"],
        description: "能记住被遗忘者。",
        attributes: { age: 19 },
        status: "active",
        expectedUpdatedAt: entity.updatedAt,
      },
    });
    expect(updatedEntityResponse.statusCode).toBe(200);
    const updatedEntity = updatedEntityResponse.json() as {
      updatedAt: string;
    };
    expect(Date.parse(updatedEntity.updatedAt)).toBeGreaterThan(
      Date.parse(entity.updatedAt),
    );
    const staleEntity = await app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/entities/${entity.id}`,
      payload: {
        name: "会被拒绝",
        aliases: [],
        description: null,
        attributes: {},
        status: "active",
        expectedUpdatedAt: entity.updatedAt,
      },
    });
    expect(staleEntity.statusCode).toBe(409);
    expect(staleEntity.json()).toMatchObject({
      error: { code: "canon.entity.version.conflict" },
    });

    const chapterResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/outline`,
      payload: {
        parentId: initial.outline[0]!.id,
        kind: "chapter",
        ordinal: 0,
        title: "旧标题",
        summary: null,
        metadata: {},
      },
    });
    const chapter = chapterResponse.json() as {
      id: string;
      updatedAt: string;
    };
    const updatedChapter = await app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/outline/${chapter.id}`,
      payload: {
        title: "雾港失灯",
        goal: "发现遗忘规则",
        conflict: "父亲拒绝承认失踪者",
        status: "review",
        expectedUpdatedAt: chapter.updatedAt,
      },
    });
    expect(updatedChapter.statusCode).toBe(200);
    expect(updatedChapter.json()).toMatchObject({
      title: "雾港失灯",
      goal: "发现遗忘规则",
      status: "review",
    });

    const factResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/facts`,
      payload: {
        subjectId: entity.id,
        predicate: "害怕",
        value: "黑暗",
        authority: "locked",
        knowledgeScope: "omniscient",
      },
    });
    const fact = factResponse.json() as {
      fact: { id: string; createdAt: string };
    };
    const correction = {
      subjectId: entity.id,
      predicate: "害怕",
      objectEntityId: null,
      value: "深水",
      validFromNodeId: null,
      validToNodeId: null,
      knowledgeScope: "reader",
      knowledgeSubjectId: null,
      authority: "confirmed",
      confidence: 1,
    };
    const lockedRejection = await app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/facts/${fact.fact.id}`,
      payload: { ...correction, confirmLockedRevision: false },
    });
    expect(lockedRejection.statusCode).toBe(409);
    expect(lockedRejection.json()).toMatchObject({
      error: { code: "canon.fact.locked" },
    });
    const revisedResponse = await app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/facts/${fact.fact.id}`,
      payload: { ...correction, confirmLockedRevision: true },
    });
    expect(revisedResponse.statusCode).toBe(201);
    const revised = revisedResponse.json() as {
      fact: { id: string; createdAt: string; value: string };
    };
    expect(revised).toMatchObject({
      fact: {
        value: "深水",
        authority: "confirmed",
        knowledgeScope: "reader",
        supersedesFactId: fact.fact.id,
      },
    });

    const snapshot = (
      await app.inject({
        method: "GET",
        url: `/api/projects/${project.id}/story-bible`,
      })
    ).json() as {
      entities: { name: string; updatedAt: string }[];
      facts: { value: string }[];
    };
    expect(snapshot.entities[0]).toMatchObject({
      name: "林昼",
      updatedAt: updatedEntity.updatedAt,
    });
    expect(snapshot.facts).toEqual([
      expect.objectContaining({ value: "深水" }),
    ]);

    const withdrawnResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/facts/${revised.fact.id}/withdraw`,
      payload: {
        reason: "这一恐惧设定已废弃",
        confirmLockedWithdrawal: false,
      },
    });
    expect(withdrawnResponse.statusCode).toBe(201);
    expect(withdrawnResponse.json()).toMatchObject({
      factId: revised.fact.id,
      reason: "这一恐惧设定已废弃",
    });
    const afterWithdrawal = (
      await app.inject({
        method: "GET",
        url: `/api/projects/${project.id}/story-bible`,
      })
    ).json() as { facts: unknown[] };
    expect(afterWithdrawal.facts).toEqual([]);
  });
});
