import { randomUUID } from "node:crypto";
import type { StoryCompassDto, StoryLongLineDto } from "@narralume/contracts";
import {
  createOutlineNode,
  createDocument,
  ZERO_BUDGET_USAGE,
  type OutlineNode,
} from "@narralume/domain";
import {
  buildClosingReviewRecipe,
  buildRollingOutlineRecipe,
} from "@narralume/harness";
import {
  AutomationWorkerSuite,
  storyLineReviewEvidence,
  type NarrativeModelClient,
} from "@narralume/narrative";
import {
  SqliteAutomationRepository,
  SqliteCanonRepository,
  SqliteNarrativeStateRepository,
  SqliteStoryRepository,
  SqliteDocumentRepository,
  SqliteRunRepository,
  SqliteReviewRepository,
} from "@narralume/persistence";
import { NodeNarrativeDatabase } from "@narralume/persistence/node";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";

const resources: {
  app: Awaited<ReturnType<typeof buildApp>>;
  database: NodeNarrativeDatabase;
}[] = [];
afterEach(async () => {
  for (const { app, database } of resources.splice(0)) {
    await app.close();
    database.close();
  }
});

async function setup() {
  const database = new NodeNarrativeDatabase();
  const app = await buildApp({
    database,
    config: {
      dataDirectory: ".",
      databasePath: ":memory:",
      host: "127.0.0.1",
      port: 4317,
      environment: "test",
    },
    environment: {},
    enableRunWorker: false,
    logger: false,
  });
  resources.push({ app, database });
  const createProject = async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { requestId: randomUUID(), title: "长期故事线" },
    });
    expect(response.statusCode).toBe(201);
    return response.json().id as string;
  };
  const projectId = await createProject();
  const foreignId = await createProject();
  const story = new SqliteStoryRepository(database);
  const node = (
    parent: OutlineNode,
    kind: OutlineNode["kind"],
    title: string,
    ordinal = 0,
  ) =>
    story.insertOutlineNode(
      createOutlineNode({
        id: randomUUID(),
        projectId: parent.projectId,
        parent,
        kind,
        title,
        ordinal,
        now: "2026-09-20T10:00:00.000Z",
      }),
    );
  const root = story.listOutline(projectId)[0]!;
  const volume = node(root, "volume", "第一卷");
  const arc = node(volume, "arc", "寻找见证者");
  const chapter = node(arc, "chapter", "初见");
  story.updateOutlineStatus(
    projectId,
    chapter.id,
    "committed",
    "2026-09-20T11:00:00.000Z",
  );
  const future = node(arc, "chapter", "将来的会面", 1);
  const foreignVolume = node(
    story.listOutline(foreignId)[0]!,
    "volume",
    "其他作品的卷",
  );
  const foreignChapter = node(foreignVolume, "chapter", "其他作品的定稿");
  story.updateOutlineStatus(
    foreignId,
    foreignChapter.id,
    "committed",
    "2026-09-20T11:00:00.000Z",
  );
  const line: StoryLongLineDto = {
    title: "失踪者的名字",
    promise: "揭示港口如何失去记忆",
    status: "developing",
    development: {
      scopeNodeId: arc.id,
      stageGoal: "找到另一名见证者",
      progress: "已确认旧信件的笔迹",
      openPromises: ["尚未找到收信人", "尚未解释潮声"],
      nextDevelopment: "让调查触及港口之外",
      evidenceChapterIds: [chapter.id],
    },
  };
  const input = {
    corePromise: "记忆与代价",
    endingDirection: null,
    longLines: [line],
    themeQuestions: ["谁承担遗忘"],
    constraints: ["不立刻揭晓幕后原因"],
    target: { chapters: 100, wordsPerChapter: 3000, volumes: 4 },
  };
  const put = (body: unknown) =>
    app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/compass`,
      payload: body,
    });
  const get = async () =>
    (
      await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/compass`,
      })
    ).json() as StoryCompassDto;
  return {
    app,
    database,
    story,
    projectId,
    foreignId,
    arc,
    volume,
    chapter,
    future,
    foreignVolume,
    foreignChapter,
    line,
    input,
    put,
    get,
  };
}

