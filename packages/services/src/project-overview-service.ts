import type {
  AutopilotSession,
  OutlineStatus,
  RunSnapshot,
} from "@narralume/domain";
import {
  SqliteAutomationRepository,
  SqliteDocumentRepository,
  SqliteProjectRepository,
  SqliteProjectStatisticsRepository,
  SqliteReviewRepository,
  SqliteRunRepository,
  SqliteStoryRepository,
  type NarrativeDatabase,
} from "@narralume/persistence";

import { runProductProjection } from "./run-policy.js";
import { isPrimaryRunRecipe } from "./task-classification.js";

const TERMINAL_SESSION_STATUSES = new Set(["completed", "cancelled"]);

interface ChapterOverviewView {
  outlineNodeId: string;
  title: string;
  status: OutlineStatus;
  documentId: string | null;
  documentVersionId: string | null;
}

export class ProjectOverviewService {
  private readonly projects: SqliteProjectRepository;
  private readonly story: SqliteStoryRepository;
  private readonly documents: SqliteDocumentRepository;
  private readonly runs: SqliteRunRepository;
  private readonly automation: SqliteAutomationRepository;
  private readonly reviews: SqliteReviewRepository;
  private readonly statistics: SqliteProjectStatisticsRepository;

  constructor(database: NarrativeDatabase) {
    this.projects = new SqliteProjectRepository(database);
    this.story = new SqliteStoryRepository(database);
    this.documents = new SqliteDocumentRepository(database);
    this.runs = new SqliteRunRepository(database);
    this.automation = new SqliteAutomationRepository(database);
    this.reviews = new SqliteReviewRepository(database);
    this.statistics = new SqliteProjectStatisticsRepository(database);
  }

  get(projectId: string) {
    const project = this.projects.get(projectId);
    if (!project) return null;

    const chapters = this.story
      .listOutline(projectId)
      .filter((node) => node.kind === "chapter");
    const chapterDocuments = new Map(
      this.documents
        .list(projectId, "chapter")
        .filter((document) => document.outlineNodeId)
        .map((document) => [document.outlineNodeId!, document]),
    );
    const chapterViews = new Map(
      chapters.map((chapter) => {
        const document = chapterDocuments.get(chapter.id);
        return [
          chapter.id,
          {
            outlineNodeId: chapter.id,
            title: chapter.title,
            status: chapter.status,
            documentId: document?.id ?? null,
            documentVersionId: document?.currentVersionId ?? null,
          },
        ] as const;
      }),
    );
    const statistics = this.statistics.get(projectId)!;

    const activeSession = this.automation
      .listSessions(projectId)
      .find((session) => !TERMINAL_SESSION_STATUSES.has(session.status));
    const activeRun =
      this.runs
        .listActiveRuns(projectId)
        .find((run) => isPrimaryRunRecipe(run.recipe)) ?? null;
    const activeTask = activeSession
      ? this.sessionTask(activeSession, chapterViews)
      : activeRun
        ? this.runTask(this.runs.getSnapshot(activeRun.id), chapterViews)
        : null;

    const activeTargetId = activeTask?.targetChapter?.outlineNodeId ?? null;
    const currentChapter = activeTargetId
      ? (chapterViews.get(activeTargetId) ?? null)
      : (chapters
          .filter(
            (chapter) =>
              chapter.status !== "committed" && chapter.status !== "abandoned",
          )
          .map((chapter) => chapterViews.get(chapter.id)!)
          .at(0) ?? null);

    const candidateSets = this.automation.listCandidateSets(projectId);
    const foundationCandidates = candidateSets
      .flatMap((set) => set.candidates)
      .filter((candidate) => candidate.status === "pending");
    const reports = this.reviews.listProjectReports(projectId);
    const reviewIssues = reports.flatMap((report) => {
      // 只有已经绑定到正文的报告，才能在写作台中定位和裁定。
      // 任务中途失败留下的候选审稿仍保留在运行证据里，但不能冒充产品待办。
      if (!report.documentId) return [];
      const run = this.runs.getRun(report.runId);
      if (run?.status === "cancelled") return [];
      return report.issues
        .filter((issue) => issue.status === "open")
        .map((issue) => ({
          reportId: report.id,
          documentId: report.documentId!,
          issue,
        }));
    });
    const revisionProposals = this.reviews
      .listRevisionProposals(projectId)
      .filter(
        (proposal) => proposal.status === "proposed" && proposal.documentId,
      );
    const reviewDocumentId =
      revisionProposals[0]?.documentId ?? reviewIssues[0]?.documentId ?? null;
    const canonChangeSets = this.reviews
      .listCanonChangeSets(projectId)
      .filter((changeSet) => changeSet.status === "candidate");

    return {
      project,
      progress: {
        lastWritingAt: statistics.lastWritingAt,
        wordCount: statistics.wordCount,
        committedChapters: statistics.committedChapters,
        totalChapters: statistics.totalChapters,
      },
      currentChapter,
      activeTask,
      pending: {
        foundationCandidates: foundationCandidates.length,
        reviewIssues: reviewIssues.length,
        revisionProposals: revisionProposals.length,
        canonChangeSets: canonChangeSets.length,
        reviewDocumentId,
      },
      nextAction: activeTask
        ? { kind: "continue_task", targetId: activeTask.id }
        : foundationCandidates[0]
          ? { kind: "review_foundation", targetId: foundationCandidates[0].id }
          : canonChangeSets[0]
            ? {
                kind: "resolve_story_changes",
                targetId: canonChangeSets[0].id,
              }
            : revisionProposals[0]
              ? {
                  kind: "review_writing",
                  targetId: revisionProposals[0].id,
                }
              : reviewIssues[0]
                ? {
                    kind: "review_writing",
                    targetId: reviewIssues[0].reportId,
                  }
                : currentChapter && currentChapter.status !== "committed"
                  ? {
                      kind: "write_chapter",
                      targetId: currentChapter.outlineNodeId,
                    }
                  : chapters.length === 0
                    ? { kind: "build_outline", targetId: null }
                    : { kind: "complete", targetId: null },
    };
  }

