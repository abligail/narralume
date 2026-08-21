import "../styles/overview.css";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pause, Play, Square } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router";

import { ConfirmDialog } from "../components/confirm-dialog";
import { ErrorNote } from "../components/error-note";
import { ProjectRequiredState } from "../components/project-required-state";
import { Skeleton } from "../components/skeleton";
import { useI18n, type MessageKey } from "../i18n";
import {
  controlAutopilotSession,
  controlRun,
  getProjectOverview,
  resolveAutopilotFailure,
  type ProjectOverview,
  type ProjectOverviewActiveTask,
  type RunActionRequest,
  type SessionActionRequest,
} from "../lib/api";
import { formatRelativeDate } from "../lib/fmt";
import {
  nextActionKindLabel,
  outlineStatusLabel,
  projectPhaseLabel,
  stopReasonLabel,
  taskActionLabel,
  taskKindLabel,
  taskStatusLabel,
} from "../lib/labels";
import { projectWorkspacePath, useProjectId } from "../lib/project-route";
import {
  reconcileTasks,
  rememberTask,
  rememberedTasks,
  taskHref,
} from "../lib/task-ledger";

/* 项目概览：进入作品后的默认页面。数据源是服务端 overview 聚合：
   进度、当前章节、活动任务（origin / stopReason / availableActions）、
   待办计数与下一步。任务内部 Step 不在此解析；恢复走任务台账与深度链接。 */

export function OverviewWorkspace() {
  const { t } = useI18n();
  const projectId = useProjectId();
  const overviewQuery = useQuery({
    queryKey: ["project", projectId, "overview"],
    queryFn: ({ signal }) => getProjectOverview(projectId!, signal),
    enabled: Boolean(projectId),
    refetchInterval: (query) =>
      query.state.data?.activeTask ? 3_000 : false,
  });
  const overview = overviewQuery.data ?? null;

  /* 离页恢复对账：服务端真相是唯一权威；活跃任务收进台账，失踪任务清掉。 */
  useEffect(() => {
    if (!projectId || !overviewQuery.data) return;
    const active = overviewQuery.data.activeTask;
    if (active) {
      rememberTask({
        projectId,
        kind: active.kind,
        taskId: active.id,
        label: active.targetChapter?.title ?? taskKindLabel(active.kind),
        createdAt: new Date().toISOString(),
        origin: active.origin,
        documentId: active.targetChapter?.documentId ?? null,
      });
    }
    reconcileTasks(
      projectId,
      active ? [active.id] : [],
    );
  }, [projectId, overviewQuery.data]);

  if (!projectId) {
    return (
      <div className="overview">
        <ProjectRequiredState
          seal={t("overview.requiredState.seal")}
          title={t("overview.requiredState.title")}
          description={t("overview.requiredState.description")}
        />
      </div>
    );
  }

  return (
    <div className="overview">
      {overviewQuery.isPending ? (
        <Skeleton lines={7} />
      ) : overviewQuery.isError ? (
        <ErrorNote error={overviewQuery.error} title={t("overview.loadError")} />
      ) : overview ? (
        <OverviewBoard overview={overview} />
      ) : null}
    </div>
  );
}

