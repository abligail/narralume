import { afterEach, describe, expect, it } from "vitest";
import { createCanonEntity } from "@narralume/domain";
import type {
  AutopilotSessionDetailDto,
  CanonCandidateSetDto,
} from "@narralume/contracts";
import type { NarrativeModelClient } from "@narralume/narrative";
import {
  SqliteAutomationRepository,
  SqliteCanonRepository,
  SqliteRunRepository,
  SqliteStoryRepository,
} from "@narralume/persistence";
import { NodeNarrativeDatabase } from "@narralume/persistence/node";
import {
  RollingOutlineProposalSchema,
  type RollingOutlineProposal,
} from "../../../packages/narrative/src/automation-schemas.js";
import {
  planningEntityIssues,
  stagePlanningEntities,
} from "../../../packages/narrative/src/planning-entities.js";
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

function openWorldPlan(): RollingOutlineProposal {
  return {
    rationale: "调查需要进入港外航线，旧人物没有当地记录。",
    volumeId: null,
    arcId: null,
    volume: { title: "港外", summary: "调查扩展到外港。", goal: "寻找寄信人" },
    arc: {
      title: "新航线",
      summary: "第一次到访。",
      goal: "查验航线",
      conflict: "记录缺失",
      outcome: "找到另一份航图",
    },
    decisionAcknowledgements: [],
    entityProposals: [
      {
        key: "pilot",
        type: "character",
        name: "沈渡",
        aliases: ["摆渡人"],
        description: "AUTHORED_PROFILE_SECRET：保存被删航线的领航员。",
        narrativeRole: "提供外港记录并质疑调查者的动机",
        rationale: "引入当地视角，不能由未到过外港的旧人物代替",
      },
      {
        key: "harbor",
        type: "location",
        name: "潮门港",
        aliases: [],
        description: "季节性开放的内海港口。",
        narrativeRole: "使旅行时限成为阻力",
        rationale: "新航线需要有独立通行规则的空间",
      },
    ],
    chapters: [
      {
        title: "潮门",
        summary: "到访外港",
        goal: "取得航图",
        conflict: "潮门将关",
        outcome: "找到残页",
        pov: { kind: "proposed", id: "pilot" },
        entityRefs: [
          { kind: "proposed", id: "pilot" },
          { kind: "proposed", id: "harbor" },
        ],
        storyTime: null,
        hook: "航图仍缺一角",
      },
    ],
    nextArc: null,
    continuityRisks: [],
  };
}