  private runTask(
    snapshot: RunSnapshot,
    chapters: ReadonlyMap<string, ChapterOverviewView>,
  ) {
    const projection = runProductProjection(snapshot);
    const isChapterTask = snapshot.run.recipe === "chapter-production";
    const isFoundationTask = snapshot.run.recipe === "book-foundation";
    if (!isChapterTask && !isFoundationTask) {
      throw new Error(
        `Task projection does not support recipe ${snapshot.run.recipe}`,
      );
    }
    return {
      // foundation 也会把书级大纲根节点记在 targetOutlineNodeId 上；
      // 是否为单章任务必须由 recipe 判断，不能把“有目标节点”等同于“写正文”。
      kind: isChapterTask ? "chapter" : "foundation",
      id: snapshot.run.id,
      status: snapshot.run.status,
      targetChapter:
        isChapterTask && snapshot.run.targetOutlineNodeId
          ? (chapters.get(snapshot.run.targetOutlineNodeId) ?? null)
          : null,
      origin: isFoundationTask
        ? { ...projection.origin, surface: "autopilot" }
        : projection.origin,
      stopReason: latestRunReason(snapshot),
      availableActions: projection.availableActions,
    };
  }

  private sessionTask(
    session: AutopilotSession,
    chapters: ReadonlyMap<string, ChapterOverviewView>,
  ) {
    const child = session.currentRunId
      ? this.runs.getSnapshot(session.currentRunId)
      : null;
    return {
      kind: "quick_creation",
      id: session.id,
      status: session.status,
      targetChapter: session.currentOutlineNodeId
        ? (chapters.get(session.currentOutlineNodeId) ?? null)
        : null,
      origin: isRecord(session.chapterPolicy.origin)
        ? session.chapterPolicy.origin
        : null,
      stopReason: child
        ? latestRunReason(child)
        : typeof session.lastError?.code === "string"
          ? session.lastError.code
          : null,
      availableActions: sessionActions(session, child),
    };
  }
}

function sessionActions(
  session: AutopilotSession,
  child: RunSnapshot | null,
): string[] {
  if (["pending", "planning", "running"].includes(session.status)) {
    return ["pause", "cancel"];
  }
  if (session.status === "paused") return ["resume", "cancel"];
  if (session.status === "failed") {
    return ["retry-current", "skip-chapter", "replan", "stop"];
  }
  if (session.status !== "awaiting_user") return [];
  const reason = child ? latestRunReason(child) : null;
  if (reason === "chapter_commit_approval_required") {
    return ["accept_manuscript", "request_revision", "cancel"];
  }
  if (reason === "scene_plan_approval_required") {
    return ["accept_plan", "cancel"];
  }
  if (reason === "settlement_conflict_requires_resolution") {
    return ["cancel"];
  }
  return ["cancel"];
}

function latestRunReason(snapshot: RunSnapshot): string | null {
  const event = [...snapshot.events]
    .reverse()
    .find((candidate) => candidate.type === `run.${snapshot.run.status}`);
  return typeof event?.payload.reason === "string"
    ? event.payload.reason
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