function OverviewBoard({ overview }: { overview: ProjectOverview }) {
  const { t } = useI18n();
  const { progress, currentChapter, activeTask, pending, nextAction } = overview;
  const nextEntry = nextActionEntry(overview, t);
  return (
    <main className="overview__board">
      <header className="overview__masthead">
        <h1 className="overview__masthead-title">{overview.project.title}</h1>
        <p className="overview__masthead-premise">{overview.project.premise ?? t("overview.masthead.emptyPremise")}</p>
        <div className="overview__masthead-row mono">
          <span className="overview__masthead-index">OVERLOOK · 02</span>
          <span className="overview__masthead-phase">{projectPhaseLabel(overview.project.phase)}</span>
          <span className="overview__masthead-progress">{t("overview.masthead.progress", { committed: progress.committedChapters, total: progress.totalChapters, words: progress.wordCount })}</span>
          <span className="overview__masthead-writingat">
            {progress.lastWritingAt ? t("overview.masthead.lastWriting", { time: formatRelativeDate(progress.lastWritingAt) }) : t("overview.masthead.neverWriting")}
          </span>
        </div>
      </header>

      {/* 按任务 id 重挂载：轮询切到别的任务时，取消确认与 mutation 状态不跨任务残留。 */}
      {activeTask ? <ActiveTaskCard key={activeTask.id} projectId={overview.project.id} task={activeTask} /> : null}

      {!activeTask && currentChapter ? (
        <section className="overview__current">
          <h2 className="overview__current-head">{t("overview.currentChapter.head")}</h2>
          <article className="overview__chapter-card">
            <strong className="overview__chapter-title">{currentChapter.title}</strong>
            <span className="overview__chapter-status mono">{outlineStatusLabel(currentChapter.status)}</span>
            <div className="overview__chapter-actions">
              <Link to={chapterWritingHref(overview.project.id, currentChapter)} className="btn btn--primary" aria-label={t("overview.currentChapter.continueAria")}>{t("overview.currentChapter.continue")}</Link>
              <Link to={projectWorkspacePath(overview.project.id, "bible")} className="btn" aria-label={t("overview.currentChapter.viewStory")}>{t("overview.currentChapter.viewStory")}</Link>
            </div>
          </article>
        </section>
      ) : null}

      {!activeTask && !currentChapter ? (
        <section className="overview__current">
          <h2 className="overview__current-head">{t("overview.currentChapter.head")}</h2>
          <p className="overview__current-done">{completedChapterMessage(overview, t)}</p>
        </section>
      ) : null}

      <PendingStrip projectId={overview.project.id} pending={pending} activeTask={activeTask} />

      <section className="overview__entries" aria-label={t("overview.entries.ariaLabel")}>
        <h3 className="overview__entries-head mono">NEXT · {nextActionKindLabel(nextAction.kind)}</h3>
        {EntryCard(nextEntry.label, nextEntry.href, nextEntry.blurb, true)}
        {nextEntry.href !== projectWorkspacePath(overview.project.id, "bible") ? EntryCard(t("overview.entries.organizeStory.label"), projectWorkspacePath(overview.project.id, "bible"), t("overview.entries.organizeStory.blurb")) : null}
        {nextEntry.href !== projectWorkspacePath(overview.project.id, "autopilot") ? EntryCard(t("overview.entries.autopilot.label"), projectWorkspacePath(overview.project.id, "autopilot"), t("overview.entries.autopilot.blurb")) : null}
      </section>
    </main>
  );
}

/** 活动任务卡：只展示任务协议字段（kind / status / stopReason / availableActions），
 *  并提供「回到任务现场」的恢复链接；不展开任务内部步骤。 */
