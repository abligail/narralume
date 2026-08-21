import { createProject } from "@narralume/domain";
import { NodeNarrativeDatabase } from "../src/node.js";
import { buildFoundationRecipe } from "@narralume/harness";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SqliteAutomationRepository,
  SqliteModelRepository,
  SqliteProjectRepository,
  SqliteProviderRepository,
  SqliteRunRepository,
} from "../src/index.js";

const now = "2026-08-10T00:00:00.000Z";
const budget = {
  maxInputTokens: 100_000,
  maxOutputTokens: 20_000,
  maxCalls: 10,
  maxCostUsd: null,
  maxWallTimeMs: 300_000,
};
let database: NodeNarrativeDatabase;
let automation: SqliteAutomationRepository;
let runs: SqliteRunRepository;

beforeEach(() => {
  database = new NodeNarrativeDatabase();
  database.migrate();
  new SqliteProjectRepository(database).insert(
    createProject({ id: "p1", title: "潮汐灯塔", now }),
  );
  new SqliteProviderRepository(database).upsert({
    id: "profile",
    name: "test",
    wireApi: "openai-responses",
    baseUrl: "https://api.example.com/v1",
    endpoint: null,
    credentialRef: "env:TEST_KEY",
    anthropicVersion: null,
    headers: {},
    queryParams: {},
    requestStartTimeoutMs: null,
    streamIdleTimeoutMs: null,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  });
  new SqliteModelRepository(database).upsert({
    id: "profile",
    providerId: "profile",
    modelId: "test-model",
    taskType: "writing",
    contextWindow: null,
    maxOutputTokens: null,
    sampling: {},
    capabilities: {},
    enabled: true,
    createdAt: now,
    updatedAt: now,
  });
  automation = new SqliteAutomationRepository(database);
  runs = new SqliteRunRepository(database);
});

afterEach(() => database.close());

