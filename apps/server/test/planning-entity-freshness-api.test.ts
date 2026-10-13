import { randomUUID } from "node:crypto";
import { createCanonEntity, ZERO_BUDGET_USAGE } from "@narralume/domain";
import { buildRollingOutlineRecipe } from "@narralume/harness";
import {
  AutomationWorkerSuite,
  type NarrativeModelClient,
} from "@narralume/narrative";
import {
  SqliteAutomationRepository,
  SqliteCanonRepository,
  SqliteRunRepository,
  SqliteStoryRepository,
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

async function setup(proposeEntities = false, withRedundantAliases = false) {
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
  const created = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: { requestId: randomUUID(), title: "实体目录基线" },
  });
  expect(created.statusCode, created.body).toBe(201);
  const projectId = created.json().id as string;
  const canon = new SqliteCanonRepository(database);
  const entity = canon.insertEntity(
    createCanonEntity({
      id: randomUUID(),
      projectId,
      type: "character",
      name: "苇娘",
      aliases: ["阿苇的母亲"],
      description: "苇娘是阿苇的母亲。" + "作者的人物资料。".repeat(40),
      now: new Date().toISOString(),
    }),
  );
  const story = new SqliteStoryRepository(database);
  const runs = new SqliteRunRepository(database);
  const now = new Date().toISOString();
  const session = new SqliteAutomationRepository(database).createSession({
    id: randomUUID(),
    projectId,
    mode: "autopilot",
    targetChapters: 1,
    windowSize: 1,
    maxRevisionCycles: 0,
    chapterPolicy: {},
    now,
  });
  const id = randomUUID();
  const recipe = buildRollingOutlineRecipe(id);
  runs.create({
    id,
    projectId,
    recipe: recipe.name,
    recipeVersion: recipe.version,
    mode: "autopilot",
    targetOutlineNodeId: story.listOutline(projectId)[0]!.id,
    policy: { sessionId: session.id },
    steps: recipe.steps,
    now,
  });
  runs.leaseRun(id, "planning-catalog-test", now, 30_000);
  let duringGeneration: (() => void) | undefined;
  const proposals = proposeEntities
    ? ["witnessA", "witnessB"].map((key, index) => ({
        key,
        type: "character" as const,
        name: `见证人${index + 1}`,
        aliases: withRedundantAliases
          ? [
              `见证人${index + 1}`,
              `证人别名${index + 1}`,
              `证人别名${index + 1}`,
            ]
          : [],
        description: "持有另一份渡口记录。",
        narrativeRole: "提供另一份记录",
        rationale: "需要核对记录来源",
      }))
    : [];
  const model: NarrativeModelClient = {
    async text() {
      throw Error("unexpected");
    },
    async structured(_run, _step, _purpose, _request, _contract, validate) {
      duringGeneration?.();
      const checked = validate({
        entityProposals: proposals,
        decisionAcknowledgements: [],
        rationale: "由苇娘确认母女关系并核对渡口记录。",
        volumeId: null,
        arcId: null,
        volume: { title: "第一卷", summary: "查证渡口记录", goal: "核对来源" },
        arc: {
          title: "渡口调查",
          summary: "苇娘与阿苇核对旧记录",
          goal: "查明来源",
          conflict: "记录不符",
          outcome: "取得证据",
        },
        chapters: [
          {
            title: "母女查证",
            summary: "由苇娘确认与阿苇的母女关系",
            goal: "核验记录",
            conflict: "两份记录不符",
            outcome: "取得线索",
            pov: { kind: "existing", id: entity.id },
            entityRefs: [
              { kind: "existing", id: entity.id },
              ...proposals.map(({ key }) => ({ kind: "proposed", id: key })),
            ],
            storyTime: null,
            hook: "谁改动了记录",
          },
        ],
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
  const workers = new AutomationWorkerSuite(database, model).registry();
  const execute = async (
    kind: "outline.generate" | "outline.entities" | "outline.commit",
  ) => {
    const step = runs.getSnapshot(id).steps.find((step) => step.kind === kind)!;
    runs.startStep(id, step.id, new Date().toISOString());
    const result = await workers[kind]!.execute(
      runs.getSnapshot(id),
      step,
      new AbortController().signal,
    );
    runs.succeedStep(
      id,
      step.id,
      result.output,
      result.artifactKind,
      new Date().toISOString(),
    );
    return result;
  };
  const adopt = (key: string) =>
    app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/canon-candidates/${id}:planning-entities/items/${key}/decisions`,
      payload: { action: "apply" },
    });
  return {
    app,
    database,
    canon,
    entity,
    projectId,
    story,
    runs,
    id,
    execute,
    adopt,
    during: (action: () => void) => {
      duringGeneration = action;
    },
  };
}

const catalogChanges = [
  "name",
  "aliases",
  "description",
  "type",
  "status",
  "addition",
  "deletion",
] as const;
type CatalogChange = (typeof catalogChanges)[number];
function changeCatalog(
  t: Awaited<ReturnType<typeof setup>>,
  change: CatalogChange,
  entity = t.entity,
) {
  if (change === "addition") {
    t.canon.insertEntity(
      createCanonEntity({
        id: randomUUID(),
        projectId: t.projectId,
        type: "location",
        name: "新渡口",
        now: new Date().toISOString(),
      }),
    );
  } else if (change === "deletion") {
    t.canon.deleteEntity(t.projectId, entity.id);
  } else if (change === "type") {
    t.database.raw
      .prepare(
        "UPDATE canon_entities SET type = ? WHERE project_id = ? AND id = ?",
      )
      .run("organization", t.projectId, entity.id);
  } else {
    t.canon.updateEntity({
      ...entity,
      ...(change === "name" ? { name: "新名字" } : {}),
      ...(change === "aliases" ? { aliases: ["新别名"] } : {}),
      ...(change === "description"
        ? { description: "作者已更正母女关系。" }
        : {}),
      ...(change === "status" ? { status: "retired" as const } : {}),
      updatedAt: new Date().toISOString(),
    });
  }
}

describe("rolling planning entity catalog freshness", () => {
  it.each(catalogChanges)(
    "rejects generation after catalog %s",
    async (change) => {
      const t = await setup();
      t.during(() => changeCatalog(t, change));
      await expect(t.execute("outline.generate")).rejects.toMatchObject({
        code: "planning.memory.stale",
      });
    },
  );

  it.each(
    catalogChanges.flatMap((change) =>
      ["stage", "commit"].map((boundary) => ({ change, boundary })),
    ),
  )(
    "rejects $boundary after catalog $change without writing an outline",
    async ({ change, boundary }) => {
      const t = await setup();
      await t.execute("outline.generate");
      if (boundary === "commit") await t.execute("outline.entities");
      const before = t.story.listOutline(t.projectId);
      changeCatalog(t, change);
      await expect(
        t.execute(boundary === "stage" ? "outline.entities" : "outline.commit"),
      ).rejects.toMatchObject({ code: "planning.memory.stale" });
      expect(t.story.listOutline(t.projectId)).toEqual(before);
    },
  );

  it.each(["attributes", "updatedAt", "description suffix"] as const)(
    "allows generation and commit after unprovided %s changes",
    async (change) => {
      const t = await setup();
      const mutate = () => {
        const current = t.canon.requireEntity(t.projectId, t.entity.id);
        t.canon.updateEntity({
          ...current,
          ...(change === "attributes"
            ? { attributes: { hidden: randomUUID() } }
            : {}),
          ...(change === "description suffix"
            ? { description: current.description!.slice(0, 240) + randomUUID() }
            : {}),
          updatedAt: new Date().toISOString(),
        });
      };
      t.during(mutate);
      await t.execute("outline.generate");
      mutate();
      await t.execute("outline.entities");
      mutate();
      expect(
        (await t.execute("outline.commit")).output.chapterIds,
      ).toHaveLength(1);
    },
  );

  it.each([false, true])(
    "allows successive entity adoptions and commits their bindings, redundant aliases=%s",
    async (withRedundantAliases) => {
      const t = await setup(true, withRedundantAliases);
      await t.execute("outline.generate");
      await t.execute("outline.entities");
      for (const key of ["witnessA", "witnessB"]) {
        const accepted = await t.adopt(key);
        expect(accepted.statusCode, accepted.body).toBe(200);
        expect(accepted.json().candidateSet.stale).toBe(false);
      }
      const committed = await t.execute("outline.commit");
      const chapter = t.story.getOutlineNode(
        t.projectId,
        String(committed.output.chapterIds[0]),
      )!;
      expect(chapter.metadata.plannedEntityIds).toEqual([
        t.entity.id,
        `${t.id}:planning-entities:witnessA:entity`,
        `${t.id}:planning-entities:witnessB:entity`,
      ]);
    },
  );

  it.each(["name", "aliases", "description", "status", "addition"] as const)(
    "rejects further adoption and commit after adopted entity %s changes",
    async (change) => {
      const t = await setup(true);
      await t.execute("outline.generate");
      await t.execute("outline.entities");
      expect((await t.adopt("witnessA")).statusCode).toBe(200);
      const adopted = t.canon.requireEntity(
        t.projectId,
        `${t.id}:planning-entities:witnessA:entity`,
      );
      changeCatalog(t, change, adopted);
      const accepted = await t.adopt("witnessB");
      expect(accepted.statusCode, accepted.body).toBe(409);
      expect(accepted.json().error.code).toBe("planning.memory.stale");
      await expect(t.execute("outline.commit")).rejects.toMatchObject({
        code: "planning.memory.stale",
      });
    },
  );

  it("rejects a planned entity ID inserted without an apply decision", async () => {
    const t = await setup(true);
    await t.execute("outline.generate");
    await t.execute("outline.entities");
    t.canon.insertEntity(
      createCanonEntity({
        id: `${t.id}:planning-entities:witnessA:entity`,
        projectId: t.projectId,
        type: "character",
        name: "冒名的见证人",
        now: new Date().toISOString(),
      }),
    );
    const accepted = await t.adopt("witnessB");
    expect(accepted.statusCode, accepted.body).toBe(409);
    expect(accepted.json().error.code).toBe("planning.memory.stale");
  });
});