function ActiveTaskCard({ projectId, task }: { projectId: string; task: ProjectOverviewActiveTask }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const restore = rememberedTasks(projectId).find((item) => item.taskId === task.id);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const mutation = useMutation<unknown, Error, string>({
    mutationFn: (action: string) => {
      if (task.kind === "quick_creation") {
        if (["retry-current", "skip-chapter", "replan", "stop"].includes(action)) {
          return resolveAutopilotFailure(task.id, action as "retry-current" | "skip-chapter" | "replan" | "stop");
        }
        return controlAutopilotSession(task.id, { action } as SessionActionRequest);
      }
      return controlRun(projectId, task.id, { action } as RunActionRequest);
    },
    onSuccess: () => {
      setConfirmCancel(false);
      void queryClient.invalidateQueries({ queryKey: ["project", projectId, "overview"] });
      void queryClient.invalidateQueries({ queryKey: ["run", task.id] });
    },
  });
  const directActions = task.availableActions.filter((action) => ["pause", "resume", "retry-current", "skip-chapter", "replan", "stop"].includes(action));
  const needsProductDecision = task.availableActions.some((action) => ["accept_plan", "accept_manuscript", "request_revision", "discard_manuscript"].includes(action)) || task.stopReason === "settlement_conflict_requires_resolution";
  const href = taskHref(projectId, task.kind, task.id, {
    origin: task.origin,
    documentId: task.targetChapter?.documentId ?? restore?.documentId ?? null,
  });
  return (
    <section className="overview__current" aria-label={t("overview.activeTask.aria")}>
      <h2 className="overview__current-head">{t("overview.activeTask.head", { kind: taskKindLabel(task.kind) })}</h2>
      <article className="overview__chapter-card" data-task={task.kind}>
        <strong className="overview__chapter-title">
          {task.targetChapter?.title ?? restore?.label ?? t("overview.activeTask.fallbackTitle")}
        </strong>
        <span className="overview__chapter-status mono">{taskStatusLabel(task.status)}</span>
        {task.stopReason ? (
          <p className="overview__chapter-goal">{stopReasonLabel(task.stopReason)}</p>
        ) : null}
        <div className="overview__chapter-actions">
          {directActions.map((action) => <button key={action} type="button" className="btn" disabled={mutation.isPending} onClick={() => mutation.mutate(action)}>{action === "pause" ? <Pause size={13} /> : action === "resume" ? <Play size={13} /> : null}{taskActionLabel(action)}</button>)}
          {task.availableActions.includes("cancel") ? <button type="button" className="btn" disabled={mutation.isPending} onClick={() => setConfirmCancel(true)}><Square size={13} />{t("common.action.cancel")}</button> : null}
          <Link
            to={href}
            className="btn btn--primary"
            aria-label={t("overview.activeTask.backAria")}
          >
            {needsProductDecision ? t("overview.activeTask.decideLabel") : t("overview.activeTask.backLabel")}
          </Link>
        </div>
        {mutation.isError ? <ErrorNote error={mutation.error} title={t("overview.activeTask.error")} /> : null}
      </article>
      {confirmCancel ? <ConfirmDialog title={t("overview.cancelDialog.title")} confirmLabel={t("overview.cancelDialog.confirm")} danger pending={mutation.isPending} onCancel={() => setConfirmCancel(false)} onConfirm={() => mutation.mutate("cancel")}><p>{t("overview.cancelDialog.body")}</p></ConfirmDialog> : null}
    </section>
  );
}

/** 待办汇总：四项计数大于零才显形；各连到裁定位置。 */
function PendingStrip({ projectId, pending, activeTask }: { projectId: string; pending: ProjectOverview["pending"]; activeTask: ProjectOverviewActiveTask | null }) {
  const { t } = useI18n();
  const resumeHint = activeTask === null ? rememberedTasks(projectId)[0] : null;
  const reviewHref = reviewWorkspaceHref(projectId, pending.reviewDocumentId);
  const items = [
    { key: "foundation", count: pending.foundationCandidates, label: t("overview.pending.foundation"), href: projectWorkspacePath(projectId, "autopilot") },
    { key: "issues", count: pending.reviewIssues, label: t("overview.pending.issues"), href: reviewHref },
    { key: "proposals", count: pending.revisionProposals, label: t("overview.pending.proposals"), href: reviewHref },
    { key: "canon", count: pending.canonChangeSets, label: t("overview.pending.canon"), href: `${projectWorkspacePath(projectId, "studio")}?focus=canon` },
  ].filter((item) => item.count > 0);
  if (items.length === 0 && !resumeHint) return null;
  return (
    <section className="overview__pending" aria-label={t("overview.pending.aria")}>
      {items.map((item) => (
        <Link key={item.key} className="overview__pending-item mono" to={item.href}>
          {item.label} · {item.count}
        </Link>
      ))}
      {resumeHint ? (
        <Link className="overview__pending-item mono" to={taskHref(projectId, resumeHint.kind, resumeHint.taskId, { origin: resumeHint.origin ?? null, documentId: resumeHint.documentId ?? null })}>
          {t("overview.pending.resume", { label: resumeHint.label })}
        </Link>
      ) : null}
    </section>
  );
}