describe("SqliteAutomationRepository", () => {
  it("versions the compass and resolves candidate sets idempotently", () => {
    expect(
      automation.upsertCompass({
        projectId: "p1",
        corePromise: "每次遗忘都必须留下可见代价。",
        endingDirection: "女儿决定保留痛苦的记忆。",
        longLines: [{ title: "失踪者", promise: "找回名字", status: "open" }],
        themeQuestions: ["遗忘是否等于宽恕？"],
        target: { chapters: 30, wordsPerChapter: 2500, volumes: 2 },
        constraints: ["不使用梦境解释"],
        version: 1,
        updatedAt: now,
      }).version,
    ).toBe(1);
    expect(
      automation.upsertCompass({
        ...automation.requireCompass("p1"),
        corePromise: "记忆与责任不可分割。",
        updatedAt: "2026-08-10T00:00:01.000Z",
      }).version,
    ).toBe(2);

    const recipe = buildFoundationRecipe("foundation-run");
    runs.create({
      id: "foundation-run",
      projectId: "p1",
      recipe: recipe.name,
      recipeVersion: recipe.version,
      mode: "manual",
      targetOutlineNodeId: null,
      policy: {},
      budgetLimit: budget,
      steps: recipe.steps,
      now,
    });
    const staged = automation.stageCandidateSet({
      id: "set-1",
      projectId: "p1",
      sourceRunId: "foundation-run",
      title: "第一组候选",
      candidates: [
        {
          id: "candidate-1",
          kind: "intent",
          label: "作者意图",
          payload: { promise: "守住名字" },
        },
        {
          id: "candidate-2",
          kind: "entity",
          label: "林昼",
          payload: { type: "character", name: "林昼" },
        },
      ],
      now,
    });
    expect(staged.candidates).toHaveLength(2);
    automation.resolveCandidate("candidate-1", {
      status: "adopted",
      adoptedRefType: "author_intent",
      adoptedRefId: "p1",
      now,
    });
    expect(automation.requireCandidateSet("set-1").set.status).toBe(
      "partially_adopted",
    );
    automation.resolveCandidate("candidate-2", {
      status: "discarded",
      now,
    });
    expect(automation.requireCandidateSet("set-1").set.status).toBe(
      "partially_adopted",
    );
    expect(
      automation.resolveCandidate("candidate-1", {
        status: "discarded",
        now,
      }).status,
    ).toBe("adopted");
  });

  it("persists session child links, controls, steers, and recovery outcomes", () => {
    const session = automation.createSession({
      id: "session-1",
      projectId: "p1",
      mode: "autopilot",
      targetChapters: 5,
      windowSize: 3,
      maxRevisionCycles: 2,
      chapterPolicy: { minChapterCharacters: 1200 },
      childBudget: budget,
      now,
    });
    expect(session.status).toBe("pending");

    const recipe = buildFoundationRecipe("child-run");
    runs.create({
      id: "child-run",
      projectId: "p1",
      recipe: recipe.name,
      recipeVersion: recipe.version,
      mode: "autopilot",
      targetOutlineNodeId: null,
      policy: {},
      budgetLimit: budget,
      steps: recipe.steps,
      now,
    });
    automation.attachRun("session-1", {
      runId: "child-run",
      role: "rolling-plan",
      outlineNodeId: null,
      now,
    });
    expect(automation.requireSession("session-1")).toMatchObject({
      status: "planning",
      currentRunId: "child-run",
    });
    expect(
      automation.markRunProcessed("session-1", "child-run", "completed", now),
    ).toBe(true);
    expect(
      automation.markRunProcessed("session-1", "child-run", "completed", now),
    ).toBe(false);

    const steer = automation.createSteer({
      id: "steer-1",
      projectId: "p1",
      sessionId: "session-1",
      targetRunId: null,
      content: "下一章让林昼主动撒谎。",
      now,
    });
    expect(steer.status).toBe("pending");
    automation.classifySteer("steer-1", {
      classification: "next_scene",
      effectiveBoundary: "next_chapter",
      rationale: "不必改写已提交内容",
      risk: "low",
      now,
    });
    automation.resolveSteer("steer-1", "applied", now);
    expect(automation.listSteers("session-1")[0]).toMatchObject({
      classification: "next_scene",
      status: "applied",
    });

    const failedRecipe = buildFoundationRecipe("steer-classification-failed");
    runs.create({
      id: "steer-classification-failed",
      projectId: "p1",
      recipe: failedRecipe.name,
      recipeVersion: failedRecipe.version,
      mode: "manual",
      targetOutlineNodeId: null,
      policy: {},
      budgetLimit: budget,
      steps: failedRecipe.steps,
      now,
    });
    automation.createSteer({
      id: "steer-failed",
      projectId: "p1",
      sessionId: "session-1",
      targetRunId: null,
      content: "下一章改成雨夜追逐。",
      now,
    });
    automation.setSteerClassificationRun(
      "steer-failed",
      "steer-classification-failed",
      now,
    );
    runs.setRunStatus(
      "steer-classification-failed",
      "failed",
      now,
      "model_request_invalid",
    );
    expect(automation.reconcileSteerClassifications("session-1", now)).toBe(1);
    expect(automation.requireSteer("steer-failed")).toMatchObject({
      status: "rejected",
      rationale:
        "Impact assessment failed, so this steering instruction was not applied",
    });

    automation.requestSessionControl("session-1", "pause", now);
    expect(automation.requireSession("session-1").pauseRequested).toBe(true);
    automation.setSessionStatus("session-1", "paused", now);
    expect(automation.listActionableSessions()).toHaveLength(0);
    automation.resumeSession("session-1", now);
    expect(automation.requireSession("session-1").status).toBe("running");
    expect(automation.listActionableSessions()).toHaveLength(1);
    automation.setSessionStatus("session-1", "awaiting_user", now);
    expect(automation.listActionableSessions()).toHaveLength(0);
  });
});
