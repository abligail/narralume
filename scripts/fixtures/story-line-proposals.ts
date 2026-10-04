import {
  createProject,
  createOutlineNode,
  createDocument,
  ZERO_BUDGET_USAGE,
} from "@narralume/domain";
import { buildClosingReviewRecipe } from "@narralume/harness";
import {
  AutomationWorkerSuite,
  type NarrativeModelClient,
} from "@narralume/narrative";
import {
  SqliteProjectRepository,
  SqliteStoryRepository,
  SqliteCanonRepository,
  SqliteDocumentRepository,
  SqliteNarrativeStateRepository,
  SqliteAutomationRepository,
  SqliteRunRepository,
  type NarrativeDatabase,
} from "@narralume/persistence";

export async function seedStoryLineProposals(
  database: NarrativeDatabase,
  suffix: string,
) {
  const projectId = `line-proposals-${suffix}`;
  const now = "2026-09-22T00:00:00.000Z";
  new SqliteProjectRepository(database).insert(
    createProject({ id: projectId, title: "雾港进展建议", now }),
  );
  const story = new SqliteStoryRepository(database);
  const book = story.insertOutlineNode(
    createOutlineNode({
      id: `${projectId}-book`,
      projectId,
      parent: null,
      kind: "book",
      ordinal: 0,
      title: "雾港",
      now,
    }),
  );
  const volume = story.insertOutlineNode(
    createOutlineNode({
      id: `${projectId}-volume`,
      projectId,
      parent: book,
      kind: "volume",
      ordinal: 0,
      title: "港内",
      now,
    }),
  );
  const chapter = story.insertOutlineNode({
    ...createOutlineNode({
      id: `${projectId}-chapter`,
      projectId,
      parent: volume,
      kind: "chapter",
      ordinal: 0,
      title: "旧信的去向",
      now,
    }),
    status: "committed",
  });
  const documents = new SqliteDocumentRepository(database);
  const document = documents.insert(
    createDocument({
      id: `${projectId}-doc`,
      projectId,
      kind: "chapter",
      title: chapter.title,
      outlineNodeId: chapter.id,
      now,
    }),
  );
  const version = documents.appendVersion(projectId, document.id, {
    id: `${projectId}-version`,
    content: "林澈从见证者手中接过旧信。潮声仍没有答案。",
    source: "fixture",
    now,
  });
  const state = new SqliteNarrativeStateRepository(
    database,
    new SqliteCanonRepository(database),
    story,
  );
  state.upsertSummary({
    id: `${projectId}-summary`,
    projectId,
    scopeType: "chapter",
    scopeId: chapter.id,
    summary: "见证者交出了旧信，潮声之谜仍未解决。",
    stateDelta: {},
    sourceHash: version.contentHash,
    createdAt: now,
  });
  const automation = new SqliteAutomationRepository(database);
  automation.upsertCompass({
    projectId,
    corePromise: "遗忘的代价",
    endingDirection: null,
    longLines: ["失踪者", "潮声", "旧信"].map((title) => ({
      title,
      promise: "寻找真相",
      status: "open",
    })),
    themeQuestions: [],
    target: { chapters: 30, wordsPerChapter: 2000, volumes: 3 },
    constraints: [],
    version: 1,
    updatedAt: now,
  });
  const session = automation.createSession({
    id: `${projectId}-session`,
    projectId,
    mode: "autopilot",
    targetChapters: 2,
    windowSize: 2,
    maxRevisionCycles: 0,
    chapterPolicy: {},
    now,
  });
  const runId = `${projectId}-run`;
  const recipe = buildClosingReviewRecipe(runId, ["volume"]);
  const runs = new SqliteRunRepository(database);
  runs.create({
    id: runId,
    projectId,
    mode: "autopilot",
    recipe: recipe.name,
    recipeVersion: recipe.version,
    targetOutlineNodeId: volume.id,
    policy: { sessionId: session.id, volumeId: volume.id },
    steps: recipe.steps,
    now,
  });
  runs.leaseNext("fixture", now, 30_000);
  const step = runs.startStep(runId, recipe.steps[0]!.id, now);
  const model: NarrativeModelClient = {
    async text() {
      throw new Error("Unexpected text generation");
    },
    async structured(_run, _step, _purpose, _request, _contract, validate) {
      const checked = validate({
        observations: [
          {
            text: "林澈取得旧信，潮声仍没有答案。",
            basis: "observed",
            citations: [
              {
                chapterId: chapter.id,
                paragraphOrdinal: 1,
                quote: "林澈从见证者手中接过旧信。潮声仍没有答案。",
              },
            ],
          },
        ],
        scores: {
          promise: 80,
          causality: 80,
          characterArc: 80,
          pacing: 80,
          continuity: 80,
        },
        recommendations: [],
        compassAdjustments: [],
        lineEvidence: [0, 1, 2].map((lineIndex) => ({
          lineIndex,
          citations: [
            {
              chapterId: chapter.id,
              paragraphOrdinal: 1,
              quote: "林澈从见证者手中接过旧信。潮声仍没有答案。",
            },
          ],
        })),
        lineProposals: [0, 1, 2].map((lineIndex) => ({
          lineIndex,
          rationale: "旧信交出已有正文依据，潮声尚待解释。",
          status: "developing",
          progress: "取得旧信",
          openPromises: ["潮声的来源"],
          nextDevelopment: "沿航线寻找收信人",
          evidenceChapterIds: [chapter.id],
        })),
      });
      if (!checked.success) throw new Error(checked.issues.join("; "));
      return {
        value: checked.data,
        usage: ZERO_BUDGET_USAGE,
        mode: "native",
        attempts: 1,
      };
    },
  };
  const worker = new AutomationWorkerSuite(database, model).registry()[
    "volume.review"
  ]!;
  await worker.execute(
    runs.getSnapshot(runId),
    step,
    new AbortController().signal,
  );
  // No fixture run should be picked up by unrelated browser tests.
  database.raw
    .prepare("UPDATE runs SET status = 'completed' WHERE id = ?")
    .run(runId);
}