function EntryCard(label: string, to: string, blurb: string, primary = false) {
  return (
    <Link className="overview__entry" data-primary={primary} to={to} aria-label={label}>
      <span className="overview__entry-label">{label}</span>
      <span className="overview__entry-blurb mono">{blurb}</span>
    </Link>
  );
}

function chapterWritingHref(projectId: string, chapter: ProjectOverview["currentChapter"]): string {
  const params = new URLSearchParams();
  if (chapter?.documentId) params.set("document", chapter.documentId);
  else if (chapter?.outlineNodeId) params.set("outline", chapter.outlineNodeId);
  const query = params.toString();
  return `${projectWorkspacePath(projectId, "studio")}${query ? `?${query}` : ""}`;
}

type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

function nextActionEntry(overview: ProjectOverview, t: Translate): { label: string; href: string; blurb: string } {
  const projectId = overview.project.id;
  switch (overview.nextAction.kind) {
    case "continue_task": {
      const task = overview.activeTask;
      return task ? {
        label: t("overview.nextAction.continueTask.label"),
        href: taskHref(projectId, task.kind, task.id, { origin: task.origin, documentId: task.targetChapter?.documentId ?? null }),
        blurb: t("overview.nextAction.continueTask.blurb"),
      } : { label: t("overview.nextAction.backToStudio.label"), href: projectWorkspacePath(projectId, "studio"), blurb: t("overview.nextAction.backToStudio.blurb") };
    }
    case "review_foundation":
      return { label: t("overview.nextAction.reviewFoundation.label"), href: projectWorkspacePath(projectId, "autopilot"), blurb: t("overview.nextAction.reviewFoundation.blurb") };
    case "resolve_story_changes":
      return { label: t("overview.nextAction.resolveStoryChanges.label"), href: `${projectWorkspacePath(projectId, "studio")}?focus=canon`, blurb: t("overview.nextAction.resolveStoryChanges.blurb") };
    case "review_writing":
      return { label: t("overview.nextAction.reviewWriting.label"), href: reviewWorkspaceHref(projectId, overview.pending.reviewDocumentId), blurb: t("overview.nextAction.reviewWriting.blurb") };
    case "write_chapter":
      return { label: t("overview.nextAction.writeChapter.label"), href: chapterWritingHref(projectId, overview.currentChapter), blurb: t("overview.nextAction.writeChapter.blurb") };
    case "build_outline":
      return { label: t("overview.nextAction.buildOutline.label"), href: projectWorkspacePath(projectId, "bible"), blurb: t("overview.nextAction.buildOutline.blurb") };
    case "complete":
      return { label: t("overview.nextAction.complete.label"), href: projectWorkspacePath(projectId, "delivery"), blurb: t("overview.nextAction.complete.blurb") };
  }
}

function reviewWorkspaceHref(projectId: string, documentId: string | null | undefined): string {
  const params = new URLSearchParams({ focus: "review" });
  if (documentId) params.set("document", documentId);
  return `${projectWorkspacePath(projectId, "studio")}?${params}`;
}

function completedChapterMessage(overview: ProjectOverview, t: Translate): string {
  if (overview.progress.totalChapters === 0) {
    return t("overview.completed.noChapters");
  }
  switch (overview.nextAction.kind) {
    case "review_foundation":
      return t("overview.completed.reviewFoundation");
    case "resolve_story_changes":
      return t("overview.completed.resolveStoryChanges");
    case "review_writing":
      return t("overview.completed.reviewWriting");
    case "build_outline":
      return t("overview.completed.buildOutline");
    case "complete":
      return t("overview.completed.complete");
    default:
      return t("overview.completed.fallback", { action: nextActionKindLabel(overview.nextAction.kind) });
  }
}