async function proposalSetup() {
  const t = await setup();
  await t.put({
    ...t.input,
    longLines: [t.line, { ...t.line, title: "潮声" }],
    expectedVersion: null,
  });
  const now = "2026-09-22T00:00:00.000Z";
  const documents = new SqliteDocumentRepository(t.database);
  const document = documents.insert(
    createDocument({
      id: randomUUID(),
      projectId: t.projectId,
      kind: "chapter",
      title: t.chapter.title,
      outlineNodeId: t.chapter.id,
      now,
    }),
  );
  const version = documents.appendVersion(t.projectId, document.id, {
    id: randomUUID(),
    content: "见证者交出了旧信。潮声再次响起。",
    source: "test",
    now,
  });
  const state = new SqliteNarrativeStateRepository(
    t.database,
    new SqliteCanonRepository(t.database),
    t.story,
  );
  state.upsertSummary({
    id: randomUUID(),
    projectId: t.projectId,
    scopeType: "chapter",
    scopeId: t.chapter.id,
    summary: "见证者交出旧信，但潮声之谜仍未解开。",
    stateDelta: {},
    sourceHash: version.contentHash,
    createdAt: now,
  });
  const automation = new SqliteAutomationRepository(t.database);
  const session = automation.createSession({
    id: randomUUID(),
    projectId: t.projectId,
    mode: "autopilot",
    targetChapters: 2,
    windowSize: 2,
    maxRevisionCycles: 0,
    chapterPolicy: {},
    now,
  });
  const runId = randomUUID();
  const recipe = buildClosingReviewRecipe(runId, ["arc"]);
  const runs = new SqliteRunRepository(t.database);
  runs.create({
    id: runId,
    projectId: t.projectId,
    mode: "autopilot",
    recipe: recipe.name,
    recipeVersion: recipe.version,
    targetOutlineNodeId: t.arc.id,
    policy: { sessionId: session.id, arcId: t.arc.id },
    steps: recipe.steps,
    now,
  });
  runs.leaseNext("test", now, 30_000);
  const step = runs.startStep(runId, recipe.steps[0]!.id, now);
  const proposals = [0, 1].map((lineIndex) => ({
    lineIndex,
    rationale: "正文摘要记载旧信已交出",
    status: "developing",
    progress: "已取得旧信",
    openPromises: ["潮声之谜"],
    nextDevelopment: "寻找收信人",
    evidenceChapterIds: [t.chapter.id],
  }));
  let prompt = "";
  const review = async (
    items: unknown = proposals,
    during?: () => void,
    extra: Record<string, unknown> = {},
  ) => {
    const model: NarrativeModelClient = {
      async text() {
        throw new Error("Unexpected text generation");
      },
      async structured(_run, _step, _purpose, request, _contract, validate) {
        prompt = JSON.stringify(request);
        const checked = validate({
          observations: [],
          lineEvidence: (items as typeof proposals).map((item) => ({
            lineIndex: item.lineIndex,
            citations: [...new Set(item.evidenceChapterIds)].map(
              (chapterId) => ({
                chapterId,
                paragraphOrdinal: 1,
                quote: "见证者交出了旧信。",
              }),
            ),
          })),
          scores: {
            promise: 80,
            causality: 80,
            characterArc: 80,
            pacing: 80,
            continuity: 80,
          },
          recommendations: [],
          compassAdjustments: [],
          lineProposals: items,
          ...extra,
        });
        if (!checked.success) throw new Error(checked.issues.join("; "));
        during?.();
        return {
          value: checked.data,
          usage: ZERO_BUDGET_USAGE,
          mode: "native",
          attempts: 1,
        };
      },
    };
    const worker = new AutomationWorkerSuite(t.database, model).registry()[
      "arc.review"
    ]!;
    return worker.execute(
      runs.getSnapshot(runId),
      step,
      new AbortController().signal,
    );
  };
  const url = `/api/projects/${t.projectId}/compass/proposals`;
  const decide = (
    itemId: string,
    action: "apply" | "reject",
    projectId = t.projectId,
  ) =>
    t.app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/compass/proposals/${encodeURIComponent(step.id + ":story-lines")}/items/${itemId}/decision`,
      payload: { action },
    });
  return {
    ...t,
    documents,
    document,
    state,
    automation,
    proposals,
    review,
    decide,
    url,
    runs,
    session,
    prompt: () => prompt,
    setId: step.id + ":story-lines",
  };
}

async function crossArcProposalSetup() {
  const t = await proposalSetup();
  const now = "2026-09-23T00:00:00.000Z";
  t.story.updateOutlineOrdinal(t.projectId, t.arc.id, 1, now);
  const chapterInArc = (ordinal: number, title: string, content: string) => {
    const arc = t.story.insertOutlineNode(
      createOutlineNode({
        id: randomUUID(),
        projectId: t.projectId,
        parent: t.volume,
        kind: "arc",
        ordinal,
        title,
        now,
      }),
    );
    const chapter = t.story.insertOutlineNode(
      createOutlineNode({
        id: randomUUID(),
        projectId: t.projectId,
        parent: arc,
        kind: "chapter",
        ordinal: 0,
        title,
        now,
      }),
    );
    t.story.updateOutlineStatus(t.projectId, chapter.id, "committed", now);
    const document = t.documents.insert(
      createDocument({
        id: randomUUID(),
        projectId: t.projectId,
        kind: "chapter",
        outlineNodeId: chapter.id,
        title,
        now,
      }),
    );
    const version = t.documents.appendVersion(t.projectId, document.id, {
      id: randomUUID(),
      content,
      source: "test",
      now,
    });
    return { arc, chapter, document, version };
  };
  const historical = chapterInArc(0, "前弧的交接", "阿苇已经交给泽伯。");
  const later = chapterInArc(2, "后弧的安排", "泽伯后来把阿苇送到了教团。");
  t.automation.upsertCompass({
    ...(await t.get()),
    longLines: [
      {
        ...t.line,
        title: "阿苇的去向",
        development: {
          ...t.line.development!,
          openPromises: ["阿苇去向未知"],
        },
      },
    ],
  });
  return { ...t, historical, later };
}

describe("evidence-backed story line proposals", () => {
  it("checks and binds previous-arc evidence without using later-arc facts to review an earlier stage", async () => {
    const t = await crossArcProposalSetup();
    await expect(
      t.review([
        { ...t.proposals[0]!, evidenceChapterIds: [t.later.chapter.id] },
      ]),
    ).rejects.toThrow("Evidence");
    const citation = {
      chapterId: t.historical.chapter.id,
      paragraphOrdinal: 1,
      quote: "阿苇已经交给泽伯。",
    };
    const result = await t.review(
      [
        {
          ...t.proposals[0]!,
          progress: "阿苇已交给泽伯，本阶段承接这一交接。",
          openPromises: ["核实泽伯的后续安排"],
          evidenceChapterIds: [t.historical.chapter.id],
        },
      ],
      undefined,
      {
        observations: [
          {
            text: "此前阿苇已交给泽伯。",
            basis: "observed",
            citations: [citation],
          },
        ],
        lineEvidence: [{ lineIndex: 0, citations: [citation] }],
      },
    );
    const baseline = storyLineReviewEvidence(t.database, t.projectId, t.arc.id);
    expect(
      baseline.chapters.map(({ chapterId, inScope }) => ({
        chapterId,
        inScope,
      })),
    ).toEqual([
      { chapterId: t.historical.chapter.id, inScope: false },
      { chapterId: t.chapter.id, inScope: true },
    ]);
    const request = JSON.parse(t.prompt());
    const prompt = request.messages[0].content as string;
    expect(prompt).toContain("阿苇已经交给泽伯。");
    expect(prompt).toContain('"inScope":false');
    expect(prompt).toContain('"inScope":true');
    expect(prompt).toContain(`"scopeChapterIds":["${t.chapter.id}"]`);
    expect(request.instructions).toContain("历史事件记成目标阶段的新进展");
    expect(request.instructions).toContain(
      "recommendations 和 lineProposals 也必须保留",
    );
    expect(prompt).not.toContain(t.later.chapter.id);
    expect(prompt).not.toContain(t.later.version.content);
    const observations = result.output.observations as {
      citations: {
        start: number;
        end: number;
        documentVersionId: string;
        contentHash: string;
        quote: string;
      }[];
    }[];
    const bound = observations[0]!.citations[0]!;
    expect(bound).toMatchObject({
      ...citation,
      documentVersionId: t.historical.version.id,
      contentHash: t.historical.version.contentHash,
    });
    expect(t.historical.version.content.slice(bound.start, bound.end)).toBe(
      bound.quote,
    );
    const proposals = (
      await t.app.inject({ method: "GET", url: t.url })
    ).json();
    expect(proposals[0].stale).toBe(false);
    expect(proposals[0].evidence).toContainEqual(
      expect.objectContaining({ chapterId: t.historical.chapter.id }),
    );
    expect((await t.decide("0", "apply")).statusCode).toBe(200);
  });
  it("invalidates an existing proposal when an earlier arc's manuscript changes", async () => {
    const t = await crossArcProposalSetup();
    await t.review([t.proposals[0]]);
    t.documents.appendVersion(t.projectId, t.historical.document.id, {
      id: randomUUID(),
      content: "阿苇仍留在渡口，尚未交给泽伯。",
      source: "test",
      now: new Date().toISOString(),
    });
    const response = await t.decide("0", "apply");
    expect(response.statusCode, response.body).toBe(409);
    expect(response.json().error.code).toBe("story_line_proposal.stale");
    expect((await t.decide("0", "reject")).statusCode).toBe(200);
  });
  it.each(["with proposals", "without proposals"])(
    "rejects a review %s if its cross-arc historical manuscript changes during generation",
    async (mode) => {
      const t = await crossArcProposalSetup();
      await expect(
        t.review(mode === "with proposals" ? [t.proposals[0]] : [], () =>
          t.documents.appendVersion(t.projectId, t.historical.document.id, {
            id: randomUUID(),
            content: "作者改变了此前阿苇的交接。",
            source: "test",
            now: new Date().toISOString(),
          }),
        ),
      ).rejects.toMatchObject({ code: "story_line_proposal.stale" });
      expect(t.automation.listPlanningReviews(t.session.id)).toEqual([]);
    },
  );
  it("keeps empty and invalid review scopes empty despite earlier committed history", async () => {
    const t = await crossArcProposalSetup();
    const empty = t.story.insertOutlineNode(
      createOutlineNode({
        id: randomUUID(),
        projectId: t.projectId,
        parent: t.volume,
        kind: "arc",
        ordinal: 3,
        title: "尚未开始的阶段",
        now: new Date().toISOString(),
      }),
    );
    for (const scopeId of [empty.id, t.chapter.id, "missing-scope", ""]) {
      const baseline = storyLineReviewEvidence(
        t.database,
        t.projectId,
        scopeId,
      );
      expect(baseline.chapters).toEqual([]);
      expect(baseline.evidence).toEqual([]);
    }
  });
  it("rejects a planner that omits, duplicates, fabricates or misreads actual author decisions", async () => {
    const t = await proposalSetup();
    await t.review();
    await t.decide("0", "apply");
    await t.decide("1", "reject");
    const expected = [
      { setId: t.setId, itemId: "0", action: "apply" },
      { setId: t.setId, itemId: "1", action: "reject" },
    ];
    for (const acknowledgements of [
      [],
      expected.map((item) => ({ ...item, action: "reject" })),
      [expected[0], expected[0]],
      [...expected, { setId: t.setId, itemId: "made-up", action: "apply" }],
    ]) {
      await expect(generateMemoryPlan(t, acknowledgements)).rejects.toThrow(
        "decisionAcknowledgements",
      );
    }
    const result = await generateMemoryPlan(t, [...expected].reverse());
    expect(result.output.authorDecisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "apply",
          result: expect.objectContaining({
            compassVersion: expect.any(Number),
          }),
        }),
        expect.objectContaining({
          action: "reject",
          result: { rejected: true },
        }),
      ]),
    );
  });
  it.each(["manuscript", "decision"])(
    "invalidates a generated plan before staging when its %s changes",
    async (change) => {
      const t = await proposalSetup();
      await t.review();
      const result = await generateMemoryPlan(t, [
        { setId: t.setId, itemId: "0", action: "pending" },
        { setId: t.setId, itemId: "1", action: "pending" },
      ]);
      t.runs.succeedStep(
        result.runId,
        result.stepId,
        result.output,
        "rolling-outline-proposal",
        new Date().toISOString(),
      );
      if (change === "manuscript")
        t.documents.appendVersion(t.projectId, t.document.id, {
          id: randomUUID(),
          content: "作者已改写旧信的交接。",
          source: "manual",
          now: new Date().toISOString(),
        });
      else await t.decide("0", "reject");
      const snapshot = t.runs.getSnapshot(result.runId);
      const stage = snapshot.steps.find(
        (step) => step.kind === "outline.entities",
      )!;
      const worker = new AutomationWorkerSuite(
        t.database,
        {} as NarrativeModelClient,
      ).registry()["outline.entities"]!;
      await expect(
        worker.execute(snapshot, stage, new AbortController().signal),
      ).rejects.toMatchObject({ code: "planning.memory.stale" });
    },
  );
  it("reads the manuscript when a current summary falsely calls a completed event pending and binds the corrected observation", async () => {
    const t = await proposalSetup();
    t.state.upsertSummary({
      ...t.state.latestSummary(t.projectId, "chapter", t.chapter.id)!,
      summary: "旧信尚未交出。",
    });
    const result = await t.review(t.proposals, undefined, {
      observations: [
        {
          text: "见证者交出了旧信。",
          basis: "observed",
          citations: [
            {
              chapterId: t.chapter.id,
              paragraphOrdinal: 1,
              quote: "见证者交出了旧信。",
            },
          ],
        },
      ],
    });
    expect(t.prompt()).toContain("已提交正文才是事件依据");
    expect(t.prompt()).toContain("见证者交出了旧信。");
    expect(result.output.summary).toBe("见证者交出了旧信。");
    const citations = (
      result.output.observations as {
        citations: {
          start: number;
          end: number;
          quote: string;
          documentVersionId: string;
        }[];
      }[]
    )[0]!.citations;
    const current = t.documents.getVersion(
      t.projectId,
      t.document.id,
      t.documents.get(t.projectId, t.document.id)!.currentVersionId!,
    )!;
    expect(citations[0]!.documentVersionId).toBe(current.id);
    expect(current.content.slice(citations[0]!.start, citations[0]!.end)).toBe(
      citations[0]!.quote,
    );
  });
  it("rejects invented observation quotes and missing line evidence", async () => {
    const t = await proposalSetup();
    await expect(
      t.review([], undefined, {
        observations: [
          {
            text: "事故尚未揭示",
            basis: "observed",
            citations: [
              {
                chapterId: t.chapter.id,
                paragraphOrdinal: 1,
                quote: "事故尚未揭示",
              },
            ],
          },
        ],
      }),
    ).rejects.toThrow("Evidence");
    await expect(
      t.review(t.proposals, undefined, { lineEvidence: [] }),
    ).rejects.toThrow("lineIndex");
    expect((await t.app.inject({ method: "GET", url: t.url })).json()).toEqual(
      [],
    );
  });
  it("rejects changed manuscripts even when no story line update is proposed", async () => {
    const t = await proposalSetup();
    await expect(
      t.review([], () =>
        t.documents.appendVersion(t.projectId, t.document.id, {
          id: randomUUID(),
          content: "作者写了不同的事件。",
          source: "manual",
          now: new Date().toISOString(),
        }),
      ),
    ).rejects.toMatchObject({ code: "story_line_proposal.stale" });
    expect(t.automation.listPlanningReviews(t.session.id)).toEqual([]);
  });
  it("keeps evidence valid when unrelated future plans are appended and blocks bulk decisions", async () => {
    const t = await proposalSetup();
    await t.review();
    t.story.insertOutlineNode(
      createOutlineNode({
        id: randomUUID(),
        projectId: t.projectId,
        parent: t.arc,
        kind: "chapter",
        ordinal: 2,
        title: "尚未写作的新章",
        now: new Date().toISOString(),
      }),
    );
    const bulk = await t.app.inject({
      method: "POST",
      url: `/api/projects/${t.projectId}/canon-change-sets/${encodeURIComponent(t.setId)}/decisions`,
      payload: { requestId: randomUUID(), action: "apply" },
    });
    expect(bulk.statusCode, bulk.body).toBe(409);
    expect(bulk.json().error.code).toBe(
      "story_line_proposal.individual_required",
    );
    expect((await t.decide("0", "apply")).statusCode).toBe(200);
  });
  it("feeds actual accepted results and rejections into the next planning window", async () => {
    const t = await proposalSetup();
    await t.review();
    await t.decide("0", "apply");
    await t.decide("1", "reject");
    const stageReview = t.state.latestSummary(t.projectId, "arc", t.arc.id)!;
    t.state.upsertSummary({
      ...stageReview,
      summary: "错误的双向信号断言",
      stateDelta: {
        recommendations: ["考虑一次信号压力测试"],
        observations: [{ text: "错误的双向信号断言" }],
        compassAdjustments: ["错误的双向信号断言"],
      },
    });
    const id = randomUUID();
    const recipe = buildRollingOutlineRecipe(id);
    t.runs.create({
      id,
      projectId: t.projectId,
      recipe: recipe.name,
      recipeVersion: recipe.version,
      mode: "autopilot",
      targetOutlineNodeId: t.story.listOutline(t.projectId)[0]!.id,
      policy: { sessionId: t.session.id },
      steps: recipe.steps,
      now: new Date().toISOString(),
    });
    let captured = "";
    const model: NarrativeModelClient = {
      async text() {
        throw new Error("unexpected");
      },
      async structured(_run, _step, _purpose, request) {
        captured = JSON.stringify(request);
        throw new Error("captured planning input");
      },
    };
    const snapshot = t.runs.getSnapshot(id);
    const worker = new AutomationWorkerSuite(t.database, model).registry()[
      "outline.generate"
    ]!;
    await expect(
      worker.execute(
        snapshot,
        snapshot.steps[0]!,
        new AbortController().signal,
      ),
    ).rejects.toThrow("captured planning input");
    expect(captured).toContain("compassVersion");
    expect(captured).toContain("已取得旧信");
    expect(captured).toContain('\\"action\\":\\"reject\\"');
    expect(captured).toContain("不得当成作者方向");
    expect(captured).toContain("考虑一次信号压力测试");
    expect(captured).not.toContain("错误的双向信号断言");
  });
  it("stages without applying, applies siblings atomically, replays decisions and rejects opposite decisions", async () => {
    const t = await proposalSetup();
    const before = await t.get();
    await t.review();
    expect(await t.get()).toEqual(before);
    expect(t.prompt()).toContain(t.chapter.id);
    expect(t.prompt()).not.toContain(t.future.title);
    const list = (await t.app.inject({ method: "GET", url: t.url })).json();
    expect(list[0].items).toHaveLength(2);
    expect(list[0].stale).toBe(false);
    expect((await t.decide("0", "apply")).statusCode).toBe(200);
    expect((await t.decide("0", "apply")).statusCode).toBe(200);
    expect((await t.get()).version).toBe(before.version + 1);
    expect((await t.decide("0", "reject")).statusCode).toBe(409);
    expect((await t.decide("1", "apply")).statusCode).toBe(200);
    expect((await t.get()).version).toBe(before.version + 2);
    expect(
      (await t.get()).longLines.every(
        (line) => line.development?.progress === "已取得旧信",
      ),
    ).toBe(true);
    expect(
      new SqliteReviewRepository(t.database).listCanonItemDecisions(t.setId)[0]!
        .result,
    ).toMatchObject({ compassVersion: before.version + 1 });
    expect((await t.decide("0", "apply", t.foreignId)).statusCode).toBe(404);
  });
  it.each(["compass", "manuscript", "summary", "outline"])(
    "rejects stale %s evidence but allows refusal",
    async (change) => {
      const t = await proposalSetup();
      await t.review();
      if (change === "compass")
        t.automation.upsertCompass({
          ...(await t.get()),
          longLines: [...(await t.get()).longLines].reverse(),
        });
      if (change === "manuscript")
        t.documents.appendVersion(t.projectId, t.document.id, {
          id: randomUUID(),
          content: "旧信被烧毁",
          source: "test",
          now: new Date().toISOString(),
        });
      if (change === "summary") {
        const old = t.state.latestSummary(
          t.projectId,
          "chapter",
          t.chapter.id,
        )!;
        t.state.upsertSummary({ ...old, summary: "重新整理的摘要" });
      }
      if (change === "outline")
        t.story.updateOutlineStatus(
          t.projectId,
          t.arc.id,
          "abandoned",
          new Date().toISOString(),
        );
      const response = await t.decide("0", "apply");
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().error.code).toBe("story_line_proposal.stale");
      expect((await t.decide("0", "reject")).statusCode).toBe(200);
    },
  );
  it("rejects fabricated, future, duplicate, and cross-project evidence and unknown lines", async () => {
    const t = await proposalSetup();
    for (const evidenceChapterIds of [
      [t.future.id],
      [t.foreignChapter.id],
      [t.chapter.id, t.chapter.id],
      ["made-up"],
    ]) {
      await expect(
        t.review([{ ...t.proposals[0], evidenceChapterIds }]),
      ).rejects.toThrow("Evidence");
    }
    await expect(
      t.review([{ ...t.proposals[0], lineIndex: 3 }]),
    ).rejects.toThrow("lineIndex");
    await expect(t.review([t.proposals[0], t.proposals[0]])).rejects.toThrow(
      "lineIndex",
    );
  });
  it("does not use outline summaries when manuscript summaries are absent or outdated", async () => {
    const t = await proposalSetup();
    t.documents.appendVersion(t.projectId, t.document.id, {
      id: randomUUID(),
      content: "新的正文",
      source: "test",
      now: new Date().toISOString(),
    });
    await expect(t.review()).rejects.toThrow("Evidence");
    await t.review([]);
    expect((await t.app.inject({ method: "GET", url: t.url })).json()).toEqual(
      [],
    );
  });
  it("rechecks the baseline after model completion", async () => {
    const t = await proposalSetup();
    await expect(
      t.review(t.proposals, () =>
        t.automation.upsertCompass({
          ...t.automation.requireCompass(t.projectId),
          corePromise: "变更",
        }),
      ),
    ).rejects.toMatchObject({ code: "story_line_proposal.stale" });
    expect((await t.app.inject({ method: "GET", url: t.url })).json()).toEqual(
      [],
    );
  });
  it("rolls back the compass if persisting its decision fails", async () => {
    const t = await proposalSetup();
    await t.review();
    const before = await t.get();
    t.database.raw.exec(
      "CREATE TRIGGER fail_proposal BEFORE INSERT ON canon_change_set_item_decisions BEGIN SELECT RAISE(ABORT, 'test fault'); END",
    );
    expect((await t.decide("0", "apply")).statusCode).toBe(500);
    expect(await t.get()).toEqual(before);
  });
});

async function generateMemoryPlan(
  t: Awaited<ReturnType<typeof proposalSetup>>,
  decisionAcknowledgements: unknown[],
) {
  const id = randomUUID();
  const recipe = buildRollingOutlineRecipe(id);
  const now = new Date().toISOString();
  t.runs.create({
    id,
    projectId: t.projectId,
    recipe: recipe.name,
    recipeVersion: recipe.version,
    mode: "autopilot",
    targetOutlineNodeId: t.story.listOutline(t.projectId)[0]!.id,
    policy: { sessionId: t.session.id },
    steps: recipe.steps,
    now,
  });
  t.runs.leaseRun(id, "memory-plan-test", now, 30_000);
  const step = t.runs.startStep(id, recipe.steps[0]!.id, now);
  const model: NarrativeModelClient = {
    async text() {
      throw Error("unexpected");
    },
    async structured(_run, _step, _purpose, _request, _contract, validate) {
      const checked = validate({
        entityProposals: [],
        decisionAcknowledgements,
        rationale: "核对旧信的来源与潮声。",
        volumeId: t.volume.id,
        arcId: t.arc.id,
        volume: { title: "第一卷", summary: "旧信调查", goal: "找到来源" },
        arc: {
          title: "寻找见证者",
          summary: "核对旧信",
          goal: "查明来源",
          conflict: "见证分歧",
          outcome: "取得交叉证据",
        },
        chapters: [0, 1].map((index) => ({
          title: `下一章${index}`,
          summary: "查证旧信来源",
          goal: "核验",
          conflict: "证词差异",
          outcome: "取得新线索",
          pov: null,
          entityRefs: [],
          storyTime: null,
          hook: "未解潮声",
        })),
        nextArc: null,
        continuityRisks: [],
      });
      if (!checked.success) throw Error(checked.issues.join(";"));
      return {
        value: checked.data,
        usage: ZERO_BUDGET_USAGE,
        mode: "native",
        attempts: 1,
      };
    },
  };
  const worker = new AutomationWorkerSuite(t.database, model).registry()[
    "outline.generate"
  ]!;
  const output = await worker.execute(
    t.runs.getSnapshot(id),
    step,
    new AbortController().signal,
  );
  return { ...output, runId: id, stepId: step.id };
}

describe("author-maintained long story lines", () => {
  it("persists stage records, rejects stale saves, and allows simple directions without a progress record", async () => {
    const { input, line, put, get } = await setup();
    const first = await put({ ...input, expectedVersion: null });
    expect(first.statusCode, first.body).toBe(200);
    expect(await get()).toMatchObject({ ...input, version: 1 });
    const edited = {
      ...line,
      development: {
        ...line.development!,
        nextDevelopment: "先展开新地点，不收束全书",
      },
    };
    const saved = await put({
      ...input,
      longLines: [edited],
      expectedVersion: 1,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const stale = await put({ ...input, longLines: [], expectedVersion: 1 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      error: { code: "compass.version.conflict" },
    });
    expect((await get()).longLines).toEqual([edited]);
    const simple = {
      title: "封闭群像",
      promise: "发展已有角色之间的信任",
      status: "open",
    };
    expect(
      (await put({ ...input, longLines: [edited, simple], expectedVersion: 2 }))
        .statusCode,
    ).toBe(200);
    expect((await get()).longLines[1]).toEqual(simple);
    expect(
      (await put({ ...input, longLines: [simple], expectedVersion: 3 }))
        .statusCode,
    ).toBe(200);
    expect(await get()).toMatchObject({
      corePromise: input.corePromise,
      constraints: input.constraints,
      longLines: [simple],
      version: 4,
    });
  });

  it("rejects foreign, missing, future, and abandoned references without changing the compass", async () => {
    const {
      input,
      line,
      put,
      get,
      chapter,
      future,
      foreignVolume,
      foreignChapter,
      story,
      projectId,
      arc,
    } = await setup();
    expect((await put({ ...input, expectedVersion: null })).statusCode).toBe(
      200,
    );
    const baseline = await get();
    for (const scopeNodeId of [foreignVolume.id, chapter.id, "missing-stage"]) {
      const result = await put({
        ...input,
        longLines: [
          { ...line, development: { ...line.development!, scopeNodeId } },
        ],
        expectedVersion: 1,
      });
      expect(result.statusCode).toBe(409);
      expect(result.json()).toMatchObject({
        error: { code: "compass.scope.invalid" },
      });
    }
    for (const evidenceChapterIds of [
      [foreignChapter.id],
      [future.id],
      [arc.id],
      ["missing-chapter"],
    ]) {
      const result = await put({
        ...input,
        longLines: [
          {
            ...line,
            development: { ...line.development!, evidenceChapterIds },
          },
        ],
        expectedVersion: 1,
      });
      expect(result.statusCode).toBe(409);
      expect(result.json()).toMatchObject({
        error: { code: "compass.evidence.invalid" },
      });
    }
    const duplicate = await put({
      ...input,
      longLines: [
        {
          ...line,
          development: {
            ...line.development!,
            evidenceChapterIds: [chapter.id, chapter.id],
          },
        },
      ],
      expectedVersion: 1,
    });
    expect(duplicate.statusCode).toBe(400);
    story.updateOutlineStatus(
      projectId,
      arc.id,
      "abandoned",
      "2026-09-20T12:00:00.000Z",
    );
    expect((await put({ ...input, expectedVersion: 1 })).json()).toMatchObject({
      error: { code: "compass.scope.invalid" },
    });
    expect(
      (
        await put({
          ...input,
          longLines: [
            {
              ...line,
              development: { ...line.development!, scopeNodeId: null },
            },
          ],
          expectedVersion: 1,
        })
      ).json(),
    ).toMatchObject({ error: { code: "compass.evidence.invalid" } });
    expect(await get()).toEqual(baseline);
  });

  it("shows only the latest review of each stage in this project without adopting suggestions", async () => {
    const {
      app,
      database,
      story,
      projectId,
      foreignId,
      foreignVolume,
      arc,
      volume,
      input,
      put,
      get,
    } = await setup();
    await put({ ...input, expectedVersion: null });
    const baseline = await get();
    const state = new SqliteNarrativeStateRepository(
      database,
      new SqliteCanonRepository(database),
      story,
    );
    const review = (id: string, node: OutlineNode, time: string) =>
      state.upsertSummary({
        id,
        projectId: node.projectId,
        scopeType: node.kind === "arc" ? "arc" : "volume",
        scopeId: node.id,
        summary: id,
        stateDelta: {
          recommendations: ["建议引入新的调查阻力"],
          compassAdjustments: ["建议调整阶段目标"],
        },
        sourceHash: id,
        createdAt: time,
      });
    review("old-arc", arc, "2026-09-20T10:00:00.000Z");
    review("latest-arc", arc, "2026-09-20T11:00:00.000Z");
    review("latest-volume", volume, "2026-09-20T12:00:00.000Z");
    review("foreign-review", foreignVolume, "2026-09-20T13:00:00.000Z");
    const response = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/compass/reviews`,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject([
      {
        id: "latest-volume",
        recommendations: ["建议引入新的调查阻力"],
        compassAdjustments: ["建议调整阶段目标"],
      },
      { id: "latest-arc", outlineNodeId: arc.id },
    ]);
    expect(response.json()).toHaveLength(2);
    expect(await get()).toEqual(baseline);
    expect(
      new SqliteAutomationRepository(database).getCompass(foreignId),
    ).toBeNull();
  });

  it.each([false, true])(
    "restores stage records with new node IDs, including abandoned references (%s)",
    async (abandoned) => {
      const { app, input, put, projectId, line, story, chapter, arc } =
        await setup();
      expect((await put({ ...input, expectedVersion: null })).statusCode).toBe(
        200,
      );
      if (abandoned) {
        const remove = async (id: string) =>
          app.inject({
            method: "DELETE",
            url: `/api/projects/${projectId}/outline/${id}`,
            payload: {
              expectedUpdatedAt: story.requireOutlineNode(projectId, id)
                .updatedAt,
            },
          });
        const removedChapter = await remove(chapter.id);
        expect(removedChapter.statusCode, removedChapter.body).toBe(200);
        expect(removedChapter.json()).toMatchObject({
          disposition: "abandoned",
          references: 1,
        });
        const removedScope = await remove(arc.id);
        expect(removedScope.statusCode, removedScope.body).toBe(200);
        expect(removedScope.json()).toMatchObject({
          disposition: "abandoned",
          references: 3,
        });
      }
      const backup = await app.inject({
        method: "POST",
        url: `/api/projects/${projectId}/backups`,
        payload: { label: "阶段记录" },
      });
      expect(backup.statusCode, backup.body).toBe(201);
      const restored = await app.inject({
        method: "POST",
        url: `/api/backups/${backup.json().id}/restore`,
        payload: { requestId: randomUUID(), title: "恢复故事线" },
      });
      expect(restored.statusCode, restored.body).toBe(201);
      const restoredId = restored.json().projectId as string;
      const compass = (
        await app.inject({
          method: "GET",
          url: `/api/projects/${restoredId}/compass`,
        })
      ).json() as StoryCompassDto;
      const nodes = story.listOutline(restoredId);
      const stageId = nodes.find((node) => node.title === "寻找见证者")!.id;
      const evidenceId = nodes.find((node) => node.title === "初见")!.id;
      expect(compass.longLines).toEqual([
        {
          ...line,
          development: {
            ...line.development!,
            scopeNodeId: stageId,
            evidenceChapterIds: [evidenceId],
          },
        },
      ]);
      expect(stageId).not.toBe(line.development!.scopeNodeId);
      expect(evidenceId).not.toBe(line.development!.evidenceChapterIds[0]);
      expect(nodes.find((node) => node.id === evidenceId)!.status).toBe(
        abandoned ? "abandoned" : "committed",
      );
    },
  );
});