async function setup() {
  let plan = openWorldPlan();
  const requests: string[] = [];
  const model: NarrativeModelClient = {
    async text() {
      throw new Error(
        "This fixture only exercises planning and context compilation",
      );
    },
    async structured(_run, _step, purpose, request, _contract, validate) {
      expect(purpose).toBe("rolling-outline");
      requests.push(JSON.stringify(request));
      const checked = validate(plan);
      if (!checked.success)
        throw {
          code: "fixture.invalid_plan",
          message: checked.issues.join("; "),
          retryable: false,
        };
      return {
        value: checked.data,
        mode: "native",
        attempts: 1,
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          calls: 1,
          costUsd: 0,
          wallTimeMs: 1,
        },
      };
    },
  };
  const database = new NodeNarrativeDatabase(":memory:");
  const app = await buildApp({
    config: {
      dataDirectory: ".",
      databasePath: ":memory:",
      host: "127.0.0.1",
      port: 4317,
      environment: "test",
    },
    database,
    narrativeModelClient: model,
    enableRunWorker: false,
    logger: false,
    environment: {
      NARRATIVE_LLM_API_KEY: "test",
      NARRATIVE_LLM_BASE_URL: "https://example.com/v1",
      NARRATIVE_LLM_MODEL: "test",
      NARRATIVE_LLM_CONTEXT_WINDOW: "128000",
      NARRATIVE_LLM_MAX_OUTPUT_TOKENS: "32000",
    },
  });
  resources.push({ app, database });
  const project = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: { requestId: crypto.randomUUID(), title: "港外长篇" },
  });
  expect(project.statusCode, project.body).toBe(201);
  const projectId = project.json().id as string;
  const session = await app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/autopilot/sessions`,
    payload: {
      requestId: crypto.randomUUID(),
      targetChapters: 1,
      windowSize: 1,
    },
  });
  expect(session.statusCode, session.body).toBe(202);
  const sessionId = session.json().id as string;
  const detail = async () =>
    (
      await app.inject({
        method: "GET",
        url: `/api/autopilot/sessions/${sessionId}`,
      })
    ).json() as AutopilotSessionDetailDto;
  const advanceSession = async () => {
    const r = await app.inject({
      method: "POST",
      url: `/api/autopilot/sessions/${sessionId}/advance`,
    });
    expect(r.statusCode, r.body).toBe(200);
  };
  await advanceSession();
  const runId = (await detail()).session.currentRunId!;
  const runs = new SqliteRunRepository(database);
  const story = new SqliteStoryRepository(database);
  const canon = new SqliteCanonRepository(database);
  const finish = async (id = runId) => {
    for (let i = 0; i < 8; i++) {
      const r = await app.inject({
        method: "POST",
        url: `/api/runs/${id}/advance`,
        payload: { projectId },
      });
      expect(r.statusCode, r.body).toBe(200);
      if (
        ["completed", "failed", "awaiting_user", "cancelled"].includes(
          runs.getSnapshot(id).run.status,
        )
      )
        break;
    }
    return runs.getSnapshot(id).run.status;
  };
  const candidates = async () =>
    (
      await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/canon-spreads/entities/candidates`,
      })
    ).json() as CanonCandidateSetDto[];
  const decide = (item: string, action: "apply" | "reject") =>
    app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/canon-candidates/${runId}:planning-entities/items/${item}/decisions`,
      payload: { action },
    });
  const accept = () =>
    app.inject({
      method: "POST",
      url: `/api/autopilot/sessions/${sessionId}/actions`,
      payload: { action: "accept_entities", requestId: `${runId}:accept` },
    });
  return {
    app,
    database,
    projectId,
    sessionId,
    runId,
    runs,
    story,
    canon,
    requests,
    detail,
    advanceSession,
    finish,
    candidates,
    decide,
    accept,
    setPlan: (value: RollingOutlineProposal) => {
      plan = value;
    },
  };
}

describe("rolling planning entity decisions", () => {
  it("parks without creating chapters, preserves staging/decision retries, and binds accepted entities into chapter context and backups", async () => {
    const t = await setup();
    expect(await t.finish()).toBe("awaiting_user");
    await t.advanceSession();
    expect(await t.detail()).toMatchObject({
      currentChapter: null,
      stopReason: "planning_entities_require_decision",
      availableActions: ["accept_entities", "replan", "cancel"],
    });
    expect(t.story.listOutline(t.projectId)).toHaveLength(1);
    expect(t.canon.listEntities(t.projectId)).toHaveLength(0);
    const pending = await t.accept();
    expect(pending.statusCode, pending.body).toBe(409);
    expect(pending.json().error.code).toBe("planning.entities.pending");
    // Generic resume must return to the same persisted decision boundary.
    t.runs.resume(t.runId, new Date().toISOString());
    expect(await t.finish()).toBe("awaiting_user");
    for (let i = 0; i < 2; i++)
      expect((await t.decide("pilot", "apply")).statusCode).toBe(200);
    expect((await t.accept()).json().error.code).toBe(
      "planning.entities.pending",
    );
    const snapshot = t.runs.getSnapshot(t.runId);
    stagePlanningEntities(
      t.database,
      snapshot,
      snapshot.steps.find((step) => step.kind === "outline.entities")!.id,
      new Date().toISOString(),
    );
    expect(await t.candidates()).toHaveLength(1);
    expect((await t.candidates())[0]!.items[0]!.decision?.action).toBe("apply");
    expect((await t.decide("harbor", "apply")).statusCode).toBe(200);
    for (let i = 0; i < 2; i++) {
      const r = await t.accept();
      expect(r.statusCode, r.body).toBe(200);
    }
    expect(await t.finish()).toBe("completed");
    const chapter = t.story
      .listOutline(t.projectId)
      .find((node) => node.kind === "chapter")!;
    const pilot = t.canon
      .listEntities(t.projectId)
      .find((entity) => entity.name === "沈渡")!;
    const harbor = t.canon
      .listEntities(t.projectId)
      .find((entity) => entity.name === "潮门港")!;
    expect(chapter.povEntityId).toBe(pilot.id);
    expect(chapter.metadata.plannedEntityIds).toEqual([pilot.id, harbor.id]);
    expect(t.canon.countEntityReferences(harbor.id)).toBeGreaterThan(0);
    await t.advanceSession();
    await t.advanceSession();
    const chapterRun = (await t.detail()).session.currentRunId!;
    await t.app.inject({
      method: "POST",
      url: `/api/runs/${chapterRun}/advance`,
      payload: { projectId: t.projectId },
    });
    const compiled = t.runs
      .getSnapshot(chapterRun)
      .steps.find((step) => step.kind === "context.compile")!.outputArtifact!;
    const contexts = compiled.contexts as Record<string, { text: string }>;
    expect(contexts["scene-plan"]!.text).toContain("AUTHORED_PROFILE_SECRET");
    expect(contexts["chapter-draft"]!.text).toContain(pilot.id);
    expect(contexts["chapter-draft"]!.text).toContain("潮门港");
    expect(contexts["chapter-draft"]!.text).not.toContain(
      "AUTHORED_PROFILE_SECRET",
    );
    const backup = await t.app.inject({
      method: "POST",
      url: `/api/projects/${t.projectId}/backups`,
      payload: { label: "实体引用" },
    });
    expect(backup.statusCode, backup.body).toBe(201);
    const restored = await t.app.inject({
      method: "POST",
      url: `/api/backups/${backup.json().id}/restore`,
      payload: { requestId: crypto.randomUUID(), title: "恢复引用" },
    });
    expect(restored.statusCode, restored.body).toBe(201);
    const restoredId = restored.json().projectId as string;
    const restoredChapter = t.story
      .listOutline(restoredId)
      .find((node) => node.kind === "chapter")!;
    const restoredEntities = t.canon.listEntities(restoredId);
    expect(restoredChapter.metadata.plannedEntityIds).toEqual(
      ["沈渡", "潮门港"].map(
        (name) => restoredEntities.find((entity) => entity.name === name)!.id,
      ),
    );
    expect(restoredChapter.metadata.plannedEntityIds).not.toContain(pilot.id);
    const removed = await t.app.inject({
      method: "DELETE",
      url: `/api/projects/${t.projectId}/entities/${harbor.id}`,
      payload: { expectedUpdatedAt: harbor.updatedAt },
    });
    expect(removed.statusCode, removed.body).toBe(200);
    expect(t.canon.getEntity(t.projectId, harbor.id)?.status).toBe("retired");
  });

  it("keeps adopted entities and rejection feedback when replanning, allowing a closed-cast window with no new proposals", async () => {
    const t = await setup();
    await t.finish();
    await t.advanceSession();
    expect((await t.decide("pilot", "apply")).statusCode).toBe(200);
    expect((await t.decide("harbor", "reject")).statusCode).toBe(200);
    expect((await t.accept()).json().error.code).toBe(
      "planning.entities.rejected",
    );
    expect(t.story.listOutline(t.projectId)).toHaveLength(1);
    const replan = await t.app.inject({
      method: "POST",
      url: `/api/autopilot/sessions/${t.sessionId}/resolutions`,
      payload: { action: "replan" },
    });
    expect(replan.statusCode, replan.body).toBe(200);
    expect(t.story.listOutline(t.projectId)[0]!.status).not.toBe("abandoned");
    const plan = openWorldPlan();
    plan.entityProposals = [];
    const pilot = t.canon.listEntities(t.projectId)[0]!;
    plan.chapters[0]!.pov = { kind: "existing", id: pilot.id };
    plan.chapters[0]!.entityRefs = [{ kind: "existing", id: pilot.id }];
    t.setPlan(plan);
    await t.advanceSession();
    await t.advanceSession();
    const nextRun = (await t.detail()).session.currentRunId!;
    expect(nextRun).not.toBe(t.runId);
    expect(await t.finish(nextRun)).toBe("completed");
    expect(t.requests[1]).toContain("rejectedProposals");
    expect(t.requests[1]).toContain("潮门港");
    expect(t.requests[1]).toContain(pilot.id);
    expect(t.canon.listEntities(t.projectId)).toHaveLength(1);
    expect(await t.candidates()).toHaveLength(1);
  });

  it.each(["cancel", "outline", "compass", "alias"] as const)(
    "refuses adoption after %s changes without partial writes",
    async (change) => {
      const t = await setup();
      await t.finish();
      await t.advanceSession();
      const now = new Date().toISOString();
      if (change === "cancel") t.runs.requestCancel(t.runId, now);
      if (change === "outline")
        t.story.updateOutlineDetails(
          t.projectId,
          t.story.listOutline(t.projectId)[0]!.id,
          { title: "作者改动" },
          now,
        );
      if (change === "compass")
        new SqliteAutomationRepository(t.database).upsertCompass({
          projectId: t.projectId,
          corePromise: "新方向",
          endingDirection: null,
          longLines: [],
          themeQuestions: [],
          target: { chapters: 100, wordsPerChapter: 3000, volumes: 3 },
          constraints: [],
          version: 1,
          updatedAt: now,
        });
      if (change === "alias")
        t.canon.insertEntity(
          createCanonEntity({
            id: "existing",
            projectId: t.projectId,
            type: "character",
            name: "其他名字",
            aliases: [" 摆渡人 "],
            now,
          }),
        );
      const before = t.canon.listEntities(t.projectId);
      const response = await t.decide("pilot", "apply");
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().error.code).toBe(
        {
          cancel: "planning.entities.stale",
          outline: "outline.baseline.conflict",
          compass: "compass.baseline.conflict",
          alias: "planning.memory.stale",
        }[change],
      );
      expect(t.canon.listEntities(t.projectId)).toEqual(before);
      expect((await t.candidates())[0]!.items[0]!.decision).toBeNull();
      expect((await t.decide("pilot", "reject")).statusCode).toBe(200);
    },
  );

  it.each(["pending", "rejected"] as const)(
    "rechecks %s decisions inside commit even if the approval flag is forged",
    async (decision) => {
      const t = await setup();
      await t.finish();
      if (decision === "rejected")
        expect((await t.decide("harbor", "reject")).statusCode).toBe(200);
      t.runs.mergePolicy(
        t.runId,
        { entityCandidatesApproved: true },
        new Date().toISOString(),
      );
      t.runs.resume(t.runId, new Date().toISOString());
      expect(await t.finish()).toBe("failed");
      expect(
        t.runs
          .getSnapshot(t.runId)
          .steps.find((step) => step.kind === "outline.commit")?.error?.code,
      ).toBe(`planning.entities.${decision}`);
      expect(t.story.listOutline(t.projectId)).toHaveLength(1);
    },
  );

  it("rechecks adopted identities after approval and before outline commit", async () => {
    const t = await setup();
    await t.finish();
    await t.advanceSession();
    for (const key of ["pilot", "harbor"])
      expect((await t.decide(key, "apply")).statusCode).toBe(200);
    expect((await t.accept()).statusCode).toBe(200);
    const entity = t.canon.listEntities(t.projectId)[0]!;
    t.canon.updateEntity({
      ...entity,
      status: "retired",
      updatedAt: new Date().toISOString(),
    });
    expect(await t.finish()).toBe("failed");
    expect(
      t.runs
        .getSnapshot(t.runId)
        .steps.find((step) => step.kind === "outline.commit")?.error?.code,
    ).toBe("planning.memory.stale");
    expect(t.story.listOutline(t.projectId)).toHaveLength(1);
  });

  it("rejects invalid identities during generation, including foreign references, duplicate keys, aliases, and a location POV", () => {
    const existing = createCanonEntity({
      id: "existing",
      projectId: "this-book",
      type: "character",
      name: "沈渡",
      aliases: ["摆渡人"],
      now: new Date().toISOString(),
    });
    const plan = openWorldPlan();
    expect(planningEntityIssues(plan, [])).toEqual([]);
    expect(planningEntityIssues(plan, [existing]).join(" ")).toContain(
      "already belongs to existing",
    );
    plan.entityProposals[0]!.name = "另一名字";
    plan.entityProposals[0]!.aliases = ["　摆渡人　"];
    expect(planningEntityIssues(plan, [existing]).join(" ")).toContain(
      "already belongs",
    );
    plan.chapters[0]!.entityRefs.push({
      kind: "existing",
      id: "foreign-book-entity",
    });
    plan.chapters[0]!.pov = { kind: "proposed", id: "harbor" };
    plan.entityProposals.push({ ...plan.entityProposals[0]! });
    const issues = planningEntityIssues(plan, [existing]).join(" ");
    expect(issues).toContain("foreign-book-entity");
    expect(issues).toContain("must be unique");
    expect(issues).toContain("must reference a character");
    expect(
      RollingOutlineProposalSchema.safeParse({
        ...plan,
        entityProposals: [{ ...plan.entityProposals[0]!, key: "../unsafe" }],
      }).success,
    ).toBe(false);
  });
});
